// Live Windows check: opens its own scratch Notepad, types, reads back,
// closes without saving. Acts only on the window titled with its unique
// scratch file; other windows are listed read-only. Does not touch the clipboard.
// Usage: node test/live-notepad.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, textOf } from "./client.mjs";

if (process.platform !== "win32") {
	console.log("skipped: Windows only");
	process.exit(0);
}
const dir = mkdtempSync(path.join(os.tmpdir(), "computer-live-"));
const name = `computer-live-${process.pid}.txt`;
const file = path.join(dir, name);
writeFileSync(file, "");
const s = startServer();
await s.init();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const call = async (tool, args) => {
	const r = await s.call(tool, args);
	if (r.isError) throw new Error(`${tool}: ${textOf(r)}`);
	return r;
};
const ok = (label, cond, detail = "") => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!cond) process.exitCode = 1;
};

/** Close the scratch window without saving: File > Exit, then "Don't Save" if prompted. */
async function closeScratch(id) {
	await call("menu_select", { target: id, path: ["File", "Exit"] });
	let dontSave;
	for (let i = 0; i < 12 && !dontSave; i++) {
		await sleep(250);
		const r = await s.call("ax_find", { target: id, role: "button", title: "Don't Save" });
		if (r.isError) return; // window already gone: it closed without a prompt
		dontSave = JSON.parse(textOf(r))[0];
	}
	if (!dontSave) return;
	const pressed = await s.call("element_press", { ref: dontSave.ref });
	if (pressed.isError) {
		console.log(`note: element_press refused (${textOf(pressed).split(";")[0]}); using element_click`);
		await call("element_click", { ref: dontSave.ref });
	}
}

let scratchId;
try {
	const all = JSON.parse(textOf(await call("list_windows", {})));
	ok("list_windows", Array.isArray(all), `${all.length} windows`);

	// Launch through the shell so Windows gives the new window the foreground,
	// which takeover (needed for XAML Notepad keystrokes) requires to hand focus back.
	// The window opens 1.5 s from now: list_windows with wait must catch it as soon as it appears.
	setTimeout(() => {
		spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process notepad.exe -ArgumentList '"${file}"'`], { stdio: "ignore" });
	}, 1500);
	const w0 = Date.now();
	let win = JSON.parse(textOf(await call("list_windows", { title: name, wait: 9000 })))[0];
	const waitedMs = Date.now() - w0;
	ok("list_windows wait caught a late window", !!win && waitedMs >= 1000 && waitedMs < 9000, `waited ${waitedMs} ms`);
	for (let i = 0; i < 40 && !win; i++) {
		await sleep(250);
		win = JSON.parse(textOf(await call("list_windows", { title: name })))[0];
	}
	if (!win) throw new Error("scratch Notepad window did not appear");
	scratchId = win.id;
	ok("scratch window found", true, `id=${win.id} title=${JSON.stringify(win.title)}`);
	// Windows hands the shell-launched window the foreground asynchronously, after it appears.
	// Takeover (needed for XAML Notepad keystrokes) works once it holds the foreground.
	for (let i = 0; i < 40 && !win.focused; i++) {
		await sleep(250);
		win = JSON.parse(textOf(await call("list_windows", { title: name })))[0] ?? win;
	}
	console.log(`note: scratch window ${win.focused ? "holds" : "did not get"} the foreground`);

	const shot = await call("screenshot", { target: win.id });
	const img = shot.content.find(c => c.type === "image");
	ok("screenshot", img && Buffer.from(img.data, "base64").subarray(1, 4).toString() === "PNG", textOf(shot));

	const tree = textOf(await call("ax_tree", { target: win.id }));
	ok("ax_tree", /textfield .*\[ref=e\d+\]/.test(tree), tree.split("\n")[0]);

	const typed = "typed by the computer plugin";
	const findEdit = async () => JSON.parse(textOf(await call("ax_find", { target: win.id, role: "textfield", limit: 1 })))[0];
	let t = await s.call("type_text", { target: win.id, text: typed });
	if (t.isError && /refused to activate the exact target window.*no input was sent/.test(textOf(t))) {
		// Windows' foreground lock refused the takeover and nothing was sent. Focus this scratch
		// window's own text field through UI Automation, then retry once.
		const [field] = JSON.parse(textOf(await call("ax_find", { target: win.id, role: "textfield", limit: 1 })));
		await call("element_focus", { ref: field.ref });
		console.log("note: activation refused; focused the scratch text field via element_focus and retried");
		t = await s.call("type_text", { target: win.id, text: typed });
	}
	let edit;
	if (t.isError && /cannot save the current foreground window/.test(textOf(t))) {
		console.log(/the screen is locked/.test(textOf(t))
			? "BLOCKED type_text: the screen is locked, so keystrokes cannot be sent. Unlock and rerun."
			: "BLOCKED type_text: no window is in the foreground (Windows foreground lock). Click any window once and rerun.");
		process.exitCode = 2;
	} else {
		if (t.isError) throw new Error(`type_text: ${textOf(t)}`);
		console.log(textOf(t));
		edit = await findEdit();
		ok("type_text read back via AX", edit.value === typed, JSON.stringify(edit.value));
	}
	edit = await findEdit();

	await call("element_set_value", { ref: edit.ref, value: "set via accessibility" });
	edit = await findEdit();
	ok("element_set_value read back", edit.value === "set via accessibility", JSON.stringify(edit.value));

	// hold_keys: hold a letter key for 1 s in the scratch window; at least one "x" must land.
	await call("element_set_value", { ref: edit.ref, value: "" });
	const holdStart = Date.now();
	let h = await s.call("hold_keys", { target: win.id, keys: ["x"], duration: 1 });
	if (h.isError && /refused to activate the exact target window.*no input was sent/.test(textOf(h))) {
		const [field] = JSON.parse(textOf(await call("ax_find", { target: win.id, role: "textfield", limit: 1 })));
		await call("element_focus", { ref: field.ref });
		console.log("note: activation refused; focused the scratch text field via element_focus and retried hold_keys");
		h = await s.call("hold_keys", { target: win.id, keys: ["x"], duration: 1 });
	}
	if (h.isError && /cannot save the current foreground window|refused to activate/.test(textOf(h))) {
		console.log("BLOCKED hold_keys: Windows would not give the scratch window the foreground. Click any window once and rerun.");
		process.exitCode = 2;
	} else {
		if (h.isError) throw new Error(`hold_keys: ${textOf(h)}`);
		const heldMs = Date.now() - holdStart;
		edit = await findEdit();
		ok("hold_keys held 1 s and the key landed", heldMs >= 900 && /x/.test(edit.value ?? ""), `took ${heldMs} ms, value=${JSON.stringify(edit.value)}`);
	}

	// hold_mouse: press and hold the left button inside the text area for 0.6 s, then release.
	const before = (await findEdit()).value;
	const mouseStart = Date.now();
	const m = await s.call("hold_mouse", { target: win.id, x: 250, y: 300, duration: 0.6, button: "left" });
	if (m.isError && /cannot save the current foreground window|refused to activate/.test(textOf(m))) {
		console.log("BLOCKED hold_mouse: Windows would not give the scratch window the foreground.");
		process.exitCode = 2;
	} else {
		if (m.isError) throw new Error(`hold_mouse: ${textOf(m)}`);
		const mouseMs = Date.now() - mouseStart;
		ok("hold_mouse held 0.6 s and released", mouseMs >= 550 && mouseMs < 15000 && (await findEdit()).value === before, `took ${mouseMs} ms, text unchanged`);
	}

	// File > Exit through the native menu works in the background.
	await closeScratch(win.id);
	await sleep(1000);
	const left = JSON.parse(textOf(await call("list_windows", { title: name })));
	ok("closed without saving", left.length === 0 && readFileSync(file, "utf8") === "", `windows left=${left.length}, file bytes=${readFileSync(file).length}`);
} catch (error) {
	ok("run", false, error.message);
} finally {
	try {
		const left = JSON.parse(textOf(await s.call("list_windows", { title: name })));
		if (scratchId && left.length) {
			console.log("cleanup: closing the scratch window without saving");
			await closeScratch(scratchId);
		}
	} catch (error) {
		console.log(`cleanup failed: ${error.message}`);
	}
	s.close();
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

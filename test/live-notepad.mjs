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

try {
	const all = JSON.parse(textOf(await call("list_windows", {})));
	ok("list_windows", all.length > 0, `${all.length} windows`);

	// Launch through the shell so Windows gives the new window the foreground,
	// which takeover (needed for XAML Notepad keystrokes) requires to hand focus back.
	spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process notepad.exe -ArgumentList '"${file}"'`], { stdio: "ignore" });
	let win;
	for (let i = 0; i < 40 && !win; i++) {
		await sleep(250);
		win = JSON.parse(textOf(await call("list_windows", { title: name })))[0];
	}
	if (!win) throw new Error("scratch Notepad window did not appear");
	ok("scratch window found", true, `id=${win.id} title=${JSON.stringify(win.title)}`);

	const shot = await call("screenshot", { target: win.id });
	const img = shot.content.find(c => c.type === "image");
	ok("screenshot", img && Buffer.from(img.data, "base64").subarray(1, 4).toString() === "PNG", textOf(shot));

	const tree = textOf(await call("ax_tree", { target: win.id }));
	ok("ax_tree", /textfield .*\[ref=e\d+\]/.test(tree), tree.split("\n")[0]);

	const typed = "typed by the computer plugin";
	const findEdit = async () => JSON.parse(textOf(await call("ax_find", { target: win.id, role: "textfield", limit: 1 })))[0];
	const t = await s.call("type_text", { target: win.id, text: typed });
	let edit;
	if (t.isError && /cannot save the current foreground window/.test(textOf(t))) {
		console.log("BLOCKED type_text: no window is in the foreground (Windows foreground lock). Click any window once and rerun.");
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

	// File > Exit through the native menu works in the background.
	await call("menu_select", { target: win.id, path: ["File", "Exit"] });
	let dontSave;
	for (let i = 0; i < 20 && !dontSave; i++) {
		await sleep(250);
		dontSave = JSON.parse(textOf(await call("ax_find", { target: win.id, role: "button", title: "Don't Save" })))[0];
	}
	if (!dontSave) throw new Error("save prompt did not appear");
	const pressed = await s.call("element_press", { ref: dontSave.ref });
	if (pressed.isError) {
		console.log(`note: element_press refused (${textOf(pressed).split(";")[0]}); using element_click`);
		await call("element_click", { ref: dontSave.ref });
	}
	await sleep(1000);
	const left = JSON.parse(textOf(await call("list_windows", { title: name })));
	ok("closed without saving", left.length === 0 && readFileSync(file, "utf8") === "", `windows left=${left.length}, file bytes=${readFileSync(file).length}`);
} catch (error) {
	ok("run", false, error.message);
} finally {
	s.close();
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

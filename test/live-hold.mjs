// Live Windows check for hold_keys, hold_mouse and list_windows wait. Opens its own
// scratch WinForms window (a classic Win32 text box takes background key messages, so
// this works even while the screen is locked), acts only on that window, then closes it.
// Usage: node test/live-hold.mjs
import { spawn } from "node:child_process";
import { startServer, textOf } from "./client.mjs";

if (process.platform !== "win32") {
	console.log("skipped: Windows only");
	process.exit(0);
}
const title = `computer-hold-${process.pid}`;
const ps =
	"Add-Type -AssemblyName System.Windows.Forms; " +
	`$f=New-Object Windows.Forms.Form; $f.Text='${title}'; $f.Width=420; $f.Height=220; ` +
	"$t=New-Object Windows.Forms.TextBox; $t.Multiline=$true; $t.Dock='Fill'; $f.Controls.Add($t); " +
	"$f.Add_Shown({$t.Focus()}); [void]$f.ShowDialog()";
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

let child;
try {
	// The window opens 1.5 s from now: wait must return as soon as it exists, not at the limit.
	setTimeout(() => {
		child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", ps], { stdio: "ignore" });
	}, 1500);
	const t0 = Date.now();
	const win = JSON.parse(textOf(await call("list_windows", { title, wait: 9000 })))[0];
	const waited = Date.now() - t0;
	ok("list_windows wait caught a late window", !!win && waited >= 1000 && waited < 9000, `waited ${waited} ms`);
	if (!win) throw new Error("scratch window did not appear");

	const edit = async () => JSON.parse(textOf(await call("ax_find", { target: win.id, role: "textfield", limit: 1 })))[0];
	ok("scratch text box starts empty", ((await edit()).value ?? "") === "");

	const t1 = Date.now();
	const held = await call("hold_keys", { target: win.id, keys: ["x"], duration: 1 });
	const heldMs = Date.now() - t1;
	const value = (await edit()).value ?? "";
	ok("hold_keys held 1 s and the key landed", heldMs >= 900 && /x/.test(value), `took ${heldMs} ms, value=${JSON.stringify(value)}; ${textOf(held).split("\n")[0]}`);

	await call("screenshot", { target: win.id }); // input coordinates are pixels of a screenshot
	const t2 = Date.now();
	await call("hold_mouse", { target: win.id, x: 100, y: 60, duration: 0.6, button: "left" });
	const mouseMs = Date.now() - t2;
	ok("hold_mouse held 0.6 s and released", mouseMs >= 550 && mouseMs < 15000 && ((await edit()).value ?? "") === value, `took ${mouseMs} ms, text unchanged`);

	const bad = await s.call("hold_keys", { target: win.id, keys: ["x"], duration: 101 });
	ok("hold_keys rejects duration 101 before sending", bad.isError === true && /range 0\.\.100.*nothing was sent/.test(textOf(bad)) && (await edit()).value === value);
} catch (error) {
	ok("run", false, error.message);
} finally {
	try {
		child?.kill();
	} catch {}
	await sleep(800);
	const r = await s.call("list_windows", { title });
	const left = r.isError ? [] : JSON.parse(textOf(r));
	ok("scratch window closed", left.length === 0, `windows left=${left.length}`);
	s.close();
}

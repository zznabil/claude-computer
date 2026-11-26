// Live Antigravity check (Windows): agy itself drives the installed plugin.
// Opens its own scratch Notepad, asks `agy -p` to inspect it, type into it,
// read the text back and close it without saving. agy gets a session-only
// allow-list of exactly the tools needed (no --dangerously-skip-permissions).
// Afterwards this script checks, independently, that the window is gone and
// the file is still empty. Other windows are only listed.
// Usage: node test/live-agy.mjs [path-to-agy]   (plugin installed with `agy plugin install`)
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, textOf } from "./client.mjs";

if (process.platform !== "win32") {
	console.log("skipped: Windows only");
	process.exit(0);
}
const AGY = process.argv[2] ?? path.join(process.env.LOCALAPPDATA ?? "", "agy", "bin", "agy.exe");
const MODEL = process.env.AGY_MODEL ?? "gemini-4-neon-medium";
const TOOLS = ["capabilities", "list_windows", "screenshot", "ax_tree", "ax_find", "type_text", "element_focus", "menu_select", "element_press", "element_click"];
const dir = mkdtempSync(path.join(os.tmpdir(), "computer-agy-"));
const name = `computer-agy-${process.pid}.txt`;
const file = path.join(dir, name);
writeFileSync(file, "");
const typed = "hello from antigravity";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const s = startServer();
await s.init();
const ok = (label, cond, detail = "") => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!cond) process.exitCode = 1;
};
const windowsTitled = async () => JSON.parse(textOf(await s.call("list_windows", { title: name })));

try {
	spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process notepad.exe -ArgumentList '"${file}"'`], { stdio: "ignore" });
	let win;
	for (let i = 0; i < 40 && !win?.focused; i++) {
		await sleep(250);
		win = (await windowsTitled())[0];
	}
	if (!win) throw new Error("scratch Notepad did not appear");
	console.log(`scratch window ${win.id} ${JSON.stringify(win.title)} focused=${win.focused}`);

	const prompt = [
		`Use only the tools of the "computer" MCP server, and act only on the window whose title contains "${name}". Do not touch any other window or app.`,
		`1. Call capabilities. 2. Call list_windows with title "${name}" and take its id.`,
		`3. Call screenshot on that id. 4. Call ax_tree on that id.`,
		`5. Call type_text on that id with text "${typed}". If it fails with "refused to activate", call element_focus on the window's textfield ref from ax_tree, then retry type_text once.`,
		`6. Call ax_find on that id with role "textfield" and report its value.`,
		`7. Close the window without saving: menu_select with path ["File","Exit"], then ax_find the button titled "Don't Save" on the same id and element_press it (if element_press fails, element_click it).`,
		`Finally reply with one line: READBACK=<the value from step 6>.`,
	].join("\n");
	const settings = JSON.stringify({ permissions: { allow: TOOLS.map(t => `mcp(computer_computer/${t})`) } });
	const run = spawnSync(AGY, ["-p", prompt, "--model", MODEL, "--settings", settings, "--output-format", "stream-json", "--print-timeout", "400s"], {
		cwd: dir,
		encoding: "utf8",
		timeout: 450000,
		maxBuffer: 64 * 1024 * 1024,
	});
	const events = (run.stdout ?? "").split("\n").flatMap(l => {
		try {
			return [JSON.parse(l)];
		} catch {
			return [];
		}
	});
	const calls = new Map();
	for (const e of events) {
		const u = e.step_update;
		const p = u?.tool_info?.parameters;
		if (u?.tool_name !== "call_mcp_tool" || p?.ServerName !== "computer_computer") continue;
		if (u.state === "ACTIVE") continue;
		calls.set(u.step_index, { tool: p.ToolName, state: u.state, error: u.tool_info?.error?.message });
	}
	const list = [...calls.values()];
	console.log("agy tool calls (server computer_computer):");
	for (const c of list) console.log(`  ${c.tool}: ${c.state}${c.error ? ` (${c.error.slice(0, 160)})` : ""}`);
	const result = events.find(e => e.event === "result")?.result;
	const done = t => list.some(c => c.tool === t && c.state !== "ERROR");
	for (const t of ["capabilities", "list_windows", "screenshot", "ax_tree", "type_text", "ax_find", "menu_select"]) ok(`agy called ${t}`, done(t));
	ok("agy close step pressed Don't Save", done("element_press") || done("element_click"));
	const response = result?.response ?? "";
	ok("agy read back the typed text", response.includes(`READBACK=${typed}`), JSON.stringify(response.trim().slice(-160)));
	await sleep(1000);
	const left = await windowsTitled();
	ok("closed without saving (independent check)", left.length === 0 && readFileSync(file, "utf8") === "", `windows left=${left.length}, file bytes=${readFileSync(file).length}`);
	if (result?.denied_actions?.length) console.log(`denied: ${JSON.stringify(result.denied_actions)}`);
} catch (error) {
	ok("run", false, error.message);
} finally {
	// Never leave the scratch window open: File > Exit, then Don't Save.
	try {
		const left = await windowsTitled();
		for (const w of left) {
			console.log("cleanup: closing the scratch window without saving");
			await s.call("menu_select", { target: w.id, path: ["File", "Exit"] });
			await sleep(800);
			const r = await s.call("ax_find", { target: w.id, role: "button", title: "Don't Save" });
			const [b] = r.isError ? [] : JSON.parse(textOf(r));
			if (b) {
				const p = await s.call("element_press", { ref: b.ref });
				if (p.isError) await s.call("element_click", { ref: b.ref });
			}
		}
	} catch (error) {
		console.log(`cleanup failed: ${error.message}`);
	}
	s.close();
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

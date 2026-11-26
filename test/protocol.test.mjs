// Protocol, catalogue, policy, timeout and shutdown checks. No desktop input
// is sent: every input call here targets a missing window/ref, so a broken
// guard fails with a native error instead of acting.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer, textOf } from "./client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const READ_ONLY = [
	"capabilities", "list_displays", "list_windows", "list_applications", "screenshot", "ax_tree", "observe",
	"ax_find", "ax_element", "ax_element_at", "ax_focused", "clipboard_read",
];

async function withServer(env, fn) {
	const s = startServer(env);
	try {
		await s.init();
		const caps = await s.call("capabilities");
		return await fn(s, caps.isError ? null : JSON.parse(textOf(caps)));
	} finally {
		s.close();
	}
}

test("initialize, tools/list, annotations, validation", async () => {
	const s = startServer();
	try {
		const init = await s.init();
		assert.equal(init.result.serverInfo.name, "computer");
		assert.match(init.result.instructions, /UNTRUSTED/);

		const { tools } = (await s.request("tools/list", {})).result;
		assert.equal(tools.length, 31);
		for (const t of tools) {
			assert.equal(typeof t.annotations.readOnlyHint, "boolean", t.name);
			assert.equal(t.annotations.readOnlyHint, READ_ONLY.includes(t.name), `${t.name} readOnlyHint`);
			assert.equal(t.inputSchema.type, "object", t.name);
		}
		assert.equal(tools.find(t => t.name === "menu_items").annotations.readOnlyHint, false);
		assert.deepEqual(Object.keys(tools.find(t => t.name === "open_application").inputSchema.properties), ["id", "activate", "app", "reveal"]);

		const bad = await s.call("click", { target: "1", x: "10", y: 2, bogus: true });
		assert.equal(bad.isError, true);
		assert.match(textOf(bad), /^InvalidArguments: .*"x" has the wrong type.*unknown option "bogus".*nothing was sent$/);

		const unknown = await s.request("tools/call", { name: "nope", arguments: {} });
		assert.equal(unknown.error.code, -32602);
		const missing = await s.request("no/such/method", {});
		assert.equal(missing.error.code, -32601);
	} finally {
		s.close();
	}
});

test("refuse setting blocks takeover, desktop input, raises and reveal before sending", async () => {
	await withServer({ COMPUTER_TAKEOVER: "refuse" }, async (s, caps) => {
		if (!caps) return; // no native backend on this host
		assert.equal(caps.takeoverSetting, "refuse");
		for (const [name, args] of [
			["click", { target: "display:no-such-display", x: 1, y: 1 }],
			["press_keys", { target: "no-such-window", keys: "a", takeover: true }],
			["raise_window", { id: "no-such-window" }],
			["element_press", { ref: "e999999", action: "raise" }],
			["element_press", { ref: "e999999", action: "AXRaise" }],
			["open_application", { id: "no-such-app", reveal: true }],
			["open_application", { id: "no-such-app", activate: true }],
		]) {
			const r = await s.call(name, args);
			assert.equal(r.isError, true, name);
			assert.match(textOf(r), /^BackgroundUnavailable: .*"refuse".*nothing was sent/, `${name} ${JSON.stringify(args)}`);
		}
		if (caps.backend === "quartz") {
			for (const [name, args] of [
				["click", { target: "no-such-window", x: 1, y: 1, button: "right" }],
				["click", { target: "no-such-window", x: 1, y: 1, modifiers: ["ctrl"] }],
				["click", { target: "no-such-window", x: 1, y: 1, menu: ["File"] }],
				["drag", { target: "no-such-window", path: [{ x: 1, y: 1 }, { x: 2, y: 2 }], button: "right" }],
				["element_press", { ref: "e999999", action: "open" }],
				["element_press", { ref: "e999999", action: "showMenu" }],
				["element_press", { ref: "e999999", action: "increment", menu: ["x"] }],
			]) {
				const r = await s.call(name, args);
				assert.match(textOf(r), /^BackgroundUnavailable: .*"refuse"/, `${name} ${JSON.stringify(args)}`);
			}
		}
	});
});

test("fallback setting does not refuse a raise action before native", async () => {
	await withServer({ COMPUTER_TAKEOVER: "fallback" }, async (s, caps) => {
		if (!caps) return;
		const r = await s.call("element_press", { ref: "e999999", action: "raise" });
		assert.doesNotMatch(textOf(r), /^BackgroundUnavailable/);
	});
});

test("element_set_value refuses numbers that are not exact decimal text", async () => {
	await withServer({}, async (s, caps) => {
		if (!caps) return;
		for (const value of [2 ** 53 + 2, 1e21, 1e-7]) {
			const r = await s.call("element_set_value", { ref: "e999999", value });
			assert.match(textOf(r), /^InvalidArguments: value .*decimal string.*nothing was sent$/, String(value));
		}
		const ok = await s.call("element_set_value", { ref: "e999999", value: 75 });
		assert.doesNotMatch(textOf(ok), /InvalidArguments/); // reaches native (StaleRef)
	});
});

test("call deadline cancels a slow call and the queue recovers", async () => {
	await withServer({ COMPUTER_CALL_TIMEOUT_MS: "20" }, async (s, caps) => {
		if (!caps) return;
		const r = await s.call("list_applications", {});
		assert.match(textOf(r), /^Timeout: list_applications did not finish within 20 ms and was cancelled/);
	});
	// The queue is not wedged: a normal call after native work drains succeeds.
	await withServer({ COMPUTER_CALL_TIMEOUT_MS: "20" }, async (s, caps) => {
		if (!caps) return;
		await s.call("list_applications", {});
		await new Promise(r => setTimeout(r, 2000));
		const w = await s.call("list_windows", {});
		assert.equal(w.isError, undefined, textOf(w));
	});
});

test("npm install is killed at its timeout", async () => {
	const data = mkdtempSync(path.join(os.tmpdir(), "computer-install-"));
	// An empty plugin data dir forces the download path, unless a local ./node_modules install exists.
	const local = await import("node:fs").then(fs => fs.existsSync(path.join(root, "node_modules", "@oh-my-pi")));
	if (local) return; // a local addon install short-circuits the download path
	const s = startServer({ CLAUDE_PLUGIN_DATA: data, COMPUTER_INSTALL_TIMEOUT_MS: "1" });
	try {
		await s.init();
		const r = await s.call("capabilities");
		assert.match(textOf(r), /^InstallTimeout: npm install of @oh-my-pi\/pi-natives-.* took longer than 1 ms/);
	} finally {
		s.close();
		await new Promise(r => setTimeout(r, 500));
		rmSync(data, { recursive: true, force: true });
	}
});

test("stdin close closes the session and exits promptly", async () => {
	const child = spawn(process.execPath, [path.join(root, "server", "index.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
	let err = "";
	child.stderr.on("data", d => (err += d));
	const send = m => child.stdin.write(`${JSON.stringify(m)}\n`);
	send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
	send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "capabilities", arguments: {} } });
	await new Promise(r => {
		let out = "";
		child.stdout.on("data", d => {
			out += d;
			if (out.includes('"id":2')) r();
		});
	});
	const t0 = Date.now();
	const exited = new Promise(r => child.on("exit", code => r(code)));
	child.stdin.end();
	const code = await exited;
	assert.equal(code, 0);
	assert.ok(Date.now() - t0 < 3000, `exit took ${Date.now() - t0} ms`);
	assert.match(err, /shutting down: stdin closed/);
});

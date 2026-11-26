// Protocol and catalogue checks; no desktop input is sent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer, textOf } from "./client.mjs";

const READ_ONLY = [
	"capabilities", "list_displays", "list_windows", "list_applications", "screenshot", "ax_tree", "observe",
	"ax_find", "ax_element", "ax_element_at", "ax_focused", "menu_items", "clipboard_read",
];

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

test("refuse setting blocks takeover and desktop input before sending", async () => {
	const s = startServer({ COMPUTER_TAKEOVER: "refuse" });
	try {
		await s.init();
		const caps = await s.call("capabilities");
		if (caps.isError) return; // no native backend on this host: nothing to check
		assert.match(textOf(caps), /"takeoverSetting": "refuse"/);
		for (const [name, args] of [
			["click", { target: "display:no-such-display", x: 1, y: 1 }],
			["press_keys", { target: "no-such-window", keys: "a", takeover: true }],
			["raise_window", { id: "no-such-window" }],
		]) {
			const r = await s.call(name, args);
			assert.equal(r.isError, true, name);
			assert.match(textOf(r), /^BackgroundUnavailable: .*"refuse".*nothing was sent/, name);
		}
	} finally {
		s.close();
	}
});

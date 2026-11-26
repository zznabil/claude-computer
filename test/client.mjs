// Tiny MCP stdio client for tests and live checks.
// Usage: node test/client.mjs '<json array of [tool, args]>'   (prints each result)
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function startServer(env = {}) {
	const child = spawn(process.execPath, [path.join(root, "server", "index.mjs")], {
		env: { ...process.env, ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let buf = "";
	let next = 1;
	const pending = new Map();
	const stderr = [];
	child.stderr.on("data", d => stderr.push(String(d)));
	child.stdout.on("data", d => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			const msg = JSON.parse(line);
			pending.get(msg.id)?.(msg);
			pending.delete(msg.id);
		}
	});
	const request = (method, params) =>
		new Promise(resolve => {
			const id = next++;
			pending.set(id, resolve);
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	return {
		request,
		stderr,
		async init() {
			const r = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
			return r;
		},
		call: (name, args = {}) => request("tools/call", { name, arguments: args }).then(m => m.result ?? m),
		close: () => child.stdin.end(),
	};
}

export const textOf = r => (r.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const steps = JSON.parse(process.argv[2] ?? "[]");
	const s = startServer();
	await s.init();
	for (const [name, args] of steps) {
		const r = await s.call(name, args);
		const imgs = (r.content ?? []).filter(c => c.type === "image");
		console.log(`## ${name} ${JSON.stringify(args)}${r.isError ? " (isError)" : ""}`);
		console.log(textOf(r) || JSON.stringify(r));
		for (const img of imgs) console.log(`[image ${img.mimeType} ${Math.round((img.data.length * 3) / 4 / 1024)} KiB]`);
	}
	s.close();
}

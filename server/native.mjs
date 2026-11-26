// Locates (and on first use installs) the prebuilt oh-my-pi desktop addon.
//
// The addon is the published `@oh-my-pi/pi-natives-<platform>-<arch>` leaf
// package (MIT, https://github.com/can1357/oh-my-pi). Its own JS loader in
// `@oh-my-pi/pi-natives` needs Bun (`import.meta.dir`), so this file loads
// the N-API `.node` file directly, which works in Node.js.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_VERSION = "19.2.1";
export const LEAF = `@oh-my-pi/pi-natives-${process.platform}-${process.arch}`;
const SUPPORTED = new Set(["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]);

/** Desktop methods this server calls; an addon without them is the wrong ABI. */
const REQUIRED = [
	"listDisplays", "listWindows", "capture", "captureRegion", "observe", "click", "moveMouse", "drag",
	"scroll", "typeText", "keyChord", "axSnapshot", "axQuery", "axNode", "axPerform", "axSetValue",
	"axFocus", "axClick", "axType", "axKeyChord", "setRunDeadline", "cancel", "close",
];

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Directory that receives an on-demand install: Claude Code's persistent plugin data dir. */
export function dataDir() {
	return process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".cache", "claude-computer");
}

function findAddon(root) {
	let manifest;
	try {
		manifest = createRequire(path.join(root, "package.json")).resolve(`${LEAF}/package.json`);
	} catch {
		return null;
	}
	const version = JSON.parse(readFileSync(manifest, "utf8")).version;
	if (version !== NATIVE_VERSION) return null;
	const dir = path.dirname(manifest);
	const files = readdirSync(dir).filter(f => f.endsWith(".node"));
	// The baseline build runs on every CPU of the platform; prefer it over AVX2 "modern".
	const file = files.find(f => f.includes("baseline")) ?? files[0];
	return file ? path.join(dir, file) : null;
}

function npmInstall(dir, log) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "computer-plugin-deps", private: true, dependencies: { [LEAF]: NATIVE_VERSION } }, null, 2),
	);
	log(`installing ${LEAF}@${NATIVE_VERSION} into ${dir} (one-time, ~50 MB download)`);
	return new Promise((resolve, reject) => {
		const child = spawn(
			"npm",
			["install", "--no-audit", "--no-fund", "--ignore-scripts", "--omit=dev", "--no-package-lock"],
			// stdout carries the MCP protocol, so npm output goes to stderr only.
			{ cwd: dir, shell: process.platform === "win32", stdio: ["ignore", process.stderr, process.stderr] },
		);
		child.on("error", reject);
		child.on("exit", code =>
			code === 0 ? resolve() : reject(new Error(`npm install exited with code ${code} in ${dir}`)),
		);
	});
}

let loading;

/** Resolve the native addon module, installing it into the data dir when absent. */
export function loadNative(log = () => {}) {
	loading ??= (async () => {
		const tag = `${process.platform}-${process.arch}`;
		if (!SUPPORTED.has(tag)) throw new Error(`Unsupported: no prebuilt oh-my-pi desktop addon for ${tag}`);
		let file = findAddon(pluginRoot) ?? findAddon(dataDir());
		if (!file) {
			await npmInstall(dataDir(), log);
			file = findAddon(dataDir());
		}
		if (!file || !existsSync(file)) throw new Error(`Could not find ${LEAF}@${NATIVE_VERSION} after install`);
		const native = createRequire(import.meta.url)(file);
		const proto = native.DesktopSession?.prototype;
		const missing = REQUIRED.filter(m => typeof proto?.[m] !== "function");
		if (missing.length) throw new Error(`Desktop addon at ${file} lacks: ${missing.join(", ")}`);
		log(`loaded ${file}`);
		return { native, file };
	})();
	loading.catch(() => {
		loading = undefined; // allow a retry on the next call
	});
	return loading;
}

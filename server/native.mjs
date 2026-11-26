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
	"listDisplays", "listWindows", "listApplications", "openApplication", "capture", "captureRegion", "observe",
	"click", "moveMouse", "drag", "scroll", "typeText", "keyChord", "raiseWindow", "menuItems", "menuSelect",
	"axSnapshot", "axQuery", "axNode", "axAttributes", "axChildren", "axParent", "axElementAt", "axFocused",
	"axPerform", "axSetValue", "axSelectText", "axFocus", "axClick", "axType", "axKeyChord",
	"setRunDeadline", "cancel", "close",
];
/** Getters read on the session. */
const REQUIRED_GETTERS = ["capabilities", "screenState", "escapeStops"];
/** Top-level clipboard functions. */
const REQUIRED_FUNCTIONS = ["readTextFromClipboard", "readImageFromClipboard", "copyToClipboard"];
const INSTALL_MS = Number(process.env.COMPUTER_INSTALL_TIMEOUT_MS) > 0 ? Number(process.env.COMPUTER_INSTALL_TIMEOUT_MS) : 10 * 60 * 1000;
const NPM_ARGS = "install --no-audit --no-fund --ignore-scripts --omit=dev --no-package-lock";

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
	log(`installing ${LEAF}@${NATIVE_VERSION} into ${dir} (one-time; about 130-300 MB unpacked)`);
	// npm is npm.cmd on Windows, which needs cmd.exe; a fixed command string avoids
	// spawn's args-with-shell path (DEP0190). stdout carries the MCP protocol, so npm
	// output goes to stderr only.
	const win = process.platform === "win32";
	const child = win
		? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm ${NPM_ARGS}`], { cwd: dir, stdio: ["ignore", process.stderr, process.stderr], windowsHide: true })
		: spawn("npm", NPM_ARGS.split(" "), { cwd: dir, stdio: ["ignore", process.stderr, process.stderr] });
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			log(`npm install exceeded ${INSTALL_MS} ms; killing it`);
			if (win) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			else child.kill("SIGKILL");
			reject(new Error(`InstallTimeout: npm install of ${LEAF}@${NATIVE_VERSION} took longer than ${INSTALL_MS} ms in ${dir}; check the network and retry`));
		}, INSTALL_MS);
		child.on("error", error => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", code => {
			clearTimeout(timer);
			code === 0 ? resolve() : reject(new Error(`npm install exited with code ${code} in ${dir}`));
		});
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
		const missing = [
			...REQUIRED.filter(m => typeof proto?.[m] !== "function"),
			...REQUIRED_GETTERS.filter(g => !proto || !(g in proto)),
			...REQUIRED_FUNCTIONS.filter(f => typeof native[f] !== "function"),
		];
		if (missing.length) throw new Error(`Desktop addon at ${file} lacks: ${missing.join(", ")}`);
		log(`loaded ${file}`);
		return { native, file };
	})();
	loading.catch(() => {
		loading = undefined; // allow a retry on the next call
	});
	return loading;
}

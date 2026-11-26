// Host detection, data directory and settings, shared by Claude Code and
// Antigravity (agy).
//
// Settings precedence, per key: environment variable (COMPUTER_*), then
// `settings.json` in the plugin data directory, then the default. An env value
// that is empty or still an unexpanded `${...}` placeholder counts as unset.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const env = process.env;

/** Plugin version from package.json (kept equal to both plugin manifests by test). */
export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** Which host started the server. */
export const HOST = env.CLAUDE_PLUGIN_ROOT ? "claude-code" : env.PLUGIN_ROOT ? "antigravity" : "standalone";

const set = v => typeof v === "string" && v.trim() !== "" && !/\$\{[^}]*\}/.test(v);

/** Persistent per-plugin data: CLAUDE_PLUGIN_DATA (Claude Code), PLUGIN_DATA (agy), else ~/.cache/claude-computer. */
export function dataDir() {
	if (set(env.CLAUDE_PLUGIN_DATA)) return env.CLAUDE_PLUGIN_DATA;
	if (set(env.PLUGIN_DATA)) return env.PLUGIN_DATA;
	return path.join(os.homedir(), ".cache", "claude-computer");
}

export const SETTINGS_FILE = path.join(dataDir(), "settings.json");

function readSettingsFile() {
	try {
		const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch (error) {
		if (error?.code !== "ENOENT") process.stderr.write(`[computer] ignoring ${SETTINGS_FILE}: ${error.message}\n`);
		return {};
	}
}

const file = readSettingsFile();
const sources = {};

function pickSetting(key, envName, parse, fallback) {
	if (set(env[envName])) {
		const v = parse(env[envName]);
		if (v !== undefined) {
			sources[key] = `env ${envName}`;
			return v;
		}
	}
	if (file[key] !== undefined) {
		const v = parse(String(file[key]));
		if (v !== undefined) {
			sources[key] = SETTINGS_FILE;
			return v;
		}
	}
	sources[key] = "default";
	return fallback;
}

const takeover = v => (v === "refuse" || v === "fallback" ? v : undefined);
const positive = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);

export const SETTINGS = {
	takeover: pickSetting("takeover", "COMPUTER_TAKEOVER", takeover, "fallback"),
	max_width: pickSetting("max_width", "COMPUTER_MAX_WIDTH", positive, 1366),
	max_height: pickSetting("max_height", "COMPUTER_MAX_HEIGHT", positive, 768),
	call_timeout_ms: pickSetting("call_timeout_ms", "COMPUTER_CALL_TIMEOUT_MS", positive, 120000),
	install_timeout_ms: pickSetting("install_timeout_ms", "COMPUTER_INSTALL_TIMEOUT_MS", positive, 600000),
};
export const SETTING_SOURCES = sources;

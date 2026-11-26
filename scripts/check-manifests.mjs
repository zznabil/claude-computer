// Static checks of the plugin manifests for Claude Code and Antigravity (agy).
// CI runs this because the agy CLI cannot be installed on CI runners; Claude
// Code's own validator runs separately (`claude plugin validate .`).
// Usage: node scripts/check-manifests.mjs [--tag vX.Y.Z]
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const fail = msg => problems.push(msg);
const read = rel => JSON.parse(readFileSync(path.join(root, rel), "utf8"));
const exists = rel => existsSync(path.join(root, rel));

const pkg = read("package.json");
const claude = read(".claude-plugin/plugin.json");
const market = read(".claude-plugin/marketplace.json");
const agy = read(".antigravity-plugin/plugin.json");
const agyMcp = read("mcp_config.json");
const semver = /^\d+\.\d+\.\d+$/;

// Versions: one version everywhere, and the release tag must match it.
if (!semver.test(pkg.version)) fail(`package.json version ${pkg.version} is not X.Y.Z`);
for (const [file, v] of [[".claude-plugin/plugin.json", claude.version], [".antigravity-plugin/plugin.json", agy.version]])
	if (v !== pkg.version) fail(`${file} version ${v} != package.json ${pkg.version}`);
const tagAt = process.argv.indexOf("--tag");
if (tagAt > 0) {
	const tag = process.argv[tagAt + 1] ?? "";
	if (tag !== `v${pkg.version}`) fail(`tag ${tag} != v${pkg.version} (package.json and both manifests)`);
}

// Claude Code plugin + marketplace.
if (claude.name !== "computer") fail(`.claude-plugin/plugin.json name ${claude.name} != computer`);
const cServer = claude.mcpServers?.computer;
if (cServer?.command !== "node" || cServer?.args?.[0] !== "${CLAUDE_PLUGIN_ROOT}/server/index.mjs")
	fail(".claude-plugin/plugin.json mcpServers.computer must run node ${CLAUDE_PLUGIN_ROOT}/server/index.mjs");
for (const ref of Object.values(cServer?.env ?? {})) {
	const key = /^\$\{user_config\.(\w+)\}$/.exec(ref)?.[1];
	if (key && !claude.userConfig?.[key]) fail(`.claude-plugin/plugin.json env references undeclared user_config.${key}`);
}
if (claude.icon && !exists(claude.icon)) fail(`.claude-plugin/plugin.json icon ${claude.icon} missing`);
const entry = market.plugins?.find(p => p.name === "computer");
if (!entry || entry.source !== "./") fail(".claude-plugin/marketplace.json must list computer with source ./");

// Antigravity native plugin (docs: plugins.md, mcp_servers.md, rules.md of the agy-customizations skill).
const AGY_KEYS = new Set(["name", "version", "description", "author", "homepage", "repository", "logo", "disabled"]);
for (const k of Object.keys(agy)) if (!AGY_KEYS.has(k)) fail(`.antigravity-plugin/plugin.json has unknown key ${k}`);
if (agy.name !== "computer") fail(`.antigravity-plugin/plugin.json name ${agy.name} != computer`);
for (const k of ["homepage"]) if (agy[k] !== undefined && !/^https:\/\//.test(agy[k])) fail(`.antigravity-plugin/plugin.json ${k} must be https://`);
if (agy.logo) {
	if (!exists(agy.logo)) fail(`agy logo ${agy.logo} missing`);
	if (agy.logo.split("/").some(part => part.startsWith("."))) fail(`agy logo ${agy.logo} is under a dot-directory, which the Marketplace bundle drops`);
}
const aServer = agyMcp.mcpServers?.computer;
if (aServer?.command !== "node" || aServer?.args?.[0] !== "${PLUGIN_ROOT}/server/index.mjs")
	fail("mcp_config.json mcpServers.computer must run node ${PLUGIN_ROOT}/server/index.mjs");
if (!exists("rules/AGENTS.md")) fail("rules/AGENTS.md missing");
else if (statSync(path.join(root, "rules/AGENTS.md")).size > 24000) fail("rules/AGENTS.md exceeds agy's 24,000-byte rule limit");

// Shared files.
if (!exists("server/index.mjs")) fail("server/index.mjs missing");
const png = readFileSync(path.join(root, "assets/icon.png"));
const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
if (png.toString("ascii", 1, 4) !== "PNG" || w !== h || w < 512 || w > 2048) fail(`assets/icon.png must be a square PNG of 512-2048 px (got ${w}x${h})`);

if (problems.length) {
	for (const p of problems) console.error(`✘ ${p}`);
	process.exit(1);
}
console.log(`✔ manifests consistent: computer ${pkg.version} (Claude Code plugin + marketplace, Antigravity plugin + mcp_config + rules)`);

// Addon drift check. The plugin pins the oh-my-pi desktop addon exactly. This script reports:
//   1. local mismatch: a pin location disagrees with `server/native.mjs` NATIVE_VERSION
//   2. upstream drift: npm publishes a newer version of a pinned leaf package
// Usage: node scripts/check-addon-drift.mjs [--offline]
// Exit: 0 in sync, 1 mismatch or drift, 2 npm unreachable (online mode only).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(root, rel), "utf8");

/** Every place that names the pinned version, as { where, version }. */
export function collectPins(files) {
	const pins = [];
	const nv = /export const NATIVE_VERSION = "([^"]+)"/.exec(files.native);
	pins.push({ where: "server/native.mjs NATIVE_VERSION", version: nv?.[1] });
	const deps = JSON.parse(files.pkg).optionalDependencies ?? {};
	for (const [name, version] of Object.entries(deps)) pins.push({ where: `package.json ${name}`, version });
	const key = /key: pi-natives-([^\s$]+?)-\$\{\{/.exec(files.ci);
	pins.push({ where: ".github/workflows/ci.yml cache key", version: key?.[1] });
	const notice = /version ([0-9][^\s,(]*)/.exec(files.notice);
	pins.push({ where: "NOTICE", version: notice?.[1] });
	const readme = /pi-natives-<platform>-<arch>@([0-9][^\s`(,]*)/.exec(files.readme);
	pins.push({ where: "README.md", version: readme?.[1] });
	return pins;
}

/** Locations whose version differs from NATIVE_VERSION (a missing version counts as a mismatch). */
export function localMismatches(pins) {
	const want = pins.find(p => p.where.startsWith("server/native.mjs"))?.version;
	return pins.filter(p => p.version !== want).map(p => ({ ...p, want }));
}

/** Leaf packages whose npm `latest` differs from the pinned version. */
export function upstreamDrift(want, latest) {
	return Object.entries(latest)
		.filter(([, version]) => version !== want)
		.map(([name, version]) => ({ name, pinned: want, latest: version }));
}

async function npmLatest(name) {
	const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, { signal: AbortSignal.timeout(20000) });
	if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
	return (await res.json()).version;
}

async function main() {
	const offline = process.argv.includes("--offline");
	const files = {
		native: read("server/native.mjs"),
		pkg: read("package.json"),
		ci: read(".github/workflows/ci.yml"),
		notice: read("NOTICE"),
		readme: read("README.md"),
	};
	const pins = collectPins(files);
	const want = pins[0].version;
	let failed = false;
	const bad = localMismatches(pins);
	console.log(`pinned addon: ${want} (${pins.length} locations)`);
	for (const m of bad) {
		failed = true;
		console.log(`MISMATCH ${m.where}: ${m.version ?? "not found"} (expected ${m.want})`);
	}
	if (offline) {
		console.log(bad.length ? "offline: local pins disagree" : "offline: local pins agree");
		process.exit(failed ? 1 : 0);
	}
	const leaves = Object.keys(JSON.parse(files.pkg).optionalDependencies ?? {});
	let latest;
	try {
		latest = Object.fromEntries(await Promise.all(leaves.map(async n => [n, await npmLatest(n)])));
	} catch (error) {
		console.log(`npm unreachable: ${error.message}`);
		process.exit(2);
	}
	const drift = upstreamDrift(want, latest);
	for (const d of drift) {
		failed = true;
		console.log(`DRIFT ${d.name}: pinned ${d.pinned}, npm latest ${d.latest}`);
	}
	if (!failed) console.log(`in sync: all ${leaves.length} leaves at npm latest ${want}`);
	process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

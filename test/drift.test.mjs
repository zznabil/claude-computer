// Addon drift check: it must pass on the repo as shipped and fail when a pin or npm moves.
// Offline only: the npm comparison is exercised through its pure function.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectPins, localMismatches, upstreamDrift } from "../scripts/check-addon-drift.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = () => ({
	native: readFileSync(path.join(root, "server/native.mjs"), "utf8"),
	pkg: readFileSync(path.join(root, "package.json"), "utf8"),
	ci: readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"),
	notice: readFileSync(path.join(root, "NOTICE"), "utf8"),
	readme: readFileSync(path.join(root, "README.md"), "utf8"),
});

test("every pin location is found and agrees", () => {
	const pins = collectPins(files());
	assert.equal(pins.length, 10, "NATIVE_VERSION + 6 leaves + ci + NOTICE + README");
	assert.ok(pins.every(p => /^\d+\.\d+\.\d+$/.test(p.version ?? "")), JSON.stringify(pins));
	assert.deepEqual(localMismatches(pins), []);
});

test("a changed or unreadable pin is a mismatch", () => {
	const f = files();
	const want = collectPins(f)[0].version;
	const bumped = collectPins({ ...f, notice: f.notice.replace(`version ${want}`, "version 99.0.0") });
	assert.deepEqual(localMismatches(bumped).map(m => m.where), ["NOTICE"]);
	const missing = collectPins({ ...f, readme: "no pin here" });
	assert.deepEqual(localMismatches(missing).map(m => m.where), ["README.md"]);
});

test("upstream drift names each leaf that moved", () => {
	assert.deepEqual(upstreamDrift("1.0.0", { a: "1.0.0", b: "1.0.0" }), []);
	assert.deepEqual(upstreamDrift("1.0.0", { a: "1.0.0", b: "1.1.0" }), [{ name: "b", pinned: "1.0.0", latest: "1.1.0" }]);
});

test("the script exits 0 when pins agree and 1 when one is broken", () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "drift-"));
	try {
		for (const rel of ["scripts/check-addon-drift.mjs", "server/native.mjs", "package.json", ".github/workflows/ci.yml", "NOTICE", "README.md"]) {
			mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
			cpSync(path.join(root, rel), path.join(tmp, rel));
		}
		const run = () => spawnSync(process.execPath, [path.join(tmp, "scripts/check-addon-drift.mjs"), "--offline"], { encoding: "utf8" });
		const ok = run();
		assert.equal(ok.status, 0, ok.stdout + ok.stderr);
		assert.match(ok.stdout, /^offline: local pins agree$/m, "a silent exit 0 is not a pass");
		const ci = path.join(tmp, ".github/workflows/ci.yml");
		writeFileSync(ci, readFileSync(ci, "utf8").replace(/pi-natives-\d+\.\d+\.\d+-/, "pi-natives-0.0.1-"));
		const broken = run();
		assert.equal(broken.status, 1);
		assert.match(broken.stdout, /MISMATCH \.github\/workflows\/ci\.yml cache key: 0\.0\.1/);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// Prints the CHANGELOG.md section of one version, for the GitHub release notes.
// Usage: node scripts/release-notes.mjs 0.2.0
import { readFileSync } from "node:fs";

const version = process.argv[2];
const text = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const lines = text.split(/\r?\n/);
const start = lines.findIndex(l => l.startsWith(`## [${version}]`));
if (!version || start < 0) {
	console.error(`CHANGELOG.md has no section for ${version}`);
	process.exit(1);
}
const end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
const body = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
if (!body) {
	console.error(`CHANGELOG.md section ${version} is empty`);
	process.exit(1);
}
console.log(body);

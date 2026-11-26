// Generates assets/icon.png (512x512): a monitor with a pointer.
// Pure Node (zlib), no external assets. Usage: node scripts/make-icon.mjs
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const S = 512;
const px = new Uint8Array(S * S * 4);
const BG = [32, 36, 48, 255];
const FRAME = [222, 226, 235, 255];
const SCREEN = [64, 132, 214, 255];
const STAND = [170, 176, 190, 255];
const CURSOR = [255, 255, 255, 255];
const OUTLINE = [20, 22, 30, 255];

function set(x, y, c) {
	if (x < 0 || y < 0 || x >= S || y >= S) return;
	px.set(c, (y * S + x) * 4);
}
function roundRect(x0, y0, x1, y1, r, c) {
	for (let y = y0; y < y1; y++)
		for (let x = x0; x < x1; x++) {
			const dx = Math.max(x0 + r - x - 0.5, 0, x + 0.5 - (x1 - r));
			const dy = Math.max(y0 + r - y - 0.5, 0, y + 0.5 - (y1 - r));
			if (dx * dx + dy * dy <= r * r) set(x, y, c);
		}
}
/** Point-in-polygon fill (even-odd). */
function poly(points, c) {
	const ys = points.map(p => p[1]);
	for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
		const xs = [];
		for (let i = 0; i < points.length; i++) {
			const [ax, ay] = points[i];
			const [bx, by] = points[(i + 1) % points.length];
			if ((ay <= y + 0.5 && by > y + 0.5) || (by <= y + 0.5 && ay > y + 0.5)) xs.push(ax + ((y + 0.5 - ay) * (bx - ax)) / (by - ay));
		}
		xs.sort((a, b) => a - b);
		for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.round(xs[i]); x < Math.round(xs[i + 1]); x++) set(x, y, c);
	}
}

roundRect(0, 0, S, S, 96, BG); // tile
roundRect(72, 96, 440, 344, 28, FRAME); // monitor bezel
roundRect(96, 120, 416, 320, 12, SCREEN); // screen
poly([[226, 344], [286, 344], [300, 400], [212, 400]], STAND); // neck
roundRect(160, 396, 352, 420, 12, STAND); // base
// pointer: outline then fill, offset into the screen
const arrow = [[0, 0], [0, 150], [38, 114], [66, 176], [94, 164], [66, 104], [116, 104]];
const at = (dx, dy, k = 1) => arrow.map(([x, y]) => [250 + dx + x * k, 170 + dy + y * k]);
poly(at(-6, -10, 1.12), OUTLINE);
poly(at(0, 0), CURSOR);

// PNG encode (RGBA, filter 0 per row)
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc = buf => {
	let c = 0xffffffff;
	for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type), data]);
	const sum = Buffer.alloc(4);
	sum.writeUInt32BE(crc(body));
	return Buffer.concat([len, body, sum]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr.set([8, 6, 0, 0, 0], 8);
const png = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	chunk("IHDR", ihdr),
	chunk("IDAT", deflateSync(raw, { level: 9 })),
	chunk("IEND", Buffer.alloc(0)),
]);
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "icon.png");
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${S}x${S})`);

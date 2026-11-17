// Writes icon.png (80x80) and largeIcon.png (130x130): light shafts over a kelp silhouette. Run once: node make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
const png = (n) => {
  const raw = Buffer.alloc(n * (n * 4 + 1)), ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / n, v = y / n, o = y * (n * 4 + 1) + 1 + x * 4;
    let r = 4 + 20 * (1 - v), g = 28 + 120 * (1 - v) ** 1.5, b = 44 + 150 * (1 - v) ** 1.2;
    const ray = Math.max(0, Math.sin((u - v * 0.35) * 19)) ** 3 * (1 - v) * 0.55; r += 150 * ray; g += 190 * ray; b += 170 * ray;
    for (const [cx, h, w, ph] of [[0.22, 0.62, 0.05, 0], [0.4, 0.8, 0.06, 2], [0.63, 0.7, 0.055, 4], [0.82, 0.5, 0.045, 1]]) {
      const t = (1 - v) / h, c = cx + Math.sin(v * 9 + ph) * 0.045, k = t < 1 ? ss(w * (1 - t * 0.6), w * (1 - t * 0.6) - 1.5 / n, Math.abs(u - c)) : 0;
      r += (8 - r) * k; g += (58 - g) * k; b += (40 - b) * k;
    }
    const d = Math.hypot(u - 0.5, v - 0.5), a = ss(0.5, 0.47, d);
    raw[o] = Math.min(255, r); raw[o + 1] = Math.min(255, g); raw[o + 2] = Math.min(255, b); raw[o + 3] = a * 255;
  }
  const h = Buffer.alloc(13); h.writeUInt32BE(n, 0); h.writeUInt32BE(n, 4); h[8] = 8; h[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', h), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
};
writeFileSync(new URL('icon.png', import.meta.url), png(80)); writeFileSync(new URL('largeIcon.png', import.meta.url), png(130));

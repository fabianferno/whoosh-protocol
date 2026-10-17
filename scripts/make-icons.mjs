// Generates the PWA icons (concentric "sound wave" arcs) as PNGs with no dependencies.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

function png(size) {
  const bg = [75, 74, 74];
  const fg = [255, 90, 31];
  const raw = Buffer.alloc((size * 3 + 1) * size);
  const cx = size * 0.3;
  const cy = size * 0.5;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x - cx, y - cy) / size;
      const angle = Math.atan2(y - cy, x - cx);
      let a = 0;
      if (dist < 0.045) a = 1;
      else if (Math.abs(angle) < 0.85) {
        for (const r of [0.2, 0.34, 0.48]) {
          const d = Math.abs(dist - r) - 0.028;
          a = Math.max(a, Math.min(1, Math.max(0, 0.5 - d * size)));
        }
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(bg[i] + (fg[i] - bg[i]) * a);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public', { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(`public/${name}`, png(size));
}
console.log('wrote public/icon-192.png, icon-512.png, apple-touch-icon.png');

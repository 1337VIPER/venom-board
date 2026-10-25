// QR codes for setting up two-step sign-in (the same encoder the app uses). Exposes window.VBQR.
'use strict';
(() => {
/* ---------- QR codes ---------- */
// A small QR encoder for the two-step sign-in setup: byte mode, error correction level M, versions 1–10
// (up to 213 bytes, plenty for an authenticator link). Returns rows of booleans (true = dark), or null if too long.
const QR_M = [null, [16, 10, [1, 16]], [28, 16, [1, 28]], [44, 26, [1, 44]], [64, 18, [2, 32]], [86, 24, [2, 43]], [108, 16, [4, 27]],
  [124, 18, [4, 31]], [154, 22, [2, 38], [2, 39]], [182, 22, [3, 36], [2, 37]], [216, 26, [4, 43], [1, 44]]];
const QR_ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const QR_VERSION = {7: 0x07C94, 8: 0x085BC, 9: 0x09A99, 10: 0x0A4D3};
function qrCode(text) {
  const data = [...new TextEncoder().encode(text)];
  let ver = 1;
  while (ver <= 10 && QR_M[ver][0] * 8 < 4 + (ver < 10 ? 8 : 16) + data.length * 8) ver++;
  if (ver > 10) return null;
  const [dataCw, ecPer, ...groups] = QR_M[ver];
  const bits = [], put = (v, len) => { for (let i = len - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(data.length, ver < 10 ? 8 : 16);
  for (const b of data) put(b, 8);
  put(0, Math.min(4, dataCw * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) cw.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
  for (let pad = 0xEC; cw.length < dataCw; pad ^= 0xEC ^ 0x11) cw.push(pad);
  // Reed-Solomon error correction over GF(256)
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11D; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  let gen = [1];
  for (let i = 0; i < ecPer; i++) {
    const next = new Array(gen.length + 1).fill(0);
    gen.forEach((g, j) => { next[j] ^= g; next[j + 1] ^= mul(g, EXP[i]); });
    gen = next;
  }
  const ecOf = block => {
    const res = new Array(ecPer).fill(0);
    for (const b of block) { const f = b ^ res.shift(); res.push(0); for (let j = 0; j < ecPer; j++) res[j] ^= mul(gen[j + 1], f); }
    return res;
  };
  const blocks = [];
  let k = 0;
  for (const [count, size] of groups) for (let i = 0; i < count; i++) { blocks.push(cw.slice(k, k + size)); k += size; }
  const ecs = blocks.map(ecOf), stream = [];
  for (let i = 0; i < Math.max(...blocks.map(b => b.length)); i++) for (const b of blocks) if (i < b.length) stream.push(b[i]);
  for (let i = 0; i < ecPer; i++) for (const e of ecs) stream.push(e[i]);
  // the module grid: finder, timing and alignment patterns, reserved format areas, version information
  const n = ver * 4 + 17, grid = [...Array(n)].map(() => new Array(n).fill(false)), fn = [...Array(n)].map(() => new Array(n).fill(false));
  const set = (r, c, v) => { grid[r][c] = v; fn[r][c] = true; };
  const finder = (r0, c0) => {
    for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
      const r = r0 + i, c = c0 + j;
      if (r < 0 || c < 0 || r >= n || c >= n) continue;
      set(r, c, i >= 0 && i <= 6 && j >= 0 && j <= 6 && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4)));
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const al = QR_ALIGN[ver], last = al[al.length - 1];
  for (const r of al) for (const c of al) {
    if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(r + i, c + j, Math.max(Math.abs(i), Math.abs(j)) !== 1);
  }
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(8, i, false); if (!fn[i][8]) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { set(8, n - 1 - i, false); set(n - 1 - i, 8, false); }
  set(n - 8, 8, true);
  if (ver >= 7) for (let i = 0; i < 18; i++) { const bit = ((QR_VERSION[ver] >> i) & 1) === 1, a = Math.floor(i / 3), b = n - 11 + (i % 3); set(a, b, bit); set(b, a, bit); }
  // data, in the zigzag order from the bottom right
  let bi = 0;
  const total = stream.length * 8, bitAt = i => ((stream[i >> 3] >> (7 - (i & 7))) & 1) === 1;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) for (let j = 0; j < 2; j++) {
      const c = right - j, r = ((right + 1) & 2) === 0 ? n - 1 - vert : vert;
      if (fn[r][c]) continue;
      grid[r][c] = bi < total ? bitAt(bi) : false; bi++;
    }
  }
  // pick the mask that reads best
  const MASKS = [(r, c) => (r + c) % 2 === 0, r => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0];
  const formatBits = mask => { let rem = mask; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537); return ((mask << 10) | rem) ^ 0x5412; };  // level M is 00
  const withMask = m => {
    const g = grid.map((row, r) => row.map((v, c) => (fn[r][c] ? v : v !== MASKS[m](r, c))));
    const f = formatBits(m), bit = i => ((f >> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) g[i][8] = bit(i);
    g[7][8] = bit(6); g[8][8] = bit(7); g[8][7] = bit(8);
    for (let i = 9; i < 15; i++) g[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i++) g[8][n - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) g[n - 15 + i][8] = bit(i);
    g[n - 8][8] = true;
    return g;
  };
  const penalty = g => {
    let p = 0, dark = 0;
    const lines = [...g, ...g[0].map((_, c) => g.map(row => row[c]))];
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= line.length; i++) {
        if (i < line.length && line[i] === line[i - 1]) run++;
        else { if (run >= 5) p += run - 2; run = 1; }
      }
      const s = line.map(v => (v ? 1 : 0)).join('');
      p += 40 * ((s.match(/(?=10111010000)/g) || []).length + (s.match(/(?=00001011101)/g) || []).length);
    }
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) { const v = g[r][c]; if (v === g[r][c + 1] && v === g[r + 1][c] && v === g[r + 1][c + 1]) p += 3; }
    for (const row of g) for (const v of row) if (v) dark++;
    return p + Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
  };
  let best = null, bestScore = Infinity;
  for (let m = 0; m < 8; m++) { const g = withMask(m), sc = penalty(g); if (sc < bestScore) { best = g; bestScore = sc; } }
  return best;
}
function drawQR(canvas, text, scale = 5) {
  const q = qrCode(text);
  if (!q) return false;
  const n = q.length, size = (n + 8) * scale, g = canvas.getContext('2d');
  canvas.width = canvas.height = size;
  g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
  g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q[r][c]) g.fillRect((c + 4) * scale, (r + 4) * scale, scale, scale);
  return true;
}
window.VBQR = { code: qrCode, draw: drawQR };
})();

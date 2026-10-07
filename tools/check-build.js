// Checks the Linux and macOS builds that GitHub Actions makes (.github/workflows/desktop.yml) before anything
// is signed or released.
//
//   node tools/check-build.js <run id>        (the number at the end of the run's address on GitHub)
//
// Signing an AppImage vouches for it to every installed Linux copy, so a build made on someone else's machines
// is only trusted once it's shown to be exactly what this computer makes from the same code:
//
//  1. The run built this checkout's exact commit (with no local changes), using the workflow in this repo, on
//     GitHub's own machines, in a single attempt, and succeeded. Someone who got into the GitHub account could
//     push other code and build it, but not under this commit.
//  2. Linux: the same AppImage is assembled here, and every file inside the downloaded one (the app, the
//     Electron runtime, the launcher, the icons, the bundled libraries) must be identical to it. The start-up
//     program in front must be the official one, and the update map on the end must describe the file exactly.
//  3. macOS: the app inside (its code and update settings) must be identical to the one made here. The Electron
//     engine around it can only be rebuilt on a Mac. macOS copies never install updates (they only show a link to
//     the release page), so macOS builds are never signed.
//
// Archives are read strictly. Anything another reader could take differently (names repeated or out of order,
// lookup indexes, links that differ in any way, extended attributes, special permissions, an app archive header
// that isn't plain JSON, a zip whose entries don't follow each other exactly) fails the check instead of being
// interpreted.
//
// When everything matches, a CHECKED.json is written next to the AppImage, and tools/sign-update.js only signs
// an AppImage that has one. The downloads stay in dist/ci-<run id>.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const REPO = '1337VIPER/venom-board';
const WORKFLOW = '.github/workflows/desktop.yml';
const ARTIFACTS = ['venom-board-linux', 'venom-board-macos'];
const { version } = require(path.join(root, 'package.json'));

const gh = (...args) => execFileSync(process.env.GH || 'gh', args, { encoding: 'utf8', maxBuffer: 256 << 20 });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sha = (data, alg = 'sha256') => crypto.createHash(alg).update(data).digest('hex');
const needs = what => (cond, msg) => { if (!cond) throw new Error(`${what}: ${msg}`); };
let failed = 0;
const ok = msg => console.log('  ok   ' + msg);
const bad = msg => { failed++; console.log('  FAIL ' + msg); };
const check = (good, msg) => (good ? ok(msg) : bad(msg));

/* ---------- squashfs, as mksquashfs makes it for AppImages: gzip, no fragments, no extended attributes ---------- */
function squashfs(buf, start) {
  const need = needs('AppImage');
  need(buf.readUInt32LE(start) === 0x73717368, 'no squashfs image where the runtime ends');
  const blockSize = buf.readUInt32LE(start + 12);
  need(buf.readUInt16LE(start + 20) === 1, 'unexpected compression (expected gzip)');
  need(buf.readUInt16LE(start + 28) === 4 && buf.readUInt16LE(start + 30) === 0, 'unexpected squashfs version');
  need(blockSize >= 4096 && blockSize <= 1048576 && !(blockSize & (blockSize - 1)), 'unexpected block size');
  need(buf.readUInt32LE(start + 16) === 0, 'fragments are not expected');
  need(buf.readBigUInt64LE(start + 56) === 0xffffffffffffffffn, 'extended attributes are not expected');
  const rootRef = buf.readBigUInt64LE(start + 32);
  const end = start + Number(buf.readBigUInt64LE(start + 40));
  const inodeTable = Number(buf.readBigUInt64LE(start + 64)), dirTable = Number(buf.readBigUInt64LE(start + 72));
  need(end <= buf.length && start + inodeTable < end && start + dirTable < end, 'image runs past the end of the file');
  // metadata is stored in blocks of up to 8 KiB, each with a 2-byte header (top bit: stored uncompressed)
  const blocks = new Map();
  const metaBlock = pos => {
    if (!blocks.has(pos)) {
      need(pos + 2 <= end, 'metadata outside the image');
      const h = buf.readUInt16LE(pos), size = h & 0x7fff;
      need(size > 0 && size <= 8192 && pos + 2 + size <= end, 'bad metadata block');
      const raw = buf.subarray(pos + 2, pos + 2 + size), data = h & 0x8000 ? raw : zlib.inflateSync(raw);
      need(data.length <= 8192, 'oversized metadata block');
      blocks.set(pos, { data, next: pos + 2 + size });
    }
    return blocks.get(pos);
  };
  const meta = (table, block, offset) => {
    let b = metaBlock(start + table + block), i = offset;
    const take = n => {
      const out = Buffer.alloc(n);
      for (let o = 0; o < n;) {
        if (i >= b.data.length) { b = metaBlock(b.next); i = 0; }
        const k = Math.min(n - o, b.data.length - i);
        b.data.copy(out, o, i, i + k); o += k; i += k;
      }
      return out;
    };
    return { take, u16: () => take(2).readUInt16LE(0), u32: () => take(4).readUInt32LE(0), u64: () => Number(take(8).readBigUInt64LE(0)) };
  };
  const noXattr = x => need(x === 0xffffffff, 'extended attributes are not expected');
  const inode = ref => {
    const r = meta(inodeTable, Number(ref >> 16n), Number(ref & 0xffffn));
    const type = r.u16(), mode = r.u16(); r.take(12);  // uid, gid, mtime, inode number
    need(!(mode & 0o7000), 'setuid, setgid or sticky permissions are not expected');
    if (type === 1) { const block = r.u32(); r.u32(); const size = r.u16(), offset = r.u16(); return { kind: 'dir', type: 1, block, offset, size }; }
    if (type === 8) {
      r.u32(); const size = r.u32(), block = r.u32(); r.u32(); const index = r.u16(), offset = r.u16(); noXattr(r.u32());
      need(index === 0, 'directory lookup indexes are not expected');
      return { kind: 'dir', type: 1, block, offset, size };
    }
    if (type === 2 || type === 9) {
      let at, frag, size;
      if (type === 2) { at = r.u32(); frag = r.u32(); r.u32(); size = r.u32(); } else { at = r.u64(); size = r.u64(); r.u64(); r.u32(); frag = r.u32(); r.u32(); noXattr(r.u32()); }
      need(frag === 0xffffffff, 'fragments are not expected');
      const sizes = Array.from({ length: Math.ceil(size / blockSize) }, () => r.u32());
      return { kind: 'file', type: 2, at, size, sizes };
    }
    if (type === 3 || type === 10) { r.u32(); const target = r.take(r.u32()).toString('utf8'); if (type === 10) noXattr(r.u32()); return { kind: 'link', type: 3, target }; }
    throw new Error(`AppImage: unexpected entry type ${type}`);
  };
  const read = f => {
    const parts = [];
    let pos = start + f.at, left = f.size;
    for (const s of f.sizes) {
      const n = s & 0xffffff, want = Math.min(blockSize, left);
      need(pos + n <= end, 'file data outside the image');
      const part = !n ? Buffer.alloc(want) : s & 0x1000000 ? buf.subarray(pos, pos + n) : zlib.inflateSync(buf.subarray(pos, pos + n));
      need(part.length === want, 'bad data block');
      parts.push(part); pos += n; left -= want;
    }
    return Buffer.concat(parts);
  };
  const files = new Map();
  (function walk(dir, prefix) {
    if (dir.size <= 3) return;
    const r = meta(dirTable, dir.block, dir.offset);
    let prev = null, left = dir.size - 3;
    while (left > 0) {
      const count = r.u32() + 1, inodeBlock = r.u32(); r.u32(); left -= 12;
      need(count <= 256, 'bad directory header');
      for (let k = 0; k < count; k++) {
        const offset = r.u16(); r.take(2); const type = r.u16(), bytes = r.u16() + 1, raw = r.take(bytes); left -= 8 + bytes;
        const name = raw.toString('utf8'), p = prefix + name;
        need(Buffer.from(name, 'utf8').equals(raw) && name !== '.' && name !== '..' && !/[/\0]/.test(name), `bad name ${JSON.stringify(p)}`);
        // in order and only once, so a reader looking a name up and a reader listing the folder find the same entry
        need(!prev || Buffer.compare(prev, raw) < 0, `name repeated or out of order: ${p}`);
        prev = raw;
        const node = inode((BigInt(inodeBlock) << 16n) | BigInt(offset));
        need(type === node.type || type === node.type + 7, `entry type doesn't match its contents: ${p}`);
        if (node.kind === 'dir') { files.set(p, { kind: 'dir' }); walk(node, p + '/'); }
        else if (node.kind === 'link') files.set(p, { kind: 'link', target: node.target });
        else { const data = read(node); files.set(p, { kind: 'file', size: data.length, hash: sha(data), data: /\.(asar|yml)$/.test(p) ? data : null }); }
      }
    }
    need(left === 0, 'directory listing overruns');
  })(inode(rootRef), '');
  return { files, end };
}

/* ---------- app archives (app.asar) ---------- */
// The header has to be plain JSON that reads back exactly (no repeated keys or other tricks), so Electron and
// this check can't read it differently.
function asarParts(buf) {
  const need = needs('app.asar');
  need(buf.length >= 16 && buf.readUInt32LE(0) === 4, 'bad header');
  const headerSize = buf.readUInt32LE(4), payload = buf.readUInt32LE(8), jsonSize = buf.readUInt32LE(12);
  need(payload + 4 === headerSize && jsonSize + 4 <= payload && payload - jsonSize - 4 < 4 && 8 + headerSize <= buf.length, 'bad header sizes');
  const text = buf.toString('utf8', 16, 16 + jsonSize), header = JSON.parse(text);
  need(JSON.stringify(header) === text, "the header isn't plain JSON");
  return { header, data: buf.subarray(8 + headerSize) };
}
// files in an archive by path, with each file's SHA-256 (or what it links to)
function asarFiles(buf) {
  const { header, data } = asarParts(buf), out = new Map();
  (function walk(node, prefix) {
    for (const [name, e] of Object.entries(node.files || {})) {
      const p = prefix + name;
      if (e.files) walk(e, p + '/');
      else if (e.link) out.set(p, 'link ' + e.link);
      else if (e.unpacked) out.set(p, 'unpacked');
      else out.set(p, sha(data.subarray(Number(e.offset), Number(e.offset) + e.size)));
    }
  })(header, '');
  return out;
}
// The same archive: identical bytes, or identical apart from which files are marked executable (Windows has no
// such mark), with the same header otherwise and exactly the same contents.
function sameArchive(theirs, ours) {
  if (theirs.equals(ours)) return true;
  const a = asarParts(theirs), b = asarParts(ours);
  const strip = node => { for (const e of Object.values(node.files || {})) { if (e.files) strip(e); else delete e.executable; } return node; };
  return JSON.stringify(strip(a.header)) === JSON.stringify(strip(b.header)) && a.data.equals(b.data);
}

/* ---------- zip files (the macOS build) ---------- */
// The entries must follow each other exactly from the start of the file, with local headers that agree with the
// directory at the end, so a reader walking the file from the start sees the same files as one using the directory.
function zipFiles(buf) {
  const need = needs('zip');
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  need(e >= 0 && e + 22 + buf.readUInt16LE(e + 20) === buf.length, 'no end record');
  need(buf.readUInt16LE(e + 4) === 0 && buf.readUInt16LE(e + 6) === 0 && buf.readUInt16LE(e + 8) === buf.readUInt16LE(e + 10), 'split zip files are not expected');
  let count = buf.readUInt16LE(e + 10), size = buf.readUInt32LE(e + 12), at = buf.readUInt32LE(e + 16), cdEnd = e;
  if (count === 0xffff || size === 0xffffffff || at === 0xffffffff) {
    need(buf.readUInt32LE(e - 20) === 0x07064b50, 'missing zip64 locator');
    const z = Number(buf.readBigUInt64LE(e - 12));
    need(buf.readUInt32LE(z) === 0x06064b50 && z + 56 === e - 20, 'bad zip64 end record');
    count = Number(buf.readBigUInt64LE(z + 32)); size = Number(buf.readBigUInt64LE(z + 40)); at = Number(buf.readBigUInt64LE(z + 48)); cdEnd = z;
  }
  const list = [];
  let p = at;
  for (let i = 0; i < count; i++) {
    need(buf.readUInt32LE(p) === 0x02014b50, 'damaged central directory');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), comp = buf.readUInt32LE(p + 20), full = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    need(comp !== 0xffffffff && full !== 0xffffffff && local !== 0xffffffff, 'zip64 entries are not expected');
    need((method === 0 || method === 8) && !(flags & 1), `unexpected compression or encryption: ${name}`);
    list.push({ name, method, comp, full, local });
    p += 46 + nl + xl + cl;
  }
  need(p === at + size && p === cdEnd, "the central directory isn't where the end record says");
  const names = new Set();
  let pos = 0;
  for (const en of list) {
    need(en.local === pos && buf.readUInt32LE(pos) === 0x04034b50, `entries don't follow each other: ${en.name}`);
    const flags = buf.readUInt16LE(pos + 6), nl = buf.readUInt16LE(pos + 26), xl = buf.readUInt16LE(pos + 28);
    need(buf.readUInt16LE(pos + 8) === en.method && buf.toString('utf8', pos + 30, pos + 30 + nl) === en.name, `local header disagrees: ${en.name}`);
    if (!(flags & 8)) need(buf.readUInt32LE(pos + 18) === en.comp && buf.readUInt32LE(pos + 22) === en.full, `local sizes disagree: ${en.name}`);
    const parts = en.name.split('/');
    need(en.name && !names.has(en.name) && !en.name.startsWith('/') && !/[\\\0]/.test(en.name) && !parts.includes('..') && !parts.includes('.') && !parts.slice(0, -1).includes(''), `bad or repeated name: ${en.name}`);
    names.add(en.name);
    en.data = pos + 30 + nl + xl;
    pos = en.data + en.comp;
    if (flags & 8) pos += buf.readUInt32LE(pos) === 0x08074b50 ? 16 : 12;
  }
  need(pos === at, 'unexpected data before the central directory');
  const byName = new Map(list.map(en => [en.name, en]));
  const read = name => {
    const en = byName.get(name);
    if (!en) return null;
    const raw = buf.subarray(en.data, en.data + en.comp), out = en.method === 0 ? raw : zlib.inflateRawSync(raw);
    need(out.length === en.full, `wrong size: ${name}`);
    return out;
  };
  return { names: list.map(en => en.name), read };
}

/* ---------- the same Linux build, assembled on this computer ---------- */
// electron-builder assembles the AppImage's contents in a folder and hands it to mksquashfs, a Linux program.
// Here that one step is caught: the folder is kept to compare against, and nothing else changes.
async function referenceLinux() {
  const ab = path.dirname(require.resolve('app-builder-lib/package.json', { paths: [root] }));
  const util = require(require.resolve('builder-util', { paths: [ab] }));
  const fsx = require(require.resolve('fs-extra', { paths: [ab] }));
  const { build, Platform, Arch } = require(require.resolve('electron-builder', { paths: [root] }));
  const { getAppImageTools } = require(path.join(ab, 'out', 'toolsets', 'linux'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-reference-'));
  const links = new Map(), files = new Map();
  const realExec = util.exec, realLink = fsx.symlink;
  fsx.symlink = async (target, where) => { links.set(path.resolve(String(where)), String(target)); };  // Windows can't always make links
  util.exec = async (file, args, ...rest) => {
    if (path.basename(file) !== 'mksquashfs') return realExec(file, args, ...rest);
    const stage = path.resolve(args[0]);
    (function walk(dir, prefix) {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, d.name), p = prefix + d.name;
        if (d.isDirectory()) { files.set(p, { kind: 'dir' }); walk(full, p + '/'); }
        else { const data = fs.readFileSync(full); files.set(p, { kind: 'file', size: data.length, hash: sha(data), data: /\.(asar|yml)$/.test(p) ? data : null }); }
      }
    })(stage, '');
    for (const [where, target] of links) if (where.startsWith(stage + path.sep)) files.set(path.relative(stage, where).replace(/\\/g, '/'), { kind: 'link', target: target.replace(/\\/g, '/') });
    fs.writeFileSync(args[1], '');
    return '';
  };
  try {
    await build({ projectDir: root, targets: Platform.LINUX.createTarget('AppImage', Arch.x64), publish: 'never', config: { directories: { output: out } } });
  } finally {
    util.exec = realExec; fsx.symlink = realLink;
    fs.rmSync(out, { recursive: true, force: true });
  }
  if (!files.size) throw new Error("the reference build didn't get as far as packing the AppImage");
  const runtime = fs.readFileSync((await getAppImageTools('0.0.0', Arch.x64)).runtime);
  return { files, runtime };
}
// where the AppImage runtime itself looks for the image: right after its ELF section headers
const elfEnd = b => (b.readUInt32BE(0) === 0x7f454c46 && b[4] === 2 ? Number(b.readBigUInt64LE(0x28)) + b.readUInt16LE(0x3a) * b.readUInt16LE(0x3c) : -1);

async function main() {
  const runId = process.argv[2];
  if (!/^\d+$/.test(runId || '')) { console.error('Usage: node tools/check-build.js <run id>'); process.exit(2); }

  console.log(`\nThe run (${REPO} #${runId})`);
  const commit = git('rev-parse', 'HEAD');
  check(!git('status', '--porcelain', '--untracked-files=no'), 'this checkout has no uncommitted changes');
  const run = JSON.parse(gh('api', `repos/${REPO}/actions/runs/${runId}`));
  check(run.repository && run.repository.full_name === REPO && run.head_repository && run.head_repository.full_name === REPO, 'it ran in this repository, not a fork');
  check(String(run.path || '').split('@')[0] === WORKFLOW, `it ran ${WORKFLOW}`);
  check(['push', 'workflow_dispatch'].includes(run.event), `it was started by a tag or by hand (${run.event})`);
  check(run.head_sha === commit, `it built this checkout's commit ${commit.slice(0, 12)}${run.head_sha === commit ? '' : ` (it built ${String(run.head_sha).slice(0, 12)})`}`);
  check(run.run_attempt === 1, 'it ran once (a re-run could mix in builds from an earlier attempt)');
  check(run.status === 'completed' && run.conclusion === 'success', 'it finished successfully');
  const jobs = JSON.parse(gh('api', `repos/${REPO}/actions/runs/${runId}/jobs?filter=all&per_page=100`)).jobs || [];
  const hosted = j => j.runner_group_name === 'GitHub Actions' && /^GitHub Actions \d+$/.test(j.runner_name || '') && j.conclusion === 'success' && j.run_attempt === 1;
  check(jobs.length === ARTIFACTS.length && jobs.every(hosted), `every job ran on GitHub's own machines (${jobs.map(j => `${j.name}: ${j.runner_name}`).join(', ')})`);
  const arts = JSON.parse(gh('api', `repos/${REPO}/actions/runs/${runId}/artifacts?per_page=100`)).artifacts || [];
  check(arts.map(a => a.name).sort().join() === ARTIFACTS.join() && arts.every(a => !a.expired), `it made exactly the expected downloads (${arts.map(a => a.name).join(', ')})`);
  if (failed) { console.log('\nThis run is not a build of this checkout, so nothing else was checked.'); process.exit(1); }

  const dir = path.join(root, 'dist', 'ci-' + runId);
  fs.rmSync(dir, { recursive: true, force: true });
  gh('run', 'download', runId, '-R', REPO, '-D', dir);
  const found = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : found.push(path.join(d, e.name)); })(dir);
  const appImage = found.find(f => path.basename(f) === `VenomBoard-${version}.AppImage`);
  const macZip = found.find(f => path.basename(f) === `VenomBoard-${version}-mac.zip`);

  console.log('\nThe same Linux build, made on this computer');
  const ref = await referenceLinux();
  const refAsar = ref.files.get('resources/app.asar').data;
  // its own app files must be the committed ones (electron-builder writes its own package.json, compared below)
  const own = [...asarFiles(refAsar)].filter(([p]) => !p.startsWith('node_modules/') && p !== 'package.json');
  check(own.length > 0 && own.every(([p, h]) => h === sha(execFileSync('git', ['cat-file', 'blob', `HEAD:${p}`], { cwd: root, maxBuffer: 64 << 20 }))), `it uses exactly the committed app files (${own.map(([p]) => p).join(', ')})`);
  check(elfEnd(ref.runtime) === ref.runtime.length, 'the official AppImage runtime starts the image right where it ends');

  console.log(`\nLinux: ${appImage ? path.relative(root, appImage) : `VenomBoard-${version}.AppImage is missing`}`);
  if (appImage) {
    const buf = fs.readFileSync(appImage);
    check(buf.subarray(0, ref.runtime.length).equals(ref.runtime), 'its start-up program is the official AppImage runtime electron-builder uses');
    let img = null;
    try { img = squashfs(buf, ref.runtime.length); } catch (e) { bad(e.message); }
    if (img) {
      const theirs = img.files, ours = ref.files, diff = [];
      for (const p of [...new Set([...theirs.keys(), ...ours.keys()])].sort()) {
        const a = theirs.get(p), b = ours.get(p);
        if (!a || !b) diff.push(`${a ? 'extra' : 'missing'} ${p}`);
        else if (a.kind !== b.kind || a.target !== b.target) diff.push(`different ${p}`);  // links must point at exactly the same place
        else if (a.kind === 'file' && a.hash !== b.hash && !(p.endsWith('.asar') && sameArchive(a.data, b.data))) diff.push(`different ${p}`);
      }
      const count = [...ours.values()].filter(e => e.kind === 'file').length;
      check(!diff.length, `every file inside is identical to this computer's build (${count} files, ${asarFiles(refAsar).size} in the app)${diff.length ? ':\n         ' + diff.slice(0, 20).join('\n         ') : ''}`);
      // after the image: padding, then the map electron-builder appends for smaller update downloads
      const len = buf.readUInt32BE(buf.length - 4), mapAt = buf.length - 4 - len;
      let map = null;
      try { map = JSON.parse(zlib.inflateRawSync(buf.subarray(mapAt, buf.length - 4))); } catch (e) { /* reported below */ }
      const gap = mapAt >= img.end ? buf.subarray(img.end, mapAt) : null;
      check(gap && gap.length < 4096 && gap.every(x => x === 0) && map && Array.isArray(map.files), 'nothing else is in the file except its update map');
      if (map && gap) {
        const ab = path.dirname(require.resolve('app-builder-lib/package.json', { paths: [root] }));
        const { buildBlockMap } = require(path.join(ab, 'out', 'targets', 'blockmap', 'blockmap'));
        const head = path.join(os.tmpdir(), `vb-head-${process.pid}`), fresh = head + '.blockmap';
        fs.writeFileSync(head, buf.subarray(0, mapAt));
        await buildBlockMap(head, 'gzip', fresh);
        check(JSON.stringify(JSON.parse(zlib.gunzipSync(fs.readFileSync(fresh)))) === JSON.stringify(map), 'the update map describes the file exactly');
        fs.rmSync(head, { force: true }); fs.rmSync(fresh, { force: true });
      }
    }
  }

  console.log(`\nmacOS: ${macZip ? path.relative(root, macZip) : `VenomBoard-${version}-mac.zip is missing`}`);
  if (macZip) {
    let zip = null;
    try { zip = zipFiles(fs.readFileSync(macZip)); } catch (e) { bad(e.message); }
    if (zip) {
      check(zip.names.length > 0 && zip.names.every(n => n.startsWith('Venom Board.app/')), `it holds only Venom Board.app (${zip.names.length} entries)`);
      const asar = zip.read('Venom Board.app/Contents/Resources/app.asar');
      let same = false;
      try { same = !!asar && sameArchive(asar, refAsar); } catch (e) { bad(e.message); }
      check(same, 'the app inside (Contents/Resources/app.asar) is identical to this computer\'s build');
      check(!zip.names.some(n => n.includes('app.asar.unpacked')), 'nothing is kept outside the app archive');
      const yml = zip.read('Venom Board.app/Contents/Resources/app-update.yml');
      check(yml && /^owner: 1337VIPER$/m.test(yml) && /^repo: venom-board$/m.test(yml) && /^provider: github$/m.test(yml), 'it looks for new versions on this repository');
    }
  }

  if (failed || !appImage) { console.log(`\n${failed || 1} check${failed === 1 ? '' : 's'} failed. Don't sign or release these builds.`); process.exit(1); }
  fs.writeFileSync(path.join(path.dirname(appImage), 'CHECKED.json'), JSON.stringify({ run: Number(runId), commit, files: { [path.basename(appImage)]: sha(fs.readFileSync(appImage), 'sha512') } }, null, 2) + '\n');
  console.log(`\nEverything matches. Sign the AppImage with:\n  node tools/sign-update.js "${path.relative(root, appImage)}"`);
}
if (require.main === module) main().catch(e => { console.error('\n' + (e.stack || e)); process.exit(1); });
module.exports = { squashfs, asarFiles, sameArchive, zipFiles, referenceLinux, elfEnd };

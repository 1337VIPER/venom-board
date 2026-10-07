// Checks the Linux and macOS builds that GitHub Actions makes (.github/workflows/desktop.yml) before anything
// is signed or released.
//
//   node tools/check-build.js <run id>        (the number at the end of the run's address on GitHub)
//
// Signing an AppImage vouches for it to every installed Linux copy, so a build made on someone else's machines
// is only trusted once it's shown to be exactly what this computer makes from the same code:
//
//  1. The run built this checkout's exact commit (with no local changes), using the workflow in this repo, on
//     GitHub's own machines, and succeeded. Someone who got into the GitHub account could push other code and
//     build it, but not under this commit.
//  2. Linux: the same AppImage is assembled here, and every file inside the downloaded one (the app, the
//     Electron runtime, the launcher, the icons, the bundled libraries) must be identical to it. The start-up
//     program in front must be the official one, and the update map on the end must describe the file exactly.
//  3. macOS: the app inside (its code and update settings) must be identical to the one made here. The Electron
//     engine around it can only be rebuilt on a Mac. macOS copies never install updates (they only show a link to
//     the release page), so macOS builds are never signed.
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
const { version } = require(path.join(root, 'package.json'));

const gh = (...args) => execFileSync(process.env.GH || 'gh', args, { encoding: 'utf8', maxBuffer: 256 << 20 });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sha = (data, alg = 'sha256') => crypto.createHash(alg).update(data).digest('hex');
let failed = 0;
const ok = msg => console.log('  ok   ' + msg);
const bad = msg => { failed++; console.log('  FAIL ' + msg); };
const check = (good, msg) => (good ? ok(msg) : bad(msg));

/* ---------- squashfs (as made by mksquashfs for AppImages: gzip, no fragments, no xattrs) ---------- */
function squashfs(buf, start) {
  if (buf.readUInt32LE(start) !== 0x73717368) throw new Error('no squashfs image where the AppImage runtime ends');
  const blockSize = buf.readUInt32LE(start + 12);
  if (buf.readUInt16LE(start + 20) !== 1) throw new Error('unexpected squashfs compression (expected gzip)');
  if (buf.readUInt16LE(start + 28) !== 4) throw new Error('unexpected squashfs version');
  const rootRef = buf.readBigUInt64LE(start + 32);
  const bytesUsed = Number(buf.readBigUInt64LE(start + 40));
  const inodeTable = Number(buf.readBigUInt64LE(start + 64));
  const dirTable = Number(buf.readBigUInt64LE(start + 72));
  // metadata is stored in blocks of up to 8 KiB, each with a 2-byte header (top bit: stored uncompressed)
  const blocks = new Map();
  const metaBlock = pos => {
    if (!blocks.has(pos)) {
      const h = buf.readUInt16LE(pos), raw = buf.subarray(pos + 2, pos + 2 + (h & 0x7fff));
      blocks.set(pos, { data: h & 0x8000 ? raw : zlib.inflateSync(raw), next: pos + 2 + (h & 0x7fff) });
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
  const inode = ref => {
    const r = meta(inodeTable, Number(ref >> 16n), Number(ref & 0xffffn));
    const type = r.u16(); r.take(14);  // mode, uid, gid, mtime, inode number
    if (type === 1) { const block = r.u32(); r.u32(); const size = r.u16(), offset = r.u16(); return { kind: 'dir', block, offset, size }; }
    if (type === 8) { r.u32(); const size = r.u32(), block = r.u32(); r.u32(); r.u16(); const offset = r.u16(); return { kind: 'dir', block, offset, size }; }
    if (type === 2 || type === 9) {
      let at, frag, size;
      if (type === 2) { at = r.u32(); frag = r.u32(); r.u32(); size = r.u32(); } else { at = r.u64(); size = r.u64(); r.u64(); r.u32(); frag = r.u32(); r.u32(); r.u32(); }
      if (frag !== 0xffffffff) throw new Error('unexpected fragment in squashfs image');
      const sizes = Array.from({ length: Math.ceil(size / blockSize) }, () => r.u32());
      return { kind: 'file', at, size, sizes };
    }
    if (type === 3 || type === 10) { r.u32(); return { kind: 'link', target: r.take(r.u32()).toString('utf8') }; }
    throw new Error(`unexpected entry type ${type} in squashfs image`);
  };
  const read = f => {
    const parts = [];
    let pos = start + f.at, left = f.size;
    for (const s of f.sizes) {
      const n = s & 0xffffff, want = Math.min(blockSize, left);
      if (!n) parts.push(Buffer.alloc(want));
      else { const raw = buf.subarray(pos, pos + n); parts.push(s & 0x1000000 ? raw : zlib.inflateSync(raw)); pos += n; }
      left -= want;
    }
    const data = Buffer.concat(parts);
    if (data.length !== f.size) throw new Error('squashfs file has the wrong size');
    return data;
  };
  const files = new Map();
  (function walk(dir, prefix) {
    if (dir.size <= 3) return;
    const r = meta(dirTable, dir.block, dir.offset);
    for (let left = dir.size - 3; left > 0;) {
      const count = r.u32() + 1, inodeBlock = r.u32(); r.u32(); left -= 12;
      for (let k = 0; k < count; k++) {
        const offset = r.u16(); r.take(4); const bytes = r.u16() + 1, name = r.take(bytes).toString('utf8'); left -= 8 + bytes;
        if (!name || name === '.' || name === '..' || name.includes('/')) throw new Error(`bad name in squashfs image: ${name}`);
        const p = prefix + name, node = inode((BigInt(inodeBlock) << 16n) | BigInt(offset));
        if (node.kind === 'dir') { files.set(p, { kind: 'dir' }); walk(node, p + '/'); }
        else if (node.kind === 'link') files.set(p, { kind: 'link', target: node.target });
        else { const data = read(node); files.set(p, { kind: 'file', size: data.length, hash: sha(data), data: /\.(asar|yml)$/.test(p) ? data : null }); }
      }
    }
  })(inode(rootRef), '');
  return { files, end: start + bytesUsed };
}

/* ---------- asar archives: compare what's inside, file by file ---------- */
function asarFiles(buf) {
  const headerSize = buf.readUInt32LE(4), header = JSON.parse(buf.toString('utf8', 16, 16 + buf.readUInt32LE(12)));
  const base = 8 + headerSize, out = new Map();
  (function walk(node, prefix) {
    for (const [name, e] of Object.entries(node.files || {})) {
      const p = prefix + name;
      if (e.files) walk(e, p + '/');
      else if (e.link) out.set(p, 'link ' + e.link);
      else if (e.unpacked) out.set(p, 'unpacked');
      else { const at = base + Number(e.offset); out.set(p, sha(buf.subarray(at, at + e.size))); }
    }
  })(header, '');
  return out;
}
function sameAsar(theirs, ours, label) {
  const a = asarFiles(theirs), b = asarFiles(ours), diff = [];
  for (const p of new Set([...a.keys(), ...b.keys()])) if (a.get(p) !== b.get(p)) diff.push(!a.has(p) ? `missing ${p}` : !b.has(p) ? `extra ${p}` : `different ${p}`);
  check(!diff.length, `${label}: the app inside is identical (${b.size} files)${diff.length ? ': ' + diff.slice(0, 8).join(', ') : ''}`);
}

/* ---------- zip archives (the macOS build) ---------- */
function zipFiles(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip file');
  let count = buf.readUInt16LE(e + 10), at = buf.readUInt32LE(e + 16);
  if ((count === 0xffff || at === 0xffffffff) && buf.readUInt32LE(e - 20) === 0x07064b50) {
    const z = Number(buf.readBigUInt64LE(e - 12));
    count = Number(buf.readBigUInt64LE(z + 32)); at = Number(buf.readBigUInt64LE(z + 48));
  }
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('damaged zip file');
    const nl = buf.readUInt16LE(at + 28), xl = buf.readUInt16LE(at + 30), cl = buf.readUInt16LE(at + 32);
    entries.set(buf.toString('utf8', at + 46, at + 46 + nl), { method: buf.readUInt16LE(at + 10), comp: buf.readUInt32LE(at + 20), local: buf.readUInt32LE(at + 42) });
    at += 46 + nl + xl + cl;
  }
  const read = name => {
    const en = entries.get(name);
    if (!en) return null;
    const from = en.local + 30 + buf.readUInt16LE(en.local + 26) + buf.readUInt16LE(en.local + 28), data = buf.subarray(from, from + en.comp);
    return en.method === 0 ? data : zlib.inflateRawSync(data);
  };
  return { names: [...entries.keys()], read };
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
        if (links.has(full)) files.set(p, { kind: 'link', target: links.get(full).replace(/\\/g, '/') });
        else if (d.isDirectory()) { files.set(p, { kind: 'dir' }); walk(full, p + '/'); }
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
  const tools = await getAppImageTools('0.0.0', Arch.x64);
  return { files, runtime: fs.readFileSync(tools.runtime) };
}
// a link inside the image, followed to the file it points at
const follow = (files, p) => {
  for (let i = 0, e = files.get(p); i < 8 && e; i++) {
    if (e.kind !== 'link') return e;
    p = path.posix.normalize(path.posix.join(path.posix.dirname(p), e.target));
    e = files.get(p);
  }
  return null;
};

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
  check(run.status === 'completed' && run.conclusion === 'success', 'it finished successfully');
  const jobs = JSON.parse(gh('api', `repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`)).jobs || [];
  check(jobs.length > 0 && jobs.every(j => j.runner_group_name === 'GitHub Actions'), `every job ran on GitHub's own machines (${jobs.map(j => `${j.name}: ${j.runner_group_name}`).join(', ')})`);
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

  console.log(`\nLinux: ${appImage ? path.relative(root, appImage) : `VenomBoard-${version}.AppImage is missing`}`);
  if (appImage) {
    const buf = fs.readFileSync(appImage);
    check(buf.subarray(0, ref.runtime.length).equals(ref.runtime), "its start-up program is the official AppImage runtime electron-builder uses");
    const img = squashfs(buf, ref.runtime.length);
    const theirs = img.files, ours = ref.files, diff = [];
    for (const p of [...new Set([...theirs.keys(), ...ours.keys()])].sort()) {
      const a = theirs.get(p), b = ours.get(p);
      if (!a || !b) { diff.push(`${a ? 'extra' : 'missing'} ${p}`); continue; }
      if (a.kind === 'link' || b.kind === 'link') {
        const fa = follow(theirs, p), fb = follow(ours, p);
        if (!(a.kind === b.kind && a.target === b.target) && !(fa && fb && fa.hash === fb.hash)) diff.push(`different link ${p}`);
        continue;
      }
      if (a.kind !== b.kind) diff.push(`different ${p}`);
      else if (a.kind === 'file' && a.hash !== b.hash) {
        // asar headers can record file modes Windows doesn't have, so archives are compared by what's inside
        if (p.endsWith('.asar')) { const x = asarFiles(a.data), y = asarFiles(b.data); if (x.size !== y.size || [...x].some(([k, v]) => y.get(k) !== v)) diff.push(`different ${p}`); }
        else diff.push(`different ${p}`);
      }
    }
    const count = [...ours.values()].filter(e => e.kind === 'file').length;
    check(!diff.length, `every file inside is identical to this computer's build (${count} files)${diff.length ? ':\n         ' + diff.slice(0, 20).join('\n         ') : ''}`);
    const asar = theirs.get('resources/app.asar');
    if (asar && asar.data) sameAsar(asar.data, ours.get('resources/app.asar').data, 'resources/app.asar');
    // after the image: padding, then the map electron-builder appends for smaller update downloads
    const len = buf.readUInt32BE(buf.length - 4), mapAt = buf.length - 4 - len;
    let map = null;
    try { map = JSON.parse(zlib.inflateRawSync(buf.subarray(mapAt, buf.length - 4))); } catch (e) { /* reported below */ }
    const gap = mapAt >= img.end ? buf.subarray(img.end, mapAt) : null;
    check(gap && gap.length < 4096 && gap.every(x => x === 0) && map && Array.isArray(map.files), 'nothing else is in the file except its update map');
    if (map && gap) {
      const head = path.join(os.tmpdir(), `vb-head-${process.pid}`);
      fs.writeFileSync(head, buf.subarray(0, mapAt));
      const ab = path.dirname(require.resolve('app-builder-lib/package.json', { paths: [root] }));
      const { buildBlockMap } = require(path.join(ab, 'out', 'targets', 'blockmap', 'blockmap'));
      const fresh = head + '.blockmap';
      await buildBlockMap(head, 'gzip', fresh);
      const mine = JSON.parse(zlib.gunzipSync(fs.readFileSync(fresh)));
      check(JSON.stringify(mine) === JSON.stringify(map), 'the update map describes the file exactly');
      fs.rmSync(head, { force: true }); fs.rmSync(fresh, { force: true });
    }
  }

  console.log(`\nmacOS: ${macZip ? path.relative(root, macZip) : `VenomBoard-${version}-mac.zip is missing`}`);
  if (macZip) {
    const zip = zipFiles(fs.readFileSync(macZip));
    check(zip.names.length > 0 && zip.names.every(n => n.startsWith('Venom Board.app/')), `it holds only Venom Board.app (${zip.names.length} entries)`);
    const asar = zip.read('Venom Board.app/Contents/Resources/app.asar');
    if (asar) sameAsar(asar, ref.files.get('resources/app.asar').data, 'Contents/Resources/app.asar'); else bad('Contents/Resources/app.asar is missing');
    check(!zip.names.some(n => n.includes('app.asar.unpacked')), 'nothing is kept outside the app archive');
    const yml = zip.read('Venom Board.app/Contents/Resources/app-update.yml');
    check(yml && /^owner: 1337VIPER$/m.test(yml) && /^repo: venom-board$/m.test(yml) && /^provider: github$/m.test(yml), 'it looks for new versions on this repository');
  }

  if (failed || !appImage) { console.log(`\n${failed} check${failed === 1 ? '' : 's'} failed. Don't sign or release these builds.`); process.exit(1); }
  fs.writeFileSync(path.join(path.dirname(appImage), 'CHECKED.json'), JSON.stringify({ run: Number(runId), commit, files: { [path.basename(appImage)]: sha(fs.readFileSync(appImage), 'sha512') } }, null, 2) + '\n');
  console.log(`\nEverything matches. Sign the AppImage with:\n  node tools/sign-update.js "${path.relative(root, appImage)}"`);
}
if (require.main === module) main().catch(e => { console.error('\n' + (e.stack || e)); process.exit(1); });
module.exports = { squashfs, asarFiles, zipFiles, referenceLinux };

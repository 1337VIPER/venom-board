// Signs Venom Board release files with the private update key, so installed copies accept them as updates.
// Each file and its .sig go on the GitHub release.
//
//   node tools/sign-update.js                  signs dist/VenomBoard-Setup-<package.json version>.exe
//   node tools/sign-update.js <file> [...]     signs each file: the Windows installer, the Linux AppImage,
//                                              the macOS zip and dmg (VenomBoard-<version>[-mac].<ext>)
//
// The private key lives outside the repo (~/.venom-board/update-signing-key.pem, or the VB_UPDATE_KEY
// path) and must never be committed or uploaded anywhere. Keep a safe offline backup of it: without it,
// installed copies can't be sent updates.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const files = process.argv.length > 2 ? process.argv.slice(2) : [path.join(root, 'dist', `VenomBoard-Setup-${version}.exe`)];

const keyFile = process.env.VB_UPDATE_KEY || path.join(os.homedir(), '.venom-board', 'update-signing-key.pem');
const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const pem = ((main.match(/UPDATE_PUBLIC_KEY = '([^']+)'/) || [])[1] || '').replace(/\\n/g, '\n');

let failed = false;
for (const file of files) {
  const name = path.basename(file);
  const v = name.replace(/^VenomBoard-(Setup-)?/, '').replace(/(-mac)?\.(exe|AppImage|zip|dmg)$/, '');
  if (!/^VenomBoard-/.test(name) || !/\.(exe|AppImage|zip|dmg)$/.test(name) || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/.test(v) || !fs.existsSync(file)) {
    console.error(`Not a Venom Board release file: ${file}`);
    failed = true;
    continue;
  }
  const hash = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('hex');
  const message = Buffer.from(`venom-board-update\n${v}\n${hash}\n`);
  const signature = crypto.sign(null, message, key);
  // checked exactly the way the app will, against the public key built into the app
  if (!pem || !crypto.verify(null, message, pem, signature)) {
    console.error("This key doesn't match the public key built into the app (electron/main.js). Nothing was signed.");
    process.exit(1);
  }
  fs.writeFileSync(file + '.sig', signature.toString('base64') + '\n');
  console.log(`Signed ${name} -> ${name}.sig`);
}
process.exit(failed ? 1 : 0);

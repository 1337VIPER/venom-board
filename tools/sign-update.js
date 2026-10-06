// Signs a Venom Board installer with the private update key, so installed copies accept it as an update.
// The installer and its .sig file both go on the GitHub release.
//
//   node tools/sign-update.js                         signs dist/VenomBoard-Setup-<package.json version>.exe
//   node tools/sign-update.js path/to/VenomBoard-Setup-1.2.0.exe
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
const file = process.argv[2] || path.join(root, 'dist', `VenomBoard-Setup-${version}.exe`);
const m = path.basename(file).match(/^VenomBoard-Setup-(.+)\.exe$/);
if (!m || !fs.existsSync(file)) {
  console.error(`No installer found at ${file}`);
  process.exit(1);
}

const keyFile = process.env.VB_UPDATE_KEY || path.join(os.homedir(), '.venom-board', 'update-signing-key.pem');
const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
const hash = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('hex');
const message = Buffer.from(`venom-board-update\n${m[1]}\n${hash}\n`);
const signature = crypto.sign(null, message, key);

// check it exactly the way the app will, against the public key built into the app
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const pem = (main.match(/UPDATE_PUBLIC_KEY = '([^']+)'/) || [])[1];
if (!pem || !crypto.verify(null, message, pem.replace(/\\n/g, '\n'), signature)) {
  console.error("This key doesn't match the public key built into the app (electron/main.js). Nothing was signed.");
  process.exit(1);
}
fs.writeFileSync(file + '.sig', signature.toString('base64') + '\n');
console.log(`Signed ${path.basename(file)} -> ${path.basename(file)}.sig`);

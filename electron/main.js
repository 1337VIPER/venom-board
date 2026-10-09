// Venom Board desktop shell: frameless window, pin on top, opacity, window lock,
// click-through with a global "turn it off" shortcut, screenshots from any app, native file dialogs and automatic updates.
const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, Tray, Menu, net, session, nativeImage, desktopCapturer, screen, clipboard, systemPreferences } = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

app.setAppUserModelId('com.venomboard.app');
const MAC = process.platform === 'darwin', WIN = process.platform === 'win32';
const RELEASES = 'https://github.com/1337VIPER/venom-board/releases/latest';

const ROOT = path.join(__dirname, '..');
// Developer modes (electron/dev): VB_SMOKE=<dir> runs the self-test, VB_SHOTS=<dir> renders the README screenshots,
// VB_LAYOUT=<dir> checks the layout across screen and interface sizes.
const DEV = process.env.VB_SMOKE ? ['smoke', process.env.VB_SMOKE] : process.env.VB_SHOTS ? ['screenshots', process.env.VB_SHOTS] : process.env.VB_LAYOUT ? ['layout', process.env.VB_LAYOUT] : null;
if (DEV) app.setPath('userData', path.join(DEV[1], 'userdata'));
const statePath = () => path.join(app.getPath('userData'), 'window-state.json');
const ICON = path.join(ROOT, 'assets', WIN ? 'icon.ico' : 'icon-1024.png');
const DEFAULT_KEY = 'CommandOrControl+Shift+X';
const DEFAULT_SNIP_KEY = 'Alt+Shift+S';
const OVERLAY = {
  venom: { color: '#111119', symbolColor: '#f1eef2' },
  anti: { color: '#fdfcfd', symbolColor: '#0d0c12' },
};

let win = null;
let tray = null;
let state = {};
let clickThrough = false;     // never persisted: the app always starts clickable
let pinBeforeClickThrough = null;
let registeredKey = null;
let snipKeyOn = null;         // the screenshot key, while the system lets us have it
let snip = null;              // a screenshot in progress: its overlay windows and whether the board was showing

const keyLabel = k => String(k || '').replace(/CommandOrControl/g, 'Ctrl').replace(/Super/g, 'Win');
// Interface size: the whole page zooms, and the title bar overlay grows or shrinks to match the top bar.
const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
const uiScale = () => (UI_SCALES.includes(state.uiScale) ? state.uiScale : 1);
const overlay = () => ({ ...OVERLAY[state.skin === 'anti' ? 'anti' : 'venom'], height: Math.round((state.topbar === false ? 30 : 52) * uiScale()) });

function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (e) { return {}; }
}
function saveState() {
  if (!win || win.isDestroyed()) return;
  state = { ...state, ...win.getNormalBounds(), maximized: win.isMaximized() };
  try { fs.writeFileSync(statePath(), JSON.stringify(state)); } catch (e) { /* not fatal */ }
}
function publicState() {
  return {
    pinned: !!(win && win.isAlwaysOnTop()),
    opacity: win ? win.getOpacity() : 1,
    locked: !!state.locked,
    clickThrough,
    clickKey: state.clickKey,
    keyLabel: keyLabel(state.clickKey),
    keyOk: !!registeredKey,
    snipKey: state.snipKey,
    snipLabel: keyLabel(state.snipKey),
    snipOk: !!snipKeyOn,
    uiScale: uiScale(),
  };
}
function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('vb:state', publicState());
}
function applyLock() {
  const on = !!state.locked;
  win.setMovable(!on);
  win.setResizable(!on);
  win.setMaximizable(!on);
}

/* ---------- click-through ---------- */
function registerKey() {
  unregisterKey();
  try {
    if (globalShortcut.register(state.clickKey, () => setClickThrough(false))) registeredKey = state.clickKey;
  } catch (e) { registeredKey = null; }
  return !!registeredKey;
}
function unregisterKey() {
  if (!registeredKey) return;
  try { globalShortcut.unregister(registeredKey); } catch (e) { /* already gone */ }
  registeredKey = null;
}
function showTray() {
  if (tray) return;
  // the menu bar (macOS) and Linux trays want a small picture
  tray = new Tray(WIN ? ICON : nativeImage.createFromPath(path.join(ROOT, 'assets', 'icon-1024.png')).resize({ width: MAC ? 18 : 22, height: MAC ? 18 : 22 }));
  tray.setToolTip(`Venom Board: click-through is on. Click here or press ${keyLabel(state.clickKey)} to turn it off.`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Turn off click-through', click: () => setClickThrough(false) },
    { type: 'separator' },
    { label: 'Quit Venom Board', click: () => app.quit() },
  ]));
  tray.on('click', () => setClickThrough(false));
}
function hideTray() {
  if (tray) { tray.destroy(); tray = null; }
}
function setClickThrough(on) {
  if (!win) return publicState();
  on = !!on;
  if (on !== clickThrough) {
    clickThrough = on;
    win.setIgnoreMouseEvents(on);
    if (on) {
      // a click-through window is only useful above the app you are clicking into
      pinBeforeClickThrough = win.isAlwaysOnTop();
      if (!pinBeforeClickThrough) win.setAlwaysOnTop(true, 'floating');
      registerKey();
      showTray();  // second way out, in case another app owns the shortcut
    } else {
      unregisterKey();
      hideTray();
      if (pinBeforeClickThrough === false) win.setAlwaysOnTop(false);
      pinBeforeClickThrough = null;
      win.focus();
    }
  }
  pushState();
  return publicState();
}

/* ---------- screenshots ---------- */
// The screenshot key works from any app. Every screen is captured as it is (Venom Board included, so the board
// itself can be screenshotted), and a frozen copy of each screen lets you drag the area you want. It lands on the
// board, and on the clipboard too.
function registerSnipKey() {
  if (snipKeyOn) { try { globalShortcut.unregister(snipKeyOn); } catch (e) { /* already gone */ } snipKeyOn = null; }
  try { if (state.snipKey && globalShortcut.register(state.snipKey, startSnip)) snipKeyOn = state.snipKey; } catch (e) { snipKeyOn = null; }
  return !!snipKeyOn;
}
async function startSnip() {
  if (snip || !win || win.isDestroyed()) return;
  // macOS asks once for screen recording; after a no, capturing only ever shows the wallpaper
  if (MAC && ['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen'))) { snipResult({ error: 'permission' }); return; }
  snip = { overlays: [], wasShowing: win.isVisible() && !win.isMinimized() };
  let shots = [];
  try {
    const displays = screen.getAllDisplays();
    const size = displays.reduce((m, d) => ({ width: Math.max(m.width, Math.round(d.size.width * d.scaleFactor)), height: Math.max(m.height, Math.round(d.size.height * d.scaleFactor)) }), { width: 0, height: 0 });
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    shots = displays.map((d, i) => ({ display: d, image: (sources.find(s => s.display_id === String(d.id)) || (sources.length === displays.length ? sources[i] : null) || {}).thumbnail }))
      .filter(s => s.image && !s.image.isEmpty());
  } catch (e) { shots = []; }
  if (!shots.length) { endSnip(null, 'capture'); return; }
  for (const s of shots) {
    const b = s.display.bounds;
    const o = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height, show: false, frame: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false, enableLargerThanScreen: true,
      backgroundColor: '#000000', title: 'Venom Board screenshot',
      webPreferences: { preload: path.join(__dirname, 'snip-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    o.setAlwaysOnTop(true, 'screen-saver');
    o.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    o.webContents.on('will-navigate', e => e.preventDefault());
    o.on('closed', () => { if (snip && snip.overlays.some(x => x.win === o)) endSnip(null); });
    snip.overlays.push({ win: o, ...s });
    o.loadFile(path.join(__dirname, 'snip.html')).then(() => {
      if (o.isDestroyed()) return;
      o.webContents.send('snip:image', 'data:image/jpeg;base64,' + s.image.toJPEG(90).toString('base64'));
      o.setBounds(b);  // a frameless window can be nudged when it's made
      o.show(); o.focus();
    }).catch(() => endSnip(null, 'capture'));
  }
}
// box: the area dragged on one overlay, in that screen's points; the crop comes from the full-resolution capture
function endSnip(box, error) {
  const cur = snip;
  if (!cur) return;
  snip = null;
  let out = null;
  if (box) {
    const { image, display } = box.overlay, b = display.bounds, sz = image.getSize(), sx = sz.width / b.width, sy = sz.height / b.height;
    const x = Math.max(0, Math.min(sz.width - 1, Math.round(box.x * sx))), y = Math.max(0, Math.min(sz.height - 1, Math.round(box.y * sy)));
    const w = Math.min(sz.width - x, Math.round(box.w * sx)), h = Math.min(sz.height - y, Math.round(box.h * sy));
    if (w >= 2 && h >= 2) {
      const img = image.crop({ x, y, width: w, height: h });
      try { clipboard.writeImage(img); } catch (e) { /* the board still gets it */ }
      out = { image: 'data:image/png;base64,' + img.toPNG().toString('base64'), width: w, height: h };
    }
  }
  for (const o of cur.overlays) if (!o.win.isDestroyed()) o.win.destroy();
  if (!win || win.isDestroyed()) return;
  // the board comes back to show where the screenshot went; a cancelled one leaves things as they were
  if (cur.wasShowing || out || error) { win.show(); win.focus(); }
  if (out) snipResult(out);
  else if (error) snipResult({ error });
}
function snipResult(r) { if (win && !win.isDestroyed()) win.webContents.send('vb:snip', r); }
const fromOverlay = e => snip && snip.overlays.find(o => !o.win.isDestroyed() && o.win.webContents === e.sender);
ipcMain.on('snip:done', (e, box) => {
  const o = fromOverlay(e);
  if (!o) return;
  const n = v => (Number.isFinite(v) ? v : 0);
  endSnip({ overlay: o, x: n(box && box.x), y: n(box && box.y), w: n(box && box.w), h: n(box && box.h) });
});
ipcMain.on('snip:cancel', e => { if (fromOverlay(e)) endSnip(null); });

/* ---------- window ---------- */
function createWindow() {
  state = loadState();
  if (!state.clickKey) state.clickKey = DEFAULT_KEY;
  if (!state.snipKey) state.snipKey = DEFAULT_SNIP_KEY;
  win = new BrowserWindow({
    width: state.width || 1520,
    height: state.height || 940,
    x: state.x,
    y: state.y,
    minWidth: 480,
    minHeight: 400,
    title: 'Venom Board',
    backgroundColor: '#060609',
    icon: ICON,
    // Windows and Linux draw their window buttons over the top bar's right end; macOS keeps its traffic lights top left
    titleBarStyle: MAC ? 'hiddenInset' : 'hidden',
    ...(MAC ? { trafficLightPosition: { x: 16, y: 18 } } : { titleBarOverlay: overlay() }),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (state.maximized) win.maximize();
  if (state.pinned) win.setAlwaysOnTop(true, 'floating');
  if (state.opacity && state.opacity < 1) win.setOpacity(state.opacity);
  applyLock();

  let devMode = null;
  if (DEV) { try { devMode = require('./dev/' + DEV[0]); } catch (e) { devMode = null; } }
  if (devMode) devMode(app, win, DEV[1]);
  else win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(uiScale()));
  win.loadFile(path.join(ROOT, 'index.html'));

  // Links on cards open in the real browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  win.on('close', saveState);
  win.on('closed', () => { win = null; });
}

ipcMain.handle('vb:get-state', () => publicState());
ipcMain.handle('vb:set-pin', (e, on) => {
  if (!win) return false;
  win.setAlwaysOnTop(!!on, 'floating');
  state.pinned = win.isAlwaysOnTop();
  if (clickThrough) pinBeforeClickThrough = state.pinned;
  saveState();
  pushState();
  return state.pinned;
});
ipcMain.handle('vb:set-opacity', (e, v) => {
  if (!win) return 1;
  const o = Math.min(1, Math.max(0.2, Number(v) || 1));
  win.setOpacity(o);
  state.opacity = o;
  saveState();
  pushState();
  return o;
});
ipcMain.handle('vb:set-lock', (e, on) => {
  state.locked = !!on;
  if (win) applyLock();
  saveState();
  pushState();
  return publicState();
});
ipcMain.handle('vb:set-click-through', (e, on) => setClickThrough(on));
ipcMain.handle('vb:set-click-key', (e, accel) => {
  if (typeof accel !== 'string' || !accel || accel.length > 60) return { ok: false, ...publicState() };
  if (accel === state.snipKey) return { ok: false, ...publicState() };  // one key, one job
  const prev = state.clickKey;
  let ok = false;
  if (clickThrough) {
    state.clickKey = accel;
    ok = registerKey();
    if (!ok) { state.clickKey = prev; registerKey(); }
  } else {
    // prove the OS will hand us this shortcut, then let it go until click-through is switched on
    try { ok = globalShortcut.register(accel, () => {}); if (ok) globalShortcut.unregister(accel); } catch (err) { ok = false; }
    if (ok) state.clickKey = accel;
  }
  if (tray) tray.setToolTip(`Venom Board: click-through is on. Click here or press ${keyLabel(state.clickKey)} to turn it off.`);
  saveState();
  pushState();
  return { ok, ...publicState() };
});
ipcMain.handle('vb:snip', () => { startSnip(); return true; });
ipcMain.handle('vb:set-snip-key', (e, accel) => {
  if (typeof accel !== 'string' || !accel || accel.length > 60) return { ok: false, ...publicState() };
  if (accel === state.clickKey) return { ok: false, ...publicState() };  // one key, one job
  const prev = state.snipKey;
  state.snipKey = accel;
  const ok = registerSnipKey();
  if (!ok) { state.snipKey = prev; registerSnipKey(); }
  saveState();
  pushState();
  return { ok, ...publicState() };
});
ipcMain.handle('vb:set-ui-scale', (e, f) => {
  if (!win || !UI_SCALES.includes(f)) return uiScale();
  state.uiScale = f;
  win.webContents.setZoomFactor(f);
  if (!MAC) try { win.setTitleBarOverlay(overlay()); } catch (err) { /* older platforms */ }
  saveState();
  pushState();
  return f;
});
ipcMain.handle('vb:set-topbar', (e, on) => {
  state.topbar = !!on;
  if (!MAC) try { win && win.setTitleBarOverlay(overlay()); } catch (err) { /* older platforms */ }
  saveState();
});
ipcMain.handle('vb:set-skin', (e, skin) => {
  state.skin = skin === 'anti' ? 'anti' : 'venom';
  if (!MAC) try { win && win.setTitleBarOverlay(overlay()); } catch (err) { /* older platforms */ }
  saveState();
});
// The page may only write to files the user picked in a Save or Open dialog this session,
// so a malicious board file can never make the app write anywhere else on disk.
const pickedFiles = new Set();
const pick = file => { const full = path.resolve(file); pickedFiles.add(full.toLowerCase()); return full; };
const wasPicked = file => typeof file === 'string' && pickedFiles.has(path.resolve(file).toLowerCase());
ipcMain.handle('vb:save-file', async (e, { name, data, filters, path: target } = {}) => {
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) return null;
  let file = wasPicked(target) ? path.resolve(target) : null;
  if (!file) {
    const r = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('documents'), path.basename(String(name || 'board.json'))),
      filters: Array.isArray(filters) && filters.length ? filters : undefined,
    });
    if (r.canceled || !r.filePath) return null;
    file = pick(r.filePath);
  }
  fs.writeFileSync(file, typeof data === 'string' ? data : Buffer.from(data));
  return { path: file, name: path.basename(file) };
});
ipcMain.handle('vb:open-file', async (e, { filters } = {}) => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    defaultPath: app.getPath('documents'),
    filters: Array.isArray(filters) && filters.length ? filters : undefined,
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const file = pick(r.filePaths[0]);  // saving back to a file the user opened is allowed
  return { path: file, name: path.basename(file), text: fs.readFileSync(file, 'utf8') };
});
ipcMain.handle('vb:open-external', (e, url) => {
  if (typeof url === 'string' && /^https?:/i.test(url)) shell.openExternal(url);
});

// Updates. The installed app checks the GitHub releases for a newer version when it starts and every few
// hours, downloads it in the background (checked against the release's SHA-512) and installs it on restart.
// The page offers "Restart to update"; otherwise it installs when the app closes.
//
// Every installer must also carry a signature made with Venom Board's private update key, which is never
// stored on GitHub. The app only installs an update whose signature matches the public key below, so even
// someone who got into the GitHub account couldn't push an update that installed copies would accept.
const UPDATE_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAv0KVrzBpMO3JhOElcEKk3TB7nOHBV6PD1HzbofMM2/k=\n-----END PUBLIC KEY-----\n';
const SIGNATURES = process.env.VB_UPDATE_SIG_BASE || 'https://github.com/1337VIPER/venom-board/releases/download/v{version}';
function sha512File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    fs.createReadStream(file).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}
// The signature covers the version and the file's SHA-512. Each platform also only takes its own kind of file,
// by name and by what's actually in it (a Windows program, or an AppImage), so one platform's signed release
// can't be passed off to another.
const UPDATE_FILE = WIN ? /^VenomBoard-Setup-[\w.-]+\.exe$/ : /^VenomBoard-[\w.-]+\.AppImage$/;
async function ownKind(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const b = Buffer.alloc(11);
    await fh.read(b, 0, 11, 0);
    return WIN ? b[0] === 0x4d && b[1] === 0x5a : b.readUInt32BE(0) === 0x7f454c46 && b[8] === 0x41 && b[9] === 0x49 && b[10] === 0x02;
  } finally { await fh.close(); }
}
// Returns the installer's SHA-512 if its signature checks out, otherwise null.
async function verifyUpdate(info) {
  const version = String(info.version);
  if (MAC || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/.test(version)) return null;
  const entry = (info.files || []).map(f => path.basename(String(f.url || ''))).find(f => UPDATE_FILE.test(f));
  const file = entry || path.basename(String(info.path || ''));
  if (!UPDATE_FILE.test(file) || !(await ownKind(info.downloadedFile))) return null;
  const hash = await sha512File(info.downloadedFile);
  // always fetched fresh: a cached copy could be stale
  const url = SIGNATURES.replace('{version}', version) + `/${file}.sig?t=${Date.now()}`;
  const res = await net.fetch(url, { cache: 'no-store' });
  if (!res.ok) return null;
  const signature = Buffer.from((await res.text()).trim(), 'base64');
  const message = Buffer.from(`venom-board-update\n${version}\n${hash}\n`);
  return signature.length === 64 && crypto.verify(null, message, UPDATE_PUBLIC_KEY, signature) ? hash : null;
}

// The updater never installs anything by itself. Both ways in, "Restart to update" and closing the app, go
// through installVerified(), which runs the installer only if it is still exactly the file that passed the
// signature check (same path, same SHA-512). Anything else is refused, so a later failed download can't
// slip through on the strength of an earlier good one.
let updater = null;
let update = { state: 'idle' };
let verified = null;  // { file, hash, version } of the download whose signature checked out
let quitting = false;
async function installVerified(relaunch) {
  if (!updater || !verified) return false;
  const pending = updater.installerPath;
  const good = pending && path.resolve(pending) === path.resolve(verified.file) && (await sha512File(pending).catch(() => null)) === verified.hash;
  if (!good) {
    verified = null;
    setUpdate({ state: 'error', message: "The downloaded update couldn't be verified, so it wasn't installed." });
    return false;
  }
  updater.quitAndInstall(true, relaunch);  // installs quietly; reopens the app only after "Restart to update"
  return true;
}
function setUpdate(u) {
  update = u;
  if (win && !win.isDestroyed()) win.webContents.send('vb:update', update);
}
function startUpdates() {
  if (!app.isPackaged || DEV) return;
  try { updater = require('electron-updater').autoUpdater; } catch (e) { return; }
  updater.autoDownload = !MAC;
  updater.autoInstallOnAppQuit = false;  // installs only ever happen through installVerified()
  updater.logger = null;
  updater.on('checking-for-update', () => { if (update.state !== 'downloading' && update.state !== 'ready') setUpdate({ state: 'checking' }); });
  updater.on('update-not-available', () => setUpdate({ state: 'current' }));
  updater.on('update-available', i => {
    verified = null;
    if (MAC) { setUpdate({ state: 'available', version: i.version }); return; }  // macOS: offered as a download
    setUpdate({ state: 'downloading', version: i.version, percent: 0 });
  });
  updater.on('download-progress', p => setUpdate({ ...update, state: 'downloading', percent: Math.floor(p.percent || 0) }));
  updater.on('update-downloaded', async i => {
    verified = null;
    setUpdate({ state: 'verifying', version: i.version });
    const hash = await verifyUpdate(i).catch(() => null);
    if (!hash) {
      try { fs.rmSync(i.downloadedFile, { force: true }); } catch (e) { /* not fatal: it can never be installed anyway */ }
      setUpdate({ state: 'error', message: `The download of version ${i.version} couldn't be verified, so it wasn't installed.` });
      return;
    }
    verified = { file: i.downloadedFile, hash, version: i.version };
    setUpdate({ state: 'ready', version: i.version });
    if (process.env.VB_UPDATE_AUTOINSTALL === '1') installVerified(true);  // used by the update test
  });
  updater.on('error', e => { if (update.state !== 'ready') setUpdate({ state: 'error', message: String((e && e.message) || e).slice(0, 200) }); });
  // a verified update installs quietly when the app closes, unless "Restart to update" already did it
  app.on('before-quit', e => {
    if (quitting || !verified) return;
    e.preventDefault();
    quitting = true;
    installVerified(false).then(ok => { if (!ok) app.quit(); }, () => app.quit());
  });
  const check = () => { if (!['downloading', 'verifying', 'ready', 'available'].includes(update.state)) updater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 4000);
  setInterval(check, 4 * 3600000);
}
ipcMain.handle('vb:get-update', () => ({ ...update, current: app.getVersion(), enabled: !!updater }));
ipcMain.handle('vb:check-update', () => {
  if (!updater) return false;
  if (['downloading', 'verifying', 'ready'].includes(update.state)) setUpdate(update);
  else updater.checkForUpdates().catch(() => {});
  return true;
});
ipcMain.handle('vb:install-update', () => {
  if (updater && update.state === 'available') { shell.openExternal(RELEASES); return true; }  // macOS
  if (!updater || update.state !== 'ready' || !verified) return false;
  quitting = true;
  installVerified(true).then(ok => { if (!ok) quitting = false; });
  return true;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (clickThrough) setClickThrough(false);  // launching again is also a way back in
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    // the page only ever copies text (and a video player may go full screen): cameras, microphones, location,
    // notifications and every other permission are refused without asking
    const OK_PERMS = new Set(['clipboard-sanitized-write', 'fullscreen', 'mediaKeySystem']);
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(OK_PERMS.has(perm)));
    session.defaultSession.setPermissionCheckHandler((wc, perm) => OK_PERMS.has(perm));
    // YouTube and Vimeo players only start inside a page that says which site it's on, and an app loaded from
    // disk has no address to send; they're told it's Venom Board
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube-nocookie.com/*', 'https://player.vimeo.com/*'] }, (d, done) => {
      if (!d.requestHeaders.Referer) d.requestHeaders.Referer = 'https://venomboard.com/';
      done({ requestHeaders: d.requestHeaders });
    });
    createWindow(); registerSnipKey(); startUpdates();
  });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); hideTray(); });
  app.on('window-all-closed', () => app.quit());
}

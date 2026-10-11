// Venom Board desktop shell: frameless window, pin on top, opacity, window lock,
// click-through with a global "turn it off" shortcut, screenshots from any app, native file dialogs and automatic updates.
const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, Tray, Menu, net, session, nativeImage, desktopCapturer, screen, clipboard, systemPreferences, Notification, ClipboardItem } = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// Windows shows a taskbar button with the icon of the app id, so a copy run from source (electron.exe, with the Electron
// atom) has an id of its own: running it can never hand that icon to the installed app's button.
app.setAppUserModelId(app.isPackaged ? 'com.venomboard.app' : 'com.venomboard.app.dev');
const MAC = process.platform === 'darwin', WIN = process.platform === 'win32';
const RELEASES = 'https://github.com/1337VIPER/venom-board/releases/latest';

const ROOT = path.join(__dirname, '..');
// Developer modes (electron/dev): VB_SMOKE=<dir> runs the self-test, VB_SHOTS=<dir> renders the README screenshots,
// VB_LAYOUT=<dir> checks the layout across screen and interface sizes, VB_SNIPTEST=<dir> tests the screenshot tool.
const DEV = process.env.VB_SMOKE ? ['smoke', process.env.VB_SMOKE] : process.env.VB_SHOTS ? ['screenshots', process.env.VB_SHOTS] : process.env.VB_LAYOUT ? ['layout', process.env.VB_LAYOUT]
  : process.env.VB_SNIPTEST ? ['sniptest', process.env.VB_SNIPTEST] : null;
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
let snipTimer = null;         // a screenshot waiting out its delay
let pendingWindow = null;     // the window an overlay is about to capture, for the display-media handler
const pins = new Set();       // screenshots pinned on top of everything

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
// itself can be screenshotted), and a frozen copy of each screen, at its full resolution, lets you pick the area:
// drag it, or F for the whole screen, W for one window, L for the last area. Then the overlay is an editor (arrows,
// boxes, text, numbered steps, pixelating what's private) and the picture goes where you choose: onto the board (and
// the clipboard), only the clipboard, a file, a short link on the team server, or pinned on top of every window.
const SNIP_ACTIONS = ['board', 'copy', 'save', 'link', 'pin'];
// Electron 44's clipboard is the asynchronous web kind, which takes pictures as ClipboardItems; older ones had writeImage
async function clipImage(img) {
  if (typeof clipboard.writeImage === 'function') { clipboard.writeImage(img); return; }
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([img.toPNG()], { type: 'image/png' }) })]);
}
function registerSnipKey() {
  if (snipKeyOn) { try { globalShortcut.unregister(snipKeyOn); } catch (e) { /* already gone */ } snipKeyOn = null; }
  try { if (state.snipKey && globalShortcut.register(state.snipKey, () => startSnip())) snipKeyOn = state.snipKey; } catch (e) { snipKeyOn = null; }
  return !!snipKeyOn;
}
// opts.delay: seconds to wait first (to open a menu, say); opts.mode 'window' opens the window picker straight away
async function startSnip(opts = {}) {
  if (snip || snipTimer || !win || win.isDestroyed()) return;
  const delay = Math.min(10, Math.max(0, Number(opts.delay) || 0));
  if (delay) { snipTimer = setTimeout(() => { snipTimer = null; startSnip({ ...opts, delay: 0 }); }, delay * 1000); return; }
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
  const here = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
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
    const entry = { win: o, ...s, here: s.display.id === here };
    snip.overlays.push(entry);
    // shown once the frozen screen is drawn (or after a moment regardless), so it never flashes black
    entry.showTimer = setTimeout(() => showOverlay(entry), 1500);
    o.loadFile(path.join(__dirname, 'snip.html')).then(() => {
      if (o.isDestroyed()) return;
      const sz = s.image.getSize(), last = state.lastSnip && state.lastSnip.display === s.display.id ? state.lastSnip.box : null;
      // raw pixels (BGRA) travel faster than any picture format, and they're exact for the colour picker
      o.webContents.send('snip:image', { width: sz.width, height: sz.height, data: s.image.toBitmap(), last, mode: entry.here ? opts.mode || '' : '' });
    }).catch(() => endSnip(null, 'capture'));
  }
}
function showOverlay(o) {
  clearTimeout(o.showTimer);
  if (!snip || o.win.isDestroyed() || o.win.isVisible()) return;
  o.win.setBounds(o.display.bounds);  // a frameless window can be nudged when it's made
  o.win.show();
  if (o.here || !snip.overlays.some(x => x.here)) o.win.focus();
}
const fromOverlay = e => snip && snip.overlays.find(o => !o.win.isDestroyed() && o.win.webContents === e.sender);
const isOverlay = wc => !!snip && snip.overlays.some(o => !o.win.isDestroyed() && o.win.webContents === wc);
ipcMain.on('snip:ready', e => { const o = fromOverlay(e); if (o) showOverlay(o); });
// one screen at a time: starting an area on one clears the others
ipcMain.on('snip:active', e => {
  const o = fromOverlay(e);
  if (o) for (const x of snip.overlays) if (x !== o && !x.win.isDestroyed()) x.win.webContents.send('snip:reset');
});
ipcMain.on('snip:cancel', e => { if (fromOverlay(e)) endSnip(null); });
// the finished picture, as PNG bytes made by the overlay (with whatever was drawn on it), and what to do with it
ipcMain.on('snip:finish', (e, r) => {
  const o = fromOverlay(e);
  if (!o) return;
  const png = r && r.png;
  if (!(png instanceof Uint8Array) || png.length < 8 || png.length > 256 * 1048576) { endSnip(null, 'capture'); return; }
  const img = nativeImage.createFromBuffer(Buffer.from(png));
  if (img.isEmpty()) { endSnip(null, 'capture'); return; }
  const n = v => (Number.isFinite(v) ? v : 0), box = r.box || {};
  endSnip({ overlay: o, action: SNIP_ACTIONS.includes(r.action) ? r.action : 'board', img, png: Buffer.from(png), box: { x: n(box.x), y: n(box.y), w: n(box.w), h: n(box.h) } });
});
ipcMain.handle('snip:copy-text', async (e, text) => {
  if (!fromOverlay(e) || typeof text !== 'string' || text.length > 200) return false;
  try { await clipboard.writeText(text); return true; } catch (err) { return false; }
});
// the windows that can be captured, with small previews (the overlays themselves and pinned screenshots left out)
ipcMain.handle('snip:windows', async e => {
  if (!fromOverlay(e)) return [];
  try {
    const list = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 360, height: 220 } });
    return list.filter(s => s.name && !/^Venom Board (screenshot|pinned screenshot)$/.test(s.name) && !s.thumbnail.isEmpty()).slice(0, 48)
      .map(s => ({ id: s.id, name: s.name.slice(0, 120), thumb: 'data:image/jpeg;base64,' + s.thumbnail.toJPEG(80).toString('base64') }));
  } catch (err) { return []; }
});
// A window is captured at its own resolution as a one-frame video of just that window (it can be behind others).
// The overlay asks for it here first; the display-media handler then hands that window over, once.
ipcMain.handle('snip:prepare-window', async (e, id) => {
  if (!fromOverlay(e) || typeof id !== 'string') return false;
  try {
    const s = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })).find(x => x.id === id);
    pendingWindow = s ? { source: s, sender: e.sender, at: Date.now() } : null;
    return !!s;
  } catch (err) { return false; }
});
// if that doesn't work, a large preview of the window does (it can be a little soft)
ipcMain.handle('snip:window', async (e, id) => {
  const o = fromOverlay(e);
  if (!o || typeof id !== 'string') return null;
  try {
    const sz = o.image.getSize();
    const s = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: sz })).find(x => x.id === id);
    if (!s || s.thumbnail.isEmpty()) return null;
    const t = s.thumbnail.getSize();
    return { width: t.width, height: t.height, data: s.thumbnail.toBitmap() };
  } catch (err) { return null; }
});
async function endSnip(res, error) {
  const cur = snip;
  if (!cur) return;
  snip = null; pendingWindow = null;
  for (const o of cur.overlays) { clearTimeout(o.showTimer); if (!o.win.isDestroyed()) o.win.destroy(); }
  if (!win || win.isDestroyed()) return;
  if (!res) {
    // a cancelled screenshot leaves things as they were; a failed one says so on the board
    if (cur.wasShowing || error) { win.show(); win.focus(); }
    if (error) snipResult({ error });
    return;
  }
  state.lastSnip = { display: res.overlay.display.id, box: res.box };
  saveState();
  const { img, action } = res, size = img.getSize();
  if (action === 'pin') { pinShot(img, res.overlay.display.bounds, res.box); return; }
  if (action === 'save') { saveShot(img); return; }
  // on the clipboard every other time: for a link, that's what's left if the upload doesn't work out
  try { await clipImage(img); } catch (e) { /* the other steps still happen */ }
  if (action === 'copy') { notify('Screenshot copied', `${size.width} × ${size.height}. Paste it into any app.`); return; }
  // the board comes back to show where a screenshot went; a link is made behind the scenes, where you are
  if (action === 'board') { win.show(); win.focus(); }
  snipResult({ image: 'data:image/png;base64,' + res.png.toString('base64'), width: size.width, height: size.height, action });
}
function snipResult(r) { if (win && !win.isDestroyed()) win.webContents.send('vb:snip', r); }
function notify(title, body, url) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true, icon: ICON });
    if (url) n.on('click', () => shell.openExternal(url));
    n.show();
  } catch (e) { /* not fatal */ }
}
const stamp = () => { const d = new Date(), p = v => String(v).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`; };
async function saveShot(img) {
  const dir = state.shotDir && fs.existsSync(state.shotDir) ? state.shotDir : app.getPath('pictures');
  const opts = { defaultPath: path.join(dir, `Screenshot ${stamp()}.png`), filters: [{ name: 'PNG picture', extensions: ['png'] }, { name: 'JPEG picture', extensions: ['jpg', 'jpeg'] }] };
  const r = await (win && win.isVisible() ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts));
  if (r.canceled || !r.filePath) return;
  try {
    fs.writeFileSync(r.filePath, /\.jpe?g$/i.test(r.filePath) ? img.toJPEG(92) : img.toPNG());
    state.shotDir = path.dirname(r.filePath);
    saveState();
  } catch (e) { dialog.showErrorBox('Venom Board', `Couldn't save the screenshot: ${e.message}`); }
}

/* --- pinned screenshots ---
   A screenshot can stay on top of every window, where it was taken: drag it anywhere, scroll to zoom, Ctrl+scroll
   for opacity, double-click or Esc to close, right-click for copy, save and the board. */
function pinShot(img, area, box) {
  const sz = img.getSize(), k = box.w > 0 ? box.w / sz.width : 1;
  const w = Math.max(24, Math.round(sz.width * k)), h = Math.max(24, Math.round(sz.height * k));
  const p = new BrowserWindow({
    x: Math.round(area.x + box.x), y: Math.round(area.y + box.y), width: w, height: h, frame: false, resizable: false, maximizable: false,
    minimizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: true, backgroundColor: '#000000', title: 'Venom Board pinned screenshot', show: false,
    webPreferences: { preload: path.join(__dirname, 'pin-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  p.setAlwaysOnTop(true, 'floating');
  p.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  p.webContents.on('will-navigate', e => e.preventDefault());
  const pin = { win: p, img, base: { w, h }, zoom: 1 };
  pins.add(pin);
  p.on('closed', () => pins.delete(pin));
  p.loadFile(path.join(__dirname, 'pin.html')).then(() => {
    if (p.isDestroyed()) return;
    p.webContents.send('pin:image', img.toDataURL());
    p.showInactive();
  });
}
const pinOf = e => [...pins].find(x => !x.win.isDestroyed() && x.win.webContents === e.sender);
ipcMain.on('pin:move', (e, dx, dy) => {
  const x = pinOf(e);
  if (!x || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const [px, py] = x.win.getPosition();
  x.win.setPosition(Math.round(px + dx), Math.round(py + dy));
});
// zooms around the point under the pointer (fx, fy: where it is across the picture, 0 to 1)
ipcMain.on('pin:zoom', (e, steps, fx, fy) => {
  const x = pinOf(e);
  if (!x || !Number.isFinite(steps)) return;
  const zoom = Math.min(4, Math.max(0.2, steps === 0 ? 1 : x.zoom * Math.pow(1.1, steps)));
  const b = x.win.getBounds(), w = Math.round(x.base.w * zoom), h = Math.round(x.base.h * zoom);
  const ax = Number.isFinite(fx) ? fx : 0.5, ay = Number.isFinite(fy) ? fy : 0.5;
  x.zoom = zoom;
  x.win.setBounds({ x: Math.round(b.x + (b.width - w) * ax), y: Math.round(b.y + (b.height - h) * ay), width: w, height: h });
});
ipcMain.on('pin:opacity', (e, steps) => {
  const x = pinOf(e);
  if (x && Number.isFinite(steps)) x.win.setOpacity(Math.min(1, Math.max(0.2, x.win.getOpacity() + steps * 0.1)));
});
ipcMain.on('pin:close', e => { const x = pinOf(e); if (x) x.win.close(); });
ipcMain.on('pin:menu', e => {
  const x = pinOf(e);
  if (!x) return;
  const size = x.img.getSize(), toBoard = action => {
    if (!win || win.isDestroyed()) return;
    if (action === 'board') { win.show(); win.focus(); }
    snipResult({ image: x.img.toDataURL(), width: size.width, height: size.height, action });
  };
  Menu.buildFromTemplate([
    { label: 'Copy', click: () => clipImage(x.img).then(() => notify('Screenshot copied', `${size.width} × ${size.height}. Paste it into any app.`), () => {}) },
    { label: 'Save as…', click: () => saveShot(x.img) },
    { label: 'Add to the board', click: () => toBoard('board') },
    { label: 'Get a short link', click: () => toBoard('link') },
    { type: 'separator' },
    { label: 'Actual size', click: () => { x.zoom = 1; const b = x.win.getBounds(); x.win.setBounds({ x: b.x, y: b.y, width: x.base.w, height: x.base.h }); } },
    { label: 'Close', click: () => x.win.close() },
  ]).popup({ window: x.win });
});

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
  // pinned screenshots go with the board, so closing it still quits the app
  win.on('closed', () => { win = null; for (const p of pins) if (!p.win.isDestroyed()) p.win.close(); });
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
ipcMain.handle('vb:snip', (e, opts) => {
  if (!win || e.sender !== win.webContents) return false;
  const o = opts && typeof opts === 'object' ? opts : {};
  startSnip({ delay: Number(o.delay) || 0, mode: o.mode === 'window' ? 'window' : '' });
  return true;
});
// for screenshot links made by the page: the link on the clipboard, and a note (click it to open the link) for
// when Venom Board is behind the app you took the screenshot in
ipcMain.handle('vb:copy-text', async (e, text) => {
  if (!win || e.sender !== win.webContents || typeof text !== 'string' || text.length > 2000) return false;
  try { await clipboard.writeText(text); return true; } catch (err) { return false; }
});
ipcMain.handle('vb:notify', (e, n) => {
  if (!win || e.sender !== win.webContents || !n || typeof n.title !== 'string') return false;
  notify(n.title.slice(0, 120), String(n.body || '').slice(0, 300), typeof n.url === 'string' && /^https?:\/\//i.test(n.url) ? n.url : null);
  return true;
});
ipcMain.handle('vb:show', e => {
  if (!win || e.sender !== win.webContents) return false;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  return true;
});
// a picture from the board onto the system clipboard, as a real bitmap, so every other app can paste it
ipcMain.handle('vb:copy-image', async (e, url) => {
  if (!win || e.sender !== win.webContents) return false;
  if (typeof url !== 'string' || !url.startsWith('data:image/png;base64,') || url.length > 256 * 1048576) return false;
  const img = nativeImage.createFromDataURL(url);
  if (img.isEmpty()) return false;
  try { await clipImage(img); return true; } catch (err) { return false; }
});
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
    // ...except that a screenshot overlay may capture the one window that was picked in it
    const ok = (wc, perm) => OK_PERMS.has(perm) || (['media', 'display-capture'].includes(perm) && isOverlay(wc));
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(ok(wc, perm)));
    session.defaultSession.setPermissionCheckHandler((wc, perm) => ok(wc, perm));
    session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
      const p = pendingWindow, f = req.frame;
      pendingWindow = null;
      const asked = p && !p.sender.isDestroyed() && f && p.sender.mainFrame && f.processId === p.sender.mainFrame.processId && f.routingId === p.sender.mainFrame.routingId;
      cb(asked && isOverlay(p.sender) && Date.now() - p.at < 15000 ? { video: p.source } : {});
    });
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

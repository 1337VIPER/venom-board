// Venom Board desktop shell: frameless window, pin on top, opacity, window lock,
// click-through with a global "turn it off" shortcut, and native file dialogs.
const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

app.setAppUserModelId('com.venomboard.app');

const ROOT = path.join(__dirname, '..');
// Developer modes (electron/dev): VB_SMOKE=<dir> runs the self-test, VB_SHOTS=<dir> renders the README screenshots.
const DEV = process.env.VB_SMOKE ? ['smoke', process.env.VB_SMOKE] : process.env.VB_SHOTS ? ['screenshots', process.env.VB_SHOTS] : null;
if (DEV) app.setPath('userData', path.join(DEV[1], 'userdata'));
const statePath = () => path.join(app.getPath('userData'), 'window-state.json');
const ICON = path.join(ROOT, 'assets', 'icon.ico');
const DEFAULT_KEY = 'CommandOrControl+Shift+X';
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

const keyLabel = k => String(k || '').replace(/CommandOrControl/g, 'Ctrl').replace(/Super/g, 'Win');
const overlay = () => ({ ...OVERLAY[state.skin === 'anti' ? 'anti' : 'venom'], height: state.topbar === false ? 30 : 52 });

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
  tray = new Tray(ICON);
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

/* ---------- window ---------- */
function createWindow() {
  state = loadState();
  if (!state.clickKey) state.clickKey = DEFAULT_KEY;
  win = new BrowserWindow({
    width: state.width || 1520,
    height: state.height || 940,
    x: state.x,
    y: state.y,
    minWidth: 480,
    minHeight: 340,
    title: 'Venom Board',
    backgroundColor: '#060609',
    icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: overlay(),
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
ipcMain.handle('vb:set-topbar', (e, on) => {
  state.topbar = !!on;
  try { win && win.setTitleBarOverlay(overlay()); } catch (err) { /* older platforms */ }
  saveState();
});
ipcMain.handle('vb:set-skin', (e, skin) => {
  state.skin = skin === 'anti' ? 'anti' : 'venom';
  try { win && win.setTitleBarOverlay(overlay()); } catch (err) { /* older platforms */ }
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (clickThrough) setClickThrough(false);  // launching again is also a way back in
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(createWindow);
  app.on('will-quit', () => { globalShortcut.unregisterAll(); hideTray(); });
  app.on('window-all-closed', () => app.quit());
}

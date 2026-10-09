// The only bridge between the page and the desktop shell. The page sees window.venomDesktop.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('venomDesktop', {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('vb:get-state'),
  onState: cb => {
    ipcRenderer.removeAllListeners('vb:state');
    ipcRenderer.on('vb:state', (e, s) => cb(s));
  },
  setPin: on => ipcRenderer.invoke('vb:set-pin', on),
  setOpacity: v => ipcRenderer.invoke('vb:set-opacity', v),
  setLock: on => ipcRenderer.invoke('vb:set-lock', on),
  setClickThrough: on => ipcRenderer.invoke('vb:set-click-through', on),
  setClickKey: accel => ipcRenderer.invoke('vb:set-click-key', accel),
  snip: () => ipcRenderer.invoke('vb:snip'),
  onSnip: cb => {
    ipcRenderer.removeAllListeners('vb:snip');
    ipcRenderer.on('vb:snip', (e, r) => cb(r));
  },
  setSnipKey: accel => ipcRenderer.invoke('vb:set-snip-key', accel),
  setTopbar: on => ipcRenderer.invoke('vb:set-topbar', on),
  setSkin: skin => ipcRenderer.invoke('vb:set-skin', skin),
  setUiScale: f => ipcRenderer.invoke('vb:set-ui-scale', f),
  saveFile: opts => ipcRenderer.invoke('vb:save-file', opts),
  openFile: opts => ipcRenderer.invoke('vb:open-file', opts),
  openExternal: url => ipcRenderer.invoke('vb:open-external', url),
  getUpdate: () => ipcRenderer.invoke('vb:get-update'),
  onUpdate: cb => {
    ipcRenderer.removeAllListeners('vb:update');
    ipcRenderer.on('vb:update', (e, u) => cb(u));
  },
  checkUpdate: () => ipcRenderer.invoke('vb:check-update'),
  installUpdate: () => ipcRenderer.invoke('vb:install-update'),
});

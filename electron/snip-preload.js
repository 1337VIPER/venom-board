// The screenshot overlay's only bridge: it receives its frozen screen (raw pixels), can list and capture windows and copy a
// colour's code, and sends back the finished picture with what to do with it, or a cancel.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, (e, v) => cb(v));
};
contextBridge.exposeInMainWorld('venomSnip', {
  platform: process.platform,
  onImage: cb => on('snip:image', cb),
  onReset: cb => on('snip:reset', cb),
  ready: () => ipcRenderer.send('snip:ready'),
  active: () => ipcRenderer.send('snip:active'),
  windows: () => ipcRenderer.invoke('snip:windows'),
  prepareWindow: id => ipcRenderer.invoke('snip:prepare-window', id),
  windowImage: id => ipcRenderer.invoke('snip:window', id),
  copyText: text => ipcRenderer.invoke('snip:copy-text', text),
  finish: r => ipcRenderer.send('snip:finish', r),
  cancel: () => ipcRenderer.send('snip:cancel'),
});

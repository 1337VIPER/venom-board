// The screenshot overlay's only bridge: it receives the frozen screen and sends back the area dragged, or a cancel.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('venomSnip', {
  onImage: cb => {
    ipcRenderer.removeAllListeners('snip:image');
    ipcRenderer.on('snip:image', (e, url) => cb(url));
  },
  done: box => ipcRenderer.send('snip:done', box),
  cancel: () => ipcRenderer.send('snip:cancel'),
});

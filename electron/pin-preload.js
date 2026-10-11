// A pinned screenshot's only bridge: it gets its picture, and asks the app to move, zoom, fade or close its window
// and to show its menu.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('venomPin', {
  onImage: cb => {
    ipcRenderer.removeAllListeners('pin:image');
    ipcRenderer.on('pin:image', (e, url) => cb(url));
  },
  move: (dx, dy) => ipcRenderer.send('pin:move', dx, dy),
  zoom: (steps, fx, fy) => ipcRenderer.send('pin:zoom', steps, fx, fy),
  opacity: steps => ipcRenderer.send('pin:opacity', steps),
  menu: () => ipcRenderer.send('pin:menu'),
  close: () => ipcRenderer.send('pin:close'),
});

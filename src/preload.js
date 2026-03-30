const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getStore: () => ipcRenderer.invoke('get-store'),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  showOverlay: () => ipcRenderer.send('show-overlay'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  reloadOverlay: () => ipcRenderer.send('reload-overlay'),
  setUrl: (url, displayIndex, show = false) => ipcRenderer.send('set-url', { url, displayIndex, show }),
  moveOverlay: (displayIndex) => ipcRenderer.send('move-overlay', displayIndex),
  saveUrl: (url) => ipcRenderer.send('save-url', url),
  removeSaved: (url) => ipcRenderer.send('remove-saved', url),
  clearHistory: () => ipcRenderer.send('clear-history'),
  onStoreUpdated: (cb) => ipcRenderer.on('store-updated', (_, data) => cb(data)),
  onOverlayState: (cb) => ipcRenderer.on('overlay-state', (_, visible) => cb(visible)),
});

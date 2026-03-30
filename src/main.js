const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

if (require('electron-squirrel-startup')) app.quit();

const STORE_PATH = path.join(app.getPath('userData'), 'store.json');

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      // Sanitize saved entries that may be objects from a previous version
      data.saved = (data.saved || []).map(e => typeof e === 'string' ? e : e.url).filter(Boolean);
      return data;
    }
  } catch (_) {}
  return { history: [], saved: [], selectedMonitor: 0 };
}

function saveStore(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

let store = loadStore();
let mainWindow = null;
let overlayWindow = null;

function getDisplay(displayIndex) {
  const displays = screen.getAllDisplays();
  return displays[displayIndex] || displays[0];
}

function createOverlayWindow() {
  const { x, y, width, height } = getDisplay(store.selectedMonitor).bounds;

  overlayWindow = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.show();

  overlayWindow.webContents.on('did-finish-load', () => {
    overlayWindow.webContents.insertCSS('html, body { background: transparent !important; }');
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 640,
    resizable: false,
    autoHideMenuBar: true,
    title: 'Simple Overlay',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    overlayWindow.destroy();
    app.quit();
  });
}

// IPC handlers
ipcMain.handle('get-store', () => store);

ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays().map((d, i) => ({
    id: i,
    label: `Display ${i + 1}${d.label ? ` - ${d.label}` : ''} (${d.bounds.width}x${d.bounds.height})`,
    isPrimary: d.id === screen.getPrimaryDisplay().id,
  }));
});

function showOverlay() {
  overlayWindow.setOpacity(1);
  mainWindow.webContents.send('overlay-state', true);
}

ipcMain.on('show-overlay', showOverlay);

ipcMain.on('hide-overlay', () => {
  overlayWindow.setOpacity(0)
  mainWindow.webContents.send('overlay-state', false);
});

ipcMain.on('reload-overlay', () => {
  const url = overlayWindow.webContents.getURL();
  if (url && url !== 'about:blank') overlayWindow.loadURL(url);
});

ipcMain.on('move-overlay', (_, displayIndex) => {
  store.selectedMonitor = displayIndex;
  saveStore(store);
  const { x, y, width, height } = getDisplay(displayIndex).bounds;
  overlayWindow.setBounds({ x, y, width, height });
});

ipcMain.on('set-url', (_, { url, displayIndex, show }) => {
  store.history = [url, ...store.history.filter(u => u !== url)].slice(0, 10);
  store.selectedMonitor = displayIndex;
  saveStore(store);
  mainWindow.webContents.send('store-updated', store);
  const { x, y, width, height } = getDisplay(displayIndex).bounds;
  overlayWindow.setBounds({ x, y, width, height });
  overlayWindow.loadURL(url);
  if (show) showOverlay();
});

ipcMain.on('save-url', (_, url) => {
  if (!store.saved.includes(url)) {
    store.saved = [url, ...store.saved];
    saveStore(store);
    mainWindow.webContents.send('store-updated', store);
  }
});

ipcMain.on('remove-saved', (_, url) => {
  store.saved = store.saved.filter(u => u !== url);
  saveStore(store);
  mainWindow.webContents.send('store-updated', store);
});

ipcMain.on('clear-history', () => {
  store.history = [];
  saveStore(store);
  mainWindow.webContents.send('store-updated', store);
});

app.whenReady().then(() => {
  createOverlayWindow();
  createMainWindow();
});

app.on('window-all-closed', () => app.quit());

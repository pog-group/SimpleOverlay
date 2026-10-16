const { app, BrowserWindow, Menu, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { version } = require('../package.json');
const windows = require('./windows');
const { checkForUpdates } = require('./updater');

if (require('electron-squirrel-startup')) app.quit();

// Pin Windows taskbar icon to this app ID so it always groups correctly
if (process.platform === 'win32') {
  app.setAppUserModelId('com.pog.simpleoverlay');
}

function getAppIcon() {
  const base = path.join(app.getAppPath(), 'assets', 'icons');
  if (process.platform === 'win32') return path.join(base, 'icon.ico');
  if (process.platform === 'darwin') return path.join(base, 'icon.icns');
  return path.join(base, 'icon.png');
}

const STORE_PATH = path.join(app.getPath('userData'), 'store.json');

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      // Sanitize saved entries that may be objects from a previous version
      data.saved = (data.saved || []).map(e => typeof e === 'string' ? e : e.url).filter(Boolean);
      if (data.hideWhenUnfocused === undefined) data.hideWhenUnfocused = true;
      return data;
    }
  } catch (_) {}
  return {
    history: [],
    saved: [
      'http://overlazy.imthespyke.fr/',
      'https://broadcast-center.imthespyke.fr/',
    ],
    selectedMonitor: 0,
    hideWhenUnfocused: true,
  };
}

function saveStore(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

let store = loadStore();
let mainWindow = null;
let overlayWindow = null;

const HISTORY_LIMIT = 30;
const INTERACT_CSS = 'html, body { background: #3a3a3a !important; backdrop-filter: blur(12px) !important; }';

// Everything the overlay's geometry and visibility is derived from.
let overlayOn = false;
let interactMode = null; // null | 'interact' (clicks work) | 'edit' (clicks work + fullscreen)
let follow = null;       // { hwnd, title, watcher, alive, minimized, focused, ours, rect } while following a window
let loadFailed = false;
let lastBounds = '';
let lastStatus = { tone: 'off', text: 'Overlay hidden' };

function getDisplay(displayIndex) {
  const displays = screen.getAllDisplays();
  return displays[displayIndex] || displays[0];
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
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
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.show();

  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  overlayWindow.webContents.on('did-finish-load', async () => {
    await overlayWindow.webContents.insertCSS('html, body { background: transparent !important; }');
    if (overlayWindow._interacting) {
      overlayWindow._interactCSSKey = await overlayWindow.webContents.insertCSS(INTERACT_CSS);
    }
  });

  overlayWindow.webContents.on('did-finish-load', () => setLoadFailed(false));
  overlayWindow.webContents.on('did-fail-load', (_, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) setLoadFailed(true); // -3 = aborted by a newer navigation
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 640,
    resizable: false,
    title: `Simple Overlay v${version}`,
    icon: getAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    stopFollow();
    overlayWindow.destroy();
    app.quit();
  });
}

// Across monitors with different scaling, Electron applies the new size using the scale of the display
// the window is leaving, so the first setBounds can land with the wrong size. A second call fixes it.
function setOverlayBounds(b) {
  const want = {
    x: Math.round(b.x), y: Math.round(b.y),
    width: Math.round(b.width), height: Math.round(b.height),
  };
  overlayWindow.setBounds(want);
  const got = overlayWindow.getBounds();
  if (got.x !== want.x || got.y !== want.y || got.width !== want.width || got.height !== want.height) {
    overlayWindow.setBounds(want);
  }
}

// Single place that decides where the overlay is and whether it can be seen.
function applyOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  let visible = false;
  let bounds = getDisplay(store.selectedMonitor).bounds;
  let status;

  if (!overlayOn) {
    status = { tone: 'off', text: 'Overlay hidden' };
  } else if (interactMode === 'edit') {
    if (follow && follow.rect) bounds = screen.getDisplayMatching(follow.rect).bounds;
    visible = true;
    status = { tone: 'on', text: 'Interacting in fullscreen. Stop to snap back.' };
  } else if (follow) {
    const name = `“${follow.title}”`;
    const r = follow.rect;
    if (!follow.alive) {
      status = { tone: 'warn', short: 'window closed', text: `${name} was closed. Pick another window or a display.` };
    } else if (follow.minimized) {
      status = { tone: 'idle', short: 'minimized', text: `Hidden. ${name} is minimized.` };
    } else if (!r) {
      status = { tone: 'idle', short: 'searching…', text: `Looking for ${name}…` };
    } else if (r.width <= 0 || r.height <= 0) {
      status = { tone: 'idle', short: 'no visible area', text: `Hidden. ${name} has no visible area.` };
    } else if (store.hideWhenUnfocused && !follow.focused && !follow.ours) {
      status = { tone: 'idle', short: 'not focused', text: `Hidden. ${name} is not focused.` };
    } else {
      bounds = r;
      visible = true;
      status = { tone: 'on', text: `Following ${name}` };
    }
  } else {
    visible = true;
    status = { tone: 'on', text: `Showing on Display ${store.selectedMonitor + 1}` };
  }

  if (visible) {
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    if (key !== lastBounds) {
      lastBounds = key;
      setOverlayBounds(bounds);
    }
  }
  overlayWindow.setOpacity(visible ? 1 : 0);

  if (status.tone !== lastStatus.tone || status.text !== lastStatus.text || status.short !== lastStatus.short) {
    lastStatus = status;
    send('status', status);
  }
}

// ── Window following ──
function stopFollow() {
  if (follow && follow.watcher) follow.watcher.stop();
  follow = null;
}

function startFollow(hwnd, title) {
  stopFollow();
  const f = { hwnd, title, watcher: null, alive: true, minimized: false, focused: false, ours: false, rect: null };
  follow = f;
  f.watcher = windows.watchWindow(
    hwnd,
    (s) => {
      if (follow !== f) return;
      f.alive = s.alive;
      f.minimized = s.minimized;
      f.focused = s.focused;
      f.ours = s.fgPid === process.pid;
      // The helper reports physical pixels; Electron bounds are DIPs.
      f.rect = !s.alive ? null
        : typeof screen.screenToDipRect === 'function' ? screen.screenToDipRect(null, s.rect)
        : s.rect;
      applyOverlay();
    },
    () => {
      if (follow !== f) return;
      f.alive = false;
      applyOverlay();
    },
  );
}

// ── Show / hide / interact ──
// True when there is a page that can actually be shown.
function hasUrl() {
  const url = overlayWindow && overlayWindow.webContents.getURL();
  return !!url && url !== 'about:blank' && !loadFailed;
}

function setLoadFailed(value) {
  loadFailed = value;
  send('can-show', hasUrl());
  // A page that failed to load leaves nothing to show.
  if (value && overlayOn) hideOverlay();
}

function showOverlay() {
  if (!hasUrl()) return; // nothing to show yet
  overlayOn = true;
  send('overlay-state', true);
  applyOverlay();
}

async function hideOverlay() {
  if (interactMode) await stopInteract(false);
  overlayOn = false;
  send('overlay-state', false);
  applyOverlay();
}

function toggleOverlay() {
  if (overlayOn) return hideOverlay();
  showOverlay();
}

// fromHotkey: the user is in another app, so don't pull the control panel in front of it.
async function startInteract(mode, fromHotkey = false) {
  if (!overlayOn) showOverlay();
  if (!overlayOn) return;
  const alreadyInteracting = !!interactMode;
  interactMode = mode;
  if (!alreadyInteracting) {
    overlayWindow._interacting = true;
    overlayWindow.setIgnoreMouseEvents(false);
    overlayWindow.setAlwaysOnTop(false);
    overlayWindow.setFocusable(true);
    if (!fromHotkey) mainWindow.setAlwaysOnTop(true, 'normal');
    if (!overlayWindow._interactCSSKey) {
      overlayWindow._interactCSSKey = await overlayWindow.webContents.insertCSS(INTERACT_CSS);
    }
  }
  applyOverlay();
  overlayWindow.focus();
  send('interact-state', interactMode);
}

async function stopInteract(focusPanel = true) {
  if (!interactMode) return;
  interactMode = null;
  overlayWindow._interacting = false;
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setFocusable(false);
  mainWindow.setAlwaysOnTop(false);
  applyOverlay();
  if (overlayWindow._interactCSSKey) {
    const key = overlayWindow._interactCSSKey;
    overlayWindow._interactCSSKey = null;
    await overlayWindow.webContents.removeInsertedCSS(key);
  }
  if (focusPanel) mainWindow.focus();
  send('interact-state', null);
}

function toggleInteract() {
  return interactMode ? stopInteract(false) : startInteract('interact', true);
}

// ── IPC ──
function currentTarget() {
  return follow
    ? { kind: 'window', hwnd: follow.hwnd, title: follow.title }
    : { kind: 'display', index: store.selectedMonitor };
}

ipcMain.handle('get-store', () => store);

ipcMain.handle('get-state', () => ({
  overlayOn,
  interactMode,
  status: lastStatus,
  target: currentTarget(),
  hideWhenUnfocused: store.hideWhenUnfocused,
  canFollow: windows.SUPPORTED,
  canShow: hasUrl(),
}));

ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays().map((d, i) => ({
    id: i,
    label: `Display ${i + 1}${d.label ? ` - ${d.label}` : ''} (${d.bounds.width}x${d.bounds.height})`,
    isPrimary: d.id === screen.getPrimaryDisplay().id,
  }));
});

ipcMain.handle('list-windows', () => windows.listWindows());

ipcMain.on('show-overlay', showOverlay);
ipcMain.on('hide-overlay', hideOverlay);

ipcMain.on('reload-overlay', () => {
  const url = overlayWindow.webContents.getURL();
  if (url && url !== 'about:blank') {
    loadFailed = false;
    overlayWindow.loadURL(url).catch(() => {});
  }
});

ipcMain.on('set-target', async (_, t) => {
  if (t && t.kind === 'window' && Number.isSafeInteger(Number(t.hwnd))) {
    startFollow(Number(t.hwnd), String(t.title || 'window'));
  } else {
    stopFollow();
    store.selectedMonitor = Number(t && t.index) || 0;
    saveStore(store);
    // "Edit layout" only exists while following a window.
    if (interactMode === 'edit') await startInteract('interact');
  }
  lastBounds = '';
  applyOverlay();
});

ipcMain.on('set-hide-unfocused', (_, value) => {
  store.hideWhenUnfocused = !!value;
  saveStore(store);
  applyOverlay();
});

ipcMain.on('set-url', (_, { url, show }) => {
  store.history = [url, ...store.history.filter(u => u !== url)].slice(0, HISTORY_LIMIT);
  saveStore(store);
  send('store-updated', store);
  loadFailed = false;
  overlayWindow.loadURL(url).catch(() => {}); // failures are reported via did-fail-load
  if (show) showOverlay();
});

ipcMain.on('save-url', (_, url) => {
  if (!store.saved.includes(url)) {
    store.saved = [url, ...store.saved];
    saveStore(store);
    send('store-updated', store);
  }
});

ipcMain.on('remove-saved', (_, url) => {
  store.saved = store.saved.filter(u => u !== url);
  saveStore(store);
  send('store-updated', store);
});

ipcMain.on('remove-history', (_, url) => {
  store.history = store.history.filter(u => u !== url);
  saveStore(store);
  send('store-updated', store);
});

ipcMain.on('clear-history', () => {
  store.history = [];
  saveStore(store);
  send('store-updated', store);
});

ipcMain.on('interact-overlay', (_, mode) => startInteract(mode === 'edit' ? 'edit' : 'interact'));
ipcMain.on('stop-interact-overlay', () => stopInteract());

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // no File/Edit/... bar, not even when pressing Alt
  createOverlayWindow();
  createMainWindow();
  applyOverlay();
  const bind = (key, fn) => {
    if (!globalShortcut.register(key, fn)) console.warn(`Could not register global shortcut ${key}`);
  };
  bind('CommandOrControl+Alt+O', toggleOverlay);
  bind('CommandOrControl+Alt+I', toggleInteract);
  setTimeout(() => checkForUpdates(mainWindow), process.env.SIMPLEOVERLAY_FAKE_UPDATE ? 1500 : 5000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopFollow();
});

app.on('window-all-closed', () => app.quit());

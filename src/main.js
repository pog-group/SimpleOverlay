const { app, BrowserWindow, Menu, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const { version } = require('../package.json');
const windows = require('./windows');
const updater = require('./updater');
const { normalizeUrl } = require('./url');

// Squirrel runs the app briefly during install/update/uninstall. Quit right away and skip all startup work.
const isSquirrelEvent = require('electron-squirrel-startup');
if (isSquirrelEvent) app.quit();

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

const storage = require('./store');
const store = storage.state; // live object: saved, history, selectedMonitor, hideWhenUnfocused
let mainWindow = null;
let overlayWindow = null;

const INTERACT_CSS = 'html, body { background: #3a3a3a !important; backdrop-filter: blur(12px) !important; }';

// Everything the overlay's geometry and visibility is derived from.
let overlayOn = false;
let interactMode = null; // null | 'interact' (clicks work) | 'edit' (clicks work + fullscreen)
let follow = null;       // { hwnd, title, proc, watcher, retry, alive, minimized, focused, ours, rect } while following a window
let overlayVisible = false; // whether the overlay is actually showing right now
let loadFailed = false;
let pendingHistoryUrl = null; // recorded in Recent only once the page has actually loaded
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
  overlayWindow.webContents.setAudioMuted(true); // the overlay is silent unless the user turns sound on

  // Zoom is kept per origin, so a navigation can reset it.
  overlayWindow.webContents.on('dom-ready', applyPageZoom);
  overlayWindow.webContents.on('did-navigate', applyPageZoom);
  overlayWindow.webContents.on('did-finish-load', async () => {
    applyPageZoom();
    await overlayWindow.webContents.insertCSS('html, body { background: transparent !important; }');
    if (overlayWindow._interacting) {
      overlayWindow._interactCSSKey = await overlayWindow.webContents.insertCSS(INTERACT_CSS);
    }
  });

  overlayWindow.webContents.on('did-finish-load', () => {
    setLoadFailed(false);
    if (pendingHistoryUrl) {
      storage.addHistory(pendingHistoryUrl).then(notifyStore);
      pendingHistoryUrl = null;
    }
  });
  overlayWindow.webContents.on('did-fail-load', (_, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) { // -3 = aborted by a newer navigation
      pendingHistoryUrl = null;
      setLoadFailed(true);
    }
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
    // On quit-and-install every window is closed in turn, so the overlay may already be gone.
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
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
  applyPageZoom();
}

// Makes the page believe the overlay is `pageWidth` px wide (e.g. 1920 on a 2560 screen) by zooming it,
// so layouts built for one resolution line up on another. 0 = native size.
function applyPageZoom() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const width = overlayWindow.getContentSize()[0];
  const zoom = store.pageWidth && width > 0 ? width / store.pageWidth : 1;
  if (Math.abs(overlayWindow.webContents.getZoomFactor() - zoom) > 0.001) {
    overlayWindow.webContents.setZoomFactor(zoom);
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
      status = { tone: 'warn', short: 'window not found', text: `${name} is gone. Waiting for it to come back, or pick another window.` };
    } else if (follow.minimized) {
      status = { tone: 'idle', short: 'minimized', text: `Hidden. ${name} is minimized.` };
    } else if (!r) {
      status = { tone: 'idle', short: 'searching…', text: `Looking for ${name}…` };
    } else if (r.width <= 0 || r.height <= 0) {
      status = { tone: 'idle', short: 'no visible area', text: `Hidden. ${name} has no visible area.` };
    } else if (store.hideWhenUnfocused && !follow.focused && !interactMode) {
      // Only the followed window counts as focus; our own panel doesn't (the overlay itself does while interacting).
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
  overlayVisible = visible;
  status.visible = visible;

  if (status.tone !== lastStatus.tone || status.text !== lastStatus.text || status.short !== lastStatus.short || status.visible !== lastStatus.visible) {
    lastStatus = status;
    send('status', status);
  }
}

// ── Window following ──
function stopFollow() {
  if (!follow) return;
  if (follow.watcher) follow.watcher.stop();
  clearInterval(follow.retry);
  follow = null;
}

// When the followed window disappears and a window of the same app appears (an app restart), lock back on.
// An exact title match wins; otherwise the app must have exactly one other window.
function findReplacement(f) {
  if (!f.proc) return null;
  const candidates = windows.listWindows().filter(w => w.proc === f.proc && Number(w.hwnd) !== f.hwnd);
  return candidates.find(w => w.title === f.title) || (candidates.length === 1 ? candidates[0] : null);
}

function watchFollowed(f) {
  if (f.watcher) f.watcher.stop();
  f.watcher = windows.watchWindow(
    f.hwnd,
    (s) => {
      if (follow !== f) return;
      f.alive = s.alive;
      f.minimized = s.minimized;
      f.focused = s.focused;
      f.ours = s.fgPid === process.pid;
      // The tracker reports physical pixels; Electron bounds are DIPs.
      f.rect = !s.alive ? null
        : typeof screen.screenToDipRect === 'function' ? screen.screenToDipRect(null, s.rect)
        : s.rect;
      if (s.alive) {
        clearInterval(f.retry);
        f.retry = null;
      } else if (!f.retry) {
        f.retry = setInterval(() => {
          const match = follow === f && findReplacement(f);
          if (!match) return;
          f.hwnd = Number(match.hwnd);
          f.title = match.title;
          watchFollowed(f);
          send('target', currentTarget());
        }, 1000);
      }
      applyOverlay();
    },
    () => {
      if (follow !== f) return;
      f.alive = false;
      applyOverlay();
    },
  );
}

function startFollow(hwnd, title, proc) {
  stopFollow();
  const f = { hwnd, title, proc, watcher: null, retry: null, alive: true, minimized: false, focused: false, ours: false, rect: null };
  follow = f;
  watchFollowed(f);
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

// Start/stop run one at a time, so mashing the hotkey can't interleave two transitions
// (that could leave the dark interact background stuck on the overlay).
let interactQueue = Promise.resolve();
function queueInteract(task) {
  const run = interactQueue.then(task);
  interactQueue = run.catch(() => {});
  return run;
}

const startInteract = (mode, fromHotkey = false) => queueInteract(() => doStartInteract(mode, fromHotkey));
const stopInteract = (focusPanel = true) => queueInteract(() => doStopInteract(focusPanel));

// fromHotkey: the user is in another app, so don't pull the control panel in front of it.
async function doStartInteract(mode, fromHotkey) {
  if (!overlayOn) showOverlay();
  if (!overlayOn) return;
  // Clicking into an overlay you can't see is pointless; fullscreen interact still works.
  // Hidden only because the followed window lost focus doesn't count: interacting forces it visible.
  if (mode === 'interact' && follow && !overlayVisible && lastStatus.short !== 'not focused') return;
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

async function doStopInteract(focusPanel) {
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
  return queueInteract(() => (interactMode ? doStopInteract(false) : doStartInteract('interact', true)));
}

// ── IPC ──
const notifyStore = () => send('store-updated', store);

function currentTarget() {
  return follow
    ? { kind: 'window', hwnd: follow.hwnd, title: follow.title, proc: follow.proc }
    : { kind: 'display', index: store.selectedMonitor };
}

ipcMain.handle('get-store', () => store);

ipcMain.handle('get-state', () => ({
  overlayOn,
  interactMode,
  status: lastStatus,
  target: currentTarget(),
  hideWhenUnfocused: store.hideWhenUnfocused,
  pageWidth: store.pageWidth,
  canFollow: windows.SUPPORTED,
  canShow: hasUrl(),
  audioMuted: overlayWindow.webContents.isAudioMuted(),
  update: updater.getUpdate(),
}));

ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays().map((d, i) => ({
    id: i,
    label: `Display ${i + 1}${d.label ? ` - ${d.label}` : ''} (${d.bounds.width}x${d.bounds.height})`,
    isPrimary: d.id === screen.getPrimaryDisplay().id,
  }));
});

ipcMain.handle('list-windows', () => windows.listWindows());

ipcMain.on('set-audio-muted', (_, muted) => overlayWindow.webContents.setAudioMuted(!!muted));
ipcMain.on('install-update', updater.installUpdate);
ipcMain.on('show-overlay', showOverlay);
ipcMain.on('hide-overlay', hideOverlay);

ipcMain.on('reload-overlay', () => {
  const url = overlayWindow.webContents.getURL();
  if (url && url !== 'about:blank') {
    loadFailed = false;
    overlayWindow.loadURL(url).catch(() => {});
  }
});

// Like Ctrl+Shift+F5: drop the HTTP cache, service workers and Cache Storage, then reload bypassing the cache.
// Cookies and localStorage are kept so logins survive.
ipcMain.on('clear-cache-reload', async () => {
  const wc = overlayWindow.webContents;
  const url = wc.getURL();
  try {
    await wc.session.clearCache();
    await wc.session.clearStorageData({ storages: ['serviceworkers', 'cachestorage', 'shadercache'] });
    await wc.session.clearCodeCaches({});
  } catch (_) { /* reload anyway */ }
  if (url && url !== 'about:blank') {
    loadFailed = false;
    wc.reloadIgnoringCache();
  }
});

ipcMain.on('set-target', async (_, t) => {
  if (t && t.kind === 'window' && Number.isSafeInteger(Number(t.hwnd))) {
    startFollow(Number(t.hwnd), String(t.title || 'window'), String(t.proc || ''));
  } else {
    stopFollow();
    store.selectedMonitor = Number(t && t.index) || 0;
    storage.persist();
    // "Edit layout" only exists while following a window.
    if (interactMode === 'edit') await startInteract('interact');
  }
  lastBounds = '';
  applyOverlay();
});

ipcMain.on('set-page-width', (_, width) => {
  const w = Number(width);
  store.pageWidth = Number.isInteger(w) && w >= 320 && w <= 7680 ? w : 0;
  storage.persist();
  applyPageZoom();
});

ipcMain.on('set-hide-unfocused', (_, value) => {
  store.hideWhenUnfocused = !!value;
  storage.persist();
  applyOverlay();
});

// Returns { ok, url } or { ok: false, error } so the panel can show what is wrong.
ipcMain.handle('set-url', (_, { url, show }) => {
  const result = normalizeUrl(url);
  if (!result.ok) return result;
  pendingHistoryUrl = result.url;
  loadFailed = false;
  overlayWindow.loadURL(result.url).catch(() => {}); // failures are reported via did-fail-load
  if (show) showOverlay();
  return result;
});

ipcMain.handle('save-url', async (_, url) => {
  const result = normalizeUrl(url);
  if (result.ok) await storage.addSaved(result.url).then(notifyStore);
  return result;
});

ipcMain.on('remove-saved', (_, url) => storage.removeSaved(url).then(notifyStore));
ipcMain.on('move-saved', (_, url, beforeUrl) => {
  if (typeof url !== 'string' || (beforeUrl != null && typeof beforeUrl !== 'string')) return;
  storage.moveSaved(url, beforeUrl).then(notifyStore);
});
ipcMain.on('remove-history', (_, url) => storage.removeHistory(url).then(notifyStore));
ipcMain.on('clear-history', () => storage.clearHistory().then(notifyStore));

ipcMain.on('interact-overlay', (_, mode) => startInteract(mode === 'edit' ? 'edit' : 'interact'));
ipcMain.on('stop-interact-overlay', () => stopInteract());

app.whenReady().then(() => {
  if (isSquirrelEvent) return;
  storage.init(app.getPath('userData'));
  storage.watch(notifyStore); // other running instances may change the saved list or history
  Menu.setApplicationMenu(null); // no File/Edit/... bar, not even when pressing Alt
  createOverlayWindow();
  createMainWindow();
  applyOverlay();
  const bind = (key, fn) => {
    if (!globalShortcut.register(key, fn)) console.warn(`Could not register global shortcut ${key}`);
  };
  bind('CommandOrControl+Alt+O', toggleOverlay);
  bind('CommandOrControl+Alt+I', toggleInteract);
  updater.startUpdateChecks(mainWindow, (u) => send('update-state', u),
    process.env.SIMPLEOVERLAY_FAKE_UPDATE ? 1500 : 5000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopFollow();
});

app.on('window-all-closed', () => app.quit());

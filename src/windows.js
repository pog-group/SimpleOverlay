// Windows-only helpers: list top-level windows and watch one of them.
// Electron cannot see other apps' windows, so we call user32/dwmapi directly through koffi
// (a prebuilt FFI module; no helper process, no PowerShell).
const path = require('path');

const SUPPORTED = process.platform === 'win32';

const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_TRANSPARENT = 0x20;     // click-through: other overlays
const WS_EX_NOACTIVATE = 0x08000000; // never takes focus: other overlays
const GWL_EXSTYLE = -20;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const POLL_MS = 16;

let native = null;
function load() {
  if (native) return native;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const kernel32 = koffi.load('kernel32.dll');
  koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  const EnumProc = koffi.proto('bool EnumProc(intptr hwnd, intptr lparam)');
  native = {
    koffi,
    EnumProc,
    GetForegroundWindow: user32.func('intptr GetForegroundWindow()'),
    IsWindow: user32.func('bool IsWindow(intptr hwnd)'),
    IsIconic: user32.func('bool IsIconic(intptr hwnd)'),
    IsWindowVisible: user32.func('bool IsWindowVisible(intptr hwnd)'),
    GetWindowRect: user32.func('bool GetWindowRect(intptr hwnd, _Out_ RECT *rect)'),
    GetWindowThreadProcessId: user32.func('uint32 GetWindowThreadProcessId(intptr hwnd, _Out_ uint32_t *pid)'),
    GetWindowLongW: user32.func('int32 GetWindowLongW(intptr hwnd, int index)'),
    GetWindowTextW: user32.func('int GetWindowTextW(intptr hwnd, _Out_ uint8_t *text, int max)'),
    EnumWindows: user32.func('bool EnumWindows(EnumProc *callback, intptr lparam)'),
    DwmRect: dwmapi.func('int DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ RECT *value, uint32 size)'),
    DwmInt: dwmapi.func('int DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ int32_t *value, uint32 size)'),
    OpenProcess: kernel32.func('intptr OpenProcess(uint32 access, bool inherit, uint32 pid)'),
    CloseHandle: kernel32.func('bool CloseHandle(intptr handle)'),
    QueryFullProcessImageNameW: kernel32.func('bool QueryFullProcessImageNameW(intptr process, uint32 flags, _Out_ uint8_t *name, _Inout_ uint32_t *size)'),
  };
  return native;
}

function windowPid(n, hwnd) {
  const pid = [0];
  n.GetWindowThreadProcessId(hwnd, pid);
  return pid[0];
}

const processNames = new Map(); // pid -> exe name without extension ('' if unknown)
function processName(n, pid) {
  if (processNames.has(pid)) return processNames.get(pid);
  let name = '';
  const handle = n.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (handle) {
    const buf = Buffer.alloc(1040);
    const size = [520];
    if (n.QueryFullProcessImageNameW(handle, 0, buf, size)) {
      name = path.win32.basename(buf.toString('utf16le', 0, size[0] * 2), '.exe');
    }
    n.CloseHandle(handle);
  }
  processNames.set(pid, name);
  return name;
}

function windowTitle(n, hwnd) {
  const buf = Buffer.alloc(1024);
  const length = n.GetWindowTextW(hwnd, buf, 512);
  return length > 0 ? buf.toString('utf16le', 0, length * 2) : '';
}

// Returns [{ hwnd, title, proc }] for windows a user would recognise as "an app window".
function listWindows() {
  if (!SUPPORTED) return [];
  const n = load();
  const handles = [];
  const callback = n.koffi.register((hwnd) => {
    handles.push(hwnd);
    return true;
  }, n.koffi.pointer(n.EnumProc));
  try {
    n.EnumWindows(callback, 0);
  } finally {
    n.koffi.unregister(callback);
  }

  const result = [];
  for (const hwnd of handles) {
    if (!n.IsWindowVisible(hwnd)) continue;
    if ((n.GetWindowLongW(hwnd, GWL_EXSTYLE) & (WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE)) !== 0) continue;
    const cloaked = [0];
    n.DwmInt(hwnd, DWMWA_CLOAKED, cloaked, 4);
    if (cloaked[0] !== 0) continue; // belongs to another virtual desktop or is a hidden UWP frame
    const title = windowTitle(n, hwnd);
    if (!title.trim() || title === 'Program Manager') continue;
    const pid = windowPid(n, hwnd);
    if (pid === process.pid) continue;
    result.push({ hwnd: String(hwnd), title, proc: processName(n, pid) });
  }
  return result;
}

// Calls onState({alive, minimized, focused, fgPid, rect:{x,y,width,height}}) whenever something changes.
// Returns { stop() }. onExit fires if the native calls start failing.
function watchWindow(hwnd, onState, onExit) {
  const id = Number(hwnd);
  if (!SUPPORTED || !Number.isSafeInteger(id)) return { stop() {} };
  const n = load();
  let last = '';

  const tick = () => {
    const alive = n.IsWindow(id);
    let minimized = false;
    const rect = {};
    if (alive) {
      minimized = n.IsIconic(id);
      // The frame without the invisible resize borders; falls back to the plain window rectangle.
      if (n.DwmRect(id, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16) !== 0) n.GetWindowRect(id, rect);
    }
    const fg = n.GetForegroundWindow();
    const fgPid = fg ? windowPid(n, fg) : 0;
    const left = rect.left || 0;
    const top = rect.top || 0;
    const key = [alive, minimized, fg === id, fgPid, left, top, rect.right || 0, rect.bottom || 0].join('|');
    if (key === last) return;
    last = key;
    onState({
      alive,
      minimized,
      focused: fg === id,
      fgPid,
      rect: { x: left, y: top, width: (rect.right || 0) - left, height: (rect.bottom || 0) - top },
    });
  };

  const timer = setInterval(() => {
    try {
      tick();
    } catch (err) {
      console.warn('Window tracking stopped:', err.message);
      clearInterval(timer);
      onExit();
    }
  }, POLL_MS);

  return { stop: () => clearInterval(timer) };
}

module.exports = { SUPPORTED, listWindows, watchWindow };

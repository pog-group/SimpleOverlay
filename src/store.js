// Persistent settings shared by every running instance of the app.
//
// - Writes go through a lock file and an atomic replace (temp file + rename), so two instances
//   never interleave writes and a crash can't leave a half-written store.json.
// - Every write re-reads the file under the lock, so one instance never overwrites another's changes.
// - `saved` and `history` are shared between instances. `selectedMonitor` and `hideWhenUnfocused`
//   belong to each instance (they're remembered as "last used" but never pushed to other instances).
const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');
const writeFileAtomic = require('write-file-atomic');

const HISTORY_LIMIT = 30;
const DEFAULT_SAVED = [
  'http://overlazy.imthespyke.fr/',
  'https://broadcast-center.imthespyke.fr/',
];

let file = null;
let queue = Promise.resolve();

// The live state. The object identity never changes, so other modules can hold on to it.
const state = {
  history: [],
  saved: DEFAULT_SAVED.slice(),
  selectedMonitor: 0,
  hideWhenUnfocused: true,
};

function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const strings = (list) => (Array.isArray(list) ? list : [])
    .map((e) => (typeof e === 'string' ? e : e && e.url)) // older versions stored objects
    .filter((e) => typeof e === 'string' && e);
  return {
    history: strings(raw.history).slice(0, HISTORY_LIMIT),
    saved: Array.isArray(raw.saved) ? strings(raw.saved) : DEFAULT_SAVED.slice(),
    selectedMonitor: Number.isInteger(raw.selectedMonitor) ? raw.selectedMonitor : 0,
    hideWhenUnfocused: raw.hideWhenUnfocused !== false,
  };
}

// Returns the parsed file, null if it doesn't exist, or throws if it exists but is unreadable.
function readDisk() {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const data = sanitize(JSON.parse(text));
  if (!data) throw new Error('store.json has an unexpected shape');
  return data;
}

// A file that can't be parsed is kept aside instead of being silently overwritten.
function quarantine() {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch (_) {}
}

function readDiskOrDefaults() {
  try {
    return readDisk() || sanitize({});
  } catch (_) {
    quarantine();
    return sanitize({});
  }
}

function init(userDataDir) {
  file = path.join(userDataDir, 'store.json');
  Object.assign(state, readDiskOrDefaults());
  return state;
}

// On Windows the final rename fails with EPERM/EBUSY while antivirus or another process
// briefly has the file open, so try again a few times.
async function writeWithRetry(text) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await writeFileAtomic(file, text);
    } catch (err) {
      if (attempt >= 15 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 + attempt * 20));
    }
  }
}

// Applies `mutate` to the freshest shared data and saves it. Calls are serialized in this process
// and locked across processes.
function update(mutate) {
  const run = queue.then(async () => {
    let release = null;
    try {
      release = await lockfile.lock(file, { realpath: false, stale: 10000, retries: { retries: 30, minTimeout: 20, maxTimeout: 200 } });
      const disk = readDiskOrDefaults();
      mutate(disk);
      disk.selectedMonitor = state.selectedMonitor;
      disk.hideWhenUnfocused = state.hideWhenUnfocused;
      await writeWithRetry(JSON.stringify(disk, null, 2));
      state.saved = disk.saved;
      state.history = disk.history;
    } catch (err) {
      // Disk trouble must not break the UI: keep the change in memory for this session.
      console.warn('Could not save store.json:', err.message);
      mutate(state);
    } finally {
      if (release) await release().catch(() => {});
    }
    return state;
  });
  queue = run.catch(() => {});
  return run;
}

// Saves this instance's own settings (monitor, hide-when-unfocused).
const persist = () => update(() => {});

const addHistory = (url) => update((d) => {
  d.history = [url, ...d.history.filter((u) => u !== url)].slice(0, HISTORY_LIMIT);
});
const removeHistory = (url) => update((d) => { d.history = d.history.filter((u) => u !== url); });
const clearHistory = () => update((d) => { d.history = []; });
const addSaved = (url) => update((d) => { if (!d.saved.includes(url)) d.saved = [url, ...d.saved]; });
const removeSaved = (url) => update((d) => { d.saved = d.saved.filter((u) => u !== url); });

// Calls onChange(state) when another instance changed the saved list or history.
function watch(onChange) {
  let timer = null;
  const check = () => {
    let disk;
    try {
      disk = readDisk();
    } catch (_) {
      return; // mid-write or unreadable: the next event will bring a good copy
    }
    if (!disk) return;
    if (JSON.stringify(disk.saved) === JSON.stringify(state.saved)
      && JSON.stringify(disk.history) === JSON.stringify(state.history)) return;
    state.saved = disk.saved;
    state.history = disk.history;
    onChange(state);
  };
  try {
    fs.watch(path.dirname(file), (_, name) => {
      if (name && name !== path.basename(file)) return;
      clearTimeout(timer);
      timer = setTimeout(check, 100);
    });
  } catch (_) {}
}

module.exports = { state, init, persist, addHistory, removeHistory, clearHistory, addSaved, removeSaved, watch };

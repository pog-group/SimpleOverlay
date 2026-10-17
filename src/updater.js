// Looks for a newer GitHub release and installs it when the user clicks "Update available" in the UI.
// Windows installs update in-app through Squirrel; other platforms get a link to the release page.
const { app, autoUpdater, dialog, net, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const REPO = 'pog-group/SimpleOverlay';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
// Squirrel reads <feed>/RELEASES and the .nupkg files listed in it; GitHub redirects "latest" to the newest release.
const FEED_URL = `https://github.com/${REPO}/releases/latest/download`;

// Testing: SIMPLEOVERLAY_FAKE_UPDATE=1 (see `npm run test:update`) pretends a newer release exists
// and walks through the whole flow without touching GitHub or restarting the app.
const FAKE = !!process.env.SIMPLEOVERLAY_FAKE_UPDATE;
const FAKE_UNINSTALLED = process.env.SIMPLEOVERLAY_FAKE_UPDATE === 'uninstalled'; // pretend this copy wasn't installed
const FAKE_RELEASE = { tag_name: 'v99.0.0', html_url: `https://github.com/${REPO}/releases` };

let current = null;          // { version, url, phase: 'available' | 'downloading' } once a newer release is found
let notify = () => {};
let parentWindow = null;
let squirrelReady = false;

// Squirrel keeps its Update.exe next to the app folder. Without it (zip, build folder, dev run) the
// app can't replace itself.
function isSquirrelInstall() {
  if (FAKE) return !FAKE_UNINSTALLED;
  return process.platform === 'win32' && fs.existsSync(path.resolve(path.dirname(process.execPath), '..', 'Update.exe'));
}

function getUpdate() {
  return current;
}

function setPhase(phase) {
  if (!current) return;
  current = { ...current, phase };
  notify(current);
}

function parseVersion(v) {
  return String(v).replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
}

function isNewer(latest, installed) {
  const a = parseVersion(latest);
  const b = parseVersion(installed);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

// A release that is still being uploaded (or whose installer files are missing) must not be offered:
// Squirrel would fail with "no update found". Windows needs the RELEASES index and the full package.
function isComplete(release) {
  const assets = (release.assets || []).filter((a) => a.state === 'uploaded');
  if (process.platform !== 'win32') return assets.length > 0;
  return assets.some((a) => a.name === 'RELEASES') && assets.some((a) => /-full\.nupkg$/.test(a.name));
}

async function fetchLatestRelease() {
  const res = await net.fetch(API_URL, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  return res.json();
}

const RECHECK_MS = 30 * 60 * 1000;

// Checks once after `firstDelayMs`, then every 30 minutes, since the overlay is often left open for days.
// onChange(update) fires when a newer release is found or its phase changes.
function startUpdateChecks(window, onChange, firstDelayMs) {
  parentWindow = window;
  notify = onChange;
  setTimeout(checkForUpdates, firstDelayMs);
  setInterval(checkForUpdates, RECHECK_MS);
}

async function checkForUpdates() {
  // Dev runs and unpacked builds can't update themselves.
  if (!app.isPackaged && !FAKE) return;
  // Don't disturb a download in progress.
  if (current && current.phase === 'downloading') return;

  let release;
  try {
    release = FAKE ? FAKE_RELEASE : await fetchLatestRelease();
  } catch (_) {
    return; // offline or rate-limited: try again next launch
  }
  if (!release || release.draft || release.prerelease) return;
  if (!FAKE && (!isNewer(release.tag_name, app.getVersion()) || !isComplete(release))) return;

  const version = release.tag_name.replace(/^v/i, '');
  if (current && current.version === version) return; // already announced
  current = { version, url: release.html_url, phase: 'available', canAutoInstall: isSquirrelInstall() };
  notify(current);
}

function showError(message, detail) {
  setPhase('available');
  dialog.showMessageBox(parentWindow, { type: 'error', message, detail: String(detail || '') });
}

function setupSquirrel() {
  if (squirrelReady) return;
  squirrelReady = true;
  autoUpdater.on('error', (err) => showError('The update failed.', err && err.message ? err.message : err));
  autoUpdater.on('update-not-available', () => showError('No update was found.', 'The release has no installable files yet.'));
  autoUpdater.on('update-downloaded', () => autoUpdater.quitAndInstall());
  autoUpdater.setFeedURL({ url: FEED_URL });
}

async function openReleasePage(explanation) {
  if (explanation) {
    const { response } = await dialog.showMessageBox(parentWindow, {
      type: 'info',
      message: "This copy can't update itself.",
      detail: explanation,
      buttons: ['Open release page', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
  }
  shell.openExternal(current.url);
}

// Called when the user clicks "Update available": download, install and restart.
function installUpdate() {
  if (!current || current.phase === 'downloading') return;

  if (!current.canAutoInstall) {
    // Windows copies that weren't installed with Setup.exe (zip, build folder) can't be replaced in place.
    openReleasePage(process.platform === 'win32'
      ? "It wasn't installed with the Setup installer, so updates can't be applied automatically. Download the new version from the release page instead."
      : null);
  } else if (FAKE) {
    setPhase('downloading');
    setTimeout(() => {
      setPhase('available');
      dialog.showMessageBox(parentWindow, { type: 'info', message: 'Test mode: the app would restart and install now.' });
    }, 2500);
  } else {
    setPhase('downloading');
    setupSquirrel();
    autoUpdater.checkForUpdates(); // downloads right away; "update-downloaded" restarts into the new version
  }
}

module.exports = { startUpdateChecks, installUpdate, getUpdate };

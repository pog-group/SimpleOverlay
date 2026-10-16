// Checks GitHub for a newer release and asks before updating.
// Windows installs update in-app through Squirrel; other platforms get a link to the release page.
const { app, autoUpdater, dialog, net, shell } = require('electron');

const REPO = 'pog-group/SimpleOverlay';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
// Squirrel reads <feed>/RELEASES and the .nupkg files listed in it; GitHub redirects "latest" to the newest release.
const FEED_URL = `https://github.com/${REPO}/releases/latest/download`;

function parseVersion(v) {
  return String(v).replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

async function fetchLatestRelease() {
  const res = await net.fetch(API_URL, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  return res.json();
}

// Testing: SIMPLEOVERLAY_FAKE_UPDATE=1 (see `npm run test:update`) pretends a newer release exists
// and walks through the whole flow without touching GitHub or restarting the app.
const FAKE = !!process.env.SIMPLEOVERLAY_FAKE_UPDATE;
const FAKE_RELEASE = { tag_name: 'v99.0.0', html_url: `https://github.com/${REPO}/releases` };

async function fakeInstall(parent, version) {
  await new Promise((resolve) => setTimeout(resolve, 2500)); // pretend to download
  const { response } = await dialog.showMessageBox(parent, {
    type: 'info',
    message: `Version ${version} is ready.`,
    detail: 'Restart Simple Overlay to finish updating. (Test mode: restarting is simulated.)',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    dialog.showMessageBox(parent, { type: 'info', message: 'Test mode: the app would restart and install now.' });
  }
}

function installOnWindows(parent, version) {
  autoUpdater.on('error', (err) => {
    dialog.showMessageBox(parent, {
      type: 'error',
      message: 'The update failed.',
      detail: String(err && err.message ? err.message : err),
    });
  });
  autoUpdater.on('update-downloaded', async () => {
    const { response } = await dialog.showMessageBox(parent, {
      type: 'info',
      message: `Version ${version} is ready.`,
      detail: 'Restart Simple Overlay to finish updating.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.setFeedURL({ url: FEED_URL });
  autoUpdater.checkForUpdates(); // downloads in the background; "update-downloaded" fires when done
}

async function checkForUpdates(parent) {
  // Dev runs and unpacked builds can't update themselves.
  if (!app.isPackaged && !FAKE) return;

  let release;
  try {
    release = FAKE ? FAKE_RELEASE : await fetchLatestRelease();
  } catch (_) {
    return; // offline or rate-limited: try again next launch
  }
  if (!release || release.draft || release.prerelease) return;
  if (!FAKE && !isNewer(release.tag_name, app.getVersion())) return;

  const version = release.tag_name.replace(/^v/i, '');
  const canAutoUpdate = process.platform === 'win32';
  const { response } = await dialog.showMessageBox(parent, {
    type: 'info',
    message: `Simple Overlay ${version} is available.`,
    detail: `You are on ${app.getVersion()}.`,
    buttons: [canAutoUpdate ? 'Update' : 'View release', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;

  if (FAKE) fakeInstall(parent, version);
  else if (canAutoUpdate) installOnWindows(parent, version);
  else shell.openExternal(release.html_url);
}

module.exports = { checkForUpdates };

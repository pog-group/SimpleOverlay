// Starts the app in dev mode with a pretend update (v99.0.0) to try the update dialogs.
const { spawn } = require('child_process');

const env = { ...process.env, SIMPLEOVERLAY_FAKE_UPDATE: '1' };
delete env.ELECTRON_RUN_AS_NODE; // set by some IDE terminals; would run electron as plain node

spawn('npx electron-forge start', { stdio: 'inherit', shell: true, env })
  .on('exit', (code) => process.exit(code ?? 0));

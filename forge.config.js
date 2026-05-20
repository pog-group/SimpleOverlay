module.exports = {
  packagerConfig: {
    name: 'Simple Overlay',
    executableName: 'simple-overlay',
    asar: true,
    icon: './assets/icons/icon',
    ignore: (path) => {
      const allowed = [
        /^$/,
        /^[/\\]package\.json$/,
        /^[/\\]src([/\\]|$)/,
        /^[/\\]assets([/\\]|$)/,
        /^[/\\]node_modules([/\\]|$)/,
      ];
      return !allowed.some(r => r.test(path));
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'simple_overlay',
        setupIcon: './assets/icons/icon.ico', 
      },
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        format: 'ULFO',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          maintainer: 'Spyke',
          homepage: 'https://pog-tv.com',
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: {},
    },
  ],
};

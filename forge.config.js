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
  // `npm run publish:win` builds, then uploads Setup.exe, RELEASES and the .nupkg to a draft
  // GitHub release for v<package.json version>. Needs a GITHUB_TOKEN env variable.
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: { owner: 'pog-group', name: 'SimpleOverlay' },
        prerelease: false,
        draft: true,
      },
    },
  ],
};

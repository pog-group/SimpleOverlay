// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    setBackground: (callback: (imageData: any) => void) => {
        ipcRenderer.on('set-background', (event: any, imageData: any) => {
            console.log('set-background', imageData);
            callback(imageData);
        });
    },
    getSources: async () => {
        return await ipcRenderer.invoke('getSources');
    },
    getOperatingSystem: async () => {
        return await ipcRenderer.invoke('getOperatingSystem');
    },
    toggleMouseEvent: async (value: boolean) => {
        if (value == true) {
            ipcRenderer.send('mouse-events-enable');
        } else {
            ipcRenderer.send('mouse-events-disable');
        }
    },
    onToggleDisplay: (callback:any) => ipcRenderer.on('toggle_display', (_, action) => callback(action)),
    onFightMode: (callback:any) => ipcRenderer.on('fightMode', (_, action) => callback(action)),
});

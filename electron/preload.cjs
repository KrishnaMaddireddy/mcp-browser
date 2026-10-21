const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcpbDesktop', {
  platform: process.platform,
  onOpenTab: (cb) => ipcRenderer.on('open-tab', (_e, url) => cb(String(url))),
  openExternal: (url) => ipcRenderer.invoke('mcpb:open-external', String(url)),
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcpbDesktop', {
  platform: process.platform,
  onOpenTab: (cb) => ipcRenderer.on('open-tab', (_e, url) => cb(String(url))),
  // From the right-click menu: { kind: 'check', claim } or { kind: 'search', query }.
  onOpenEntry: (cb) => ipcRenderer.on('open-entry', (_e, entry) => cb({ kind: String(entry?.kind || ''), claim: String(entry?.claim || ''), query: String(entry?.query || '') })),
  openExternal: (url) => ipcRenderer.invoke('mcpb:open-external', String(url)),
});

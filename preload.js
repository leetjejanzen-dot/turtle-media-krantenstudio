const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  saveProject: (project) => ipcRenderer.invoke('save-project', project),
  loadProject: () => ipcRenderer.invoke('load-project'),
  savePng: (payload) => ipcRenderer.invoke('save-png', payload),
  savePdf: (payload) => ipcRenderer.invoke('save-pdf', payload),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  openStore: () => ipcRenderer.invoke('open-store')
});

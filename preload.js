const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  saveProject: (project) => ipcRenderer.invoke('save-project', project),
  loadProject: () => ipcRenderer.invoke('load-project'),
  savePng: (payload) => ipcRenderer.invoke('save-png', payload),
  savePdf: (payload) => ipcRenderer.invoke('save-pdf', payload),
  savePodcastAudio: (payload) => ipcRenderer.invoke('save-podcast-audio', payload),
  getRecorderConfig: () => ipcRenderer.invoke('get-recorder-config'),
  openDiscordBotInvite: () => ipcRenderer.invoke('open-discord-bot-invite'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  openManualUpdate: () => ipcRenderer.invoke('open-manual-update'),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (_event, payload) => callback(payload)),
  openStore: () => ipcRenderer.invoke('open-store')
});

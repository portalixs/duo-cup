const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('commentator', {
  getStatus: () => ipcRenderer.invoke('commentator:status'),
  saveSettings: form => ipcRenderer.invoke('commentator:save', form),
  action: name => ipcRenderer.invoke('commentator:action', name),
  chooseCs2: () => ipcRenderer.invoke('commentator:choose-cs2'),
  copy: text => ipcRenderer.invoke('commentator:copy', text),
});

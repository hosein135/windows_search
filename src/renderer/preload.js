'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getHardware: (opts) => ipcRenderer.invoke('hardware:get', opts),
  dbStatus: () => ipcRenderer.invoke('db:status'),
  scanFiles: () => ipcRenderer.invoke('files:scan'),
  search: (q) => ipcRenderer.invoke('search:run', q),
  startImport: (opts) => ipcRenderer.invoke('import:start', opts),
  cancelImport: () => ipcRenderer.invoke('import:cancel'),
  onImportProgress: (cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on('import:progress', fn);
    return () => ipcRenderer.removeListener('import:progress', fn);
  },
  onGpuNormalize: (cb) => {
    const fn = async (_e, { id, strings }) => {
      try {
        const out = await cb(strings);
        ipcRenderer.send('gpu:normalize:result', { id, strings: out });
      } catch (err) {
        ipcRenderer.send('gpu:normalize:result', { id, error: String(err && err.message || err) });
      }
    };
    ipcRenderer.on('gpu:normalize', fn);
    return () => ipcRenderer.removeListener('gpu:normalize', fn);
  },
});

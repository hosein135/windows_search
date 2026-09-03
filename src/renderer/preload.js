'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getHardware: (opts) => ipcRenderer.invoke('hardware:get', opts),
  getGpuPlan: () => ipcRenderer.invoke('gpu:plan'),
  getGpuFlags: () => ipcRenderer.invoke('gpu:flags'),
  dbStatus: () => ipcRenderer.invoke('db:status'),
  scanFiles: () => ipcRenderer.invoke('files:scan'),
  search: (q) => ipcRenderer.invoke('search:run', q),
  startImport: (opts) => ipcRenderer.invoke('import:start', opts),
  importFile: (opts) => ipcRenderer.invoke('import:file', opts),
  cancelImport: () => ipcRenderer.invoke('import:cancel'),
  storageInfo: () => ipcRenderer.invoke('storage:info'),
  onImportProgress: (cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on('import:progress', fn);
    return () => ipcRenderer.removeListener('import:progress', fn);
  },
  onGpuPlanChange: (cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on('gpu:plan:changed', fn);
    return () => ipcRenderer.removeListener('gpu:plan:changed', fn);
  },
  /** Tell the main process which WebGPU adapter this renderer got (pool registration). */
  reportGpuState: (state) => ipcRenderer.send('gpu:state', state),
  /**
   * Serve GPU ops requested by the main process (fold / rank / state).
   * cb(op, payload) -> Promise<result>
   */
  onGpuOp: (cb) => {
    const fn = async (_e, { id, op, payload }) => {
      try {
        const result = await cb(op, payload);
        ipcRenderer.send('gpu:op:result', { id, result });
      } catch (err) {
        ipcRenderer.send('gpu:op:result', { id, error: String(err && err.message || err) });
      }
    };
    ipcRenderer.on('gpu:op', fn);
    return () => ipcRenderer.removeListener('gpu:op', fn);
  },
});

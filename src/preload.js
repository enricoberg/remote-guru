'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // servers.json
  listServers: () => ipcRenderer.invoke('servers:list'),
  saveServers: (list) => ipcRenderer.invoke('servers:save', list),
  pickPem: () => ipcRenderer.invoke('dialog:pickPem'),

  // ssh
  connect: (server) => ipcRenderer.invoke('ssh:connect', server),
  write: (id, data) => ipcRenderer.send('ssh:write', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('ssh:resize', { id, cols, rows }),
  disconnect: (id) => ipcRenderer.invoke('ssh:disconnect', id),
  listDir: (id, dir) => ipcRenderer.invoke('ssh:listDir', { id, dir }),
  realpath: (id, p) => ipcRenderer.invoke('ssh:realpath', { id, path: p }),
  deleteEntry: (id, p, isDir) => ipcRenderer.invoke('ssh:delete', { id, path: p, isDir }),
  copyEntry: (id, src, destDir, isDir) =>
    ipcRenderer.invoke('ssh:copy', { id, src, destDir, isDir }),
  createFile: (id, p) => ipcRenderer.invoke('ssh:createFile', { id, path: p }),
  download: (id, remotePath, filename) =>
    ipcRenderer.invoke('ssh:download', { id, remotePath, filename }),

  // eventi dal main
  onData: (cb) => ipcRenderer.on('ssh:data', (_e, p) => cb(p)),
  onCwd: (cb) => ipcRenderer.on('ssh:cwd', (_e, p) => cb(p)),
  onClosed: (cb) => ipcRenderer.on('ssh:closed', (_e, p) => cb(p)),
});

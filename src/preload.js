'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // servers.json
  listServers: () => ipcRenderer.invoke('servers:list'),
  saveServers: (list) => ipcRenderer.invoke('servers:save', list),
  exportServers: () => ipcRenderer.invoke('servers:export'),
  importServers: () => ipcRenderer.invoke('servers:import'),
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
  importLocal: (id, destDir) => ipcRenderer.invoke('ssh:import', { id, destDir }),
  download: (id, remotePath, filename, isDir) =>
    ipcRenderer.invoke('ssh:download', { id, remotePath, filename, isDir }),

  // docker
  dockerPs: (id) => ipcRenderer.invoke('docker:ps', id),
  dockerAction: (id, action, container) =>
    ipcRenderer.invoke('docker:action', { id, action, container }),
  manualPull: (id, opId, image, targetImage) =>
    ipcRenderer.invoke('docker:manualPull', { id, opId, image, targetImage }),
  onPullProgress: (cb) => ipcRenderer.on('docker:pullProgress', (_e, p) => cb(p)),
  composeImages: (id) => ipcRenderer.invoke('docker:composeImages', id),
  listImages: (id) => ipcRenderer.invoke('docker:listImages', id),
  imageAction: (id, action, image) =>
    ipcRenderer.invoke('docker:imageAction', { id, action, image }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // screen
  screenList: (id) => ipcRenderer.invoke('screen:list', id),
  screenCreate: (id, name) => ipcRenderer.invoke('screen:create', { id, name }),
  screenKill: (id, target) => ipcRenderer.invoke('screen:kill', { id, target }),
  screenDetach: (id, target) => ipcRenderer.invoke('screen:detach', { id, target }),
  screenClearStatus: (id, target) => ipcRenderer.invoke('screen:clearStatus', { id, target }),

  // eventi dal main
  onData: (cb) => ipcRenderer.on('ssh:data', (_e, p) => cb(p)),
  onCwd: (cb) => ipcRenderer.on('ssh:cwd', (_e, p) => cb(p)),
  onSty: (cb) => ipcRenderer.on('ssh:sty', (_e, p) => cb(p)),
  onClosed: (cb) => ipcRenderer.on('ssh:closed', (_e, p) => cb(p)),
});

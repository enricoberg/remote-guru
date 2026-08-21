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
  copyInto: (id, src, destDir, isDir) =>
    ipcRenderer.invoke('ssh:copyInto', { id, src, destDir, isDir }),
  makeExecutable: (id, p) => ipcRenderer.invoke('ssh:makeExecutable', { id, path: p }),
  createFile: (id, p) => ipcRenderer.invoke('ssh:createFile', { id, path: p }),
  readFile: (id, p) => ipcRenderer.invoke('ssh:readFile', { id, path: p }),
  writeFile: (id, p, content) => ipcRenderer.invoke('ssh:writeFile', { id, path: p, content }),
  mkdir: (id, p) => ipcRenderer.invoke('ssh:mkdir', { id, path: p }),
  rename: (id, from, to) => ipcRenderer.invoke('ssh:rename', { id, from, to }),
  moveInto: (id, src, destDir) => ipcRenderer.invoke('ssh:moveInto', { id, src, destDir }),
  deleteMany: (id, paths) => ipcRenderer.invoke('ssh:deleteMany', { id, paths }),
  dirSize: (id, p) => ipcRenderer.invoke('ssh:dirSize', { id, path: p }),
  pathInfo: (id, p) => ipcRenderer.invoke('ssh:pathInfo', { id, path: p }),
  compress: (id, cwd, names, archive, format) =>
    ipcRenderer.invoke('ssh:compress', { id, cwd, names, archive, format }),
  extract: (id, p, destDir) => ipcRenderer.invoke('ssh:extract', { id, path: p, destDir }),

  // trasferimenti file (upload + download, coda unica con pausa/ripresa)
  queueUpload: (id, destDir) => ipcRenderer.invoke('transfer:upload', { id, destDir }),
  queueDownload: (id, remotePath, filename, isDir, size) =>
    ipcRenderer.invoke('transfer:download', { id, remotePath, filename, isDir, size }),
  queueUploadPaths: (id, destDir, paths) =>
    ipcRenderer.invoke('transfer:uploadPaths', { id, destDir, paths }),
  queueDownloadMany: (id, items) => ipcRenderer.invoke('transfer:downloadMany', { id, items }),
  queueRelay: (srcId, srcPath, name, isDir, size, dstId, destDir) =>
    ipcRenderer.invoke('transfer:relay', { srcId, srcPath, name, isDir, size, dstId, destDir }),
  transferList: () => ipcRenderer.invoke('transfer:list'),
  transferPause: (tid) => ipcRenderer.invoke('transfer:pause', tid),
  transferResume: (tid) => ipcRenderer.invoke('transfer:resume', tid),
  transferRemove: (tid) => ipcRenderer.invoke('transfer:remove', tid),
  transferClearDone: () => ipcRenderer.invoke('transfer:clearDone'),
  onTransferUpdate: (cb) => ipcRenderer.on('transfer:update', (_e, p) => cb(p)),
  onTransferRemoved: (cb) => ipcRenderer.on('transfer:removed', (_e, p) => cb(p)),

  // monitor di sistema (dischi, cpu, ram)
  sysStats: (id) => ipcRenderer.invoke('sys:stats', id),

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

  // postgres
  pgList: (id) => ipcRenderer.invoke('pg:list', id),
  pgDumpPick: (name) => ipcRenderer.invoke('pg:dumpPick', { name }),
  pgDumpRun: (id, opId, group, dbName, localPath) =>
    ipcRenderer.invoke('pg:dumpRun', { id, opId, group, dbName, localPath }),
  onDumpProgress: (cb) => ipcRenderer.on('pg:dumpProgress', (_e, p) => cb(p)),
  pgRestorePick: () => ipcRenderer.invoke('pg:restorePick'),
  pgRestoreRun: (id, group, dbName, localPath) =>
    ipcRenderer.invoke('pg:restoreRun', { id, group, dbName, localPath }),

  // screen
  screenList: (id) => ipcRenderer.invoke('screen:list', id),
  screenCreate: (id, name) => ipcRenderer.invoke('screen:create', { id, name }),
  screenKill: (id, target) => ipcRenderer.invoke('screen:kill', { id, target }),
  screenDetach: (id, target) => ipcRenderer.invoke('screen:detach', { id, target }),
  screenClearStatus: (id, target) => ipcRenderer.invoke('screen:clearStatus', { id, target }),

  // crontab
  cronRead: (id) => ipcRenderer.invoke('cron:read', id),
  cronWrite: (id, content) => ipcRenderer.invoke('cron:write', { id, content }),

  // eventi dal main
  onData: (cb) => ipcRenderer.on('ssh:data', (_e, p) => cb(p)),
  onCwd: (cb) => ipcRenderer.on('ssh:cwd', (_e, p) => cb(p)),
  onSty: (cb) => ipcRenderer.on('ssh:sty', (_e, p) => cb(p)),
  onClosed: (cb) => ipcRenderer.on('ssh:closed', (_e, p) => cb(p)),
});

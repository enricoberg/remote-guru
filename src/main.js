'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const ssh = require('./ssh');

// In sviluppo si usa il servers.json del repo; nell'app pacchettizzata
// app.getAppPath() punta dentro app.asar (sola lettura), quindi si salva
// nella cartella dati utente, scrivibile.
const SERVERS_FILE = app.isPackaged
  ? path.join(app.getPath('userData'), 'servers.json')
  : path.join(app.getAppPath(), 'servers.json');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 500,
    title: 'Remote Guru',
    icon: path.join(__dirname, '..', 'icon.png'),
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => (mainWindow = null));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- Gestione servers.json --------------------------------------------------

function readServers() {
  try {
    const raw = fs.readFileSync(SERVERS_FILE, 'utf8');
    const data = JSON.parse(raw || '[]');
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function writeServers(list) {
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

ipcMain.handle('servers:list', () => readServers());

ipcMain.handle('servers:save', (_e, list) => {
  writeServers(list);
  return true;
});

ipcMain.handle('servers:export', async () => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Esporta configurazione (servers.json)',
    defaultPath: 'servers.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, JSON.stringify(readServers(), null, 2), 'utf8');
  return res.filePath;
});

ipcMain.handle('servers:import', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Importa configurazione (servers.json)',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const data = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
  if (!Array.isArray(data)) throw new Error('Il file non contiene un elenco di server valido.');
  return data;
});

ipcMain.handle('dialog:pickPem', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Seleziona file PEM',
    properties: ['openFile'],
    filters: [{ name: 'Chiavi PEM', extensions: ['pem', 'key', 'ppk', '*'] }],
  });
  return res.canceled ? null : res.filePaths[0];
});

// --- SSH --------------------------------------------------------------------

ipcMain.handle('ssh:connect', async (_e, server) => {
  const onData = (id, data) => send('ssh:data', { id, data });
  const onCwd = (id, cwd) => send('ssh:cwd', { id, cwd });
  const onSty = (id, sty) => send('ssh:sty', { id, sty });
  const onClose = (id) => send('ssh:closed', { id });
  const { id, cwd } = await ssh.connect(server, onData, onCwd, onSty, onClose);
  return { id, cwd };
});

ipcMain.on('ssh:write', (_e, { id, data }) => {
  try { ssh.write(id, data); } catch (_) {}
});

ipcMain.on('ssh:resize', (_e, { id, cols, rows }) => {
  ssh.resize(id, cols, rows);
});

ipcMain.handle('ssh:disconnect', (_e, id) => {
  ssh.disconnect(id);
  return true;
});

ipcMain.handle('ssh:listDir', (_e, { id, dir }) => ssh.listDir(id, dir));

ipcMain.handle('ssh:realpath', (_e, { id, path: p }) => ssh.realpath(id, p));

ipcMain.handle('ssh:delete', (_e, { id, path: p, isDir }) => ssh.deleteEntry(id, p, isDir));

ipcMain.handle('ssh:copy', (_e, { id, src, destDir, isDir }) =>
  ssh.copyRemote(id, src, destDir, isDir)
);

ipcMain.handle('ssh:createFile', (_e, { id, path: p }) => ssh.createFile(id, p));

ipcMain.handle('ssh:readFile', (_e, { id, path: p }) => ssh.readFile(id, p));
ipcMain.handle('ssh:writeFile', (_e, { id, path: p, content }) =>
  ssh.writeFile(id, p, content));

ipcMain.handle('ssh:import', async (_e, { id, destDir }) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Importa',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const names = [];
  for (const p of res.filePaths) names.push(await ssh.importPath(id, p, destDir));
  return names;
});

ipcMain.handle('ssh:download', async (_e, { id, remotePath, filename, isDir }) => {
  if (isDir) {
    // per le cartelle si sceglie una directory locale di destinazione
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Scarica cartella in…',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const dest = path.join(res.filePaths[0], filename);
    await ssh.downloadDir(id, remotePath, dest);
    return dest;
  }
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Scarica file',
    defaultPath: filename,
  });
  if (res.canceled) return null;
  await ssh.download(id, remotePath, res.filePath);
  return res.filePath;
});

// --- Docker -----------------------------------------------------------------

ipcMain.handle('docker:ps', (_e, id) => ssh.dockerPs(id));

ipcMain.handle('docker:action', (_e, { id, action, container }) =>
  ssh.dockerAction(id, action, container)
);

ipcMain.handle('docker:manualPull', (_e, { id, opId, image, targetImage }) =>
  ssh.manualPull(id, image, targetImage, (p) => send('docker:pullProgress', { opId, ...p }))
);

ipcMain.handle('docker:composeImages', (_e, id) => ssh.composeImages(id));

ipcMain.handle('docker:listImages', (_e, id) => ssh.listImages(id));

ipcMain.handle('docker:imageAction', (_e, { id, action, image }) =>
  ssh.imageAction(id, action, image)
);

// --- Screen -----------------------------------------------------------------

ipcMain.handle('screen:list', (_e, id) => ssh.screenList(id));

ipcMain.handle('screen:create', (_e, { id, name }) => ssh.screenCreate(id, name));

ipcMain.handle('screen:kill', (_e, { id, target }) => ssh.screenKill(id, target));

ipcMain.handle('screen:detach', (_e, { id, target }) => ssh.screenDetach(id, target));

ipcMain.handle('screen:clearStatus', (_e, { id, target }) => ssh.screenClearStatus(id, target));

ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url));

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

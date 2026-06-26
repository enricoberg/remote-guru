'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const ssh = require('./ssh');

const SERVERS_FILE = path.join(app.getAppPath(), 'servers.json');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 500,
    title: 'Remote Guru',
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
  const onClose = (id) => send('ssh:closed', { id });
  const { id, cwd } = await ssh.connect(server, onData, onCwd, onClose);
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

ipcMain.handle('ssh:download', async (_e, { id, remotePath, filename }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Scarica file',
    defaultPath: filename,
  });
  if (res.canceled) return null;
  await ssh.download(id, remotePath, res.filePath);
  return res.filePath;
});

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

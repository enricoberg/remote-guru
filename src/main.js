'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const ssh = require('./ssh');
const transfers = require('./transfers');

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

/**
 * Menu dell'applicazione: è quello predefinito di Electron senza le voci di
 * zoom della pagina. I loro acceleratori (Cmd/Ctrl con +, - e 0) servono allo
 * zoom del carattere del terminale, che agisce sulla singola sessione: un
 * acceleratore di menu verrebbe eseguito comunque, scavalcando il renderer.
 * Le voci di modifica (copia/incolla) restano, perché su macOS il terminale
 * dipende da quelle per Cmd+C / Cmd+V.
 */
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

app.whenReady().then(() => {
  // coda trasferimenti: stato persistito nella cartella dati utente, così i
  // download/upload incompleti sopravvivono alla chiusura dell'app
  transfers.init({
    ssh,
    emit: send,
    storePath: path.join(app.getPath('userData'), 'transfers.json'),
    // area di transito delle copie server -> server (drag&drop fra due schede)
    tmpRoot: path.join(app.getPath('temp'), 'remote-guru'),
  });
  buildAppMenu();
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
  const onClose = (id) => {
    // i trasferimenti in corso su questa sessione vanno in pausa, non persi
    transfers.onSessionClosed(id);
    send('ssh:closed', { id });
  };
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
  transfers.onSessionClosed(id);
  ssh.disconnect(id);
  return true;
});

ipcMain.handle('ssh:listDir', (_e, { id, dir }) => ssh.listDir(id, dir));

ipcMain.handle('ssh:realpath', (_e, { id, path: p }) => ssh.realpath(id, p));

ipcMain.handle('ssh:delete', (_e, { id, path: p, isDir }) => ssh.deleteEntry(id, p, isDir));

ipcMain.handle('ssh:copy', (_e, { id, src, destDir, isDir }) =>
  ssh.copyRemote(id, src, destDir, isDir)
);

ipcMain.handle('ssh:copyInto', (_e, { id, src, destDir, isDir }) =>
  ssh.copyInto(id, src, destDir, isDir)
);

ipcMain.handle('ssh:makeExecutable', (_e, { id, path: p }) => ssh.makeExecutable(id, p));

ipcMain.handle('ssh:createFile', (_e, { id, path: p }) => ssh.createFile(id, p));

ipcMain.handle('ssh:readFile', (_e, { id, path: p }) => ssh.readFile(id, p));
ipcMain.handle('ssh:writeFile', (_e, { id, path: p, content }) =>
  ssh.writeFile(id, p, content));

ipcMain.handle('ssh:mkdir', (_e, { id, path: p }) => ssh.makeDir(id, p));

ipcMain.handle('ssh:rename', (_e, { id, from, to }) => ssh.renameEntry(id, from, to));

ipcMain.handle('ssh:moveInto', (_e, { id, src, destDir }) => ssh.moveInto(id, src, destDir));

ipcMain.handle('ssh:deleteMany', (_e, { id, paths }) => ssh.deleteMany(id, paths));

ipcMain.handle('ssh:dirSize', (_e, { id, path: p }) => ssh.dirSize(id, p));

ipcMain.handle('ssh:pathInfo', (_e, { id, path: p }) => ssh.pathInfo(id, p));

ipcMain.handle('ssh:compress', (_e, { id, cwd, names, archive, format }) =>
  ssh.compress(id, cwd, names, archive, format));

ipcMain.handle('ssh:extract', (_e, { id, path: p, destDir }) => ssh.extract(id, p, destDir));

// --- Trasferimenti file (upload + download) ---------------------------------

/** Chiede dove salvare e accoda il download; ritorna la voce creata (o null). */
ipcMain.handle('transfer:download', async (_e, { id, remotePath, filename, isDir, size }) => {
  let localPath;
  if (isDir) {
    // per le cartelle si sceglie una directory locale di destinazione
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Scarica cartella in…',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    localPath = path.join(res.filePaths[0], filename);
  } else {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Scarica file',
      defaultPath: filename,
    });
    if (res.canceled || !res.filePath) return null;
    localPath = res.filePath;
  }
  return transfers.addDownload({ sessionId: id, remotePath, name: filename, isDir, localPath, size });
});

/** Chiede quali file/cartelle caricare e li accoda; ritorna le voci create. */
ipcMain.handle('transfer:upload', async (_e, { id, destDir }) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Carica sul server',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths.map((p) => transfers.addUpload({ sessionId: id, localPath: p, destDir }));
});

/**
 * Accoda l'upload di percorsi locali già noti (file trascinati dal Finder /
 * Esplora file dentro il file browser): nessun dialog, la destinazione è la
 * cartella su cui è avvenuto il drop.
 */
ipcMain.handle('transfer:uploadPaths', (_e, { id, destDir, paths }) => {
  const list = (paths || []).filter((p) => typeof p === 'string' && p);
  const items = [];
  const errors = [];
  list.forEach((p) => {
    try {
      items.push(transfers.addUpload({ sessionId: id, localPath: p, destDir }));
    } catch (e) {
      errors.push(e.message);
    }
  });
  if (!items.length && errors.length) throw new Error(errors[0]);
  return items;
});

/** Chiede una sola cartella di destinazione e accoda il download di più voci. */
ipcMain.handle('transfer:downloadMany', async (_e, { id, items }) => {
  const list = (items || []).filter((it) => it && it.path && it.name);
  if (!list.length) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Scarica in…',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const dir = res.filePaths[0];
  return list.map((it) =>
    transfers.addDownload({
      sessionId: id,
      remotePath: it.path,
      name: it.name,
      isDir: !!it.isDir,
      localPath: path.join(dir, it.name),
      size: it.size,
    })
  );
});

/**
 * Copia un file/cartella da un server a un altro: accoda il download nella
 * cartella temporanea locale; l'upload sul secondo server parte da solo appena
 * il download è completo.
 */
ipcMain.handle('transfer:relay', (_e, { srcId, srcPath, name, isDir, size, dstId, destDir }) =>
  transfers.addRelay({
    srcSessionId: srcId, srcPath, name, isDir, size, dstSessionId: dstId, destDir,
  })
);

ipcMain.handle('transfer:list', () => transfers.list());
ipcMain.handle('transfer:pause', (_e, id) => { transfers.pause(id); return true; });
ipcMain.handle('transfer:resume', (_e, id) => transfers.resume(id));
ipcMain.handle('transfer:remove', (_e, id) => { transfers.remove(id); return true; });
ipcMain.handle('transfer:clearDone', () => { transfers.clearDone(); return true; });

// --- Monitor di sistema -----------------------------------------------------

ipcMain.handle('sys:stats', (_e, id) => ssh.sysStats(id));

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

// --- PostgreSQL -------------------------------------------------------------

ipcMain.handle('pg:list', (_e, id) => ssh.pgListAll(id));

// Sceglie il percorso locale dove salvare il dump.
ipcMain.handle('pg:dumpPick', async (_e, { name }) => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Salva dump database',
    defaultPath: `${name || 'database'}_${stamp}.dump`,
    filters: [{ name: 'PostgreSQL dump', extensions: ['dump'] }],
  });
  return res.canceled || !res.filePath ? null : res.filePath;
});

ipcMain.handle('pg:dumpRun', (_e, { id, opId, group, dbName, localPath }) =>
  ssh.pgDump(id, group, dbName, localPath, (p) => send('pg:dumpProgress', { opId, ...p }))
);

// Sceglie il file dump locale da ripristinare.
ipcMain.handle('pg:restorePick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Seleziona il file dump da ripristinare',
    properties: ['openFile'],
    filters: [{ name: 'PostgreSQL dump', extensions: ['dump', 'backup', 'sql'] }, { name: 'Tutti i file', extensions: ['*'] }],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

ipcMain.handle('pg:restoreRun', (_e, { id, group, dbName, localPath }) =>
  ssh.pgRestore(id, group, dbName, localPath)
);

// --- Screen -----------------------------------------------------------------

ipcMain.handle('screen:list', (_e, id) => ssh.screenList(id));

ipcMain.handle('screen:create', (_e, { id, name }) => ssh.screenCreate(id, name));

ipcMain.handle('screen:kill', (_e, { id, target }) => ssh.screenKill(id, target));

ipcMain.handle('screen:detach', (_e, { id, target }) => ssh.screenDetach(id, target));

ipcMain.handle('screen:clearStatus', (_e, { id, target }) => ssh.screenClearStatus(id, target));

// --- Crontab ------------------------------------------------------------------

ipcMain.handle('cron:read', (_e, id) => ssh.cronRead(id));

ipcMain.handle('cron:write', (_e, { id, content }) => ssh.cronWrite(id, content));

ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url));

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

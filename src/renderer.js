'use strict';

const { Terminal } = window;
const FitAddon = window.FitAddon.FitAddon;

// ----------------------------------------------------------------------------
// Stato globale
// ----------------------------------------------------------------------------
let servers = [];
let selectedIndex = -1; // server selezionato nella config

/** @type {Map<string, Tab>} sessione SSH id -> tab */
const tabs = new Map();
let activeTabId = null;
let splitTabId = null; // seconda scheda mostrata in split view
let splitRatio = 0.5;

let remoteClipboard = null; // { sessionId, path, isDir, name }

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

// ============================================================================
// CONFIG VIEW
// ============================================================================

async function loadServers() {
  servers = await window.api.listServers();
  renderServerList();
}

function renderServerList() {
  const ul = $('#server-list');
  ul.innerHTML = '';
  servers.forEach((s, i) => {
    const li = el('li');
    if (i === selectedIndex) li.classList.add('selected');
    const nick = el('div', 'li-nick');
    nick.textContent = s.nickname || s.name || s.host;
    const sub = el('div', 'li-sub');
    sub.textContent = `${s.username}@${s.host}:${s.port || 22} · ${s.usePem ? 'PEM' : 'password'}`;
    li.appendChild(nick);
    li.appendChild(sub);
    li.addEventListener('click', () => selectServer(i));
    li.addEventListener('dblclick', () => { selectServer(i); openConnection(servers[i]); });
    ul.appendChild(li);
  });
}

function blankServer() {
  return {
    nickname: '', name: '', host: '', port: 22,
    username: '', usePem: true, pemPath: '', password: '', passphrase: '',
  };
}

function selectServer(i) {
  selectedIndex = i;
  renderServerList();
  fillForm(servers[i]);
  $('#btn-delete').classList.remove('hidden');
}

function newServer() {
  selectedIndex = -1;
  renderServerList();
  fillForm(blankServer());
  $('#btn-delete').classList.add('hidden');
}

function fillForm(s) {
  $('#form-empty').classList.add('hidden');
  const form = $('#server-form');
  form.classList.remove('hidden');
  form.nickname.value = s.nickname || '';
  form.host.value = s.host || '';
  form.port.value = s.port || 22;
  form.username.value = s.username || '';
  form.password.value = s.password || '';
  // passphrase chiave PEM (separata dalla password); retro-compat: se assente, vuota
  form.passphrase.value = s.passphrase || '';
  form.pemPath.value = s.pemPath || '';
  const mode = s.usePem ? 'pem' : 'password';
  form.querySelector(`input[name=authMode][value=${mode}]`).checked = true;
  applyAuthMode();
}

function applyAuthMode() {
  const mode = $('#server-form').authMode.value;
  // la password resta sempre visibile; cambia solo la visibilità del blocco PEM
  $('#field-pem').classList.toggle('hidden', mode !== 'pem');
}

function readForm() {
  const form = $('#server-form');
  const usePem = form.authMode.value === 'pem';
  const host = form.host.value.trim();
  const username = form.username.value.trim();
  return {
    nickname: form.nickname.value.trim() || `${username}@${host}`,
    name: `${username}@${host}`,
    host,
    port: parseInt(form.port.value, 10) || 22,
    username,
    usePem,
    pemPath: form.pemPath.value.trim(),
    // password sempre salvata (login password + "incolla password")
    password: form.password.value || '',
    // passphrase della chiave, separata dalla password
    passphrase: form.passphrase.value || '',
  };
}

async function saveServer(e) {
  e.preventDefault();
  const data = readForm();
  if (!data.host || !data.username) return toast('Host e username obbligatori', true);
  if (selectedIndex >= 0) servers[selectedIndex] = data;
  else { servers.push(data); selectedIndex = servers.length - 1; }
  await window.api.saveServers(servers);
  renderServerList();
  toast('Configurazione salvata');
}

async function deleteServer() {
  if (selectedIndex < 0) return;
  const s = servers[selectedIndex];
  if (!confirm(`Eliminare "${s.nickname}"?`)) return;
  servers.splice(selectedIndex, 1);
  selectedIndex = -1;
  await window.api.saveServers(servers);
  renderServerList();
  $('#server-form').classList.add('hidden');
  $('#form-empty').classList.remove('hidden');
  toast('Server eliminato');
}

async function connectFromForm() {
  // salva implicitamente i campi correnti prima di connettere
  const data = readForm();
  if (!data.host || !data.username) return toast('Host e username obbligatori', true);
  await openConnection(data);
}

// ============================================================================
// TERMINAL VIEW
// ============================================================================

function showView(name) {
  $('#config-view').classList.toggle('active', name === 'config');
  $('#terminal-view').classList.toggle('active', name === 'terminal');
  // mostra "torna alle sessioni" solo se ci sono schede aperte
  $('#btn-back').classList.toggle('hidden', !(name === 'config' && tabs.size > 0));
  if (name === 'terminal') setTimeout(fitAll, 50);
}

async function openConnection(server) {
  toast(`Connessione a ${server.host}…`);
  let res;
  try {
    res = await window.api.connect(server);
  } catch (e) {
    return toast('Errore connessione: ' + e.message, true);
  }
  const id = res.id;

  const term = new Terminal({
    fontFamily: 'SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#89b4fa' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const tab = {
    id, server, term, fit,
    cwd: res.cwd || '~',
    paneEl: null, tabEl: null, hostEl: null, cwdEl: null,
    dead: false, inputBuffer: '',
  };
  tabs.set(id, tab);

  buildPane(tab);
  buildTabButton(tab);

  // input utente -> shell remota
  term.onData((d) => window.api.write(id, d));
  term.onResize(({ cols, rows }) => window.api.resize(id, cols, rows));

  activeTabId = id;
  showView('terminal');
  layout();
  setTimeout(() => { fit.fit(); term.focus(); }, 60);
}

function buildTabButton(tab) {
  const t = el('div', 'tab');
  t.draggable = true;
  t.dataset.id = tab.id;
  const dot = el('span', 'dot');
  const title = el('span', 'tab-title');
  title.textContent = tab.server.nickname || tab.server.name;
  const close = el('button', 'tab-close');
  close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });
  t.appendChild(dot);
  t.appendChild(title);
  t.appendChild(close);
  t.addEventListener('click', () => {
    if (title.isContentEditable) return; // in fase di rinomina
    setActive(tab.id);
  });

  // drag & drop per split view
  t.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/tab', tab.id));

  // menu contestuale sulla scheda
  t.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, [
      { icon: 'fa-solid fa-clone', label: 'Duplica sessione', action: () => openConnection(tab.server) },
      { icon: 'fa-solid fa-pen', label: 'Rinomina', action: () => renameTab(tab.id) },
      { sep: true },
      { icon: 'fa-solid fa-xmark', label: 'Chiudi', action: () => closeTab(tab.id) },
    ]);
  });

  tab.tabEl = t;
  $('#tabs').appendChild(t);
}

function buildPane(tab) {
  const pane = el('div', 'pane');
  pane.dataset.id = tab.id;

  const toolbar = el('div', 'pane-toolbar');
  const llBtn = el('button', 'btn-ll');
  llBtn.title = 'Elenca contenuto cartella (ll)';
  llBtn.innerHTML = '<i class="fa-solid fa-list"></i>';
  llBtn.addEventListener('click', () => showListing(tab));
  const clearBtn = el('button', 'btn-ll');
  clearBtn.title = 'Pulisci terminale (clear)';
  clearBtn.innerHTML = '<i class="fa-solid fa-display"></i>';
  clearBtn.addEventListener('click', () => {
    tab.term.clear();
    window.api.write(tab.id, 'clear\r');
    tab.term.focus();
  });
  const srv = el('span', 'srv-name');
  srv.textContent = tab.server.nickname || tab.server.name;
  const cwd = el('span', 'cwd');
  cwd.textContent = tab.cwd;
  tab.cwdEl = cwd;
  const splitBtn = el('button', 'btn-ll');
  splitBtn.title = 'Affianca un\'altra scheda (split view)';
  splitBtn.innerHTML = '<i class="fa-solid fa-table-columns"></i>';
  splitBtn.style.marginLeft = 'auto';
  splitBtn.addEventListener('click', () => toggleSplit(tab.id));
  toolbar.appendChild(llBtn);
  toolbar.appendChild(clearBtn);
  toolbar.appendChild(srv);
  toolbar.appendChild(cwd);
  toolbar.appendChild(splitBtn);

  const host = el('div', 'term-host');
  tab.hostEl = host;

  // drop zone per split view (con evidenziazione)
  pane.addEventListener('dragover', (e) => {
    e.preventDefault();
    pane.classList.add('drop-hint');
  });
  pane.addEventListener('dragleave', () => pane.classList.remove('drop-hint'));
  pane.addEventListener('drop', (e) => {
    e.preventDefault();
    pane.classList.remove('drop-hint');
    const dropped = e.dataTransfer.getData('text/tab');
    if (dropped && dropped !== activeTabId) enableSplit(dropped);
  });

  pane.appendChild(toolbar);
  pane.appendChild(host);
  $('#panes').appendChild(pane);
  tab.paneEl = pane;

  tab.term.open(host);

  // menu contestuale sul terminale (incolla password)
  host.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openTermContextMenu(e, tab);
  });
}

function renameTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  const titleEl = tab.tabEl.querySelector('.tab-title');
  const original = titleEl.textContent;
  const fallback = tab.server.nickname || tab.server.name;

  // editing inline (Electron non supporta window.prompt)
  titleEl.contentEditable = 'true';
  titleEl.classList.add('editing');
  titleEl.focus();
  // seleziona tutto il testo
  const range = document.createRange();
  range.selectNodeContents(titleEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    titleEl.contentEditable = 'false';
    titleEl.classList.remove('editing');
    const val = titleEl.textContent.trim();
    if (commit) titleEl.textContent = val || fallback;
    else titleEl.textContent = original;
    titleEl.title = titleEl.textContent;
    titleEl.removeEventListener('keydown', onKey);
    titleEl.removeEventListener('blur', onBlur);
  };
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  // evita che il click di apertura menu chiuda subito l'editing
  titleEl.addEventListener('keydown', onKey);
  setTimeout(() => titleEl.addEventListener('blur', onBlur), 0);
}

function setActive(id) {
  activeTabId = id;
  layout();
  const tab = tabs.get(id);
  if (tab) setTimeout(() => { tab.fit.fit(); tab.term.focus(); }, 30);
}

/** Dispone i pane: solo activeTab, oppure activeTab + splitTab affiancati e ridimensionabili. */
function layout() {
  const panes = $('#panes');
  // rimuovi eventuale divider
  panes.querySelectorAll('.split-divider').forEach((d) => d.remove());

  tabs.forEach((tab) => {
    const visible = tab.id === activeTabId || tab.id === splitTabId;
    tab.paneEl.classList.toggle('visible', visible);
    tab.paneEl.style.flex = '';
    tab.paneEl.style.order = '';
  });

  // aggiorna stato schede
  const splitting = splitTabId && tabs.has(splitTabId) && splitTabId !== activeTabId;
  tabs.forEach((tab) => {
    const isActive = tab.id === activeTabId || tab.id === splitTabId;
    tab.tabEl.classList.toggle('active', isActive);
    // indicatori split: quale scheda è a sinistra e quale a destra
    tab.tabEl.classList.toggle('split-left', !!splitting && tab.id === activeTabId);
    tab.tabEl.classList.toggle('split-right', !!splitting && tab.id === splitTabId);
    tab.tabEl.querySelector('.dot').classList.toggle('dead', tab.dead);
  });

  if (splitTabId && tabs.has(splitTabId) && splitTabId !== activeTabId) {
    const left = tabs.get(activeTabId).paneEl;
    const right = tabs.get(splitTabId).paneEl;
    // ordine visivo esplicito (indipendente dall'ordine nel DOM): left | divider | right
    left.style.flex = splitRatio;
    left.style.order = '1';
    right.style.flex = 1 - splitRatio;
    right.style.order = '3';
    const divider = el('div', 'split-divider');
    divider.style.order = '2';
    panes.appendChild(divider);
    setupDividerDrag(divider);
  } else {
    splitTabId = splitTabId === activeTabId ? null : splitTabId;
  }
  setTimeout(fitAll, 30);
}

function enableSplit(secondId) {
  if (secondId === activeTabId) return;
  splitTabId = secondId;
  layout();
  toast('Split view attiva — trascina il divisore centrale per ridimensionare');
}

/** Attiva/disattiva lo split dal pulsante ⫿: se attivo lo chiude, altrimenti
 *  affianca la prima scheda diversa da quella attiva. */
function toggleSplit(tabId) {
  if (splitTabId) {
    splitTabId = null;
    layout();
    toast('Split view chiusa');
    return;
  }
  if (tabId !== activeTabId) setActive(tabId);
  const other = [...tabs.keys()].find((k) => k !== activeTabId);
  if (!other) return toast('Apri almeno 2 schede per usare lo split', true);
  enableSplit(other);
}

function setupDividerDrag(divider) {
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const panes = $('#panes');
    const rect = panes.getBoundingClientRect();
    const onMove = (ev) => {
      let r = (ev.clientX - rect.left) / rect.width;
      r = Math.max(0.2, Math.min(0.8, r));
      splitRatio = r;
      tabs.get(activeTabId).paneEl.style.flex = r;
      tabs.get(splitTabId).paneEl.style.flex = 1 - r;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      fitAll();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function fitAll() {
  tabs.forEach((tab) => {
    if (tab.paneEl.classList.contains('visible')) {
      try { tab.fit.fit(); } catch (_) {}
    }
  });
}

async function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  await window.api.disconnect(id);
  tab.term.dispose();
  tab.paneEl.remove();
  tab.tabEl.remove();
  tabs.delete(id);
  if (splitTabId === id) splitTabId = null;
  if (activeTabId === id) {
    const next = tabs.keys().next();
    activeTabId = next.done ? null : next.value;
  }
  if (tabs.size === 0) showView('config');
  else layout();
}


// ============================================================================
// LISTING STRUTTURATO ("ll" cliccabile)
// ============================================================================

async function showListing(tab, dir) {
  let res;
  try {
    res = await window.api.listDir(tab.id, dir || tab.cwd);
  } catch (e) {
    return toast('Errore elenco: ' + e.message, true);
  }
  tab.cwd = res.cwd;
  if (tab.cwdEl) tab.cwdEl.textContent = res.cwd;

  // rimuovi overlay precedente
  const old = tab.hostEl.querySelector('.ll-overlay');
  if (old) old.remove();

  const overlay = el('div', 'll-overlay');
  const head = el('div', 'll-head');
  const info = el('span');
  info.innerHTML = `<i class="fa-solid fa-folder-open"></i> ${escapeHtml(res.cwd)} — ${res.entries.length} elementi`;
  const actions = el('span', 'll-head-actions');
  const searchBtn = el('button');
  searchBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i>';
  searchBtn.title = 'Cerca nella cartella (grep)';
  searchBtn.addEventListener('click', () => toggleSearch(tab, res.cwd, overlay));
  const closeBtn = el('button');
  closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  closeBtn.title = 'Chiudi';
  closeBtn.addEventListener('click', () => overlay.remove());
  actions.appendChild(searchBtn);
  actions.appendChild(closeBtn);
  head.appendChild(info);
  head.appendChild(actions);
  overlay.appendChild(head);

  // voce per risalire
  const up = makeEntry(tab, { name: '..', isDir: true, isLink: false, size: 0 }, res.cwd);
  overlay.appendChild(up);

  res.entries.forEach((entry) => {
    if (entry.name === '.' || entry.name === '..') return;
    overlay.appendChild(makeEntry(tab, entry, res.cwd));
  });

  tab.hostEl.appendChild(overlay);
}

/** Mostra/nasconde una barra di ricerca che lancia un grep nella cartella `cwd`. */
function toggleSearch(tab, cwd, overlay) {
  const existing = overlay.querySelector('.ll-search');
  if (existing) { existing.remove(); return; }

  const bar = el('div', 'll-search');
  const icon = el('i', 'fa-solid fa-magnifying-glass');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'search-input';
  input.placeholder = 'Testo da cercare con grep — Invio per cercare, Esc per chiudere';
  bar.appendChild(icon);
  bar.appendChild(input);

  // subito sotto l'intestazione
  overlay.insertBefore(bar, overlay.children[1] || null);
  input.focus();

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); bar.remove(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      overlay.remove();
      tab.term.focus();
      // grep ricorsivo, case-insensitive, con numero di riga, nella cartella corrente
      window.api.write(tab.id, `grep -rni ${shQuote(text)} ${shQuote(cwd)}\r`);
    }
  });
}

/** Mostra una riga di input nell'overlay per creare un file vuoto nella cartella `cwd`. */
function newFilePrompt(tab, cwd) {
  let overlay = tab.hostEl.querySelector('.ll-overlay');
  if (!overlay) return showListing(tab, cwd).then(() => newFilePrompt(tab, cwd));

  // rimuovi eventuale riga di input già presente
  const existing = overlay.querySelector('.ll-newfile');
  if (existing) existing.remove();

  const row = el('div', 'll-entry ll-newfile');
  const ico = el('span', 'ico');
  ico.innerHTML = '<i class="fa-solid fa-file-pen"></i>';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'newfile-input';
  input.placeholder = 'nome-file.txt — Invio per creare, Esc per annullare';
  row.appendChild(ico);
  row.appendChild(input);

  // inserisci subito dopo l'intestazione
  overlay.insertBefore(row, overlay.children[1] || null);
  input.focus();

  let done = false;
  const cleanup = () => { if (!done) { done = true; row.remove(); } };
  input.addEventListener('keydown', async (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return cleanup();
      const target = joinPath(cwd, name);
      try {
        await window.api.createFile(tab.id, target);
        toast('File creato: ' + name);
        cleanup();
        showListing(tab, cwd);
      } catch (err) { toast('Errore: ' + err.message, true); }
    }
  });
  input.addEventListener('blur', cleanup);
}

function makeEntry(tab, entry, cwd) {
  const row = el('div', 'll-entry' + (entry.isDir ? ' dir' : '') + (entry.isLink ? ' link' : ''));
  const ico = el('span', 'ico');
  ico.innerHTML = entry.isDir
    ? '<i class="fa-solid fa-folder"></i>'
    : entry.isLink ? '<i class="fa-solid fa-link"></i>' : '<i class="fa-solid fa-file"></i>';
  const nm = el('span', 'nm');
  nm.textContent = entry.name;
  const sz = el('span', 'sz');
  sz.textContent = entry.isDir ? '' : humanSize(entry.size);
  row.appendChild(ico);
  row.appendChild(nm);
  row.appendChild(sz);

  const fullPath = joinPath(cwd, entry.name);

  // click su cartella -> cd
  if (entry.isDir) {
    nm.addEventListener('click', () => {
      const target = entry.name === '..' ? parentPath(cwd) : fullPath;
      window.api.write(tab.id, `cd '${target.replace(/'/g, `'\\''`)}'\r`);
      tab.cwd = target;
      if (tab.cwdEl) tab.cwdEl.textContent = target;
      setTimeout(() => showListing(tab, target), 250);
    });
  } else {
    // doppio clic su file -> cat automatico
    row.addEventListener('dblclick', () => {
      const ov = tab.hostEl.querySelector('.ll-overlay');
      if (ov) ov.remove();
      tab.term.focus();
      window.api.write(tab.id, `cat ${shQuote(fullPath)}\r`);
    });
  }

  // menu contestuale su file/cartella
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openEntryContextMenu(e, tab, entry, fullPath, cwd);
  });

  return row;
}

// ============================================================================
// MENU CONTESTUALI
// ============================================================================

function openEntryContextMenu(e, tab, entry, fullPath, cwd) {
  const items = [
    { icon: 'fa-solid fa-file-circle-plus', label: 'Nuovo file vuoto', action: () => newFilePrompt(tab, cwd) },
    { icon: 'fa-solid fa-trash', label: 'Elimina', action: () => deleteEntry(tab, entry, fullPath) },
    { icon: 'fa-solid fa-copy', label: 'Copia', action: () => {
        remoteClipboard = { sessionId: tab.id, path: fullPath, isDir: entry.isDir, name: entry.name };
        toast(`Copiato: ${entry.name}`);
      } },
    {
      icon: 'fa-solid fa-paste',
      label: 'Incolla' + (remoteClipboard ? ` (${remoteClipboard.name})` : ''),
      disabled: !remoteClipboard,
      action: () => pasteEntry(tab, cwd),
    },
  ];
  if (!entry.isDir) {
    items.push({
      icon: 'fa-solid fa-pen-to-square',
      label: 'Modifica (sudo nano)',
      action: () => {
        const ov = tab.hostEl.querySelector('.ll-overlay');
        if (ov) ov.remove();
        tab.term.focus();
        window.api.write(tab.id, `sudo nano ${shQuote(fullPath)}\r`);
      },
    });
    items.push({ icon: 'fa-solid fa-download', label: 'Scarica in locale', action: () => downloadEntry(tab, entry, fullPath) });
  }
  openContextMenu(e.clientX, e.clientY, items);
}

function openTermContextMenu(e, tab) {
  const items = [
    {
      icon: 'fa-solid fa-key',
      label: 'Incolla password',
      disabled: !tab.server.password,
      action: () => {
        window.api.write(tab.id, tab.server.password);
        toast('Password inserita');
      },
    },
  ];
  openContextMenu(e.clientX, e.clientY, items);
}

function openContextMenu(x, y, items) {
  const menu = $('#ctx-menu');
  menu.innerHTML = '';
  items.forEach((it) => {
    if (it.sep) { menu.appendChild(el('div', 'sep')); return; }
    const d = el('div', 'item' + (it.disabled ? ' disabled' : ''));
    if (it.icon) {
      const i = el('i');
      i.className = it.icon;
      d.appendChild(i);
    }
    const span = el('span');
    span.textContent = it.label;
    d.appendChild(span);
    if (!it.disabled) {
      d.addEventListener('click', () => { hideContextMenu(); it.action(); });
    }
    menu.appendChild(d);
  });
  menu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 200) + 'px';
  menu.classList.remove('hidden');
}

function hideContextMenu() {
  $('#ctx-menu').classList.add('hidden');
}

async function deleteEntry(tab, entry, fullPath) {
  if (!confirm(`Eliminare "${entry.name}"${entry.isDir ? ' e tutto il contenuto' : ''}?`)) return;
  try {
    await window.api.deleteEntry(tab.id, fullPath, entry.isDir);
    toast('Eliminato: ' + entry.name);
    showListing(tab, tab.cwd);
  } catch (e) { toast('Errore: ' + e.message, true); }
}

async function pasteEntry(tab, destDir) {
  if (!remoteClipboard) return;
  if (remoteClipboard.sessionId !== tab.id) {
    return toast('Incolla supportato solo nella stessa connessione', true);
  }
  try {
    await window.api.copyEntry(tab.id, remoteClipboard.path, destDir, remoteClipboard.isDir);
    toast('Incollato: ' + remoteClipboard.name);
    showListing(tab, tab.cwd);
  } catch (e) { toast('Errore: ' + e.message, true); }
}

async function downloadEntry(tab, entry, fullPath) {
  try {
    const saved = await window.api.download(tab.id, fullPath, entry.name);
    if (saved) toast('Scaricato in: ' + saved);
  } catch (e) { toast('Errore download: ' + e.message, true); }
}

// ============================================================================
// EVENTI DAL MAIN
// ============================================================================

window.api.onData(({ id, data }) => {
  const tab = tabs.get(id);
  if (tab) tab.term.write(data);
});

window.api.onCwd(({ id, cwd }) => {
  const tab = tabs.get(id);
  if (tab) {
    tab.cwd = cwd;
    if (tab.cwdEl) tab.cwdEl.textContent = cwd;
  }
});

window.api.onClosed(({ id }) => {
  const tab = tabs.get(id);
  if (tab) {
    tab.dead = true;
    tab.term.write('\r\n\x1b[31m[connessione chiusa]\x1b[0m\r\n');
    layout();
  }
});

// ============================================================================
// UTILITY
// ============================================================================

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
function joinPath(dir, name) {
  if (name === '..') return parentPath(dir);
  if (dir.endsWith('/')) return dir + name;
  return dir + '/' + name;
}
function parentPath(dir) {
  if (dir === '/' || !dir.includes('/')) return '/';
  const p = dir.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
  return p === '' ? '/' : p;
}
function humanSize(bytes) {
  if (bytes == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

let toastTimer;
function toast(msg, isErr) {
  let t = $('#toast');
  if (!t) {
    t = el('div'); t.id = 'toast'; document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ============================================================================
// BOOTSTRAP
// ============================================================================

window.addEventListener('DOMContentLoaded', () => {
  loadServers();

  $('#btn-new').addEventListener('click', newServer);
  $('#server-form').addEventListener('submit', saveServer);
  $('#btn-delete').addEventListener('click', deleteServer);
  $('#btn-connect').addEventListener('click', connectFromForm);
  $('#btn-pem').addEventListener('click', async () => {
    const p = await window.api.pickPem();
    if (p) $('#server-form').pemPath.value = p;
  });
  $('#server-form').querySelectorAll('input[name=authMode]').forEach((r) =>
    r.addEventListener('change', applyAuthMode)
  );
  $('#btn-home').addEventListener('click', () => showView('config'));
  $('#btn-back').addEventListener('click', () => {
    if (tabs.size > 0) { showView('terminal'); layout(); }
  });

  document.addEventListener('click', hideContextMenu);
  window.addEventListener('resize', fitAll);
});

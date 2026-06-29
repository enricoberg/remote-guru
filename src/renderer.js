'use strict';

const { Terminal } = window;
const FitAddon = window.FitAddon.FitAddon;

// ----------------------------------------------------------------------------
// Stato globale
// ----------------------------------------------------------------------------
let servers = [];
let selectedIndex = -1; // server selezionato nella config
let serverQuery = ''; // filtro lista server (pagina iniziale)
const UNGROUPED = '__ungrouped__'; // chiave sezione "Senza gruppo"
const serverLabel = (s) => s.nickname || s.name || s.host || '';

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

/** Esporta l'elenco server su un file JSON scelto dall'utente. */
async function exportServers() {
  try {
    const dest = await window.api.exportServers();
    if (dest) toast(`Configurazione esportata in ${dest}`);
  } catch (e) {
    toast(`Errore nell'esportazione: ${e.message || e}`, true);
  }
}

/** Importa un file servers.json, sostituendo la configurazione attuale. */
async function importServers() {
  try {
    const imported = await window.api.importServers();
    if (!imported) return; // annullato
    if (!confirm(`Sostituire la configurazione attuale con ${imported.length} server importati?`)) return;
    servers = imported;
    await window.api.saveServers(servers);
    selectedIndex = -1;
    renderServerList();
    $('#server-form').classList.add('hidden');
    $('#form-empty').classList.remove('hidden');
    toast(`Importati ${imported.length} server`);
  } catch (e) {
    toast(`Errore nell'importazione: ${e.message || e}`, true);
  }
}

function renderServerList() {
  const ul = $('#server-list');
  ul.innerHTML = '';
  const q = serverQuery.trim().toLowerCase();
  const matches = (s) =>
    !q || `${s.nickname || ''} ${s.name || ''} ${s.host || ''} ${s.username || ''}`.toLowerCase().includes(q);
  const byName = (a, b) =>
    serverLabel(a.s).localeCompare(serverLabel(b.s), undefined, { sensitivity: 'base' });

  const indexed = servers.map((s, i) => ({ s, i }));
  const groupNames = [...new Set(indexed.map(({ s }) => (s.group || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  let shown = 0;
  const addServer = (entry, grouped) => {
    const li = makeServerLi(entry.s, entry.i);
    if (grouped) li.classList.add('grouped');
    ul.appendChild(li);
    shown++;
  };

  if (!groupNames.length) {
    // nessun gruppo: lista piatta ordinata alfabeticamente
    indexed.filter(({ s }) => matches(s)).sort(byName).forEach((e) => addServer(e, false));
  } else {
    groupNames.forEach((g) => {
      const members = indexed.filter(({ s }) => (s.group || '').trim() === g);
      const vis = members.filter(({ s }) => matches(s)).sort(byName);
      if (q && !vis.length) return; // in ricerca nascondi i gruppi senza match
      const collapsed = isGroupCollapsed(g) && !q;
      ul.appendChild(makeGroupHeader(g, members.length, collapsed, false));
      if (!collapsed) vis.forEach((e) => addServer(e, true));
    });
    // sezione "Senza gruppo" (anche drop target per togliere dal gruppo)
    const ung = indexed.filter(({ s }) => !(s.group || '').trim());
    const uvis = ung.filter(({ s }) => matches(s)).sort(byName);
    if (!q || uvis.length) {
      const collapsed = isGroupCollapsed(UNGROUPED) && !q;
      ul.appendChild(makeGroupHeader(UNGROUPED, ung.length, collapsed, true));
      if (!collapsed) uvis.forEach((e) => addServer(e, true));
    }
  }

  if (servers.length && !shown) {
    const empty = el('li', 'server-empty');
    empty.textContent = 'Nessuna macchina corrisponde alla ricerca.';
    ul.appendChild(empty);
  }
}

/** Crea la riga di un server (selezione, doppio click per connettere, drag&drop). */
function makeServerLi(s, i) {
  const li = el('li');
  li.draggable = true;
  if (i === selectedIndex) li.classList.add('selected');
  const nick = el('div', 'li-nick');
  nick.textContent = serverLabel(s);
  const sub = el('div', 'li-sub');
  sub.textContent = `${s.username}@${s.host}:${s.port || 22} · ${s.usePem ? 'PEM' : 'password'}`;
  li.appendChild(nick);
  li.appendChild(sub);
  li.addEventListener('click', () => selectServer(i));
  li.addEventListener('dblclick', () => { selectServer(i); openConnection(servers[i]); });

  li.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/server', String(i));
    e.dataTransfer.effectAllowed = 'move';
  });
  li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drop-hint'); });
  li.addEventListener('dragleave', () => li.classList.remove('drop-hint'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    li.classList.remove('drop-hint');
    const from = parseInt(e.dataTransfer.getData('text/server'), 10);
    if (Number.isNaN(from) || from === i) return;
    onDropOnServer(from, i);
  });
  return li;
}

/** Crea l'intestazione (collassabile + drop target) di un gruppo. */
function makeGroupHeader(name, count, collapsed, isUngrouped) {
  const li = el('li', 'server-group' + (collapsed ? ' collapsed' : ''));
  li.dataset.group = isUngrouped ? '' : name;
  const caret = el('i', 'fa-solid caret ' + (collapsed ? 'fa-chevron-right' : 'fa-chevron-down'));
  const title = el('span', 'sg-name');
  title.textContent = isUngrouped ? 'Senza gruppo' : name;
  const cnt = el('span', 'sg-count');
  cnt.textContent = count;
  li.appendChild(caret);
  li.appendChild(title);
  li.appendChild(cnt);

  li.addEventListener('click', () => {
    if (title.isContentEditable) return; // in fase di rinomina
    toggleGroupCollapsed(isUngrouped ? UNGROUPED : name);
    renderServerList();
  });
  if (!isUngrouped) {
    li.addEventListener('dblclick', (e) => { e.stopPropagation(); renameGroup(name, title); });
  }

  li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drop-hint'); });
  li.addEventListener('dragleave', () => li.classList.remove('drop-hint'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    li.classList.remove('drop-hint');
    const from = parseInt(e.dataTransfer.getData('text/server'), 10);
    if (Number.isNaN(from)) return;
    assignGroup(from, isUngrouped ? '' : name);
  });
  return li;
}

/** Drop di un server su un altro: stesso gruppo del target, o crea un nuovo gruppo. */
async function onDropOnServer(from, to) {
  const tgroup = (servers[to].group || '').trim();
  if (tgroup) {
    return assignGroup(from, tgroup);
  }
  // entrambi senza gruppo: crea un nuovo gruppo e avvia la rinomina inline
  const name = uniqueGroupName('Nuovo gruppo');
  servers[from].group = name;
  servers[to].group = name;
  await window.api.saveServers(servers);
  renderServerList();
  const title = document.querySelector(`.server-group[data-group="${cssEscape(name)}"] .sg-name`);
  if (title) renameGroup(name, title);
}

/** Assegna (o rimuove, se vuoto) il gruppo a un server e salva. */
async function assignGroup(index, groupName) {
  const g = (groupName || '').trim();
  if (g) servers[index].group = g;
  else delete servers[index].group;
  await window.api.saveServers(servers);
  renderServerList();
}

function uniqueGroupName(base) {
  const existing = new Set(servers.map((s) => (s.group || '').trim()).filter(Boolean));
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Rinomina inline di un gruppo: aggiorna tutti i server che vi appartengono. */
function renameGroup(oldName, titleEl) {
  titleEl.contentEditable = 'true';
  titleEl.classList.add('editing');
  titleEl.focus();
  const range = document.createRange();
  range.selectNodeContents(titleEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    titleEl.contentEditable = 'false';
    titleEl.classList.remove('editing');
    titleEl.removeEventListener('keydown', onKey);
    titleEl.removeEventListener('blur', onBlur);
    const val = titleEl.textContent.trim();
    if (commit && val && val !== oldName) {
      const newName = uniqueGroupName(val);
      servers.forEach((s) => { if ((s.group || '').trim() === oldName) s.group = newName; });
      if (isGroupCollapsed(oldName)) { setGroupCollapsed(oldName, false); setGroupCollapsed(newName, true); }
      await window.api.saveServers(servers);
    }
    renderServerList();
  };
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  titleEl.addEventListener('keydown', onKey);
  setTimeout(() => titleEl.addEventListener('blur', onBlur), 0);
}

// --- stato collassato dei gruppi (persistito in localStorage) ---
function groupCollapseStore() {
  try { return JSON.parse(localStorage.getItem('groupCollapsed') || '{}'); } catch (_) { return {}; }
}
function isGroupCollapsed(name) { return !!groupCollapseStore()[name]; }
function setGroupCollapsed(name, val) {
  const m = groupCollapseStore();
  if (val) m[name] = true; else delete m[name];
  localStorage.setItem('groupCollapsed', JSON.stringify(m));
}
function toggleGroupCollapsed(name) { setGroupCollapsed(name, !isGroupCollapsed(name)); }

/** Escape minimale per un valore usato in un selettore [data-group="…"]. */
function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

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
  if (selectedIndex >= 0) {
    if (servers[selectedIndex].group) data.group = servers[selectedIndex].group; // preserva il gruppo
    servers[selectedIndex] = data;
  } else { servers.push(data); selectedIndex = servers.length - 1; }
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
  const dockerBtn = el('button', 'btn-ll');
  dockerBtn.title = 'Container Docker';
  dockerBtn.innerHTML = '<i class="fa-brands fa-docker"></i>';
  dockerBtn.addEventListener('click', () => showDocker(tab));
  const imagesBtn = el('button', 'btn-ll');
  imagesBtn.title = 'Immagini Docker';
  imagesBtn.innerHTML = '<i class="fa-solid fa-hard-drive"></i>';
  imagesBtn.addEventListener('click', () => showImages(tab));
  const screensBtn = el('button', 'btn-ll');
  screensBtn.title = 'Sessioni screen';
  screensBtn.innerHTML = '<i class="fa-brands fa-buffer"></i>';
  screensBtn.addEventListener('click', () => showScreens(tab));
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
  toolbar.appendChild(dockerBtn);
  toolbar.appendChild(imagesBtn);
  toolbar.appendChild(screensBtn);
  toolbar.appendChild(srv);
  toolbar.appendChild(cwd);
  toolbar.appendChild(splitBtn);

  // intestazione visibile solo quando si è dentro uno screen
  const screenBar = el('div', 'screen-bar hidden');
  const sbIcon = el('i', 'fa-brands fa-buffer');
  const sbName = el('span', 'screen-bar-name');
  const sbDetach = el('button', 'screen-bar-detach');
  sbDetach.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i> Detach';
  sbDetach.title = 'Stacca dallo screen (Ctrl-A D)';
  sbDetach.addEventListener('click', () => detachScreen(tab));
  screenBar.appendChild(sbIcon);
  screenBar.appendChild(sbName);
  screenBar.appendChild(sbDetach);
  tab.screenBarEl = screenBar;
  tab.screenBarNameEl = sbName;

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
  pane.appendChild(screenBar);
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
  // maniglia di ridimensionamento verticale in cima al pannello
  const grip = el('div', 'll-resize');
  overlay.appendChild(grip);
  setupOverlayResize(grip, overlay, tab);
  // ripristina l'altezza scelta in precedenza (per questa scheda)
  if (tab.llHeight) { overlay.style.height = tab.llHeight + 'px'; overlay.style.maxHeight = 'none'; }

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

/** Permette di ridimensionare verticalmente il pannello file browser trascinando la maniglia in alto. */
function setupOverlayResize(grip, overlay, tab) {
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = overlay.getBoundingClientRect().height;
    const hostH = tab.hostEl.getBoundingClientRect().height;
    overlay.style.maxHeight = 'none';
    const onMove = (ev) => {
      // trascinando verso l'alto il pannello si espande
      let h = startH + (startY - ev.clientY);
      h = Math.max(80, Math.min(hostH - 30, h));
      overlay.style.height = h + 'px';
      tab.llHeight = h;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
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
// DOCKER
// ============================================================================

async function showDocker(tab) {
  let containers;
  try {
    toast('Lettura container Docker…');
    containers = await window.api.dockerPs(tab.id);
  } catch (e) {
    return toast('Errore Docker: ' + e.message, true);
  }

  // riusa lo stesso overlay del file browser
  const old = tab.hostEl.querySelector('.ll-overlay');
  if (old) old.remove();

  const overlay = el('div', 'll-overlay docker-overlay containers-overlay');
  const grip = el('div', 'll-resize');
  overlay.appendChild(grip);
  setupOverlayResize(grip, overlay, tab);
  if (tab.llHeight) { overlay.style.height = tab.llHeight + 'px'; overlay.style.maxHeight = 'none'; }

  const head = el('div', 'll-head');
  const info = el('span');
  info.innerHTML = `<i class="fa-brands fa-docker"></i> Container attivi — ${containers.length}`;
  const actions = el('span', 'll-head-actions');
  const refreshBtn = el('button');
  refreshBtn.innerHTML = '<i class="fa-solid fa-rotate"></i>';
  refreshBtn.title = 'Aggiorna';
  refreshBtn.addEventListener('click', () => showDocker(tab));
  const closeBtn = el('button');
  closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  closeBtn.title = 'Chiudi';
  closeBtn.addEventListener('click', () => overlay.remove());
  actions.appendChild(refreshBtn);
  actions.appendChild(closeBtn);
  head.appendChild(info);
  head.appendChild(actions);
  overlay.appendChild(head);

  if (!containers.length) {
    const empty = el('div', 'docker-empty');
    empty.textContent = 'Nessun container attivo.';
    overlay.appendChild(empty);
  }

  // raggruppa i container per cartella (working dir del progetto compose)
  const groups = new Map();
  containers.forEach((c) => {
    const key = c.workdir || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  });
  // cartelle note prima (ordinate), i container senza cartella per ultimi
  const keys = [...groups.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
  });

  // barra di ricerca (filtra per nome/immagine/stato)
  let searchInput = null;
  if (containers.length) {
    const bar = el('div', 'll-search');
    const icon = el('i', 'fa-solid fa-magnifying-glass');
    searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'search-input';
    searchInput.placeholder = 'Filtra container…';
    bar.appendChild(icon);
    bar.appendChild(searchInput);
    overlay.appendChild(bar);
  }

  const blocks = [];
  keys.forEach((key) => {
    const header = el('div', 'docker-group');
    header.innerHTML = key
      ? `<i class="fa-solid fa-folder"></i> ${escapeHtml(key)}`
      : '<i class="fa-solid fa-layer-group"></i> Senza cartella';
    overlay.appendChild(header);
    const items = groups.get(key).map((c) => {
      const row = makeDockerRow(tab, c);
      overlay.appendChild(row);
      return { text: `${c.name} ${c.image} ${c.status || ''}`.toLowerCase(), row };
    });
    blocks.push({ header, items });
  });

  const noRes = el('div', 'docker-empty');
  noRes.textContent = 'Nessun risultato.';
  noRes.style.display = 'none';
  overlay.appendChild(noRes);

  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => e.stopPropagation());
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      let total = 0;
      blocks.forEach((b) => {
        let vis = 0;
        b.items.forEach((it) => {
          const match = !q || it.text.includes(q);
          it.row.style.display = match ? '' : 'none';
          if (match) vis++;
        });
        b.header.style.display = vis ? '' : 'none'; // nascondi i gruppi vuoti
        total += vis;
      });
      noRes.style.display = total ? 'none' : '';
    });
  }

  tab.hostEl.appendChild(overlay);
  if (searchInput) setTimeout(() => searchInput.focus(), 0);
}

function makeDockerRow(tab, c) {
  const row = el('div', 'docker-row' + (c.running ? '' : ' stopped'));

  const dot = el('span', 'docker-dot' + (c.running ? ' on' : ''));
  dot.title = c.status || c.state || '';
  row.appendChild(dot);

  const meta = el('div', 'docker-meta');
  const name = el('span', 'docker-name');
  name.innerHTML = `<i class="fa-solid fa-cube"></i> ${escapeHtml(c.name)}`;
  name.title = c.name + (c.status ? ` — ${c.status}` : '');
  const img = el('span', 'docker-img');
  img.textContent = c.status ? `${c.image} · ${c.status}` : c.image;
  img.title = `${c.image}${c.status ? ` — ${c.status}` : ''}`;
  meta.appendChild(name);
  meta.appendChild(img);

  const btns = el('div', 'docker-actions');
  // container attivo: stop/restart; container fermo: up. down/pull sempre.
  const defs = c.running
    ? [
        { action: 'logs',    icon: 'fa-file-lines',       label: 'Logs',    cls: 'd-logs' },
        { action: 'shell',   icon: 'fa-terminal',         label: 'Shell',   cls: 'd-shell' },
        { action: 'browser', icon: 'fa-globe',            label: 'Browser', cls: 'd-browser' },
        { action: 'stop',    icon: 'fa-stop',             label: 'Stop',    cls: 'd-stop' },
        { action: 'restart', icon: 'fa-rotate-right',     label: 'Restart', cls: 'd-restart' },
        { action: 'down',    icon: 'fa-arrow-down',       label: 'Down',    cls: 'd-down' },
        { action: 'pull',    icon: 'fa-cloud-arrow-down', label: 'Pull',    cls: 'd-pull' },
      ]
    : [
        { action: 'up',      icon: 'fa-play',             label: 'Up',      cls: 'd-up' },
        { action: 'logs',    icon: 'fa-file-lines',       label: 'Logs',    cls: 'd-logs' },
        { action: 'down',    icon: 'fa-arrow-down',       label: 'Down',    cls: 'd-down' },
        { action: 'pull',    icon: 'fa-cloud-arrow-down', label: 'Pull',    cls: 'd-pull' },
      ];
  defs.forEach((d) => {
    const b = el('button', 'docker-btn ' + d.cls);
    b.innerHTML = `<i class="fa-solid ${d.icon}"></i><span class="lbl">${d.label}</span>`;
    b.title = `${d.label} ${c.name}`;
    b.addEventListener('click', () => dockerAction(tab, d.action, c, b));
    btns.appendChild(b);
  });

  row.appendChild(meta);
  row.appendChild(btns);
  return row;
}

async function dockerAction(tab, action, c, btn) {
  // i log vanno mostrati live nel terminale (come cat/grep)
  if (action === 'logs') {
    const ov = tab.hostEl.querySelector('.ll-overlay');
    if (ov) ov.remove();
    tab.term.focus();
    const follow = c.running ? '-f ' : '';
    window.api.write(tab.id, `docker logs --tail 200 ${follow}${shQuote(c.id)}\r`);
    return;
  }

  // Shell: entra nel container nel terminale (docker exec -it ... bash/sh)
  if (action === 'shell') {
    const ov = tab.hostEl.querySelector('.ll-overlay');
    if (ov) ov.remove();
    tab.term.clear(); // pulisce lo scrollback prima di entrare
    tab.term.focus();
    const inner = 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi';
    window.api.write(tab.id, `clear && docker exec -it ${shQuote(c.name)} sh -c ${shQuote(inner)}\r`);
    return;
  }

  // Browser: apre la porta esposta dal container nel browser di sistema
  if (action === 'browser') {
    openContainerBrowser(tab, c, btn);
    return;
  }

  const labels = { up: 'Up', stop: 'Stop', restart: 'Restart', down: 'Down', pull: 'Pull' };
  if (action === 'down' && !confirm(`Eseguire "down" su "${c.name}"?`)) return;

  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
  try {
    toast(`${labels[action]} ${c.name}…`);
    await window.api.dockerAction(tab.id, action, c);
    toast(`${labels[action]} completato: ${c.name}`);
    showDocker(tab); // ricarica lo stato
  } catch (e) {
    toast(`Errore ${labels[action]}: ` + e.message, true);
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

/** Apre nel browser di sistema la porta esposta dal container (http://host:porta). */
function openContainerBrowser(tab, c, btn) {
  const ports = c.ports || [];
  if (!ports.length) return toast('Il container non espone porte', true);
  const host = tab.server.host;
  const open = (p) => window.api.openExternal(`http://${host}:${p}`);
  if (ports.length === 1) return open(ports[0]);
  // più porte: menu di scelta accanto al pulsante
  const rect = btn ? btn.getBoundingClientRect() : { left: 100, bottom: 100 };
  openContextMenu(rect.left, rect.bottom, ports.map((p) => ({
    icon: 'fa-solid fa-globe',
    label: `Porta ${p}`,
    action: () => open(p),
  })));
}

// ============================================================================
// IMMAGINI DOCKER
// ============================================================================

async function showImages(tab) {
  let composeImgs, localImgs;
  try {
    toast('Lettura immagini Docker…');
    [composeImgs, localImgs] = await Promise.all([
      window.api.composeImages(tab.id),
      window.api.listImages(tab.id),
    ]);
  } catch (e) {
    return toast('Errore immagini: ' + e.message, true);
  }

  const old = tab.hostEl.querySelector('.ll-overlay');
  if (old) old.remove();

  const overlay = el('div', 'll-overlay docker-overlay');
  const grip = el('div', 'll-resize');
  overlay.appendChild(grip);
  setupOverlayResize(grip, overlay, tab);
  if (tab.llHeight) { overlay.style.height = tab.llHeight + 'px'; overlay.style.maxHeight = 'none'; }

  const head = el('div', 'll-head');
  const info = el('span');
  info.innerHTML = '<i class="fa-solid fa-hard-drive"></i> Immagini Docker';
  const actions = el('span', 'll-head-actions');
  const refreshBtn = el('button');
  refreshBtn.innerHTML = '<i class="fa-solid fa-rotate"></i>';
  refreshBtn.title = 'Aggiorna';
  refreshBtn.addEventListener('click', () => showImages(tab));
  const closeBtn = el('button');
  closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  closeBtn.title = 'Chiudi';
  closeBtn.addEventListener('click', () => overlay.remove());
  actions.appendChild(refreshBtn);
  actions.appendChild(closeBtn);
  head.appendChild(info);
  head.appendChild(actions);
  overlay.appendChild(head);

  // --- Sezione 1: immagini dichiarate nei compose (collassata di default) ---
  const g1 = makeCollapsibleHeader(`<i class="fa-solid fa-layer-group"></i> Nei compose — ${composeImgs.length}`);
  overlay.appendChild(g1.header);
  const s1 = buildImageSection(
    composeImgs.map((it) => ({ text: it.image, row: makeComposeImageRow(tab, it.image) })),
    'Nessuna immagine trovata nei compose.'
  );
  overlay.appendChild(s1.section);
  g1.attach(s1.section, true);

  // --- Sezione 2: immagini presenti (docker images, espansa) ---
  const g2 = makeCollapsibleHeader(`<i class="fa-solid fa-hard-drive"></i> Presenti sul remoto — ${localImgs.length}`);
  overlay.appendChild(g2.header);
  const s2 = buildImageSection(
    localImgs.map((img) => ({
      text: `${img.ref || `${img.repo}:${img.tag}`} ${img.id || ''}`,
      row: makeLocalImageRow(tab, img),
    })),
    'Nessuna immagine presente.'
  );
  overlay.appendChild(s2.section);
  g2.attach(s2.section, false);

  tab.hostEl.appendChild(overlay);
  // focus sulla ricerca della seconda sezione (quella espansa)
  if (s2.input) setTimeout(() => s2.input.focus(), 0);
}

/** Crea un'intestazione di sezione collassabile con freccia. */
function makeCollapsibleHeader(html) {
  const header = el('div', 'docker-group collapsible');
  const caret = el('i', 'fa-solid fa-chevron-down caret');
  const label = el('span');
  label.innerHTML = html;
  header.appendChild(caret);
  header.appendChild(label);
  return {
    header,
    attach(content, collapsed) {
      const apply = () => {
        const isCol = header.classList.contains('collapsed');
        content.style.display = isCol ? 'none' : '';
        caret.classList.toggle('fa-chevron-right', isCol);
        caret.classList.toggle('fa-chevron-down', !isCol);
      };
      header.classList.toggle('collapsed', collapsed);
      apply();
      header.addEventListener('click', () => {
        header.classList.toggle('collapsed');
        apply();
      });
    },
  };
}

/** Costruisce una sezione di immagini con barra di ricerca che filtra le righe.
 *  Ritorna { section, input } (input è la barra di ricerca, o null se vuota). */
function buildImageSection(items, emptyText) {
  const section = el('div', 'img-section');
  if (!items.length) {
    const empty = el('div', 'docker-empty');
    empty.textContent = emptyText;
    section.appendChild(empty);
    return { section, input: null };
  }

  const bar = el('div', 'll-search');
  const icon = el('i', 'fa-solid fa-magnifying-glass');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'search-input';
  input.placeholder = 'Filtra immagini…';
  bar.appendChild(icon);
  bar.appendChild(input);
  section.appendChild(bar);

  const list = el('div', 'img-list');
  items.forEach((it) => list.appendChild(it.row));
  section.appendChild(list);

  const noRes = el('div', 'docker-empty');
  noRes.textContent = 'Nessun risultato.';
  noRes.style.display = 'none';
  section.appendChild(noRes);

  input.addEventListener('keydown', (e) => e.stopPropagation());
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    let visible = 0;
    items.forEach((it) => {
      const match = !q || it.text.toLowerCase().includes(q);
      it.row.style.display = match ? '' : 'none';
      if (match) visible++;
    });
    noRes.style.display = visible ? 'none' : '';
  });

  return { section, input };
}

function makeComposeImageRow(tab, image) {
  const row = el('div', 'docker-row');
  const meta = el('div', 'docker-meta');
  const name = el('span', 'docker-name');
  name.innerHTML = `<i class="fa-solid fa-box"></i> ${escapeHtml(image)}`;
  name.title = image;
  meta.appendChild(name);

  const btns = el('div', 'docker-actions');
  const pullBtn = el('button', 'docker-btn d-pull');
  pullBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Pull';
  pullBtn.title = 'Pull ' + image;
  pullBtn.addEventListener('click', () => imageAction(tab, 'pull', { ref: image }, pullBtn));
  const manualBtn = el('button', 'docker-btn d-manual');
  manualBtn.innerHTML = '<i class="fa-solid fa-download"></i> Manual Pull';
  manualBtn.title = 'Manual Pull → ' + image;
  manualBtn.addEventListener('click', () => openManualPull(tab, image, row));
  btns.appendChild(pullBtn);
  btns.appendChild(manualBtn);

  row.appendChild(meta);
  row.appendChild(btns);
  return row;
}

function makeLocalImageRow(tab, img) {
  const row = el('div', 'docker-row');
  const meta = el('div', 'docker-meta');
  const name = el('span', 'docker-name');
  const label = img.ref || `${img.repo}:${img.tag}`;
  name.innerHTML = `<i class="fa-solid fa-box-archive"></i> ${escapeHtml(label)}`;
  name.title = `${label} — ${img.id}`;
  const sub = el('span', 'docker-img');
  const parts = [img.size, img.created, img.id].filter(Boolean);
  sub.textContent = parts.join(' · ');
  meta.appendChild(name);
  meta.appendChild(sub);

  const btns = el('div', 'docker-actions');
  const pullBtn = el('button', 'docker-btn d-pull');
  pullBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Pull';
  if (img.ref) {
    pullBtn.title = 'Pull ' + img.ref;
    pullBtn.addEventListener('click', () => imageAction(tab, 'pull', img, pullBtn));
  } else {
    pullBtn.disabled = true;
    pullBtn.title = 'Immagine senza tag: pull non disponibile';
  }
  const delBtn = el('button', 'docker-btn d-down');
  delBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Elimina';
  delBtn.title = 'Elimina immagine';
  delBtn.addEventListener('click', () => imageAction(tab, 'delete', img, delBtn));
  btns.appendChild(pullBtn);
  btns.appendChild(delBtn);

  row.appendChild(meta);
  row.appendChild(btns);
  return row;
}

async function imageAction(tab, action, img, btn) {
  const labels = { pull: 'Pull', delete: 'Elimina' };
  const name = img.ref || img.id || '';
  if (action === 'delete' && !confirm(`Eliminare l'immagine "${name}"?`)) return;

  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
  try {
    toast(`${labels[action]} ${name}…`);
    await window.api.imageAction(tab.id, action, img);
    toast(`${labels[action]} completato: ${name}`);
    showImages(tab);
  } catch (e) {
    toast(`Errore ${labels[action]}: ` + e.message, true);
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

// ============================================================================
// SCREEN (GNU screen)
// ============================================================================

async function showScreens(tab) {
  let screens;
  try {
    toast('Lettura sessioni screen…');
    screens = await window.api.screenList(tab.id);
  } catch (e) {
    return toast('Errore screen: ' + e.message, true);
  }

  const old = tab.hostEl.querySelector('.ll-overlay');
  if (old) old.remove();

  const overlay = el('div', 'll-overlay docker-overlay');
  const grip = el('div', 'll-resize');
  overlay.appendChild(grip);
  setupOverlayResize(grip, overlay, tab);
  if (tab.llHeight) { overlay.style.height = tab.llHeight + 'px'; overlay.style.maxHeight = 'none'; }

  const head = el('div', 'll-head');
  const info = el('span');
  info.innerHTML = `<i class="fa-brands fa-buffer"></i> Sessioni screen — ${screens.length}`;
  const actions = el('span', 'll-head-actions');
  const detachBtn = el('button');
  detachBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i>';
  detachBtn.title = 'Detach dalla sessione attuale (Ctrl-A D)';
  detachBtn.addEventListener('click', () => {
    overlay.remove();
    tab.term.focus();
    window.api.write(tab.id, '\x01d'); // Ctrl-A, poi d
    setTimeout(() => showScreens(tab), 400);
  });
  const refreshBtn = el('button');
  refreshBtn.innerHTML = '<i class="fa-solid fa-rotate"></i>';
  refreshBtn.title = 'Aggiorna';
  refreshBtn.addEventListener('click', () => showScreens(tab));
  const closeBtn = el('button');
  closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  closeBtn.title = 'Chiudi';
  closeBtn.addEventListener('click', () => overlay.remove());
  actions.appendChild(detachBtn);
  actions.appendChild(refreshBtn);
  actions.appendChild(closeBtn);
  head.appendChild(info);
  head.appendChild(actions);
  overlay.appendChild(head);

  // --- barra di creazione di un nuovo screen (non vi si entra) ---
  const newBar = el('div', 'docker-mp');
  const newTop = el('div', 'docker-mp-top');
  const newIcon = el('i', 'fa-solid fa-plus');
  const newInput = document.createElement('input');
  newInput.type = 'text';
  newInput.className = 'docker-mp-input';
  newInput.placeholder = 'Nome nuovo screen — Invio per crearlo (senza entrarci)';
  const createBtn = el('button', 'docker-btn d-up');
  createBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Crea';
  const doCreate = () => createScreen(tab, newInput.value, newInput);
  createBtn.addEventListener('click', doCreate);
  newInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); doCreate(); }
  });
  newTop.appendChild(newIcon);
  newTop.appendChild(newInput);
  newTop.appendChild(createBtn);
  newBar.appendChild(newTop);
  overlay.appendChild(newBar);

  if (!screens.length) {
    const empty = el('div', 'docker-empty');
    empty.textContent = 'Nessuna sessione screen attiva.';
    overlay.appendChild(empty);
  } else {
    screens.forEach((s) => overlay.appendChild(makeScreenRow(tab, s)));
  }

  tab.hostEl.appendChild(overlay);
  setTimeout(() => newInput.focus(), 0);
}

function makeScreenRow(tab, s) {
  const attached = /attached/i.test(s.status);
  const row = el('div', 'docker-row' + (attached ? '' : ' stopped'));

  const dot = el('span', 'docker-dot' + (attached ? ' on' : ''));
  dot.title = s.status;
  row.appendChild(dot);

  const meta = el('div', 'docker-meta');
  const name = el('span', 'docker-name');
  name.innerHTML = `<i class="fa-brands fa-buffer"></i> ${escapeHtml(s.name)}`;
  name.title = s.full;
  const sub = el('span', 'docker-img');
  sub.textContent = `${s.full} · ${s.status}`;
  meta.appendChild(name);
  meta.appendChild(sub);

  const btns = el('div', 'docker-actions');
  const enterBtn = el('button', 'docker-btn d-shell');
  enterBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Entra';
  enterBtn.title = 'Entra nello screen ' + s.name;
  enterBtn.addEventListener('click', () => enterScreen(tab, s));
  const delBtn = el('button', 'docker-btn d-down');
  delBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Elimina';
  delBtn.title = 'Elimina lo screen ' + s.name;
  delBtn.addEventListener('click', () => killScreen(tab, s, delBtn));
  btns.appendChild(enterBtn);
  // il detach ha senso solo se lo screen è attualmente attaccato
  if (attached) {
    const detBtn = el('button', 'docker-btn d-stop');
    detBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i> Detach';
    detBtn.title = 'Stacca lo screen ' + s.name;
    detBtn.addEventListener('click', () => detachScreenRow(tab, s, detBtn));
    btns.appendChild(detBtn);
  }
  btns.appendChild(delBtn);

  row.appendChild(meta);
  row.appendChild(btns);
  return row;
}

async function createScreen(tab, name, input) {
  const n = String(name || '').trim();
  if (!n) return toast('Inserisci un nome per lo screen', true);
  if (/\s/.test(n)) return toast('Il nome non può contenere spazi', true);
  try {
    toast('Creazione screen…');
    await window.api.screenCreate(tab.id, n);
    if (input) input.value = '';
    toast('Screen creato: ' + n);
    showScreens(tab); // ricarica la lista (senza entrarci)
  } catch (e) {
    toast('Errore creazione screen: ' + e.message, true);
  }
}

/** Entra nello screen nel terminale. `-d -r` lo stacca da eventuali altre
 *  sessioni e lo riattacca qui, evitando l'errore "Attached elsewhere". */
function enterScreen(tab, s) {
  const ov = tab.hostEl.querySelector('.ll-overlay');
  if (ov) ov.remove();
  tab.term.clear();
  tab.term.focus();
  window.api.write(tab.id, `clear && screen -d -r ${shQuote(s.full)}\r`);
  showScreenBar(tab, s.name);
  // rimuove l'eventuale barra in basso lasciata da versioni precedenti
  setTimeout(() => { window.api.screenClearStatus(tab.id, s.full).catch(() => {}); }, 600);
}

/** Mostra l'intestazione "sei dentro lo screen". */
function showScreenBar(tab, name) {
  if (!tab.screenBarEl) return;
  tab.screenBarNameEl.textContent = name;
  tab.screenBarEl.classList.remove('hidden');
  // ignora i marker STY in arrivo subito dopo l'attach (residui della shell esterna)
  tab.screenBarShownAt = Date.now();
  if (tab.fit) setTimeout(() => { tab.fit.fit(); }, 0);
}

/** Nasconde l'intestazione dello screen (siamo tornati alla shell esterna). */
function hideScreenBar(tab) {
  if (!tab.screenBarEl || tab.screenBarEl.classList.contains('hidden')) return;
  tab.screenBarEl.classList.add('hidden');
  if (tab.fit) setTimeout(() => { tab.fit.fit(); }, 0);
}

/** Stacca dallo screen inviando Ctrl-A D al terminale. */
function detachScreen(tab) {
  tab.term.focus();
  window.api.write(tab.id, '\x01d'); // Ctrl-A, poi d
  hideScreenBar(tab);
}

/** Stacca uno screen attaccato (dalla lista). Se era attaccato in questo
 *  terminale, il terminale torna alla shell esterna. */
async function detachScreenRow(tab, s, btn) {
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
  try {
    await window.api.screenDetach(tab.id, s.full);
    toast('Detach effettuato: ' + s.name);
    hideScreenBar(tab); // se era attaccato qui
    showScreens(tab);
  } catch (e) {
    toast('Errore detach: ' + e.message, true);
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

async function killScreen(tab, s, btn) {
  if (!confirm(`Eliminare lo screen "${s.name}"?`)) return;
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
  try {
    toast('Eliminazione screen…');
    await window.api.screenKill(tab.id, s.full);
    toast('Screen eliminato: ' + s.name);
    showScreens(tab);
  } catch (e) {
    toast('Errore eliminazione: ' + e.message, true);
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

// --- Manual Pull ------------------------------------------------------------

let mpOpSeq = 0;
const mpProgressHandlers = new Set();

/** Ripulisce un riferimento immagine incollato (toglie "docker pull " e apici). */
function cleanImageRef(raw) {
  return String(raw || '')
    .trim()
    .replace(/^docker\s+pull\s+/i, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

/** Valida un riferimento immagine con digest: repo[:tag]@sha256:<64hex>. */
function isValidImageRef(s) {
  return /^[\w][\w./-]*(:[\w][\w.-]*)?@sha256:[a-f0-9]{64}$/i.test(s);
}

/** Apre (o richiude) il form inline di Manual Pull sotto la riga dell'immagine.
 *  `targetImage` è l'immagine (dal compose) con cui ritaggare sul remoto. */
function openManualPull(tab, targetImage, anchorRow) {
  const next = anchorRow.nextElementSibling;
  if (next && next.classList.contains('docker-mp')) { next.remove(); return; }

  const box = el('div', 'docker-mp');
  const top = el('div', 'docker-mp-top');
  const icon = el('i', 'fa-solid fa-download');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'docker-mp-input';
  input.placeholder = 'registry/repo:tag@sha256:… — Invio per avviare, Esc per annullare';
  const go = el('button', 'docker-btn d-manual');
  go.innerHTML = '<i class="fa-solid fa-play"></i> Avvia';
  top.appendChild(icon);
  top.appendChild(input);
  top.appendChild(go);

  const status = el('div', 'docker-mp-status');
  status.textContent = `Destinazione retag: ${targetImage}`;
  const bar = el('div', 'docker-mp-bar');
  const fill = el('div', 'docker-mp-fill');
  bar.appendChild(fill);

  box.appendChild(top);
  box.appendChild(status);
  box.appendChild(bar);
  anchorRow.parentNode.insertBefore(box, anchorRow.nextElementSibling);
  input.focus();

  const ui = { box, status, fill, go, input };
  const start = () => startManualPull(tab, targetImage, input.value, ui);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); start(); }
    else if (e.key === 'Escape') { e.preventDefault(); if (!ui.running) box.remove(); }
  });
  go.addEventListener('click', start);
}

async function startManualPull(tab, targetImage, raw, ui) {
  if (ui.running) return;
  const image = cleanImageRef(raw);
  if (!isValidImageRef(image)) {
    ui.status.textContent = 'Riferimento non valido. Atteso: repo:tag@sha256:<digest>';
    ui.status.classList.add('err');
    return;
  }
  ui.status.classList.remove('err');
  ui.input.value = image; // mostra il valore ripulito
  ui.input.disabled = true;
  ui.go.disabled = true;
  ui.running = true;
  ui.box.classList.add('running');

  const opId = 'mp' + (++mpOpSeq);
  const onProg = (p) => {
    if (p.opId !== opId) return;
    if (typeof p.pct === 'number') {
      ui.box.classList.remove('indeterminate');
      ui.fill.style.width = p.pct + '%';
    } else {
      ui.box.classList.add('indeterminate');
    }
    if (p.text) ui.status.textContent = p.text;
  };
  mpProgressHandlers.add(onProg);

  try {
    const res = await window.api.manualPull(tab.id, opId, image, targetImage);
    ui.box.classList.remove('indeterminate');
    ui.fill.style.width = '100%';
    const tag = (res && res.targetImage) || targetImage;
    ui.status.textContent = `Completato — immagine ritaggata come ${tag}`;
    toast('Manual Pull completato: ' + tag);
    showImages(tab); // ricarica lo stato (rimuove il form)
  } catch (e) {
    ui.box.classList.remove('indeterminate', 'running');
    ui.status.textContent = 'Errore: ' + e.message;
    ui.status.classList.add('err');
    ui.input.disabled = false;
    ui.go.disabled = false;
    ui.running = false;
  } finally {
    mpProgressHandlers.delete(onProg);
  }
}

// ============================================================================
// MENU CONTESTUALI
// ============================================================================

function openEntryContextMenu(e, tab, entry, fullPath, cwd) {
  const items = [
    { icon: 'fa-solid fa-file-circle-plus', label: 'Nuovo file', action: () => newFilePrompt(tab, cwd) },
    { icon: 'fa-solid fa-file-import', label: 'Importa', action: () => importLocal(tab, cwd) },
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
      label: 'Modifica',
      action: () => {
        const ov = tab.hostEl.querySelector('.ll-overlay');
        if (ov) ov.remove();
        tab.term.focus();
        window.api.write(tab.id, `sudo nano ${shQuote(fullPath)}\r`);
      },
    });
  }
  // Scarica: disponibile sia per file che per cartelle
  items.push({ icon: 'fa-solid fa-download', label: 'Scarica', action: () => downloadEntry(tab, entry, fullPath) });
  openContextMenu(e.clientX, e.clientY, items);
}

function openTermContextMenu(e, tab) {
  const items = [
    {
      icon: 'fa-solid fa-key',
      label: 'Incolla password',
      disabled: !tab.server.password,
      action: () => {
        // incolla la password e invia ENTER, poi torna sul terminale
        window.api.write(tab.id, tab.server.password + '\r');
        tab.term.focus();
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
  // rendi visibile per misurarne le dimensioni reali, poi posiziona dentro la finestra
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  let left = x, top = y;
  if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
  if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = Math.max(8, top) + 'px';
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
    if (entry.isDir) toast('Download cartella in corso…');
    const saved = await window.api.download(tab.id, fullPath, entry.name, entry.isDir);
    if (saved) toast('Scaricato in: ' + saved);
  } catch (e) { toast('Errore download: ' + e.message, true); }
}

async function importLocal(tab, destDir) {
  try {
    toast('Importazione in corso…');
    const names = await window.api.importLocal(tab.id, destDir);
    if (!names) return; // annullato
    toast(`Importato: ${names.join(', ')}`);
    showListing(tab, destDir);
  } catch (e) { toast('Errore import: ' + e.message, true); }
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

// $STY emesso dalla shell esterna ad ogni prompt: vuoto = fuori dallo screen.
// Quando lo riceviamo vuoto, vuol dire che siamo tornati alla shell → via la barra.
window.api.onSty(({ id, sty }) => {
  const tab = tabs.get(id);
  if (!tab) return;
  if (!sty) {
    // piccola finestra di tolleranza per ignorare i marker residui post-attach
    if (tab.screenBarShownAt && Date.now() - tab.screenBarShownAt < 700) return;
    hideScreenBar(tab);
  }
});

window.api.onPullProgress((p) => {
  mpProgressHandlers.forEach((h) => h(p));
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
  $('#btn-export').addEventListener('click', exportServers);
  $('#btn-import').addEventListener('click', importServers);
  $('#server-search').addEventListener('input', (e) => {
    serverQuery = e.target.value;
    renderServerList();
  });
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

  // focus iniziale sulla barra di ricerca dei server
  $('#server-search').focus();
});

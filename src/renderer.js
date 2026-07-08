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
    if (dest) toast(i18n.t('export_done', { path: dest }));
  } catch (e) {
    toast(i18n.t('export_error', { error: e.message || e }), true);
  }
}

/** Importa un file servers.json, sostituendo la configurazione attuale. */
async function importServers() {
  try {
    const imported = await window.api.importServers();
    if (!imported) return; // annullato
    if (!confirm(i18n.t('import_confirm', { count: imported.length }))) return;
    servers = imported;
    await window.api.saveServers(servers);
    selectedIndex = -1;
    renderServerList();
    $('#server-form').classList.add('hidden');
    $('#form-empty').classList.remove('hidden');
    toast(i18n.t('import_done', { count: imported.length }));
  } catch (e) {
    toast(i18n.t('import_error', { error: e.message || e }), true);
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
    empty.textContent = i18n.t('search_no_results');
    ul.appendChild(empty);
  }
  updateToggleGroupsBtn();
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
  title.textContent = isUngrouped ? i18n.t('group_without_name') : name;
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

/** Nomi di tutti i gruppi presenti (inclusa la sezione "Senza gruppo" se non vuota). */
function allGroupKeys() {
  const keys = [...new Set(servers.map((s) => (s.group || '').trim()).filter(Boolean))];
  if (servers.some((s) => !(s.group || '').trim())) keys.push(UNGROUPED);
  return keys;
}

/** Espande o comprime tutti i gruppi in un colpo solo. */
function toggleAllGroups() {
  const keys = allGroupKeys();
  // se anche un solo gruppo è espanso, l'azione comprime tutto; altrimenti espande tutto
  const anyExpanded = keys.some((k) => !isGroupCollapsed(k));
  keys.forEach((k) => setGroupCollapsed(k, anyExpanded));
  renderServerList();
  updateToggleGroupsBtn();
}

/** Aggiorna icona/etichetta del bottone in base allo stato corrente dei gruppi. */
function updateToggleGroupsBtn() {
  const btn = $('#btn-toggle-groups');
  if (!btn) return;
  const keys = allGroupKeys();
  btn.classList.toggle('hidden', keys.length < 1);
  const anyExpanded = keys.some((k) => !isGroupCollapsed(k));
  // se c'è qualcosa di espanso, il prossimo click comprime (freccia su); altrimenti espande (freccia giù)
  btn.querySelector('i').className = anyExpanded ? 'fa-solid fa-angles-up' : 'fa-solid fa-angles-down';
  btn.title = anyExpanded ? 'Comprimi tutti i gruppi' : 'Espandi tutti i gruppi';
}

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
  // ripristina i campi password come nascosti
  form.querySelectorAll('.btn-eye').forEach((btn) => {
    form[btn.dataset.target].type = 'password';
    btn.querySelector('i').className = 'fa-solid fa-eye';
  });
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
  if (!data.host || !data.username) return toast(i18n.t('host_and_username_required'), true);
  if (selectedIndex >= 0) {
    if (servers[selectedIndex].group) data.group = servers[selectedIndex].group; // preserva il gruppo
    servers[selectedIndex] = data;
  } else { servers.push(data); selectedIndex = servers.length - 1; }
  await window.api.saveServers(servers);
  renderServerList();
  toast(i18n.t('config_saved'));
}

async function deleteServer() {
  if (selectedIndex < 0) return;
  const s = servers[selectedIndex];
  if (!confirm(i18n.t('confirm_delete_server', { nickname: s.nickname }))) return;
  servers.splice(selectedIndex, 1);
  selectedIndex = -1;
  await window.api.saveServers(servers);
  renderServerList();
  $('#server-form').classList.add('hidden');
  $('#form-empty').classList.remove('hidden');
  toast(i18n.t('server_deleted'));
}

async function connectFromForm() {
  // salva implicitamente i campi correnti prima di connettere
  const data = readForm();
  if (!data.host || !data.username) return toast(i18n.t('host_and_username_required'), true);
  await openConnection(data);
}

// ============================================================================
// TERMINAL VIEW
// ============================================================================

function showView(name) {
  $('#config-view').classList.toggle('active', name === 'config');
  $('#settings-view').classList.toggle('active', name === 'settings');
  $('#terminal-view').classList.toggle('active', name === 'terminal');
  // mostra "torna alle sessioni" solo se ci sono schede aperte
  $('#btn-back').classList.toggle('hidden', !(name === 'config' && tabs.size > 0));
  if (name === 'terminal') setTimeout(fitAll, 50);
}

// ---------- Tema (persistito in localStorage) ----------
const DEFAULT_THEME = 'mocha';
function getSavedTheme() {
  return localStorage.getItem('theme') || DEFAULT_THEME;
}
function applyTheme(name) {
  document.documentElement.setAttribute('data-theme', name || DEFAULT_THEME);
  localStorage.setItem('theme', name || DEFAULT_THEME);
  // Allinea i colori dei terminali aperti al tema selezionato
  const theme = buildTerminalTheme();
  tabs.forEach((tab) => { tab.term.options.theme = theme; });
}

// Costruisce il theme di xterm.js leggendo le variabili CSS del tema attivo,
// così il terminale resta coerente con i temi dell'app (mocha, dracula, nord...).
function buildTerminalTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  const bg = v('--bg', '#1e1e2e');
  const text = v('--text', '#cdd6f4');
  const accent = v('--accent', '#89b4fa');
  const green = v('--green', '#a6e3a1');
  const red = v('--red', '#f38ba8');
  const yellow = v('--yellow', '#f9e2af');
  const muted = v('--muted', '#9399b2');
  const border = v('--border', '#313244');
  return {
    background: bg,
    foreground: text,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: border,
    // palette ANSI derivata dai colori del tema
    black: border, red, green, yellow,
    blue: accent, magenta: accent, cyan: green, white: text,
    brightBlack: muted, brightRed: red, brightGreen: green, brightYellow: yellow,
    brightBlue: accent, brightMagenta: accent, brightCyan: green, brightWhite: text,
  };
}

async function openConnection(server) {
  toast(i18n.t('connecting', { host: server.host }));
  let res;
  try {
    res = await window.api.connect(server);
  } catch (e) {
    return toast(i18n.t('connection_error', { error: e.message }), true);
  }
  const id = res.id;

  const term = new Terminal({
    fontFamily: 'SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: buildTerminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const tab = {
    id, server, term, fit,
    cwd: res.cwd || '~',
    paneEl: null, tabEl: null, hostEl: null, cwdEl: null,
    dead: false, inputBuffer: '',
    termState: 'host', // 'host' | 'logs' | 'shell': stato del terminale per i comandi docker
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
      { icon: 'fa-solid fa-clone', label: i18n.t('duplicate_session'), action: () => openConnection(tab.server) },
      { icon: 'fa-solid fa-pen', label: i18n.t('rename_session'), action: () => renameTab(tab.id) },
      { sep: true },
      { icon: 'fa-solid fa-xmark', label: i18n.t('close_session'), action: () => closeTab(tab.id) },
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
  llBtn.title = i18n.t('ll_button_title');
  llBtn.innerHTML = '<i class="fa-solid fa-list"></i>';
  llBtn.addEventListener('click', () => showListing(tab));
  const clearBtn = el('button', 'btn-ll');
  clearBtn.title = i18n.t('clear_button_title');
  clearBtn.innerHTML = '<i class="fa-solid fa-broom"></i>';
  clearBtn.addEventListener('click', () => {
    tab.term.clear();
    window.api.write(tab.id, 'clear\r');
    tab.term.focus();
  });
  const dockerBtn = el('button', 'btn-ll');
  dockerBtn.title = i18n.t('docker_containers_button_title');
  dockerBtn.innerHTML = '<i class="fa-brands fa-docker"></i>';
  dockerBtn.addEventListener('click', () => showDocker(tab));
  const imagesBtn = el('button', 'btn-ll');
  imagesBtn.title = i18n.t('docker_images_button_title');
  imagesBtn.innerHTML = '<i class="fa-solid fa-hard-drive"></i>';
  imagesBtn.addEventListener('click', () => showImages(tab));
  const dbBtn = el('button', 'btn-ll');
  dbBtn.title = i18n.t('db_databases_button_title');
  dbBtn.innerHTML = '<i class="fa-solid fa-database"></i>';
  dbBtn.addEventListener('click', () => showDatabases(tab));
  const screensBtn = el('button', 'btn-ll');
  screensBtn.title = i18n.t('screen_sessions_button_title');
  screensBtn.innerHTML = '<i class="fa-brands fa-buffer"></i>';
  screensBtn.addEventListener('click', () => showScreens(tab));
  const cronBtn = el('button', 'btn-ll');
  cronBtn.title = i18n.t('cron_button_title');
  cronBtn.innerHTML = '<i class="fa-solid fa-clock"></i>';
  cronBtn.addEventListener('click', () => showCrontab(tab));
  const srv = el('span', 'srv-name');
  srv.textContent = tab.server.nickname || tab.server.name;
  const cwd = el('span', 'cwd');
  cwd.textContent = tab.cwd;
  tab.cwdEl = cwd;
  const splitBtn = el('button', 'btn-ll');
  splitBtn.title = i18n.t('split_view_button_title');
  splitBtn.innerHTML = '<i class="fa-solid fa-table-columns"></i>';
  splitBtn.style.marginLeft = 'auto';
  splitBtn.addEventListener('click', () => toggleSplit(tab.id));
  toolbar.appendChild(llBtn);
  toolbar.appendChild(clearBtn);
  toolbar.appendChild(dockerBtn);
  toolbar.appendChild(imagesBtn);
  toolbar.appendChild(dbBtn);
  toolbar.appendChild(screensBtn);
  toolbar.appendChild(cronBtn);
  toolbar.appendChild(srv);
  toolbar.appendChild(cwd);
  toolbar.appendChild(splitBtn);

  // intestazione visibile solo quando si è dentro uno screen
  const screenBar = el('div', 'screen-bar hidden');
  const sbIcon = el('i', 'fa-brands fa-buffer');
  const sbName = el('span', 'screen-bar-name');
  const sbDetach = el('button', 'screen-bar-detach');
  sbDetach.innerHTML = `<i class="fa-solid fa-right-from-bracket"></i> ${i18n.t('screen_detach_button')}`;
  sbDetach.title = i18n.t('screen_detach_button_title');
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
  toast(i18n.t('split_view_active'));
}

/** Attiva/disattiva lo split dal pulsante ⫿: se attivo lo chiude, altrimenti
 *  affianca la prima scheda diversa da quella attiva. */
function toggleSplit(tabId) {
  if (splitTabId) {
    splitTabId = null;
    layout();
    toast(i18n.t('split_view_closed'));
    return;
  }
  if (tabId !== activeTabId) setActive(tabId);
  const other = [...tabs.keys()].find((k) => k !== activeTabId);
  if (!other) return toast(i18n.t('split_min_2_tabs'), true);
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
    return toast(i18n.t('listing_error', { error: e.message }), true);
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
  info.innerHTML = i18n.t('listing_folder_info', { path: escapeHtml(res.cwd), count: res.entries.length });
  const actions = el('span', 'll-head-actions');
  const searchBtn = el('button');
  searchBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i>';
  searchBtn.title = i18n.t('search_folder');
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
  input.placeholder = i18n.t('search_placeholder');
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
      // grep ricorsivo, case-insensitive, con numero di riga, nella cartella corrente
      // (il file browser resta aperto)
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
  input.placeholder = i18n.t('newfile_placeholder');
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
        toast(i18n.t('newfile_created', { name: name }));
        cleanup();
        showListing(tab, cwd);
      } catch (err) { toast(i18n.t('generic_error', { error: err.message }), true); }
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
    // doppio clic su file -> cat automatico (il file browser resta aperto)
    row.addEventListener('dblclick', () => {
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
    toast(i18n.t('listing_loading'));
    containers = await window.api.dockerPs(tab.id);
  } catch (e) {
    return toast(i18n.t('docker_action_error', { action: 'Docker', error: e.message }), true);
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
  info.innerHTML = i18n.t('docker_containers_title', { count: containers.length });
  const actions = el('span', 'll-head-actions');
  const refreshBtn = el('button');
  refreshBtn.innerHTML = '<i class="fa-solid fa-rotate"></i>';
  refreshBtn.title = i18n.t('refresh');
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
    empty.textContent = i18n.t('docker_no_containers');
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
    searchInput.placeholder = i18n.t('docker_filter_containers');
    bar.appendChild(icon);
    bar.appendChild(searchInput);
    overlay.appendChild(bar);
  }

  const blocks = [];
  keys.forEach((key) => {
    const header = el('div', 'docker-group');
    header.innerHTML = key
      ? `<i class="fa-solid fa-folder"></i> ${escapeHtml(key)}`
      : `<i class="fa-solid fa-layer-group"></i> ${i18n.t('group_without_name')}`;
    overlay.appendChild(header);
    const items = groups.get(key).map((c) => {
      const row = makeDockerRow(tab, c);
      overlay.appendChild(row);
      return { text: `${c.name} ${c.image} ${c.status || ''}`.toLowerCase(), row };
    });
    blocks.push({ header, items });
  });

  const noRes = el('div', 'docker-empty');
  noRes.textContent = i18n.t('docker_no_results');
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
        { action: 'logs',    icon: 'fa-file-lines',       label: i18n.t('docker_logs'),    cls: 'd-logs' },
        { action: 'shell',   icon: 'fa-terminal',         label: i18n.t('docker_shell'),   cls: 'd-shell' },
        { action: 'browser', icon: 'fa-globe',            label: i18n.t('docker_browser'), cls: 'd-browser' },
        { action: 'stop',    icon: 'fa-stop',             label: i18n.t('docker_stop'),    cls: 'd-stop' },
        { action: 'restart', icon: 'fa-rotate-right',     label: i18n.t('docker_restart'), cls: 'd-restart' },
        { action: 'down',    icon: 'fa-arrow-down',       label: i18n.t('docker_down'),    cls: 'd-down' },
        { action: 'pull',    icon: 'fa-cloud-arrow-down', label: i18n.t('docker_pull'),    cls: 'd-pull' },
      ]
    : [
        { action: 'up',      icon: 'fa-play',             label: i18n.t('docker_up'),      cls: 'd-up' },
        { action: 'logs',    icon: 'fa-file-lines',       label: i18n.t('docker_logs'),    cls: 'd-logs' },
        { action: 'down',    icon: 'fa-arrow-down',       label: i18n.t('docker_down'),    cls: 'd-down' },
        { action: 'pull',    icon: 'fa-cloud-arrow-down', label: i18n.t('docker_pull'),    cls: 'd-pull' },
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

// ---- Database (PostgreSQL) --------------------------------------------------

async function showDatabases(tab) {
  let groups;
  try {
    toast(i18n.t('listing_databases'));
    groups = await window.api.pgList(tab.id);
  } catch (e) {
    return toast(i18n.t('db_action_error', { error: e.message }), true);
  }

  // riusa lo stesso overlay di docker/file browser
  const old = tab.hostEl.querySelector('.ll-overlay');
  if (old) old.remove();

  const overlay = el('div', 'll-overlay docker-overlay containers-overlay');
  const grip = el('div', 'll-resize');
  overlay.appendChild(grip);
  setupOverlayResize(grip, overlay, tab);
  if (tab.llHeight) { overlay.style.height = tab.llHeight + 'px'; overlay.style.maxHeight = 'none'; }

  const total = groups.reduce((n, g) => n + g.databases.length, 0);

  const head = el('div', 'll-head');
  const info = el('span');
  info.innerHTML = i18n.t('db_databases_title', { count: total });
  const actions = el('span', 'll-head-actions');
  const refreshBtn = el('button');
  refreshBtn.innerHTML = '<i class="fa-solid fa-rotate"></i>';
  refreshBtn.title = i18n.t('refresh');
  refreshBtn.addEventListener('click', () => showDatabases(tab));
  const closeBtn = el('button');
  closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  closeBtn.title = 'Chiudi';
  closeBtn.addEventListener('click', () => overlay.remove());
  actions.appendChild(refreshBtn);
  actions.appendChild(closeBtn);
  head.appendChild(info);
  head.appendChild(actions);
  overlay.appendChild(head);

  if (!total) {
    const empty = el('div', 'docker-empty');
    empty.textContent = i18n.t('db_no_databases');
    overlay.appendChild(empty);
  }

  // barra di ricerca (filtra per nome/proprietario)
  let searchInput = null;
  if (total) {
    const bar = el('div', 'll-search');
    const icon = el('i', 'fa-solid fa-magnifying-glass');
    searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'search-input';
    searchInput.placeholder = i18n.t('db_filter_databases');
    bar.appendChild(icon);
    bar.appendChild(searchInput);
    overlay.appendChild(bar);
  }

  // un blocco per sorgente: host e ogni container Postgres
  const blocks = [];
  groups.forEach((g) => {
    const header = el('div', 'docker-group');
    header.innerHTML = g.source === 'container'
      ? `<i class="fa-brands fa-docker"></i> ${escapeHtml(g.container)}` +
        (g.image ? ` <span class="cwd">${escapeHtml(g.image)}</span>` : '')
      : `<i class="fa-solid fa-server"></i> ${i18n.t('db_host')}`;
    overlay.appendChild(header);
    const items = g.databases.map((d) => {
      const row = makeDbRow(tab, d, g);
      overlay.appendChild(row);
      return { text: `${d.name} ${d.owner}`.toLowerCase(), row };
    });
    blocks.push({ header, items });
  });

  const noRes = el('div', 'docker-empty');
  noRes.textContent = i18n.t('docker_no_results');
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

function makeDbRow(tab, d, group) {
  const row = el('div', 'docker-row');

  const dot = el('span', 'docker-dot on');
  dot.title = d.size || '';
  row.appendChild(dot);

  const meta = el('div', 'docker-meta');
  const name = el('span', 'docker-name');
  name.innerHTML = `<i class="fa-solid fa-database"></i> ${escapeHtml(d.name)}`;
  name.title = d.name;
  const sub = el('span', 'docker-img');
  const parts = [];
  if (d.owner) parts.push(i18n.t('db_owner', { owner: d.owner }));
  if (d.size) parts.push(d.size);
  sub.textContent = parts.join(' · ');
  sub.title = sub.textContent;
  meta.appendChild(name);
  meta.appendChild(sub);

  const btns = el('div', 'docker-actions');
  const consoleBtn = el('button', 'docker-btn d-shell');
  consoleBtn.innerHTML = `<i class="fa-solid fa-terminal"></i><span class="lbl">${i18n.t('db_console')}</span>`;
  consoleBtn.title = `${i18n.t('db_console')} ${d.name}`;
  consoleBtn.addEventListener('click', () => openPsql(tab, d, group));
  btns.appendChild(consoleBtn);

  const dumpBtn = el('button', 'docker-btn d-logs');
  dumpBtn.innerHTML = `<i class="fa-solid fa-download"></i><span class="lbl">${i18n.t('db_dump')}</span>`;
  dumpBtn.title = `${i18n.t('db_dump')} ${d.name}`;
  dumpBtn.addEventListener('click', () => dbDump(tab, d, group, dumpBtn));
  btns.appendChild(dumpBtn);

  const restoreBtn = el('button', 'docker-btn d-pull');
  restoreBtn.innerHTML = `<i class="fa-solid fa-upload"></i><span class="lbl">${i18n.t('db_restore')}</span>`;
  restoreBtn.title = `${i18n.t('db_restore')} ${d.name}`;
  restoreBtn.addEventListener('click', () => dbRestore(tab, d, group, restoreBtn));
  btns.appendChild(restoreBtn);

  row.appendChild(meta);
  row.appendChild(btns);
  return row;
}

/** Esegue il dump (custom, struttura + dati) del database in un file locale scelto,
 *  mostrando una barra di avanzamento sotto la riga (come il Manual Pull). */
async function dbDump(tab, d, group, btn) {
  const localPath = await window.api.pgDumpPick(d.name);
  if (!localPath) return; // scelta annullata

  // box di avanzamento sotto la riga del database (riusa lo stile docker-mp)
  const row = btn.closest('.docker-row');
  const next = row && row.nextElementSibling;
  if (next && next.classList.contains('docker-mp')) next.remove();
  const box = el('div', 'docker-mp running indeterminate');
  const status = el('div', 'docker-mp-status');
  status.textContent = i18n.t('db_dump_running', { name: d.name });
  const bar = el('div', 'docker-mp-bar');
  const fill = el('div', 'docker-mp-fill');
  bar.appendChild(fill);
  box.appendChild(status);
  box.appendChild(bar);
  if (row) row.parentNode.insertBefore(box, row.nextElementSibling);

  btn.disabled = true;
  const opId = 'dump' + (++pgOpSeq);
  const onProg = (p) => {
    if (p.opId !== opId) return;
    if (typeof p.pct === 'number') {
      box.classList.remove('indeterminate');
      fill.style.width = p.pct + '%';
    } else {
      box.classList.add('indeterminate');
    }
    if (p.text) status.textContent = p.text;
  };
  pgProgressHandlers.add(onProg);

  try {
    await window.api.pgDumpRun(tab.id, opId, group, d.name, localPath);
    box.classList.remove('indeterminate');
    fill.style.width = '100%';
    status.textContent = i18n.t('db_dump_done', { name: d.name });
    toast(i18n.t('db_dump_done', { name: d.name }));
    setTimeout(() => box.remove(), 4000);
  } catch (e) {
    box.classList.remove('indeterminate', 'running');
    status.textContent = i18n.t('db_action_error', { error: e.message });
    status.classList.add('err');
    toast(i18n.t('db_action_error', { error: e.message }), true);
  } finally {
    btn.disabled = false;
    pgProgressHandlers.delete(onProg);
  }
}

/** Ripristina un dump scelto dal disco nel database selezionato (sovrascrive). */
async function dbRestore(tab, d, group, btn) {
  const localPath = await window.api.pgRestorePick();
  if (!localPath) return; // scelta annullata
  if (!confirm(i18n.t('confirm_db_restore', { name: d.name }))) return;
  btn.disabled = true;
  toast(i18n.t('db_restore_running', { name: d.name }));
  try {
    await window.api.pgRestoreRun(tab.id, group, d.name, localPath);
    toast(i18n.t('db_restore_done', { name: d.name }));
  } catch (e) {
    toast(i18n.t('db_action_error', { error: e.message }), true);
  } finally {
    btn.disabled = false;
  }
}

/**
 * Apre una console psql sul database scelto, nel terminale della scheda.
 * Per i database dentro un container si usa `docker exec -it … psql`,
 * altrimenti si accede come utente di sistema `postgres` sull'host.
 */
function openPsql(tab, d, group) {
  const ov = tab.hostEl.querySelector('.ll-overlay');
  if (ov) ov.remove();
  tab.term.focus();
  const wait = returnToHostShell(tab); // esci da eventuali log/shell aperti
  const run = () => {
    tab.term.clear();
    const cmd = group && group.source === 'container'
      ? `docker exec -it ${shQuote(group.container)} psql -U ${shQuote(group.user || 'postgres')} -d ${shQuote(d.name)}`
      : `sudo -u postgres psql -d ${shQuote(d.name)}`;
    window.api.write(tab.id, `clear && ${cmd}\r`);
    tab.termState = 'shell'; // \q o exit riportano alla shell host
  };
  wait ? setTimeout(run, wait) : run();
}

/**
 * Riporta il terminale alla shell host prima di lanciare un comando docker
 * interattivo. Se stiamo seguendo dei log (logs -f) manda Ctrl+C; se siamo
 * dentro la shell di un container manda `exit`. Lo stato torna a 'host' appena
 * la shell host stampa un nuovo prompt (marker CWD gestito in onCwd), quindi
 * un'uscita manuale dell'utente non provoca un `exit` di troppo (che chiuderebbe
 * la sessione SSH). Ritorna i ms di attesa consigliati prima del comando dopo.
 */
function returnToHostShell(tab) {
  if (tab.termState === 'logs') {
    window.api.write(tab.id, '\x03'); // Ctrl+C: interrompe il follow dei log
    tab.termState = 'host';
    return 150;
  }
  if (tab.termState === 'shell') {
    window.api.write(tab.id, 'exit\r'); // esce dalla shell del container
    tab.termState = 'host';
    return 250;
  }
  return 0;
}

async function dockerAction(tab, action, c, btn) {
  // i log vanno mostrati live nel terminale (come cat/grep)
  if (action === 'logs') {
    const ov = tab.hostEl.querySelector('.ll-overlay');
    if (ov) ov.remove();
    tab.term.focus();
    const follow = c.running ? '-f ' : '';
    const wait = returnToHostShell(tab); // esci da log/shell aperti in precedenza
    const run = () => {
      window.api.write(tab.id, `docker logs --tail 200 ${follow}${shQuote(c.id)}\r`);
      if (follow) tab.termState = 'logs'; // il follow blocca il prompt finché non si esce
    };
    wait ? setTimeout(run, wait) : run();
    return;
  }

  // Shell: entra nel container nel terminale (docker exec -it ... bash/sh)
  if (action === 'shell') {
    const ov = tab.hostEl.querySelector('.ll-overlay');
    if (ov) ov.remove();
    tab.term.focus();
    const wait = returnToHostShell(tab); // esci da log/shell aperti in precedenza
    const run = () => {
      tab.term.clear(); // pulisce lo scrollback prima di entrare
      const inner = 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi';
      window.api.write(tab.id, `clear && docker exec -it ${shQuote(c.name)} sh -c ${shQuote(inner)}\r`);
      tab.termState = 'shell'; // ora siamo dentro al container
    };
    wait ? setTimeout(run, wait) : run();
    return;
  }

  // Browser: apre la porta esposta dal container nel browser di sistema
  if (action === 'browser') {
    openContainerBrowser(tab, c, btn);
    return;
  }

  const labels = {
    up: i18n.t('docker_up'),
    stop: i18n.t('docker_stop'),
    restart: i18n.t('docker_restart'),
    down: i18n.t('docker_down'),
    pull: i18n.t('docker_pull'),
  };
  if (action === 'down' && !confirm(i18n.t('confirm_docker_down', { name: c.name }))) return;

  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
  try {
    toast(i18n.t('docker_action_loading', { action: labels[action], name: c.name }));
    await window.api.dockerAction(tab.id, action, c);
    toast(i18n.t('docker_action_done', { action: labels[action], name: c.name }));
    showDocker(tab); // ricarica lo stato
  } catch (e) {
    toast(i18n.t('docker_action_error', { action: labels[action], error: e.message }), true);
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

/** Apre nel browser di sistema la porta esposta dal container (http://host:porta). */
function openContainerBrowser(tab, c, btn) {
  const ports = c.ports || [];
  if (!ports.length) return toast(i18n.t('docker_no_ports'), true);
  const host = tab.server.host;
  const open = (p) => window.api.openExternal(`http://${host}:${p}`);
  if (ports.length === 1) return open(ports[0]);
  // più porte: menu di scelta accanto al pulsante
  const rect = btn ? btn.getBoundingClientRect() : { left: 100, bottom: 100 };
  openContextMenu(rect.left, rect.bottom, ports.map((p) => ({
    icon: 'fa-solid fa-globe',
    label: i18n.t('docker_port_label', { port: p }),
    action: () => open(p),
  })));
}

// ============================================================================
// IMMAGINI DOCKER
// ============================================================================

async function showImages(tab) {
  let composeImgs, localImgs;
  try {
    toast(i18n.t('listing_loading'));
    [composeImgs, localImgs] = await Promise.all([
      window.api.composeImages(tab.id),
      window.api.listImages(tab.id),
    ]);
  } catch (e) {
    return toast(i18n.t('docker_action_error', { action: 'Immagini', error: e.message }), true);
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
  info.innerHTML = i18n.t('docker_images_title');
  const actions = el('span', 'll-head-actions');
  const refreshBtn = el('button');
  refreshBtn.innerHTML = '<i class="fa-solid fa-rotate"></i>';
  refreshBtn.title = i18n.t('refresh');
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
  const g1 = makeCollapsibleHeader(i18n.t('docker_images_in_compose', { count: composeImgs.length }));
  overlay.appendChild(g1.header);
  const s1 = buildImageSection(
    composeImgs.map((it) => ({ text: it.image, row: makeComposeImageRow(tab, it.image) })),
    i18n.t('docker_no_images')
  );
  overlay.appendChild(s1.section);
  g1.attach(s1.section, true);

  // --- Sezione 2: immagini presenti (docker images, espansa) ---
  const g2 = makeCollapsibleHeader(i18n.t('docker_images_available', { count: localImgs.length }));
  overlay.appendChild(g2.header);
  const s2 = buildImageSection(
    localImgs.map((img) => ({
      text: `${img.ref || `${img.repo}:${img.tag}`} ${img.id || ''}`,
      row: makeLocalImageRow(tab, img),
    })),
    i18n.t('docker_images_none_available')
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
  input.placeholder = i18n.t('docker_filter_images');
  bar.appendChild(icon);
  bar.appendChild(input);
  section.appendChild(bar);

  const list = el('div', 'img-list');
  items.forEach((it) => list.appendChild(it.row));
  section.appendChild(list);

  const noRes = el('div', 'docker-empty');
  noRes.textContent = i18n.t('docker_no_results');
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
  pullBtn.innerHTML = `<i class="fa-solid fa-cloud-arrow-down"></i> ${i18n.t('docker_pull')}`;
  pullBtn.title = i18n.t('docker_pull') + ' ' + image;
  pullBtn.addEventListener('click', () => imageAction(tab, 'pull', { ref: image }, pullBtn));
  const manualBtn = el('button', 'docker-btn d-manual');
  manualBtn.innerHTML = `<i class="fa-solid fa-download"></i> ${i18n.t('docker_manual_pull')}`;
  manualBtn.title = i18n.t('docker_manual_pull_title', { image: image });
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
  pullBtn.innerHTML = `<i class="fa-solid fa-cloud-arrow-down"></i> ${i18n.t('docker_pull')}`;
  if (img.ref) {
    pullBtn.title = i18n.t('docker_pull') + ' ' + img.ref;
    pullBtn.addEventListener('click', () => imageAction(tab, 'pull', img, pullBtn));
  } else {
    pullBtn.disabled = true;
    pullBtn.title = i18n.t('docker_pull_not_available');
  }
  const delBtn = el('button', 'docker-btn d-down');
  delBtn.innerHTML = `<i class="fa-solid fa-trash"></i> ${i18n.t('docker_delete_image')}`;
  delBtn.title = i18n.t('docker_delete_image');
  delBtn.addEventListener('click', () => imageAction(tab, 'delete', img, delBtn));
  btns.appendChild(pullBtn);
  btns.appendChild(delBtn);

  row.appendChild(meta);
  row.appendChild(btns);
  return row;
}

async function imageAction(tab, action, img, btn) {
  const labels = {
    pull: i18n.t('docker_pull'),
    delete: i18n.t('docker_delete_image'),
  };
  const name = img.ref || img.id || '';
  if (action === 'delete' && !confirm(i18n.t('confirm_delete_image', { name: name }))) return;

  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
  try {
    toast(i18n.t('docker_action_loading', { action: labels[action], name: name }));
    await window.api.imageAction(tab.id, action, img);
    toast(i18n.t('docker_action_done', { action: labels[action], name: name }));
    showImages(tab);
  } catch (e) {
    toast(i18n.t('docker_action_error', { action: labels[action], error: e.message }), true);
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

// ============================================================================
// SCREEN (GNU screen)
// ============================================================================

async function showScreens(tab) {
  let screens;
  try {
    toast(i18n.t('listing_loading'));
    screens = await window.api.screenList(tab.id);
  } catch (e) {
    return toast(i18n.t('docker_action_error', { action: 'Screen', error: e.message }), true);
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
  info.innerHTML = i18n.t('screen_sessions_title', { count: screens.length });
  const actions = el('span', 'll-head-actions');
  const detachBtn = el('button');
  detachBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i>';
  detachBtn.title = i18n.t('screen_detach_all');
  detachBtn.addEventListener('click', () => {
    overlay.remove();
    tab.term.focus();
    window.api.write(tab.id, '\x01d'); // Ctrl-A, poi d
    setTimeout(() => showScreens(tab), 400);
  });
  const refreshBtn = el('button');
  refreshBtn.innerHTML = '<i class="fa-solid fa-rotate"></i>';
  refreshBtn.title = i18n.t('refresh');
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
  newInput.placeholder = i18n.t('screen_create_placeholder');
  const createBtn = el('button', 'docker-btn d-up');
  createBtn.innerHTML = `<i class="fa-solid fa-plus"></i> ${i18n.t('screen_create_button')}`;
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
    empty.textContent = i18n.t('screen_no_sessions');
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
  enterBtn.innerHTML = `<i class="fa-solid fa-right-to-bracket"></i> ${i18n.t('screen_enter')}`;
  enterBtn.title = i18n.t('screen_enter') + ' ' + s.name;
  enterBtn.addEventListener('click', () => enterScreen(tab, s));
  const delBtn = el('button', 'docker-btn d-down');
  delBtn.innerHTML = `<i class="fa-solid fa-trash"></i> ${i18n.t('screen_kill')}`;
  delBtn.title = i18n.t('screen_kill') + ' ' + s.name;
  delBtn.addEventListener('click', () => killScreen(tab, s, delBtn));
  btns.appendChild(enterBtn);
  // il detach ha senso solo se lo screen è attualmente attaccato
  if (attached) {
    const detBtn = el('button', 'docker-btn d-stop');
    detBtn.innerHTML = `<i class="fa-solid fa-right-from-bracket"></i> ${i18n.t('screen_detach')}`;
    detBtn.title = i18n.t('screen_detach') + ' ' + s.name;
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
  if (!n) return toast(i18n.t('generic_error', { error: 'nome' }), true);
  if (/\s/.test(n)) return toast(i18n.t('screen_invalid_name'), true);
  try {
    toast(i18n.t('screen_creating'));
    await window.api.screenCreate(tab.id, n);
    if (input) input.value = '';
    toast(i18n.t('screen_created', { name: n }));
    showScreens(tab); // ricarica la lista (senza entrarci)
  } catch (e) {
    toast(i18n.t('screen_create_error', { error: e.message }), true);
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
    toast(i18n.t('screen_detach_done', { name: s.name }));
    hideScreenBar(tab); // se era attaccato qui
    showScreens(tab);
  } catch (e) {
    toast(i18n.t('screen_detach_error', { error: e.message }), true);
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

async function killScreen(tab, s, btn) {
  if (!confirm(i18n.t('confirm_delete_screen', { name: s.name }))) return;
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
  try {
    toast(i18n.t('listing_loading'));
    await window.api.screenKill(tab.id, s.full);
    toast(i18n.t('screen_deleted', { name: s.name }));
    showScreens(tab);
  } catch (e) {
    toast(i18n.t('screen_delete_error', { error: e.message }), true);
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

// ============================================================================
// CRONTAB (root, via sudo)
// ============================================================================

// riga cron: schedule (@keyword oppure 5 campi) + comando
const CRON_LINE_RE = /^(@\w+|(?:\S+\s+){4}\S+)\s+(.+)$/;

/** True se la stringa ha la forma di una pianificazione cron valida. */
function looksLikeCronSchedule(s) {
  const t = String(s).trim();
  if (/^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)$/i.test(t)) return true;
  const fields = t.split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f) => /^[\dA-Za-z*\/,-]+$/.test(f)) && fields.some((f) => /[\d*]/.test(f));
}

/**
 * Analizza il testo del crontab. Ritorna { lines, jobs }: `lines` sono le righe
 * grezze (per riscrivere il file preservando commenti e variabili), `jobs` le
 * voci riconosciute come job cron — attive, oppure commentate = "in pausa".
 */
// righe d'esempio dei crontab di default delle distro: da non mostrare mai
const CRON_EXAMPLE_MARKER = '/var/backups/home.tgz';

function parseCrontab(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const jobs = [];
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    if (line.includes(CRON_EXAMPLE_MARKER)) return;
    if (line.startsWith('#')) {
      const inner = line.replace(/^#+\s*/, '');
      const m = inner.match(CRON_LINE_RE);
      if (m && looksLikeCronSchedule(m[1])) {
        jobs.push({ idx, schedule: m[1].trim(), command: m[2].trim(), paused: true });
      }
      return;
    }
    if (/^\w+\s*=/.test(line)) return; // variabile d'ambiente (PATH=, MAILTO=…)
    const m = line.match(CRON_LINE_RE);
    if (m && looksLikeCronSchedule(m[1])) {
      jobs.push({ idx, schedule: m[1].trim(), command: m[2].trim(), paused: false });
    }
  });
  return { lines, jobs };
}

/** Nome (tradotto) del giorno della settimana cron: 0/7 = domenica. */
function cronDayName(n) {
  return i18n.t('cron_day_' + (Number(n) % 7));
}

/** Descrizione human-readable di una pianificazione cron (fallback: la stringa grezza). */
function humanizeCron(schedule) {
  const s = String(schedule).trim();
  const kw = {
    '@reboot': 'cron_at_reboot',
    '@hourly': 'cron_every_hour',
    '@daily': 'cron_every_day',
    '@midnight': 'cron_every_day',
    '@weekly': 'cron_every_week',
    '@monthly': 'cron_every_month',
    '@yearly': 'cron_every_year',
    '@annually': 'cron_every_year',
  };
  if (kw[s.toLowerCase()]) return i18n.t(kw[s.toLowerCase()]);

  const f = s.split(/\s+/);
  if (f.length !== 5) return s;
  const [min, hour, dom, mon, dow] = f;
  const num = (x) => /^\d+$/.test(x);
  const time = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  let m;

  // i mesi ristretti non hanno una forma leggibile: si mostra l'espressione grezza
  if (mon !== '*') return s;

  // suffisso per il giorno della settimana: singolo, intervallo (1-5) o lista (1,3,5)
  let dowSuffix = null;
  if (dow === '*') dowSuffix = '';
  else if (num(dow)) dowSuffix = ' (' + cronDayName(dow) + ')';
  else if ((m = dow.match(/^(\d+)-(\d+)$/)))
    dowSuffix = ' ' + i18n.t('cron_on_days_range', { from: cronDayName(m[1]), to: cronDayName(m[2]) });
  else if (/^\d+(,\d+)+$/.test(dow))
    dowSuffix = ' (' + dow.split(',').map(cronDayName).join(', ') + ')';
  if (dowSuffix === null) return s;

  // suffisso per la fascia oraria (es. 6-20)
  const hourRange = hour.match(/^(\d+)-(\d+)$/);
  const hourSuffix = hourRange
    ? ' ' + i18n.t('cron_between_hours', { from: hourRange[1], to: hourRange[2] })
    : '';

  const numList = (x) => /^\d+(,\d+)+$/.test(x);

  // pattern basati sul minuto, validi con ora piena o fascia oraria
  if ((hour === '*' || hourRange) && dom === '*' && mon === '*') {
    let base = null;
    if (min === '*') base = i18n.t('cron_every_minute');
    else if ((m = min.match(/^\*\/(\d+)$/))) base = i18n.t('cron_every_n_minutes', { n: m[1] });
    else if (num(min)) base = i18n.t('cron_every_hour_at', { m: min });
    else if (numList(min)) base = i18n.t('cron_every_hour_at', { m: min.split(',').join(', ') });
    if (base) return base + hourSuffix + dowSuffix;
  }

  if (num(min) && (m = hour.match(/^\*\/(\d+)$/)) && dom === '*' && mon === '*')
    return i18n.t('cron_every_n_hours', { n: m[1], m: min }) + dowSuffix;
  // lista di ore (es. 4,13,20): un'esecuzione al giorno per ciascun orario
  if (num(min) && numList(hour) && dom === '*' && mon === '*') {
    const times = hour.split(',').map((h) => time(h, min)).join(', ');
    return i18n.t('cron_every_day_at', { time: times }) + dowSuffix;
  }
  if (num(min) && num(hour) && dom === '*' && mon === '*') {
    if (num(dow)) return i18n.t('cron_every_week_at', { day: cronDayName(dow), time: time(hour, min) });
    if (dowSuffix) return i18n.t('cron_every_day_at', { time: time(hour, min) }) + dowSuffix;
    return i18n.t('cron_every_day_at', { time: time(hour, min) });
  }
  if (num(min) && num(hour) && num(dom) && mon === '*' && dow === '*')
    return i18n.t('cron_every_month_at', { d: dom, time: time(hour, min) });
  return s;
}

async function showCrontab(tab) {
  let text;
  try {
    toast(i18n.t('listing_loading'));
    text = await window.api.cronRead(tab.id);
  } catch (e) {
    return toast(i18n.t('cron_error', { error: e.message }), true);
  }
  const { lines, jobs } = parseCrontab(text);

  const old = tab.hostEl.querySelector('.ll-overlay');
  if (old) old.remove();

  const overlay = el('div', 'll-overlay docker-overlay');
  const grip = el('div', 'll-resize');
  overlay.appendChild(grip);
  setupOverlayResize(grip, overlay, tab);
  if (tab.llHeight) { overlay.style.height = tab.llHeight + 'px'; overlay.style.maxHeight = 'none'; }

  const head = el('div', 'll-head');
  const info = el('span');
  info.innerHTML = i18n.t('cron_title', { count: jobs.length });
  const actions = el('span', 'll-head-actions');
  const addBtn = el('button');
  addBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
  addBtn.title = i18n.t('cron_add_button');
  addBtn.addEventListener('click', () => {
    const existing = overlay.querySelector('.cron-form');
    if (existing) { existing.remove(); return; }
    const form = makeCronForm(tab, lines, null);
    overlay.insertBefore(form, head.nextElementSibling);
  });
  const refreshBtn = el('button');
  refreshBtn.innerHTML = '<i class="fa-solid fa-rotate"></i>';
  refreshBtn.title = i18n.t('refresh');
  refreshBtn.addEventListener('click', () => showCrontab(tab));
  const closeBtn = el('button');
  closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  closeBtn.title = 'Chiudi';
  closeBtn.addEventListener('click', () => overlay.remove());
  actions.appendChild(addBtn);
  actions.appendChild(refreshBtn);
  actions.appendChild(closeBtn);
  head.appendChild(info);
  head.appendChild(actions);
  overlay.appendChild(head);

  if (!jobs.length) {
    const empty = el('div', 'docker-empty');
    empty.textContent = i18n.t('cron_no_jobs');
    overlay.appendChild(empty);
  } else {
    jobs.forEach((job) => overlay.appendChild(makeCronRow(tab, job, lines)));
  }

  tab.hostEl.appendChild(overlay);
}

function makeCronRow(tab, job, lines) {
  const row = el('div', 'docker-row' + (job.paused ? ' stopped' : ''));

  const dot = el('span', 'docker-dot' + (job.paused ? '' : ' on'));
  dot.title = job.paused ? i18n.t('cron_paused_label') : humanizeCron(job.schedule);
  row.appendChild(dot);

  const meta = el('div', 'docker-meta');
  const name = el('span', 'docker-name');
  const ico = el('i', 'fa-solid fa-clock');
  name.appendChild(ico);
  name.appendChild(document.createTextNode(' '));
  appendCronCommand(tab, name, job.command);
  name.title = job.command;
  const sub = el('span', 'docker-img');
  const human = humanizeCron(job.schedule);
  sub.textContent = [
    human !== job.schedule ? human : null,
    job.schedule,
    job.paused ? i18n.t('cron_paused_label') : null,
  ].filter(Boolean).join(' · ');
  sub.title = sub.textContent;
  meta.appendChild(name);
  meta.appendChild(sub);

  const btns = el('div', 'docker-actions');

  const pauseBtn = el('button', 'docker-btn ' + (job.paused ? 'd-up' : 'd-stop'));
  pauseBtn.innerHTML = job.paused
    ? `<i class="fa-solid fa-play"></i><span class="lbl">${i18n.t('cron_resume')}</span>`
    : `<i class="fa-solid fa-pause"></i><span class="lbl">${i18n.t('cron_pause')}</span>`;
  pauseBtn.title = job.paused ? i18n.t('cron_resume') : i18n.t('cron_pause');
  pauseBtn.addEventListener('click', () => toggleCronPause(tab, job, lines, pauseBtn));
  btns.appendChild(pauseBtn);

  const editBtn = el('button', 'docker-btn d-restart');
  editBtn.innerHTML = `<i class="fa-solid fa-pen"></i><span class="lbl">${i18n.t('cron_edit')}</span>`;
  editBtn.title = i18n.t('cron_edit');
  editBtn.addEventListener('click', () => {
    const next = row.nextElementSibling;
    if (next && next.classList.contains('cron-form')) { next.remove(); return; }
    const form = makeCronForm(tab, lines, job);
    row.parentNode.insertBefore(form, row.nextElementSibling);
  });
  btns.appendChild(editBtn);

  const delBtn = el('button', 'docker-btn d-down');
  delBtn.innerHTML = `<i class="fa-solid fa-trash"></i><span class="lbl">${i18n.t('cron_delete')}</span>`;
  delBtn.title = i18n.t('cron_delete');
  delBtn.addEventListener('click', () => deleteCron(tab, job, lines, delBtn));
  btns.appendChild(delBtn);

  row.appendChild(meta);
  row.appendChild(btns);
  return row;
}

// percorsi assoluti che sembrano script: cliccabili, aprono l'editor embeddato
const CRON_SCRIPT_RE = /\/(?:[^\s;|&<>'"]+\/)*[^\s;|&<>'"]+\.(?:sh|bash|py|pl|rb|php|js|mjs|cjs)\b/g;

/** Rende il comando nel container, con gli script come link cliccabili. */
function appendCronCommand(tab, container, command) {
  let last = 0;
  for (const m of command.matchAll(CRON_SCRIPT_RE)) {
    if (m.index > last) container.appendChild(document.createTextNode(command.slice(last, m.index)));
    const path = m[0];
    const link = el('span', 'cron-link');
    link.textContent = path;
    link.title = i18n.t('cron_open_script', { path: path });
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = path.split('/').pop();
      openEmbeddedEditor(tab, { name }, path);
    });
    container.appendChild(link);
    last = m.index + path.length;
  }
  if (last < command.length) container.appendChild(document.createTextNode(command.slice(last)));
}

/** Riscrive l'intero crontab a partire dalle righe e ricarica la lista. */
async function saveCrontabLines(tab, lines) {
  await window.api.cronWrite(tab.id, lines.join('\n'));
  toast(i18n.t('cron_saved'));
  showCrontab(tab);
}

/** Mette in pausa (commenta) o riattiva (scommenta) un job. */
async function toggleCronPause(tab, job, lines, btn) {
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
  try {
    lines[job.idx] = job.paused
      ? `${job.schedule} ${job.command}`
      : `# ${job.schedule} ${job.command}`;
    await saveCrontabLines(tab, lines);
  } catch (e) {
    toast(i18n.t('cron_error', { error: e.message }), true);
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

async function deleteCron(tab, job, lines, btn) {
  if (!confirm(i18n.t('confirm_delete_cron', { command: job.command }))) return;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
  try {
    lines.splice(job.idx, 1);
    await saveCrontabLines(tab, lines);
  } catch (e) {
    toast(i18n.t('cron_error', { error: e.message }), true);
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

/**
 * Prova a ricondurre una pianificazione cron a uno dei preset del form.
 * Ritorna { freq, ...valori } oppure { freq: 'custom', raw } se non riconosciuta.
 */
function cronToPreset(schedule) {
  const f = String(schedule).trim().split(/\s+/);
  if (f.length !== 5) return { freq: 'custom', raw: schedule };
  const [min, hour, dom, mon, dow] = f;
  const num = (x) => /^\d+$/.test(x);
  let m;
  if ((m = min.match(/^\*\/(\d+)$/)) && hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return { freq: 'minutes', n: +m[1] };
  if (num(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return { freq: 'hourly', min: +min };
  if (num(min) && num(hour) && dom === '*' && mon === '*' && dow === '*')
    return { freq: 'daily', min: +min, hour: +hour };
  if (num(min) && num(hour) && dom === '*' && mon === '*' && num(dow))
    return { freq: 'weekly', min: +min, hour: +hour, dow: +dow % 7 };
  if (num(min) && num(hour) && num(dom) && mon === '*' && dow === '*')
    return { freq: 'monthly', min: +min, hour: +hour, dom: +dom };
  return { freq: 'custom', raw: schedule };
}

/**
 * Form inline (stile Manual Pull) per creare o modificare un job cron.
 * `job` = null per una nuova voce. Frequenze human-readable + modalità custom.
 */
function makeCronForm(tab, lines, job) {
  const box = el('div', 'docker-mp cron-form');

  // --- riga frequenza ---
  const freqRow = el('div', 'cron-form-row');
  const freqLbl = el('span', 'cron-form-label');
  freqLbl.textContent = i18n.t('cron_freq_label');
  const freqSel = document.createElement('select');
  freqSel.className = 'cron-select';
  [
    ['minutes', i18n.t('cron_freq_minutes')],
    ['hourly', i18n.t('cron_freq_hourly')],
    ['daily', i18n.t('cron_freq_daily')],
    ['weekly', i18n.t('cron_freq_weekly')],
    ['monthly', i18n.t('cron_freq_monthly')],
    ['custom', i18n.t('cron_freq_custom')],
  ].forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    freqSel.appendChild(o);
  });
  const params = el('span', 'cron-form-params');
  freqRow.appendChild(freqLbl);
  freqRow.appendChild(freqSel);
  freqRow.appendChild(params);
  box.appendChild(freqRow);

  // --- riga comando ---
  const cmdRow = el('div', 'cron-form-row');
  const cmdIcon = el('i', 'fa-solid fa-terminal');
  const cmdInput = document.createElement('input');
  cmdInput.type = 'text';
  cmdInput.className = 'docker-mp-input';
  cmdInput.placeholder = i18n.t('cron_command_placeholder');
  const saveBtn = el('button', 'docker-btn d-up');
  saveBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> ${i18n.t('cron_save')}`;
  cmdRow.appendChild(cmdIcon);
  cmdRow.appendChild(cmdInput);
  cmdRow.appendChild(saveBtn);
  box.appendChild(cmdRow);

  const status = el('div', 'docker-mp-status');
  box.appendChild(status);

  // input dinamici per i parametri della frequenza scelta
  const mkNum = (value, min, max, width) => {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'cron-num';
    inp.min = min; inp.max = max; inp.value = value;
    if (width) inp.style.width = width;
    return inp;
  };
  const mkTime = (h, m) => {
    const inp = document.createElement('input');
    inp.type = 'time';
    inp.className = 'cron-time';
    inp.value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    return inp;
  };
  const mkText = (value, placeholder) => {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'docker-mp-input cron-raw';
    inp.value = value || '';
    inp.placeholder = placeholder;
    return inp;
  };
  const mkLabel = (key) => {
    const s = el('span', 'cron-form-hint');
    s.textContent = i18n.t(key);
    return s;
  };

  const preset = job ? cronToPreset(job.schedule) : { freq: 'daily', hour: 0, min: 0 };
  const fields = {};

  const renderParams = (freq) => {
    params.innerHTML = '';
    if (freq === 'minutes') {
      fields.n = mkNum(preset.n || 5, 1, 59, '64px');
      params.appendChild(mkLabel('cron_every_label'));
      params.appendChild(fields.n);
      params.appendChild(mkLabel('cron_minutes_suffix'));
    } else if (freq === 'hourly') {
      fields.min = mkNum(preset.min || 0, 0, 59, '64px');
      params.appendChild(mkLabel('cron_at_minute'));
      params.appendChild(fields.min);
    } else if (freq === 'daily') {
      fields.time = mkTime(preset.hour ?? 0, preset.min ?? 0);
      params.appendChild(mkLabel('cron_at_time'));
      params.appendChild(fields.time);
    } else if (freq === 'weekly') {
      fields.dow = document.createElement('select');
      fields.dow.className = 'cron-select';
      for (let d = 0; d < 7; d++) {
        const o = document.createElement('option');
        o.value = d;
        o.textContent = cronDayName(d);
        fields.dow.appendChild(o);
      }
      fields.dow.value = preset.dow ?? 1;
      fields.time = mkTime(preset.hour ?? 0, preset.min ?? 0);
      params.appendChild(fields.dow);
      params.appendChild(mkLabel('cron_at_time'));
      params.appendChild(fields.time);
    } else if (freq === 'monthly') {
      fields.dom = mkNum(preset.dom || 1, 1, 31, '64px');
      fields.time = mkTime(preset.hour ?? 0, preset.min ?? 0);
      params.appendChild(mkLabel('cron_on_day'));
      params.appendChild(fields.dom);
      params.appendChild(mkLabel('cron_at_time'));
      params.appendChild(fields.time);
    } else { // custom
      fields.raw = mkText(preset.raw || (job && job.schedule) || '', i18n.t('cron_custom_placeholder'));
      params.appendChild(fields.raw);
    }
  };

  freqSel.value = preset.freq;
  renderParams(preset.freq);
  freqSel.addEventListener('change', () => renderParams(freqSel.value));
  if (job) cmdInput.value = job.command;

  const buildSchedule = () => {
    const freq = freqSel.value;
    const t = () => {
      const [h, m] = (fields.time.value || '00:00').split(':');
      return { h: +h, m: +m };
    };
    if (freq === 'minutes') {
      const n = Math.max(1, Math.min(59, parseInt(fields.n.value, 10) || 0));
      return n ? `*/${n} * * * *` : null;
    }
    if (freq === 'hourly') {
      const m = parseInt(fields.min.value, 10);
      return m >= 0 && m <= 59 ? `${m} * * * *` : null;
    }
    if (freq === 'daily') { const { h, m } = t(); return `${m} ${h} * * *`; }
    if (freq === 'weekly') { const { h, m } = t(); return `${m} ${h} * * ${fields.dow.value}`; }
    if (freq === 'monthly') {
      const d = parseInt(fields.dom.value, 10);
      if (!(d >= 1 && d <= 31)) return null;
      const { h, m } = t();
      return `${m} ${h} ${d} * *`;
    }
    const raw = fields.raw.value.trim();
    return looksLikeCronSchedule(raw) ? raw : null;
  };

  const save = async () => {
    const schedule = buildSchedule();
    if (!schedule) {
      status.textContent = i18n.t('cron_invalid');
      status.classList.add('err');
      return;
    }
    const command = cmdInput.value.trim();
    if (!command) {
      status.textContent = i18n.t('cron_command_required');
      status.classList.add('err');
      return;
    }
    status.classList.remove('err');
    saveBtn.disabled = true;
    try {
      const entry = (job && job.paused ? '# ' : '') + `${schedule} ${command}`;
      if (job) lines[job.idx] = entry;
      else lines.push(entry);
      await saveCrontabLines(tab, lines);
    } catch (e) {
      saveBtn.disabled = false;
      status.textContent = i18n.t('cron_error', { error: e.message });
      status.classList.add('err');
      if (job) lines[job.idx] = (job.paused ? '# ' : '') + `${job.schedule} ${job.command}`;
      else lines.pop();
    }
  };
  saveBtn.addEventListener('click', save);
  cmdInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); box.remove(); }
  });

  setTimeout(() => cmdInput.focus(), 0);
  return box;
}

// --- Manual Pull ------------------------------------------------------------

let mpOpSeq = 0;
const mpProgressHandlers = new Set();

// avanzamento dump database (stesso meccanismo del Manual Pull)
let pgOpSeq = 0;
const pgProgressHandlers = new Set();

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
  input.placeholder = i18n.t('docker_manual_pull_placeholder');
  const go = el('button', 'docker-btn d-manual');
  go.innerHTML = `<i class="fa-solid fa-play"></i> ${i18n.t('docker_manual_pull')}`;
  top.appendChild(icon);
  top.appendChild(input);
  top.appendChild(go);

  const status = el('div', 'docker-mp-status');
  status.textContent = i18n.t('docker_manual_pull_destination', { image: targetImage });
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
    ui.status.textContent = i18n.t('docker_manual_pull_invalid');
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
    ui.status.textContent = i18n.t('docker_manual_pull_done', { image: tag });
    toast(i18n.t('docker_manual_pull_done', { image: tag }));
    showImages(tab); // ricarica lo stato (rimuove il form)
  } catch (e) {
    ui.box.classList.remove('indeterminate', 'running');
    ui.status.textContent = i18n.t('docker_manual_pull_error', { error: e.message });
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
    { icon: 'fa-solid fa-file-circle-plus', label: i18n.t('new_file'), action: () => newFilePrompt(tab, cwd) },
    { icon: 'fa-solid fa-file-import', label: i18n.t('import_file'), action: () => importLocal(tab, cwd) },
    { icon: 'fa-solid fa-trash', label: i18n.t('delete'), action: () => deleteEntry(tab, entry, fullPath) },
    { icon: 'fa-solid fa-copy', label: i18n.t('copy'), action: () => {
        remoteClipboard = { sessionId: tab.id, path: fullPath, isDir: entry.isDir, name: entry.name };
        toast(i18n.t('copied', { name: entry.name }));
      } },
    {
      icon: 'fa-solid fa-paste',
      label: i18n.t('paste') + (remoteClipboard ? ` (${remoteClipboard.name})` : ''),
      disabled: !remoteClipboard,
      action: () => pasteEntry(tab, cwd),
    },
  ];
  if (!entry.isDir) {
    items.push({
      icon: 'fa-solid fa-file-pen',
      label: i18n.t('edit_with_editor'),
      action: () => openEmbeddedEditor(tab, entry, fullPath),
    });
    items.push({
      icon: 'fa-solid fa-pen-to-square',
      label: i18n.t('edit'),
      action: () => {
        const ov = tab.hostEl.querySelector('.ll-overlay');
        if (ov) ov.remove();
        tab.term.focus();
        window.api.write(tab.id, `sudo nano ${shQuote(fullPath)}\r`);
      },
    });
  }
  // Scarica: disponibile sia per file che per cartelle
  items.push({ icon: 'fa-solid fa-download', label: i18n.t('download'), action: () => downloadEntry(tab, entry, fullPath) });
  openContextMenu(e.clientX, e.clientY, items);
}

/**
 * Apre un editor di testo embeddato (overlay) per modificare un file remoto.
 * Carica il contenuto via SFTP/sudo, mostra una textarea con due pulsanti:
 * "Salva ed esci" e "Esci senza salvare".
 */
async function openEmbeddedEditor(tab, entry, fullPath) {
  // chiudi eventuali overlay aperti (listing / docker / editor precedente)
  const old = tab.hostEl.querySelector('.ll-overlay');
  if (old) old.remove();

  let content;
  try {
    toast(i18n.t('editor_loading', { name: entry.name }));
    content = await window.api.readFile(tab.id, fullPath);
  } catch (e) {
    return toast(i18n.t('generic_error', { error: e.message }), true);
  }

  const overlay = el('div', 'll-overlay editor-overlay');
  const grip = el('div', 'll-resize');
  overlay.appendChild(grip);
  setupOverlayResize(grip, overlay, tab);
  if (tab.llHeight) { overlay.style.height = tab.llHeight + 'px'; overlay.style.maxHeight = 'none'; }

  const head = el('div', 'll-head');
  const info = el('span');
  info.innerHTML = `<i class="fa-solid fa-file-pen"></i> ${entry.name}`;
  const actions = el('span', 'll-head-actions');

  const saveBtn = el('button', 'editor-save');
  saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i>';
  saveBtn.title = i18n.t('editor_save');
  const cancelBtn = el('button');
  cancelBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  cancelBtn.title = i18n.t('editor_cancel');
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  head.appendChild(info);
  head.appendChild(actions);
  overlay.appendChild(head);

  const ta = document.createElement('textarea');
  ta.className = 'editor-textarea';
  ta.value = content;
  ta.spellcheck = false;
  overlay.appendChild(ta);

  const original = content;
  const isDirty = () => ta.value !== original;

  const close = () => {
    overlay.remove();
    tab.term.focus();
  };

  cancelBtn.addEventListener('click', () => {
    if (isDirty() && !confirm(i18n.t('editor_unsaved_confirm'))) return;
    close();
  });

  const save = async () => {
    saveBtn.disabled = true;
    try {
      await window.api.writeFile(tab.id, fullPath, ta.value);
      toast(i18n.t('editor_saved', { name: entry.name }));
      close();
    } catch (e) {
      saveBtn.disabled = false;
      toast(i18n.t('editor_save_error', { error: e.message }), true);
    }
  };
  saveBtn.addEventListener('click', save);

  // scorciatoie: Ctrl/Cmd+S salva, Esc esce
  ta.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') {
      ev.preventDefault();
      save();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      if (!isDirty() || confirm(i18n.t('editor_unsaved_confirm'))) close();
    }
  });

  tab.hostEl.appendChild(overlay);
  ta.focus();
}

function openTermContextMenu(e, tab) {
  const items = [
    {
      icon: 'fa-solid fa-key',
      label: i18n.t('paste_password'),
      disabled: !tab.server.password,
      action: () => {
        // incolla la password e invia ENTER, poi torna sul terminale
        window.api.write(tab.id, tab.server.password + '\r');
        tab.term.focus();
        toast(i18n.t('password_pasted'));
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
  const suffix = entry.isDir ? i18n.t('confirm_delete_entry_dir') : '';
  if (!confirm(i18n.t('confirm_delete_entry', { name: entry.name, suffix: suffix }))) return;
  try {
    await window.api.deleteEntry(tab.id, fullPath, entry.isDir);
    toast(i18n.t('entry_deleted', { name: entry.name }));
    showListing(tab, tab.cwd);
  } catch (e) { toast(i18n.t('generic_error', { error: e.message }), true); }
}

async function pasteEntry(tab, destDir) {
  if (!remoteClipboard) return;
  if (remoteClipboard.sessionId !== tab.id) {
    return toast(i18n.t('paste_only_same_connection'), true);
  }
  try {
    const newName = await window.api.copyEntry(tab.id, remoteClipboard.path, destDir, remoteClipboard.isDir);
    toast(i18n.t('pasted', { name: newName || remoteClipboard.name }));
    showListing(tab, tab.cwd);
  } catch (e) { toast(i18n.t('generic_error', { error: e.message }), true); }
}

async function downloadEntry(tab, entry, fullPath) {
  try {
    if (entry.isDir) toast(i18n.t('download_folder_loading'));
    const saved = await window.api.download(tab.id, fullPath, entry.name, entry.isDir);
    if (saved) toast(i18n.t('download_saved', { path: saved }));
  } catch (e) { toast(i18n.t('download_error', { error: e.message }), true); }
}

async function importLocal(tab, destDir) {
  try {
    toast(i18n.t('importing'));
    const names = await window.api.importLocal(tab.id, destDir);
    if (!names) return; // annullato
    toast(`Importato: ${names.join(', ')}`);
    showListing(tab, destDir);
  } catch (e) { toast(i18n.t('import_error', { error: e.message }), true); }
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
    // un marker CWD = prompt della shell host: non siamo (più) in log/container
    tab.termState = 'host';
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

window.api.onDumpProgress((p) => {
  pgProgressHandlers.forEach((h) => h(p));
});

window.api.onClosed(({ id }) => {
  const tab = tabs.get(id);
  if (tab) {
    tab.dead = true;
    tab.term.write(`\r\n\x1b[31m[${i18n.t('connection_closed')}]\x1b[0m\r\n`);
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
// APPLICAZIONE TESTI UI
// ============================================================================

function applyUITexts() {
  // Header configurazione
  const configTitle = document.querySelector('.config-header h1');
  const configSubtitle = document.querySelector('.config-header p');
  if (configTitle) configTitle.innerHTML = i18n.t('config_header_title');
  if (configSubtitle) configSubtitle.textContent = i18n.t('config_header_subtitle');

  // Titolo pannello server
  const panelTitle = document.querySelector('.panel-title span');
  if (panelTitle) panelTitle.textContent = i18n.t('server_list_title');

  // Button group espandi/comprimi
  const toggleBtn = $('#btn-toggle-groups');
  if (toggleBtn) {
    const keys = allGroupKeys();
    const anyExpanded = keys.some((k) => !isGroupCollapsed(k));
    toggleBtn.title = anyExpanded ? i18n.t('btn_toggle_groups_collapse') : i18n.t('btn_toggle_groups_expand');
  }

  // Bottone settings
  const settingsBtn = $('#btn-settings');
  if (settingsBtn) settingsBtn.title = i18n.t('settings_title');

  // Bottone nuovo server
  const newBtn = $('#btn-new');
  if (newBtn) newBtn.textContent = i18n.t('btn_new_server');

  // Form empty
  const formEmpty = $('#form-empty');
  if (formEmpty) formEmpty.textContent = i18n.t('select_or_create_server');

  // Form labels e placeholder
  const form = $('#server-form');
  if (form) {
    const updateLabel = (selector, text) => {
      const el = form.querySelector(selector);
      if (el) el.textContent = text;
    };
    const updatePlaceholder = (selector, text) => {
      const el = form.querySelector(selector);
      if (el) el.placeholder = text;
    };
    const updateLabelFor = (selector, newText) => {
      const labels = form.querySelectorAll('label');
      labels.forEach(l => {
        if (l.textContent.includes(selector)) {
          l.textContent = newText;
        }
      });
    };

    // Update nickname
    updatePlaceholder('input[name="nickname"]', i18n.t('form_placeholder_nickname'));
    updatePlaceholder('input[name="host"]', i18n.t('form_placeholder_host'));
    updatePlaceholder('input[name="username"]', i18n.t('form_placeholder_username'));
    updatePlaceholder('input[name="password"]', i18n.t('form_placeholder_password'));
    updatePlaceholder('input[name="pemPath"]', i18n.t('form_placeholder_pempath'));
    updatePlaceholder('input[name="passphrase"]', i18n.t('form_placeholder_passphrase'));

    // Update auth mode labels: sostituisci solo il testo, preservando l'<input> radio.
    // (impostare textContent sul <label> cancellerebbe il radio name="authMode" e
    //  romperebbe sia connetti che il doppio clic, che leggono form.authMode)
    const setRadioLabel = (value, text) => {
      const input = form.querySelector(`input[name="authMode"][value="${value}"]`);
      if (!input) return;
      const label = input.parentElement;
      label.childNodes.forEach((n) => { if (n.nodeType === Node.TEXT_NODE) n.remove(); });
      label.appendChild(document.createTextNode(' ' + text));
    };
    setRadioLabel('password', i18n.t('form_auth_password'));
    setRadioLabel('pem', i18n.t('form_auth_pem'));

    // Update button labels
    form.querySelector('button[type="submit"]').innerHTML = `<i class="fa-solid fa-floppy-disk"></i> ${i18n.t('form_btn_save')}`;
    form.querySelector('#btn-connect').innerHTML = `<i class="fa-solid fa-plug"></i> ${i18n.t('form_btn_connect')}`;
    form.querySelector('#btn-delete').innerHTML = `<i class="fa-solid fa-trash"></i> ${i18n.t('form_btn_delete')}`;

    // Update password hint
    const hint = form.querySelector('small.hint');
    if (hint) hint.textContent = i18n.t('form_password_hint');
  }

  // Settings view
  const settingsTitle = document.querySelector('.settings-header h1');
  const settingsSubtitle = document.querySelector('.settings-header p');
  if (settingsTitle) settingsTitle.innerHTML = i18n.t('settings_title');
  if (settingsSubtitle) settingsSubtitle.textContent = i18n.t('settings_subtitle');

  const themeLabel = document.querySelector('label[for="theme-select"]');
  if (themeLabel) themeLabel.textContent = i18n.t('settings_theme_label');

  const langLabel = document.querySelector('label[for="language-select"]');
  if (langLabel) langLabel.textContent = i18n.t('settings_language_label');

  // Update theme options
  const themeSelect = $('#theme-select');
  if (themeSelect) {
    const options = {
      mocha: i18n.t('settings_theme_mocha'),
      miami: i18n.t('settings_theme_miami'),
      dracula: i18n.t('settings_theme_dracula'),
      nord: i18n.t('settings_theme_nord'),
      'tokyo-night': i18n.t('settings_theme_tokyo'),
      gruvbox: i18n.t('settings_theme_gruvbox'),
      matrix: i18n.t('settings_theme_matrix'),
    };
    themeSelect.querySelectorAll('option').forEach(opt => {
      if (options[opt.value]) opt.textContent = options[opt.value];
    });
  }

  // Update language options
  const langSelect = $('#language-select');
  if (langSelect) {
    const options = {
      it: i18n.t('settings_language_italian'),
      en: i18n.t('settings_language_english'),
      es: i18n.t('settings_language_spanish'),
      fr: i18n.t('settings_language_french'),
      de: i18n.t('settings_language_german'),
      pt: i18n.t('settings_language_portuguese'),
    };
    langSelect.querySelectorAll('option').forEach(opt => {
      if (options[opt.value]) opt.textContent = options[opt.value];
    });
  }

  const configLabel = document.querySelector('.settings-card:last-child .settings-row label');
  if (configLabel) configLabel.textContent = i18n.t('settings_config_label');

  const importBtn = $('#btn-import');
  if (importBtn) importBtn.innerHTML = `<i class="fa-solid fa-upload"></i> ${i18n.t('settings_btn_import')}`;

  const exportBtn = $('#btn-export');
  if (exportBtn) exportBtn.innerHTML = `<i class="fa-solid fa-download"></i> ${i18n.t('settings_btn_export')}`;

  const backBtn = $('#btn-settings-back');
  if (backBtn) backBtn.innerHTML = `<i class="fa-solid fa-arrow-left"></i> ${i18n.t('settings_title')}`;

  const homeBackBtn = $('#btn-back');
  if (homeBackBtn) homeBackBtn.innerHTML = `<i class="fa-solid fa-arrow-left"></i> ${i18n.t('back_to_active_sessions')}`;

  // Search placeholder
  const searchInput = $('#server-search');
  if (searchInput) searchInput.placeholder = i18n.t('search_placeholder');
}

// ============================================================================
// BOOTSTRAP
// ============================================================================

window.addEventListener('DOMContentLoaded', async () => {
  // carica le traduzioni e applica la lingua salvata
  await i18n.load();
  i18n.setLanguage(i18n.getLanguage());
  applyUITexts();

  loadServers();

  // tema: applica quello salvato e collega la dropdown
  const themeSelect = $('#theme-select');
  applyTheme(getSavedTheme());
  themeSelect.value = getSavedTheme();
  themeSelect.addEventListener('change', (e) => applyTheme(e.target.value));

  // lingua: applica quella salvata e collega la dropdown
  const langSelect = $('#language-select');
  langSelect.value = i18n.getLanguage();
  langSelect.addEventListener('change', (e) => {
    i18n.setLanguage(e.target.value);
    applyUITexts();
    renderServerList();
  });

  $('#btn-settings').addEventListener('click', () => showView('settings'));
  $('#btn-settings-back').addEventListener('click', () => showView('config'));
  $('#btn-toggle-groups').addEventListener('click', toggleAllGroups);

  $('#btn-new').addEventListener('click', newServer);
  $('#btn-export').addEventListener('click', exportServers);
  $('#btn-import').addEventListener('click', importServers);

  // occhio mostra/nascondi sui campi password
  $('#server-form').querySelectorAll('.btn-eye').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(`#server-form input[name=${btn.dataset.target}]`);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.querySelector('i').className = show ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
    });
  });
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

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
// split view: elenco ordinato (sinistra→destra) delle schede affiancate.
// Vuoto o con un solo elemento = vista singola (solo activeTab).
let splitIds = [];
let splitWeights = new Map(); // id -> peso flex (somma qualsiasi, conta il rapporto)

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
  if (name !== 'settings') stopRecording();
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

/** Pulisce il terminale (schermo locale + `clear` remoto). */
function clearTerminal(tab) {
  tab.term.clear();
  window.api.write(tab.id, 'clear\r');
  tab.term.focus();
}

/**
 * Azioni della barra di una scheda: usate sia per costruire i pulsanti del pane
 * sia dal motore delle scorciatoie da tastiera (vedi SCORCIATOIE DA TASTIERA),
 * così i due percorsi restano sempre allineati.
 */
const TAB_ACTIONS = [
  { id: 'files',     icon: 'fa-solid fa-list',       labelKey: 'll_button_title',                run: (tab) => showListing(tab) },
  { id: 'clear',     icon: 'fa-solid fa-broom',      labelKey: 'clear_button_title',             run: (tab) => clearTerminal(tab) },
  { id: 'docker',    icon: 'fa-brands fa-docker',    labelKey: 'docker_containers_button_title', run: (tab) => showDocker(tab) },
  { id: 'images',    icon: 'fa-solid fa-hard-drive', labelKey: 'docker_images_button_title',     run: (tab) => showImages(tab) },
  { id: 'databases', icon: 'fa-solid fa-database',   labelKey: 'db_databases_button_title',      run: (tab) => showDatabases(tab) },
  { id: 'screens',   icon: 'fa-brands fa-buffer',    labelKey: 'screen_sessions_button_title',   run: (tab) => showScreens(tab) },
  { id: 'cron',      icon: 'fa-solid fa-clock',      labelKey: 'cron_button_title',              run: (tab) => showCrontab(tab) },
  { id: 'monitor',   icon: 'fa-solid fa-gauge-high', labelKey: 'monitor_button_title',           run: (tab) => showMonitor(tab) },
];

function buildPane(tab) {
  const pane = el('div', 'pane');
  pane.dataset.id = tab.id;

  // in split view la linguetta della scheda vive qui, sopra il proprio pane
  const tabSlot = el('div', 'pane-tabslot');
  tab.tabSlotEl = tabSlot;

  const toolbar = el('div', 'pane-toolbar');

  // barra fissa di azioni: solo icone, con tooltip sotto al passaggio del mouse
  // (il tooltip riporta anche la scorciatoia da tastiera associata, se c'è)
  const actionsBar = el('div', 'pane-actions');
  for (const a of TAB_ACTIONS) {
    const label = i18n.t(a.labelKey);
    const keys = shortcutFor(a.id);
    const btn = el('button', 'btn-ll tip');
    btn.innerHTML = `<i class="${a.icon}"></i>`;
    btn.dataset.tip = keys ? `${label}  ·  ${formatBinding(keys)}` : label;
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', () => a.run(tab));
    actionsBar.appendChild(btn);
  }

  const srv = el('span', 'srv-name');
  srv.textContent = tab.server.nickname || tab.server.name;
  const cwd = el('span', 'cwd');
  cwd.textContent = tab.cwd;
  tab.cwdEl = cwd;
  toolbar.appendChild(actionsBar);
  toolbar.appendChild(srv);
  toolbar.appendChild(cwd);

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

  // in split, cliccare su un pane lo rende quello "attivo" (focus tastiera)
  pane.addEventListener('mousedown', () => {
    if (tab.id !== activeTabId && splitOrder().includes(tab.id)) {
      activeTabId = tab.id;
      layout();
    }
  });

  // drop zone per split view (con evidenziazione); vicino ai bordi della
  // finestra ha la precedenza lo snap a metà schermo (vedi setupEdgeSnap)
  pane.addEventListener('dragover', (e) => {
    e.preventDefault();
    const edge = edgeSide(e);
    showEdgeHint(edge);
    pane.classList.toggle('drop-hint', !edge);
  });
  pane.addEventListener('dragleave', () => pane.classList.remove('drop-hint'));
  pane.addEventListener('drop', (e) => {
    e.preventDefault();
    pane.classList.remove('drop-hint');
    const edge = edgeSide(e);
    showEdgeHint(null);
    const dropped = e.dataTransfer.getData('text/tab');
    if (!dropped) return;
    if (edge) splitToSide(dropped, edge);
    else enableSplit(dropped);
  });

  pane.appendChild(tabSlot);
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

/**
 * Tooltip unico per tutti gli elementi con `data-tip`: appare subito sotto
 * l'elemento ed è agganciato al body, così non viene tagliato dai contenitori
 * e resta sempre dentro la finestra (posizione limitata ai bordi).
 */
function setupTooltips() {
  const MARGIN = 6;
  const bubble = el('div', 'tip-bubble hidden');
  document.body.appendChild(bubble);
  let current = null;

  const hide = () => {
    current = null;
    bubble.classList.add('hidden');
  };

  const show = (target) => {
    const text = target.dataset.tip;
    if (!text) return hide();
    current = target;
    bubble.textContent = text;
    bubble.classList.remove('hidden', 'above');

    const r = target.getBoundingClientRect();
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    // centrato sull'elemento, ma rientrato se sborderebbe a destra/sinistra
    const left = Math.max(MARGIN, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - MARGIN));
    // sotto l'elemento; se non c'è spazio, sopra
    const below = r.bottom + MARGIN;
    const above = below + h > window.innerHeight - MARGIN;
    bubble.classList.toggle('above', above);
    bubble.style.left = `${left}px`;
    bubble.style.top = `${above ? Math.max(MARGIN, r.top - h - MARGIN) : below}px`;
    // la freccia resta puntata al centro dell'elemento anche col tooltip rientrato
    const arrow = Math.min(Math.max(r.left + r.width / 2 - left, 10), w - 10);
    bubble.style.setProperty('--tip-arrow', `${arrow}px`);
  };

  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (t === current) return;
    t ? show(t) : hide();
  });
  document.addEventListener('mousedown', hide);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
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
  // selezionare una scheda fuori dallo split chiude lo split e la mostra da sola
  const order = splitOrder();
  if (order.length && !order.includes(id)) {
    splitIds = [];
    splitWeights.clear();
  }
  activeTabId = id;
  layout();
  const tab = tabs.get(id);
  if (tab) setTimeout(() => { tab.fit.fit(); tab.term.focus(); }, 30);
}

/**
 * Passa alla scheda successiva/precedente (scorciatoie da tastiera).
 * In split view il ciclo resta fra i pane affiancati e sposta solo il focus.
 */
function cycleTab(delta) {
  const order = splitOrder();
  const ids = order.length ? order : [...tabs.keys()];
  if (ids.length < 2) return;
  const cur = ids.indexOf(activeTabId);
  const next = ids[((cur < 0 ? 0 : cur) + delta + ids.length) % ids.length];
  if (!order.length) return setActive(next);
  activeTabId = next;
  layout();
  const tab = tabs.get(next);
  if (tab) setTimeout(() => tab.term.focus(), 30);
}

/** Schede realmente affiancate: quelle ancora aperte presenti in splitIds (>= 2). */
function splitOrder() {
  const list = splitIds.filter((id) => tabs.has(id));
  return list.length >= 2 ? list : [];
}

/** Peso flex di un pane nello split (1 se non ancora impostato). */
function weightOf(id) {
  const w = splitWeights.get(id);
  return w > 0 ? w : 1;
}

/** Dispone i pane: solo activeTab, oppure tutte le schede in splitIds
 *  affiancate in orizzontale e ridimensionabili tramite i divider. */
function layout() {
  const panes = $('#panes');
  // rimuovi eventuali divider della disposizione precedente
  panes.querySelectorAll('.split-divider').forEach((d) => d.remove());

  const order = splitOrder();
  splitIds = order; // normalizza (scarta le schede chiuse)
  // il pulsante nella barra resta evidenziato mentre lo split è attivo
  const splitBtn = $('#btn-split');
  if (splitBtn) splitBtn.classList.toggle('active', order.length > 1);
  const shown = order.length ? order : (activeTabId ? [activeTabId] : []);
  // lo split deve includere la scheda attiva: altrimenti l'attiva diventa la prima mostrata
  if (order.length && !order.includes(activeTabId)) activeTabId = order[0];

  tabs.forEach((tab) => {
    const visible = shown.includes(tab.id);
    tab.paneEl.classList.toggle('visible', visible);
    tab.paneEl.style.flex = '';
    tab.paneEl.style.order = '';
  });

  // aggiorna stato schede: tutte quelle affiancate risultano "attive".
  // In split, la linguetta si sposta sopra il proprio pane (così ne segue
  // larghezza e posizione anche durante il resize); le altre restano in barra.
  const tabbar = $('#tabs');
  tabs.forEach((tab) => {
    const inSplit = order.includes(tab.id);
    tab.tabEl.classList.toggle('active', shown.includes(tab.id));
    tab.tabEl.classList.toggle('focused', tab.id === activeTabId && order.length > 1);
    tab.tabEl.classList.toggle('docked', inSplit);
    tab.tabEl.querySelector('.dot').classList.toggle('dead', tab.dead);
    const host = inSplit ? tab.tabSlotEl : tabbar;
    if (tab.tabEl.parentElement !== host) host.appendChild(tab.tabEl);
    else if (!inSplit) tabbar.appendChild(tab.tabEl); // mantiene l'ordine di apertura
  });

  // ordine visivo esplicito (indipendente dall'ordine nel DOM):
  // pane | divider | pane | divider | pane …
  order.forEach((id, i) => {
    const pane = tabs.get(id).paneEl;
    pane.style.flex = weightOf(id);
    pane.style.order = String(i * 2 + 1);
    if (i < order.length - 1) {
      const divider = el('div', 'split-divider');
      divider.style.order = String(i * 2 + 2);
      panes.appendChild(divider);
      setupDividerDrag(divider, id, order[i + 1]);
    }
  });

  setTimeout(fitAll, 30);
}

/** Imposta lo split sull'elenco di schede dato (in ordine sinistra→destra). */
function setSplit(ids, { silent = false } = {}) {
  const list = [...new Set(ids.filter((id) => tabs.has(id)))];
  if (list.length < 2) {
    splitIds = [];
    splitWeights.clear();
    layout();
    if (!silent) toast(i18n.t('split_view_closed'));
    return;
  }
  splitIds = list;
  // conserva i pesi già impostati (utile nei riordini), 1 per le nuove sezioni
  splitWeights = new Map(list.map((id) => [id, weightOf(id)]));
  if (!list.includes(activeTabId)) activeTabId = list[0];
  layout();
  if (!silent) toast(i18n.t('split_view_active', { count: list.length }));
}

/** Aggiunge una scheda allo split esistente (o ne crea uno con l'attiva). */
function enableSplit(secondId) {
  if (!tabs.has(secondId)) return;
  const order = splitOrder();
  if (order.length) {
    if (order.includes(secondId)) return;
    setSplit([...order, secondId]);
  } else {
    if (secondId === activeTabId) return;
    setSplit([activeTabId, secondId]);
  }
}

/** Attiva/disattiva lo split dal pulsante ⫿: se attivo lo chiude,
 *  altrimenti affianca in orizzontale tutte le schede aperte. */
function toggleSplit(tabId) {
  if (splitOrder().length) {
    setSplit([]);
    return;
  }
  if (tabId !== activeTabId) setActive(tabId);
  if (tabs.size < 2) return toast(i18n.t('split_min_2_tabs'), true);
  setSplit([...tabs.keys()]);
}

/** Assegna alla scheda la metà destra/sinistra dello schermo (drag verso il
 *  bordo della finestra): le altre schede restano tutte visibili e si
 *  spartiscono la metà opposta. */
function splitToSide(id, side) {
  if (!tabs.has(id)) return;
  if (tabs.size < 2) return toast(i18n.t('split_min_2_tabs'), true);
  // se non si è già in split, affianca tutte le schede aperte
  const base = splitOrder().length ? splitOrder() : [...tabs.keys()];
  const rest = base.filter((k) => k !== id);
  if (!rest.length) return toast(i18n.t('split_min_2_tabs'), true);
  setSplit(side === 'left' ? [id, ...rest] : [...rest, id], { silent: true });
  // metà schermo alla scheda trascinata, l'altra metà divisa fra le rimanenti
  splitWeights.set(id, 0.5);
  rest.forEach((k) => splitWeights.set(k, 0.5 / rest.length));
  layout();
  setActive(id);
  toast(i18n.t(side === 'left' ? 'split_view_left' : 'split_view_right'));
}

// ---------------------------------------------------------------------------
// SNAP AI BORDI: trascinando una scheda verso il bordo destro/sinistro della
// finestra, quella scheda viene mostrata nella metà corrispondente.
// ---------------------------------------------------------------------------

const EDGE_SNAP_PX = 90; // larghezza della zona sensibile ai bordi

/** 'left' | 'right' | null in base alla vicinanza al bordo della finestra. */
function edgeSide(e) {
  const w = window.innerWidth;
  if (e.clientX <= EDGE_SNAP_PX) return 'left';
  if (e.clientX >= w - EDGE_SNAP_PX) return 'right';
  return null;
}

/** Mostra/nasconde l'anteprima della metà schermo di destinazione. */
function showEdgeHint(side) {
  const hint = $('#edge-hint');
  if (!hint) return;
  hint.classList.toggle('hidden', !side);
  hint.classList.toggle('right', side === 'right');
}

/** Collega le zone di snap sul contenitore del terminale (bordi finestra). */
function setupEdgeSnap() {
  const view = $('#terminal-view');
  view.addEventListener('dragover', (e) => {
    const side = edgeSide(e);
    if (side) e.preventDefault();
    showEdgeHint(side);
  });
  view.addEventListener('drop', (e) => {
    const side = edgeSide(e);
    showEdgeHint(null);
    if (!side) return;
    e.preventDefault();
    const dropped = e.dataTransfer.getData('text/tab');
    if (dropped) splitToSide(dropped, side);
  });
  view.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) showEdgeHint(null); // uscita dalla finestra
  });
  document.addEventListener('dragend', () => showEdgeHint(null));
}

/** Trascinamento di un divider: ridistribuisce lo spazio fra i due pane adiacenti. */
function setupDividerDrag(divider, leftId, rightId) {
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const leftPane = tabs.get(leftId).paneEl;
    const rightPane = tabs.get(rightId).paneEl;
    // lo spazio (e il peso) da ripartire riguarda solo la coppia adiacente
    const startLeft = leftPane.getBoundingClientRect();
    const startRight = rightPane.getBoundingClientRect();
    const span = startLeft.width + startRight.width;
    const pairWeight = weightOf(leftId) + weightOf(rightId);
    if (span <= 0) return;
    const onMove = (ev) => {
      let r = (ev.clientX - startLeft.left) / span;
      r = Math.max(0.15, Math.min(0.85, r));
      const wl = pairWeight * r;
      splitWeights.set(leftId, wl);
      splitWeights.set(rightId, pairWeight - wl);
      leftPane.style.flex = wl;
      rightPane.style.flex = pairWeight - wl;
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
  invalidateListing(id);
  splitIds = splitIds.filter((s) => s !== id);
  splitWeights.delete(id);
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

// Cache dei listing, chiave `${tab.id}\u0000${dir}` -> { cwd, entries, sig }.
// Serve al disegno immediato (stale-while-revalidate): si mostra subito l'ultimo
// contenuto noto e lo si aggiorna quando arriva la risposta SFTP.
const listingCache = new Map();
const LISTING_CACHE_MAX = 80; // cartelle tenute in memoria per tutte le schede
const listingKey = (tabId, dir) => tabId + '\u0000' + dir;

/** Firma del contenuto di una cartella: se non cambia si evita di ridisegnare. */
function listingSig(res) {
  return res.cwd + '\u0002' + res.entries
    .map((e) => `${e.name}\u0001${e.size}\u0001${e.mtime}\u0001${e.mode}`)
    .join('\u0002');
}

function cacheListing(tabId, dir, res) {
  listingCache.set(listingKey(tabId, dir), res);
  // tetto alla memoria: la Map conserva l'ordine di inserimento, si scarta la più vecchia
  while (listingCache.size > LISTING_CACHE_MAX) {
    listingCache.delete(listingCache.keys().next().value);
  }
}

/** Scarta la cache di una scheda: una singola cartella, oppure tutte. */
function invalidateListing(tabId, dir) {
  if (dir) return void listingCache.delete(listingKey(tabId, dir));
  const prefix = tabId + '\u0000';
  for (const k of [...listingCache.keys()]) {
    if (k.startsWith(prefix)) listingCache.delete(k);
  }
}

/** Spegne l'indicatore di caricamento sul file browser attualmente a schermo. */
function stopListingSpinner(tab) {
  const ov = tab.hostEl.querySelector('.ll-overlay.ll-files');
  if (ov) ov.classList.remove('ll-loading');
}

/**
 * Apre o aggiorna il file browser sulla cartella `dir`.
 *
 * Mostra subito qualcosa senza aspettare la rete: il contenuto in cache se c'è,
 * altrimenti uno scheletro; se a schermo c'è già il listing della stessa
 * cartella lo lascia in piedi e accende solo lo spinner. Il contenuto viene
 * sostituito quando arriva la risposta SFTP (e non viene ridisegnato affatto se
 * la cartella è identica a quella già mostrata).
 *
 * `opts.fresh` salta la cache: da usare dopo aver modificato la cartella
 * (creazione, cancellazione, copia, chmod, upload).
 */
async function showListing(tab, dir, opts = {}) {
  const target = dir || tab.cwd;
  // ogni richiesta ha un numero progressivo: se ne parte una più recente
  // (navigazione rapida fra cartelle) la risposta arretrata viene scartata
  const seq = tab.llSeq = (tab.llSeq || 0) + 1;

  if (opts.fresh) invalidateListing(tab.id, target);
  const cached = listingCache.get(listingKey(tab.id, target));
  const current = tab.hostEl.querySelector('.ll-overlay.ll-files');
  let skeleton = false;

  if (cached) renderListing(tab, cached, true);
  else if (current && tab.llDir === target) current.classList.add('ll-loading');
  else { renderListingSkeleton(tab, target); skeleton = true; }

  let res;
  try {
    res = await window.api.listDir(tab.id, target);
  } catch (e) {
    if (seq === tab.llSeq) {
      // se non c'era nulla da mostrare togli lo scheletro, altrimenti resta il contenuto vecchio
      if (skeleton) { const ov = tab.hostEl.querySelector('.ll-overlay.ll-files'); if (ov) ov.remove(); }
      else stopListingSpinner(tab);
    }
    return toast(i18n.t('listing_error', { error: e.message }), true);
  }
  if (seq !== tab.llSeq) return; // sorpassata da una richiesta più recente

  res.sig = listingSig(res);
  cacheListing(tab.id, res.cwd, res);
  if (target !== res.cwd) cacheListing(tab.id, target, res);

  tab.cwd = res.cwd;
  if (tab.cwdEl) tab.cwdEl.textContent = res.cwd;

  // già a schermo e identico: niente da ridisegnare, basta spegnere lo spinner
  if (cached && cached.sig === res.sig && tab.llDir === res.cwd) return stopListingSpinner(tab);
  renderListing(tab, res);
}

/** Contenitore dell'overlay file browser: maniglia di resize e altezza salvata. */
function beginListingOverlay(tab, loading) {
  const overlay = el('div', 'll-overlay ll-files' + (loading ? ' ll-loading' : ''));
  // maniglia di ridimensionamento verticale in cima al pannello
  const grip = el('div', 'll-resize');
  overlay.appendChild(grip);
  setupOverlayResize(grip, overlay, tab);
  // ripristina l'altezza scelta in precedenza (per questa scheda)
  if (tab.llHeight) { overlay.style.height = tab.llHeight + 'px'; overlay.style.maxHeight = 'none'; }
  return overlay;
}

/** Sostituisce l'overlay a schermo, conservando lo scroll se è la stessa cartella. */
function endListingOverlay(tab, overlay, dir) {
  const old = tab.hostEl.querySelector('.ll-overlay');
  const keepScroll = old && old.classList.contains('ll-files') && tab.llDir === dir;
  const scroll = keepScroll ? old.scrollTop : 0;
  if (old) old.remove();
  tab.hostEl.appendChild(overlay);
  if (scroll) overlay.scrollTop = scroll;
  tab.llDir = dir;
}

/** Intestazione del file browser. `count` a null = cartella non ancora letta. */
function makeListingHead(tab, cwd, count, overlay) {
  const head = el('div', 'll-head');
  const info = el('span');
  info.innerHTML = count === null
    ? `<i class="fa-solid fa-folder-open"></i> ${escapeHtml(cwd)}`
    : i18n.t('listing_folder_info', { path: escapeHtml(cwd), count: count });
  const actions = el('span', 'll-head-actions');
  // visibile solo mentre l'overlay ha la classe .ll-loading
  const spin = el('span', 'll-spin');
  spin.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>';
  const searchBtn = el('button');
  searchBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i>';
  searchBtn.title = i18n.t('search_folder');
  searchBtn.addEventListener('click', () => toggleSearch(tab, cwd, overlay));
  const closeBtn = el('button');
  closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  closeBtn.title = 'Chiudi';
  // il numero di richiesta avanza: una lettura ancora in volo non riapre il pannello
  closeBtn.addEventListener('click', () => { tab.llSeq = (tab.llSeq || 0) + 1; overlay.remove(); });
  actions.appendChild(spin);
  actions.appendChild(searchBtn);
  actions.appendChild(closeBtn);
  head.appendChild(info);
  head.appendChild(actions);
  return head;
}

/** Disegna il contenuto della cartella. `loading` = dati dalla cache, in attesa di conferma. */
function renderListing(tab, res, loading = false) {
  const overlay = beginListingOverlay(tab, loading);
  overlay.appendChild(makeListingHead(tab, res.cwd, res.entries.length, overlay));

  // voce per risalire
  const up = makeEntry(tab, { name: '..', isDir: true, isLink: false, size: 0 }, res.cwd);
  overlay.appendChild(up);

  res.entries.forEach((entry) => {
    if (entry.name === '.' || entry.name === '..') return;
    overlay.appendChild(makeEntry(tab, entry, res.cwd));
  });

  endListingOverlay(tab, overlay, res.cwd);
}

/** Scheletro mostrato subito quando la cartella non è in cache. */
function renderListingSkeleton(tab, dir) {
  const overlay = beginListingOverlay(tab, true);
  overlay.appendChild(makeListingHead(tab, dir, null, overlay));
  for (let i = 0; i < 8; i++) overlay.appendChild(el('div', 'll-skeleton'));
  endListingOverlay(tab, overlay, dir);
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
        showListing(tab, cwd, { fresh: true });
      } catch (err) { toast(i18n.t('generic_error', { error: err.message }), true); }
    }
  });
  input.addEventListener('blur', cleanup);
}

function makeEntry(tab, entry, cwd) {
  const row = el('div', 'll-entry' + (entry.isDir ? ' dir' : '') + (entry.isLink ? ' link' : '')
    + (entry.isExec ? ' exec' : ''));
  const ico = el('span', 'ico');
  ico.innerHTML = entry.isDir
    ? '<i class="fa-solid fa-folder"></i>'
    : entry.isLink ? '<i class="fa-solid fa-link"></i>'
    : entry.isExec ? '<i class="fa-solid fa-gears"></i>'
    : '<i class="fa-solid fa-file"></i>';
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
      // il listing usa un percorso assoluto via SFTP: non dipende dalla `cd`
      // sulla shell, quindi parte subito in parallelo senza attese fisse
      showListing(tab, target);
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
      const portsText = (c.portDetails || [])
        .map((p) => (p.host != null ? `${p.host} ${p.container}` : `${p.container}`))
        .join(' ');
      return { text: `${c.name} ${c.image} ${c.status || ''} ${portsText}`.toLowerCase(), row };
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
  // dettaglio porte accanto al nome: host→container (pubblicate) e solo esposte
  const pd = c.portDetails || [];
  if (pd.length) {
    const wrap = el('span', 'docker-ports');
    pd.forEach((p) => {
      const chip = el('span', 'port-chip' + (p.host != null ? ' published' : ''));
      chip.textContent = p.host != null ? `${p.host}→${p.container}` : `${p.container}`;
      chip.title = p.host != null
        ? i18n.t('docker_port_published', { host: p.host, container: p.container, proto: p.proto })
        : i18n.t('docker_port_exposed', { container: p.container, proto: p.proto });
      wrap.appendChild(chip);
    });
    name.appendChild(wrap);
  }
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

// ============================================================================
// MONITOR DI SISTEMA (dischi + CPU/RAM in tempo reale)
// ============================================================================

const MON_INTERVAL = 1000; // frequenza di aggiornamento
const MON_HIST = 60;       // punti di storico nei grafici (~2 minuti)
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Soglie di colore condivise da barre, percentuali e grafici. */
function levelClass(v) {
  return v >= 90 ? 'crit' : v >= 75 ? 'warn' : 'ok';
}

/**
 * Dashboard di sistema: unisce `df` (dischi) e le metriche in stile htop
 * (CPU per core, memoria, swap, load, processi) in un pannello che si aggiorna
 * ogni 2 secondi finché resta aperto e la scheda è visibile.
 */
async function showMonitor(tab) {
  // chiudi eventuali overlay già aperti (listing / docker / monitor precedente)
  const old = tab.hostEl.querySelector('.ll-overlay');
  if (old) old.remove();

  const overlay = el('div', 'll-overlay mon-overlay');
  const grip = el('div', 'll-resize');
  overlay.appendChild(grip);
  setupOverlayResize(grip, overlay, tab);
  if (tab.llHeight) { overlay.style.height = tab.llHeight + 'px'; overlay.style.maxHeight = 'none'; }

  const head = el('div', 'll-head');
  const info = el('span', 'mon-head');
  const title = el('span', 'mon-head-title');
  title.innerHTML = `<i class="fa-solid fa-gauge-high"></i> ${i18n.t('monitor_title')}`;
  const headInfo = el('span', 'mon-head-info');
  info.appendChild(title);
  info.appendChild(headInfo);
  const actions = el('span', 'll-head-actions');
  const closeBtn = el('button');
  closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  closeBtn.title = i18n.t('tf_close');
  closeBtn.addEventListener('click', () => overlay.remove());
  actions.appendChild(closeBtn);
  head.appendChild(info);
  head.appendChild(actions);
  overlay.appendChild(head);

  const notice = el('div', 'mon-notice');
  notice.textContent = i18n.t('monitor_loading');
  overlay.appendChild(notice);

  const body = el('div', 'mon-body hidden');

  // ---- riquadro CPU ----
  const cpuCard = el('div', 'mon-card');
  const cpuBig = el('span', 'mon-big');
  cpuBig.textContent = '—';
  const cpuSub = el('span', 'mon-sub');
  cpuCard.appendChild(makeCardHead('fa-solid fa-microchip', i18n.t('monitor_cpu'), cpuSub, cpuBig));
  const cpuSpark = makeSpark('cpu');
  cpuCard.appendChild(cpuSpark.svg);
  const cores = el('div', 'mon-cores');
  cpuCard.appendChild(cores);
  const cpuKv = el('div', 'mon-kv');
  cpuCard.appendChild(cpuKv);

  // ---- riquadro memoria ----
  const memCard = el('div', 'mon-card');
  const memBig = el('span', 'mon-big');
  memBig.textContent = '—';
  const memSub = el('span', 'mon-sub');
  memCard.appendChild(makeCardHead('fa-solid fa-memory', i18n.t('monitor_ram'), memSub, memBig));
  const memSpark = makeSpark('mem');
  memCard.appendChild(memSpark.svg);
  // barra a segmenti: in uso | cache/buffer | libera (spazio residuo)
  const stack = el('div', 'mon-stack');
  const segUsed = el('div', 'mon-seg used');
  const segCache = el('div', 'mon-seg cache');
  stack.appendChild(segUsed);
  stack.appendChild(segCache);
  memCard.appendChild(stack);
  const legend = el('div', 'mon-legend');
  legend.innerHTML =
    `<span><i class="dot used"></i>${i18n.t('monitor_used')}</span>` +
    `<span><i class="dot cache"></i>${i18n.t('monitor_cache')}</span>` +
    `<span><i class="dot free"></i>${i18n.t('monitor_free')}</span>`;
  memCard.appendChild(legend);
  const memKv = el('div', 'mon-kv');
  memCard.appendChild(memKv);

  const grid = el('div', 'mon-grid');
  grid.appendChild(cpuCard);
  grid.appendChild(memCard);
  body.appendChild(grid);

  // ---- dischi ----
  const diskSection = el('div', 'mon-section');
  diskSection.appendChild(makeSectionTitle('fa-solid fa-hard-drive', i18n.t('monitor_disks')));
  const diskBox = el('div', 'mon-disks');
  diskSection.appendChild(diskBox);
  body.appendChild(diskSection);

  // ---- processi ----
  const procSection = el('div', 'mon-section');
  procSection.appendChild(makeSectionTitle('fa-solid fa-list-ol', i18n.t('monitor_procs')));
  const procBox = el('div', 'mon-procs');
  procSection.appendChild(procBox);
  body.appendChild(procSection);

  overlay.appendChild(body);
  tab.hostEl.appendChild(overlay);

  tab.monitor = {
    overlay, notice, body, headInfo,
    cpuBig, cpuSub, cpuKv, cpuSpark, cores,
    memBig, memSub, memKv, memSpark, segUsed, segCache,
    diskBox, procBox, diskSig: null, diskRefs: new Map(),
    hist: { cpu: [], mem: [] },
  };

  let busy = false;
  const tick = async () => {
    // il pannello è stato chiuso (o sostituito da un altro): ferma il polling
    if (!overlay.isConnected) {
      clearInterval(tab.monitor && tab.monitor.timer);
      if (tab.monitor && tab.monitor.overlay === overlay) tab.monitor = null;
      return;
    }
    // scheda non visibile o connessione caduta: niente interrogazioni inutili
    if (busy || tab.dead || !tab.paneEl.classList.contains('visible')) return;
    busy = true;
    try {
      updateMonitor(tab, await window.api.sysStats(tab.id));
    } catch (e) {
      notice.textContent = i18n.t('monitor_error', { error: e.message });
      notice.classList.remove('hidden');
    } finally {
      busy = false;
    }
  };
  tab.monitor.timer = setInterval(tick, MON_INTERVAL);
  tick();
}

/** Intestazione di un riquadro: icona, titolo, sottotitolo e valore grande. */
function makeCardHead(icon, label, subEl, bigEl) {
  const h = el('div', 'mon-card-head');
  const i = el('i', icon);
  const t = el('span', 'mon-card-title');
  t.textContent = label;
  h.appendChild(i);
  h.appendChild(t);
  h.appendChild(subEl);
  h.appendChild(bigEl);
  return h;
}

function makeSectionTitle(icon, label) {
  const d = el('div', 'mon-section-title');
  d.innerHTML = `<i class="${icon}"></i> ${escapeHtml(label)}`;
  return d;
}

/**
 * Grafico sparkline in SVG (area + linea + linee guida), disegnato a percentuali
 * 0-100. Usa `currentColor` così il colore arriva dal tema via CSS.
 */
function makeSpark(cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'mon-spark ' + cls);
  svg.setAttribute('viewBox', '0 0 100 34');
  svg.setAttribute('preserveAspectRatio', 'none');
  [25, 50, 75].forEach((p) => {
    const ln = document.createElementNS(SVG_NS, 'line');
    const y = (34 - (p / 100) * 34).toFixed(2);
    ln.setAttribute('x1', '0');
    ln.setAttribute('x2', '100');
    ln.setAttribute('y1', y);
    ln.setAttribute('y2', y);
    ln.setAttribute('class', 'mon-spark-grid');
    svg.appendChild(ln);
  });
  const area = document.createElementNS(SVG_NS, 'path');
  area.setAttribute('class', 'mon-spark-area');
  const line = document.createElementNS(SVG_NS, 'path');
  line.setAttribute('class', 'mon-spark-line');
  svg.appendChild(area);
  svg.appendChild(line);
  return {
    svg,
    draw(values) {
      const { l, a } = sparkPaths(values, 100, 34);
      line.setAttribute('d', l);
      area.setAttribute('d', a);
    },
  };
}

/** Percorsi SVG di linea e area: la serie scorre da destra verso sinistra. */
function sparkPaths(values, w, h) {
  if (!values.length) return { l: '', a: '' };
  const step = w / (MON_HIST - 1);
  const pts = values.map((v, i) => {
    const x = w - (values.length - 1 - i) * step;
    const y = h - 1 - (Math.max(0, Math.min(100, v)) / 100) * (h - 2);
    return [x.toFixed(2), y.toFixed(2)];
  });
  const l = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
  const a = `${l} L${pts[pts.length - 1][0]},${h} L${pts[0][0]},${h} Z`;
  return { l, a };
}

/** Applica al pannello lo snapshot arrivato dal server. */
function updateMonitor(tab, s) {
  const m = tab.monitor;
  if (!m) return;

  if (!s.cpu && !s.mem) {
    m.notice.textContent = i18n.t('monitor_no_data');
    m.notice.classList.remove('hidden');
    m.body.classList.add('hidden');
    return;
  }
  m.notice.classList.add('hidden');
  m.body.classList.remove('hidden');

  const headBits = [];
  if (s.uptime != null) headBits.push(`${i18n.t('monitor_uptime')} ${formatUptime(s.uptime)}`);
  if (s.procsRunning) headBits.push(`${i18n.t('monitor_tasks')} ${s.procsRunning}`);
  m.headInfo.textContent = headBits.join('  ·  ');

  // ---- CPU ----
  if (s.cpu && s.cpu.all != null) {
    push(m.hist.cpu, s.cpu.all);
    m.cpuBig.textContent = Math.round(s.cpu.all) + '%';
    m.cpuBig.className = 'mon-big ' + levelClass(s.cpu.all);
    m.cpuSpark.draw(m.hist.cpu);
    m.cpuSub.textContent = [
      s.cpuModel,
      s.cpu.cores.length ? i18n.t('monitor_cores', { n: s.cpu.cores.length }) : '',
    ].filter(Boolean).join(' · ');
    m.cpuSub.title = s.cpuModel || '';
    renderCores(m.cores, s.cpu.cores);
    const kv = [];
    if (s.load) kv.push(`${i18n.t('monitor_load')} ${s.load.map((v) => v.toFixed(2)).join('  ')}`);
    if (s.cpu.iowait != null) kv.push(`${i18n.t('monitor_iowait')} ${s.cpu.iowait.toFixed(1)}%`);
    m.cpuKv.textContent = kv.join('  ·  ');
  }

  // ---- memoria ----
  if (s.mem) {
    const pct = (s.mem.used / s.mem.total) * 100;
    const cache = s.mem.buffers + s.mem.cached;
    push(m.hist.mem, pct);
    m.memBig.textContent = Math.round(pct) + '%';
    m.memBig.className = 'mon-big ' + levelClass(pct);
    m.memSpark.draw(m.hist.mem);
    m.memSub.textContent = humanSize(s.mem.total);
    m.segUsed.style.width = pct.toFixed(1) + '%';
    m.segCache.style.width = Math.min(100 - pct, (cache / s.mem.total) * 100).toFixed(1) + '%';
    const kv = [
      i18n.t('monitor_used_of', { used: humanSize(s.mem.used), total: humanSize(s.mem.total) }),
      `${i18n.t('monitor_cache')} ${humanSize(cache)}`,
    ];
    if (s.mem.swapTotal) {
      kv.push(`${i18n.t('monitor_swap')} ${humanSize(s.mem.swapUsed)} / ${humanSize(s.mem.swapTotal)}`);
    }
    m.memKv.textContent = kv.join('  ·  ');
  }

  renderDisks(m, s.disks || []);
  renderProcs(m.procBox, s.procs || []);
}

function push(arr, v) {
  arr.push(v);
  if (arr.length > MON_HIST) arr.shift();
}

/** Barrette verticali, una per core (stile htop). */
function renderCores(box, cores) {
  if (box.childElementCount !== cores.length) {
    box.innerHTML = '';
    cores.forEach((_, i) => {
      const c = el('div', 'mon-core');
      const f = el('div', 'mon-core-fill');
      c.appendChild(f);
      c.dataset.i = i;
      box.appendChild(c);
    });
  }
  cores.forEach((v, i) => {
    const c = box.children[i];
    const f = c.firstChild;
    f.style.height = Math.max(2, Math.min(100, v)).toFixed(1) + '%';
    f.className = 'mon-core-fill ' + levelClass(v);
    c.title = `core ${i}: ${Math.round(v)}%`;
  });
}

/**
 * Barre di occupazione dei filesystem. Le righe vengono ricostruite solo se
 * l'elenco dei mount cambia, altrimenti si aggiornano in place (transizioni fluide).
 */
function renderDisks(m, disks) {
  const sig = disks.map((d) => d.mount).join('|');
  if (m.diskSig !== sig) {
    m.diskSig = sig;
    m.diskRefs = new Map();
    m.diskBox.innerHTML = '';
    if (!disks.length) {
      const empty = el('div', 'mon-empty');
      empty.textContent = i18n.t('monitor_no_disks');
      m.diskBox.appendChild(empty);
    }
    disks.forEach((d) => {
      const row = el('div', 'mon-disk');
      const top = el('div', 'mon-disk-top');
      const mount = el('span', 'mon-disk-mount');
      mount.textContent = d.mount;
      mount.title = d.fs;
      const val = el('span', 'mon-disk-val');
      const pct = el('span', 'mon-disk-pct');
      top.appendChild(mount);
      top.appendChild(val);
      top.appendChild(pct);
      const bar = el('div', 'mon-bar');
      const fill = el('div', 'mon-bar-fill');
      bar.appendChild(fill);
      row.appendChild(top);
      row.appendChild(bar);
      m.diskBox.appendChild(row);
      m.diskRefs.set(d.mount, { val, pct, fill });
    });
  }
  disks.forEach((d) => {
    const r = m.diskRefs.get(d.mount);
    if (!r) return;
    r.val.textContent = `${humanSize(d.used)} / ${humanSize(d.size)}` +
      `  ·  ${i18n.t('monitor_free')} ${humanSize(d.avail)}`;
    r.pct.textContent = Math.round(d.pct) + '%';
    r.pct.className = 'mon-disk-pct ' + levelClass(d.pct);
    r.fill.style.width = d.pct.toFixed(1) + '%';
    r.fill.className = 'mon-bar-fill ' + levelClass(d.pct);
  });
}

/** Tabella dei processi più esosi (ordinati per CPU, come htop). */
function renderProcs(box, procs) {
  box.innerHTML = '';
  const head = el('div', 'mon-proc head');
  const cols = [
    ['p-pid', 'PID'],
    ['p-user', i18n.t('monitor_col_user')],
    ['p-cmd', i18n.t('monitor_col_cmd')],
    ['p-cpu', 'CPU%'],
    ['p-mem', 'RAM%'],
  ];
  cols.forEach(([cls, label]) => {
    const c = el('span', cls);
    c.textContent = label;
    head.appendChild(c);
  });
  box.appendChild(head);

  if (!procs.length) {
    const empty = el('div', 'mon-empty');
    empty.textContent = i18n.t('monitor_no_procs');
    box.appendChild(empty);
    return;
  }
  procs.forEach((p) => {
    const row = el('div', 'mon-proc');
    const vals = [
      ['p-pid', p.pid],
      ['p-user', p.user],
      ['p-cmd', p.cmd],
      ['p-cpu ' + levelClass(p.cpu), p.cpu.toFixed(1)],
      ['p-mem ' + levelClass(p.mem), p.mem.toFixed(1)],
    ];
    vals.forEach(([cls, v]) => {
      const c = el('span', cls);
      c.textContent = v;
      row.appendChild(c);
    });
    row.title = `${p.cmd} (pid ${p.pid})`;
    box.appendChild(row);
  });
}

/** Uptime in forma compatta: "3g 4h", "5h 12m", "42m". */
function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const mi = Math.floor((sec % 3600) / 60);
  const u = { d: i18n.t('monitor_unit_d'), h: i18n.t('monitor_unit_h'), m: i18n.t('monitor_unit_m') };
  if (d) return `${d}${u.d} ${h}${u.h}`;
  if (h) return `${h}${u.h} ${mi}${u.m}`;
  return `${mi}${u.m}`;
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
    if (isScriptFile(entry.name)) {
      items.push({
        icon: 'fa-solid fa-gears',
        label: i18n.t('make_executable'),
        disabled: !!entry.isExec,
        action: () => makeExecutable(tab, entry, fullPath),
      });
    }
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
 * Riconosce il linguaggio di un file (per il syntax highlighting dell'editor)
 * dall'estensione, dal nome completo o dallo shebang della prima riga.
 * Restituisce una spec di modo CodeMirror (stringa o oggetto) oppure null.
 */
function detectEditorMode(name, content) {
  const lower = (name || '').toLowerCase();
  const byName = {
    dockerfile: 'dockerfile',
    makefile: 'text/x-sh',
    'docker-compose.yml': 'yaml',
    'docker-compose.yaml': 'yaml',
    '.bashrc': 'text/x-sh',
    '.bash_profile': 'text/x-sh',
    '.zshrc': 'text/x-sh',
    '.profile': 'text/x-sh',
    '.gitconfig': 'text/x-properties',
    'nginx.conf': 'nginx',
    'crontab': 'text/x-sh',
    'hosts': 'text/x-properties',
    'fstab': 'text/x-properties',
  };
  if (byName[lower]) return byName[lower];
  if (lower.startsWith('dockerfile')) return 'dockerfile';

  const ext = lower.includes('.') ? lower.split('.').pop() : '';
  const byExt = {
    sh: 'text/x-sh', bash: 'text/x-sh', zsh: 'text/x-sh', ksh: 'text/x-sh',
    ps1: 'powershell',
    py: 'python', py3: 'python',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'text/typescript', tsx: 'text/typescript',
    json: { name: 'javascript', json: true },
    yml: 'yaml', yaml: 'yaml',
    toml: 'toml',
    ini: 'text/x-properties', cfg: 'text/x-properties', conf: 'text/x-properties',
    properties: 'text/x-properties', env: 'text/x-properties',
    xml: 'xml', xsd: 'xml', xsl: 'xml', svg: 'xml', plist: 'xml',
    html: 'htmlmixed', htm: 'htmlmixed', vue: 'htmlmixed',
    css: 'css', scss: 'text/x-scss', less: 'text/x-less',
    sql: 'sql',
    php: 'application/x-httpd-php', phtml: 'application/x-httpd-php',
    c: 'text/x-csrc', h: 'text/x-csrc',
    cpp: 'text/x-c++src', cc: 'text/x-c++src', hpp: 'text/x-c++src', cxx: 'text/x-c++src',
    java: 'text/x-java', cs: 'text/x-csharp', scala: 'text/x-scala', kt: 'text/x-kotlin',
    go: 'go', rs: 'rust', lua: 'lua',
    pl: 'perl', pm: 'perl',
    rb: 'ruby', erb: 'ruby',
    md: 'markdown', markdown: 'markdown',
    diff: 'diff', patch: 'diff',
    log: null, txt: null,
  };
  if (Object.prototype.hasOwnProperty.call(byExt, ext)) return byExt[ext];

  // nessuna estensione utile: prova con lo shebang
  const first = (content || '').split('\n', 1)[0];
  if (/^#!.*\b(bash|sh|zsh|ksh|dash)\b/.test(first)) return 'text/x-sh';
  if (/^#!.*\bpython/.test(first)) return 'python';
  if (/^#!.*\bnode\b/.test(first)) return 'javascript';
  if (/^#!.*\bperl\b/.test(first)) return 'perl';
  if (/^#!.*\bruby\b/.test(first)) return 'ruby';
  if (/^#!.*\bphp\b/.test(first)) return 'application/x-httpd-php';
  return null;
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

  // CodeMirror trasforma la textarea in un editor con syntax highlighting;
  // se la libreria non fosse disponibile si continua con la textarea semplice.
  let cm = null;
  let cmResizeObs = null;
  const getValue = () => (cm ? cm.getValue() : ta.value);
  const isDirty = () => getValue() !== original;

  const close = () => {
    if (cmResizeObs) cmResizeObs.disconnect();
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
      await window.api.writeFile(tab.id, fullPath, getValue());
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

  if (window.CodeMirror) {
    const mode = detectEditorMode(entry.name, content);
    cm = window.CodeMirror.fromTextArea(ta, {
      mode: mode || null,
      theme: 'remote-guru',
      lineNumbers: true,
      lineWrapping: false,
      indentUnit: 2,
      tabSize: 4,
      matchBrackets: true,
      autoCloseBrackets: true,
      styleActiveLine: true,
      extraKeys: {
        'Cmd-S': () => save(),
        'Ctrl-S': () => save(),
        'Cmd-/': 'toggleComment',
        'Ctrl-/': 'toggleComment',
        Esc: () => { if (!isDirty() || confirm(i18n.t('editor_unsaved_confirm'))) close(); },
        Tab: (editor) => {
          if (editor.somethingSelected()) editor.indentSelection('add');
          else editor.replaceSelection(' '.repeat(editor.getOption('indentUnit')), 'end');
        },
      },
    });
    // l'overlay è ridimensionabile: mantieni l'editor allineato all'altezza corrente
    cmResizeObs = new ResizeObserver(() => cm.refresh());
    cmResizeObs.observe(overlay);
    cm.on('blur', () => cm.refresh());
    cm.focus();
  } else {
    ta.focus();
  }
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

/** True per i file che hanno senso rendere eseguibili (script di shell). */
function isScriptFile(name) {
  return /\.(sh|bash|zsh|ksh|run)$/i.test(name || '');
}

/** Rende eseguibile uno script (sudo chmod 777) e ricarica il listing. */
async function makeExecutable(tab, entry, fullPath) {
  try {
    await window.api.makeExecutable(tab.id, fullPath);
    toast(i18n.t('made_executable', { name: entry.name }));
    showListing(tab, tab.cwd, { fresh: true });
  } catch (e) { toast(i18n.t('generic_error', { error: e.message }), true); }
}

async function deleteEntry(tab, entry, fullPath) {
  const suffix = entry.isDir ? i18n.t('confirm_delete_entry_dir') : '';
  if (!confirm(i18n.t('confirm_delete_entry', { name: entry.name, suffix: suffix }))) return;
  try {
    await window.api.deleteEntry(tab.id, fullPath, entry.isDir);
    toast(i18n.t('entry_deleted', { name: entry.name }));
    showListing(tab, tab.cwd, { fresh: true });
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
    showListing(tab, tab.cwd, { fresh: true });
  } catch (e) { toast(i18n.t('generic_error', { error: e.message }), true); }
}

async function downloadEntry(tab, entry, fullPath) {
  try {
    const item = await window.api.queueDownload(tab.id, fullPath, entry.name, entry.isDir, entry.size);
    if (!item) return; // scelta della destinazione annullata
    toast(i18n.t('tf_queued_download', { name: entry.name }));
    openTransfers();
  } catch (e) { toast(i18n.t('download_error', { error: e.message }), true); }
}

async function importLocal(tab, destDir) {
  try {
    const items = await window.api.queueUpload(tab.id, destDir);
    if (!items || !items.length) return; // annullato
    toast(i18n.t('tf_queued_upload', { name: items.map((i) => i.name).join(', ') }));
    openTransfers();
  } catch (e) { toast(i18n.t('import_error', { error: e.message }), true); }
}

// ============================================================================
// TRASFERIMENTI FILE (pannello unico: upload + download)
// ============================================================================

/** Stato locale della coda: id -> voce ricevuta dal main. */
const transferItems = new Map();

function transfersPanel() { return $('#transfers-panel'); }

function toggleTransfers() {
  transfersPanel().classList.toggle('hidden');
}

function openTransfers() {
  transfersPanel().classList.remove('hidden');
}

/** Ordina i trasferimenti: prima gli attivi, poi i più recenti. */
function sortedTransfers() {
  const rank = { running: 0, queued: 1, paused: 2, error: 3, done: 4 };
  return [...transferItems.values()].sort((a, b) => {
    const d = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    return d !== 0 ? d : b.createdAt - a.createdAt;
  });
}

/** Ridisegna l'elenco completo (usato all'avvio e quando una voce viene rimossa). */
function renderTransfers() {
  const list = $('#tf-list');
  if (!list) return;
  list.innerHTML = '';
  const items = sortedTransfers();
  if (!items.length) {
    const empty = el('div', 'tf-empty');
    empty.textContent = i18n.t('tf_empty');
    list.appendChild(empty);
  } else {
    items.forEach((it) => list.appendChild(buildTransferRow(it)));
  }
  updateTransferBadges();
}

/** Aggiorna i contatori sui due pulsanti di apertura del pannello. */
function updateTransferBadges() {
  const active = [...transferItems.values()].filter(
    (it) => it.status === 'running' || it.status === 'queued'
  ).length;
  const pending = [...transferItems.values()].filter((it) => it.status !== 'done').length;
  [$('#btn-transfers'), $('#btn-transfers-home')].forEach((btn) => {
    if (!btn) return;
    const badge = btn.querySelector('.tf-badge');
    if (badge) {
      badge.textContent = active || pending;
      badge.classList.toggle('hidden', !(active || pending));
      badge.classList.toggle('idle', !active);
    }
    btn.title = i18n.t('tf_button_title');
  });
  // in home il pulsante compare solo se c'è qualcosa da mostrare
  const homeBtn = $('#btn-transfers-home');
  if (homeBtn) homeBtn.classList.toggle('hidden', transferItems.size === 0);
}

function buildTransferRow(it) {
  const row = el('div', 'tf-item ' + it.status);
  row.dataset.id = it.id;

  // riga 1: direzione, nome, server
  const r1 = el('div', 'tf-r1');
  const dir = el('i', it.type === 'download' ? 'fa-solid fa-arrow-down tf-dir dl' : 'fa-solid fa-arrow-up tf-dir up');
  const name = el('span', 'tf-name');
  name.textContent = it.name;
  name.title = it.type === 'download'
    ? `${it.remotePath} → ${it.localPath}`
    : `${it.localPath} → ${it.destDir}`;
  const srv = el('span', 'tf-srv');
  srv.textContent = it.serverLabel || '';
  r1.appendChild(dir);
  r1.appendChild(name);
  r1.appendChild(srv);

  // riga 2: barra, percentuale, comandi
  const r2 = el('div', 'tf-r2');
  const bar = el('div', 'tf-bar');
  const fill = el('div', 'tf-fill');
  bar.appendChild(fill);
  const pct = el('span', 'tf-pct');
  const btns = el('span', 'tf-btns');

  const playPause = el('button', 'tf-btn');
  playPause.addEventListener('click', () => {
    if (it.status === 'running' || it.status === 'queued') window.api.transferPause(it.id);
    else resumeTransfer(it.id);
  });
  const del = el('button', 'tf-btn tf-del');
  del.innerHTML = '<i class="fa-solid fa-trash"></i>';
  del.title = i18n.t('tf_remove');
  del.addEventListener('click', () => window.api.transferRemove(it.id));
  btns.appendChild(playPause);
  btns.appendChild(del);

  r2.appendChild(bar);
  r2.appendChild(pct);
  r2.appendChild(btns);

  // riga 3: byte trasferiti / totale, stato, velocità
  const r3 = el('div', 'tf-r3');
  const size = el('span', 'tf-size');
  const state = el('span', 'tf-state');
  r3.appendChild(size);
  r3.appendChild(state);

  row.appendChild(r1);
  row.appendChild(r2);
  row.appendChild(r3);

  row._refs = { fill, pct, size, state, playPause, bar };
  fillTransferRow(row, it);
  return row;
}

/** Aggiorna in place i valori di una riga (evita di ricostruire il DOM ad ogni tick). */
function fillTransferRow(row, it) {
  const { fill, pct, size, state, playPause } = row._refs;
  row.className = 'tf-item ' + it.status;

  const known = typeof it.total === 'number' && it.total > 0;
  const done = it.status === 'done';
  const percent = done ? 100 : known ? Math.min(100, Math.floor((it.transferred / it.total) * 100)) : 0;

  // totale non ancora noto (calcolo dimensioni cartella): barra indeterminata
  const indet = it.status === 'running' && !known && !done;
  row.classList.toggle('indeterminate', indet);
  fill.style.width = indet ? '' : percent + '%';
  pct.textContent = known || done ? percent + '%' : '—';

  size.textContent = known
    ? `${humanSize(it.transferred)} / ${humanSize(it.total)}`
    : it.transferred
      ? humanSize(it.transferred)
      : '';

  const parts = [i18n.t('tf_status_' + it.status)];
  if (it.status === 'running' && !known) parts[0] = i18n.t('tf_preparing');
  if (it.status === 'running' && it.speed > 0) parts.push(`${humanSize(it.speed)}/s`);
  if (it.kind === 'dir' && it.fileCount) parts.push(i18n.t('tf_files_progress', { done: it.fileDone, total: it.fileCount }));
  if (it.status === 'running' && it.currentFile) parts.push(it.currentFile);
  if (it.status === 'error' && it.error) parts.push(it.error);
  state.textContent = parts.join(' · ');
  state.classList.toggle('err', it.status === 'error');

  const running = it.status === 'running' || it.status === 'queued';
  playPause.innerHTML = running ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
  playPause.title = running ? i18n.t('tf_pause') : i18n.t('tf_resume');
  playPause.classList.toggle('hidden', done); // completato: resta solo il cestino
}

/** Riprende un trasferimento; se il server non è connesso lo segnala. */
async function resumeTransfer(id) {
  const res = await window.api.transferResume(id);
  if (res && res.ok === false && res.reason === 'no_session') {
    toast(i18n.t('tf_no_session', { server: res.server || '' }), true);
  }
}

/** Applica un aggiornamento arrivato dal main a una singola riga. */
function applyTransferUpdate(it) {
  const existed = transferItems.has(it.id);
  const prev = transferItems.get(it.id);
  transferItems.set(it.id, it);

  const list = $('#tf-list');
  const row = list && list.querySelector(`.tf-item[data-id="${it.id}"]`);
  // nuova voce, o cambio di stato che altera l'ordinamento: ridisegna tutto
  if (!existed || !row || (prev && prev.status !== it.status)) renderTransfers();
  else { fillTransferRow(row, it); updateTransferBadges(); }

  if (!prev || prev.status === it.status) return;
  if (it.status === 'done') {
    toast(i18n.t('tf_done', { name: it.name }));
    // se il file browser mostra la cartella coinvolta, aggiornalo
    if (it.type === 'upload') refreshListingFor(it.destDir);
  } else if (it.status === 'error') {
    toast(i18n.t('tf_failed', { name: it.name, error: it.error || '' }), true);
  }
}

/** Ricarica il listing delle schede che stanno mostrando la cartella indicata. */
function refreshListingFor(dir) {
  if (!dir) return;
  tabs.forEach((tab) => {
    // solo se a schermo c'è davvero il file browser: un editor o un pannello
    // Docker aperto sulla stessa cartella non va sostituito
    if (tab.cwd === dir && tab.hostEl && tab.hostEl.querySelector('.ll-overlay.ll-files')) {
      showListing(tab, dir, { fresh: true });
    }
  });
}

/** Carica la coda esistente all'avvio (comprese le voci sospese da una sessione precedente). */
async function initTransfers() {
  $('#btn-transfers').addEventListener('click', toggleTransfers);
  $('#btn-transfers-home').addEventListener('click', toggleTransfers);
  $('#tf-close').addEventListener('click', () => transfersPanel().classList.add('hidden'));
  $('#tf-clear').addEventListener('click', () => window.api.transferClearDone());

  window.api.onTransferUpdate(applyTransferUpdate);
  window.api.onTransferRemoved(({ id }) => {
    transferItems.delete(id);
    renderTransfers();
  });

  try {
    const list = await window.api.transferList();
    list.forEach((it) => transferItems.set(it.id, it));
  } catch (_) { /* nessuna coda salvata */ }
  renderTransfers();
  const pending = [...transferItems.values()].filter((it) => it.status !== 'done').length;
  if (pending) toast(i18n.t('tf_pending_on_start', { count: pending }));
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

  // Bottone split view nella barra delle schede
  const splitBtn = $('#btn-split');
  if (splitBtn) splitBtn.dataset.tip = i18n.t('split_view_button_title');

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

  const configLabel = document.querySelector('#settings-card-config .settings-row label');
  if (configLabel) configLabel.textContent = i18n.t('settings_config_label');

  const importBtn = $('#btn-import');
  if (importBtn) importBtn.innerHTML = `<i class="fa-solid fa-upload"></i> ${i18n.t('settings_btn_import')}`;

  const exportBtn = $('#btn-export');
  if (exportBtn) exportBtn.innerHTML = `<i class="fa-solid fa-download"></i> ${i18n.t('settings_btn_export')}`;

  // Card scorciatoie da tastiera
  const scLabel = document.querySelector('#settings-card-shortcuts .settings-row > label');
  if (scLabel) scLabel.textContent = i18n.t('settings_shortcuts_label');
  const scHint = $('#shortcuts-hint');
  if (scHint) scHint.textContent = i18n.t('settings_shortcuts_hint');
  const scReset = $('#btn-shortcuts-reset');
  if (scReset) scReset.innerHTML = `<i class="fa-solid fa-rotate-left"></i> ${i18n.t('shortcut_reset')}`;
  renderShortcutsSettings(); // etichette e nomi dei tasti nella nuova lingua

  const backBtn = $('#btn-settings-back');
  if (backBtn) backBtn.innerHTML = `<i class="fa-solid fa-arrow-left"></i> ${i18n.t('settings_title')}`;

  const homeBackBtn = $('#btn-back');
  if (homeBackBtn) homeBackBtn.innerHTML = `<i class="fa-solid fa-arrow-left"></i> ${i18n.t('back_to_active_sessions')}`;

  // Search placeholder
  const searchInput = $('#server-search');
  if (searchInput) searchInput.placeholder = i18n.t('search_placeholder');

  // Pannello trasferimenti file
  const tfTitle = document.querySelector('#transfers-panel .tf-title');
  if (tfTitle) tfTitle.innerHTML = `<i class="fa-solid fa-right-left"></i> ${i18n.t('tf_title')}`;
  const tfClearBtn = $('#tf-clear');
  if (tfClearBtn) tfClearBtn.title = i18n.t('tf_clear_done');
  const tfCloseBtn = $('#tf-close');
  if (tfCloseBtn) tfCloseBtn.title = i18n.t('tf_close');
  const tfHomeBtn = $('#btn-transfers-home');
  if (tfHomeBtn) {
    tfHomeBtn.innerHTML =
      `<i class="fa-solid fa-right-left"></i> ${i18n.t('tf_title')} <span class="tf-badge">0</span>`;
  }
  renderTransfers(); // ricostruisce le righe con la nuova lingua e i badge
}

// ============================================================================
// SCORCIATOIE DA TASTIERA
// ============================================================================
//
// Ogni funzione della scheda (barra azioni del pane + gestione schede) può
// essere richiamata da tastiera. Una scorciatoia è una stringa canonica:
//
//   "Meta+K", "Ctrl+Shift+D", "Ctrl+Tab", "Alt+F5"   -> combinazione
//   "Double+Shift"                                    -> doppio tap sul modificatore
//
// Le combinazioni personalizzate sono salvate in localStorage solo come
// differenze rispetto ai valori predefiniti (stringa vuota = disattivata),
// così i default possono cambiare senza rompere le scelte dell'utente.

const IS_MAC = /mac/i.test(navigator.platform || navigator.userAgent);
// modificatore "di sistema": Cmd su macOS, Ctrl+Shift altrove (Ctrl+lettera
// da solo servirebbe alla shell remota, es. Ctrl+C)
const MOD = IS_MAC ? 'Meta' : 'Ctrl+Shift';

/** Azioni di gestione schede, in aggiunta a quelle della barra (TAB_ACTIONS). */
const TAB_EXTRA_ACTIONS = [
  { id: 'split',     icon: 'fa-solid fa-table-columns', labelKey: 'shortcut_split',     run: () => toggleSplit(activeTabId) },
  { id: 'transfers', icon: 'fa-solid fa-right-left',    labelKey: 'shortcut_transfers', run: () => toggleTransfers() },
  { id: 'nextTab',   icon: 'fa-solid fa-arrow-right',   labelKey: 'shortcut_next_tab',  run: () => cycleTab(1) },
  { id: 'prevTab',   icon: 'fa-solid fa-arrow-left',    labelKey: 'shortcut_prev_tab',  run: () => cycleTab(-1) },
  { id: 'closeTab',  icon: 'fa-solid fa-xmark',         labelKey: 'shortcut_close_tab', run: (tab) => closeTab(tab.id) },
];

/** Elenco completo delle azioni associabili a una scorciatoia. */
const SHORTCUT_ACTIONS = [...TAB_ACTIONS, ...TAB_EXTRA_ACTIONS];

const DEFAULT_SHORTCUTS = {
  files: 'Double+Shift', // richiesta esplicita: doppio tap su Shift apre il file explorer
  clear: `${MOD}+K`,
  docker: `${MOD}+D`,
  images: `${MOD}+I`,
  databases: `${MOD}+B`,
  screens: `${MOD}+E`,
  cron: `${MOD}+J`,
  monitor: `${MOD}+G`,
  split: `${MOD}+L`,
  transfers: `${MOD}+U`,
  nextTab: 'Ctrl+Tab',
  prevTab: 'Ctrl+Shift+Tab',
  closeTab: `${MOD}+Backspace`,
};

const SHORTCUTS_KEY = 'shortcuts';
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);
const MOD_NAMES = { Shift: 'Shift', Control: 'Ctrl', Alt: 'Alt', Meta: 'Meta' };
const DOUBLE_TAP_MS = 400; // finestra massima fra i due tap
const MAX_HOLD_MS = 600;   // oltre questa durata la pressione non è più un "tap"

let shortcutOverrides = {}; // id azione -> combinazione ('' = nessuna)
let activeBindings = new Map(); // combinazione -> azione

// ---------- lettura/scrittura delle preferenze ----------

function loadShortcuts() {
  try {
    const raw = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) || '{}');
    shortcutOverrides = raw && typeof raw === 'object' ? raw : {};
  } catch (_) {
    shortcutOverrides = {};
  }
  refreshBindings();
}

/** Combinazione attiva per un'azione ('' se disattivata). */
function shortcutFor(id) {
  return Object.prototype.hasOwnProperty.call(shortcutOverrides, id)
    ? shortcutOverrides[id] || ''
    : DEFAULT_SHORTCUTS[id] || '';
}

/** Ricostruisce la mappa combinazione -> azione usata dal dispatcher. */
function refreshBindings() {
  activeBindings = new Map();
  SHORTCUT_ACTIONS.forEach((a) => {
    const b = shortcutFor(a.id);
    if (b) activeBindings.set(b, a);
  });
}

function persistShortcuts() {
  localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(shortcutOverrides));
  refreshBindings();
}

/** Assegna una combinazione a un'azione; se era di un'altra azione, la libera. */
function setShortcut(id, binding) {
  let stolenFrom = null;
  if (binding) {
    const owner = SHORTCUT_ACTIONS.find((a) => a.id !== id && shortcutFor(a.id) === binding);
    if (owner) {
      shortcutOverrides[owner.id] = '';
      stolenFrom = owner;
    }
  }
  shortcutOverrides[id] = binding;
  persistShortcuts();
  return stolenFrom;
}

function resetShortcuts() {
  shortcutOverrides = {};
  persistShortcuts();
}

// ---------- combinazioni: lettura dall'evento e formattazione ----------

/** Nome canonico del tasto: usa il tasto fisico per lettere e cifre, così
 *  Shift/Alt non cambiano la combinazione (su macOS Alt+e -> "´"). */
function normalizeKeyName(key, code) {
  if (!key) return '';
  if (key === ' ' || code === 'Space') return 'Space';
  if (key.length === 1) {
    const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(code || '');
    return m ? (m[1] || m[2]) : key.toUpperCase();
  }
  return key; // Tab, Enter, Backspace, Escape, ArrowLeft, F5, …
}

/** Combinazione canonica da un keydown, oppure '' se non è valida. */
function bindingFromEvent(e) {
  if (MODIFIER_KEYS.has(e.key)) return '';
  const name = normalizeKeyName(e.key, e.code);
  if (!name) return '';
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  // senza modificatori il tasto servirebbe alla shell: si accettano solo i tasti funzione
  if (!mods.length && !/^F\d{1,2}$/.test(name)) return '';
  return [...mods, name].join('+');
}

/** Simbolo leggibile di un singolo tasto (⌘, ⇧, ⌫ … su macOS). */
function keySymbol(k) {
  const common = { Space: '␣', Backspace: '⌫', Enter: '⏎', Tab: '⇥', Escape: 'Esc',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  const mac = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
  const other = { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };
  return (IS_MAC ? mac[k] : other[k]) || common[k] || k;
}

/** Testo mostrato all'utente per una combinazione. */
function formatBinding(binding) {
  if (!binding) return i18n.t('shortcut_none');
  const dbl = /^Double\+(.+)$/.exec(binding);
  if (dbl) return i18n.t('shortcut_double_tap', { key: keySymbol(dbl[1]) });
  return binding.split('+').map(keySymbol).join(IS_MAC ? ' ' : ' + ');
}

// ---------- doppio tap su un modificatore ----------
//
// Un tap è valido solo se il modificatore viene premuto e rilasciato da solo,
// senza altri tasti nel mezzo e senza restare premuto: così scrivere lettere
// maiuscole nel terminale non fa scattare il doppio Shift.

let tapKey = null;      // modificatore attualmente premuto
let tapDownAt = 0;      // istante della pressione
let tapDirty = false;   // durante la pressione è stato premuto altro
let lastTapKey = null;  // primo tap in attesa del secondo
let lastTapAt = 0;

function resetTapState() {
  tapKey = null;
  tapDirty = false;
  lastTapKey = null;
}

function trackTapKeyDown(e) {
  if (MODIFIER_KEYS.has(e.key)) {
    if (e.repeat) { tapDirty = true; return; } // tenuto premuto: non è un tap
    if (tapKey && tapKey !== e.key) tapDirty = true; // due modificatori insieme
    else { tapDownAt = performance.now(); tapDirty = false; }
    tapKey = e.key;
    return;
  }
  tapDirty = true; // un tasto normale annulla la sequenza in corso
  lastTapKey = null;
}

/** Restituisce "Double+X" se il keyup completa un doppio tap, altrimenti ''. */
function trackTapKeyUp(e) {
  if (!MODIFIER_KEYS.has(e.key)) return '';
  const now = performance.now();
  const clean = !tapDirty && tapKey === e.key && now - tapDownAt < MAX_HOLD_MS
    && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
  tapKey = null;
  tapDirty = false;
  if (!clean) { lastTapKey = null; return ''; }
  if (lastTapKey === e.key && now - lastTapAt < DOUBLE_TAP_MS) {
    lastTapKey = null;
    return 'Double+' + MOD_NAMES[e.key];
  }
  lastTapKey = e.key;
  lastTapAt = now;
  return '';
}

// ---------- dispatcher globale ----------

/** Le scorciatoie valgono solo sulla scheda attiva e non mentre si scrive in un campo. */
function shortcutsAllowed(e) {
  if (recording) return false;
  if (!$('#terminal-view').classList.contains('active')) return false;
  if (!activeTabId || !tabs.has(activeTabId)) return false;
  const t = e.target;
  if (t && t.closest) {
    const field = t.closest('input, textarea, select, [contenteditable="true"]');
    // il terminale usa una textarea nascosta: lì le scorciatoie devono funzionare
    if (field && !field.classList.contains('xterm-helper-textarea')) return false;
  }
  return true;
}

function runShortcut(binding) {
  const action = activeBindings.get(binding);
  const tab = tabs.get(activeTabId);
  if (!action || !tab) return false;
  action.run(tab);
  return true;
}

function setupShortcuts() {
  loadShortcuts();

  // fase di capture: la combinazione non deve arrivare né al terminale né al resto della UI
  window.addEventListener('keydown', (e) => {
    trackTapKeyDown(e);
    if (e.repeat || MODIFIER_KEYS.has(e.key)) return;
    const binding = bindingFromEvent(e);
    if (!binding || !activeBindings.has(binding) || !shortcutsAllowed(e)) return;
    e.preventDefault();
    e.stopPropagation();
    runShortcut(binding);
  }, true);

  // i doppi tap si riconoscono al rilascio del modificatore
  window.addEventListener('keyup', (e) => {
    const binding = trackTapKeyUp(e);
    if (!binding || !activeBindings.has(binding) || !shortcutsAllowed(e)) return;
    e.preventDefault();
    runShortcut(binding);
  }, true);

  // premere un modificatore, cambiare finestra e tornare non deve valere come tap
  window.addEventListener('blur', resetTapState);
}

// ---------- pannello impostazioni: elenco e registrazione ----------

let recording = null; // { action } dell'azione in attesa della nuova combinazione

function renderShortcutsSettings() {
  const list = $('#shortcuts-list');
  if (!list) return;
  list.innerHTML = '';
  SHORTCUT_ACTIONS.forEach((a) => {
    const binding = shortcutFor(a.id);
    const isRec = !!recording && recording.action.id === a.id;
    const row = el('div', 'sc-row');

    const name = el('span', 'sc-name');
    name.innerHTML = `<i class="${a.icon}"></i> ${escapeHtml(i18n.t(a.labelKey))}`;

    const btn = el('button', 'sc-key' + (binding ? '' : ' sc-empty') + (isRec ? ' recording' : ''));
    btn.textContent = isRec ? i18n.t('shortcut_press_keys') : formatBinding(binding);
    btn.title = i18n.t('shortcut_click_to_record');
    btn.addEventListener('click', () => startRecording(a));

    const clear = el('button', 'sc-clear');
    clear.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    clear.title = i18n.t('shortcut_clear');
    clear.disabled = !binding;
    clear.addEventListener('click', () => {
      stopRecording();
      setShortcut(a.id, '');
      renderShortcutsSettings();
    });

    row.appendChild(name);
    row.appendChild(btn);
    row.appendChild(clear);
    list.appendChild(row);
  });
}

/** Mette una riga in attesa della combinazione da premere. */
function startRecording(action) {
  const first = !recording;
  recording = { action };
  resetTapState();
  renderShortcutsSettings(); // evidenzia la riga in registrazione
  if (!first) return;
  window.addEventListener('keydown', onRecordKeyDown, true);
  window.addEventListener('keyup', onRecordKeyUp, true);
  // agganciato dopo il clic corrente, altrimenti annullerebbe subito l'attesa
  setTimeout(() => document.addEventListener('mousedown', onRecordOutside, true));
}

function stopRecording() {
  if (!recording) return;
  window.removeEventListener('keydown', onRecordKeyDown, true);
  window.removeEventListener('keyup', onRecordKeyUp, true);
  document.removeEventListener('mousedown', onRecordOutside, true);
  recording = null;
  resetTapState();
  renderShortcutsSettings();
}

/** Un clic fuori dalle scorciatoie annulla l'attesa. */
function onRecordOutside(e) {
  const t = e.target;
  if (t && t.closest && t.closest('.sc-key')) return; // si sta scegliendo un'altra riga
  stopRecording();
}

function onRecordKeyDown(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;
  if (MODIFIER_KEYS.has(e.key)) return trackTapKeyDown(e); // può diventare un doppio tap
  if (e.key === 'Escape') return stopRecording();
  const binding = bindingFromEvent(e);
  if (!binding) return toast(i18n.t('shortcut_need_modifier'), true);
  commitRecording(binding);
}

function onRecordKeyUp(e) {
  const binding = trackTapKeyUp(e);
  if (!binding) return;
  e.preventDefault();
  e.stopPropagation();
  commitRecording(binding);
}

function commitRecording(binding) {
  const action = recording.action;
  const stolenFrom = setShortcut(action.id, binding);
  stopRecording();
  toast(i18n.t('shortcut_saved', {
    action: i18n.t(action.labelKey),
    keys: formatBinding(binding),
  }));
  if (stolenFrom) {
    toast(i18n.t('shortcut_conflict', { action: i18n.t(stolenFrom.labelKey) }), true);
  }
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

  setupEdgeSnap();
  setupTooltips();

  // scorciatoie da tastiera: carica le associazioni salvate e disegna l'elenco
  setupShortcuts();
  renderShortcutsSettings();
  $('#btn-shortcuts-reset').addEventListener('click', () => {
    stopRecording();
    resetShortcuts();
    renderShortcutsSettings();
    toast(i18n.t('shortcut_reset_done'));
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
  $('#btn-split').addEventListener('click', () => toggleSplit(activeTabId));
  $('#btn-home').addEventListener('click', () => showView('config'));
  $('#btn-back').addEventListener('click', () => {
    if (tabs.size > 0) { showView('terminal'); layout(); }
  });

  // coda trasferimenti: eventi, elenco iniziale (anche voci sospese da sessioni precedenti)
  await initTransfers();

  document.addEventListener('click', hideContextMenu);
  window.addEventListener('resize', fitAll);

  // focus iniziale sulla barra di ricerca dei server
  $('#server-search').focus();
});

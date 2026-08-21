'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

/**
 * Formati di archivio gestiti da `compress`/`extract`.
 *  - `kind: 'tar'`  -> tar con il flag di decompressione adatto
 *  - `kind: 'zip'`  -> unzip
 *  - `kind: 'single'` -> singolo file compresso (gz/bz2/xz), si decomprime su stdout
 * L'ordine conta: `.tar.gz` va riconosciuto prima di `.gz`.
 */
const ARCHIVE_FORMATS = [
  { re: /\.tar\.gz$|\.tgz$/i, kind: 'tar', x: '-xzf', t: '-tzf' },
  { re: /\.tar\.bz2$|\.tbz2?$/i, kind: 'tar', x: '-xjf', t: '-tjf' },
  { re: /\.tar\.xz$|\.txz$/i, kind: 'tar', x: '-xJf', t: '-tJf' },
  { re: /\.tar$/i, kind: 'tar', x: '-xf', t: '-tf' },
  { re: /\.zip$/i, kind: 'zip' },
  { re: /\.gz$/i, kind: 'single', dec: 'gzip -dc', tool: 'gzip' },
  { re: /\.bz2$/i, kind: 'single', dec: 'bzip2 -dc', tool: 'bzip2' },
  { re: /\.xz$/i, kind: 'single', dec: 'xz -dc', tool: 'xz' },
];

/**
 * Gestisce tutte le sessioni SSH attive.
 * Ogni sessione = 1 connessione ssh2 + 1 shell PTY (canale principale del terminale)
 * + SFTP on-demand (usato per il listing strutturato "ll", download, delete, ecc.).
 *
 * Architettura "ibrida": il terminale è una vera shell PTY (compatibile con vim/htop/...),
 * mentre le funzioni speciali (ll cliccabile, gestione file) passano da SFTP/exec.
 */
class SshManager {
  constructor() {
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    this._seq = 0;
  }

  /**
   * @param {object} server  voce di servers.json
   * @param {(id:string, data:string)=>void} onData   output della shell (già pulito dal marker CWD)
   * @param {(id:string, cwd:string)=>void} onCwd      aggiornamento della cwd corrente
   * @param {(id:string)=>void} onClose
   * @returns {Promise<{id:string, cwd:string}>}
   */
  connect(server, onData, onCwd, onSty, onClose) {
    return new Promise((resolve, reject) => {
      const id = 's' + ++this._seq + '_' + Date.now();
      const client = new Client();

      const connConfig = {
        host: server.host,
        port: server.port || 22,
        username: server.username,
        readyTimeout: 20000,
        keepaliveInterval: 15000,
      };

      if (server.usePem) {
        let pem;
        try {
          pem = fs.readFileSync(server.pemPath);
        } catch (e) {
          return reject(new Error('Impossibile leggere il file PEM: ' + e.message));
        }
        connConfig.privateKey = pem;
        // passphrase dedicata; per retro-compatibilità accetta anche il vecchio campo password
        const passphrase = server.passphrase || server.password;
        if (passphrase) connConfig.passphrase = passphrase;
      } else {
        connConfig.password = server.password || '';
      }

      client.on('ready', () => {
        client.shell({ term: 'xterm-256color' }, (err, stream) => {
          if (err) {
            client.end();
            return reject(err);
          }

          const session = new Session(id, client, stream, server);
          this.sessions.set(id, session);

          // Stream della shell: estraiamo il marker CWD e inoltriamo il resto al renderer.
          stream.on('data', (chunk) => {
            const { clean, cwd, sty, styFound } = session.extractMarkers(chunk.toString('utf8'));
            if (cwd && cwd !== session.cwd) {
              session.cwd = cwd;
              onCwd(id, cwd);
            }
            // emesso ad ogni prompt: STY vuoto = shell esterna, valorizzato = dentro screen
            if (styFound) onSty(id, sty);
            if (clean.length) onData(id, clean);
          });
          stream.stderr.on('data', (chunk) => onData(id, chunk.toString('utf8')));

          stream.on('close', () => {
            this.sessions.delete(id);
            try { client.end(); } catch (_) {}
            onClose(id);
          });

          // Ricaviamo la home come cwd iniziale e installiamo l'emettitore di CWD.
          this._initCwd(session);

          resolve({ id, cwd: session.cwd });
        });
      });

      client.on('error', (err) => {
        if (!this.sessions.has(id)) reject(err);
        else onClose(id);
      });

      client.connect(connConfig);
    });
  }

  /**
   * Configura la shell affinché emetta la cwd dopo ogni prompt tramite un marker
   * invisibile (OSC custom 1337;CWD=...). Funziona sia con bash che con zsh.
   */
  _initCwd(session) {
    const marker =
      `__RG() { printf '\\033]1337;CWD=%s\\007' "$PWD"; printf '\\033]1337;STY=%s\\007' "$STY"; }; ` +
      `PROMPT_COMMAND="__RG;$PROMPT_COMMAND"; ` +
      `if [ -n "$ZSH_VERSION" ]; then precmd() { __RG; }; setopt ignoreeof 2>/dev/null; ` +
      `else export IGNOREEOF=1; fi; ` +
      // ^ evita che un Ctrl-D accidentale (es. durante il detach da screen)
      //   chiuda la shell e quindi la connessione SSH.
      // cartella di partenza: /opt se esiste, altrimenti la root
      `cd /opt 2>/dev/null || cd /; ` +
      `__RG; clear\n`;
    // piccolo ritardo per far stabilizzare il prompt iniziale
    setTimeout(() => {
      try { session.stream.write(marker); } catch (_) {}
    }, 300);
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Sessione non trovata: ' + id);
    return s;
  }

  write(id, data) {
    this.get(id).stream.write(data);
  }

  resize(id, cols, rows) {
    try { this.get(id).stream.setWindow(rows, cols, 0, 0); } catch (_) {}
  }

  disconnect(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    try { s.stream.end(); } catch (_) {}
    try { s.client.end(); } catch (_) {}
    this.sessions.delete(id);
  }

  // ---- Operazioni SFTP / file ------------------------------------------------

  _sftp(id) {
    const s = this.get(id);
    return new Promise((resolve, reject) => {
      if (s.sftp) return resolve(s.sftp);
      s.client.sftp((err, sftp) => {
        if (err) return reject(err);
        s.sftp = sftp;
        resolve(sftp);
      });
    });
  }

  /** Canale SFTP della sessione (usato dal gestore dei trasferimenti). */
  sftp(id) {
    return this._sftp(id);
  }

  /**
   * Canale SFTP dedicato alla navigazione (listing / realpath), separato da
   * quello restituito da `_sftp` — condiviso con trasferimenti, editor e
   * dump/restore. Senza questa separazione una `readdir` finisce in coda dietro
   * i pacchetti dati di un upload/download in corso e il file browser diventa
   * lentissimo proprio mentre serve.
   */
  _browseSftp(id) {
    const s = this.get(id);
    if (s.sftpBrowse) return Promise.resolve(s.sftpBrowse);
    // più richieste in volo devono aprire un solo canale
    if (s.sftpBrowsePending) return s.sftpBrowsePending;
    s.sftpBrowsePending = new Promise((resolve, reject) => {
      s.client.sftp((err, sftp) => {
        s.sftpBrowsePending = null;
        if (err) return reject(err);
        s.sftpBrowse = sftp;
        // se il canale cade, la richiesta successiva ne apre uno nuovo
        const drop = () => { if (s.sftpBrowse === sftp) s.sftpBrowse = null; };
        sftp.on('close', drop);
        sftp.on('error', drop);
        resolve(sftp);
      });
    });
    return s.sftpBrowsePending;
  }

  /** True se la sessione è ancora aperta (senza lanciare eccezioni). */
  hasSession(id) {
    return this.sessions.has(id);
  }

  /** Chiave ed etichetta del server di una sessione (per la lista trasferimenti). */
  serverInfo(id) {
    const srv = this.get(id).server;
    return { key: serverKey(srv), label: srv.nickname || srv.name || srv.host || '' };
  }

  /**
   * Prima sessione aperta sullo stesso server (stesso utente/host/porta).
   * Serve per riprendere un trasferimento dopo una riconnessione o un riavvio.
   */
  findSessionByServerKey(key) {
    for (const [id, s] of this.sessions) {
      if (serverKey(s.server) === key) return id;
    }
    return null;
  }

  /** Elenca il contenuto di una cartella (per il bottone "ll" / cartelle cliccabili). */
  async listDir(id, dir) {
    const sftp = await this._browseSftp(id);
    const target = dir || this.get(id).cwd || '.';
    const abs = await new Promise((resolve, reject) => {
      sftp.realpath(target, (err, p) => (err ? reject(err) : resolve(p)));
    });
    const list = await new Promise((resolve, reject) => {
      sftp.readdir(abs, (err, l) => (err ? reject(err) : resolve(l)));
    });
    const entries = list.map((e) => {
      const m = e.attrs.mode;
      const isDir = (m & 0o170000) === 0o040000;
      const isLink = (m & 0o170000) === 0o120000;
      return {
        name: e.filename,
        isDir,
        isLink,
        // eseguibile: almeno un bit x (utente, gruppo o altri) e non è una cartella
        isExec: !isDir && (m & 0o111) !== 0,
        size: e.attrs.size,
        mtime: e.attrs.mtime,
        mode: m & 0o7777,
        longname: e.longname,
      };
    });
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { cwd: abs, entries };
  }

  /** Rende eseguibile un file (sudo chmod 777): utile per gli script .sh. */
  async makeExecutable(id, remotePath) {
    return this.sudoExec(id, `chmod 777 ${shellQuote(remotePath)}`);
  }

  /** Risolve un path relativo rispetto alla cwd in path assoluto. */
  async realpath(id, p) {
    const sftp = await this._browseSftp(id);
    return new Promise((resolve, reject) => {
      sftp.realpath(p, (err, rp) => (err ? reject(err) : resolve(rp)));
    });
  }

  async deleteEntry(id, remotePath, isDir) {
    // sempre con sudo (file e cartelle): gestisce anche percorsi protetti
    return this.sudoExec(id, `rm -rf ${shellQuote(remotePath)}`);
  }

  /**
   * Copia remoto->remoto (usato da copia/incolla), con privilegi sudo.
   * Aggiunge un suffisso "_copy" al nome (e "_copy2", "_copy3", … se necessario)
   * così da non sovrascrivere l'originale o file già presenti. Ritorna il nome
   * effettivamente creato.
   */
  async copyRemote(id, src, destDir, isDir) {
    const flag = isDir ? '-r' : '';
    const base = path.basename(src);
    // separa nome ed estensione (solo per i file; le cartelle restano intere)
    let stem = base, ext = '';
    if (!isDir) {
      const dot = base.lastIndexOf('.');
      if (dot > 0) { stem = base.slice(0, dot); ext = base.slice(dot); }
    }
    let candidate = `${stem}_copy${ext}`;
    for (let n = 2; await this._remoteExists(id, `${destDir}/${candidate}`); n++) {
      candidate = `${stem}_copy${n}${ext}`;
    }
    const dest = `${destDir}/${candidate}`;
    await this.sudoExec(id, `cp ${flag} ${shellQuote(src)} ${shellQuote(dest)}`);
    return candidate;
  }

  /**
   * Copia remoto->remoto conservando il nome (usata dal drag&drop fra file
   * browser sullo stesso server). A differenza di `copyRemote` non aggiunge il
   * suffisso "_copy": è una copia esatta, quindi sovrascrive un omonimo nella
   * destinazione, come fa l'upload. Rifiuta la copia di una cartella dentro se
   * stessa, che con `cp -r` andrebbe in ricorsione.
   */
  async copyInto(id, src, destDir, isDir) {
    const clean = String(src).replace(/\/+$/, '');
    const dest = String(destDir).replace(/\/+$/, '') || '/';
    if (dest === clean || dest.startsWith(clean + '/')) {
      throw new Error('Impossibile copiare una cartella dentro se stessa');
    }
    if (dest === path.dirname(clean)) {
      throw new Error('Origine e destinazione coincidono');
    }
    const flag = isDir ? '-r' : '';
    await this.sudoExec(id, `cp ${flag} ${shellQuote(clean)} ${shellQuote(dest)}/`);
    return path.basename(clean);
  }

  /**
   * Verifica (con sudo) se un percorso remoto è già occupato. Include i link
   * simbolici rotti (`test -e` da solo li considera inesistenti, ma il nome è
   * comunque preso e un `mv` li sovrascriverebbe).
   */
  async _remoteExists(id, remotePath) {
    const q = shellQuote(remotePath);
    try {
      await this.sudoExec(id, `[ -e ${q} ] || [ -L ${q} ]`);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Primo nome libero in `dir` partendo da `base`: `base`, `base_2`, `base_3`, …
   * Usato dall'estrazione degli archivi per non sovrascrivere nulla.
   */
  async _uniqueName(id, dir, base) {
    let candidate = base;
    for (let n = 2; await this._remoteExists(id, `${dir}/${candidate}`); n++) {
      candidate = `${base}_${n}`;
    }
    return candidate;
  }

  /**
   * `sudoExec` con messaggio d'errore parlante quando sul server manca il
   * comando richiesto (tipico di `zip`, che spesso non è installato).
   */
  async _execTool(id, cmd, tool, hint) {
    try {
      return await this.sudoExec(id, cmd);
    } catch (e) {
      if (tool && (e.code === 127 || /command not found|not installed/i.test(e.message))) {
        throw missingToolError(tool, hint);
      }
      throw e;
    }
  }

  /** True se il comando esiste sul server (nel PATH usato da sudo). */
  async _hasTool(id, tool) {
    try {
      await this.sudoExec(id, `command -v ${shellQuote(tool)} >/dev/null 2>&1`);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Crea un file vuoto (touch) nel percorso indicato, con privilegi sudo. */
  async createFile(id, remotePath) {
    return this.sudoExec(id, `touch ${shellQuote(remotePath)}`);
  }

  /** Crea una cartella (mkdir -p) nel percorso indicato, con privilegi sudo. */
  async makeDir(id, remotePath) {
    if (await this._remoteExists(id, remotePath)) {
      throw new Error(`Esiste già: ${path.basename(remotePath)}`);
    }
    await this.sudoExec(id, `mkdir -p ${shellQuote(remotePath)}`);
    return path.basename(remotePath);
  }

  /**
   * Rinomina una voce (`mv` nella stessa cartella). Rifiuta l'operazione se il
   * nuovo nome è già occupato: rinominare non deve mai sovrascrivere.
   */
  async renameEntry(id, oldPath, newPath) {
    const from = String(oldPath).replace(/\/+$/, '');
    const to = String(newPath).replace(/\/+$/, '');
    if (!to || to === '/') throw new Error('Nome non valido');
    if (from === to) return path.basename(to);
    if (await this._remoteExists(id, to)) {
      throw new Error(`Esiste già: ${path.basename(to)}`);
    }
    await this.sudoExec(id, `mv -- ${shellQuote(from)} ${shellQuote(to)}`);
    return path.basename(to);
  }

  /**
   * Sposta una voce dentro `destDir` conservando il nome (taglia/incolla).
   * Come `copyInto` rifiuta i casi degeneri: cartella dentro se stessa e
   * destinazione che coincide con la cartella di partenza.
   */
  async moveInto(id, src, destDir) {
    const clean = String(src).replace(/\/+$/, '');
    const dest = String(destDir).replace(/\/+$/, '') || '/';
    if (dest === clean || dest.startsWith(clean + '/')) {
      throw new Error('Impossibile spostare una cartella dentro se stessa');
    }
    if (dest === path.dirname(clean)) {
      throw new Error('Origine e destinazione coincidono');
    }
    await this.sudoExec(id, `mv -- ${shellQuote(clean)} ${shellQuote(dest)}/`);
    return path.basename(clean);
  }

  /**
   * Elimina più voci (selezione multipla) con un solo `rm` ogni 40 percorsi,
   * per non superare la lunghezza massima della riga di comando.
   */
  async deleteMany(id, paths) {
    const list = (paths || []).filter(Boolean);
    for (let i = 0; i < list.length; i += 40) {
      const chunk = list.slice(i, i + 40).map(shellQuote).join(' ');
      await this.sudoExec(id, `rm -rf -- ${chunk}`);
    }
    return list.length;
  }

  /**
   * Dimensione ricorsiva di una cartella in byte (`du`). Con `du` di BusyBox,
   * che non ha `-b`, si ripiega su `-sk` (KiB) e si moltiplica.
   */
  async dirSize(id, remotePath) {
    const q = shellQuote(remotePath);
    try {
      const out = await this.sudoExec(id, `du -sb -- ${q}`);
      return parseInt(String(out).trim().split(/\s+/)[0], 10) || 0;
    } catch (_) {
      const out = await this.sudoExec(id, `du -sk -- ${q}`);
      return (parseInt(String(out).trim().split(/\s+/)[0], 10) || 0) * 1024;
    }
  }

  /**
   * Metadati di una voce (finestra "Proprietà"): tipo, proprietario, permessi,
   * dimensione, date e, per i link simbolici, il percorso puntato.
   * Un campo per riga: così i nomi con spazi non rompono il parsing.
   */
  async pathInfo(id, remotePath) {
    const q = shellQuote(remotePath);
    const fmt = '%F\\n%U\\n%G\\n%a\\n%A\\n%s\\n%Y\\n%X\\n%h';
    const out = await this.sudoExec(id, `stat -c ${shellQuote(fmt)} -- ${q}`);
    const f = String(out).split('\n').map((x) => x.trim());
    const info = {
      path: remotePath,
      type: f[0] || '',
      owner: f[1] || '',
      group: f[2] || '',
      mode: f[3] || '',
      modeText: f[4] || '',
      size: Number(f[5]) || 0,
      mtime: Number(f[6]) || 0,
      atime: Number(f[7]) || 0,
      links: Number(f[8]) || 0,
      target: null,
    };
    if (/link/i.test(info.type)) {
      try {
        info.target = String(await this.sudoExec(id, `readlink -- ${q}`)).trim();
      } catch (_) {}
    }
    return info;
  }

  /**
   * Comprime una o più voci di `cwd` nell'archivio `archive` (creato dentro
   * `cwd`). `format` è 'zip' oppure 'targz'. Ritorna il nome dell'archivio.
   */
  async compress(id, cwd, names, archive, format) {
    const list = (names || []).filter(Boolean);
    if (!list.length) throw new Error('Nessun elemento da comprimere');
    if (String(archive).includes('/')) throw new Error('Nome archivio non valido');
    const dir = String(cwd).replace(/\/+$/, '') || '/';
    if (await this._remoteExists(id, `${dir}/${archive}`)) {
      throw new Error(`Esiste già: ${archive}`);
    }
    const items = list.map(shellQuote).join(' ');
    const cd = `cd ${shellQuote(dir)} && `;
    if (format === 'zip') {
      const hint = 'In alternativa comprimi in .tar.gz.';
      // controllo preventivo: senza `zip` il comando esce con 127 e basta
      if (!(await this._hasTool(id, 'zip'))) throw missingToolError('zip', hint);
      await this._execTool(id, `${cd}zip -q -r ${shellQuote(archive)} ${items}`, 'zip', hint);
      return archive;
    }
    await this._execTool(id, `${cd}tar -czf ${shellQuote(archive)} -- ${items}`, 'tar');
    return archive;
  }

  /**
   * Estrae un archivio dentro `destDir`. Se contiene più elementi al primo
   * livello crea una sottocartella col nome dell'archivio (come fanno i file
   * manager), altrimenti estrae direttamente in `destDir`. Ritorna il nome
   * creato dentro `destDir`.
   */
  async extract(id, archivePath, destDir) {
    const base = path.basename(archivePath);
    const spec = ARCHIVE_FORMATS.find((f) => f.re.test(base));
    if (!spec) throw new Error(`Formato non riconosciuto: ${base}`);
    const dest = String(destDir).replace(/\/+$/, '') || '/';
    const q = shellQuote(archivePath);
    const stem = base.replace(spec.re, '') || `${base}_estratto`;

    // singolo file compresso: si decomprime accanto, senza cartelle
    if (spec.kind === 'single') {
      const out = await this._uniqueName(id, dest, stem);
      await this._execTool(
        id,
        `${spec.dec} < ${q} > ${shellQuote(`${dest}/${out}`)}`,
        spec.tool
      );
      return out;
    }

    if (spec.kind === 'zip' && !(await this._hasTool(id, 'unzip'))) {
      throw missingToolError('unzip');
    }

    // nomi al primo livello dell'archivio: decidono se serve una sottocartella
    let roots = [];
    try {
      const listCmd = spec.kind === 'zip' ? `unzip -Z1 ${q}` : `tar ${spec.t} ${q}`;
      const out = await this.sudoExec(
        id,
        `${listCmd} | sed -e 's|^\\./||' -e 's|/.*$||' | sort -u | head -n 5`
      );
      roots = String(out).split('\n').map((x) => x.trim()).filter(Boolean);
    } catch (_) {
      roots = [];
    }

    let target = dest;
    let created = roots.length === 1 ? roots[0] : null;
    if (roots.length !== 1) {
      created = await this._uniqueName(id, dest, stem);
      target = `${dest}/${created}`;
      await this.sudoExec(id, `mkdir -p ${shellQuote(target)}`);
    }
    const cmd = spec.kind === 'zip'
      ? `unzip -o -q ${q} -d ${shellQuote(target)}`
      : `tar ${spec.x} ${q} -C ${shellQuote(target)}`;
    await this._execTool(id, cmd, spec.kind === 'zip' ? 'unzip' : 'tar');
    return created;
  }

  /**
   * Esegue un comando con `sudo -S`, fornendo la password del server via stdin.
   * Se non c'è password salvata fa un tentativo senza sudo (utenti già root / NOPASSWD).
   */
  exec(id, cmd) {
    const s = this.get(id);
    return new Promise((resolve, reject) => {
      s.client.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = '';
        let errOut = '';
        stream.on('data', (d) => (out += d.toString('utf8')));
        stream.stderr.on('data', (d) => (errOut += d.toString('utf8')));
        stream.on('close', (code) => {
          if (code === 0) return resolve(out);
          const e = new Error(errOut.trim() || `Comando uscito con codice ${code}`);
          e.code = code; // 127 = comando non trovato: serve a dare errori parlanti
          reject(e);
        });
      });
    });
  }

  sudoExec(id, cmd) {
    const s = this.get(id);
    const password = s.server.password || '';
    // -S legge la password da stdin, -p '' silenzia il prompt
    const full = `sudo -S -p '' bash -c ${shellQuote(cmd)}`;
    return new Promise((resolve, reject) => {
      s.client.exec(full, (err, stream) => {
        if (err) return reject(err);
        let out = '';
        let errOut = '';
        stream.on('data', (d) => (out += d.toString('utf8')));
        stream.stderr.on('data', (d) => (errOut += d.toString('utf8')));
        stream.on('close', (code) => {
          if (code === 0) return resolve(out);
          const msg = errOut.trim().replace(/\[sudo\][^\n]*\n?/g, '').trim();
          const e = new Error(msg || `Comando uscito con codice ${code}`);
          e.code = code; // 127 = comando non trovato
          reject(e);
        });
        if (password) {
          stream.write(password + '\n');
        }
      });
    });
  }

  // ---- Docker ----------------------------------------------------------------

  /**
   * Esegue un comando docker. Prima senza sudo (utenti nel gruppo `docker`),
   * poi con sudo come fallback (host dove docker richiede privilegi).
   */
  async dockerExec(id, cmd) {
    try {
      return await this.exec(id, cmd);
    } catch (_) {
      return this.sudoExec(id, cmd);
    }
  }

  /** Elenca tutti i container docker, anche quelli fermi (docker ps -a). */
  async dockerPs(id) {
    const fmt =
      '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}\t' +
      '{{.Label "com.docker.compose.project.working_dir"}}';
    const out = await this.dockerExec(id, `docker ps -a --no-trunc --format ${shellQuote(fmt)}`);
    return out
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.trim())
      .map((line) => {
        const [cid, name, image, state, status, ports, workdir] = line.split('\t');
        return {
          id: cid,
          name,
          image,
          state, // running | exited | created | paused | ...
          status,
          ports: parsePublishedPorts(ports), // porte host pubblicate
          portDetails: parsePortDetails(ports), // mappature host->container + porte esposte
          running: state === 'running',
          workdir: workdir || '',
        };
      });
  }

  /**
   * Azione su un container: stop | restart | down | pull.
   * Per i container gestiti da compose (workdir noto) "down" e "pull" agiscono
   * sul progetto compose; altrimenti sul singolo container/immagine.
   */
  async dockerAction(id, action, container) {
    const { id: cid, image, workdir } = container || {};
    let cmd;
    switch (action) {
      case 'up':
        cmd = workdir
          ? `docker compose --project-directory ${shellQuote(workdir)} up -d`
          : `docker start ${shellQuote(cid)}`;
        break;
      case 'stop':
        cmd = `docker stop ${shellQuote(cid)}`;
        break;
      case 'restart':
        cmd = `docker restart ${shellQuote(cid)}`;
        break;
      case 'down':
        cmd = workdir
          ? `docker compose --project-directory ${shellQuote(workdir)} down`
          : `docker rm -f ${shellQuote(cid)}`;
        break;
      case 'pull':
        cmd = workdir
          ? `docker compose --project-directory ${shellQuote(workdir)} pull`
          : `docker pull ${shellQuote(image)}`;
        break;
      default:
        throw new Error('Azione docker sconosciuta: ' + action);
    }
    return this.dockerExec(id, cmd);
  }

  /**
   * "Manual Pull": scarica un'immagine sull'host (solo se mancante), la
   * trasferisce in streaming sul remoto (docker save | docker load via SSH) e
   * la ritagga sul remoto come `targetImage`. Riporta avanzamento via onProgress.
   */
  async manualPull(id, image, targetImage, onProgress) {
    const session = this.get(id);

    // 1. pull locale solo se l'immagine non è già presente sull'host
    onProgress({ phase: 'check', pct: null, text: 'Verifica immagine sull\'host…' });
    const pulledNow = !(await this._localImageExists(image));
    if (pulledNow) {
      onProgress({ phase: 'pull', pct: null, text: 'docker pull sull\'host…' });
      await this._localPull(image, onProgress);
    }

    // L'immagine pullata per digest è senza tag (RepoTags vuoto) e `docker save`
    // per ID/@digest fallisce (specie col containerd image store). Quindi la
    // taggiamo localmente con l'immagine di destinazione: così il tar contiene
    // già il repo:tag giusto e il remoto la riceve pronta dopo il load.
    const meta = JSON.parse(await this._localDocker(['image', 'inspect', image]))[0] || {};
    const imageId = meta.Id; // sha256:…
    const size = Number(meta.Size) || 0;

    onProgress({ phase: 'tag', pct: null, text: `Tag locale → ${targetImage}` });
    await this._localDocker(['tag', imageId, targetImage]);

    // 2. streaming docker save (host) -> docker load (remoto): il remoto ottiene
    //    direttamente l'immagine col tag di destinazione.
    onProgress({ phase: 'transfer', pct: 0, text: 'Trasferimento immagine sul remoto…' });
    await this._streamSaveLoad(id, targetImage, size, onProgress);

    // 3. pulizia locale: rimuoviamo il tag di destinazione (artefatto creato da
    //    noi per il transfer) e, se l'abbiamo scaricata in questa operazione,
    //    anche l'immagine sorgente. Un'immagine che l'utente aveva già viene
    //    lasciata intatta. Errori qui non compromettono il trasferimento.
    onProgress({ phase: 'cleanup', pct: null, text: 'Pulizia immagine locale…' });
    await this._localRemoveImage(targetImage);
    if (pulledNow && image !== targetImage) {
      await this._localRemoveImage(image);
    }

    onProgress({ phase: 'done', pct: 100, text: `Completato — ritaggata come ${targetImage}` });
    return { ok: true, image, targetImage };
  }

  /** Rimuove un'immagine locale (best-effort: eventuali errori sono ignorati). */
  async _localRemoveImage(ref) {
    try { await this._localDocker(['rmi', ref]); }
    catch (_) { /* già assente o in uso: ignora */ }
  }

  // ---- Immagini --------------------------------------------------------------

  /**
   * Elenca le immagini definite in tutti i compose sulla macchina, unendo:
   *  - i progetti compose tracciati da Docker (`docker compose ls -a`)
   *  - i file compose trovati con una scansione del filesystem nelle posizioni
   *    comuni (così includiamo anche i compose mai avviati).
   */
  async composeImages(id) {
    const files = new Set();

    // 1) progetti compose tracciati da Docker (hanno container creati)
    try {
      const out = await this.dockerExec(id, 'docker compose ls -a --format json');
      const parsed = JSON.parse(out.slice(out.indexOf('[')));
      if (Array.isArray(parsed)) {
        for (const p of parsed) {
          String(p.ConfigFiles || '')
            .split(',')
            .map((f) => f.trim())
            .filter(Boolean)
            .forEach((f) => files.add(f));
        }
      }
    } catch (_) { /* ignora */ }

    // 2) scansione filesystem dei file compose (anche progetti mai avviati)
    try {
      const roots = '/opt /srv /root /home';
      const names =
        '\\( -name docker-compose.yml -o -name docker-compose.yaml ' +
        '-o -name compose.yml -o -name compose.yaml \\)';
      const cmd =
        `find ${roots} -maxdepth 4 -type f ${names} ` +
        `-not -path '*/node_modules/*' 2>/dev/null || true`;
      const out = await this.dockerExec(id, cmd);
      out.split('\n').map((l) => l.trim()).filter(Boolean).forEach((f) => files.add(f));
    } catch (_) { /* ignora */ }

    // 3) per ogni compose, estrae le immagini risolte
    const images = new Set();
    for (const file of files) {
      try {
        const out = await this.dockerExec(id, `docker compose -f ${shellQuote(file)} config --images`);
        out.split('\n').map((l) => l.trim()).filter(Boolean).forEach((im) => images.add(im));
      } catch (_) { /* compose non leggibile: skip */ }
    }
    return [...images].sort().map((image) => ({ image, project: '' }));
  }

  /** Elenca le immagini presenti sul remoto (docker images). */
  async listImages(id) {
    const fmt = '{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedAt}}';
    const out = await this.dockerExec(id, `docker images --format ${shellQuote(fmt)}`);
    return out
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.trim())
      .map((line) => {
        const [repo, tag, imgId, size, created] = line.split('\t');
        const tagged = repo && repo !== '<none>' && tag && tag !== '<none>';
        return { repo, tag, id: imgId, size, created: created || '', ref: tagged ? `${repo}:${tag}` : null };
      });
  }

  /** Azione su un'immagine: pull | delete. */
  async imageAction(id, action, image) {
    const { ref, id: imgId } = image || {};
    switch (action) {
      case 'pull':
        if (!ref) throw new Error('Immagine senza tag: pull non disponibile');
        return this.dockerExec(id, `docker pull ${shellQuote(ref)}`);
      case 'delete':
        return this.dockerExec(id, `docker rmi ${shellQuote(ref || imgId)}`);
      default:
        throw new Error('Azione immagine sconosciuta: ' + action);
    }
  }

  /**
   * Path del binario `docker` sull'host. Le app GUI (e a volte Electron) non
   * ereditano il PATH completo della shell, quindi cerchiamo le posizioni note.
   */
  _dockerBin() {
    if (this._dockerBinPath) return this._dockerBinPath;
    const candidates = [
      process.env.DOCKER_BIN,
      '/usr/local/bin/docker',
      '/opt/homebrew/bin/docker',
      '/usr/bin/docker',
      '/snap/bin/docker',
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) { this._dockerBinPath = c; return c; } } catch (_) {}
    }
    this._dockerBinPath = 'docker'; // ultima risorsa: affidati al PATH
    return this._dockerBinPath;
  }

  /** Esegue `docker <args>` sull'host e risolve lo stdout. */
  _localDocker(args) {
    const { execFile } = require('child_process');
    return new Promise((resolve, reject) => {
      execFile(this._dockerBin(), args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim()));
        resolve(stdout);
      });
    });
  }

  async _localImageExists(image) {
    try { await this._localDocker(['image', 'inspect', image]); return true; }
    catch (_) { return false; }
  }

  async _localImageSize(image) {
    try {
      const out = await this._localDocker(['image', 'inspect', '--format', '{{.Size}}', image]);
      const n = parseInt(out.trim(), 10);
      return Number.isFinite(n) ? n : 0;
    } catch (_) { return 0; }
  }

  /** docker pull sull'host con avanzamento (ultima riga di output). */
  _localPull(image, onProgress) {
    const { spawn } = require('child_process');
    return new Promise((resolve, reject) => {
      const p = spawn(this._dockerBin(), ['pull', image]);
      let errOut = '';
      p.stdout.on('data', (d) => {
        const line = d.toString().split('\n').map((s) => s.trim()).filter(Boolean).pop();
        if (line) onProgress({ phase: 'pull', pct: null, text: line });
      });
      p.stderr.on('data', (d) => { errOut += d.toString(); });
      p.on('error', reject);
      p.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(errOut.trim() || `docker pull uscito con codice ${code}`))
      );
    });
  }

  /** True se docker sul remoto richiede sudo (probe leggero). */
  async _remoteDockerNeedsSudo(id) {
    try { await this.exec(id, 'docker version >/dev/null 2>&1'); return false; }
    catch (_) { return true; }
  }

  /** Streamma `docker save <ref>` dall'host nello stdin di `docker load` sul remoto. */
  async _streamSaveLoad(id, ref, size, onProgress) {
    const { spawn } = require('child_process');
    const session = this.get(id);
    const needSudo = await this._remoteDockerNeedsSudo(id);
    const password = session.server.password || '';
    const loadCmd = needSudo ? `sudo -S -p '' docker load` : 'docker load';

    return new Promise((resolve, reject) => {
      session.client.exec(loadCmd, (err, stream) => {
        if (err) return reject(err);

        let remoteErr = '';
        let settled = false;
        const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

        stream.on('data', () => {}); // output di docker load (ignorato)
        stream.stderr.on('data', (d) => { remoteErr += d.toString(); });
        stream.on('close', (code) => {
          if (code === 0) return done(resolve);
          const msg = remoteErr.replace(/\[sudo\][^\n]*\n?/g, '').trim();
          done(reject, new Error(msg || `docker load remoto uscito con codice ${code}`));
        });

        // sudo -S legge la password (prima riga) da stdin, poi il resto va a docker load
        if (needSudo && password) stream.write(password + '\n');

        const saver = spawn(this._dockerBin(), ['save', ref]);
        let sent = 0;
        let saveErr = '';
        saver.stdout.on('data', (chunk) => {
          sent += chunk.length;
          if (size > 0) {
            const pct = Math.min(98, Math.round((sent / size) * 100));
            onProgress({ phase: 'transfer', pct, text: `Trasferiti ${humanBytes(sent)} / ${humanBytes(size)}` });
          } else {
            onProgress({ phase: 'transfer', pct: null, text: `Trasferiti ${humanBytes(sent)}` });
          }
        });
        saver.stderr.on('data', (d) => { saveErr += d.toString(); });
        saver.on('error', (e) => { try { stream.end(); } catch (_) {} done(reject, e); });
        saver.on('close', (code) => {
          if (code !== 0) {
            try { stream.end(); } catch (_) {}
            done(reject, new Error(saveErr.trim() || `docker save uscito con codice ${code}`));
          }
        });
        saver.stdout.pipe(stream); // chiude lo stdin remoto a fine save
      });
    });
  }

  // ---- Screen (GNU screen) ---------------------------------------------------

  /**
   * Elenca le sessioni screen dell'utente (screen -ls).
   * `screen -ls` esce con codice != 0 anche in condizioni normali, quindi
   * forziamo l'uscita a 0 (`|| true`) e analizziamo lo stdout.
   */
  async screenList(id) {
    let out;
    try { out = await this.exec(id, 'screen -ls || true'); }
    catch (_) { out = ''; }
    const screens = [];
    out.split('\n').forEach((line) => {
      // righe tipo: "\t12345.nome\t(data)\t(Detached)"
      const m = line.match(/^\s*(\d+)\.(\S+)/);
      if (!m) return;
      const st = line.match(/\((Attached|Detached|Dead[^)]*|Multi[^)]*)\)/i);
      screens.push({
        pid: m[1],
        name: m[2],
        full: `${m[1]}.${m[2]}`,
        status: st ? st[1] : 'Detached',
      });
    });
    return screens;
  }

  /** Crea una nuova sessione screen staccata (senza entrarci). */
  async screenCreate(id, name) {
    const n = String(name || '').trim();
    if (!n || /\s/.test(n)) throw new Error('Nome screen non valido');
    return this.exec(id, `screen -dmS ${shellQuote(n)}`);
  }

  /** Termina (elimina) una sessione screen. */
  async screenKill(id, target) {
    return this.exec(id, `screen -S ${shellQuote(target)} -X quit`);
  }

  /** Stacca una sessione screen attualmente attaccata. */
  async screenDetach(id, target) {
    return this.exec(id, `screen -S ${shellQuote(target)} -X detach`);
  }

  /**
   * Rimuove l'eventuale barra di stato in fondo (hardstatus) impostata da
   * versioni precedenti dell'app, liberando l'ultima riga del display.
   * Va invocata DOPO l'attach: `screen -X` agisce sul display attivo.
   */
  async screenClearStatus(id, target) {
    try { await this.exec(id, `screen -S ${shellQuote(target)} -X hardstatus ignore`); }
    catch (_) { /* niente da pulire: ignora */ }
    return true;
  }

  // ---- Crontab (root, via sudo) -----------------------------------------------

  /**
   * Legge il crontab di root (sudo crontab -l). Un crontab inesistente
   * ("no crontab for root") non è un errore: ritorna testo vuoto.
   */
  async cronRead(id) {
    try {
      return await this.sudoExec(id, 'crontab -l');
    } catch (e) {
      if (/no crontab/i.test(e.message || '')) return '';
      throw e;
    }
  }

  /**
   * Sovrascrive il crontab di root con il contenuto indicato. Il testo passa
   * in base64 per evitare qualunque problema di quoting (apici, $, backslash…).
   */
  async cronWrite(id, content) {
    let text = String(content || '');
    if (text && !text.endsWith('\n')) text += '\n'; // cron richiede il newline finale
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    return this.sudoExec(id, `echo ${b64} | base64 -d | crontab -`);
  }

  /**
   * Legge il contenuto testuale di un file remoto (con privilegi sudo, così da
   * poter aprire anche file protetti come quelli di root). Usa base64 per il
   * trasporto, evitando qualunque corruzione di codifica.
   */
  async readFile(id, remotePath) {
    const b64 = await this.sudoExec(id, `base64 ${shellQuote(remotePath)}`);
    return Buffer.from(b64, 'base64').toString('utf8');
  }

  /**
   * Scrive il contenuto in un file remoto. Carica prima in /tmp via SFTP
   * (scrivibile dall'utente), poi copia sulla destinazione con sudo: `cp` su un
   * file esistente ne preserva proprietario e permessi.
   */
  async writeFile(id, remotePath, content) {
    const sftp = await this._sftp(id);
    const tmp = `/tmp/rg-edit-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await new Promise((resolve, reject) => {
      const ws = sftp.createWriteStream(tmp);
      ws.on('error', reject);
      ws.on('close', resolve);
      ws.end(Buffer.from(content, 'utf8'));
    });
    try {
      await this.sudoExec(id, `cp ${shellQuote(tmp)} ${shellQuote(remotePath)}`);
    } finally {
      await this.exec(id, `rm -f ${shellQuote(tmp)}`).catch(() => {});
    }
    return true;
  }

  // ---- Monitor di sistema ----------------------------------------------------

  /**
   * Fotografia dello stato del sistema per la dashboard: CPU (totale e per core),
   * memoria, swap, load average, uptime, dischi (`df`) e processi più esosi.
   *
   * Tutto in una sola exec per non moltiplicare i round trip. /proc/stat viene
   * campionato due volte a 0,5 s di distanza: così l'uso istantaneo di CPU si
   * calcola sul posto, senza conservare stato tra una chiamata e l'altra (e il
   * primo aggiornamento mostra già valori sensati).
   */
  async sysStats(id) {
    const cmd = [
      'export LC_ALL=C',
      'echo @S1', "grep '^cpu' /proc/stat 2>/dev/null",
      'sleep 0.5',
      'echo @S2', "grep '^cpu' /proc/stat 2>/dev/null",
      'echo @MEM', 'cat /proc/meminfo 2>/dev/null',
      'echo @LOAD', 'cat /proc/loadavg 2>/dev/null',
      'echo @UP', 'cat /proc/uptime 2>/dev/null',
      'echo @MODEL', "grep -m1 '^model name' /proc/cpuinfo 2>/dev/null",
      // -x esclude i filesystem virtuali (non su tutte le df: fallback senza -x)
      'echo @DF',
      '{ df -P -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null' +
        ' || df -P -B1 2>/dev/null; }',
      'echo @PS',
      'ps -eo pid=,user=,pcpu=,pmem=,comm= --sort=-pcpu 2>/dev/null | head -n 12',
      'echo @END',
    ].join('; ');
    return parseSysStats(await this.exec(id, cmd));
  }

  // ---- PostgreSQL ------------------------------------------------------------

  /**
   * Esegue un comando psql come utente di sistema `postgres` via sudo,
   * fornendo la password del server via stdin (come sudoExec). Serve quando
   * l'utente SSH non ha un ruolo Postgres proprio (caso più comune).
   */
  _pgSudo(id, psqlCmd) {
    const s = this.get(id);
    const password = s.server.password || '';
    const full = `sudo -S -p '' -u postgres ${psqlCmd}`;
    return new Promise((resolve, reject) => {
      s.client.exec(full, (err, stream) => {
        if (err) return reject(err);
        let out = '';
        let errOut = '';
        stream.on('data', (d) => (out += d.toString('utf8')));
        stream.stderr.on('data', (d) => (errOut += d.toString('utf8')));
        stream.on('close', (code) => {
          if (code === 0) return resolve(out);
          const msg = errOut.trim().replace(/\[sudo\][^\n]*\n?/g, '').trim();
          reject(new Error(msg || `Comando uscito con codice ${code}`));
        });
        if (password) stream.write(password + '\n');
      });
    });
  }

  /**
   * Elenca i database PostgreSQL installati direttamente sull'host (esclusi i
   * template). Prova prima con l'utente SSH corrente (se ha accesso diretto a
   * psql), poi come utente di sistema `postgres` via sudo.
   */
  async pgListDatabases(id) {
    // -A: output non allineato, -t: solo le righe dati, separatore di default '|'
    const psqlCmd = `psql -At -c ${shellQuote(PG_LIST_SQL)}`;
    let out;
    try {
      out = await this.exec(id, psqlCmd);
    } catch (_) {
      out = await this._pgSudo(id, psqlCmd);
    }
    return parsePgList(out);
  }

  /** Ricava il super-utente Postgres di un container (POSTGRES_USER o 'postgres'). */
  async _pgContainerUser(id, container) {
    try {
      const fmt = '{{range .Config.Env}}{{println .}}{{end}}';
      const out = await this.dockerExec(
        id,
        `docker inspect --format ${shellQuote(fmt)} ${shellQuote(container.id)}`
      );
      const line = out
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('POSTGRES_USER='));
      if (line) return line.slice('POSTGRES_USER='.length).trim() || 'postgres';
    } catch (_) { /* env non leggibile: usa il default */ }
    return 'postgres';
  }

  /** Elenca i database dentro un container Postgres via `docker exec ... psql`. */
  async _pgListInContainer(id, container, user) {
    const cmd =
      `docker exec ${shellQuote(container.id)} ` +
      `psql -U ${shellQuote(user)} -At -c ${shellQuote(PG_LIST_SQL)}`;
    return parsePgList(await this.dockerExec(id, cmd));
  }

  /**
   * Elenca tutti i database PostgreSQL raggiungibili sulla macchina, sia quelli
   * installati sull'host sia quelli dentro container Docker basati su immagini
   * Postgres. Ritorna un elenco di gruppi:
   *   { source: 'host' | 'container', container?, image?, user?, databases: [] }
   */
  async pgListAll(id) {
    const groups = [];

    // 1. Host
    try {
      const dbs = await this.pgListDatabases(id);
      if (dbs.length) groups.push({ source: 'host', databases: dbs });
    } catch (_) { /* nessun Postgres sull'host: ignora */ }

    // 2. Container Postgres in esecuzione
    let containers = [];
    try { containers = await this.dockerPs(id); } catch (_) { /* docker assente */ }
    const pgContainers = containers.filter(
      (c) => c.running && /postgres|postgis|timescale/i.test(c.image)
    );
    for (const c of pgContainers) {
      try {
        const user = await this._pgContainerUser(id, c);
        const dbs = await this._pgListInContainer(id, c, user);
        groups.push({ source: 'container', container: c.name, image: c.image, user, databases: dbs });
      } catch (_) { /* container non pronto o non interrogabile: salta */ }
    }

    return groups;
  }

  /** Rende un file leggibile a tutti (utile prima di scaricarlo o di leggerlo come postgres). */
  async _chmodReadable(id, p) {
    try { await this.exec(id, `chmod 644 ${shellQuote(p)}`); }
    catch (_) { await this.sudoExec(id, `chmod 644 ${shellQuote(p)}`).catch(() => {}); }
  }

  /** Rimuove un file temporaneo, con fallback sudo se creato da un altro utente. */
  async _rmForce(id, p) {
    try { await this.exec(id, `rm -f ${shellQuote(p)}`); }
    catch (_) { await this.sudoExec(id, `rm -f ${shellQuote(p)}`).catch(() => {}); }
  }

  /** Dimensione in byte di un file remoto (0 se non leggibile). */
  async _remoteFileSize(id, p) {
    try {
      const out = await this.exec(id, `wc -c < ${shellQuote(p)}`);
      const n = parseInt(String(out).trim(), 10);
      return Number.isFinite(n) ? n : 0;
    } catch (_) { return 0; }
  }

  /** Scarica un file remoto riportando l'avanzamento (byte trasferiti / totale). */
  async _downloadWithProgress(id, remotePath, localPath, total, onProgress) {
    const sftp = await this._sftp(id);
    return new Promise((resolve, reject) => {
      const opts = {
        step: (transferred) => {
          if (total > 0) {
            const pct = Math.min(99, Math.round((transferred / total) * 100));
            onProgress({ phase: 'transfer', pct, text: `${humanBytes(transferred)} / ${humanBytes(total)}` });
          } else {
            onProgress({ phase: 'transfer', pct: null, text: humanBytes(transferred) });
          }
        },
      };
      sftp.fastGet(remotePath, localPath, opts, (err) => (err ? reject(err) : resolve(localPath)));
    });
  }

  /**
   * Esegue il dump (formato custom `-Fc`, struttura + dati) del database indicato
   * e lo scarica in `localPath`. Funziona sia per Postgres installato sull'host
   * sia per i container Docker. Il dump viene prima scritto in un file temporaneo
   * remoto, poi trasferito via SFTP e infine rimosso. `onProgress` riceve
   * l'avanzamento (indeterminato durante la creazione, in percentuale durante il
   * download).
   */
  async pgDump(id, group, dbName, localPath, onProgress = () => {}) {
    const tmp = `/tmp/rg-dump-${Date.now()}-${Math.floor(Math.random() * 1e6)}.dump`;
    try {
      onProgress({ phase: 'dump', pct: null }); // creazione dump: barra indeterminata
      if (group && group.source === 'container') {
        const user = group.user || 'postgres';
        const cmd =
          `docker exec ${shellQuote(group.container)} ` +
          `pg_dump -U ${shellQuote(user)} -Fc ${shellQuote(dbName)} > ${shellQuote(tmp)}`;
        await this.dockerExec(id, cmd);
      } else {
        const cmd = `pg_dump -Fc ${shellQuote(dbName)} > ${shellQuote(tmp)}`;
        try { await this.exec(id, cmd); }
        catch (_) { await this._pgSudo(id, cmd); }
      }
      await this._chmodReadable(id, tmp); // il file può appartenere a root/postgres
      const total = await this._remoteFileSize(id, tmp);
      onProgress({ phase: 'transfer', pct: 0, text: `0 B / ${humanBytes(total)}` });
      await this._downloadWithProgress(id, tmp, localPath, total, onProgress);
    } finally {
      await this._rmForce(id, tmp);
    }
    return localPath;
  }

  /**
   * Ripristina un dump (formato custom) da `localPath` nel database indicato.
   * Il file viene caricato via SFTP in un temporaneo remoto e poi passato a
   * `pg_restore` (`--clean --if-exists` per sovrascrivere gli oggetti esistenti).
   * Funziona sia sull'host sia nei container Docker.
   */
  async pgRestore(id, group, dbName, localPath) {
    const tmp = `/tmp/rg-restore-${Date.now()}-${Math.floor(Math.random() * 1e6)}.dump`;
    const sftp = await this._sftp(id);
    await new Promise((resolve, reject) => {
      sftp.fastPut(localPath, tmp, (err) => (err ? reject(err) : resolve()));
    });
    try {
      await this._chmodReadable(id, tmp); // leggibile anche dall'utente postgres
      if (group && group.source === 'container') {
        const user = group.user || 'postgres';
        const cmd =
          `docker exec -i ${shellQuote(group.container)} ` +
          `pg_restore -U ${shellQuote(user)} --clean --if-exists ` +
          `-d ${shellQuote(dbName)} < ${shellQuote(tmp)}`;
        await this.dockerExec(id, cmd);
      } else {
        const cmd = `pg_restore --clean --if-exists -d ${shellQuote(dbName)} ${shellQuote(tmp)}`;
        try { await this.exec(id, cmd); }
        catch (_) { await this._pgSudo(id, cmd); }
      }
    } finally {
      await this._rmForce(id, tmp);
    }
    return localPath;
  }

}

class Session {
  constructor(id, client, stream, server) {
    this.id = id;
    this.client = client;
    this.stream = stream;
    this.server = server;
    this.sftp = null;
    this.sftpBrowse = null; // canale SFTP dedicato al file browser
    this.sftpBrowsePending = null;
    this.cwd = '~';
    this._cwdBuf = '';
  }

  /**
   * Estrae i marker OSC 1337 (CWD=... e STY=...) dal flusso e ritorna il testo
   * "pulito". Gestisce marker spezzati su più chunk.
   *  - `cwd`: ultima cwd vista (o null)
   *  - `sty`: ultimo valore di $STY visto ('' = shell esterna, valorizzato = screen)
   *  - `styFound`: true se è stato visto almeno un marker STY in questo chunk
   */
  extractMarkers(text) {
    let data = this._cwdBuf + text;
    this._cwdBuf = '';
    let cwd = null;
    let sty = '';
    let styFound = false;
    const re = /\x1b\]1337;(CWD|STY)=([^\x07]*)\x07/g;
    let clean = data.replace(re, (_, key, val) => {
      if (key === 'CWD') cwd = val;
      else { sty = val; styFound = true; }
      return '';
    });
    // se è rimasto un marker parziale a fine buffer, mettilo da parte
    const partial = clean.lastIndexOf('\x1b]1337;');
    if (partial !== -1 && clean.indexOf('\x07', partial) === -1) {
      this._cwdBuf = clean.slice(partial);
      clean = clean.slice(0, partial);
    }
    return { clean, cwd, sty, styFound };
  }
}

/**
 * Errore per un comando mancante sul server: meglio dirlo con chiarezza che
 * mostrare "uscito con codice 127". `zip` e `unzip` spesso non sono installati.
 */
function missingToolError(tool, hint) {
  const extra = hint ? ` ${hint}` : '';
  return new Error(
    `Comando '${tool}' non disponibile sul server: installalo (es. sudo apt install ${tool}).${extra}`
  );
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Identifica un server a prescindere dalla sessione: utente@host:porta. */
function serverKey(srv) {
  return `${srv.username || ''}@${srv.host || ''}:${srv.port || 22}`;
}

// SQL per elencare i database (escludendo i template): nome, proprietario, dimensione.
const PG_LIST_SQL =
  'SELECT datname, pg_catalog.pg_get_userbyid(datdba), ' +
  'pg_size_pretty(pg_database_size(datname)) ' +
  'FROM pg_database WHERE datistemplate = false ORDER BY datname;';

// ---- Parsing dello stato di sistema ---------------------------------------

/**
 * Analizza l'output a sezioni (@S1, @MEM, …) del comando di `sysStats`.
 * Ritorna null nei campi non disponibili (es. sistemi senza /proc), così la
 * dashboard può segnalarlo senza rompersi.
 */
function parseSysStats(out) {
  const sec = {};
  let cur = null;
  for (const raw of String(out).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = line.match(/^@([A-Z0-9]+)$/);
    if (m) { cur = m[1]; sec[cur] = []; continue; }
    if (cur) sec[cur].push(line);
  }

  const mem = parseMeminfo(sec.MEM || []);
  const load = (sec.LOAD || [])[0] ? String(sec.LOAD[0]).trim().split(/\s+/) : [];
  const upFields = (sec.UP || [])[0] ? String(sec.UP[0]).trim().split(/\s+/) : [];
  const modelLine = (sec.MODEL || [])[0] || '';

  return {
    cpu: parseCpu(sec.S1 || [], sec.S2 || []),
    cpuModel: modelLine.includes(':') ? modelLine.split(':').slice(1).join(':').trim() : '',
    mem,
    load: load.length >= 3 ? load.slice(0, 3).map(Number) : null,
    procsRunning: load[3] || '',
    uptime: upFields.length ? Math.floor(Number(upFields[0])) : null,
    disks: parseDf(sec.DF || []),
    procs: parsePs(sec.PS || []),
  };
}

/**
 * Uso di CPU in percentuale dalla differenza fra due campionamenti di /proc/stat.
 * Ritorna { all, iowait, cores: [] } oppure null se i dati non sono utilizzabili.
 */
function parseCpu(first, second) {
  const read = (lines) => {
    const map = new Map();
    for (const l of lines) {
      const f = l.trim().split(/\s+/);
      if (!f[0] || !/^cpu/.test(f[0])) continue;
      const n = f.slice(1).map((x) => Number(x) || 0);
      // idle = idle + iowait: entrambi tempo non speso a calcolare
      map.set(f[0], {
        total: n.reduce((s, v) => s + v, 0),
        idle: (n[3] || 0) + (n[4] || 0),
        iowait: n[4] || 0,
      });
    }
    return map;
  };
  const a = read(first);
  const b = read(second);
  if (!a.size || !b.size) return null;

  const pct = (key) => {
    const x = a.get(key);
    const y = b.get(key);
    if (!x || !y) return null;
    const dt = y.total - x.total;
    if (dt <= 0) return null;
    return {
      busy: Math.max(0, Math.min(100, ((dt - (y.idle - x.idle)) / dt) * 100)),
      iowait: Math.max(0, Math.min(100, ((y.iowait - x.iowait) / dt) * 100)),
    };
  };

  const all = pct('cpu');
  const cores = [];
  for (let i = 0; b.has('cpu' + i); i++) {
    const c = pct('cpu' + i);
    cores.push(c ? c.busy : 0);
  }
  return { all: all ? all.busy : null, iowait: all ? all.iowait : null, cores };
}

/** Memoria e swap in byte da /proc/meminfo. */
function parseMeminfo(lines) {
  const kv = {};
  for (const l of lines) {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) kv[m[1]] = Number(m[2]) * 1024; // i valori sono in kB
  }
  if (!kv.MemTotal) return null;
  const cached = (kv.Cached || 0) + (kv.SReclaimable || 0);
  // "available" è la stima del kernel di memoria realmente allocabile: più
  // affidabile di free+cache per dire quanta RAM è davvero occupata
  const available = kv.MemAvailable != null ? kv.MemAvailable : (kv.MemFree || 0) + cached;
  return {
    total: kv.MemTotal,
    free: kv.MemFree || 0,
    available,
    buffers: kv.Buffers || 0,
    cached,
    used: Math.max(0, kv.MemTotal - available),
    swapTotal: kv.SwapTotal || 0,
    swapUsed: Math.max(0, (kv.SwapTotal || 0) - (kv.SwapFree || 0)),
  };
}

/** Righe di `df -P -B1` (byte) in oggetti, scartando i filesystem virtuali. */
function parseDf(lines) {
  const skipFs = /^(tmpfs|devtmpfs|udev|overlay|shm|none|squashfs|efivarfs)$/i;
  const skipMount = /^\/(dev|proc|sys|run)(\/|$)/;
  const out = [];
  for (const l of lines.slice(1)) { // la prima riga è l'intestazione
    if (!l.trim()) continue;
    const f = l.trim().split(/\s+/);
    if (f.length < 6) continue;
    const [fs, size, used, avail] = f;
    const mount = f.slice(5).join(' '); // i mount point possono contenere spazi
    if (skipFs.test(fs) || skipMount.test(mount)) continue;
    const total = Number(size);
    if (!total) continue;
    out.push({
      fs,
      mount,
      size: total,
      used: Number(used),
      avail: Number(avail),
      pct: Math.min(100, (Number(used) / total) * 100),
    });
  }
  out.sort((a, b) => b.pct - a.pct);
  return out;
}

/** Righe di `ps -eo pid,user,pcpu,pmem,comm` in oggetti. */
function parsePs(lines) {
  const out = [];
  for (const l of lines) {
    const f = l.trim().split(/\s+/);
    if (f.length < 5 || !/^\d+$/.test(f[0])) continue;
    out.push({
      pid: f[0],
      user: f[1],
      cpu: Number(f[2]) || 0,
      mem: Number(f[3]) || 0,
      cmd: f.slice(4).join(' '),
    });
  }
  return out;
}

/** Converte l'output `nome|proprietario|dimensione` di psql in oggetti. */
function parsePgList(out) {
  return String(out)
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim())
    .map((line) => {
      const [name, owner, size] = line.split('|');
      return { name, owner: owner || '', size: size || '' };
    });
}

/**
 * Estrae le porte host pubblicate dal campo `.Ports` di docker ps.
 * Es: "0.0.0.0:5000->5000/tcp, :::5000->5000/tcp, 8080/tcp" -> [5000]
 */
function parsePublishedPorts(str) {
  const ports = new Set();
  String(str || '').split(',').forEach((seg) => {
    const m = seg.trim().match(/:(\d+)->/);
    if (m) ports.add(parseInt(m[1], 10));
  });
  return [...ports].sort((a, b) => a - b);
}

/**
 * Dettaglio delle porte dal campo `.Ports` di docker ps: mappature pubblicate
 * (host -> container) e porte solo esposte.
 * Es: "0.0.0.0:5000->5000/tcp, :::5000->5000/tcp, 8080/tcp"
 *  -> [{ host: 5000, container: 5000, proto: 'tcp' }, { container: 8080, proto: 'tcp' }]
 */
function parsePortDetails(str) {
  const seen = new Set();
  const list = [];
  String(str || '').split(',').forEach((seg) => {
    const s = seg.trim();
    if (!s) return;
    const pub = s.match(/(?::|^)(\d+)->(\d+)\/(\w+)$/);
    if (pub) {
      const item = { host: parseInt(pub[1], 10), container: parseInt(pub[2], 10), proto: pub[3] };
      const key = `${item.host}->${item.container}/${item.proto}`;
      if (!seen.has(key)) { seen.add(key); list.push(item); }
      return;
    }
    const exp = s.match(/^(\d+)\/(\w+)$/);
    if (exp) {
      const item = { container: parseInt(exp[1], 10), proto: exp[2] };
      const key = `exp:${item.container}/${item.proto}`;
      if (!seen.has(key)) { seen.add(key); list.push(item); }
    }
  });
  // prima le porte pubblicate, ordinate per porta host
  return list.sort((a, b) => {
    if ((a.host == null) !== (b.host == null)) return a.host == null ? 1 : -1;
    return (a.host ?? a.container) - (b.host ?? b.container);
  });
}

function humanBytes(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = Number(bytes) || 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}

module.exports = new SshManager();

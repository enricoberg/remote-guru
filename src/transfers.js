'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Gestore dei trasferimenti file (upload + download) via SFTP.
 *
 * Caratteristiche:
 *  - trasferimenti asincroni con avanzamento in byte (barra + percentuale);
 *  - riprendibili: ogni file viene trasferito con stream a offset, quindi una
 *    pausa, un errore di rete o la chiusura dell'app non fanno ripartire da zero;
 *  - una coda per sessione SSH (un trasferimento attivo per volta per server);
 *  - stato persistito su disco: al riavvio i trasferimenti incompleti tornano in
 *    pausa e sono riprendibili appena la sessione al server è di nuovo aperta.
 *
 * Convenzioni:
 *  - download: il file viene scritto in `<destinazione>.rgpart` e rinominato solo
 *    al completamento, così un file parziale non viene mai confuso con uno intero;
 *  - upload: i dati vanno prima in una cartella di staging remota deterministica
 *    (/tmp/rg-up-<id>, scrivibile dall'utente) e alla fine vengono copiati nella
 *    destinazione con `sudo cp`, come già fa l'import "classico". Lo staging è
 *    deterministico proprio per poter riprendere l'upload dopo un'interruzione;
 *  - relay (copia server -> server, drag&drop fra due schede): non è un tipo a
 *    sé, ma un download verso una cartella temporanea locale seguito da un
 *    upload sul secondo server. Le due fasi sono due voci di coda con lo stesso
 *    `groupId`, così pausa/ripresa/avanzamento funzionano già senza casi speciali.
 */

const PART = '.rgpart';
const ABORT = 'RG_TRANSFER_ABORTED';

class TransferManager {
  constructor() {
    /** @type {Map<string, object>} id -> item */
    this.items = new Map();
    /** sessionId -> id del trasferimento attivo (max 1 per sessione) */
    this._active = new Map();
    this.ssh = null;
    this._emitFn = () => {};
    this.storePath = null;
    /** cartella dove transitano i dati dei relay server -> server */
    this.tmpRoot = null;
    this._seq = 0;
    this._saveTimer = null;
  }

  /** @param {{ssh:object, emit:(ch:string,p:any)=>void, storePath:string, tmpRoot:string}} opts */
  init({ ssh, emit, storePath, tmpRoot }) {
    this.ssh = ssh;
    this._emitFn = emit;
    this.storePath = storePath;
    this.tmpRoot = tmpRoot;
    this._load();
  }

  // ---- API pubblica ---------------------------------------------------------

  /** Elenco completo (per popolare il pannello all'avvio del renderer). */
  list() {
    return [...this.items.values()].map((it) => this._view(it));
  }

  /**
   * Accoda il download di un file o di una cartella remota.
   * @param {{sessionId:string, remotePath:string, name:string, isDir:boolean,
   *          localPath:string, size?:number}} o
   */
  addDownload(o) {
    const it = this._make({
      type: 'download',
      kind: o.isDir ? 'dir' : 'file',
      sessionId: o.sessionId,
      name: o.name,
      remotePath: o.remotePath,
      localPath: o.localPath,
      // per i file singoli la dimensione arriva già dal listing: barra subito precisa
      total: !o.isDir && typeof o.size === 'number' ? o.size : null,
    });
    return this._enqueue(it);
  }

  /**
   * Accoda l'upload di un file o di una cartella locale dentro `destDir`.
   * @param {{sessionId:string, localPath:string, destDir:string}} o
   */
  addUpload(o) {
    let st;
    try {
      st = fs.statSync(o.localPath);
    } catch (e) {
      throw new Error(`Impossibile leggere ${o.localPath}: ${e.message}`);
    }
    const it = this._make({
      type: 'upload',
      kind: st.isDirectory() ? 'dir' : 'file',
      sessionId: o.sessionId,
      name: path.basename(o.localPath),
      localPath: o.localPath,
      destDir: o.destDir,
      total: st.isDirectory() ? null : st.size,
    });
    it.tmpRemote = `/tmp/rg-up-${it.id}`;
    return this._enqueue(it);
  }

  /**
   * Accoda la copia di un file/cartella da un server a un altro passando per il
   * disco locale: qui nasce solo la fase di download (verso una cartella
   * temporanea); l'upload sul server di destinazione viene accodato da
   * `_startRelayUpload` quando il download è finito.
   * @param {{srcSessionId:string, srcPath:string, name:string, isDir:boolean,
   *          size?:number, dstSessionId:string, destDir:string}} o
   */
  addRelay(o) {
    if (!this.tmpRoot) throw new Error('Cartella temporanea non configurata');
    const dst = this.ssh.serverInfo(o.dstSessionId);
    const it = this._make({
      type: 'download',
      kind: o.isDir ? 'dir' : 'file',
      sessionId: o.srcSessionId,
      name: o.name,
      remotePath: o.srcPath,
      total: !o.isDir && typeof o.size === 'number' ? o.size : null,
    });
    const stage = path.join(this.tmpRoot, `relay-${it.id}`);
    fs.mkdirSync(stage, { recursive: true });
    it.localPath = path.join(stage, o.name);
    it.groupId = it.id;
    // `dstServerKey` serve a ritrovare la destinazione se quella sessione cade
    // mentre il download è in corso (o se l'app viene riavviata a metà)
    it.relay = { dstSessionId: o.dstSessionId, dstServerKey: dst.key, destDir: o.destDir, stage };
    it.relayPair = { from: it.serverLabel, to: dst.label, srcPath: o.srcPath, destDir: o.destDir };
    return this._enqueue(it);
  }

  /** Seconda fase di un relay: carica sul server di destinazione quanto scaricato. */
  _startRelayUpload(it) {
    const r = it.relay;
    const sessionId = this.ssh.hasSession(r.dstSessionId)
      ? r.dstSessionId
      : this.ssh.findSessionByServerKey(r.dstServerKey);
    const up = this._make({
      type: 'upload',
      kind: it.kind,
      sessionId,
      serverKey: r.dstServerKey,
      serverLabel: it.relayPair ? it.relayPair.to : '',
      name: it.name,
      localPath: it.localPath,
      destDir: r.destDir,
      // per le cartelle la dimensione viene ricalcolata in locale da `_prepare`
      total: it.kind === 'dir' ? null : it.total,
    });
    up.tmpRemote = `/tmp/rg-up-${up.id}`;
    up.groupId = it.groupId || it.id;
    up.cleanupLocal = r.stage; // i dati locali erano solo di passaggio
    up.relayPair = it.relayPair;
    // destinazione non più connessa: la voce nasce in pausa, pronta a riprendere
    if (!sessionId) up.status = 'paused';
    return this._enqueue(up);
  }

  /** Sospende un trasferimento (i dati già trasferiti restano su disco). */
  pause(id) {
    const it = this.items.get(id);
    if (!it || it.status === 'done') return;
    it._abort = true;
    it.status = 'paused';
    it.speed = 0;
    // pausa voluta: non deve ripartire da sola alla prossima riconnessione
    it._netPaused = false;
    if (it._abortFn) { try { it._abortFn(); } catch (_) {} }
    this._emit(it);
    this._save();
  }

  /**
   * Riprende un trasferimento sospeso o in errore. Se la sessione originale non
   * esiste più (app riavviata, connessione caduta) cerca una sessione aperta sullo
   * stesso server; se non c'è, ritorna `{ok:false, reason:'no_session'}`.
   */
  resume(id) {
    const it = this.items.get(id);
    if (!it) return { ok: false, reason: 'not_found' };
    if (it.status === 'running' || it.status === 'queued' || it.status === 'done') return { ok: true };

    if (!it.sessionId || !this.ssh.hasSession(it.sessionId)) {
      const sid = this.ssh.findSessionByServerKey(it.serverKey);
      if (!sid) return { ok: false, reason: 'no_session', server: it.serverLabel };
      it.sessionId = sid;
    }
    it.status = 'queued';
    it.error = null;
    it._abort = false;
    this._emit(it);
    this._save();
    this._pump();
    return { ok: true };
  }

  /**
   * Rimuove un trasferimento dalla lista, interrompendolo se attivo, e pulisce i
   * dati parziali: i file `.rgpart` per i download, la cartella di staging remota
   * per gli upload. I file già completati di una cartella non vengono toccati.
   */
  remove(id) {
    const it = this.items.get(id);
    if (!it) return;
    it._abort = true;
    if (it._abortFn) { try { it._abortFn(); } catch (_) {} }
    this.items.delete(id);
    if (this._active.get(it.sessionId) === it.id) this._active.delete(it.sessionId);
    this._cleanupPartials(it);
    this._emitFn('transfer:removed', { id });
    this._save();
    this._pump();
  }

  /** Rimuove dalla lista tutti i trasferimenti completati. */
  clearDone() {
    for (const it of [...this.items.values()]) {
      if (it.status === 'done') {
        this.items.delete(it.id);
        this._emitFn('transfer:removed', { id: it.id });
      }
    }
    this._save();
  }

  /**
   * Una sessione SSH si è chiusa: i trasferimenti attivi/in coda su quella
   * sessione vanno in pausa, pronti a riprendere alla prossima connessione.
   */
  onSessionClosed(sessionId) {
    for (const it of this.items.values()) {
      if (it.sessionId !== sessionId) continue;
      if (it.status === 'running') {
        it._abort = true;
        it.status = 'paused';
        it.speed = 0;
        // messo in pausa dalla caduta, non dall'utente: va ripreso da solo
        it._netPaused = true;
        if (it._abortFn) { try { it._abortFn(); } catch (_) {} }
        this._emit(it);
      } else if (it.status === 'queued') {
        it.status = 'paused';
        it._netPaused = true;
        this._emit(it);
      }
    }
    this._active.delete(sessionId);
    this._save();
  }

  /**
   * La sessione è tornata su (stesso id, vedi `ssh.reconnect`): riprende solo i
   * trasferimenti che erano stati messi in pausa dalla caduta. Quelli fermati a
   * mano dall'utente restano fermi.
   */
  onSessionReconnected(sessionId) {
    for (const it of this.items.values()) {
      if (it.sessionId !== sessionId || !it._netPaused) continue;
      it._netPaused = false;
      if (it.status === 'paused') this.resume(it.id);
    }
  }

  // ---- Coda -----------------------------------------------------------------

  _make(fields) {
    const id = 't' + ++this._seq + '_' + Date.now();
    // la sessione può mancare (seconda fase di un relay verso un server che si è
    // disconnesso): in quel caso chiave ed etichetta arrivano da `fields`
    const info = fields.sessionId && this.ssh.hasSession(fields.sessionId)
      ? this.ssh.serverInfo(fields.sessionId)
      : { key: null, label: '' };
    return {
      id,
      status: 'queued',
      transferred: 0,
      total: null,
      speed: 0,
      error: null,
      currentFile: null,
      prepared: false,
      files: null,   // manifest delle cartelle: [{rel, size, dir}]
      doneIdx: 0,    // primo file del manifest ancora da trasferire
      baseDone: 0,   // byte dei file già completati (cartelle)
      createdAt: Date.now(),
      serverKey: info.key,
      serverLabel: info.label,
      ...fields,
    };
  }

  _enqueue(it) {
    this.items.set(it.id, it);
    this._emit(it);
    this._save();
    this._pump();
    return this._view(it);
  }

  /** Avvia i trasferimenti in coda rispettando il limite di 1 per sessione. */
  _pump() {
    for (const it of this.items.values()) {
      if (it.status !== 'queued' || !it.sessionId) continue;
      if (this._active.has(it.sessionId)) continue;
      if (!this.ssh.hasSession(it.sessionId)) {
        it.status = 'paused';
        this._emit(it);
        continue;
      }
      this._active.set(it.sessionId, it.id);
      this._run(it);
    }
  }

  async _run(it) {
    it.status = 'running';
    it.error = null;
    it._abort = false;
    it._spd = { t: Date.now(), b: it.transferred };
    it._lastEmit = 0;
    this._emit(it);

    try {
      if (!this.ssh.hasSession(it.sessionId)) throw new Error('Sessione SSH non più attiva');
      // primo avvio in assoluto: elimina eventuali parziali rimasti da un
      // trasferimento precedente sulla stessa destinazione (es. app terminata
      // brutalmente), altrimenti li riprenderemmo come se fossero nostri
      if (!it.started) {
        it.started = true;
        // la cartella temporanea di un relay è appena creata e univoca per voce:
        // non ci sono parziali di altri trasferimenti da ripulire
        if (it.type === 'download' && !it.relay) this._cleanupPartials(it);
      }
      if (it.type === 'upload' && !fs.existsSync(it.localPath)) {
        throw new Error(`Dati locali non più disponibili: ${it.localPath}`);
      }
      if (!it.prepared) await this._prepare(it);
      if (it.type === 'upload') {
        await this.ssh.exec(it.sessionId, `mkdir -p ${q(it.tmpRemote)}`);
      }
      if (it.kind === 'dir') await this._runDir(it);
      else await this._runFile(it);
      if (it.type === 'upload') await this._finalizeUpload(it);

      it.status = 'done';
      it.transferred = it.total == null ? it.transferred : it.total;
      it.currentFile = null;
      it.speed = 0;
      // relay: finito il download parte la fase di upload sull'altro server
      if (it.relay) this._startRelayUpload(it);
    } catch (e) {
      it.speed = 0;
      it.currentFile = null;
      // se nel frattempo è già stato richiesto un nuovo avvio (pausa + ripresa
      // rapida), lo stato 'queued' non va sovrascritto: ci pensa _pump()
      if (it.status !== 'queued') {
        if (it._abort || (e && e.message === ABORT)) {
          it.status = 'paused';
        } else {
          it.status = 'error';
          it.error = (e && e.message) || String(e);
        }
      }
    } finally {
      it._abortFn = null;
      if (this._active.get(it.sessionId) === it.id) this._active.delete(it.sessionId);
      this._emit(it);
      this._save();
      this._pump();
    }
  }

  /** Calcola dimensione totale e (per le cartelle) l'elenco dei file da trasferire. */
  async _prepare(it) {
    if (it.type === 'download') {
      const sftp = await this.ssh.sftp(it.sessionId);
      if (it.kind === 'dir') {
        const files = [];
        await this._walkRemote(sftp, it.remotePath, '', files);
        it.files = files;
        it.total = files.reduce((s, f) => s + (f.size || 0), 0);
      } else {
        const st = await this._statRemote(sftp, it.remotePath);
        it.total = st.size;
      }
    } else if (it.kind === 'dir') {
      const files = [];
      walkLocal(it.localPath, '', files);
      it.files = files;
      it.total = files.reduce((s, f) => s + (f.size || 0), 0);
    }
    it.prepared = true;
    this._emit(it);
    this._save();
  }

  async _runFile(it) {
    if (it.type === 'download') {
      await this._pullFile(it, it.remotePath, it.localPath, it.total, 0);
    } else {
      await this._pushFile(it, it.localPath, `${it.tmpRemote}/${it.name}`, it.total, 0);
    }
  }

  /**
   * Trasferisce i file di una cartella partendo da `doneIdx`: dopo una pausa o un
   * riavvio riprende dal file interrotto, saltando quelli già completati.
   */
  async _runDir(it) {
    const remoteRoot = it.type === 'download' ? it.remotePath : `${it.tmpRemote}/${it.name}`;

    // download: la cartella di destinazione esiste anche se è vuota
    if (it.type === 'download') fs.mkdirSync(it.localPath, { recursive: true });

    // upload: crea in blocco l'albero di cartelle remoto (poche chiamate invece di una per file)
    if (it.type === 'upload' && !it._dirsMade) {
      const dirs = [remoteRoot, ...it.files.filter((f) => f.dir).map((f) => joinRemote(remoteRoot, f.rel))];
      for (let i = 0; i < dirs.length; i += 40) {
        await this.ssh.exec(it.sessionId, 'mkdir -p ' + dirs.slice(i, i + 40).map(q).join(' '));
      }
      it._dirsMade = true;
    }

    for (let i = it.doneIdx; i < it.files.length; i++) {
      if (it._abort) throw new Error(ABORT);
      const f = it.files[i];
      it.currentFile = f.rel;
      if (it.type === 'download') {
        const target = path.join(it.localPath, ...f.rel.split('/'));
        if (f.dir) fs.mkdirSync(target, { recursive: true });
        else await this._pullFile(it, joinRemote(it.remotePath, f.rel), target, f.size, it.baseDone);
      } else if (!f.dir) {
        await this._pushFile(
          it,
          path.join(it.localPath, ...f.rel.split('/')),
          joinRemote(remoteRoot, f.rel),
          f.size,
          it.baseDone
        );
      }
      it.doneIdx = i + 1;
      it.baseDone += f.size || 0;
      it.transferred = it.baseDone;
      this._emit(it, true);
      this._save();
    }
  }

  /**
   * Scarica un singolo file remoto in `localFinal`, riprendendo dal punto in cui
   * si era interrotto (dimensione del `.rgpart` già presente).
   * `base` = byte già conteggiati per i file precedenti (progresso cartella).
   */
  async _pullFile(it, remote, localFinal, size, base) {
    fs.mkdirSync(path.dirname(localFinal), { recursive: true });
    const part = localFinal + PART;

    if (size === 0) {
      fs.writeFileSync(localFinal, '');
      try { fs.unlinkSync(part); } catch (_) {}
      return;
    }

    let offset = 0;
    try { offset = fs.statSync(part).size; } catch (_) {}
    if (size != null && offset > size) {
      // il parziale è più grande dell'originale (file cambiato sul server): riparti
      try { fs.unlinkSync(part); } catch (_) {}
      offset = 0;
    }
    if (size != null && offset === size) {
      fs.renameSync(part, localFinal);
      it.transferred = base + size;
      return;
    }

    const sftp = await this.ssh.sftp(it.sessionId);
    it.transferred = base + offset;
    await new Promise((resolve, reject) => {
      if (it._abort) return reject(new Error(ABORT));
      const rs = sftp.createReadStream(remote, { start: offset });
      const ws = fs.createWriteStream(part, offset ? { flags: 'r+', start: offset } : { flags: 'w' });
      let settled = false;
      let aborted = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        it._abortFn = null;
        if (err) reject(err); else resolve();
      };
      // pausa: chiudi il read stream e svuota il buffer di scrittura, così il
      // .rgpart su disco resta un prefisso valido del file
      it._abortFn = () => {
        aborted = true;
        try { rs.destroy(); } catch (_) {}
        ws.end();
      };
      rs.on('data', (c) => this._onBytes(it, c.length));
      rs.on('error', (e) => { try { ws.destroy(); } catch (_) {} finish(e); });
      ws.on('error', (e) => { try { rs.destroy(); } catch (_) {} finish(e); });
      ws.on('finish', () => finish(aborted ? new Error(ABORT) : null));
      rs.pipe(ws);
    });
    fs.renameSync(part, localFinal);
  }

  /**
   * Carica un singolo file locale nel percorso remoto di staging, riprendendo
   * dalla dimensione già presente sul server.
   */
  async _pushFile(it, local, remote, size, base) {
    const sftp = await this.ssh.sftp(it.sessionId);

    if (size === 0) {
      await new Promise((resolve, reject) => {
        const ws = sftp.createWriteStream(remote, { flags: 'w' });
        ws.on('error', reject);
        ws.on('close', resolve);
        ws.end();
      });
      return;
    }

    let offset = 0;
    const st = await this._statRemote(sftp, remote).catch(() => null);
    if (st) offset = st.size;
    if (offset > size) {
      await new Promise((resolve) => sftp.unlink(remote, () => resolve()));
      offset = 0;
    }
    if (offset === size) {
      it.transferred = base + size;
      return;
    }

    it.transferred = base + offset;
    await new Promise((resolve, reject) => {
      if (it._abort) return reject(new Error(ABORT));
      const rs = fs.createReadStream(local, { start: offset });
      const ws = sftp.createWriteStream(remote, offset ? { flags: 'r+', start: offset } : { flags: 'w' });
      let settled = false;
      let aborted = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        it._abortFn = null;
        if (err) reject(err); else resolve();
      };
      it._abortFn = () => {
        aborted = true;
        try { rs.destroy(); } catch (_) {}
        ws.end();
      };
      rs.on('data', (c) => this._onBytes(it, c.length));
      rs.on('error', (e) => { try { ws.destroy(); } catch (_) {} finish(e); });
      ws.on('error', (e) => { try { rs.destroy(); } catch (_) {} finish(e); });
      // 'close' (e non 'finish') garantisce che l'handle remoto sia chiuso
      ws.on('close', () => finish(aborted ? new Error(ABORT) : null));
      rs.pipe(ws);
    });
  }

  /** Sposta lo staging nella destinazione finale (con sudo) e lo rimuove. */
  async _finalizeUpload(it) {
    const staged = `${it.tmpRemote}/${it.name}`;
    await this.ssh.sudoExec(it.sessionId, `cp -r ${q(staged)} ${q(it.destDir)}/`);
    await this.ssh.exec(it.sessionId, `rm -rf ${q(it.tmpRemote)}`).catch(() => {});
    if (it.cleanupLocal) rmDirSafe(it.cleanupLocal);
  }

  // ---- Utility SFTP ---------------------------------------------------------

  _statRemote(sftp, p) {
    return new Promise((resolve, reject) => {
      sftp.stat(p, (err, st) => (err ? reject(err) : resolve(st)));
    });
  }

  /** Costruisce il manifest di una cartella remota (file e sottocartelle, symlink esclusi). */
  async _walkRemote(sftp, root, rel, out) {
    const dir = rel ? joinRemote(root, rel) : root;
    const list = await new Promise((resolve, reject) => {
      sftp.readdir(dir, (err, l) => (err ? reject(err) : resolve(l)));
    });
    for (const e of list) {
      if (e.filename === '.' || e.filename === '..') continue;
      const m = e.attrs.mode;
      const isDir = (m & 0o170000) === 0o040000;
      const isLink = (m & 0o170000) === 0o120000;
      if (isLink) continue; // symlink saltati per evitare loop
      const childRel = rel ? `${rel}/${e.filename}` : e.filename;
      if (isDir) {
        out.push({ rel: childRel, size: 0, dir: true });
        await this._walkRemote(sftp, root, childRel, out);
      } else {
        out.push({ rel: childRel, size: e.attrs.size || 0 });
      }
    }
  }

  /** Elimina i dati parziali di un trasferimento rimosso. */
  _cleanupPartials(it) {
    // relay: la cartella temporanea locale è tutta nostra e va via intera, ma
    // solo se l'altra fase non è ancora in lista (starebbe leggendo da lì)
    const stage = it.relay ? it.relay.stage : it.cleanupLocal;
    if (stage && !this._hasSibling(it)) rmDirSafe(stage);

    if (it.type === 'download') {
      if (stage) return;
      if (it.kind === 'file') {
        try { fs.unlinkSync(it.localPath + PART); } catch (_) {}
      } else {
        removePartsRecursive(it.localPath);
      }
    } else if (it.tmpRemote && it.sessionId && this.ssh.hasSession(it.sessionId)) {
      this.ssh.exec(it.sessionId, `rm -rf ${q(it.tmpRemote)}`).catch(() => {});
    }
  }

  /** True se in lista c'è l'altra fase, non ancora completata, dello stesso relay. */
  _hasSibling(it) {
    if (!it.groupId) return false;
    for (const other of this.items.values()) {
      if (other.id !== it.id && other.groupId === it.groupId && other.status !== 'done') return true;
    }
    return false;
  }

  // ---- Avanzamento / eventi -------------------------------------------------

  /** Conta i byte trasferiti ed emette l'avanzamento al massimo 5 volte al secondo. */
  _onBytes(it, n) {
    it.transferred += n;
    const now = Date.now();
    if (now - (it._lastEmit || 0) < 200) return;
    const dt = (now - it._spd.t) / 1000;
    if (dt >= 0.6) {
      it.speed = Math.max(0, (it.transferred - it._spd.b) / dt);
      it._spd = { t: now, b: it.transferred };
    }
    it._lastEmit = now;
    this._emit(it);
  }

  _emit(it) {
    if (!this.items.has(it.id)) return; // trasferimento rimosso nel frattempo
    this._emitFn('transfer:update', this._view(it));
  }

  /** Campi visibili al renderer. */
  _view(it) {
    return {
      id: it.id,
      type: it.type,
      kind: it.kind,
      name: it.name,
      serverLabel: it.serverLabel,
      remotePath: it.remotePath || null,
      localPath: it.localPath,
      destDir: it.destDir || null,
      total: it.total,
      transferred: it.transferred,
      speed: it.speed || 0,
      status: it.status,
      error: it.error,
      currentFile: it.currentFile,
      groupId: it.groupId || null,
      relayPair: it.relayPair || null,
      fileCount: it.files ? it.files.filter((f) => !f.dir).length : null,
      fileDone: it.files ? it.files.slice(0, it.doneIdx).filter((f) => !f.dir).length : null,
      createdAt: it.createdAt,
    };
  }

  // ---- Persistenza ----------------------------------------------------------

  _save() {
    if (!this.storePath) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._saveNow(), 400);
  }

  _saveNow() {
    if (!this.storePath) return;
    const data = [...this.items.values()]
      .filter((it) => it.status !== 'done')
      .map((it) => ({
        id: it.id, type: it.type, kind: it.kind, name: it.name,
        serverKey: it.serverKey, serverLabel: it.serverLabel,
        remotePath: it.remotePath || null, localPath: it.localPath,
        destDir: it.destDir || null, tmpRemote: it.tmpRemote || null,
        relay: it.relay || null, relayPair: it.relayPair || null,
        groupId: it.groupId || null, cleanupLocal: it.cleanupLocal || null,
        total: it.total, transferred: it.transferred, status: it.status,
        error: it.error, prepared: it.prepared, started: it.started, files: it.files,
        doneIdx: it.doneIdx, baseDone: it.baseDone, createdAt: it.createdAt,
      }));
    try {
      const tmp = this.storePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, this.storePath);
    } catch (_) { /* coda non salvabile: non è un errore bloccante */ }
  }

  /** Ricarica la coda salvata: tutto ciò che era incompleto torna in pausa. */
  _load() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
    } catch (_) { return; }
    if (!Array.isArray(data)) return;
    for (const o of data) {
      if (!o || !o.id || o.status === 'done') continue;
      this.items.set(o.id, {
        ...o,
        sessionId: null,       // la sessione va ri-agganciata alla ripresa
        status: 'paused',
        speed: 0,
        error: null,
        currentFile: null,
        files: Array.isArray(o.files) ? o.files : null,
        doneIdx: o.doneIdx || 0,
        baseDone: o.baseDone || 0,
      });
    }
  }
}

function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function joinRemote(dir, rel) {
  return dir.replace(/\/+$/, '') + '/' + rel;
}

/** Manifest di una cartella locale (file e sottocartelle, symlink esclusi). */
function walkLocal(root, rel, out) {
  const dir = rel ? path.join(root, ...rel.split('/')) : root;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(full); } catch (_) { continue; }
    if (st.isSymbolicLink()) continue;
    const childRel = rel ? `${rel}/${name}` : name;
    if (st.isDirectory()) {
      out.push({ rel: childRel, size: 0, dir: true });
      walkLocal(root, childRel, out);
    } else if (st.isFile()) {
      out.push({ rel: childRel, size: st.size });
    }
  }
}

/** Elimina una cartella con tutto il contenuto, ignorando gli errori. */
function rmDirSafe(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/** Elimina ricorsivamente i soli file parziali (.rgpart) sotto `dir`. */
function removePartsRecursive(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) removePartsRecursive(full);
    else if (e.name.endsWith(PART)) { try { fs.unlinkSync(full); } catch (_) {} }
  }
}

module.exports = new TransferManager();

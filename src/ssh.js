'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

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

  /** Elenca il contenuto di una cartella (per il bottone "ll" / cartelle cliccabili). */
  async listDir(id, dir) {
    const sftp = await this._sftp(id);
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
        size: e.attrs.size,
        mtime: e.attrs.mtime,
        longname: e.longname,
      };
    });
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { cwd: abs, entries };
  }

  /** Risolve un path relativo rispetto alla cwd in path assoluto. */
  async realpath(id, p) {
    const sftp = await this._sftp(id);
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

  /** Verifica (con sudo) se un percorso remoto esiste già. */
  async _remoteExists(id, remotePath) {
    try {
      await this.sudoExec(id, `test -e ${shellQuote(remotePath)}`);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Importa un file o cartella locale nel server, dentro `destDir`.
   * Carica prima in /tmp via SFTP (scrivibile dall'utente), poi copia nella
   * destinazione con sudo per gestire eventuali permessi (es. /opt).
   */
  async importPath(id, localPath, destDir) {
    const sftp = await this._sftp(id);
    const base = path.basename(localPath);
    const tmpRoot = `/tmp/rg-import-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await this._sftpMkdir(sftp, tmpRoot);
    try {
      await this._sftpPut(sftp, localPath, `${tmpRoot}/${base}`);
      await this.sudoExec(id, `cp -r ${shellQuote(tmpRoot + '/' + base)} ${shellQuote(destDir)}/`);
    } finally {
      // pulizia del temporaneo (best-effort)
      await this.exec(id, `rm -rf ${shellQuote(tmpRoot)}`).catch(() => {});
    }
    return base;
  }

  _sftpMkdir(sftp, dir) {
    return new Promise((resolve, reject) => {
      sftp.mkdir(dir, (err) => (err ? reject(err) : resolve()));
    });
  }

  async _sftpPut(sftp, local, remote) {
    const st = fs.statSync(local);
    if (st.isDirectory()) {
      await this._sftpMkdir(sftp, remote);
      for (const name of fs.readdirSync(local)) {
        await this._sftpPut(sftp, path.join(local, name), remote + '/' + name);
      }
    } else {
      await new Promise((resolve, reject) => {
        sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve()));
      });
    }
  }

  /** Crea un file vuoto (touch) nel percorso indicato, con privilegi sudo. */
  async createFile(id, remotePath) {
    return this.sudoExec(id, `touch ${shellQuote(remotePath)}`);
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
          if (code === 0) resolve(out);
          else reject(new Error(errOut.trim() || `Comando uscito con codice ${code}`));
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
          reject(new Error(msg || `Comando uscito con codice ${code}`));
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

  /** Scarica un file remoto in locale. */
  async download(id, remotePath, localPath) {
    const sftp = await this._sftp(id);
    return new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) => (err ? reject(err) : resolve(localPath)));
    });
  }

  /** Scarica ricorsivamente una cartella remota in locale (`localPath`). */
  async downloadDir(id, remotePath, localPath) {
    const sftp = await this._sftp(id);
    fs.mkdirSync(localPath, { recursive: true });
    const entries = await new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, l) => (err ? reject(err) : resolve(l)));
    });
    for (const e of entries) {
      const rem = remotePath.replace(/\/+$/, '') + '/' + e.filename;
      const loc = path.join(localPath, e.filename);
      const isDir = (e.attrs.mode & 0o170000) === 0o040000;
      const isLink = (e.attrs.mode & 0o170000) === 0o120000;
      if (isLink) continue; // salta i symlink per evitare loop
      if (isDir) await this.downloadDir(id, rem, loc);
      else {
        await new Promise((resolve, reject) => {
          sftp.fastGet(rem, loc, (err) => (err ? reject(err) : resolve()));
        });
      }
    }
    return localPath;
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

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// SQL per elencare i database (escludendo i template): nome, proprietario, dimensione.
const PG_LIST_SQL =
  'SELECT datname, pg_catalog.pg_get_userbyid(datdba), ' +
  'pg_size_pretty(pg_database_size(datname)) ' +
  'FROM pg_database WHERE datistemplate = false ORDER BY datname;';

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

function humanBytes(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = Number(bytes) || 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}

module.exports = new SshManager();

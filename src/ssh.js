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
  connect(server, onData, onCwd, onClose) {
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
            const { clean, cwd } = session.extractCwd(chunk.toString('utf8'));
            if (cwd && cwd !== session.cwd) {
              session.cwd = cwd;
              onCwd(id, cwd);
            }
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
      `__RG() { printf '\\033]1337;CWD=%s\\007' "$PWD"; }; ` +
      `PROMPT_COMMAND="__RG;$PROMPT_COMMAND"; ` +
      `if [ -n "$ZSH_VERSION" ]; then precmd() { __RG; }; fi; ` +
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

  /** Copia remoto->remoto (usato da copia/incolla), con privilegi sudo. */
  async copyRemote(id, src, destDir, isDir) {
    const flag = isDir ? '-r' : '';
    return this.sudoExec(id, `cp ${flag} ${shellQuote(src)} ${shellQuote(destDir)}/`);
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
    if (!(await this._localImageExists(image))) {
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

    onProgress({ phase: 'done', pct: 100, text: `Completato — ritaggata come ${targetImage}` });
    return { ok: true, image, targetImage };
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
   * Estrae il marker CWD (OSC 1337;CWD=...) dal flusso e ritorna il testo "pulito".
   * Gestisce il marker spezzato su più chunk.
   */
  extractCwd(text) {
    let data = this._cwdBuf + text;
    this._cwdBuf = '';
    let cwd = null;
    const re = /\x1b\]1337;CWD=([^\x07]*)\x07/g;
    let clean = data.replace(re, (_, p) => {
      cwd = p;
      return '';
    });
    // se è rimasto un marker parziale a fine buffer, mettilo da parte
    const partial = clean.lastIndexOf('\x1b]1337;CWD=');
    if (partial !== -1 && clean.indexOf('\x07', partial) === -1) {
      this._cwdBuf = clean.slice(partial);
      clean = clean.slice(0, partial);
    }
    return { clean, cwd };
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
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

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

module.exports = new SshManager();

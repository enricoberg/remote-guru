'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const remoteTools = require('./claude-tools');

/**
 * Assistente Claude (Agent SDK) per esplorare il server di una scheda.
 *
 * - Login: si usa il Claude Code incluso nell'SDK (`claude auth login`), che apre
 *   il browser. Le credenziali restano su questo computer, in una cartella di
 *   configurazione dedicata all'app (non quella di un Claude Code personale) e
 *   non vengono mai inviate al server remoto.
 * - Chat: nessuno strumento integrato (niente shell o file locali); il modello
 *   vede solo gli strumenti in sola lettura di claude-tools.js.
 * - Cronologia: un file JSON locale con le chat raggruppate per server.
 */

// variabili che farebbero usare a Claude Code credenziali diverse dal login dell'app
const AUTH_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'];

const TOOL_TIMEOUT = 10 * 60 * 1000; // lascia all'utente il tempo di rispondere alle conferme
const MAX_SAVED_OUTPUT = 4000; // anteprima dell'output di uno strumento salvata nella cronologia

class ClaudeManager {
  init({ ssh, emit, userDataDir, appPath, version }) {
    this.ssh = ssh;
    this.emit = emit;
    this.appPath = appPath;
    this.version = version;
    this.configDir = path.join(userDataDir, 'claude');
    // cwd fissa: Claude Code salva le sessioni per cartella, serve per riprenderle
    this.workDir = path.join(this.configDir, 'workspace');
    this.storePath = path.join(userDataDir, 'claude-chats.json');
    fs.mkdirSync(this.workDir, { recursive: true });
    /** chatId -> { abort, pending:Map<confirmId, resolve> } */
    this.runs = new Map();
    /** chatId -> Set di chiavi già consentite "per questa chat" */
    this.allowed = new Map();
    /** confirmId -> chatId */
    this.confirms = new Map();
    this.loginProc = null;
  }

  // ---- binario ed ambiente ---------------------------------------------------------

  /** Eseguibile nativo di Claude Code distribuito con l'SDK (fuori da app.asar). */
  binary() {
    const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const p = path.join(this.appPath, 'node_modules', '@anthropic-ai', pkg, exe);
    return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  }

  env() {
    const env = { ...process.env };
    AUTH_ENV.forEach((k) => delete env[k]);
    env.CLAUDE_CONFIG_DIR = this.configDir;
    env.CLAUDE_AGENT_SDK_CLIENT_APP = `remote-guru/${this.version}`;
    return env;
  }

  _runCli(args) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.binary(), args, { env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        return resolve({ code: -1, stdout: '', stderr: e.message });
      }
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (e) => resolve({ code: -1, stdout, stderr: e.message }));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  // ---- autenticazione --------------------------------------------------------------

  async authStatus() {
    const r = await this._runCli(['auth', 'status', '--json']);
    try {
      const j = JSON.parse(r.stdout);
      return {
        loggedIn: !!j.loggedIn,
        email: j.email || null,
        orgName: j.orgName || null,
        subscription: j.subscriptionType || null,
      };
    } catch (_) {
      return { loggedIn: false, error: (r.stderr || r.stdout || '').trim() || 'Claude Code non disponibile' };
    }
  }

  /**
   * Avvia `claude auth login`: Claude Code apre il browser e riceve la risposta su
   * localhost. Se il browser non riesce a tornare all'app, la pagina mostra un
   * codice da incollare (vedi loginCode). Gli esiti arrivano come 'claude:login'.
   */
  login() {
    if (this.loginProc) return true;
    const child = spawn(this.binary(), ['auth', 'login', '--claudeai'], { env: this.env(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.loginProc = child;
    let out = '';
    let urlSent = false;
    const onData = (d) => {
      out += d;
      const m = !urlSent && out.match(/https:\/\/\S+/);
      if (m) {
        urlSent = true;
        this.emit('claude:login', { state: 'url', url: m[0] });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      this.loginProc = null;
      this.emit('claude:login', { state: 'failed', error: e.message });
    });
    child.on('close', async (code) => {
      if (this.loginProc !== child) return;
      this.loginProc = null;
      const status = await this.authStatus();
      const tail = out.split('\n').map((l) => l.trim()).filter((l) => l && !/^https?:/.test(l)).slice(-2).join(' ');
      this.emit('claude:login', status.loggedIn
        ? { state: 'done', status }
        : { state: 'failed', error: code === null ? null : tail || `exit ${code}` });
    });
    return true;
  }

  /** Codice copiato dalla pagina di login, se il ritorno automatico non è riuscito. */
  loginCode(code) {
    if (!this.loginProc) return false;
    this.loginProc.stdin.write(String(code).trim() + '\n');
    return true;
  }

  cancelLogin() {
    const child = this.loginProc;
    this.loginProc = null;
    if (child) child.kill();
    return true;
  }

  async logout() {
    await this._runCli(['auth', 'logout']);
    return this.authStatus();
  }

  // ---- chat ---------------------------------------------------------------------------

  /**
   * Avvia un turno di conversazione. Gli eventi arrivano al renderer come
   * 'claude:event' con { chatId, type, ... }; l'ultimo è sempre type 'end'.
   */
  async send({ chatId, sshId, prompt, model, effort, sessionId, context }) {
    if (this.runs.has(chatId)) throw new Error('Una risposta è già in corso');
    if (!this.ssh.hasSession(sshId)) throw new Error('Sessione SSH non attiva');
    const run = { abort: new AbortController(), pending: new Map() };
    this.runs.set(chatId, run);
    const emit = (ev) => this.emit('claude:event', { chatId, ...ev });

    let sdk;
    let z;
    try {
      sdk = await import('@anthropic-ai/claude-agent-sdk');
      ({ z } = require('zod'));
    } catch (e) {
      this.runs.delete(chatId);
      throw e;
    }

    const confirm = (req) => this._confirm(chatId, run, req, emit);
    const server = sdk.createSdkMcpServer({
      name: 'remote',
      version: '1.0.0',
      timeout: TOOL_TIMEOUT,
      alwaysLoad: true,
      tools: remoteTools.buildTools({ tool: sdk.tool, z, ssh: this.ssh, sshId, confirm }),
    });

    const options = {
      cwd: this.workDir,
      pathToClaudeCodeExecutable: this.binary(),
      env: this.env(),
      model,
      effort,
      tools: [],
      mcpServers: { remote: server },
      strictMcpConfig: true,
      allowedTools: remoteTools.TOOL_NAMES.map((n) => `mcp__remote__${n}`),
      permissionMode: 'dontAsk',
      settingSources: [],
      systemPrompt: systemPrompt(context || {}),
      includePartialMessages: true,
      abortController: run.abort,
    };
    if (sessionId) options.resume = sessionId;

    (async () => {
      let failed = false;
      try {
        for await (const m of sdk.query({ prompt, options })) {
          if (this._forward(m, emit)) failed = true;
        }
      } catch (e) {
        // dopo un result di errore l'SDK rilancia lo stesso messaggio: già mostrato
        if (!run.abort.signal.aborted && !failed) {
          failed = true;
          emit({ type: 'error', message: e.message });
        }
      } finally {
        this.runs.delete(chatId);
        run.pending.forEach((resolve) => resolve(false));
        run.pending.clear();
        if (failed) {
          // un errore di autenticazione va mostrato come richiesta di login
          const st = await this.authStatus();
          if (!st.loggedIn) emit({ type: 'auth_required' });
        }
        emit({ type: 'end', aborted: run.abort.signal.aborted });
      }
    })();
    return true;
  }

  /** Traduce un messaggio dell'SDK in eventi per il renderer. True se è un errore. */
  _forward(m, emit) {
    if (m.type === 'system' && m.subtype === 'init') {
      emit({ type: 'session', sessionId: m.session_id, model: m.model });
    } else if (m.type === 'stream_event') {
      const ev = m.event;
      if (m.parent_tool_use_id) return false;
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
        emit({ type: 'text', text: ev.delta.text });
      } else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'thinking') {
        emit({ type: 'thinking' });
      }
    } else if (m.type === 'assistant') {
      (m.message.content || []).forEach((b) => {
        if (b.type === 'tool_use') {
          emit({ type: 'tool', toolId: b.id, name: String(b.name).replace(/^mcp__remote__/, ''), input: b.input });
        }
      });
    } else if (m.type === 'user' && m.message && Array.isArray(m.message.content)) {
      m.message.content.forEach((b) => {
        if (b.type !== 'tool_result') return;
        const text = Array.isArray(b.content)
          ? b.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
          : String(b.content || '');
        emit({ type: 'tool_result', toolId: b.tool_use_id, isError: !!b.is_error, text: text.slice(0, MAX_SAVED_OUTPUT) });
      });
    } else if (m.type === 'result') {
      const isError = !!m.is_error;
      emit({
        type: 'result',
        isError,
        error: isError ? (m.result || (m.errors || []).join('\n') || m.subtype) : null,
        costUsd: m.total_cost_usd,
        durationMs: m.duration_ms,
      });
      return isError;
    }
    return false;
  }

  /** Chiede all'utente il permesso per un'operazione bloccata di default. */
  _confirm(chatId, run, req, emit) {
    const allowed = this.allowed.get(chatId);
    if (allowed && allowed.has(req.key)) return Promise.resolve(true);
    if (run.abort.signal.aborted) return Promise.resolve(false);
    const confirmId = crypto.randomUUID();
    return new Promise((resolve) => {
      run.pending.set(confirmId, resolve);
      this.confirms.set(confirmId, { chatId, key: req.key });
      emit({ type: 'confirm', confirmId, kind: req.kind, path: req.path || null, command: req.command || null });
    });
  }

  /** Risposta dell'utente: 'once' | 'chat' (vale per tutta la chat) | 'deny'. */
  answerConfirm(confirmId, decision) {
    const info = this.confirms.get(confirmId);
    this.confirms.delete(confirmId);
    if (!info) return false;
    const run = this.runs.get(info.chatId);
    const resolve = run && run.pending.get(confirmId);
    if (!resolve) return false;
    run.pending.delete(confirmId);
    if (decision === 'chat') {
      if (!this.allowed.has(info.chatId)) this.allowed.set(info.chatId, new Set());
      this.allowed.get(info.chatId).add(info.key);
    }
    resolve(decision === 'once' || decision === 'chat');
    return true;
  }

  stop(chatId) {
    const run = this.runs.get(chatId);
    if (!run) return false;
    run.abort.abort();
    run.pending.forEach((resolve) => resolve(false));
    run.pending.clear();
    return true;
  }

  shutdown() {
    this.runs.forEach((run) => run.abort.abort());
    this.cancelLogin();
  }

  // ---- cronologia locale ----------------------------------------------------------

  _readStore() {
    try {
      const data = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      return data && typeof data === 'object' && data.servers ? data : { servers: {} };
    } catch (_) {
      return { servers: {} };
    }
  }

  _writeStore(data) {
    fs.writeFileSync(this.storePath, JSON.stringify(data), 'utf8');
  }

  /** Chat di un server, dalla più recente, senza i messaggi (solo l'elenco). */
  listChats(serverKey) {
    const chats = this._readStore().servers[serverKey] || [];
    return chats
      .map(({ id, title, model, effort, createdAt, updatedAt, messages }) =>
        ({ id, title, model, effort, createdAt, updatedAt, count: (messages || []).length }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  getChat(serverKey, chatId) {
    const chats = this._readStore().servers[serverKey] || [];
    return chats.find((c) => c.id === chatId) || null;
  }

  saveChat(serverKey, chat) {
    const data = this._readStore();
    const list = data.servers[serverKey] || [];
    const i = list.findIndex((c) => c.id === chat.id);
    if (i >= 0) list[i] = chat;
    else list.push(chat);
    data.servers[serverKey] = list;
    this._writeStore(data);
    return true;
  }

  deleteChat(serverKey, chatId) {
    const data = this._readStore();
    data.servers[serverKey] = (data.servers[serverKey] || []).filter((c) => c.id !== chatId);
    if (!data.servers[serverKey].length) delete data.servers[serverKey];
    this._writeStore(data);
    this.allowed.delete(chatId);
    return true;
  }
}

function systemPrompt({ label, host, username, cwd, language }) {
  return [
    'You are Claude, the assistant built into Remote Guru, a desktop SSH client.',
    `You are helping the user inspect the remote server "${label || host}" (${username}@${host}).`,
    cwd ? `The user's terminal is currently in ${cwd}.` : '',
    '',
    'You can observe the server ONLY through the provided tools, and they are strictly read-only:',
    'you cannot create, modify, delete, restart or install anything. When a fix needs a change,',
    'explain it and give the exact commands for the user to run themselves in the terminal,',
    'and never claim you ran or changed something.',
    '',
    'Reading sensitive files (SSH keys, .env files, credentials, private keys) needs the',
    "user's approval, which the tools request automatically. If access is denied, respect it and do",
    'not look for another way to read the same data.',
    '',
    'Investigate before answering: check facts with the tools instead of guessing, and prefer',
    'targeted reads (limits, offsets, grep) over dumping large files or logs.',
    `Answer in the user's language${language ? ` (UI language: ${language})` : ''}, concisely, using Markdown.`,
  ].filter((l, i, a) => l || a[i - 1]).join('\n');
}

module.exports = new ClaudeManager();

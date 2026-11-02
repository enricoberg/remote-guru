'use strict';

/**
 * Strumenti dell'assistente Claude per esplorare il server remoto in SOLA LETTURA.
 *
 * Il modello non ha una shell: può solo chiamare questi strumenti, che girano
 * nel main process sulla sessione SSH della scheda. `run_command` accetta solo
 * i comandi della lista qui sotto, con gli argomenti passati uno per uno e
 * citati singolarmente: niente pipe, redirezioni, `;`, `$()` o glob, quindi
 * non c'è modo di comporre un comando che scriva.
 *
 * I file sensibili (chiavi, .env, credenziali...) sono bloccati: per leggerli
 * serve la conferma dell'utente, chiesta tramite `confirm`.
 */

const MAX_OUTPUT = 100000; // caratteri restituiti al modello per ogni chiamata
const CMD_TIMEOUT = 30000;
const DEFAULT_TAIL = '300'; // righe di log quando il modello non ne indica

function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ---- percorsi sensibili --------------------------------------------------------

const SENSITIVE_PATHS = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)[^/]*$/,
  /(^|\/)[^/]*\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/i,
  /(^|\/)\.env(\.[^/]*)?$/,
  /(^|\/)\.(pgpass|netrc|git-credentials|npmrc|pypirc|my\.cnf|vault-token|htpasswd)$/,
  /(^|\/)\.[a-z]*_history$/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.config\/gcloud(\/|$)/,
  /(^|\/)(secrets?|credentials?)(\.[^/]*)?$/i,
  /(^|\/)wp-config\.php$/,
  /^\/etc\/(shadow|gshadow|sudoers)(-|$)/,
  /^\/etc\/sudoers\.d(\/|$)/,
  /^\/etc\/ssh\/ssh_host_[^/]*_key$/,
  /^\/etc\/ssl\/private(\/|$)/,
  /^\/etc\/letsencrypt\/(live|archive|keys)(\/|$)/,
  /^\/run\/secrets(\/|$)/,
  /^\/proc\/[^/]+\/environ$/,
];

/** True se il percorso (assoluto o relativo) punta a un file da proteggere. */
function isSensitivePath(p) {
  const s = String(p || '').replace(/\/+$/, '');
  return !!s && SENSITIVE_PATHS.some((re) => re.test(s));
}

// esclusioni aggiunte a ogni grep ricorsivo: il contenuto dei segreti non deve
// finire nei risultati di una ricerca generica
const GREP_EXCLUDES = [
  '--exclude=.env', '--exclude=.env.*', '--exclude=*.pem', '--exclude=*.key',
  '--exclude=*.p12', '--exclude=*.pfx', '--exclude=id_rsa*', '--exclude=id_dsa*',
  '--exclude=id_ecdsa*', '--exclude=id_ed25519*', '--exclude=.pgpass', '--exclude=.netrc',
  '--exclude=.git-credentials', '--exclude=.htpasswd', '--exclude=wp-config.php',
  '--exclude=shadow', '--exclude=gshadow', '--exclude=*_history',
  '--exclude-dir=.ssh', '--exclude-dir=.gnupg', '--exclude-dir=.aws', '--exclude-dir=.kube',
  '--exclude-dir=.docker', '--exclude-dir=private', '--exclude-dir=secrets',
];

// ---- comandi consentiti ----------------------------------------------------------

const FOLLOW = [/^-[a-zA-Z]*[fF]/, /^--(follow|retry)/];
const VERSION_ONLY = { only: /^(-v|-V|--version|-version|version)$/, needArgs: true };
const positionals = (args) => args.filter((a) => !a.startsWith('-'));
const hasFlag = (args, re) => args.some((a) => re.test(a));

/**
 * Regole per comando. Campi:
 *  - reads: legge il contenuto dei file passati (si risolvono i link simbolici)
 *  - grep: grep ricorsivo => si aggiungono le esclusioni dei segreti
 *  - deny: argomenti vietati (regex)
 *  - only: ogni argomento deve rispettare la regex
 *  - sub: sottocomandi ammessi (primo argomento posizionale)
 *  - denyWords: parole vietate in qualunque posizione
 *  - check(args): validazione su misura, restituisce un errore o null
 *  - fix(args): argomenti aggiunti/sistemati prima dell'esecuzione
 *  - sensitive(args): true se l'output può contenere segreti (serve conferma)
 */
const COMMANDS = {
  // file e testo
  ls: {}, stat: {}, file: {}, du: {}, df: {}, tree: {}, readlink: {}, realpath: {},
  cat: { reads: true }, head: { reads: true }, wc: { reads: true },
  tail: { reads: true, deny: FOLLOW },
  zcat: { reads: true },
  md5sum: { reads: true }, sha1sum: { reads: true }, sha256sum: { reads: true },
  grep: { reads: true, grep: true }, egrep: { reads: true, grep: true },
  fgrep: { reads: true, grep: true }, zgrep: { reads: true },
  find: { deny: [/^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/] },
  tar: {
    check: (a) => (/^-?[tvzjJaf]*t[tvzjJaf]*$/.test(a[0] || '') || a.includes('--list')) &&
      !hasFlag(a, /^--(to-command|checkpoint-action|use-compress-program|extract|get|create|append|update|delete)/) &&
      !hasFlag(a, /^-I$/)
      ? null : 'only listing an archive (tar -t / --list) is allowed',
  },
  unzip: { check: (a) => (['-l', '-v', '-Z', '-Zl'].includes(a[0]) ? null : 'only unzip -l / -v / -Z is allowed') },

  // sistema
  uname: {}, uptime: {}, whoami: {}, id: {}, groups: {}, nproc: {}, lscpu: {}, lsblk: {},
  lsmem: {}, lsof: {}, free: {}, vmstat: {}, iostat: {}, mpstat: {}, ps: {}, pgrep: {},
  pstree: {}, w: {}, who: {}, last: {}, lastlog: {},
  getent: { denyWords: ['shadow', 'gshadow'] },
  hostname: { only: /^-[a-zA-Z]+$|^--(fqdn|short|domain|ip-address|all-ip-addresses|all-fqdns|long)$/ },
  date: {
    deny: [/^-s/, /^--set/],
    check: (a) => (positionals(a).every((p) => p.startsWith('+')) ? null : 'setting the date is not allowed'),
  },
  dmesg: { deny: [/^-[a-zA-Z]*[cCDEn]/, /^--(clear|read-clear|console-off|console-on|console-level)/] },

  // rete
  ss: { deny: [/^-[a-zA-Z]*K/, /^--kill/] }, netstat: {}, dig: {}, nslookup: {}, host: {},
  ip: { denyWords: ['add', 'del', 'delete', 'set', 'flush', 'change', 'replace', 'append', 'prepend', 'exec', 'save', 'restore', 'monitor'] },

  // servizi e log
  systemctl: {
    deny: [/^-(H|M)$/, /^--(host|machine)/],
    sub: ['status', 'list-units', 'list-unit-files', 'list-timers', 'list-sockets',
      'list-dependencies', 'is-active', 'is-enabled', 'is-failed', 'show', 'cat'],
    fix: (a) => (a.includes('--no-pager') ? a : ['--no-pager', ...a]),
  },
  journalctl: {
    deny: [/^-[a-zA-Z]*f/, /^--(follow|vacuum|rotate|flush|sync|relinquish|smart-relinquish|setup-keys|update-catalog)/],
    fix: (a) => {
      const out = a.includes('--no-pager') ? [...a] : ['--no-pager', ...a];
      // senza limiti journalctl parte dalle righe più vecchie: si prendono le ultime
      if (!hasFlag(a, /^(-n|--lines|--since|--until|-S|-U|-r|--reverse|-b|--boot)/)) out.push('-n', DEFAULT_TAIL);
      return out;
    },
  },
  crontab: { check: (a) => (a.includes('-l') && a.every((x, i) => x === '-l' || x === '-u' || a[i - 1] === '-u') ? null : 'only crontab -l [-u user] is allowed') },

  // pacchetti
  'dpkg-query': {},
  dpkg: { check: (a) => (/^(-l|--list|-L|--listfiles|-s|--status|-S|--search|-p|--print-avail|--get-selections|--print-architecture)$/.test(a[0] || '') ? null : 'only dpkg query options are allowed') },
  apt: { sub: ['list', 'show', 'policy', 'search'] },
  'apt-cache': { sub: ['policy', 'show', 'search', 'depends', 'rdepends', 'madison', 'showpkg', 'stats'] },
  rpm: { check: (a) => (/^-q/.test(a[0] || '') ? null : 'only rpm -q... is allowed') },
  dnf: { sub: ['list', 'info', 'repolist', 'search'] },
  yum: { sub: ['list', 'info', 'repolist', 'search'] },

  // web server e runtime: solo test di configurazione / versione
  nginx: { only: /^-(t|T|v|V)$/, needArgs: true },
  apachectl: { only: /^-(S|t|M|v|V)$/, needArgs: true },
  apache2ctl: { only: /^-(S|t|M|v|V)$/, needArgs: true },
  openssl: { sub: ['x509', 'version', 'verify'], deny: [/^-(out|keyout)$/], reads: true },
  node: VERSION_ONLY, python: VERSION_ONLY, python3: VERSION_ONLY, php: VERSION_ONLY,
  java: VERSION_ONLY, ruby: VERSION_ONLY, perl: VERSION_ONLY, go: VERSION_ONLY,
  psql: VERSION_ONLY, mysql: VERSION_ONLY, 'redis-server': VERSION_ONLY,

  // docker (validazione dedicata, vedi checkDocker)
  docker: { docker: true },
};

const DOCKER_SUB = {
  ps: true, images: true, logs: true, inspect: true, stats: true, top: true, version: true,
  info: true, port: true, diff: true, history: true,
  network: ['ls', 'inspect'],
  volume: ['ls', 'inspect'],
  image: ['ls', 'inspect', 'history'],
  container: ['ls', 'inspect', 'logs', 'top', 'port', 'diff', 'stats'],
  system: ['df', 'info'],
  compose: ['ps', 'ls', 'logs', 'config', 'images', 'top', 'version'],
};
// opzioni di `docker compose` che prendono un valore separato
const COMPOSE_VALUE_OPTS = ['-f', '--file', '-p', '--project-name', '--project-directory', '--env-file', '--profile'];

/**
 * Valida un comando docker e restituisce { error } oppure { args, sensitive }.
 * `inspect` e `compose config` mostrano le variabili d'ambiente (spesso password).
 */
function checkDocker(args) {
  const sub = args[0];
  const rule = DOCKER_SUB[sub];
  if (!rule) return { error: `docker ${sub || ''}: subcommand not allowed` };
  let action = sub;
  let rest = args.slice(1);
  if (Array.isArray(rule)) {
    let i = 0;
    if (sub === 'compose') {
      while (i < rest.length && rest[i].startsWith('-')) i += COMPOSE_VALUE_OPTS.includes(rest[i]) ? 2 : 1;
    }
    action = rest[i];
    if (!rule.includes(action)) return { error: `docker ${sub} ${action || ''}: subcommand not allowed` };
    rest = rest.slice(i + 1);
  }
  let out = [...args];
  if (action === 'logs') {
    if (hasFlag(rest, /^(-f|--follow)$/)) return { error: 'following logs is not allowed' };
    if (!hasFlag(rest, /^(-n|--tail)/)) out.push('--tail', DEFAULT_TAIL);
  }
  if (action === 'stats' && !rest.includes('--no-stream')) out.push('--no-stream');
  return { args: out, sensitive: action === 'inspect' || action === 'config' };
}

/**
 * Controlla un comando richiesto dal modello.
 * @returns {{error:string}|{args:string[], reads:boolean, sensitive:boolean, docker:boolean}}
 */
function validateCommand(command, args) {
  const rule = Object.prototype.hasOwnProperty.call(COMMANDS, command) ? COMMANDS[command] : null;
  if (!rule) return { error: `command "${command}" is not in the allowed list` };
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) return { error: 'args must be an array of strings' };
  if (args.length > 64 || args.some((a) => a.length > 1000 || a.includes('\0'))) return { error: 'arguments too long' };

  if (rule.docker) {
    const d = checkDocker(args);
    return d.error ? d : { args: d.args, reads: false, sensitive: d.sensitive, docker: true };
  }
  if (rule.needArgs && !args.length) return { error: `${command} needs arguments` };
  if (rule.only && args.some((a) => !rule.only.test(a))) return { error: `${command}: only ${rule.only} arguments are allowed` };
  if (rule.deny) {
    const bad = args.find((a) => rule.deny.some((re) => re.test(a)));
    if (bad) return { error: `${command}: argument "${bad}" is not allowed` };
  }
  if (rule.denyWords) {
    const bad = args.find((a) => rule.denyWords.includes(a));
    if (bad) return { error: `${command}: "${bad}" is not allowed` };
  }
  if (rule.sub && !rule.sub.includes(positionals(args)[0])) {
    return { error: `${command}: allowed subcommands are ${rule.sub.join(', ')}` };
  }
  if (rule.check) {
    const err = rule.check(args);
    if (err) return { error: `${command}: ${err}` };
  }
  let out = rule.fix ? rule.fix(args) : [...args];
  if (rule.grep && hasFlag(args, /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)$/)) {
    out = [...GREP_EXCLUDES, ...out];
  }
  return { args: out, reads: !!rule.reads, sensitive: false, docker: false };
}

// ---- strumenti MCP --------------------------------------------------------------

function textResult(text, isError = false) {
  let t = String(text);
  if (t.length > MAX_OUTPUT) t = t.slice(0, MAX_OUTPUT) + '\n[... output truncated]';
  return { content: [{ type: 'text', text: t || '(no output)' }], isError };
}

function formatExec(r) {
  let text = r.stdout;
  if (r.stderr) text += (text ? '\n' : '') + '[stderr]\n' + r.stderr;
  if (r.truncated) text += '\n[... output truncated]';
  if (r.timedOut) text += `\n[command stopped after ${CMD_TIMEOUT / 1000}s]`;
  if (r.code) text += `\n[exit code ${r.code}]`;
  return text;
}

/**
 * Costruisce gli strumenti per una sessione SSH.
 * @param {object} o
 * @param {Function} o.tool  helper `tool` dell'Agent SDK
 * @param {object}   o.z     zod
 * @param {object}   o.ssh   SshManager
 * @param {string}   o.sshId id della sessione della scheda
 * @param {(req:{kind:string, key:string, path?:string, command?:string}) => Promise<boolean>} o.confirm
 */
function buildTools({ tool, z, ssh, sshId, confirm }) {
  const exec = (cmd, sudo = false) => ssh.execCapture(sshId, cmd, { timeoutMs: CMD_TIMEOUT, maxBytes: MAX_OUTPUT, sudo });

  /** Percorsi resi assoluti e con i link simbolici risolti (rispetto a `cwd`, o alla home). */
  async function resolvePaths(paths, cwd) {
    if (!paths.length) return [];
    const cd = cwd ? `cd ${q(cwd)} 2>/dev/null; ` : '';
    const r = await exec(`${cd}for p in ${paths.map(q).join(' ')}; do readlink -m -- "$p"; done`);
    return r.stdout.split('\n').filter(Boolean);
  }

  /** Chiede conferma se uno dei percorsi è sensibile. Restituisce un errore o null. */
  async function guardPaths(paths, cwd, command) {
    const candidates = paths.flatMap((a) => (a.includes('=') ? [a, a.slice(a.indexOf('=') + 1)] : [a]));
    const resolved = await resolvePaths(candidates.filter((a) => !a.startsWith('-')), cwd);
    const hit = [...candidates, ...resolved].find(isSensitivePath);
    if (!hit) return null;
    const shown = resolved.find(isSensitivePath) || hit;
    const ok = await confirm({ kind: 'sensitive_path', key: 'path:' + shown, path: shown, command });
    return ok ? null : `Access to the sensitive path "${shown}" was denied by the user. Do not try to read it another way.`;
  }

  async function guardSudo(command) {
    const ok = await confirm({ kind: 'sudo', key: 'sudo', command });
    return ok ? null : 'The user denied running this with sudo.';
  }

  const listDirectory = tool(
    'list_directory',
    'List the entries of a directory on the remote server (like ls -la). Relative paths are resolved from the home directory.',
    { path: z.string().describe('Directory path') },
    async ({ path }) => {
      try {
        const res = await ssh.listDir(sshId, path);
        const rows = res.entries.filter((e) => e.name !== '.' && e.name !== '..');
        const shown = rows.slice(0, 500).map((e) => e.longname || e.name);
        const more = rows.length > shown.length ? `\n[... ${rows.length - shown.length} more entries]` : '';
        return textResult(`Directory: ${res.cwd} (${rows.length} entries)\n${shown.join('\n')}${more}`);
      } catch (e) {
        return textResult(`Error: ${e.message}`, true);
      }
    },
  );

  const readFile = tool(
    'read_file',
    'Read a text file on the remote server. Returns numbered lines; use offset/limit to page through large files. ' +
      'Set sudo only if a normal read fails with "Permission denied" (the user must approve it).',
    {
      path: z.string().describe('File path'),
      offset: z.number().int().min(1).optional().describe('First line to read (1-based, default 1)'),
      limit: z.number().int().min(1).max(2000).optional().describe('Number of lines (default 500)'),
      sudo: z.boolean().optional(),
    },
    async ({ path, offset = 1, limit = 500, sudo = false }) => {
      try {
        const denied = await guardPaths([path], null, `read ${path}`);
        if (denied) return textResult(denied, true);
        if (sudo) {
          const no = await guardSudo(`read ${path}`);
          if (no) return textResult(no, true);
        }
        const cmd = `wc -l < ${q(path)} && echo '--RG--' && tail -n +${offset} -- ${q(path)} | head -n ${limit}`;
        const r = await exec(cmd, sudo);
        const sep = r.stdout.indexOf('--RG--\n');
        if (r.code && sep < 0) return textResult(`Error: ${r.stderr || 'cannot read file'}`, true);
        const total = parseInt(r.stdout, 10) || 0;
        const body = sep >= 0 ? r.stdout.slice(sep + 7) : '';
        if (body.includes('\0')) return textResult('This is a binary file; its content is not shown.', true);
        const lines = body.replace(/\n$/, '').split('\n');
        const numbered = body ? lines.map((l, i) => `${offset + i}\t${l}`).join('\n') : '';
        const end = body ? offset + lines.length - 1 : offset - 1;
        return textResult(`[${path}: lines ${offset}-${end} of ${total}${r.truncated ? ', truncated' : ''}]\n${numbered}`);
      } catch (e) {
        return textResult(`Error: ${e.message}`, true);
      }
    },
  );

  const searchFiles = tool(
    'search_files',
    'Find files or directories by name (case-insensitive glob, e.g. "*.log" or "nginx*") under a directory on the remote server.',
    {
      path: z.string().describe('Directory to search in'),
      name: z.string().describe('Name glob pattern'),
      type: z.enum(['file', 'directory', 'any']).optional(),
      max_depth: z.number().int().min(1).max(20).optional().describe('Default 6'),
    },
    async ({ path, name, type = 'any', max_depth = 6 }) => {
      try {
        const t = type === 'file' ? ' -type f' : type === 'directory' ? ' -type d' : '';
        const cmd = `find ${q(path)} -maxdepth ${max_depth} \\( -path /proc -o -path /sys \\) -prune -o${t} -iname ${q(name)} -print 2>/dev/null | head -n 500`;
        const r = await exec(cmd);
        return textResult(r.stdout.trim() ? r.stdout : 'No matches.');
      } catch (e) {
        return textResult(`Error: ${e.message}`, true);
      }
    },
  );

  const grepTool = tool(
    'grep',
    'Search file contents recursively for a regular expression (extended regex) on the remote server. ' +
      'Returns "file:line:text" matches. Binary files and secret files are skipped.',
    {
      path: z.string().describe('File or directory to search'),
      pattern: z.string().describe('Extended regular expression'),
      ignore_case: z.boolean().optional(),
      include: z.string().optional().describe('Only files matching this glob, e.g. "*.conf"'),
      max_results: z.number().int().min(1).max(1000).optional().describe('Default 200'),
    },
    async ({ path, pattern, ignore_case = false, include, max_results = 200 }) => {
      try {
        const denied = await guardPaths([path], null, `grep ${pattern} ${path}`);
        if (denied) return textResult(denied, true);
        const opts = ['-rIn', '--color=never', '-E', '-m', '50'];
        if (ignore_case) opts.push('-i');
        if (include) opts.push(`--include=${include}`);
        const cmd = `grep ${[...opts, ...GREP_EXCLUDES].map(q).join(' ')} -- ${q(pattern)} ${q(path)} 2>/dev/null | head -n ${max_results}`;
        const r = await exec(cmd);
        return textResult(r.stdout.trim() ? r.stdout : 'No matches.');
      } catch (e) {
        return textResult(`Error: ${e.message}`, true);
      }
    },
  );

  const runCommand = tool(
    'run_command',
    'Run a read-only diagnostic command on the remote server. Only these commands are allowed: ' +
      Object.keys(COMMANDS).join(', ') + '. ' +
      'Pass the arguments as a list: they are NOT interpreted by a shell, so pipes, redirections, ' +
      'globs, variables and command chaining do not work. Subcommands that modify the system are rejected ' +
      '(e.g. only status/list/show for systemctl; ps/logs/inspect/stats/... for docker). ' +
      'Set sudo only when the command fails for lack of permissions (the user must approve it).',
    {
      command: z.string().describe('Command name, e.g. "df"'),
      args: z.array(z.string()).optional().describe('Arguments, e.g. ["-h"]'),
      cwd: z.string().optional().describe('Working directory (default: home)'),
      sudo: z.boolean().optional(),
    },
    async ({ command, args = [], cwd, sudo = false }) => {
      try {
        const v = validateCommand(command, args);
        if (v.error) return textResult(`Rejected: ${v.error}`, true);
        const display = [command, ...args].join(' ');
        if (v.reads) {
          const denied = await guardPaths(args, cwd, display);
          if (denied) return textResult(denied, true);
        }
        if (v.sensitive) {
          const ok = await confirm({ kind: 'sensitive_command', key: 'cmd:' + command + ' ' + args.slice(0, 2).join(' '), command: display });
          if (!ok) return textResult('The user denied this command because its output may contain secrets.', true);
        }
        if (sudo) {
          const no = await guardSudo(display);
          if (no) return textResult(no, true);
        }
        const line = [command, ...v.args].map(q).join(' ');
        const full = (cwd ? `cd ${q(cwd)} && ` : '') + line;
        let r = await exec(full, sudo);
        // docker spesso richiede sudo: stesso ripiego del resto dell'app
        if (v.docker && !sudo && r.code && /permission denied/i.test(r.stderr)) r = await exec(full, true);
        return textResult(formatExec(r), !!r.code && !r.stdout);
      } catch (e) {
        return textResult(`Error: ${e.message}`, true);
      }
    },
  );

  return [listDirectory, readFile, searchFiles, grepTool, runCommand];
}

const TOOL_NAMES = ['list_directory', 'read_file', 'search_files', 'grep', 'run_command'];

module.exports = { buildTools, validateCommand, isSensitivePath, TOOL_NAMES, COMMANDS };

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { filterSecrets, isInsidePath } = require('./runner');
const ptyTap = require('./pty-tap.cjs');

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 28;
let ptyModule = null;
let ptyLoadError = null;

function loadPtyModule() {
  if (ptyModule) return ptyModule;
  if (ptyLoadError) throw ptyLoadError;
  try {
    ptyModule = require('@homebridge/node-pty-prebuilt-multiarch');
    return ptyModule;
  } catch (err) {
    ptyLoadError = err;
    throw err;
  }
}

function ptyAvailability() {
  try {
    loadPtyModule();
    return { available: true };
  } catch (err) {
    return {
      available: false,
      reason: `Integrated terminal is unavailable on this ${process.platform}/${process.arch} build: ${err.message || err}`,
    };
  }
}

function pathExts() {
  if (process.platform !== 'win32') return [''];
  return (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function expandWindowsEnv(value) {
  if (process.platform !== 'win32') return value;
  return String(value || '').replace(/%([^%]+)%/g, (match, name) => process.env[name] || match);
}

function readRegistryPath(root, valueName = 'Path') {
  if (process.platform !== 'win32') return '';
  try {
    const output = childProcess.execFileSync('reg.exe', ['query', root, '/v', valueName], {
      encoding: 'utf-8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    const line = output.split(/\r?\n/).find(item => new RegExp(`\\s${valueName}\\s+REG_`, 'i').test(item));
    return line?.replace(new RegExp(`^\\s*${valueName}\\s+REG_\\w+\\s+`, 'i'), '').trim() || '';
  } catch {
    return '';
  }
}

function commonWindowsPathDirs() {
  if (process.platform !== 'win32') return [];
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  return [
    path.join(appData, 'npm'),
    path.join(localAppData, 'Microsoft', 'WindowsApps'),
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
    path.join(localAppData, 'Volta', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'scoop', 'shims'),
    path.join(programFiles, 'nodejs'),
  ];
}

function pathDirs() {
  const values = [process.env.PATH || process.env.Path || ''];
  if (process.platform === 'win32') {
    values.push(
      readRegistryPath('HKCU\\Environment', 'Path'),
      readRegistryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path'),
      commonWindowsPathDirs().join(path.delimiter),
    );
  }
  const seen = new Set();
  return values
    .flatMap(value => expandWindowsEnv(value).split(path.delimiter))
    .map(item => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .filter(item => {
      const key = process.platform === 'win32' ? item.toLowerCase() : item;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function findOnPath(name) {
  if (!name) return null;
  if (path.isAbsolute(name) && fs.existsSync(name)) return name;
  const exts = path.extname(name) ? [''] : pathExts();
  for (const dir of pathDirs()) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function mergedPathValue(extraDirs = []) {
  const dirs = [...extraDirs, ...pathDirs()];
  const seen = new Set();
  return dirs
    .filter(Boolean)
    .filter(item => {
      const key = process.platform === 'win32' ? item.toLowerCase() : item;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(path.delimiter);
}

function existing(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function gitBashPath() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return existing([
    path.join(pf, 'Git', 'bin', 'bash.exe'),
    path.join(pf, 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(pf86, 'Git', 'bin', 'bash.exe'),
    findOnPath('bash.exe'),
  ]);
}

function decodeWindowsCommandOutput(buffer) {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''));
  const utf8 = raw.toString('utf8').replace(/\0/g, '');
  if (utf8.trim()) return utf8;
  return raw.toString('utf16le').replace(/\0/g, '');
}

function usableWslPath() {
  if (process.platform !== 'win32') return null;
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const command = existing([
    path.join(systemRoot, 'System32', 'wsl.exe'),
    findOnPath('wsl.exe'),
  ]);
  if (!command) return null;
  try {
    const output = childProcess.execFileSync(command, ['-l', '-q'], {
      encoding: 'buffer',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    const distros = decodeWindowsCommandOutput(output)
      .split(/\r?\n/)
      .map(item => item.trim())
      .filter(Boolean)
      .filter(item => !/^docker-desktop(?:-data)?$/i.test(item));
    return distros.length ? command : null;
  } catch {
    return null;
  }
}

function windowsPackageLocalCacheCandidates(packagePrefix, relativeParts) {
  if (process.platform !== 'win32') return [];
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const packagesDir = path.join(localAppData, 'Packages');
  try {
    return fs.readdirSync(packagesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith(packagePrefix))
      .map(entry => path.join(packagesDir, entry.name, 'LocalCache', ...relativeParts));
  } catch {
    return [];
  }
}

function windowsNodeVersionCommandCandidates(commandName) {
  if (process.platform !== 'win32') return [];
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const candidates = [];

  const nvmDirs = [
    process.env.NVM_HOME,
    path.join(appData, 'nvm'),
    path.join(home, 'AppData', 'Roaming', 'nvm'),
  ].filter(Boolean);
  for (const nvmDir of nvmDirs) {
    try {
      for (const entry of fs.readdirSync(nvmDir, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(path.join(nvmDir, entry.name, `${commandName}.cmd`));
      }
    } catch {}
  }

  const fnmRoots = [
    path.join(appData, 'fnm', 'node-versions'),
    path.join(localAppData, 'fnm', 'node-versions'),
    path.join(home, '.fnm', 'node-versions'),
  ];
  for (const root of fnmRoots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        candidates.push(
          path.join(root, entry.name, 'installation', `${commandName}.cmd`),
          path.join(root, entry.name, 'installation', 'bin', `${commandName}.cmd`),
        );
      }
    } catch {}
  }

  return candidates;
}

// The flag each AI CLI uses to skip ALL of its approval/permission prompts ("bypass mode" / YOLO). Used by the
// `*-bypass` profile variants. Bypass mode trades safety prompts for an uninterrupted run — the agent edits
// files and runs commands without asking — so each is a SEPARATE, clearly-labelled profile, never the default.
const AI_CLI_BYPASS_ARGS = {
  claude: ['--dangerously-skip-permissions'],
  codex: ['--dangerously-bypass-approvals-and-sandbox'],
  gemini: ['--yolo'],
};

const AI_CLI_PROFILES = [
  {
    id: 'ai-claude',
    label: 'Claude Code',
    commandName: 'claude',
    description: 'Launch the Claude Code TUI in this workspace.',
    installHint: 'Install Claude Code and ensure `claude` is on PATH.',
  },
  {
    id: 'ai-claude-bypass',
    label: 'Claude Code (bypass)',
    commandName: 'claude',
    bypass: true,
    description: 'Claude Code with every permission prompt skipped (--dangerously-skip-permissions). It edits files and runs commands without asking.',
    installHint: 'Install Claude Code and ensure `claude` is on PATH.',
  },
  {
    id: 'ai-codex',
    label: 'Codex CLI',
    commandName: 'codex',
    description: 'Launch the OpenAI Codex CLI TUI in this workspace.',
    installHint: 'Install Codex CLI and ensure `codex` is on PATH.',
  },
  {
    id: 'ai-codex-bypass',
    label: 'Codex CLI (bypass)',
    commandName: 'codex',
    bypass: true,
    description: 'Codex CLI bypassing approvals + the sandbox (--dangerously-bypass-approvals-and-sandbox). Full auto, no prompts.',
    installHint: 'Install Codex CLI and ensure `codex` is on PATH.',
  },
  {
    id: 'ai-gemini',
    label: 'Gemini CLI',
    commandName: 'gemini',
    description: 'Launch the Gemini CLI TUI in this workspace.',
    installHint: 'Install Gemini CLI and ensure `gemini` is on PATH.',
  },
  {
    id: 'ai-gemini-bypass',
    label: 'Gemini CLI (bypass)',
    commandName: 'gemini',
    bypass: true,
    description: 'Gemini CLI in YOLO mode, auto-approving all actions (--yolo).',
    installHint: 'Install Gemini CLI and ensure `gemini` is on PATH.',
  },
];

function aiCliCandidates(commandName) {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const candidates = [];

  if (process.platform === 'win32') {
    if (commandName === 'codex') {
      candidates.push(
        ...windowsPackageLocalCacheCandidates('OpenAI.Codex_', ['Local', 'OpenAI', 'Codex', 'bin', 'codex.exe']),
      );
    }
    if (commandName === 'claude') {
      candidates.push(
        path.join(home, '.claude', 'local', 'bin', 'claude.exe'),
        path.join(home, '.claude', 'bin', 'claude.exe'),
        path.join(home, '.local', 'bin', 'claude.exe'),
        path.join(localAppData, 'Programs', 'ClaudeCode', 'claude.exe'),
      );
    }
    candidates.push(
      findOnPath(commandName),
      path.join(home, '.local', 'bin', `${commandName}.exe`),
      path.join(appData, 'npm', `${commandName}.cmd`),
      path.join(localAppData, 'Microsoft', 'WinGet', 'Links', `${commandName}.exe`),
      path.join(localAppData, 'Volta', 'bin', `${commandName}.exe`),
      path.join(home, 'scoop', 'shims', `${commandName}.exe`),
      ...windowsNodeVersionCommandCandidates(commandName),
    );
    if (commandName === 'gemini') {
      candidates.push(
        path.join(localAppData, 'Programs', 'Gemini CLI', 'gemini.exe'),
        path.join(localAppData, 'Programs', 'Gemini', 'gemini.exe'),
        path.join(localAppData, 'Google', 'Gemini CLI', 'gemini.exe'),
      );
    }
    return candidates;
  }

  if (commandName === 'claude') {
    candidates.push(
      path.join(home, '.claude', 'local', 'bin', 'claude'),
      path.join(home, '.claude', 'bin', 'claude'),
    );
  }
  candidates.push(
    findOnPath(commandName),
    path.join(home, '.local', 'bin', commandName),
    `/usr/local/bin/${commandName}`,
    `/opt/homebrew/bin/${commandName}`,
    `/snap/bin/${commandName}`,
  );
  return candidates;
}

function detectAiCliProfiles() {
  return AI_CLI_PROFILES.map(profile => {
    // Bypass-mode profiles carry the CLI's skip-all-prompts flag; normal profiles run with no extra args.
    const bypassArgs = profile.bypass ? (AI_CLI_BYPASS_ARGS[profile.commandName] || []) : [];
    const command = existing(aiCliCandidates(profile.commandName));
    const fallback = command ? null : (aiCliNpmExecFallback(profile, bypassArgs) || aiCliShellFallback(profile, bypassArgs));
    return {
      ...profile,
      kind: 'ai-cli',
      family: 'ai-cli',
      bypass: !!profile.bypass,
      command: command || fallback?.command || null,
      // Direct launch: just the bypass flag (if any). Fallback launch (npm/powershell wrapper): the wrapper
      // already embeds the bypass flag around the gemini invocation, so use its args verbatim.
      args: fallback ? (fallback.args || []) : [...bypassArgs],
      available: Boolean(command || fallback),
      description: fallback?.description || profile.description,
    };
  });
}

function aiCliNpmExecFallback(profile, bypassArgs = []) {
  if (process.platform !== 'win32' || profile.commandName !== 'gemini') return null;
  const npm = findOnPath('npm.cmd') || findOnPath('npm');
  if (!npm) return null;
  return {
    command: npm,
    args: ['exec', '--package', '@google/gemini-cli', '--', 'gemini', ...bypassArgs],
    description: 'Launch Gemini CLI via npm exec when the gemini shim is not directly visible to Electron.',
  };
}

function aiCliShellFallback(profile, bypassArgs = []) {
  if (process.platform !== 'win32' || profile.commandName !== 'gemini') return null;
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = existing([
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    findOnPath('powershell.exe'),
  ]);
  if (!powershell) return null;
  return {
    command: powershell,
    // Bypass flag must live INSIDE the -Command string so it's passed to gemini, not to powershell.
    args: ['-NoLogo', '-NoExit', '-Command', [profile.commandName, ...bypassArgs].join(' ')],
    description: 'Launch Gemini CLI through PowerShell so user PATH/profile aliases can resolve it.',
  };
}

function detectShells() {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    return [
      {
        id: 'powershell',
        label: 'Windows PowerShell',
        family: 'powershell',
        command: existing([
          path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          findOnPath('powershell.exe'),
        ]),
      },
      {
        id: 'cmd',
        label: 'Command Prompt',
        family: 'cmd',
        command: existing([
          process.env.ComSpec,
          path.join(systemRoot, 'System32', 'cmd.exe'),
          findOnPath('cmd.exe'),
        ]),
      },
      {
        id: 'git-bash',
        label: 'Git Bash',
        family: 'bash',
        command: gitBashPath(),
      },
      {
        id: 'wsl',
        label: 'WSL',
        family: 'wsl',
        command: usableWslPath(),
      },
    ].filter(item => item.command);
  }

  if (process.platform === 'darwin') {
    return [
      { id: 'zsh', label: 'zsh', family: 'zsh', command: findOnPath('zsh') || '/bin/zsh' },
      { id: 'bash', label: 'bash', family: 'bash', command: findOnPath('bash') || '/bin/bash' },
      { id: 'fish', label: 'fish', family: 'fish', command: findOnPath('fish') },
    ].filter(item => item.command && fs.existsSync(item.command));
  }

  return [
    { id: 'bash', label: 'bash', family: 'bash', command: findOnPath('bash') || '/bin/bash' },
    { id: 'zsh', label: 'zsh', family: 'zsh', command: findOnPath('zsh') },
    { id: 'fish', label: 'fish', family: 'fish', command: findOnPath('fish') },
  ].filter(item => item.command && fs.existsSync(item.command));
}

function detectTerminalProfiles() {
  return [
    ...detectShells().map(item => ({
      ...item,
      kind: 'shell',
      available: true,
      description: `${item.family || 'terminal'} shell`,
    })),
    ...detectAiCliProfiles(),
  ];
}

function shellIntegrationDir() {
  const bundledDir = path.resolve(__dirname, '..', '..', 'renderer', 'terminal', 'shell-integration');
  if (bundledDir.includes(`${path.sep}app.asar${path.sep}`)) {
    const unpackedDir = bundledDir.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    if (fs.existsSync(unpackedDir)) return unpackedDir;
  }
  return bundledDir;
}

function normalizeCwd(input, workspaceRoot, allowOutsideWorkspace) {
  const cwd = path.resolve(input || os.homedir());
  if (!workspaceRoot) {
    if (allowOutsideWorkspace) return cwd;
    throw new Error('Terminal requires a workspace root, or explicit one-time outside-workspace approval.');
  }
  if (!isInsidePath(cwd, workspaceRoot)) {
    if (allowOutsideWorkspace) return cwd;
    throw new Error('Terminal working directory is outside the workspace. Confirm one-time outside-workspace execution first.');
  }
  return cwd;
}

function shellByRequest(requested) {
  const profiles = detectTerminalProfiles();
  if (requested) {
    const lower = String(requested).toLowerCase();
    const byId = profiles.find(item => item.id === lower || item.label.toLowerCase() === lower);
    if (byId) {
      if (!byId.command || byId.available === false) {
        throw new Error(`${byId.label} is not installed. ${byId.installHint || 'Install it and ensure the command is on PATH.'}`);
      }
      return byId;
    }
    const explicit = path.resolve(String(requested));
    if (fs.existsSync(explicit)) {
      const base = path.basename(explicit).toLowerCase();
      const family = base.includes('powershell') || base === 'pwsh.exe'
        ? 'powershell'
        : (base.includes('bash') ? 'bash' : (base.includes('zsh') ? 'zsh' : 'custom'));
      return { id: 'custom', label: path.basename(explicit), family, command: explicit };
    }
  }
  const shells = profiles.filter(item => item.kind === 'shell' && item.command && item.available !== false);
  if (!shells.length) throw new Error('No supported shell was found on this system.');
  return shells[0];
}

function writeZshRc(appDataPath) {
  const dir = path.join(appDataPath, 'terminal-zdotdir');
  fs.mkdirSync(dir, { recursive: true });
  const zshScript = path.join(shellIntegrationDir(), 'zsh.zsh');
  fs.writeFileSync(path.join(dir, '.zshrc'), `source ${JSON.stringify(zshScript)}\n`, 'utf-8');
  return dir;
}

function buildSpawnArgs(shell, env, appDataPath) {
  const scripts = shellIntegrationDir();
  if (shell.family === 'ai-cli') {
    // Bypass flags (if any) are already baked into shell.args by detectAiCliProfiles per the chosen profile
    // (the `*-bypass` variants), so the launch is just the command + those args — normal profiles get none.
    const args = Array.isArray(shell.args) ? shell.args.map(String) : [];
    // claude shows a first-run "Do you trust this folder?" prompt that is NOT skipped by any flag and BLOCKS the
    // session; flag claude (either variant) so spawnPty auto-accepts the default. (Also gates the observe pid.)
    const aiClaude = String(shell.commandName || '').toLowerCase() === 'claude';
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(shell.command || '')) {
      return {
        command: process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
        // node-pty/libuv quotes args for us; use call so .cmd/.bat shims work with paths containing spaces.
        args: ['/D', '/K', 'call', shell.command, ...args],
        env,
        aiClaude,
      };
    }
    return { args, env, aiClaude };
  }
  if (shell.family === 'powershell') {
    return {
      // Load the user's PowerShell profile so CLI aliases and PATH additions match external terminals.
      args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'powershell.ps1')],
      env,
    };
  }
  if (shell.family === 'bash') {
    return {
      args: ['--init-file', path.join(scripts, 'bash.sh'), '-i'],
      env,
    };
  }
  if (shell.family === 'zsh') {
    return {
      args: ['-i'],
      env: { ...env, ZDOTDIR: writeZshRc(appDataPath) },
    };
  }
  if (shell.family === 'cmd') {
    return { args: ['/K'], env };
  }
  return { args: [], env };
}

function createPtyManager({ app }) {
  const sessions = new Map();
  const listeners = new Map();
  const ownersWithDestroyHook = new Set();
  const restorePath = path.join(app.getPath('userData'), 'terminal-sessions.json');
  const appDataPath = app.getPath('userData');
  let shuttingDown = false;

  function emit(ownerId, payload) {
    const sender = listeners.get(ownerId);
    if (!sender || sender.isDestroyed()) return;
    sender.send('terminal.pty.event', payload);
  }

  async function readRestoreEntries() {
    try {
      const raw = await fs.promises.readFile(restorePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.sessions)
        ? parsed.sessions
            .filter(item => item && item.cwd)
            .map(item => ({ shell: item.shell || '', cwd: item.cwd }))
            .slice(0, 8)
        : [];
    } catch {
      return [];
    }
  }

  async function persistRestoreEntries() {
    const sessionsToSave = Array.from(sessions.values())
      .filter(item => item.restore === true)
      .map(item => ({ shell: item.shell.id, cwd: item.cwd }))
      .slice(0, 8);
    await fs.promises.mkdir(path.dirname(restorePath), { recursive: true });
    await fs.promises.writeFile(restorePath, JSON.stringify({
      version: 1,
      sessions: sessionsToSave,
    }, null, 2), 'utf-8');
  }

  function getOwnedSession(ownerWebContents, sessionId) {
    const session = sessions.get(String(sessionId || ''));
    if (!session) return null;
    if (!ownerWebContents || ownerWebContents.isDestroyed()) {
      throw new Error('Terminal window is not available.');
    }
    if (session.ownerId !== ownerWebContents.id) {
      throw new Error('PTY session is owned by another window.');
    }
    return session;
  }

  function killOwnerSessions(ownerId, options = {}) {
    for (const session of Array.from(sessions.values())) {
      if (session.ownerId === ownerId) killSession(session.id, options);
    }
    listeners.delete(ownerId);
    ownersWithDestroyHook.delete(ownerId);
  }

  function watchOwner(ownerWebContents) {
    const ownerId = ownerWebContents.id;
    if (ownersWithDestroyHook.has(ownerId)) return;
    ownersWithDestroyHook.add(ownerId);
    ownerWebContents.once('destroyed', () => {
      killOwnerSessions(ownerId);
    });
  }

  function spawnPty(ownerWebContents, input = {}) {
    if (!ownerWebContents || ownerWebContents.isDestroyed()) throw new Error('Terminal window is not available.');
    const availability = ptyAvailability();
    if (!availability.available) throw new Error(availability.reason);
    const ownerId = ownerWebContents.id;
    listeners.set(ownerId, ownerWebContents);
    watchOwner(ownerWebContents);

    const cwd = normalizeCwd(input.cwd, input.workspaceRoot, input.allowOutsideWorkspace === true);
    const shell = shellByRequest(input.shell || input.defaultShell);
    const envPath = mergedPathValue();
    const baseEnv = { ...process.env };
    for (const key of Object.keys(baseEnv)) {
      if (/^path$/i.test(key)) delete baseEnv[key];
    }
    const mergedEnv = {
      ...baseEnv,
      [process.platform === 'win32' ? 'Path' : 'PATH']: envPath,
      TERM_PROGRAM: 'OrPAD',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ORPAD_TERMINAL: '1',
      ...(input.env && typeof input.env === 'object' ? input.env : {}),
    };
    // AI provider auth vars must survive into the interactive terminal: claude/codex/gemini
    // authenticate via ANTHROPIC_API_KEY-style env, and stripping them makes a CLI that works
    // in every external terminal fail auth only inside OrPAD. The interactive pty is the user's
    // own shell on their own machine — masking here protects nothing the shell couldn't read
    // anyway. The governed Command Runner keeps full filtering (no allowlist).
    const { env, maskedCount } = filterSecrets(mergedEnv, {
      allowNames: /^(ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|CLAUDE_|CODEX_)/i,
    });
    const spawnSpec = buildSpawnArgs(shell, env, appDataPath);
    const cols = Math.max(20, Math.min(500, Number(input.cols) || DEFAULT_COLS));
    const rows = Math.max(5, Math.min(200, Number(input.rows) || DEFAULT_ROWS));
    const id = crypto.randomUUID();

    const proc = loadPtyModule().spawn(spawnSpec.command || shell.command, spawnSpec.args, {
      name: 'xterm-256color',
      cwd,
      env: spawnSpec.env,
      cols,
      rows,
    });

    const session = {
      id,
      ownerId,
      proc,
      shell,
      cwd,
      restore: input.restore !== false,
    };
    sessions.set(id, session);
    ptyTap.markAlive(id); // observers check this before attaching to a session

    // claude shows a first-run "Do you trust this folder?" prompt (NOT skipped by --dangerously-skip-permissions)
    // that BLOCKS the interactive session — so it never writes its session log and OrPAD can't observe it. Auto-
    // accept the DEFAULT option ("Yes, I trust this folder") by sending Enter once when the prompt is detected.
    // Robust: matches the rendered text with whitespace/ANSI stripped; never fires if the folder is already trusted.
    const autoTrust = !!spawnSpec.aiClaude;
    let trustBuf = '';
    let trustDone = !autoTrust;
    if (autoTrust) setTimeout(() => { trustDone = true; }, 30000); // give up watching after init settles

    proc.onData(chunk => {
      emit(ownerId, { type: 'data', sessionId: id, chunk });
      // Mirror the stream to the observe bus (no-op unless a live-TUI observer is tapping this session) so the
      // orchestration observer can reconstruct the rendered screen without disturbing the terminal.
      ptyTap.publishData(id, chunk);
      if (!trustDone) {
        trustBuf += chunk;
        if (trustBuf.length > 12000) trustBuf = trustBuf.slice(-6000);
        const flat = trustBuf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\s+/g, '').toLowerCase();
        if (flat.includes('trustthisfolder') || (flat.includes('doyoutrust') && flat.includes('entertoconfirm'))) {
          trustDone = true;
          try { proc.write('\r'); } catch (_) { /* best effort */ }
        }
      }
    });
    proc.onExit(event => {
      sessions.delete(id);
      ptyTap.publishExit(id); // let any live-TUI observer synthesize run/done and detach
      emit(ownerId, {
        type: 'exit',
        sessionId: id,
        exitCode: event.exitCode,
        signal: event.signal,
      });
      if (!shuttingDown) persistRestoreEntries().catch(() => {});
    });

    persistRestoreEntries().catch(() => {});
    return {
      sessionId: id,
      shell: {
        id: shell.id,
        label: shell.label,
        command: shell.command,
        family: shell.family,
        kind: shell.kind || 'shell',
        commandName: shell.commandName || '',
        description: shell.description || '',
      },
      cwd,
      cols,
      rows,
      maskedEnvCount: maskedCount,
      // claude: the spawned PID — OrPAD resolves the session's REAL id via ~/.claude/sessions/<pid>.json.
      aiPid: spawnSpec.aiClaude ? (proc.pid || null) : null,
    };
  }

  function write(ownerWebContents, sessionId, data) {
    const session = getOwnedSession(ownerWebContents, sessionId);
    if (!session) return false;
    session.proc.write(String(data || ''));
    return true;
  }

  function resize(ownerWebContents, sessionId, cols, rows) {
    const session = getOwnedSession(ownerWebContents, sessionId);
    if (!session) return false;
    const nextCols = Math.max(20, Math.min(500, Number(cols) || DEFAULT_COLS));
    const nextRows = Math.max(5, Math.min(200, Number(rows) || DEFAULT_ROWS));
    session.proc.resize(nextCols, nextRows);
    ptyTap.publishResize(session.id, nextCols, nextRows); // keep any live-TUI observer's grid in sync
    return true;
  }

  function killSession(sessionId, options = {}) {
    const session = sessions.get(String(sessionId || ''));
    if (!session) return false;
    try {
      if (options.preserveRestore !== true) session.restore = false;
      session.proc.kill();
    } catch {}
    sessions.delete(session.id);
    if (options.preserveRestore !== true && !shuttingDown) persistRestoreEntries().catch(() => {});
    return true;
  }

  function kill(ownerWebContents, sessionId, options = {}) {
    const session = getOwnedSession(ownerWebContents, sessionId);
    if (!session) return false;
    return killSession(session.id, options);
  }

  function killAll(options = {}) {
    for (const id of Array.from(sessions.keys())) killSession(id, options);
  }

  async function shutdown() {
    shuttingDown = true;
    await persistRestoreEntries().catch(() => {});
    killAll({ preserveRestore: true });
  }

  return {
    availability: ptyAvailability,
    detectShells,
    detectTerminalProfiles,
    spawnPty,
    write,
    resize,
    kill,
    killAll,
    shutdown,
    readRestoreEntries,
    persistRestoreEntries,
  };
}

module.exports = {
  createPtyManager,
  detectShells,
  detectTerminalProfiles,
  shellByRequest,
  ptyAvailability,
};

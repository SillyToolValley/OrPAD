const path = require('path');
const os = require('os');
const fsp = require('fs').promises;
const { BrowserWindow, dialog } = require('electron');
const {
  runCommand,
  cancel,
  cancelAll,
  activeRunCount,
  isInsidePath,
} = require('./runner');
const { createPtyManager } = require('./pty');

const MAX_HISTORY = 200;

function historyPath(app) {
  return path.join(app.getPath('userData'), 'runner-history.json');
}

async function readHistory(app) {
  try {
    const raw = await fsp.readFile(historyPath(app), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.commands) ? parsed.commands.filter(Boolean).slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

async function writeHistory(app, commands) {
  const filePath = historyPath(app);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify({
    version: 1,
    commands: commands.slice(0, MAX_HISTORY),
  }, null, 2), 'utf-8');
}

function redactHistoryCommand(commandLine) {
  return String(commandLine || '')
    .replace(/((?:--?|\/)[^\s=]*(?:key|token|secret|password)[^\s=]*=)([^\s]+)/gi, '$1<redacted>')
    .replace(/\b((?:[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|PASSWORD)=)([^\s]+)/gi, '$1<redacted>');
}

async function addHistory(app, commandLine) {
  const command = redactHistoryCommand(commandLine).trim();
  if (!command) return [];
  const existing = await readHistory(app);
  const next = [command, ...existing.filter(item => item !== command)].slice(0, MAX_HISTORY);
  await writeHistory(app, next);
  return next;
}

async function confirmOutsideWorkspace(event, cwd, workspaceRoot, label) {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const options = {
    type: 'warning',
    title: `${label} outside workspace`,
    message: `Allow ${label.toLowerCase()} to run outside the approved workspace?`,
    detail: `workspace: ${workspaceRoot || '(none)'}\ncwd: ${cwd}`,
    buttons: ['Cancel', 'Allow once'],
    cancelId: 0,
    defaultId: 1,
    noLink: true,
  };
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}

async function guardTerminalInput(event, input = {}, authority, label) {
  const workspaceRoot = authority?.getWorkspaceRoot(event.sender) || '';
  const cwd = path.resolve(String(input.cwd || workspaceRoot || os.homedir()));
  const insideWorkspace = workspaceRoot && isInsidePath(cwd, workspaceRoot);
  let allowOutsideWorkspace = false;

  if (!insideWorkspace) {
    allowOutsideWorkspace = await confirmOutsideWorkspace(event, cwd, workspaceRoot, label);
    if (!allowOutsideWorkspace) throw new Error(`${label} canceled.`);
  }

  return {
    ...input,
    cwd,
    workspaceRoot,
    allowOutsideWorkspace,
  };
}

function registerTerminalHandlers({ ipcMain, app, authority }) {
  const ptyManager = createPtyManager({ app });

  ipcMain.handle('terminal.history', async () => {
    return readHistory(app);
  });

  ipcMain.handle('terminal.run', async (event, input = {}) => {
    const runId = String(input.runId || '');
    const commandLine = String(input.commandLine || '').trim();
    const guardedInput = await guardTerminalInput(event, input, authority, 'Command Runner');
    const result = runCommand(runId, guardedInput, payload => {
      event.sender.send('terminal.event', payload);
    }, { ownerId: event.sender.id });
    if (commandLine) {
      addHistory(app, commandLine).catch(() => {});
    }
    return result;
  });

  ipcMain.handle('terminal.cancel', async (event, runId) => {
    return cancel(String(runId || ''), event.sender.id);
  });

  ipcMain.handle('terminal.status', async () => {
    return { activeRunCount: activeRunCount() };
  });

  ipcMain.handle('terminal.pty.shells', async () => {
    return ptyManager.detectTerminalProfiles().map(item => ({
      id: item.id,
      label: item.label,
      family: item.family,
      kind: item.kind || 'shell',
      command: item.command,
      commandName: item.commandName || '',
      description: item.description || '',
      installHint: item.installHint || '',
      available: item.available !== false && Boolean(item.command),
    }));
  });

  ipcMain.handle('terminal.pty.status', async () => {
    return ptyManager.availability();
  });

  ipcMain.handle('terminal.pty.restore', async () => {
    return ptyManager.readRestoreEntries();
  });

  ipcMain.handle('terminal.pty.spawn', async (event, input = {}) => {
    const guardedInput = await guardTerminalInput(event, input, authority, 'Terminal');
    return ptyManager.spawnPty(event.sender, guardedInput);
  });

  ipcMain.handle('terminal.pty.write', async (event, sessionId, data) => {
    return ptyManager.write(event.sender, sessionId, data);
  });

  ipcMain.handle('terminal.pty.resize', async (event, sessionId, cols, rows) => {
    return ptyManager.resize(event.sender, sessionId, cols, rows);
  });

  ipcMain.handle('terminal.pty.kill', async (event, sessionId) => {
    return ptyManager.kill(event.sender, sessionId);
  });

  // System clipboard for the terminal (copy/paste + a TUI's OSC 52 clipboard writes). Main-process clipboard
  // reaches the OS reliably from a sandboxed renderer.
  ipcMain.handle('clipboard.write-text', async (_event, text) => {
    try { require('electron').clipboard.writeText(String(text == null ? '' : text)); return true; }
    catch (_) { return false; }
  });
  ipcMain.handle('clipboard.read-text', async () => {
    try { return require('electron').clipboard.readText(); } catch (_) { return ''; }
  });
  // Whether the OS clipboard currently holds an image — an AI CLI paste (\x16) reads the clipboard itself,
  // so the renderer only needs the yes/no to decide between term.paste(text) and forwarding the Ctrl+V byte.
  ipcMain.handle('clipboard.has-image', async () => {
    try {
      const formats = require('electron').clipboard.availableFormats() || [];
      return formats.some(format => String(format).toLowerCase().startsWith('image/'));
    } catch (_) { return false; }
  });

  app.on('before-quit', () => {
    ptyManager.shutdown().catch(() => {});
    cancelAll();
  });
}

module.exports = {
  registerTerminalHandlers,
  readHistory,
  addHistory,
  redactHistoryCommand,
};

import * as http from 'http';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _electron as electron, ElectronApplication } from 'playwright';

async function removeDirWithRetries(dir: string, attempts = 8): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) {
        // Windows can keep Electron's userData directory locked for a short
        // time after process exit. Cleanup is best-effort so it doesn't mask
        // the actual test result.
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
    }
  }
}

function killProcessTree(pid?: number): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      childProcess.execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {}
}

export async function launchElectron(
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<ElectronApplication> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-e2e-'));
  const app = await electron.launch({
    args: ['.', ...extraArgs],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ORPAD_TEST_USER_DATA: userDataDir,
      ...extraEnv,
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('.cm-editor', { timeout: 10000 });
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand, null, { timeout: 10000 });
  const close = app.close.bind(app);
  app.close = async () => {
    const child = app.process();
    try {
      await Promise.race([
        close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out closing Electron test app.')), 5000)),
      ]);
    } catch {
      killProcessTree(child.pid);
    } finally {
      killProcessTree(child.pid);
      await removeDirWithRetries(userDataDir);
    }
  };
  return app;
}

export async function startStaticServer(
  rootDir: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.woff2': 'font/woff2',
    '.ico':  'image/x-icon',
  };

  const server = http.createServer((req, res) => {
    const urlPath = (req.url ?? '/').replace(/\?.*$/, '');
    const filePath = path.join(rootDir, urlPath === '/' ? 'index.html' : urlPath);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream' });
      res.end(data);
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      server.close(() => finish());
      server.closeAllConnections?.();
      setTimeout(finish, 1000).unref?.();
    }),
  };
}

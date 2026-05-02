// OrPAD browser platform adapter.
// Shims window.orpad so the Electron-shaped renderer runs unchanged in a browser.
//
// Workspace features (file tree / workspace search / wiki-link backlinks) work
// on Chromium-based browsers via the File System Access API. On browsers
// without FSA (Firefox / Safari), Open Folder surfaces a clear error rather
// than silently no-op'ing.

const FS_SUPPORTED =
  typeof window.showOpenFilePicker === 'function' &&
  typeof window.showSaveFilePicker === 'function';
const FSA_DIR_SUPPORTED = typeof window.showDirectoryPicker === 'function';

const SUPPORTED_EXTS = [
  'md','markdown','mkd','mdx','mmd',
  'json','jsonl','ndjson','yaml','yml',
  'html','htm','xml',
  'csv','tsv','toml','ini','conf','properties','env',
  'log','txt',
  'or-pipeline','or-graph','or-tree','or-rule','or-run',
];
const TRUSTED_URL_HOSTS = new Set([
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'cdn.jsdelivr.net',
]);
const MAX_URL_BYTES = 10 * 1024 * 1024;
const URL_FETCH_TIMEOUT_MS = 20_000;
const IGNORED_DIRS = new Set(['node_modules','.git','.svn','__pycache__','dist','build','.next','.cache','.idea','.vscode']);
const BINARY_EXTS = new Set([
  'exe','dll','so','dylib','bin','msi','app','class','jar',
  'zip','rar','7z','tar','gz','bz2','xz',
  'png','jpg','jpeg','gif','bmp','ico','webp','tiff',
  'mp4','avi','mov','wmv','mkv','webm','mp3','wav','ogg','flac','m4a',
  'pdf','doc','docx','xls','xlsx','ppt','pptx',
  'db','sqlite',
]);

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}
function isBinary(name) { return BINARY_EXTS.has(extOf(name)); }
function isMarkdown(name) { return /\.(md|markdown|mkd|mdx)$/i.test(name); }
function basenameNoExt(name) {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const b = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(0, dot) : b;
}
function dirOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i <= 0 ? '/' : p.slice(0, i);
}
function baseOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? p : p.slice(i + 1);
}
function safeDecode(value) {
  try { return decodeURIComponent(value || ''); }
  catch { return value || ''; }
}
function sanitizeFileName(name, fallback = 'shared.md') {
  const cleaned = (name || fallback)
    .split(/[\\/]/).pop()
    .replace(/[<>:"|?*\x00-\x1f]/g, '-')
    .trim();
  return cleaned || fallback;
}
function inferNameFromUrl(url, fallback = 'shared.md') {
  const pathName = safeDecode(url.pathname);
  const name = pathName.split('/').filter(Boolean).pop();
  return sanitizeFileName(name || fallback, fallback);
}
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}
function abortError(message) {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}
function isTrustedHost(hostname) {
  return TRUSTED_URL_HOSTS.has(String(hostname || '').toLowerCase());
}
function assertHttpsUrl(url) {
  if (url.protocol !== 'https:') throw new Error('HTTPS required for URL imports.');
  const decodedSearch = safeDecode(url.search);
  if (/(?:file:\/\/|data:)/i.test(decodedSearch)) {
    throw new Error('URL imports cannot contain file:// or data: query values.');
  }
}
function parseUrl(raw) {
  const url = new URL(String(raw || '').trim());
  assertHttpsUrl(url);
  return url;
}
function githubBlobToRaw(input) {
  let parts;
  try {
    const url = new URL(input);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    parts = url.pathname.split('/').filter(Boolean);
  } catch {
    parts = String(input || '').split('/').filter(Boolean);
  }
  const blobIndex = parts.indexOf('blob');
  if (blobIndex !== 2 || parts.length < 5) return null;
  const owner = parts[0];
  const repo = parts[1];
  const ref = parts[3];
  const filePath = parts.slice(4).join('/');
  return {
    url: new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`),
    name: sanitizeFileName(filePath.split('/').pop() || `${repo}.md`),
  };
}
function gistIdFromInput(input) {
  const raw = String(input || '').trim();
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== 'gist.github.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[1] : parts[0] || null;
  } catch {
    const parts = raw.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[1] : parts[0] || null;
  }
}

// Renderer treats filePath as an opaque string. Single-file opens use
// "web:<id>/<fileName>". Workspace entries use synthetic unix paths rooted
// at "/" so string ops in the renderer (split, substring on the last slash,
// etc.) work without modification.
const PATH_PREFIX = 'web:';
let handleCounter = 0;
const singleFileHandles = new Map(); // id -> FileSystemFileHandle

function registerSingleFileHandle(handle) {
  const id = String(++handleCounter);
  singleFileHandles.set(id, handle);
  return `${PATH_PREFIX}${id}/${handle.name}`;
}
function noHandlePath(fileName) {
  const id = `${++handleCounter}-nohandle`;
  return `${PATH_PREFIX}${id}/${fileName}`;
}
function singleFileHandleFromPath(filePath) {
  if (typeof filePath !== 'string' || !filePath.startsWith(PATH_PREFIX)) return null;
  const id = filePath.slice(PATH_PREFIX.length).split('/')[0];
  return singleFileHandles.get(id) || null;
}

// Workspace state
const WORKSPACE_ROOT = '/';
let workspaceDirHandle = null;          // FileSystemDirectoryHandle for the picked root
const wsFileHandles = new Map();        // "/path/file.md" -> FileSystemFileHandle
const wsDirHandles = new Map();         // "/path" -> FileSystemDirectoryHandle
const wsTreeByPath = new Map();         // "/path" -> [children] (cached subtree at that dir)
let linkIndexForward = new Map();       // filePath -> [{raw, resolvedTarget, line, context}]
let linkIndexBack = new Map();          // filePath -> [{source, line, context}]
let linkIndexNames = new Map();         // baseName.toLowerCase() -> filePath
let linkIndexRootPath = null;           // last indexed root (sanity check)

function clearWorkspace() {
  workspaceDirHandle = null;
  wsFileHandles.clear();
  wsDirHandles.clear();
  wsTreeByPath.clear();
  linkIndexForward = new Map();
  linkIndexBack = new Map();
  linkIndexNames = new Map();
  linkIndexRootPath = null;
}

function joinWsPath(parent, name) {
  if (parent === WORKSPACE_ROOT) return '/' + name;
  return parent + '/' + name;
}

async function enumerateDirectory(dirHandle, dirPath, depth = 0) {
  if (depth > 8) return [];
  wsDirHandles.set(dirPath, dirHandle);
  const items = [];
  const dirs = [];
  const files = [];
  try {
    for await (const [name, entry] of dirHandle.entries()) {
      if (entry.kind === 'directory') {
        if (IGNORED_DIRS.has(name)) continue;
        dirs.push({ name, entry });
      } else {
        files.push({ name, entry });
      }
    }
  } catch (err) {
    console.warn('Failed to read directory', dirPath, err);
    return [];
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  const dirItems = await Promise.all(dirs.map(async ({ name, entry }) => {
    const subPath = joinWsPath(dirPath, name);
    const children = await enumerateDirectory(entry, subPath, depth + 1);
    return { name, path: subPath, isDirectory: true, children };
  }));
  for (const d of dirItems) items.push(d);

  for (const { name, entry } of files) {
    const fp = joinWsPath(dirPath, name);
    wsFileHandles.set(fp, entry);
    items.push({ name, path: fp, isDirectory: false });
  }

  wsTreeByPath.set(dirPath, items);
  return items;
}

async function readFileFromHandle(handle) {
  const f = await handle.getFile();
  return await f.text();
}

function gitFsError(err) {
  return { error: err?.name || err?.message || String(err) };
}

function normalizeGitFsPath(path) {
  const raw = String(path || '/').replace(/\\/g, '/');
  const parts = raw.split('/').filter(Boolean);
  if (parts.includes('..')) throw new Error('Parent paths are not allowed');
  return '/' + parts.join('/');
}

async function getGitFsDirHandle(dirPath, create = false) {
  if (!workspaceDirHandle) throw new Error('No workspace');
  const normalized = normalizeGitFsPath(dirPath);
  if (normalized === '/') return workspaceDirHandle;
  let handle = workspaceDirHandle;
  let cursor = '';
  for (const part of normalized.split('/').filter(Boolean)) {
    handle = await handle.getDirectoryHandle(part, { create });
    cursor += '/' + part;
    wsDirHandles.set(cursor || '/', handle);
  }
  return handle;
}

async function getGitFsFileHandle(filePath, create = false) {
  const normalized = normalizeGitFsPath(filePath);
  const parent = dirOf(normalized);
  const name = baseOf(normalized);
  const parentHandle = await getGitFsDirHandle(parent, create);
  const handle = await parentHandle.getFileHandle(name, { create });
  wsFileHandles.set(normalized, handle);
  return handle;
}

async function gitFsReadFile(filePath, options) {
  try {
    const handle = await getGitFsFileHandle(filePath, false);
    const file = await handle.getFile();
    const encoding = typeof options === 'string' ? options : options?.encoding;
    if (encoding) return await file.text();
    return new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    return gitFsError(err);
  }
}

async function gitFsWriteFile(filePath, data) {
  try {
    const normalized = normalizeGitFsPath(filePath);
    const handle = await getGitFsFileHandle(normalized, true);
    let payload = data;
    if (data?.type === 'Buffer' && Array.isArray(data.data)) payload = new Uint8Array(data.data);
    else if (Array.isArray(data)) payload = new Uint8Array(data);
    await saveViaHandle(handle, payload);
    wsFileHandles.set(normalized, handle);
    return { success: true };
  } catch (err) {
    return gitFsError(err);
  }
}

async function gitFsUnlink(filePath) {
  try {
    const normalized = normalizeGitFsPath(filePath);
    const parentHandle = await getGitFsDirHandle(dirOf(normalized), false);
    await parentHandle.removeEntry(baseOf(normalized));
    wsFileHandles.delete(normalized);
    return { success: true };
  } catch (err) {
    return gitFsError(err);
  }
}

async function gitFsReaddir(dirPath, options) {
  try {
    const normalized = normalizeGitFsPath(dirPath);
    const handle = await getGitFsDirHandle(normalized, false);
    const entries = [];
    for await (const [name, entry] of handle.entries()) {
      if (options?.withFileTypes) {
        entries.push({ name, type: entry.kind === 'directory' ? 'dir' : 'file' });
      } else {
        entries.push(name);
      }
    }
    return entries.sort((a, b) => String(a.name || a).localeCompare(String(b.name || b)));
  } catch (err) {
    return gitFsError(err);
  }
}

async function gitFsMkdir(dirPath, options) {
  try {
    await getGitFsDirHandle(dirPath, !!options?.recursive || true);
    return { success: true };
  } catch (err) {
    return gitFsError(err);
  }
}

async function gitFsRmdir(dirPath) {
  try {
    const normalized = normalizeGitFsPath(dirPath);
    const parentHandle = await getGitFsDirHandle(dirOf(normalized), false);
    await parentHandle.removeEntry(baseOf(normalized), { recursive: false });
    wsDirHandles.delete(normalized);
    return { success: true };
  } catch (err) {
    return gitFsError(err);
  }
}

async function gitFsStat(targetPath) {
  try {
    const normalized = normalizeGitFsPath(targetPath);
    if (normalized === '/') {
      return { type: 'dir', size: 0, mode: 0o040000, mtimeMs: Date.now(), ctimeMs: Date.now() };
    }
    try {
      const handle = await getGitFsFileHandle(normalized, false);
      const file = await handle.getFile();
      return { type: 'file', size: file.size, mode: 0o100644, mtimeMs: file.lastModified, ctimeMs: file.lastModified };
    } catch {
      await getGitFsDirHandle(normalized, false);
      return { type: 'dir', size: 0, mode: 0o040000, mtimeMs: Date.now(), ctimeMs: Date.now() };
    }
  } catch (err) {
    return gitFsError(err);
  }
}

async function buildLinkIndexFull() {
  linkIndexForward = new Map();
  linkIndexBack = new Map();
  linkIndexNames = new Map();
  for (const [p] of wsFileHandles) {
    if (!isMarkdown(p)) continue;
    const name = basenameNoExt(baseOf(p)).toLowerCase();
    linkIndexNames.set(name, p);
  }
  const tasks = [];
  for (const [p, h] of wsFileHandles) {
    if (!isMarkdown(p)) continue;
    tasks.push(readFileFromHandle(h).then((content) => indexMarkdown(p, content)).catch(() => {}));
  }
  await Promise.all(tasks);
  linkIndexRootPath = WORKSPACE_ROOT;
}

function resolveLinkTarget(fromDir, target) {
  // Path-ish targets: resolve relative/absolute within workspace
  if (target.includes('/') || target.includes('\\') || /\.(md|markdown|mkd|mdx)$/i.test(target)) {
    const joined = target.startsWith('/') ? target : (fromDir === WORKSPACE_ROOT ? '/' + target : fromDir + '/' + target);
    // Normalize (resolve .. / .)
    const parts = joined.split('/').filter(Boolean);
    const out = [];
    for (const part of parts) {
      if (part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    const abs = '/' + out.join('/');
    if (wsFileHandles.has(abs)) return abs;
  }
  const normalized = target.toLowerCase().replace(/\.(md|markdown|mkd|mdx)$/i, '');
  return linkIndexNames.get(normalized) || null;
}

function indexMarkdown(filePath, content) {
  const fromDir = dirOf(filePath);
  const lines = content.split('\n');
  const links = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g)) {
      links.push({ raw: m[1].trim(), line: i + 1, context: line.substring(0, 200) });
    }
    for (const m of line.matchAll(/\[([^\]]*)\]\(([^)]+\.(?:md|markdown|mkd|mdx))\)/gi)) {
      links.push({ raw: m[2], line: i + 1, context: line.substring(0, 200) });
    }
  }
  const resolved = links.map((l) => ({ ...l, resolvedTarget: resolveLinkTarget(fromDir, l.raw) }));
  linkIndexForward.set(filePath, resolved);
  for (const link of resolved) {
    if (!link.resolvedTarget) continue;
    if (!linkIndexBack.has(link.resolvedTarget)) linkIndexBack.set(link.resolvedTarget, []);
    linkIndexBack.get(link.resolvedTarget).push({ source: filePath, line: link.line, context: link.context });
  }
}

// ==================== Single-file open / save ====================
let loadFileCb = null;
let urlConfirmCb = null;
let urlErrorCb = null;

async function fireLoad(file, handle) {
  const content = await file.text();
  const fileName = handle ? handle.name : file.name;
  const filePath = handle ? registerSingleFileHandle(handle) : noHandlePath(fileName);
  if (loadFileCb) loadFileCb({ filePath, dirPath: null, content });
}

async function openFileHandles(handles = []) {
  let opened = 0;
  for (const handle of handles || []) {
    if (!handle || handle.kind !== 'file') continue;
    const file = await handle.getFile();
    if (isBinary(file.name)) continue;
    await fireLoad(file, handle);
    opened++;
  }
  return opened > 0;
}

async function fireLoadText({ content, name, sourceUrl, source = 'url' }) {
  if (!loadFileCb) return;
  loadFileCb({
    filePath: null,
    dirPath: null,
    content,
    title: sanitizeFileName(name || 'shared.md'),
    source,
    sourceUrl,
    savedContent: '',
    forceUnsaved: true,
  });
}

async function confirmUrlFetch(detail) {
  if (urlConfirmCb) return await urlConfirmCb(detail);
  return window.confirm(detail.message || `Fetch file from ${detail.hostname}?`);
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('URL fetch timed out after 20 seconds.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseTextWithLimit(response, maxBytes = MAX_URL_BYTES) {
  const failLarge = () => new Error(`URL import exceeds the ${formatBytes(maxBytes)} safety limit.`);
  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw failLarge();
    return new TextDecoder().decode(buffer);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw failLarge();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock?.();
  }
}

async function fetchUrlTextContent(url, { skipHostConfirmation = false } = {}) {
  assertHttpsUrl(url);
  if (!skipHostConfirmation && !isTrustedHost(url.hostname)) {
    const ok = await confirmUrlFetch({
      kind: 'host',
      hostname: url.hostname,
      url: url.href,
      message: `Fetch file from ${url.hostname}?`,
    });
    if (!ok) throw abortError('URL import canceled.');
  }

  const response = await fetchWithTimeout(url.href);
  if (!response.ok) throw new Error(`URL fetch failed (${response.status} ${response.statusText}).`);

  const finalUrl = response.url ? new URL(response.url) : url;
  assertHttpsUrl(finalUrl);
  if (!skipHostConfirmation && !isTrustedHost(finalUrl.hostname) && finalUrl.hostname !== url.hostname) {
    const ok = await confirmUrlFetch({
      kind: 'host',
      hostname: finalUrl.hostname,
      url: finalUrl.href,
      message: `Fetch redirected file from ${finalUrl.hostname}?`,
    });
    if (!ok) throw abortError('URL import canceled.');
  }

  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_URL_BYTES) {
    throw new Error(`URL import is ${formatBytes(length)}, above the ${formatBytes(MAX_URL_BYTES)} safety limit.`);
  }

  return {
    content: await readResponseTextWithLimit(response),
    finalUrl,
  };
}

async function fetchTextUrl(url, { name, sourceUrl, skipHostConfirmation = false } = {}) {
  const { content, finalUrl } = await fetchUrlTextContent(url, { skipHostConfirmation });

  await fireLoadText({
    content,
    name: name || inferNameFromUrl(finalUrl),
    sourceUrl: sourceUrl || finalUrl.href,
  });
  return { success: true, count: 1 };
}

async function openGitHubBlob(input) {
  const raw = githubBlobToRaw(input);
  if (!raw) throw new Error('Invalid GitHub blob URL.');
  return await fetchTextUrl(raw.url, { name: raw.name, sourceUrl: raw.url.href, skipHostConfirmation: true });
}

async function openGist(input) {
  const gistId = gistIdFromInput(input);
  if (!gistId) throw new Error('Invalid Gist URL.');
  const apiUrl = new URL(`https://api.github.com/gists/${gistId}`);
  const response = await fetchWithTimeout(apiUrl.href, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`Gist fetch failed (${response.status} ${response.statusText}).`);
  const gist = await response.json();
  const files = Object.values(gist.files || {}).filter((file) => file?.raw_url);
  if (files.length === 0) throw new Error('Gist has no raw files to open.');

  let count = 0;
  for (const file of files) {
    const rawUrl = parseUrl(file.raw_url);
    await fetchTextUrl(rawUrl, {
      name: file.filename || inferNameFromUrl(rawUrl),
      sourceUrl: rawUrl.href,
      skipHostConfirmation: true,
    });
    count++;
  }
  return { success: true, count };
}

async function openUrlSource(input, options = {}) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('URL is empty.');

  const githubRaw = githubBlobToRaw(raw);
  if (githubRaw) {
    return await fetchTextUrl(githubRaw.url, {
      name: options.name || githubRaw.name,
      sourceUrl: githubRaw.url.href,
      skipHostConfirmation: true,
    });
  }

  const gistId = gistIdFromInput(raw);
  if (gistId && /^(?:https:\/\/gist\.github\.com\/|[a-f0-9]{6,}|[^/]+\/[a-f0-9]{6,})/i.test(raw)) {
    return await openGist(raw);
  }

  const url = parseUrl(raw);
  return await fetchTextUrl(url, { name: options.name || inferNameFromUrl(url), sourceUrl: url.href });
}

async function openUrlFromParams(paramsLike) {
  const params = paramsLike instanceof URLSearchParams
    ? paramsLike
    : new URLSearchParams(String(paramsLike || '').replace(/^\?/, ''));
  if (params.has('github')) return await openGitHubBlob(params.get('github'));
  if (params.has('gist')) return await openGist(params.get('gist'));
  if (params.has('src')) return await openUrlSource(params.get('src'), { name: params.get('name') || undefined });
  return { success: false, count: 0 };
}

async function pickAndOpen() {
  if (FS_SUPPORTED) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'Supported formats', accept: { 'text/*': SUPPORTED_EXTS.map((e) => '.' + e) } }],
      });
      for (const h of handles) {
        const f = await h.getFile();
        await fireLoad(f, h);
      }
      return true;
    } catch (e) {
      if (e?.name === 'AbortError') return false;
    }
  }
  return await new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = SUPPORTED_EXTS.map((e) => '.' + e).join(',');
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    input.addEventListener('change', async () => {
      for (const f of input.files) await fireLoad(f, null);
      finish(input.files.length > 0);
    });
    input.addEventListener('cancel', () => finish(false));
    window.addEventListener('focus', () => setTimeout(() => finish(false), 300), { once: true });
    input.click();
  });
}

function downloadBlob(fileName, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function defaultSaveName() {
  const m = (document.title || '').match(/^(?:•\s*)?(.+?)\s*-\s*OrPAD$/);
  if (m && m[1] && m[1] !== 'OrPAD') return m[1];
  return 'untitled.txt';
}

async function saveViaHandle(handle, content) {
  const w = await handle.createWritable();
  await w.write(content);
  await w.close();
}

async function saveFile(filePath, content) {
  if (filePath === 'localStorage:orpad-user-snippets') {
    localStorage.setItem('orpad-user-snippets', content);
    return true;
  }
  // Workspace file?
  const wsHandle = wsFileHandles.get(filePath);
  if (wsHandle) {
    try { await saveViaHandle(wsHandle, content); return true; }
    catch (err) { console.warn('workspace saveFile failed', err); return false; }
  }
  // Single-file open via FSA?
  const single = singleFileHandleFromPath(filePath);
  if (single) {
    try { await saveViaHandle(single, content); return true; }
    catch (err) { console.warn('single-file saveFile failed', err); return false; }
  }
  const fallbackName = sanitizeFileName(baseOf(filePath || '') || defaultSaveName(), defaultSaveName());
  downloadBlob(fallbackName, new Blob([content], { type: 'text/plain;charset=utf-8' }));
  return true;
}

async function saveFileAs(content) {
  const suggested = defaultSaveName();
  if (FS_SUPPORTED) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: suggested,
        types: [{ description: 'Supported formats', accept: { 'text/plain': SUPPORTED_EXTS.map((e) => '.' + e) } }],
      });
      await saveViaHandle(handle, content);
      return registerSingleFileHandle(handle);
    } catch (e) {
      if (e?.name === 'AbortError') return null;
    }
  }
  const name = window.prompt('Save file as:', suggested);
  if (!name) return null;
  downloadBlob(name, new Blob([content], { type: 'text/plain;charset=utf-8' }));
  return noHandlePath(name);
}

// ==================== Workspace ====================
async function openFolderDialog() {
  if (!FSA_DIR_SUPPORTED) {
    window.alert('Open Folder requires a Chromium-based browser (Chrome, Edge, Arc, Opera).\n\nFirefox and Safari do not yet support the File System Access API needed to browse a folder in place.');
    return null;
  }
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    clearWorkspace();
    workspaceDirHandle = dir;
    await enumerateDirectory(dir, WORKSPACE_ROOT);
    return WORKSPACE_ROOT;
  } catch (e) {
    if (e?.name === 'AbortError') return null;
    console.warn('openFolderDialog failed', e);
    window.alert('Failed to open folder: ' + (e?.message || e));
    return null;
  }
}

async function readDirectory(dirPath) {
  if (!workspaceDirHandle) return [];
  // Re-enumerate on every call so the Refresh button picks up external changes.
  // For the root, walk the whole tree; for a subdir, just that subtree.
  if (dirPath === WORKSPACE_ROOT || dirPath === '/') {
    wsFileHandles.clear();
    wsDirHandles.clear();
    wsTreeByPath.clear();
    const items = await enumerateDirectory(workspaceDirHandle, WORKSPACE_ROOT);
    return items;
  }
  const handle = wsDirHandles.get(dirPath);
  if (!handle) return [];
  const items = await enumerateDirectory(handle, dirPath);
  return items;
}

async function readFile(filePath) {
  const handle = wsFileHandles.get(filePath);
  if (!handle) return { error: 'File not found in workspace' };
  try {
    const content = await readFileFromHandle(handle);
    return {
      content,
      filePath,
      fileName: baseOf(filePath),
      dirPath: dirOf(filePath),
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

async function searchFiles(_dirPath, query, options) {
  if (!query || !workspaceDirHandle) return [];
  const { regex = false, caseSensitive = false, extensions = null } = options || {};
  let pattern = null;
  if (regex) {
    try { pattern = new RegExp(query, caseSensitive ? 'g' : 'gi'); }
    catch { return []; }
  }
  const extSet = (Array.isArray(extensions) && extensions.length > 0)
    ? new Set(extensions.map((e) => String(e).toLowerCase().replace(/^\*?\./, '')).filter(Boolean))
    : null;
  const needle = caseSensitive ? query : query.toLowerCase();
  const results = [];

  const tasks = [];
  for (const [fullPath, handle] of wsFileHandles) {
    const fileName = baseOf(fullPath);
    if (isBinary(fileName)) continue;
    if (extSet && !extSet.has(extOf(fileName))) continue;
    tasks.push((async () => {
      let content;
      try { content = await readFileFromHandle(handle); }
      catch { return; }
      const lines = content.split('\n');
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let found;
        if (pattern) {
          pattern.lastIndex = 0;
          found = pattern.test(line);
        } else {
          found = caseSensitive ? line.includes(query) : line.toLowerCase().includes(needle);
        }
        if (found) {
          matches.push({ lineNumber: i + 1, lineText: line.substring(0, 200) });
          if (matches.length >= 50) break;
        }
      }
      if (matches.length > 0) {
        results.push({
          filePath: fullPath,
          fileName,
          relativePath: fullPath.startsWith('/') ? fullPath.slice(1) : fullPath,
          matches,
        });
      }
    })());
  }
  await Promise.all(tasks);
  return results;
}

async function buildLinkIndex(_dirPath) {
  if (!workspaceDirHandle) return { fileCount: 0 };
  await buildLinkIndexFull();
  return { fileCount: linkIndexNames.size };
}

async function resolveWikiLink(_dirPath, targetName) {
  if (!workspaceDirHandle) return null;
  if (linkIndexRootPath !== WORKSPACE_ROOT) await buildLinkIndexFull();
  return resolveLinkTarget(WORKSPACE_ROOT, targetName);
}

async function getBacklinks(_dirPath, filePath) {
  if (!workspaceDirHandle) return { linked: [], unlinked: [] };
  if (linkIndexRootPath !== WORKSPACE_ROOT) await buildLinkIndexFull();
  const linked = (linkIndexBack.get(filePath) || []).map((b) => ({
    sourcePath: b.source,
    sourceTitle: basenameNoExt(baseOf(b.source)),
    line: b.line,
    context: b.context,
  }));
  const unlinked = [];
  if (linkIndexNames.size <= 1000) {
    const baseName = basenameNoExt(baseOf(filePath));
    const searchTerm = baseName.toLowerCase();
    const linkedSources = new Set(linked.map((l) => l.sourcePath));
    const tasks = [];
    for (const [, fpath] of linkIndexNames) {
      if (fpath === filePath || linkedSources.has(fpath)) continue;
      const handle = wsFileHandles.get(fpath);
      if (!handle) continue;
      tasks.push(readFileFromHandle(handle).then((content) => {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(searchTerm)) {
            unlinked.push({
              sourcePath: fpath,
              sourceTitle: basenameNoExt(baseOf(fpath)),
              line: i + 1,
              context: lines[i].substring(0, 200),
            });
            return;
          }
        }
      }).catch(() => {}));
    }
    await Promise.all(tasks);
  }
  return { linked, unlinked };
}

async function getFileNames(_dirPath) {
  if (!workspaceDirHandle) return [];
  if (linkIndexRootPath !== WORKSPACE_ROOT) await buildLinkIndexFull();
  const names = [];
  for (const [, fpath] of linkIndexNames) {
    names.push({ baseName: basenameNoExt(baseOf(fpath)), filePath: fpath });
  }
  return names;
}

function webRunbookExt(name) {
  const lower = String(name || '').toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.')) return 'env';
  if (lower.endsWith('.or-pipeline')) return 'orpad';
  if (lower.endsWith('.or-graph')) return 'orpad';
  if (lower.endsWith('.or-tree')) return 'orpad';
  if (lower.endsWith('.or-rule')) return 'orpad';
  if (lower.endsWith('.or-run')) return 'orpad';
  if (lower.endsWith('.orch-graph.json')) return 'orch';
  if (lower.endsWith('.orch-tree.json')) return 'orch';
  const match = lower.match(/\.([a-z0-9]+)$/);
  return match ? match[1] : 'text';
}

function webIsPipelineFile(name) {
  return String(name || '').toLowerCase().endsWith('.or-pipeline');
}

function webIsLegacyRunbookFile(name) {
  const lower = String(name || '').toLowerCase();
  return lower.endsWith('.orch-graph.json') || lower.endsWith('.orch-tree.json') || lower.endsWith('.orch');
}

function webRiskyName(name) {
  const lower = String(name || '').toLowerCase();
  return lower === '.env'
    || lower.startsWith('.env.')
    || lower.includes('secret')
    || lower.includes('token')
    || lower.includes('password')
    || lower.endsWith('.pem')
    || lower.endsWith('.key')
    || lower.endsWith('.p12')
    || lower.endsWith('.pfx');
}

function webIsPipelineGeneratedHarnessDir(dirPath) {
  const parts = String(dirPath || '')
    .split('/')
    .filter(Boolean);

  for (let index = 0; index <= parts.length - 5; index += 1) {
    if (
      parts[index] === '.orpad'
      && parts[index + 1] === 'pipelines'
      && parts[index + 3] === 'harness'
      && parts[index + 4] === 'generated'
    ) {
      return true;
    }
  }

  return false;
}

async function scanRunbookWorkspaceWeb() {
  const extCounts = new Map();
  const runbooks = [];
  const pipelines = [];
  const legacyRunbooks = [];
  const risky = [];
  let fileCount = 0;
  let dirCount = 0;
  let markdownCount = 0;
  let dataCount = 0;
  let diagramCount = 0;
  let logCount = 0;
  let hasObsidian = false;
  let hasRuns = false;

  async function walk(handle, dirPath, depth = 0) {
    if (depth > 8) return;
    for await (const [name, entry] of handle.entries()) {
      const fullPath = joinWsPath(dirPath, name);
      if (entry.kind === 'directory') {
        dirCount += 1;
        if (name === '.obsidian') { hasObsidian = true; continue; }
        if (name === '.orch-runs') { hasRuns = true; continue; }
        if (name === 'runs' && fullPath.includes('/.orpad/pipelines/')) { hasRuns = true; continue; }
        if (webIsPipelineGeneratedHarnessDir(fullPath)) continue;
        if (IGNORED_DIRS.has(name)) continue;
        await walk(entry, fullPath, depth + 1);
      } else {
        fileCount += 1;
        const ext = webRunbookExt(name);
        const item = { name, path: fullPath, kind: 'file' };
        extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
        if (webIsPipelineFile(name)) {
          item.format = 'or-pipeline';
          item.displayName = dirOf(fullPath).split('/').pop() || name;
          pipelines.push(item);
          runbooks.push(item);
        } else if (webIsLegacyRunbookFile(name)) {
          item.format = name.toLowerCase().endsWith('.orch-graph.json') ? 'orch-graph' : 'orch-tree';
          legacyRunbooks.push(item);
          runbooks.push(item);
        }
        if (webRiskyName(name)) risky.push(item);
        if (['md', 'markdown', 'mkd', 'mdx'].includes(ext)) markdownCount += 1;
        if (['json', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'xml', 'ini', 'conf', 'properties', 'env'].includes(ext)) dataCount += 1;
        if (['mmd', 'mermaid'].includes(ext)) diagramCount += 1;
        if (ext === 'log') logCount += 1;
      }
    }
  }

  if (workspaceDirHandle) await walk(workspaceDirHandle, WORKSPACE_ROOT);
  let workspaceType = 'Project workspace';
  if (hasObsidian && pipelines.length) workspaceType = 'Obsidian + OrPAD Pipeline workspace';
  else if (hasObsidian && runbooks.length) workspaceType = 'Obsidian + Legacy Runbook workspace';
  else if (hasObsidian) workspaceType = 'Obsidian vault';
  else if (pipelines.length) workspaceType = 'OrPAD Pipeline workspace';
  else if (runbooks.length) workspaceType = 'Legacy Runbook workspace';
  return {
    success: true,
    source: 'web-scanner',
    workspaceType,
    files: [],
    dirs: [],
    fileCount,
    dirCount,
    runbooks,
    risky,
    hasObsidian,
    hasRuns,
    markdownCount,
    dataCount,
    diagramCount,
    logCount,
    topExts: [...extCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    pipelines,
    legacyRunbooks,
  };
}

const WEB_TRUST_LEVELS = new Set([
  'local-authored',
  'imported-review',
  'signed-template',
  'generated-draft',
  'unknown',
]);
const WEB_WORK_ITEM_SCHEMA_VERSION = 'orpad.workItem.v1';
const WEB_WORK_ITEM_STATES = ['candidate', 'queued', 'claimed', 'done', 'blocked', 'rejected'];
const WEB_BUILT_IN_ORPAD_NODE_TYPES = new Set([
  'orpad.artifactContract',
  'orpad.barrier',
  'orpad.context',
  'orpad.dispatcher',
  'orpad.gate',
  'orpad.probe',
  'orpad.rule',
  'orpad.skill',
  'orpad.graph',
  'orpad.tree',
  'orpad.triage',
  'orpad.workQueue',
  'orpad.workerLoop',
]);
const WEB_ALL_NODE_TYPES = new Set([
  'Sequence',
  'Selector',
  'Parallel',
  'Discuss',
  'Loop',
  'Gate',
  'Context',
  'Timeout',
  'Retry',
  'Catch',
  'CrossCheck',
  'Skill',
  'Planner',
  'OrchTree',
  ...WEB_BUILT_IN_ORPAD_NODE_TYPES,
]);
const WEB_GRAPH_NODE_TYPES = new Set([
  ...WEB_ALL_NODE_TYPES,
  'State',
  'Tool',
  'Human',
  'Wait',
]);

function webNormalizeTrustLevel(trustLevel, fallback = 'unknown') {
  const normalized = String(trustLevel || fallback);
  return WEB_TRUST_LEVELS.has(normalized) ? normalized : 'unknown';
}

function webTrustLevelFromDocument(doc, options = {}) {
  return webNormalizeTrustLevel(doc?.trustLevel || doc?.security?.trustLevel || doc?.metadata?.trustLevel || options.trustLevel, 'local-authored');
}

function webValidateRunbookSource(source, options = {}) {
  const diagnostics = [];
  const nodeTypes = new Set();
  const renderOnlyNodeTypes = new Set();
  let graphCount = 0;
  let treeCount = 0;
  let nodeCount = 0;

  function walk(node, context = 'tree') {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      diagnostics.push({ level: 'error', code: 'NODE_INVALID', message: 'Runbook node must be an object.' });
      return;
    }
    if (!node.id) diagnostics.push({ level: 'error', code: 'NODE_ID_MISSING', message: 'Runbook node must have an id.' });
    if (!node.type) diagnostics.push({ level: 'error', code: 'NODE_TYPE_MISSING', message: 'Runbook node must have a type.' });
    if (node.type) {
      const nodeType = String(node.type);
      const isGraphContext = context === 'graph';
      const knownType = isGraphContext ? webIsKnownGraphNodeType(nodeType) : webIsKnownNodeType(nodeType);
      if (!knownType) {
        diagnostics.push({
          level: 'error',
          code: isGraphContext ? 'GRAPH_NODE_TYPE_UNKNOWN' : 'NODE_TYPE_UNKNOWN',
          message: isGraphContext ? `Unknown graph node type: ${nodeType}.` : `Unknown runbook node type: ${nodeType}.`,
          nodeId: node.id || undefined,
          nodeType,
        });
      } else {
        nodeTypes.add(nodeType);
        nodeCount += 1;
        if (isGraphContext || webIsTreeNodeType(nodeType)) renderOnlyNodeTypes.add(nodeType);
      }
    }
    if (webIsSkillNodeType(node.type) && !(node.file || node.config?.file || node.skillRef || node.config?.skillRef)) {
      diagnostics.push({ level: 'error', code: 'SKILL_FILE_MISSING', message: 'Skill node must reference a Markdown skill file.' });
    }
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child, context);
  }

  try {
    const parsed = JSON.parse(String(source || ''));
    const trustLevel = webTrustLevelFromDocument(parsed, options);
    if (parsed?.kind === 'orpad.pipeline' || parsed?.entryGraph) {
      const graphRefs = webCollectPipelineRefItems(parsed.graphs);
      const entryGraph = parsed.entryGraph || parsed.entry?.graph || parsed.graph?.file || graphRefs[0]?.file || '';
      if (!entryGraph) {
        diagnostics.push({ level: 'error', code: 'PIPELINE_ENTRY_GRAPH_MISSING', message: 'Pipeline must include an entryGraph file reference.' });
      }
      diagnostics.push({
        level: 'warning',
        code: 'WEB_LIMITED_MODE',
        message: 'Web can review and validate pipelines, but local execution, terminal, PTY, and desktop MCP are desktop-only.',
      });
      return {
        ok: !diagnostics.some(item => item.level === 'error'),
        canExecute: false,
        trustLevel,
        schemaVersion: String(parsed.version || ''),
        format: 'or-pipeline',
        pipelineCount: 1,
        graphCount: entryGraph ? 1 : 0,
        treeCount,
        nodeCount,
        nodeTypes: [],
        executableNodeTypes: [],
        renderOnlyNodeTypes: [],
        diagnostics,
      };
    }
    if (parsed?.graph && typeof parsed.graph === 'object' && !Array.isArray(parsed.graph)) {
      graphCount = 1;
      const nodes = Array.isArray(parsed.graph.nodes) ? parsed.graph.nodes : [];
      const ids = new Set();
      if (!nodes.length) diagnostics.push({ level: 'error', code: 'GRAPH_NODES_MISSING', message: 'Graph must include at least one node.' });
      for (const node of nodes) {
        walk(node, 'graph');
        if (node?.id) ids.add(String(node.id));
        if (webIsTreeNodeType(node?.type) && (node.tree || node.config?.tree)) {
          treeCount += 1;
          walk((node.tree || node.config?.tree)?.root);
        }
      }
      for (const transition of Array.isArray(parsed.graph.transitions) ? parsed.graph.transitions : []) {
        if (!transition?.from || !transition?.to) diagnostics.push({ level: 'error', code: 'GRAPH_TRANSITION_ENDPOINT_MISSING', message: 'Graph transition must include from and to node ids.' });
        else if (!ids.has(String(transition.from)) || !ids.has(String(transition.to))) diagnostics.push({ level: 'error', code: 'GRAPH_TRANSITION_REF_UNKNOWN', message: 'Graph transition must reference existing node ids.' });
      }
      diagnostics.push({
        level: 'warning',
        code: 'WEB_LIMITED_MODE',
        message: 'Web can review and validate runbooks, but local execution, terminal, PTY, and desktop MCP are desktop-only.',
      });
      diagnostics.push({
        level: 'warning',
        code: 'GRAPH_RENDER_VALIDATE_ONLY',
        message: 'Flow-based runbooks are review-only on the web until local execution is available.',
      });
      return {
        ok: !diagnostics.some(item => item.level === 'error'),
        canExecute: false,
        trustLevel,
        schemaVersion: String(parsed.version || ''),
        graphCount,
        treeCount,
        nodeCount,
        nodeTypes: [...nodeTypes].sort(),
        executableNodeTypes: [],
        renderOnlyNodeTypes: [...renderOnlyNodeTypes].sort(),
        diagnostics,
      };
    }
    const hasInlineRoot = parsed?.root && typeof parsed.root === 'object' && !Array.isArray(parsed.root);
    const trees = hasInlineRoot
      ? [{ id: parsed.id || 'tree', root: parsed.root }]
      : (Array.isArray(parsed.trees) ? parsed.trees : []);
    treeCount = trees.length;
    if (!treeCount) diagnostics.push({ level: 'error', code: 'TREES_MISSING', message: 'Runbook must include a root node or at least one tree.' });
    for (const tree of trees) walk(tree.root);
    diagnostics.push({
      level: 'warning',
      code: 'WEB_LIMITED_MODE',
      message: 'Web can review and validate runbooks, but local execution, terminal, PTY, and desktop MCP are desktop-only.',
    });
    return {
      ok: !diagnostics.some(item => item.level === 'error'),
      canExecute: false,
      trustLevel,
      schemaVersion: String(parsed.version || ''),
      graphCount,
      treeCount,
      nodeCount,
      nodeTypes: [...nodeTypes].sort(),
      executableNodeTypes: [],
      renderOnlyNodeTypes: [...nodeTypes].sort(),
      diagnostics,
    };
  } catch (err) {
    const trustLevel = webNormalizeTrustLevel(options.trustLevel, 'local-authored');
    return {
      ok: false,
      canExecute: false,
      trustLevel,
      schemaVersion: '',
      treeCount: 0,
      nodeCount: 0,
      nodeTypes: [],
      executableNodeTypes: [],
      renderOnlyNodeTypes: [],
      diagnostics: [{ level: 'error', code: 'JSON_PARSE_ERROR', message: `Runbook JSON parse failed: ${err.message}` }],
    };
  }
}

// Mutation ops — FSA supports create/remove but not direct rename. Renames go
// via read-then-write-then-remove. Best-effort: surface errors as an alert.
function webSplitRefAnchor(ref) {
  const raw = String(ref || '');
  const hashIndex = raw.indexOf('#');
  return hashIndex === -1 ? { file: raw, anchor: '' } : { file: raw.slice(0, hashIndex), anchor: raw.slice(hashIndex + 1) };
}

function webIsUrlRef(ref) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(ref || ''));
}

function webIsNodePackRef(ref) {
  const { file } = webSplitRefAnchor(ref);
  return /^[a-z0-9_.-]+:[a-z0-9_.-]+$/i.test(String(file || ''));
}

function webIsSkillNodeType(type) {
  return type === 'Skill' || type === 'orpad.skill';
}

function webIsTreeNodeType(type) {
  return type === 'OrchTree' || type === 'orpad.tree';
}

function webIsKnownNodeType(type) {
  return WEB_ALL_NODE_TYPES.has(String(type || ''));
}

function webIsKnownGraphNodeType(type) {
  return WEB_GRAPH_NODE_TYPES.has(String(type || ''));
}

function webNormalizeWsPath(rawPath) {
  const raw = String(rawPath || '/').replace(/\\/g, '/');
  const absolute = raw.startsWith('/') ? raw : '/' + raw;
  const out = [];
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) return '';
      out.pop();
    } else {
      out.push(part);
    }
  }
  return '/' + out.join('/');
}

function webPathInside(child, parent) {
  const normalizedChild = webNormalizeWsPath(child);
  const normalizedParent = webNormalizeWsPath(parent || '/');
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent.replace(/\/$/, '') + '/');
}

function webResolveRef(baseDir, ref, allowedRoot = baseDir) {
  const { file } = webSplitRefAnchor(ref);
  if (!file || webIsUrlRef(file)) return '';
  const joined = webNormalizeWsPath(file.startsWith('/') ? file : joinWsPath(baseDir, file));
  if (!joined || !webPathInside(joined, allowedRoot || baseDir)) return '';
  return joined;
}

function webNormalizePipelineRefItem(item, fallbackId = '') {
  if (!item) return null;
  if (typeof item === 'string') return { id: fallbackId || baseOf(item), file: item };
  if (typeof item !== 'object' || Array.isArray(item)) return null;
  const file = item.file || item.path || item.ref || '';
  const id = item.id || item.name || fallbackId || (file ? baseOf(file) : '');
  return file ? { ...item, id: String(id), file: String(file) } : null;
}

function webCollectPipelineRefItems(value) {
  if (Array.isArray(value)) return value.map(item => webNormalizePipelineRefItem(item)).filter(Boolean);
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([id, item]) => webNormalizePipelineRefItem(typeof item === 'string' ? item : { id, ...item }, id))
      .filter(Boolean);
  }
  return [];
}

function webGraphObject(doc) {
  if (doc?.graph && typeof doc.graph === 'object' && !Array.isArray(doc.graph)) return doc.graph;
  return Array.isArray(doc?.nodes) ? doc : null;
}

function webTreeEntries(doc) {
  if (doc?.root && typeof doc.root === 'object' && !Array.isArray(doc.root)) {
    return [{ id: doc.id || 'tree', root: doc.root }];
  }
  return Array.isArray(doc?.trees) ? doc.trees : [];
}

async function webReadJsonRef(filePath, diagnostics, code, message, details = {}) {
  const result = await readFile(filePath);
  if (result?.error) {
    diagnostics.push({ level: 'error', code, message, ...details, ref: details.ref || filePath });
    return null;
  }
  try {
    return JSON.parse(result.content || '{}');
  } catch (err) {
    diagnostics.push({ level: 'error', code: code.replace(/NOT_FOUND$/, 'PARSE_FAILED'), message: `Referenced JSON file could not be parsed: ${err.message}`, ...details, ref: details.ref || filePath });
    return null;
  }
}

async function webValidateReferencedTree(ref, state, nodeId) {
  if (webIsUrlRef(ref)) {
    state.diagnostics.push({ level: 'error', code: 'ORCH_TREE_REMOTE_REF', message: 'Remote tree references are not executable in web review mode.', nodeId, ref });
    return;
  }
  const treePath = webResolveRef(state.baseDir, ref, state.allowedRoot);
  if (!treePath) {
    state.diagnostics.push({ level: 'error', code: 'ORCH_TREE_OUTSIDE_BASE', message: 'Tree reference must stay inside the pipeline or runbook directory.', nodeId, ref });
    return;
  }
  if (state.visitedTrees.has(treePath.toLowerCase())) return;
  state.visitedTrees.add(treePath.toLowerCase());
  const treeDoc = await webReadJsonRef(treePath, state.diagnostics, 'ORCH_TREE_NOT_FOUND', 'Referenced tree file does not exist.', { nodeId, ref });
  if (!treeDoc) return;
  state.treeCount += 1;
  const previousBaseDir = state.baseDir;
  state.baseDir = dirOf(treePath);
  for (const tree of webTreeEntries(treeDoc)) await webWalkNodeDeep(tree.root, state);
  state.baseDir = previousBaseDir;
}

function webNodeConfig(node) {
  return node?.config && typeof node.config === 'object' && !Array.isArray(node.config)
    ? node.config
    : {};
}

function webSkillFileTarget(node, state) {
  const config = webNodeConfig(node);
  const directRef = node.file || config.file || '';
  const skillRef = String(node.skillRef || config.skillRef || '').trim();
  if (skillRef && webIsNodePackRef(skillRef)) return { nodePack: true, skillRef };
  const mappedRef = skillRef ? state.pipelineSkills.get(skillRef) : '';
  return {
    ref: directRef || mappedRef || '',
    baseDir: directRef ? state.baseDir : state.pipelineDir,
    skillRef,
  };
}

function webValidateSkillFile(node, state, currentPath, nodeId) {
  const target = webSkillFileTarget(node, state);
  if (target.nodePack) return;
  if (!target.ref) {
    state.diagnostics.push({
      level: 'error',
      code: 'SKILL_FILE_MISSING',
      message: 'Skill node must reference a Markdown skill file or pipeline skill id.',
      nodeId,
      path: currentPath,
      skillRef: target.skillRef || undefined,
    });
    return;
  }
  if (webIsUrlRef(target.ref)) {
    state.diagnostics.push({
      level: 'error',
      code: 'SKILL_FILE_REMOTE_REF',
      message: 'Remote skill file references are not executable in web review mode.',
      nodeId,
      path: currentPath,
      ref: target.ref,
    });
    return;
  }
  const skillPath = webResolveRef(target.baseDir, target.ref, state.allowedRoot);
  if (!skillPath) {
    state.diagnostics.push({
      level: 'error',
      code: 'SKILL_FILE_OUTSIDE_BASE',
      message: 'Skill file reference must stay inside the pipeline or runbook directory.',
      nodeId,
      path: currentPath,
      ref: target.ref,
    });
  } else if (!wsFileHandles.has(skillPath)) {
    state.diagnostics.push({
      level: 'error',
      code: 'SKILL_FILE_NOT_FOUND',
      message: 'Referenced skill file does not exist.',
      nodeId,
      path: currentPath,
      ref: target.ref,
    });
  }
}

async function webValidateTreeNode(node, state, currentPath, nodeId) {
  const config = webNodeConfig(node);
  const embeddedTree = node.tree || config.tree || null;
  const ref = node.treeRef || config.treeRef || node.ref || config.ref || '';
  if (embeddedTree && typeof embeddedTree === 'object' && !Array.isArray(embeddedTree)) {
    const trees = webTreeEntries(embeddedTree);
    if (!trees.length) {
      state.diagnostics.push({
        level: 'error',
        code: 'TREE_ROOT_MISSING',
        message: 'Tree node must embed a tree with a root node.',
        nodeId,
        path: currentPath,
      });
      return;
    }
    state.treeCount += trees.length;
    for (const tree of trees) await webWalkNodeDeep(tree.root, state);
  } else if (ref) {
    await webValidateReferencedTree(ref, state, nodeId);
  } else {
    state.diagnostics.push({
      level: 'warning',
      code: 'ORCH_TREE_REF_MISSING',
      message: 'Tree graph node should embed a tree or reference an .or-tree or .orch-tree.json file.',
      nodeId,
      path: currentPath,
    });
  }
}

function webValidateRequiredGraphConfig(node, currentPath, requiredKeys, diagnostics) {
  const config = webNodeConfig(node);
  for (const key of requiredKeys) {
    if (config[key] === undefined || config[key] === null || String(config[key]).trim() === '') {
      diagnostics.push({
        level: 'error',
        code: 'GRAPH_NODE_CONFIG_MISSING',
        message: `Graph node config must include ${key}.`,
        nodeId: node?.id || undefined,
        path: `${currentPath}.config.${key}`,
        configKey: key,
      });
    }
  }
}

function webValidateWorkQueueSchema(node, currentPath, diagnostics) {
  const schema = String(webNodeConfig(node).schema || '').trim();
  if (!schema || schema === WEB_WORK_ITEM_SCHEMA_VERSION) return;
  diagnostics.push({
    level: 'error',
    code: 'WORK_QUEUE_SCHEMA_UNSUPPORTED',
    message: `WorkQueue schema must be ${WEB_WORK_ITEM_SCHEMA_VERSION}.`,
    nodeId: node?.id || undefined,
    path: `${currentPath}.config.schema`,
    schema,
  });
}

function webValidatePipelineQueueProtocol(pipeline, diagnostics) {
  const protocol = pipeline?.run?.queueProtocol;
  if (!protocol || typeof protocol !== 'object' || Array.isArray(protocol)) return;
  const schema = String(protocol.schema || '').trim();
  if (!schema) {
    diagnostics.push({
      level: 'error',
      code: 'PIPELINE_QUEUE_PROTOCOL_SCHEMA_MISSING',
      message: 'Pipeline run.queueProtocol must declare a work item schema.',
      path: 'run.queueProtocol.schema',
    });
  } else if (schema !== WEB_WORK_ITEM_SCHEMA_VERSION) {
    diagnostics.push({
      level: 'error',
      code: 'PIPELINE_QUEUE_PROTOCOL_SCHEMA_UNSUPPORTED',
      message: `Pipeline run.queueProtocol schema must be ${WEB_WORK_ITEM_SCHEMA_VERSION}.`,
      path: 'run.queueProtocol.schema',
      schema,
    });
  }
  const states = Array.isArray(protocol.states) ? protocol.states.map(item => String(item)) : [];
  const missingStates = WEB_WORK_ITEM_STATES.filter(state => !states.includes(state));
  if (missingStates.length) {
    diagnostics.push({
      level: 'error',
      code: 'PIPELINE_QUEUE_PROTOCOL_STATES_INCOMPLETE',
      message: 'Pipeline run.queueProtocol states must include every canonical work item state.',
      path: 'run.queueProtocol.states',
      missingStates,
    });
  }
}

function webGraphQueueNamespaces(graphDoc, nodes) {
  const namespaces = new Set((Array.isArray(graphDoc?.interface?.queueNamespaces)
    ? graphDoc.interface.queueNamespaces
    : []).map(String));
  for (const node of nodes) {
    if (node?.type !== 'orpad.workQueue') continue;
    const config = webNodeConfig(node);
    if (config.queueRef) namespaces.add(String(config.queueRef));
    if (node.id) namespaces.add(String(node.id));
  }
  return namespaces;
}

function webValidateGraphNodeRefs(nodes, graphDoc, state, refPath = 'graph') {
  const ids = new Set(nodes.map(node => node?.id).filter(Boolean).map(String));
  const nodeTypesById = new Map(nodes
    .filter(node => node?.id)
    .map(node => [String(node.id), String(node.type || '')]));
  const queues = webGraphQueueNamespaces(graphDoc, nodes);

  nodes.forEach((node, index) => {
    if (!node || typeof node !== 'object') return;
    const nodeId = String(node.id || '');
    const type = String(node.type || '');
    const config = webNodeConfig(node);
    const currentPath = `${refPath}.nodes[${index}]`;

    if (['orpad.probe', 'orpad.triage', 'orpad.dispatcher', 'orpad.workerLoop'].includes(type) && config.queueRef) {
      const queueRef = String(config.queueRef);
      if (!queues.has(queueRef)) {
        state.diagnostics.push({
          level: 'error',
          code: ids.has(queueRef) ? 'GRAPH_QUEUE_REF_INVALID_TARGET' : 'GRAPH_QUEUE_REF_UNKNOWN',
          message: 'queueRef must reference a WorkQueue node id or declared graph queue namespace.',
          nodeId: nodeId || undefined,
          path: `${currentPath}.config.queueRef`,
          ref: queueRef,
        });
      }
    }

    if (type === 'orpad.dispatcher' && config.workerLoopRef) {
      const workerLoopRef = String(config.workerLoopRef);
      const workerLoopType = nodeTypesById.get(workerLoopRef);
      if (workerLoopType !== 'orpad.workerLoop') {
        state.diagnostics.push({
          level: 'error',
          code: workerLoopType ? 'GRAPH_WORKER_LOOP_REF_INVALID_TARGET' : 'GRAPH_WORKER_LOOP_REF_UNKNOWN',
          message: 'workerLoopRef must reference an existing worker loop node in the graph.',
          nodeId: nodeId || undefined,
          path: `${currentPath}.config.workerLoopRef`,
          ref: workerLoopRef,
        });
      }
    }
  });
}

async function webValidateReferencedGraph(ref, state, nodeId) {
  if (webIsUrlRef(ref)) {
    state.diagnostics.push({ level: 'error', code: 'ORPAD_GRAPH_REMOTE_REF', message: 'Remote graph references are not executable in web review mode.', nodeId, ref });
    return;
  }
  if (webIsNodePackRef(ref)) return;
  const graphPath = webResolveRef(state.baseDir, ref, state.allowedRoot);
  if (!graphPath) {
    state.diagnostics.push({ level: 'error', code: 'ORPAD_GRAPH_OUTSIDE_BASE', message: 'Graph reference must stay inside the pipeline directory.', nodeId, ref });
    return;
  }
  const graphKey = graphPath.toLowerCase();
  if (state.graphStack.includes(graphKey)) {
    state.diagnostics.push({ level: 'error', code: 'ORPAD_GRAPH_REF_CYCLE', message: 'Graph references must not form a cycle.', nodeId, ref });
    return;
  }
  if (state.visitedGraphs.has(graphKey)) return;
  state.visitedGraphs.add(graphKey);
  state.graphStack.push(graphKey);
  const graphDoc = await webReadJsonRef(graphPath, state.diagnostics, 'ORPAD_GRAPH_NOT_FOUND', 'Referenced graph file does not exist.', { nodeId, ref });
  if (graphDoc) {
    const previousBaseDir = state.baseDir;
    state.baseDir = dirOf(graphPath);
    await webValidateGraphDocument(graphDoc, state, ref);
    state.baseDir = previousBaseDir;
  }
  state.graphStack.pop();
}

async function webWalkGraphNodeDeep(node, state, currentPath) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    state.diagnostics.push({ level: 'error', code: 'GRAPH_NODE_INVALID', message: 'Graph node must be an object.', path: currentPath });
    return;
  }
  const id = String(node.id || '').trim();
  const type = String(node.type || '').trim();
  if (!id) state.diagnostics.push({ level: 'error', code: 'GRAPH_NODE_ID_MISSING', message: 'Graph node must have a non-empty id.', path: currentPath });
  if (!type) {
    state.diagnostics.push({ level: 'error', code: 'GRAPH_NODE_TYPE_MISSING', message: 'Graph node must have a type.', nodeId: id || undefined, path: currentPath });
    return;
  }
  if (!webIsKnownGraphNodeType(type)) {
    state.diagnostics.push({ level: 'error', code: 'GRAPH_NODE_TYPE_UNKNOWN', message: `Unknown graph node type: ${type}.`, nodeId: id || undefined, path: currentPath, nodeType: type });
    return;
  }
  state.nodeTypes.add(type);
  state.nodeCount += 1;
  state.renderOnlyNodeTypes.add(type);

  if (type === 'orpad.dispatcher') webValidateRequiredGraphConfig(node, currentPath, ['queueRef', 'workerLoopRef'], state.diagnostics);
  if (type === 'orpad.workQueue') {
    webValidateRequiredGraphConfig(node, currentPath, ['queueRoot', 'schema'], state.diagnostics);
    webValidateWorkQueueSchema(node, currentPath, state.diagnostics);
  }
  if (type === 'orpad.triage' || type === 'orpad.workerLoop') webValidateRequiredGraphConfig(node, currentPath, ['queueRef'], state.diagnostics);
  if (webIsSkillNodeType(type)) webValidateSkillFile(node, state, currentPath, id || undefined);

  if (type === 'orpad.graph') {
    const config = webNodeConfig(node);
    const embeddedGraph = node.graph || config.graph || null;
    const ref = node.graphRef || config.graphRef || node.ref || config.ref || '';
    if (embeddedGraph && typeof embeddedGraph === 'object' && !Array.isArray(embeddedGraph)) {
      await webValidateGraphDocument({ kind: 'orpad.graph', version: '1.0', graph: embeddedGraph }, state, `${currentPath}.graph`);
    } else if (ref) {
      await webValidateReferencedGraph(ref, state, id || undefined);
    } else {
      state.diagnostics.push({ level: 'warning', code: 'ORPAD_GRAPH_REF_MISSING', message: 'Graph node should embed a graph or reference an .or-graph file.', nodeId: id || undefined, path: currentPath });
    }
  }
  if (webIsTreeNodeType(type)) await webValidateTreeNode(node, state, currentPath, id || undefined);
}

async function webValidateGraphDocument(graphDoc, state, refPath = 'graph') {
  const graph = webGraphObject(graphDoc);
  if (!graph) {
    state.diagnostics.push({ level: 'error', code: 'GRAPH_INVALID', message: 'Graph runbook must include a graph object.', ref: refPath });
    return;
  }
  state.graphCount += 1;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  if (!nodes.length) state.diagnostics.push({ level: 'error', code: 'GRAPH_NODES_MISSING', message: 'Graph must include at least one node.', ref: refPath });
  for (const [index, node] of nodes.entries()) await webWalkGraphNodeDeep(node, state, `${refPath}.nodes[${index}]`);
  webValidateGraphNodeRefs(nodes, graphDoc, state, refPath);
  const ids = new Set();
  nodes.forEach((node, index) => {
    const id = String(node?.id || '');
    if (!id) return;
    if (ids.has(id)) {
      state.diagnostics.push({
        level: 'error',
        code: 'GRAPH_NODE_ID_DUPLICATE',
        message: 'Graph node id must be unique within a graph.',
        nodeId: id,
        path: `${refPath}.nodes[${index}]`,
      });
    }
    ids.add(id);
  });
  (Array.isArray(graph.transitions) ? graph.transitions : []).forEach((transition, index) => {
    const transitionPath = `${refPath}.transitions[${index}]`;
    const from = String(transition?.from || '');
    const to = String(transition?.to || '');
    if (!from || !to) {
      state.diagnostics.push({ level: 'error', code: 'GRAPH_TRANSITION_ENDPOINT_MISSING', message: 'Graph transition must include from and to node ids.', path: transitionPath });
      return;
    }
    if (!ids.has(from)) state.diagnostics.push({ level: 'error', code: 'GRAPH_TRANSITION_FROM_UNKNOWN', message: 'Graph transition source must reference an existing node.', path: transitionPath, ref: from });
    if (!ids.has(to)) state.diagnostics.push({ level: 'error', code: 'GRAPH_TRANSITION_TO_UNKNOWN', message: 'Graph transition target must reference an existing node.', path: transitionPath, ref: to });
  });
}

async function webWalkNodeDeep(node, state) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    state.diagnostics.push({ level: 'error', code: 'NODE_INVALID', message: 'Runbook node must be an object.' });
    return;
  }
  const id = String(node.id || '');
  const type = String(node.type || '');
  if (!id) state.diagnostics.push({ level: 'error', code: 'NODE_ID_MISSING', message: 'Runbook node must have an id.' });
  if (!type) state.diagnostics.push({ level: 'error', code: 'NODE_TYPE_MISSING', message: 'Runbook node must have a type.' });
  else if (!webIsKnownNodeType(type)) {
    state.diagnostics.push({ level: 'error', code: 'NODE_TYPE_UNKNOWN', message: `Unknown runbook node type: ${type}.`, nodeId: id || undefined, nodeType: type });
  } else {
    state.nodeTypes.add(type);
    state.nodeCount += 1;
    state.renderOnlyNodeTypes.add(type);
  }
  if (webIsSkillNodeType(type)) webValidateSkillFile(node, state, '', id);
  if (webIsTreeNodeType(type)) await webValidateTreeNode(node, state, '', id);
  for (const child of Array.isArray(node.children) ? node.children : []) await webWalkNodeDeep(child, state);
}

async function webValidateRunbookFile(filePath, options = {}) {
  const result = await readFile(filePath);
  if (result?.error) {
    return {
      ok: false,
      canExecute: false,
      trustLevel: webNormalizeTrustLevel(options?.trustLevel, 'local-authored'),
      schemaVersion: '',
      treeCount: 0,
      nodeCount: 0,
      nodeTypes: [],
      executableNodeTypes: [],
      renderOnlyNodeTypes: [],
      diagnostics: [{ level: 'error', code: 'RUNBOOK_VALIDATE_FAILED', message: result.error }],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.content || '{}');
  } catch {
    return webValidateRunbookSource(result.content, options);
  }

  const baseDir = dirOf(filePath);
  const trustLevel = webTrustLevelFromDocument(parsed, options);
  const state = {
    diagnostics: [],
    nodeTypes: new Set(),
    renderOnlyNodeTypes: new Set(),
    graphCount: 0,
    treeCount: 0,
    nodeCount: 0,
    baseDir,
    pipelineDir: baseDir,
    allowedRoot: baseDir,
    pipelineSkills: new Map(),
    graphStack: [],
    visitedGraphs: new Set(),
    visitedTrees: new Set(),
  };

  if (parsed?.kind === 'orpad.pipeline' || parsed?.entryGraph) {
    const graphRefs = webCollectPipelineRefItems(parsed.graphs);
    const treeRefs = webCollectPipelineRefItems(parsed.trees);
    const skillRefs = webCollectPipelineRefItems(parsed.skills);
    const ruleRefs = webCollectPipelineRefItems(parsed.rules);
    const entryGraph = parsed.entryGraph || parsed.entry?.graph || parsed.graph?.file || graphRefs[0]?.file || '';
    if (!entryGraph) state.diagnostics.push({ level: 'error', code: 'PIPELINE_ENTRY_GRAPH_MISSING', message: 'Pipeline must include an entryGraph file reference.' });
    webValidatePipelineQueueProtocol(parsed, state.diagnostics);

    for (const item of [...graphRefs, ...treeRefs, ...ruleRefs]) {
      const refPath = webResolveRef(baseDir, item.file, baseDir);
      if (!refPath) state.diagnostics.push({ level: 'error', code: 'PIPELINE_REF_OUTSIDE_PIPELINE', message: 'Pipeline references must stay inside the pipeline directory.', id: item.id, ref: item.file });
      else if (!wsFileHandles.has(refPath)) state.diagnostics.push({ level: 'error', code: 'PIPELINE_REF_NOT_FOUND', message: 'Referenced pipeline file does not exist.', id: item.id, ref: item.file });
    }
    for (const item of skillRefs) {
      const skillPath = webResolveRef(baseDir, item.file, baseDir);
      if (!skillPath) state.diagnostics.push({ level: 'error', code: 'SKILL_REF_OUTSIDE_PIPELINE', message: 'skill reference must stay inside the pipeline directory.', id: item.id, ref: item.file });
      else {
        state.pipelineSkills.set(item.id, item.file);
        if (!wsFileHandles.has(skillPath)) state.diagnostics.push({ level: 'error', code: 'SKILL_REF_NOT_FOUND', message: 'Referenced skill file does not exist.', id: item.id, ref: item.file });
      }
    }

    const entryGraphPath = entryGraph ? webResolveRef(baseDir, entryGraph, baseDir) : '';
    if (entryGraph && !entryGraphPath) state.diagnostics.push({ level: 'error', code: 'PIPELINE_ENTRY_GRAPH_OUTSIDE_PIPELINE', message: 'Pipeline entryGraph must stay inside the pipeline directory.', ref: entryGraph });
    const graphDoc = entryGraphPath
      ? await webReadJsonRef(entryGraphPath, state.diagnostics, 'PIPELINE_ENTRY_GRAPH_NOT_FOUND', 'Pipeline entryGraph file does not exist.', { ref: entryGraph })
      : null;
    if (graphDoc) {
      const previousBaseDir = state.baseDir;
      state.baseDir = dirOf(entryGraphPath);
      if (entryGraphPath) {
        const entryGraphKey = entryGraphPath.toLowerCase();
        state.visitedGraphs.add(entryGraphKey);
        state.graphStack.push(entryGraphKey);
      }
      await webValidateGraphDocument(graphDoc, state, entryGraph);
      if (entryGraphPath) state.graphStack.pop();
      state.baseDir = previousBaseDir;
    }

    state.diagnostics.push({ level: 'warning', code: 'WEB_LIMITED_MODE', message: 'Web can review and validate pipelines, but local execution, terminal, PTY, and desktop MCP are desktop-only.' });
    return {
      ok: !state.diagnostics.some(item => item.level === 'error'),
      canExecute: false,
      trustLevel,
      schemaVersion: String(parsed.version || ''),
      format: 'or-pipeline',
      pipelineCount: 1,
      graphCount: state.graphCount || (entryGraph ? 1 : 0),
      treeCount: state.treeCount,
      nodeCount: state.nodeCount,
      nodeTypes: [...state.nodeTypes].sort(),
      executableNodeTypes: [],
      renderOnlyNodeTypes: [...state.renderOnlyNodeTypes].sort(),
      diagnostics: state.diagnostics,
    };
  }

  const graph = webGraphObject(parsed);
  if (graph) {
    await webValidateGraphDocument(parsed, state);
  } else {
    const trees = webTreeEntries(parsed);
    if (!trees.length) state.diagnostics.push({ level: 'error', code: 'TREES_MISSING', message: 'Runbook must include a root node or at least one tree.' });
    state.treeCount = trees.length;
    for (const tree of trees) await webWalkNodeDeep(tree.root, state);
  }

  state.diagnostics.push({ level: 'warning', code: 'WEB_LIMITED_MODE', message: 'Web can review and validate runbooks, but local execution, terminal, PTY, and desktop MCP are desktop-only.' });
  return {
    ok: !state.diagnostics.some(item => item.level === 'error'),
    canExecute: false,
    trustLevel,
    schemaVersion: String(parsed.version || ''),
    graphCount: state.graphCount,
    treeCount: state.treeCount,
    nodeCount: state.nodeCount,
    nodeTypes: [...state.nodeTypes].sort(),
    executableNodeTypes: [],
    renderOnlyNodeTypes: [...state.renderOnlyNodeTypes].sort(),
    diagnostics: state.diagnostics,
  };
}

async function createFile(filePath) {
  if (!workspaceDirHandle) return { error: 'No workspace' };
  const parent = dirOf(filePath);
  const name = baseOf(filePath);
  const parentHandle = parent === WORKSPACE_ROOT ? workspaceDirHandle : wsDirHandles.get(parent);
  if (!parentHandle) return { error: 'Parent directory not found' };
  try {
    const fh = await parentHandle.getFileHandle(name, { create: true });
    wsFileHandles.set(filePath, fh);
    return { success: true };
  } catch (err) {
    const msg = err?.message || String(err);
    window.alert('Failed to create file: ' + msg);
    return { error: msg };
  }
}

async function createFolder(folderPath) {
  if (!workspaceDirHandle) return { error: 'No workspace' };
  const parent = dirOf(folderPath);
  const name = baseOf(folderPath);
  const parentHandle = parent === WORKSPACE_ROOT ? workspaceDirHandle : wsDirHandles.get(parent);
  if (!parentHandle) return { error: 'Parent directory not found' };
  try {
    const dh = await parentHandle.getDirectoryHandle(name, { create: true });
    wsDirHandles.set(folderPath, dh);
    return { success: true };
  } catch (err) {
    const msg = err?.message || String(err);
    window.alert('Failed to create folder: ' + msg);
    return { error: msg };
  }
}

async function renameFile(oldPath, newPath) {
  if (!workspaceDirHandle) return { error: 'No workspace' };
  const fileHandle = wsFileHandles.get(oldPath);
  if (!fileHandle) return { error: 'File not found in workspace' };
  // FSA doesn't expose rename directly; copy-then-delete within the same parent.
  if (dirOf(oldPath) !== dirOf(newPath)) {
    const msg = 'Rename across folders is not supported in the browser.';
    window.alert(msg);
    return { error: msg };
  }
  const parent = dirOf(newPath);
  const parentHandle = parent === WORKSPACE_ROOT ? workspaceDirHandle : wsDirHandles.get(parent);
  if (!parentHandle) return { error: 'Parent directory not found' };
  const newName = baseOf(newPath);
  const oldName = baseOf(oldPath);
  try {
    const content = await readFileFromHandle(fileHandle);
    const newHandle = await parentHandle.getFileHandle(newName, { create: true });
    await saveViaHandle(newHandle, content);
    await parentHandle.removeEntry(oldName);
    wsFileHandles.delete(oldPath);
    wsFileHandles.set(newPath, newHandle);
    return { success: true };
  } catch (err) {
    const msg = err?.message || String(err);
    window.alert('Failed to rename: ' + msg);
    return { error: msg };
  }
}

async function deleteFile(filePath) {
  if (!workspaceDirHandle) return { error: 'No workspace' };
  const parent = dirOf(filePath);
  const name = baseOf(filePath);
  const parentHandle = parent === WORKSPACE_ROOT ? workspaceDirHandle : wsDirHandles.get(parent);
  if (!parentHandle) return { error: 'Parent directory not found' };
  // Confirm since FSA delete is permanent (no Trash on web).
  if (!window.confirm(`Permanently delete "${name}"?\n\n(Browsers do not support Trash — this cannot be undone.)`)) {
    return { error: 'Canceled' };
  }
  try {
    await parentHandle.removeEntry(name, { recursive: true });
    wsFileHandles.delete(filePath);
    wsDirHandles.delete(filePath);
    return { success: true };
  } catch (err) {
    const msg = err?.message || String(err);
    window.alert('Failed to delete: ' + msg);
    return { error: msg };
  }
}

// ==================== Close flow ====================
function webShowSaveDialog() {
  const save = window.confirm('You have unsaved changes.\n\nOK = Save\nCancel = choose Discard or keep editing');
  if (save) return 'save';
  const discard = window.confirm('Discard unsaved changes?\n\nOK = Discard\nCancel = keep editing');
  return discard ? 'discard' : 'cancel';
}

// ==================== SVG → PNG ====================
function svgToPngBrowser(svgString, w, h, bg) {
  const width = Math.min(Math.max(parseInt(w, 10) || 1200, 100), 8192);
  const height = Math.min(Math.max(parseInt(h, 10) || 800, 100), 8192);
  const bgColor = (typeof bg === 'string' && bg.trim()) || '#ffffff';
  return new Promise((resolve) => {
    const img = new Image();
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((pngBlob) => {
          URL.revokeObjectURL(url);
          if (!pngBlob) return resolve(false);
          downloadBlob('diagram.png', pngBlob);
          resolve(true);
        }, 'image/png');
      } catch (err) {
        URL.revokeObjectURL(url);
        resolve(false);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(false); };
    img.src = url;
  });
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ==================== Adapter object ====================
const adapter = {
  platform: 'web',
  fsaDirSupported: FSA_DIR_SUPPORTED,

  onLoadMarkdown(cb) { loadFileCb = cb; },
  setUrlConfirmHandler(cb) { urlConfirmCb = cb; },
  setUrlErrorHandler(cb) { urlErrorCb = cb; },
  openUrl: openUrlSource,
  openUrlFromParams,
  async fetchUrlText(raw, options = {}) {
    const url = parseUrl(raw);
    const { content, finalUrl } = await fetchUrlTextContent(url, options);
    return { content, url: finalUrl.href };
  },
  openTextFromUrl: fireLoadText,
  showUrlError(err) {
    const message = err?.message || String(err);
    if (err?.name === 'AbortError') return;
    if (urlErrorCb) { urlErrorCb(err); return; }
    window.alert(message);
  },
  openFileDialog() { pickAndOpen(); },
  openFileHandles,
  getPathForFile(file) { return file; },
  dropFile(fileOrPath) {
    if (fileOrPath && typeof fileOrPath.text === 'function') fireLoad(fileOrPath, null);
  },

  readFile,
  saveFile,
  saveFileAs,

  setTitle(title) { document.title = title; },

  getLocale() {
    const raw = navigator.language || 'en';
    const direct = raw.toLowerCase();
    const short = direct.split('-')[0];
    const known = ['en','ko','zh','zh-tw','ja','es','fr','de','pt','ru','ar','hi','it','nl','pl','tr','vi','th','sv','da','fi','nb','cs','el','hu','ro','uk','id','ms','he'];
    let code = 'en';
    for (const c of [direct, short]) {
      const match = known.find((k) => k === c);
      if (match) { code = match === 'zh-tw' ? 'zh-TW' : match; break; }
    }
    return Promise.resolve({ code, mtime: 0 });
  },
  setLocale() {},

  getSystemTheme() {
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return Promise.resolve(dark ? 'dark' : 'light');
  },

  onCheckBeforeClose() {},
  showSaveDialog() { return Promise.resolve(webShowSaveDialog()); },
  confirmClose() {},

  autoSaveRecovery() { return Promise.resolve(); },
  clearRecovery() { return Promise.resolve(); },

  saveImage(_filePath, buffer, ext) {
    const mime = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
    return Promise.resolve(`data:${mime};base64,${bytesToBase64(buffer)}`);
  },
  saveText(name, text) { downloadBlob(name, new Blob([text], { type: 'text/plain;charset=utf-8' })); return Promise.resolve(name); },
  saveBinary(name, buffer) { downloadBlob(name, new Blob([buffer])); return Promise.resolve(name); },
  svgToPng(svg, w, h, bg) { return svgToPngBrowser(svg, w, h, bg); },

  // Workspace
  openFolderDialog,
  readDirectory,
  gitFs: {
    readFile: gitFsReadFile,
    writeFile: gitFsWriteFile,
    unlink: gitFsUnlink,
    readdir: gitFsReaddir,
    mkdir: gitFsMkdir,
    rmdir: gitFsRmdir,
    stat: gitFsStat,
    lstat: gitFsStat,
  },
  watchDirectory() { return Promise.resolve(); },
  unwatchDirectory() { return Promise.resolve(); },
  onDirectoryChanged() { /* no file watcher on web; Refresh button re-reads */ },
  createFile,
  createFolder,
  renameFile,
  deleteFile,
  searchFiles,
  buildLinkIndex,
  resolveWikiLink,
  getBacklinks,
  getFileNames,
  runbooks: {
    validateText(source, options) {
      return Promise.resolve(webValidateRunbookSource(source, options));
    },
    async validateFile(filePath, options) {
      return webValidateRunbookFile(filePath, options);
    },
    scanWorkspace() {
      return scanRunbookWorkspaceWeb();
    },
    readWorkspaceIndex() {
      return Promise.resolve({ success: false, error: 'Workspace index cache is desktop-only in web limited mode.' });
    },
    createRunRecord() {
      return Promise.resolve({ error: 'Run records are desktop-only in web limited mode.' });
    },
    startLocalRun() {
      return Promise.resolve({ error: 'Local run execution is desktop-only in web limited mode.' });
    },
    readRunRecord() {
      return Promise.resolve({ error: 'Run replay records are desktop-only in web limited mode.' });
    },
  },
  pipelines: {
    validateText(source, options) {
      return Promise.resolve(webValidateRunbookSource(source, options));
    },
    async validateFile(filePath, options) {
      return adapter.runbooks.validateFile(filePath, options);
    },
    scanWorkspace() {
      return scanRunbookWorkspaceWeb();
    },
    readWorkspaceIndex() {
      return Promise.resolve({ success: false, error: 'Workspace index cache is desktop-only in web limited mode.' });
    },
    createRunRecord() {
      return Promise.resolve({ error: 'Run records are desktop-only in web limited mode.' });
    },
    startLocalRun() {
      return Promise.resolve({ error: 'Local run execution is desktop-only in web limited mode.' });
    },
    readRunRecord() {
      return Promise.resolve({ error: 'Run replay records are desktop-only in web limited mode.' });
    },
  },
  revealInExplorer() {
    window.alert('"Reveal in File Explorer" is not available in the browser.');
  },
  getAppInfo() { return Promise.resolve({ isPackaged: true, version: process.env.APP_VERSION || '' }); },
  openDefaultAppsSettings() { /* button is hidden on web */ },

  // Auto-updater — desktop-only
  onShowUpdateDialog() {},
  onUpdateProgress() {},
  onUpdateError() {},
  updateAction() {},
};

window.orpad = adapter;

// Any workspace path persisted from a prior desktop session on the same origin
// would be meaningless here (no FSA handle). Clear once.
try {
  if (localStorage.getItem('orpad-workspace-path')) {
    localStorage.removeItem('orpad-workspace-path');
  }
} catch {}

// beforeunload guard: renderer installs a dirty-state probe.
let dirtyProbe = null;
adapter.__setDirtyProbe = (fn) => { dirtyProbe = fn; };
window.addEventListener('beforeunload', (e) => {
  try {
    if (dirtyProbe && dirtyProbe()) {
      e.preventDefault();
      e.returnValue = '';
    }
  } catch {}
});

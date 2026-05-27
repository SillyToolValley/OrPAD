import { scoreFuzzy } from './palette.js';

const OWNER = 'quick-open';
const MAX_VISIBLE = 50;
const PREVIEW_LINES = 30;
const RECENT_KEY = 'orpad-quick-open-recent';

const FORMAT_ALIASES = {
  md: 'markdown',
  markdown: 'markdown',
  mmd: 'mermaid',
  mermaid: 'mermaid',
  json: 'json',
  jsonl: 'jsonl',
  ndjson: 'jsonl',
  yaml: 'yaml',
  yml: 'yaml',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  csv: 'csv',
  tsv: 'tsv',
  toml: 'toml',
  ini: 'ini',
  conf: 'ini',
  properties: 'properties',
  env: 'env',
  txt: 'plain',
  text: 'plain',
  log: 'plain',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  py: 'python',
  pyw: 'python',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  php: 'php',
  phtml: 'php',
  rb: 'ruby',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  dart: 'dart',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  sql: 'sql',
  lua: 'lua',
  r: 'r',
  pl: 'perl',
  pm: 'perl',
  vue: 'vue',
  svelte: 'svelte',
  proto: 'protobuf',
  diff: 'diff',
  patch: 'diff',
  svg: 'xml',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function baseName(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || String(filePath || '');
}

function extension(filePath) {
  const name = baseName(filePath).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
}

function kindOf(filePath) {
  return FORMAT_ALIASES[extension(filePath)] || 'plain';
}

function loadRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, 50) : [];
  } catch {
    return [];
  }
}

function pushRecent(filePath) {
  try {
    const next = [filePath, ...loadRecent().filter(item => item !== filePath)].slice(0, 50);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
}

function parseQuery(value) {
  let query = String(value || '').trim();
  let line = null;
  const lineMatch = query.match(/:(\d+)$/);
  if (lineMatch) {
    line = Math.max(1, parseInt(lineMatch[1], 10));
    query = query.slice(0, -lineMatch[0].length).trim();
  }

  const filters = [];
  query = query.replace(/(^|\s)@([a-z0-9.+_-]+)/gi, (_match, space, filter) => {
    filters.push(filter.toLowerCase());
    return space;
  }).trim();

  if (query.startsWith('#')) {
    return { mode: 'symbol', query: query.slice(1).trim(), line, filter: filters[0] || '' };
  }
  return { mode: 'file', query, line, filter: filters[0] || '' };
}

function normalizeFile(item) {
  if (typeof item === 'string') {
    return { filePath: item, relativePath: item, baseName: baseName(item), kind: kindOf(item) };
  }
  const filePath = item.filePath || item.path || item.relativePath || item.baseName || '';
  const relativePath = item.relativePath || item.path || filePath;
  return {
    ...item,
    filePath,
    relativePath,
    baseName: item.baseName || baseName(filePath),
    kind: item.kind || kindOf(filePath),
  };
}

function matchesFilter(file, filter) {
  if (!filter) return true;
  const normalized = FORMAT_ALIASES[filter] || filter;
  return file.kind === normalized || extension(file.filePath) === filter;
}

function scoreFile(file, query, recentRank) {
  const text = [file.relativePath, file.baseName, file.kind].filter(Boolean).join(' ');
  const fuzzy = scoreFuzzy(query, text);
  if (fuzzy.score === Number.NEGATIVE_INFINITY) return null;
  const recentBoost = recentRank >= 0 ? 18 - Math.min(recentRank, 17) : 0;
  const baseBoost = query && String(file.baseName || '').toLowerCase().startsWith(query.toLowerCase()) ? 18 : 0;
  return { type: 'file', file, line: null, score: fuzzy.score + recentBoost + baseBoost };
}

function symbolKindForLine(file, line) {
  if (file.kind === 'markdown') {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) return { name: heading[2], detail: `H${heading[1].length}` };
  }
  if (file.kind === 'json') {
    const key = line.match(/^\s*"([^"]+)"\s*:/);
    if (key) return { name: key[1], detail: 'json key' };
  }
  if (file.kind === 'yaml') {
    const key = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:/);
    if (key) return { name: key[1], detail: 'yaml key' };
  }
  if (file.kind === 'toml' || file.kind === 'ini' || file.kind === 'properties' || file.kind === 'env') {
    const key = line.match(/^\s*([A-Za-z0-9_.-]+)\s*(?:=|:|\])/) || line.match(/^\s*\[([^\]]+)\]/);
    if (key) return { name: key[1], detail: `${file.kind} symbol` };
  }
  return null;
}

function previewText(content, targetLine) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n').slice(0, PREVIEW_LINES);
  return lines.map((line, index) => {
    const number = String(index + 1).padStart(3, ' ');
    const marker = targetLine === index + 1 ? '>' : ' ';
    return `${marker} ${number} | ${line}`;
  }).join('\n');
}

function isTextInputTarget(target) {
  if (!target) return false;
  if (target.closest?.('.cm-editor')) return false;
  const tag = target.tagName;
  return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function createQuickOpen({ root, getFiles, readFile, openFile, getWorkspacePath, notify }) {
  const overlay = el('div', 'cmdk-overlay hidden');
  overlay.innerHTML = `
    <div class="cmdk-shell cmdk-shell-wide quick-open" role="dialog" aria-modal="true" aria-label="Quick Open">
      <div class="cmdk-topline">
        <span>Quick Open</span>
        <kbd>Ctrl P</kbd>
      </div>
      <input class="cmdk-input" type="text" spellcheck="false" autocomplete="off" placeholder="Search files, file.md:42, # heading, @json">
      <div class="quick-open-body">
        <div class="cmdk-results quick-open-results" role="listbox"></div>
        <div class="quick-open-preview"><div class="quick-open-preview-title">Preview</div><pre></pre></div>
      </div>
      <div class="cmdk-footer"><span>Enter to open</span><span># for symbols</span><span>@format filters</span></div>
    </div>
  `;
  root.appendChild(overlay);

  const input = overlay.querySelector('.cmdk-input');
  const resultsEl = overlay.querySelector('.cmdk-results');
  const previewTitleEl = overlay.querySelector('.quick-open-preview-title');
  const previewEl = overlay.querySelector('.quick-open-preview pre');

  let selected = 0;
  let matches = [];
  let files = [];
  let filesLoadedFor = '';
  let loadingFiles = false;
  let symbolIndex = null;
  let symbolPromise = null;
  let previewToken = 0;
  let lastFocus = null;

  function isOpen() {
    return !overlay.classList.contains('hidden');
  }

  function close() {
    if (!isOpen()) return;
    overlay.classList.add('hidden');
    matches = [];
    selected = 0;
    if (lastFocus && typeof lastFocus.focus === 'function' && document.contains(lastFocus)) {
      lastFocus.focus();
    }
  }

  async function ensureFiles() {
    const workspace = getWorkspacePath?.() || '';
    if (filesLoadedFor === workspace && files.length) return files;
    loadingFiles = true;
    render();
    try {
      const list = await getFiles();
      files = (list || []).map(normalizeFile).filter(item => item.filePath);
      filesLoadedFor = workspace;
      symbolIndex = null;
      symbolPromise = null;
      return files;
    } finally {
      loadingFiles = false;
      render();
    }
  }

  async function ensureSymbols() {
    if (symbolIndex) return symbolIndex;
    if (symbolPromise) return symbolPromise;
    symbolPromise = (async () => {
      const list = await ensureFiles();
      const symbols = [];
      await Promise.all(list.slice(0, 1000).map(async (file) => {
        if (!['markdown', 'json', 'yaml', 'toml', 'ini', 'properties', 'env'].includes(file.kind)) return;
        try {
          const result = await readFile(file.filePath);
          const content = result?.content ?? result ?? '';
          const lines = String(content).replace(/\r\n?/g, '\n').split('\n');
          let count = 0;
          for (let i = 0; i < lines.length && count < 80; i++) {
            const symbol = symbolKindForLine(file, lines[i]);
            if (!symbol) continue;
            symbols.push({ type: 'symbol', file, symbol, line: i + 1, score: 0 });
            count++;
          }
        } catch {}
      }));
      symbolIndex = symbols;
      return symbolIndex;
    })();
    return symbolPromise;
  }

  function buildFileMatches(parsed) {
    const recent = loadRecent();
    return files
      .filter(file => matchesFilter(file, parsed.filter))
      .map(file => scoreFile(file, parsed.query, recent.indexOf(file.filePath)))
      .filter(Boolean)
      .map(match => ({ ...match, line: parsed.line }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return String(a.file.relativePath || '').localeCompare(String(b.file.relativePath || ''));
      })
      .slice(0, MAX_VISIBLE);
  }

  function buildSymbolMatches(parsed) {
    const query = parsed.query;
    return (symbolIndex || [])
      .filter(item => matchesFilter(item.file, parsed.filter))
      .map(item => {
        const text = `${item.symbol.name} ${item.file.relativePath} ${item.symbol.detail}`;
        const fuzzy = scoreFuzzy(query, text);
        if (fuzzy.score === Number.NEGATIVE_INFINITY) return null;
        return { ...item, score: fuzzy.score + 12 };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return String(a.symbol.name || '').localeCompare(String(b.symbol.name || ''));
      })
      .slice(0, MAX_VISIBLE);
  }

  function render() {
    const parsed = parseQuery(input.value);
    resultsEl.innerHTML = '';
    if (loadingFiles) {
      resultsEl.appendChild(el('div', 'cmdk-empty', 'Indexing workspace files...'));
      previewTitleEl.textContent = 'Preview';
      previewEl.textContent = '';
      return;
    }
    if (parsed.mode === 'symbol' && !symbolIndex) {
      resultsEl.appendChild(el('div', 'cmdk-empty', 'Indexing symbols...'));
      ensureSymbols().then(render).catch(err => notify?.('Quick Open', err));
      previewTitleEl.textContent = 'Preview';
      previewEl.textContent = '';
      return;
    }

    matches = parsed.mode === 'symbol' ? buildSymbolMatches(parsed) : buildFileMatches(parsed);
    selected = Math.max(0, Math.min(selected, matches.length - 1));

    if (!matches.length) {
      const empty = loadingFiles ? 'Indexing workspace files...' : 'No matching files.';
      resultsEl.appendChild(el('div', 'cmdk-empty', empty));
      previewTitleEl.textContent = 'Preview';
      previewEl.textContent = filesLoadedFor ? '' : 'Open a folder first to search workspace files.';
      return;
    }

    matches.forEach((match, index) => {
      const item = el('button', 'cmdk-item quick-open-item');
      item.type = 'button';
      item.role = 'option';
      item.classList.toggle('selected', index === selected);
      item.setAttribute('aria-selected', String(index === selected));

      const main = el('span', 'cmdk-item-main');
      if (match.type === 'symbol') {
        main.appendChild(el('strong', '', match.symbol.name));
        main.appendChild(el('small', '', `${match.file.relativePath} : ${match.line} / ${match.symbol.detail}`));
      } else {
        main.appendChild(el('strong', '', match.file.baseName));
        main.appendChild(el('small', '', match.file.relativePath));
      }
      item.appendChild(main);
      item.appendChild(el('span', 'cmdk-pill', match.file.kind));
      item.addEventListener('mousemove', () => {
        selected = index;
        render();
      });
      item.addEventListener('click', () => accept(index));
      resultsEl.appendChild(item);
    });
    updatePreview();
  }

  async function updatePreview() {
    const match = matches[selected];
    const token = ++previewToken;
    if (!match) return;
    const targetLine = match.line || null;
    previewTitleEl.textContent = match.file.relativePath || match.file.filePath;
    previewEl.textContent = 'Loading preview...';
    try {
      const result = await readFile(match.file.filePath);
      if (token !== previewToken) return;
      previewEl.textContent = previewText(result?.content ?? result ?? '', targetLine);
    } catch (err) {
      if (token !== previewToken) return;
      previewEl.textContent = err?.message || String(err);
    }
  }

  async function accept(index = selected) {
    const match = matches[index];
    if (!match) return;
    const line = match.line || null;
    pushRecent(match.file.filePath);
    close();
    try {
      await openFile(match.file.filePath, {
        line,
        symbol: match.type === 'symbol' ? match.symbol.name : '',
      });
    } catch (err) {
      console.error('[quick-open] open failed', err);
      notify?.('Quick Open', err);
    }
  }

  function open(initialQuery = '') {
    window.dispatchEvent(new CustomEvent('orpad-overlay-open', { detail: { owner: OWNER } }));
    lastFocus = document.activeElement;
    overlay.classList.remove('hidden');
    input.value = initialQuery;
    selected = 0;
    render();
    ensureFiles().then(render).catch(err => notify?.('Quick Open', err));
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  input.addEventListener('input', () => {
    selected = 0;
    render();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selected = matches.length ? (selected + 1) % matches.length : 0;
      render();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      selected = matches.length ? (selected - 1 + matches.length) % matches.length : 0;
      render();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      accept();
    }
  });
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  window.addEventListener('orpad-overlay-open', (event) => {
    if (event.detail?.owner !== OWNER) close();
  });

  return {
    open,
    close,
    refresh() {
      filesLoadedFor = '';
      files = [];
      symbolIndex = null;
      symbolPromise = null;
      if (isOpen()) ensureFiles().then(render).catch(err => notify?.('Quick Open', err));
    },
    isOpen,
    shouldHandleShortcut(event) {
      if (!event.ctrlKey && !event.metaKey) return false;
      if (event.shiftKey || event.altKey) return false;
      if (event.key.toLowerCase() !== 'p') return false;
      return !isTextInputTarget(event.target) || event.target === input;
    },
  };
}

// Editable JSON tree viewer.
// - Click a leaf value to edit it inline (auto-infers number/bool/null from literal-shaped input; otherwise string)
// - Click an object key to rename (duplicates get auto-suffixed)
// - Hover a row to reveal + (add child) and trash (delete) buttons
// - On any change, serialize and call onChange
// - View-only mode for YAML/TOML/INI where round-tripping loses comments / formatting.

// Pagination for large containers — avoids creating 10k DOM nodes for a 10k-item array.
// Anything beyond this is hidden behind a "Show next N" button.
const PAGE_SIZE = 200;

export class JSONEditor {
  constructor(container, { content, onChange, parse, readOnly = false, toggleable = false }) {
    this.container = container;
    this.onChange = onChange || (() => {});
    this.readOnly = readOnly;
    this.initialReadOnly = readOnly;
    this.toggleable = toggleable;
    this.parseFn = parse || JSON.parse;

    try {
      this.data = this.parseFn(content);
      this.error = null;
    } catch (err) {
      this.error = err.message || String(err);
      this.data = null;
    }

    this.render();
  }

  destroy() {
    this.container.innerHTML = '';
    this.container.classList.remove('jedit-host');
  }

  serialize() {
    try { return JSON.stringify(this.data, null, 2); }
    catch { return ''; }
  }

  notify() { this.onChange(this.serialize()); }

  render() {
    // Edits / expand-toggles call render() to rebuild the whole tree, which
    // would otherwise reset the scroll position to 0 on every keystroke.
    // Grab the previous scroll offsets before wiping the container so we can
    // restore them once the new .jedit-scroll is in place.
    const prev = this.container.querySelector('.jedit-scroll');
    const savedTop = prev ? prev.scrollTop : 0;
    const savedLeft = prev ? prev.scrollLeft : 0;

    this.container.innerHTML = '';
    this.container.classList.add('jedit-host');

    this.renderToolbar();

    if (this.error != null) {
      const err = document.createElement('div');
      err.className = 'preview-error';
      err.textContent = this.error;
      this.container.appendChild(err);
      return;
    }

    const scroll = document.createElement('div');
    scroll.className = 'jedit-scroll';
    scroll.addEventListener('contextmenu', (event) => {
      const node = event.target.closest('.jedit-node');
      if (!node) return;
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('orpad-ai-open-actions', {
        detail: { format: 'json', scope: 'node', pointer: node.dataset.jpointer || '' },
      }));
    });

    const wrap = document.createElement('div');
    wrap.className = 'jedit-tree';
    if (this.readOnly) wrap.classList.add('read-only');

    const rootNode = this.buildNode({ value: this.data, parent: null, keyOrIndex: null, depth: 0 });
    wrap.appendChild(rootNode);
    scroll.appendChild(wrap);
    this.container.appendChild(scroll);

    // scrollTop clamps to max-scroll on assignment, but the container only has
    // a valid max after layout. Set synchronously (works because appendChild
    // above forces a reflow when we read scrollTop/scrollLeft) and fall back
    // to rAF in case the initial measurement is still 0.
    if (savedTop > 0 || savedLeft > 0) {
      scroll.scrollTop = savedTop;
      scroll.scrollLeft = savedLeft;
      if (scroll.scrollTop !== savedTop || scroll.scrollLeft !== savedLeft) {
        requestAnimationFrame(() => {
          scroll.scrollTop = savedTop;
          scroll.scrollLeft = savedLeft;
        });
      }
    }
  }

  renderToolbar() {
    const bar = document.createElement('div');
    bar.className = 'jedit-toolbar';

    const label = document.createElement('span');
    label.className = 'jedit-mode-label';
    if (this.toggleable) {
      label.textContent = this.readOnly ? 'View only' : 'Editing';
    } else if (this.initialReadOnly) {
      label.textContent = 'View only - edit source';
      label.classList.add('jedit-locked');
    } else {
      label.textContent = 'Editing';
    }
    bar.appendChild(label);

    const spacer = document.createElement('div');
    spacer.className = 'jedit-spacer';
    bar.appendChild(spacer);

    if (this.toggleable) {
      const toggle = document.createElement('div');
      toggle.className = 'jedit-seg';
      const viewBtn = document.createElement('button');
      viewBtn.className = 'jedit-seg-btn' + (this.readOnly ? ' active' : '');
      viewBtn.title = 'View only';
      viewBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg><span>View</span>';
      viewBtn.addEventListener('click', () => { if (!this.readOnly) { this.readOnly = true; this.render(); } });

      const editBtn = document.createElement('button');
      editBtn.className = 'jedit-seg-btn' + (!this.readOnly ? ' active' : '');
      editBtn.title = 'Edit';
      editBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg><span>Edit</span>';
      editBtn.addEventListener('click', () => { if (this.readOnly) { this.readOnly = false; this.render(); } });

      toggle.appendChild(viewBtn);
      toggle.appendChild(editBtn);
      bar.appendChild(toggle);
    }

    this.container.appendChild(bar);
  }

  getType(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  highlightPointers(pointers) {
    this.clearHighlights();
    const set = new Set(pointers);
    for (const el of this.container.querySelectorAll('[data-jpointer]')) {
      if (set.has(el.dataset.jpointer)) el.classList.add('jedit-highlight');
    }
    const first = this.container.querySelector('.jedit-highlight');
    if (first) first.scrollIntoView({ block: 'nearest' });
  }

  clearHighlights() {
    for (const el of this.container.querySelectorAll('.jedit-highlight')) {
      el.classList.remove('jedit-highlight');
    }
  }

  buildNode({ value, parent, keyOrIndex, depth, pointer = '' }) {
    const type = this.getType(value);
    const row = document.createElement('div');
    row.className = 'jedit-row';
    row.dataset.type = type;

    const container = document.createElement('div');
    container.className = 'jedit-node';
    container.dataset.jpointer = pointer;
    container.appendChild(row);

    const isRoot = parent === null;
    const parentType = parent ? this.getType(parent) : null;
    const keyLabel = this.buildKeyLabel({ parent, keyOrIndex });
    if (keyLabel) row.appendChild(keyLabel);

    if (type === 'object' || type === 'array') {
      const entries = type === 'array'
        ? value.map((v, i) => [i, v])
        : Object.entries(value);

      const toggle = document.createElement('button');
      toggle.className = 'jedit-toggle';
      const openChar = type === 'array' ? '[' : '{';
      const closeChar = type === 'array' ? ']' : '}';
      // Default to expanded
      if (!('jeditExpanded' in value)) {
        try { Object.defineProperty(value, 'jeditExpanded', { value: true, writable: true, enumerable: false, configurable: true }); }
        catch { /* primitives — can't happen here */ }
      }
      const isOpen = value.jeditExpanded !== false;
      toggle.textContent = isOpen ? '▼' : '▶';
      toggle.addEventListener('click', () => {
        value.jeditExpanded = !isOpen;
        this.render();
      });
      row.insertBefore(toggle, row.firstChild);

      const bracketOpen = document.createElement('span');
      bracketOpen.className = 'jedit-bracket';
      bracketOpen.textContent = openChar;
      row.appendChild(bracketOpen);

      const countSpan = document.createElement('span');
      countSpan.className = 'jedit-count';
      countSpan.textContent = ` ${entries.length} ${entries.length === 1 ? 'item' : 'items'} `;
      row.appendChild(countSpan);

      const bracketClose = document.createElement('span');
      bracketClose.className = 'jedit-bracket';
      bracketClose.textContent = closeChar;
      row.appendChild(bracketClose);

      if (!this.readOnly && !isRoot) row.appendChild(this.buildRowActions({ parent, keyOrIndex, value, type }));
      else if (!this.readOnly && isRoot) row.appendChild(this.buildRootAddAction({ value, type }));

      if (isOpen) {
        const childrenWrap = document.createElement('div');
        childrenWrap.className = 'jedit-children';

        // Pagination: keep a per-container "shown" counter on the object itself.
        // Default to PAGE_SIZE; user clicks "show next" to reveal more.
        const total = entries.length;
        let shown = Math.min(total, PAGE_SIZE);
        if ('jeditShown' in value && typeof value.jeditShown === 'number') {
          shown = Math.min(total, Math.max(PAGE_SIZE, value.jeditShown));
        } else {
          try { Object.defineProperty(value, 'jeditShown', { value: shown, writable: true, enumerable: false, configurable: true }); }
          catch {}
        }

        for (let i = 0; i < shown; i++) {
          const [k, v] = entries[i];
          const token = String(k).replace(/~/g, '~0').replace(/\//g, '~1');
          const child = this.buildNode({ value: v, parent: value, keyOrIndex: k, depth: depth + 1, pointer: pointer + '/' + token });
          childrenWrap.appendChild(child);
        }

        if (shown < total) {
          const more = document.createElement('button');
          more.className = 'jedit-show-more';
          const remaining = total - shown;
          const step = Math.min(PAGE_SIZE, remaining);
          more.textContent = `▾ Show next ${step} (${shown} / ${total} shown)`;
          more.addEventListener('click', () => {
            value.jeditShown = shown + step;
            this.render();
          });
          childrenWrap.appendChild(more);
        }

        if (!this.readOnly) {
          const addBtn = document.createElement('button');
          addBtn.className = 'jedit-add-inline';
          addBtn.textContent = type === 'array' ? '+ item' : '+ key';
          addBtn.addEventListener('click', () => this.addChild(value, type));
          childrenWrap.appendChild(addBtn);
        }
        container.appendChild(childrenWrap);
      }
    } else {
      const valEl = document.createElement('span');
      valEl.className = `jedit-value jedit-${type}`;
      valEl.tabIndex = 0;
      valEl.textContent = this.formatLeaf(value, type);
      if (!this.readOnly) {
        valEl.classList.add('editable');
        valEl.addEventListener('click', () => this.editLeaf(valEl, parent, keyOrIndex));
        valEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); this.editLeaf(valEl, parent, keyOrIndex); }
        });
      }
      row.appendChild(valEl);

      if (!this.readOnly && !isRoot) row.appendChild(this.buildRowActions({ parent, keyOrIndex, value, type }));
      else if (!this.readOnly && isRoot) {
        // root is a scalar — allow type-aware inline edit (no add/delete)
      }
    }

    return container;
  }

  buildKeyLabel({ parent, keyOrIndex }) {
    if (parent == null) return null;
    const span = document.createElement('span');
    const parentType = this.getType(parent);
    if (parentType === 'array') {
      span.className = 'jedit-index';
      span.textContent = keyOrIndex + ': ';
      return span;
    }
    span.className = 'jedit-key';
    const keyText = document.createElement('span');
    keyText.className = 'jedit-key-name';
    keyText.textContent = keyOrIndex;
    if (!this.readOnly) {
      keyText.title = 'Click to rename';
      keyText.addEventListener('click', (e) => { e.stopPropagation(); this.editKey(keyText, parent, keyOrIndex); });
    }
    span.appendChild(keyText);
    const colon = document.createElement('span');
    colon.className = 'jedit-colon';
    colon.textContent = ': ';
    span.appendChild(colon);
    return span;
  }

  buildRowActions({ parent, keyOrIndex, value, type }) {
    const actions = document.createElement('span');
    actions.className = 'jedit-actions';
    if (type === 'object' || type === 'array') {
      const addBtn = document.createElement('button');
      addBtn.className = 'jedit-act';
      addBtn.title = type === 'array' ? 'Add item' : 'Add key';
      addBtn.innerHTML = '＋';
      addBtn.addEventListener('click', (e) => { e.stopPropagation(); this.addChild(value, type); });
      actions.appendChild(addBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.className = 'jedit-act jedit-del';
    delBtn.title = 'Delete';
    delBtn.innerHTML = '🗑';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); this.deleteEntry(parent, keyOrIndex); });
    actions.appendChild(delBtn);
    return actions;
  }

  buildRootAddAction({ value, type }) {
    const actions = document.createElement('span');
    actions.className = 'jedit-actions';
    const addBtn = document.createElement('button');
    addBtn.className = 'jedit-act';
    addBtn.title = type === 'array' ? 'Add item' : 'Add key';
    addBtn.innerHTML = '＋';
    addBtn.addEventListener('click', (e) => { e.stopPropagation(); this.addChild(value, type); });
    actions.appendChild(addBtn);
    return actions;
  }

  formatLeaf(v, type) {
    if (type === 'string') return '"' + v + '"';
    if (type === 'null') return 'null';
    return String(v);
  }

  editLeaf(valEl, parent, keyOrIndex) {
    const current = parent[keyOrIndex];
    const type = this.getType(current);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'jedit-input';
    input.value = type === 'string' ? current : String(current);
    valEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
      const rawVal = input.value;
      const parsed = this.parseLiteral(rawVal);
      parent[keyOrIndex] = parsed;
      this.notify();
      this.render();
    };
    const cancel = () => { this.render(); };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', () => commit());
  }

  editKey(keyEl, parent, currentKey) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'jedit-input jedit-key-input';
    input.value = currentKey;
    keyEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
      const newKey = input.value.trim();
      if (!newKey || newKey === currentKey) { this.render(); return; }
      if (Object.prototype.hasOwnProperty.call(parent, newKey)) {
        // avoid collisions — find a free suffix
        let i = 2;
        let candidate = `${newKey}_${i}`;
        while (Object.prototype.hasOwnProperty.call(parent, candidate)) { i++; candidate = `${newKey}_${i}`; }
        const renamed = {};
        for (const k of Object.keys(parent)) {
          if (k === currentKey) renamed[candidate] = parent[currentKey];
          else renamed[k] = parent[k];
        }
        for (const k of Object.keys(parent)) delete parent[k];
        for (const k of Object.keys(renamed)) parent[k] = renamed[k];
      } else {
        const renamed = {};
        for (const k of Object.keys(parent)) {
          if (k === currentKey) renamed[newKey] = parent[currentKey];
          else renamed[k] = parent[k];
        }
        for (const k of Object.keys(parent)) delete parent[k];
        for (const k of Object.keys(renamed)) parent[k] = renamed[k];
      }
      this.notify();
      this.render();
    };
    const cancel = () => { this.render(); };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', () => commit());
  }

  parseLiteral(raw) {
    const trimmed = raw.trim();
    if (trimmed === 'null') return null;
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (/^-?\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return n;
    }
    if (/^-?\d*\.\d+$/.test(trimmed) || /^-?\d+\.\d*$/.test(trimmed) || /^-?\d+(\.\d+)?e[+-]?\d+$/i.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return n;
    }
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
      try { const parsed = JSON.parse(trimmed); if (typeof parsed === 'string') return parsed; } catch {}
    }
    if (trimmed === '{}') return {};
    if (trimmed === '[]') return [];
    return raw;
  }

  addChild(container, type) {
    if (type === 'array') {
      container.push('');
    } else {
      let base = 'key', i = 1;
      let name = base;
      while (Object.prototype.hasOwnProperty.call(container, name)) { i++; name = `${base}${i}`; }
      container[name] = '';
    }
    this.notify();
    this.render();
  }

  deleteEntry(parent, keyOrIndex) {
    const parentType = this.getType(parent);
    if (parentType === 'array') {
      parent.splice(keyOrIndex, 1);
    } else {
      delete parent[keyOrIndex];
    }
    this.notify();
    this.render();
  }

  updateContent(content) {
    try {
      this.data = this.parseFn(content);
      this.error = null;
    } catch (err) {
      this.error = err.message || String(err);
      this.data = null;
    }
    this.render();
  }
}

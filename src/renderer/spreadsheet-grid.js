import Papa from 'papaparse';

const COL_LETTERS = (() => {
  const out = [];
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
})();

function colLetter(n) {
  let s = '';
  n = n + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const DEFAULT_COL_WIDTH = 120;
const MIN_COL_WIDTH = 40;
const ROWNUM_WIDTH = 48;
// Above this many visible rows, virtualize: render only a window around the viewport
// and pad with spacer rows so the scrollbar geometry stays correct.
const VIRT_THRESHOLD = 500;
const VIRT_BUFFER_ROWS = 20;
const FALLBACK_ROW_HEIGHT = 24;

export class SpreadsheetGrid {
  constructor(container, { content, delimiter, onChange, readOnly = false }) {
    this.container = container;
    this.delimiter = delimiter;
    this.onChange = onChange || (() => {});
    this.readOnly = readOnly;
    this.headers = [];
    this.data = [];
    this.colWidths = [];
    this.active = { row: 0, col: 0 };
    this.sel = { r1: 0, c1: 0, r2: 0, c2: 0 };
    this.editing = null;
    this.editorInput = null;
    this.editorOriginalValue = '';
    this.dragAnchor = null;
    this.resizing = null;
    this.sort = null;
    this.filters = {};
    this.filterPopupEl = null;
    this.filterPopupCol = null;
    this.destroyed = false;
    this.suppressNextScrollRestore = false;
    // Virtualization state
    this.virtEnabled = false;
    this.virtVisibleRows = null; // cached result of getVisibleRowIndices while virt active
    this.virtStart = 0;
    this.virtEnd = 0;
    this.measuredRowHeight = 0;

    this.parse(content);
    this.build();
    this.attachEvents();
    this.render();
    this.applyReadOnlyClass();
  }

  setReadOnly(ro) {
    if (ro === this.readOnly) return;
    this.readOnly = ro;
    // Reset transient UI state that doesn't make sense to carry across modes.
    this.cancelEdit();
    this.dragAnchor = null;
    this.resizing = null;
    this.hideContextMenu();
    this.hideFilterPopup();
    this.applyReadOnlyClass();
    this.updateModeToggle();
  }

  applyReadOnlyClass() {
    if (!this.rootEl) return;
    this.rootEl.classList.toggle('read-only', this.readOnly);
  }

  parse(content) {
    const parsed = Papa.parse(content || '', { delimiter: this.delimiter, skipEmptyLines: false });
    const rows = parsed.data.filter(r => !(r.length === 1 && r[0] === ''));
    if (rows.length === 0) {
      this.headers = ['A'];
      this.data = [['']];
    } else {
      this.headers = rows[0].map((h, i) => h || colLetter(i));
      this.data = rows.slice(1);
      if (this.data.length === 0) this.data = [Array(this.headers.length).fill('')];
      for (const row of this.data) while (row.length < this.headers.length) row.push('');
    }
    this.colWidths = this.headers.map(() => DEFAULT_COL_WIDTH);
  }

  serialize() {
    const rows = [this.headers.slice(), ...this.data.map(r => r.slice())];
    return Papa.unparse(rows, { delimiter: this.delimiter });
  }

  notify() { this.onChange(this.serialize()); }

  build() {
    this.container.innerHTML = '';
    this.container.classList.add('sgrid-host');

    const root = document.createElement('div');
    root.className = 'sgrid';
    root.tabIndex = 0;

    const toolbar = document.createElement('div');
    toolbar.className = 'sgrid-toolbar';
    const eyeIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    const pencilIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    toolbar.innerHTML = `
      <span class="sgrid-cellref" title="Active cell">A1</span>
      <div class="sgrid-tbar-sep"></div>
      <button class="sgrid-tbar-btn" data-act="row-above" title="Insert row above">+Row↑</button>
      <button class="sgrid-tbar-btn" data-act="row-below" title="Insert row below">+Row↓</button>
      <button class="sgrid-tbar-btn" data-act="col-left" title="Insert column left">+Col←</button>
      <button class="sgrid-tbar-btn" data-act="col-right" title="Insert column right">+Col→</button>
      <div class="sgrid-tbar-sep"></div>
      <button class="sgrid-tbar-btn" data-act="del-row" title="Delete row">−Row</button>
      <button class="sgrid-tbar-btn" data-act="del-col" title="Delete column">−Col</button>
      <div class="sgrid-tbar-sep"></div>
      <span class="sgrid-stats"></span>
      <div class="sgrid-spacer"></div>
      <div class="sgrid-seg">
        <button class="sgrid-seg-btn" data-mode="view" title="View only">${eyeIcon}<span>View</span></button>
        <button class="sgrid-seg-btn" data-mode="edit" title="Edit">${pencilIcon}<span>Edit</span></button>
      </div>
    `;
    root.appendChild(toolbar);

    const scroll = document.createElement('div');
    scroll.className = 'sgrid-scroll';
    const table = document.createElement('table');
    table.className = 'sgrid-table';
    const colgroup = document.createElement('colgroup');
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    table.appendChild(colgroup);
    table.appendChild(thead);
    table.appendChild(tbody);
    scroll.appendChild(table);
    root.appendChild(scroll);

    const contextMenu = document.createElement('div');
    contextMenu.className = 'sgrid-ctxmenu hidden';
    root.appendChild(contextMenu);

    this.container.appendChild(root);

    this.rootEl = root;
    this.toolbarEl = toolbar;
    this.scrollEl = scroll;
    this.tableEl = table;
    this.colgroupEl = colgroup;
    this.theadEl = thead;
    this.tbodyEl = tbody;
    this.ctxMenuEl = contextMenu;
    this.cellRefEl = toolbar.querySelector('.sgrid-cellref');
    this.statsEl = toolbar.querySelector('.sgrid-stats');
    this.segEl = toolbar.querySelector('.sgrid-seg');
    this.updateModeToggle();
  }

  updateModeToggle() {
    if (!this.segEl) return;
    for (const b of this.segEl.querySelectorAll('.sgrid-seg-btn')) {
      const isActive = (b.dataset.mode === 'view') === this.readOnly;
      b.classList.toggle('active', isActive);
    }
  }

  attachEvents() {
    const root = this.rootEl;

    this.toolbarEl.addEventListener('click', (e) => {
      const seg = e.target.closest('.sgrid-seg-btn');
      if (seg) {
        this.setReadOnly(seg.dataset.mode === 'view');
        root.focus();
        return;
      }
      const btn = e.target.closest('.sgrid-tbar-btn');
      if (!btn) return;
      this.runAction(btn.dataset.act);
      root.focus();
    });

    this.tbodyEl.addEventListener('mousedown', (e) => this.onTbodyMouseDown(e));
    this.theadEl.addEventListener('mousedown', (e) => this.onTheadMouseDown(e));
    this.tbodyEl.addEventListener('dblclick', (e) => this.onTbodyDblClick(e));

    this.onMouseMove = (e) => this.handleDrag(e);
    this.onMouseUp = (e) => this.handleDragEnd(e);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mouseup', this.onMouseUp);

    this.onKey = (e) => this.onKeyDown(e);
    root.addEventListener('keydown', this.onKey);

    this.onCtxMenu = (e) => this.onContextMenu(e);
    root.addEventListener('contextmenu', this.onCtxMenu);

    this.onDocClick = (e) => {
      if (!this.ctxMenuEl.contains(e.target)) this.hideContextMenu();
      if (this.filterPopupEl
          && !this.filterPopupEl.contains(e.target)
          && !e.target.closest('.sgrid-filter-btn')) {
        this.hideFilterPopup();
      }
    };
    document.addEventListener('mousedown', this.onDocClick, true);

    this.onCopy = (e) => this.handleCopy(e);
    this.onPaste = (e) => this.handlePaste(e);
    this.onCut = (e) => this.handleCut(e);
    root.addEventListener('copy', this.onCopy);
    root.addEventListener('paste', this.onPaste);
    root.addEventListener('cut', this.onCut);

    root.addEventListener('focus', () => { this.rootEl.classList.add('focused'); });
    root.addEventListener('blur', () => { this.rootEl.classList.remove('focused'); });

    this.onScroll = () => this.handleScroll();
    this.scrollEl.addEventListener('scroll', this.onScroll, { passive: true });
  }

  destroy() {
    this.destroyed = true;
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('mousedown', this.onDocClick, true);
    if (this.scrollEl && this.onScroll) this.scrollEl.removeEventListener('scroll', this.onScroll);
    this.cancelEdit();
    this.container.innerHTML = '';
    this.container.classList.remove('sgrid-host');
  }

  render() {
    const scrollTop = this.scrollEl.scrollTop;
    const scrollLeft = this.scrollEl.scrollLeft;

    this.colgroupEl.innerHTML = '';
    const rownumCol = document.createElement('col');
    rownumCol.style.width = ROWNUM_WIDTH + 'px';
    this.colgroupEl.appendChild(rownumCol);
    for (let c = 0; c < this.headers.length; c++) {
      const col = document.createElement('col');
      col.style.width = (this.colWidths[c] || DEFAULT_COL_WIDTH) + 'px';
      this.colgroupEl.appendChild(col);
    }

    this.theadEl.innerHTML = '';
    const letterRow = document.createElement('tr');
    letterRow.className = 'sgrid-letter-row';
    const cornerTh = document.createElement('th');
    cornerTh.className = 'sgrid-corner';
    cornerTh.innerHTML = '<span class="sgrid-corner-inner" title="Select all">⦾</span>';
    cornerTh.addEventListener('click', () => this.selectAll());
    letterRow.appendChild(cornerTh);
    for (let c = 0; c < this.headers.length; c++) {
      const th = document.createElement('th');
      th.className = 'sgrid-colletter';
      th.dataset.col = c;
      th.innerHTML = `<span class="sgrid-letter">${colLetter(c)}</span><span class="sgrid-resizer" data-col="${c}"></span>`;
      letterRow.appendChild(th);
    }
    this.theadEl.appendChild(letterRow);

    const fieldRow = document.createElement('tr');
    fieldRow.className = 'sgrid-field-row';
    const fieldCorner = document.createElement('th');
    fieldCorner.className = 'sgrid-corner sgrid-corner-field';
    fieldRow.appendChild(fieldCorner);
    const filterIcon = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M1.5 2.5A.5.5 0 0 1 2 2h12a.5.5 0 0 1 .4.8l-4.9 6.4V13.5a.5.5 0 0 1-.75.43l-3-1.75A.5.5 0 0 1 5.5 11.75V9.2L.6 2.8A.5.5 0 0 1 1.5 2.5Z"/></svg>';
    for (let c = 0; c < this.headers.length; c++) {
      const th = document.createElement('th');
      th.className = 'sgrid-field';
      th.dataset.col = c;
      const sortDir = this.sort && this.sort.col === c ? this.sort.dir : null;
      const arrow = sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : '';
      const filterActive = this.hasActiveFilter(c);
      th.innerHTML = `<span class="sgrid-field-name">${escapeHtml(this.headers[c])}</span><span class="sgrid-sort-arrow">${arrow}</span><button class="sgrid-filter-btn${filterActive ? ' active' : ''}" data-col="${c}" tabindex="-1" title="Filter">${filterIcon}</button>`;
      fieldRow.appendChild(th);
    }
    this.theadEl.appendChild(fieldRow);

    this.tbodyEl.innerHTML = '';
    const visibleRows = this.getVisibleRowIndices();

    if (visibleRows.length > VIRT_THRESHOLD) {
      // Virtualized path: only render rows within scroll window + buffer.
      // Render window first (using the saved scrollTop, not live — tbody is empty) so
      // that the spacer rows establish the scroll height BEFORE we restore scrollTop.
      this.virtEnabled = true;
      this.virtVisibleRows = visibleRows;
      this.renderVirtWindow(scrollTop);
      if (!this.suppressNextScrollRestore) {
        this.scrollEl.scrollTop = scrollTop;
        this.scrollEl.scrollLeft = scrollLeft;
      }
      this.suppressNextScrollRestore = false;
    } else {
      this.virtEnabled = false;
      this.virtVisibleRows = null;
      for (const r of visibleRows) this.tbodyEl.appendChild(this.buildRow(r));
      if (!this.suppressNextScrollRestore) {
        this.scrollEl.scrollTop = scrollTop;
        this.scrollEl.scrollLeft = scrollLeft;
      }
      this.suppressNextScrollRestore = false;
    }

    this.applySelectionStyle();
    this.updateCellRef();
    this.updateStats();
  }

  buildRow(r) {
    const tr = document.createElement('tr');
    tr.dataset.row = r;
    const rnum = document.createElement('th');
    rnum.className = 'sgrid-rownum';
    rnum.dataset.row = r;
    rnum.textContent = r + 1;
    tr.appendChild(rnum);
    for (let c = 0; c < this.headers.length; c++) {
      const td = document.createElement('td');
      td.className = 'sgrid-cell';
      td.dataset.row = r;
      td.dataset.col = c;
      td.textContent = this.data[r][c] ?? '';
      tr.appendChild(td);
    }
    return tr;
  }

  measureRowHeight() {
    // Use an existing rendered data row if available; otherwise fall back.
    const sample = this.tbodyEl.querySelector('tr:not(.sgrid-spacer)');
    if (sample) {
      const h = sample.getBoundingClientRect().height;
      if (h > 0) { this.measuredRowHeight = h; return h; }
    }
    return this.measuredRowHeight || FALLBACK_ROW_HEIGHT;
  }

  computeVirtWindow(scrollTopOverride) {
    const rows = this.virtVisibleRows || [];
    const rowH = this.measuredRowHeight || FALLBACK_ROW_HEIGHT;
    const viewportH = this.scrollEl.clientHeight;
    const scrollTop = scrollTopOverride != null ? scrollTopOverride : this.scrollEl.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / rowH) - VIRT_BUFFER_ROWS);
    const end = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / rowH) + VIRT_BUFFER_ROWS);
    return { start, end };
  }

  renderVirtWindow(scrollTopOverride) {
    const rows = this.virtVisibleRows || [];
    const rowH = this.measuredRowHeight || FALLBACK_ROW_HEIGHT;
    const { start, end } = this.computeVirtWindow(scrollTopOverride);
    this.virtStart = start;
    this.virtEnd = end;

    this.tbodyEl.innerHTML = '';
    const nCols = this.headers.length + 1;

    if (start > 0) {
      const sp = document.createElement('tr');
      sp.className = 'sgrid-spacer';
      sp.style.height = (start * rowH) + 'px';
      const td = document.createElement('td');
      td.colSpan = nCols;
      td.style.padding = '0';
      td.style.border = 'none';
      sp.appendChild(td);
      this.tbodyEl.appendChild(sp);
    }
    for (let i = start; i < end; i++) {
      this.tbodyEl.appendChild(this.buildRow(rows[i]));
    }
    const tail = rows.length - end;
    if (tail > 0) {
      const sp = document.createElement('tr');
      sp.className = 'sgrid-spacer';
      sp.style.height = (tail * rowH) + 'px';
      const td = document.createElement('td');
      td.colSpan = nCols;
      td.style.padding = '0';
      td.style.border = 'none';
      sp.appendChild(td);
      this.tbodyEl.appendChild(sp);
    }

    // Measure after first real row render so subsequent windows use accurate height.
    // If the measurement disagrees with what we just used (e.g., zoom changed), do one
    // corrective re-render with the correct height so the spacer totals are accurate.
    if (end > start) {
      const usedH = rowH;
      const actualH = this.measureRowHeight();
      if (Math.abs(actualH - usedH) >= 1 && this.measuredRowHeight !== usedH) {
        this.renderVirtWindow(scrollTopOverride);
      }
    }
  }

  handleScroll() {
    if (!this.virtEnabled) return;
    const { start, end } = this.computeVirtWindow();
    // Only re-render if the window has shifted meaningfully — cheap guard against jitter.
    if (Math.abs(start - this.virtStart) < 5 && Math.abs(end - this.virtEnd) < 5) return;
    this.renderVirtWindow();
    this.applySelectionStyle();
  }

  // Ensure the row at index r (document row number) is present in the rendered DOM.
  // Returns true if the row is now queryable.
  ensureRowRendered(r) {
    if (!this.virtEnabled) return true;
    const rows = this.virtVisibleRows || [];
    const idx = rows.indexOf(r);
    if (idx === -1) return false; // row is filtered out
    if (idx >= this.virtStart && idx < this.virtEnd) return true;
    // Scroll the target row into view, then render the window for that scrollTop.
    const rowH = this.measuredRowHeight || FALLBACK_ROW_HEIGHT;
    const viewportH = this.scrollEl.clientHeight;
    const headerH = this.theadEl.getBoundingClientRect().height;
    const targetTop = idx * rowH;
    const curTop = this.scrollEl.scrollTop;
    if (targetTop < curTop) {
      this.scrollEl.scrollTop = Math.max(0, targetTop - headerH - 2);
    } else if (targetTop + rowH > curTop + viewportH) {
      this.scrollEl.scrollTop = targetTop - (viewportH - rowH) + headerH + 2;
    }
    this.renderVirtWindow();
    this.applySelectionStyle();
    return true;
  }

  // ===== Filters =====
  hasActiveFilter(col) { return Object.prototype.hasOwnProperty.call(this.filters, col); }

  passesFilters(rowIdx) {
    for (const col of Object.keys(this.filters)) {
      const val = String(this.data[rowIdx]?.[col] ?? '');
      if (!this.filters[col].allowed.has(val)) return false;
    }
    return true;
  }

  getVisibleRowIndices() {
    const cols = Object.keys(this.filters);
    if (cols.length === 0) return this.data.map((_, i) => i);
    const out = [];
    for (let i = 0; i < this.data.length; i++) if (this.passesFilters(i)) out.push(i);
    return out;
  }

  getColumnUniqueValues(col) {
    const set = new Set();
    for (const row of this.data) set.add(String(row[col] ?? ''));
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  }

  nextVisibleRow(from, dir) {
    const visible = this.getVisibleRowIndices();
    if (visible.length === 0) return from;
    const idx = visible.indexOf(from);
    if (idx === -1) {
      // from is hidden — jump to first visible in the movement direction
      if (dir >= 0) { for (const v of visible) if (v >= from) return v; return visible[visible.length - 1]; }
      let last = visible[0];
      for (const v of visible) { if (v <= from) last = v; else break; }
      return last;
    }
    const next = idx + dir;
    if (next < 0) return visible[0];
    if (next >= visible.length) return visible[visible.length - 1];
    return visible[next];
  }

  applySelectionStyle() {
    const { r1, c1, r2, c2 } = this.normSel();
    const isRange = r1 !== r2 || c1 !== c2;
    // First/last visible row *within* selection bounds — filter may hide r1 or r2.
    let firstSelRow = null, lastSelRow = null;
    for (const tr of this.tbodyEl.children) {
      const r = Number(tr.dataset.row);
      if (r >= r1 && r <= r2) {
        if (firstSelRow === null) firstSelRow = r;
        lastSelRow = r;
      }
    }
    for (const tr of this.tbodyEl.children) {
      const r = Number(tr.dataset.row);
      const rnum = tr.firstElementChild;
      rnum.classList.toggle('selected', r >= r1 && r <= r2);
      for (let i = 1; i < tr.children.length; i++) {
        const td = tr.children[i];
        const c = i - 1;
        const inSel = r >= r1 && r <= r2 && c >= c1 && c <= c2;
        const isActive = r === this.active.row && c === this.active.col;
        td.classList.toggle('in-selection', inSel);
        td.classList.toggle('sel-top', inSel && r === firstSelRow);
        td.classList.toggle('sel-bottom', inSel && r === lastSelRow);
        td.classList.toggle('sel-left', inSel && c === c1);
        td.classList.toggle('sel-right', inSel && c === c2);
        td.classList.toggle('active-cell', isActive);
        td.classList.toggle('active-in-range', isActive && isRange);
      }
    }
    const letterRow = this.theadEl.firstElementChild;
    const fieldRow = this.theadEl.children[1];
    for (let c = 0; c < this.headers.length; c++) {
      letterRow.children[c + 1].classList.toggle('selected', c >= c1 && c <= c2);
      fieldRow.children[c + 1].classList.toggle('selected', c >= c1 && c <= c2);
    }
  }

  normSel() {
    return {
      r1: Math.min(this.sel.r1, this.sel.r2),
      r2: Math.max(this.sel.r1, this.sel.r2),
      c1: Math.min(this.sel.c1, this.sel.c2),
      c2: Math.max(this.sel.c1, this.sel.c2),
    };
  }

  updateCellRef() {
    if (this.editing) {
      this.cellRefEl.textContent = `Edit ${colLetter(this.editing.col)}${this.editing.row + 1}`;
    } else {
      this.cellRefEl.textContent = `${colLetter(this.active.col)}${this.active.row + 1}`;
    }
  }

  updateStats() {
    const { r1, c1, r2, c2 } = this.normSel();
    const count = (r2 - r1 + 1) * (c2 - c1 + 1);
    const totalRows = this.data.length;
    const visibleCount = this.getVisibleRowIndices().length;
    const rowsLabel = visibleCount === totalRows ? `${totalRows} rows` : `${visibleCount} of ${totalRows} rows`;
    if (count <= 1) { this.statsEl.textContent = `${rowsLabel} × ${this.headers.length} cols`; return; }
    let sum = 0, num = 0;
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const v = parseFloat(String(this.data[r]?.[c] ?? '').trim());
        if (!isNaN(v)) { sum += v; num++; }
      }
    }
    const parts = [`${count} cells`];
    if (num > 0) { parts.push(`sum ${formatNum(sum)}`); parts.push(`avg ${formatNum(sum / num)}`); }
    this.statsEl.textContent = parts.join(' · ');
  }

  focusGrid() { this.rootEl.focus(); }

  scrollActiveIntoView() {
    const td = this.tbodyEl.querySelector(`td[data-row="${this.active.row}"][data-col="${this.active.col}"]`);
    if (!td) return;
    const wrap = this.scrollEl;
    const wr = wrap.getBoundingClientRect();
    const tr = td.getBoundingClientRect();
    const headerH = this.theadEl.getBoundingClientRect().height;
    if (tr.top < wr.top + headerH) wrap.scrollTop += tr.top - (wr.top + headerH) - 2;
    else if (tr.bottom > wr.bottom) wrap.scrollTop += tr.bottom - wr.bottom + 2;
    if (tr.left < wr.left + ROWNUM_WIDTH) wrap.scrollLeft += tr.left - (wr.left + ROWNUM_WIDTH) - 2;
    else if (tr.right > wr.right) wrap.scrollLeft += tr.right - wr.right + 2;
  }

  setActive(row, col, { extend = false } = {}) {
    row = Math.max(0, Math.min(this.data.length - 1, row));
    col = Math.max(0, Math.min(this.headers.length - 1, col));
    this.active = { row, col };
    if (extend) { this.sel.r2 = row; this.sel.c2 = col; }
    else { this.sel = { r1: row, c1: col, r2: row, c2: col }; }
    if (this.virtEnabled) this.ensureRowRendered(row);
    this.applySelectionStyle();
    this.updateCellRef();
    this.updateStats();
    this.scrollActiveIntoView();
  }

  selectAll() {
    this.sel = { r1: 0, c1: 0, r2: this.data.length - 1, c2: this.headers.length - 1 };
    this.active = { row: 0, col: 0 };
    this.applySelectionStyle();
    this.updateCellRef();
    this.updateStats();
    this.rootEl.focus();
  }

  // ===== Mouse =====
  onTbodyMouseDown(e) {
    if (e.target.classList.contains('sgrid-rownum')) {
      const r = Number(e.target.dataset.row);
      this.sel = { r1: r, c1: 0, r2: r, c2: this.headers.length - 1 };
      this.active = { row: r, col: 0 };
      if (e.shiftKey) this.sel.r1 = this.active.row;
      this.dragAnchor = { kind: 'row', row: r };
      this.applySelectionStyle();
      this.updateCellRef();
      this.updateStats();
      e.preventDefault();
      this.rootEl.focus();
      return;
    }
    const td = e.target.closest('td.sgrid-cell');
    if (!td) return;
    const r = Number(td.dataset.row), c = Number(td.dataset.col);
    if (this.editing && (this.editing.row !== r || this.editing.col !== c)) this.commitEdit();
    if (e.shiftKey) this.setActive(r, c, { extend: true });
    else { this.setActive(r, c); this.dragAnchor = { kind: 'cell', row: r, col: c }; }
    e.preventDefault();
    this.rootEl.focus();
  }

  onTheadMouseDown(e) {
    if (e.target.classList.contains('sgrid-resizer')) {
      const col = Number(e.target.dataset.col);
      const startX = e.clientX;
      const startW = this.colWidths[col] || DEFAULT_COL_WIDTH;
      this.resizing = { col, startX, startW };
      e.preventDefault();
      return;
    }
    const filterBtn = e.target.closest('.sgrid-filter-btn');
    if (filterBtn) {
      const c = Number(filterBtn.dataset.col);
      this.toggleFilterPopup(c, filterBtn);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const letterTh = e.target.closest('th.sgrid-colletter');
    if (letterTh) {
      const c = Number(letterTh.dataset.col);
      const visible = this.getVisibleRowIndices();
      const lastRow = visible.length ? visible[visible.length - 1] : 0;
      this.sel = { r1: visible[0] ?? 0, c1: c, r2: lastRow, c2: c };
      this.active = { row: visible[0] ?? 0, col: c };
      if (e.shiftKey) this.sel.c1 = this.active.col;
      this.dragAnchor = { kind: 'col', col: c };
      this.applySelectionStyle();
      this.updateCellRef();
      this.updateStats();
      e.preventDefault();
      this.rootEl.focus();
      return;
    }
    const fieldTh = e.target.closest('th.sgrid-field');
    if (fieldTh) {
      const c = Number(fieldTh.dataset.col);
      this.sortByColumn(c);
      e.preventDefault();
      this.rootEl.focus();
      return;
    }
  }

  handleDrag(e) {
    if (this.resizing) {
      const { col, startX, startW } = this.resizing;
      const nw = Math.max(MIN_COL_WIDTH, startW + (e.clientX - startX));
      this.colWidths[col] = nw;
      const colEl = this.colgroupEl.children[col + 1];
      if (colEl) colEl.style.width = nw + 'px';
      return;
    }
    if (!this.dragAnchor) return;
    const t = document.elementFromPoint(e.clientX, e.clientY);
    if (!t) return;
    if (this.dragAnchor.kind === 'cell') {
      const td = t.closest('td.sgrid-cell');
      if (!td) return;
      const r = Number(td.dataset.row), c = Number(td.dataset.col);
      if (r === this.sel.r2 && c === this.sel.c2) return;
      this.sel.r2 = r; this.sel.c2 = c;
      this.applySelectionStyle();
      this.updateStats();
    } else if (this.dragAnchor.kind === 'row') {
      const rnum = t.closest('th.sgrid-rownum') || t.closest('td.sgrid-cell');
      if (!rnum) return;
      const r = Number(rnum.dataset.row);
      this.sel.r2 = r;
      this.applySelectionStyle();
      this.updateStats();
    } else if (this.dragAnchor.kind === 'col') {
      const ch = t.closest('th.sgrid-colletter') || t.closest('td.sgrid-cell');
      if (!ch) return;
      const c = Number(ch.dataset.col);
      this.sel.c2 = c;
      this.applySelectionStyle();
      this.updateStats();
    }
  }

  handleDragEnd() {
    this.dragAnchor = null;
    this.resizing = null;
  }

  onTbodyDblClick(e) {
    if (this.readOnly) return;
    const td = e.target.closest('td.sgrid-cell');
    if (!td) return;
    const r = Number(td.dataset.row), c = Number(td.dataset.col);
    this.startEdit(r, c, { clear: false });
  }

  // ===== Keyboard =====
  onKeyDown(e) {
    if (this.editing) {
      // Editor input handles its own keys; this is a safety net
      if (e.key === 'Escape') { this.cancelEdit(); e.preventDefault(); }
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'a') { this.selectAll(); e.preventDefault(); return; }
      if (k === 'home') {
        const v = this.getVisibleRowIndices();
        if (v.length) this.setActive(v[0], 0);
        e.preventDefault(); return;
      }
      if (k === 'end') {
        const v = this.getVisibleRowIndices();
        if (v.length) this.setActive(v[v.length - 1], this.headers.length - 1);
        e.preventDefault(); return;
      }
      // Ctrl+C/V/X handled by browser's copy/paste/cut events
      return;
    }
    const { row, col } = this.active;
    const pageStep = (dir) => {
      let r = row;
      for (let i = 0; i < 10; i++) r = this.nextVisibleRow(r, dir);
      return r;
    };
    switch (e.key) {
      case 'ArrowUp': this.setActive(this.nextVisibleRow(row, -1), col, { extend: e.shiftKey }); e.preventDefault(); break;
      case 'ArrowDown': this.setActive(this.nextVisibleRow(row, 1), col, { extend: e.shiftKey }); e.preventDefault(); break;
      case 'ArrowLeft': this.setActive(row, col - 1, { extend: e.shiftKey }); e.preventDefault(); break;
      case 'ArrowRight': this.setActive(row, col + 1, { extend: e.shiftKey }); e.preventDefault(); break;
      case 'Tab':
        if (e.shiftKey) this.setActive(row, col - 1);
        else this.setActive(row, col + 1);
        e.preventDefault();
        break;
      case 'Enter':
        this.setActive(this.nextVisibleRow(row, e.shiftKey ? -1 : 1), col);
        e.preventDefault();
        break;
      case 'Home': this.setActive(row, 0, { extend: e.shiftKey }); e.preventDefault(); break;
      case 'End': this.setActive(row, this.headers.length - 1, { extend: e.shiftKey }); e.preventDefault(); break;
      case 'PageUp': this.setActive(pageStep(-1), col, { extend: e.shiftKey }); e.preventDefault(); break;
      case 'PageDown': this.setActive(pageStep(1), col, { extend: e.shiftKey }); e.preventDefault(); break;
      case 'F2': if (!this.readOnly) this.startEdit(row, col, { clear: false }); e.preventDefault(); break;
      case 'Delete': case 'Backspace': this.clearSelection(); e.preventDefault(); break;
      case 'Escape': break;
      default:
        if (e.key.length === 1 && !e.altKey && !this.readOnly) {
          this.startEdit(row, col, { clear: true, initialChar: e.key });
          e.preventDefault();
        }
    }
  }

  clearSelection() {
    if (this.readOnly) return;
    const { r1, r2, c1, c2 } = this.normSel();
    let changed = false;
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (this.data[r][c] !== '') { this.data[r][c] = ''; changed = true; }
      }
    }
    if (changed) { this.render(); this.notify(); }
  }

  // ===== Editing =====
  startEdit(row, col, { clear, initialChar } = {}) {
    if (this.readOnly) return;
    if (this.virtEnabled) this.ensureRowRendered(row);
    const td = this.tbodyEl.querySelector(`td[data-row="${row}"][data-col="${col}"]`);
    if (!td) return;
    this.setActive(row, col);
    this.editing = { row, col };
    const input = document.createElement('textarea');
    input.className = 'sgrid-editor';
    input.rows = 1;
    this.editorOriginalValue = String(this.data[row][col] ?? '');
    input.value = clear ? (initialChar || '') : this.editorOriginalValue;
    td.textContent = '';
    td.appendChild(input);
    this.editorInput = input;
    td.classList.add('editing');
    input.focus();
    if (clear && initialChar) {
      input.setSelectionRange(initialChar.length, initialChar.length);
    } else {
      input.setSelectionRange(input.value.length, input.value.length);
    }
    input.addEventListener('keydown', (e) => this.onEditorKey(e));
    input.addEventListener('blur', () => { if (this.editing) this.commitEdit(); });
    this.updateCellRef();
  }

  onEditorKey(e) {
    const { row, col } = this.editing || {};
    if (row == null) return;
    if (e.key === 'Escape') { this.cancelEdit(); e.preventDefault(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      this.commitEdit();
      this.setActive(row + 1, col);
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab') {
      this.commitEdit();
      this.setActive(row, col + (e.shiftKey ? -1 : 1));
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && e.altKey) {
      // allow newline
      return;
    }
  }

  commitEdit() {
    if (!this.editing || !this.editorInput) return;
    const { row, col } = this.editing;
    const newValue = this.editorInput.value;
    this.editing = null;
    const changed = this.data[row][col] !== newValue;
    if (changed) this.data[row][col] = newValue;
    this.editorInput = null;
    this.render();
    if (changed) this.notify();
    this.rootEl.focus();
  }

  cancelEdit() {
    if (!this.editing) return;
    this.editing = null;
    this.editorInput = null;
    this.render();
    this.rootEl.focus();
  }

  // ===== Clipboard =====
  handleCopy(e) {
    const text = this.getSelectionTSV();
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  }

  handleCut(e) {
    if (this.readOnly) { this.handleCopy(e); return; }
    this.handleCopy(e);
    this.clearSelection();
  }

  handlePaste(e) {
    if (this.readOnly) { e.preventDefault(); return; }
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const pasted = text.replace(/\r\n/g, '\n').split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === ''))
      .map(line => line.split('\t'));
    const { row, col } = this.active;
    let grew = false;
    for (let r = 0; r < pasted.length; r++) {
      const tr = row + r;
      while (tr >= this.data.length) { this.data.push(Array(this.headers.length).fill('')); grew = true; }
      for (let c = 0; c < pasted[r].length; c++) {
        const tc = col + c;
        while (tc >= this.headers.length) { this.addColumn(); grew = true; }
        this.data[tr][tc] = pasted[r][c];
      }
    }
    this.sel = { r1: row, c1: col, r2: row + pasted.length - 1, c2: col + (pasted[0]?.length || 1) - 1 };
    this.render();
    this.notify();
  }

  getSelectionTSV() {
    const { r1, r2, c1, c2 } = this.normSel();
    const lines = [];
    for (let r = r1; r <= r2; r++) {
      const row = [];
      for (let c = c1; c <= c2; c++) row.push(String(this.data[r]?.[c] ?? ''));
      lines.push(row.join('\t'));
    }
    return lines.join('\n');
  }

  // ===== Structural actions =====
  addColumn(atIndex) {
    const idx = atIndex == null ? this.headers.length : atIndex;
    let base = colLetter(idx);
    let name = base;
    let i = 2;
    while (this.headers.includes(name)) { name = `${base}${i++}`; }
    this.headers.splice(idx, 0, name);
    this.colWidths.splice(idx, 0, DEFAULT_COL_WIDTH);
    for (const row of this.data) row.splice(idx, 0, '');
  }

  removeColumn(idx) {
    if (this.headers.length <= 1) return;
    this.headers.splice(idx, 1);
    this.colWidths.splice(idx, 1);
    for (const row of this.data) row.splice(idx, 1);
  }

  addRow(atIndex) {
    const idx = atIndex == null ? this.data.length : atIndex;
    this.data.splice(idx, 0, Array(this.headers.length).fill(''));
  }

  removeRow(idx) {
    if (this.data.length <= 1) { this.data[0] = Array(this.headers.length).fill(''); return; }
    this.data.splice(idx, 1);
  }

  runAction(act) {
    if (this.readOnly) return;
    const { row, col } = this.active;
    switch (act) {
      case 'row-above': this.addRow(row); break;
      case 'row-below': this.addRow(row + 1); this.setActive(row + 1, col); break;
      case 'col-left': this.addColumn(col); break;
      case 'col-right': this.addColumn(col + 1); this.setActive(row, col + 1); break;
      case 'del-row': {
        const { r1, r2 } = this.normSel();
        for (let i = r2; i >= r1; i--) this.removeRow(i);
        this.setActive(Math.min(r1, this.data.length - 1), col);
        break;
      }
      case 'del-col': {
        const { c1, c2 } = this.normSel();
        for (let i = c2; i >= c1; i--) this.removeColumn(i);
        this.setActive(row, Math.min(c1, this.headers.length - 1));
        break;
      }
      case 'rename-col': {
        const curr = this.headers[col];
        const name = prompt('Column name', curr);
        if (name != null && name !== curr) this.headers[col] = name;
        break;
      }
      default: return;
    }
    this.render();
    this.notify();
  }

  sortByColumn(col) {
    if (this.readOnly) return;
    let dir = 'asc';
    if (this.sort && this.sort.col === col) {
      dir = this.sort.dir === 'asc' ? 'desc' : this.sort.dir === 'desc' ? null : 'asc';
    }
    if (dir == null) {
      this.sort = null;
      // no restore — user chose to sort, we leave current order
    } else {
      this.sort = { col, dir };
      const mul = dir === 'asc' ? 1 : -1;
      this.data.sort((a, b) => {
        const va = a[col] ?? '', vb = b[col] ?? '';
        const na = parseFloat(String(va).trim()), nb = parseFloat(String(vb).trim());
        if (!isNaN(na) && !isNaN(nb)) return (na - nb) * mul;
        return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * mul;
      });
    }
    this.render();
    this.notify();
  }

  // ===== Context menu =====
  onContextMenu(e) {
    if (this.readOnly) { e.preventDefault(); return; }
    const td = e.target.closest('td.sgrid-cell');
    const rnum = e.target.closest('th.sgrid-rownum');
    const letterTh = e.target.closest('th.sgrid-colletter');
    const fieldTh = e.target.closest('th.sgrid-field');
    if (!td && !rnum && !letterTh && !fieldTh) return;
    e.preventDefault();
    if (td) this.setActive(Number(td.dataset.row), Number(td.dataset.col));
    else if (rnum) {
      const r = Number(rnum.dataset.row);
      this.sel = { r1: r, c1: 0, r2: r, c2: this.headers.length - 1 };
      this.active = { row: r, col: 0 };
    } else if (letterTh || fieldTh) {
      const c = Number((letterTh || fieldTh).dataset.col);
      this.sel = { r1: 0, c1: c, r2: this.data.length - 1, c2: c };
      this.active = { row: 0, col: c };
    }
    this.applySelectionStyle();
    this.updateCellRef();

    const items = [
      { label: 'Insert row above', act: 'row-above' },
      { label: 'Insert row below', act: 'row-below' },
      { label: '-' },
      { label: 'Insert column left', act: 'col-left' },
      { label: 'Insert column right', act: 'col-right' },
      { label: '-' },
      { label: 'Delete row(s)', act: 'del-row' },
      { label: 'Delete column(s)', act: 'del-col' },
      { label: '-' },
      { label: 'Rename column', act: 'rename-col' },
    ];
    this.ctxMenuEl.innerHTML = '';
    for (const it of items) {
      if (it.label === '-') { const sep = document.createElement('div'); sep.className = 'sgrid-ctx-sep'; this.ctxMenuEl.appendChild(sep); continue; }
      const b = document.createElement('button');
      b.textContent = it.label;
      b.addEventListener('click', () => {
        this.hideContextMenu();
        this.runAction(it.act);
        this.rootEl.focus();
      });
      this.ctxMenuEl.appendChild(b);
    }
    const rootRect = this.rootEl.getBoundingClientRect();
    this.ctxMenuEl.style.left = (e.clientX - rootRect.left) + 'px';
    this.ctxMenuEl.style.top = (e.clientY - rootRect.top) + 'px';
    this.ctxMenuEl.classList.remove('hidden');
  }

  hideContextMenu() {
    this.ctxMenuEl.classList.add('hidden');
  }

  // ===== Filter popup =====
  toggleFilterPopup(col, anchorEl) {
    if (this.filterPopupCol === col) { this.hideFilterPopup(); return; }
    this.showFilterPopup(col, anchorEl);
  }

  hideFilterPopup() {
    if (this.filterPopupEl) {
      this.filterPopupEl.remove();
      this.filterPopupEl = null;
      this.filterPopupCol = null;
    }
  }

  showFilterPopup(col, anchorEl) {
    this.hideFilterPopup();
    this.filterPopupCol = col;

    const popup = document.createElement('div');
    popup.className = 'sgrid-fpop';

    const header = document.createElement('div');
    header.className = 'sgrid-fpop-header';
    const title = document.createElement('span');
    title.textContent = `Filter · ${this.headers[col]}`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'sgrid-fpop-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => this.hideFilterPopup());
    header.appendChild(title);
    header.appendChild(closeBtn);
    popup.appendChild(header);

    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'sgrid-fpop-search';
    search.placeholder = 'Search values…';
    popup.appendChild(search);

    const toggleRow = document.createElement('div');
    toggleRow.className = 'sgrid-fpop-togglerow';
    const allBtn = document.createElement('button');
    allBtn.textContent = 'Select all';
    const noneBtn = document.createElement('button');
    noneBtn.textContent = 'Clear';
    toggleRow.appendChild(allBtn);
    toggleRow.appendChild(noneBtn);
    popup.appendChild(toggleRow);

    const listWrap = document.createElement('div');
    listWrap.className = 'sgrid-fpop-list';
    popup.appendChild(listWrap);

    const footer = document.createElement('div');
    footer.className = 'sgrid-fpop-footer';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'sgrid-fpop-clear';
    clearBtn.textContent = 'Clear filter';
    footer.appendChild(clearBtn);
    popup.appendChild(footer);

    const uniqueValues = this.getColumnUniqueValues(col);
    const existing = this.filters[col];
    const allowed = existing ? new Set(existing.allowed) : new Set(uniqueValues);

    const renderList = (q = '') => {
      listWrap.innerHTML = '';
      const ql = q.toLowerCase();
      const filtered = uniqueValues.filter(v => !ql || v.toLowerCase().includes(ql));
      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'sgrid-fpop-noresult';
        empty.textContent = 'No matches';
        listWrap.appendChild(empty);
        return;
      }
      for (const v of filtered) {
        const row = document.createElement('label');
        row.className = 'sgrid-fpop-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = allowed.has(v);
        cb.addEventListener('change', () => {
          if (cb.checked) allowed.add(v);
          else allowed.delete(v);
          this.applyFilter(col, allowed, uniqueValues);
        });
        const span = document.createElement('span');
        span.className = 'sgrid-fpop-val';
        if (v === '') { span.textContent = '(empty)'; span.classList.add('sgrid-fpop-empty'); }
        else span.textContent = v;
        row.appendChild(cb);
        row.appendChild(span);
        listWrap.appendChild(row);
      }
    };
    renderList();

    search.addEventListener('input', () => renderList(search.value));
    allBtn.addEventListener('click', () => {
      for (const v of uniqueValues) allowed.add(v);
      this.applyFilter(col, allowed, uniqueValues);
      renderList(search.value);
    });
    noneBtn.addEventListener('click', () => {
      allowed.clear();
      this.applyFilter(col, allowed, uniqueValues);
      renderList(search.value);
    });
    clearBtn.addEventListener('click', () => {
      delete this.filters[col];
      this.hideFilterPopup();
      this.render();
    });

    this.rootEl.appendChild(popup);
    this.filterPopupEl = popup;

    const rootRect = this.rootEl.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const popupWidth = 260;
    let left = anchorRect.right - rootRect.left - popupWidth;
    if (left < 6) left = 6;
    const maxLeft = this.rootEl.clientWidth - popupWidth - 6;
    if (left > maxLeft) left = Math.max(6, maxLeft);
    const top = anchorRect.bottom - rootRect.top + 4;
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';

    setTimeout(() => search.focus(), 0);
  }

  applyFilter(col, allowed, uniqueValues) {
    if (allowed.size >= uniqueValues.length) {
      delete this.filters[col];
    } else {
      this.filters[col] = { allowed: new Set(allowed) };
    }
    // Re-render table only — keep popup open
    this.renderOnlyBody();
  }

  renderOnlyBody() {
    // Lightweight rerender: just the body + header filter active state, keeping popup intact
    this.render();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatNum(n) {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4).replace(/\.?0+$/, '');
}

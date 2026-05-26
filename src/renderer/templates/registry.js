import prd from './prd.js';
import releaseChecklist from './release-checklist.js';
import nodePackSubmission from './node-pack-submission.js';
import uxReview from './ux-review.js';
import handover from './handover.js';
import specSheet from './spec-sheet.js';
import taskList from './task-list.js';
import adr from './adr.js';
import sessionLog from './session-log.js';
import runEvidence from './run-evidence.js';

const templates = new Map();

function slug(value) {
  return String(value || 'untitled')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

function yamlScalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value ?? '');
  if (!text) return '""';
  if (/^[a-z0-9_.-]+$/i.test(text)) return text;
  return JSON.stringify(text);
}

function toFrontmatter(data) {
  const rows = ['---'];
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined || value === null || value === '') continue;
    rows.push(`${key}: ${yamlScalar(value)}`);
  }
  rows.push('---', '');
  return rows.join('\n');
}

function normalizeTemplate(template) {
  if (!template?.id) throw new Error('Template id is required.');
  return {
    format: 'markdown',
    fields: [],
    requiredSections: [],
    optionalSections: [],
    ...template,
  };
}

export function registerTemplate(template) {
  const normalized = normalizeTemplate(template);
  templates.set(normalized.id, normalized);
  return normalized;
}

export function listTemplates() {
  return Array.from(templates.values());
}

export function getTemplate(id) {
  return templates.get(id) || null;
}

export function createFromTemplate(id, opts = {}) {
  const template = getTemplate(id);
  if (!template) throw new Error(`Unknown template: ${id}`);
  const vars = { slug, ...opts };
  const frontmatter = {
    template: template.id,
    created: new Date().toISOString().slice(0, 10),
    checklist_progress: 0,
    ...(typeof template.frontmatter === 'function' ? template.frontmatter(vars) : template.frontmatter || {}),
  };
  return `${toFrontmatter(frontmatter)}${template.body(vars).trim()}\n`;
}

export function createTemplateFile(id, opts = {}) {
  const template = getTemplate(id);
  if (!template) throw new Error(`Unknown template: ${id}`);
  const vars = { slug, ...opts };
  const filename = typeof template.filename === 'function'
    ? template.filename(vars)
    : (template.filename || `${template.id}.md`);
  return {
    template,
    filename,
    content: createFromTemplate(id, opts),
    format: template.format || 'markdown',
  };
}

[
  prd,
  releaseChecklist,
  nodePackSubmission,
  uxReview,
  handover,
  specSheet,
  taskList,
  adr,
  sessionLog,
  runEvidence,
].forEach(registerTemplate);

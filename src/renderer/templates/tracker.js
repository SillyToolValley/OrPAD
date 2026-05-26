import { getTemplate } from './registry.js';

function escapeRe(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseFrontmatter(markdown) {
  const match = String(markdown || '').match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { data: {}, raw: '', bodyStart: 0 };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!item) continue;
    let value = item[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[item[1]] = value;
  }
  return { data, raw: match[0], bodyStart: match[0].length };
}

function normalizeHeading(text) {
  return String(text || '').replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function findSectionRange(markdown, heading) {
  const source = String(markdown || '');
  const target = normalizeHeading(heading);
  const re = /^(#{2,6})\s+(.+?)\s*#*\s*$/gm;
  let match;
  while ((match = re.exec(source))) {
    const level = match[1].length;
    if (normalizeHeading(match[2]) !== target) continue;
    const headingStart = match.index;
    const headingEnd = re.lastIndex;
    const nextRe = new RegExp(`^#{2,${level}}\\s+.+?\\s*#*\\s*$`, 'gm');
    nextRe.lastIndex = headingEnd;
    const next = nextRe.exec(source);
    const end = next ? next.index : source.length;
    return {
      heading,
      level,
      headingStart,
      headingEnd,
      bodyStart: source[headingEnd] === '\n' ? headingEnd + 1 : headingEnd,
      end,
      text: source.slice(source[headingEnd] === '\n' ? headingEnd + 1 : headingEnd, end).replace(/^\n+|\n+$/g, ''),
    };
  }
  return null;
}

function isPlaceholderOnly(text) {
  const stripped = String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/_[^_\n]*_/g, '')
    .replace(/[_*~]/g, '')
    .replace(/\[[ xX]\]/g, '')
    .replace(/^[-*]\s*/gm, '')
    .replace(/\b(describe|define|explain|paste|summarize|unset|none known|todo|tbd|pending)\b/gi, '')
    .replace(/\b(primary|secondary|in scope|out of scope|risk|mitigation)\b/gi, '')
    .replace(/[.:|#]/g, '')
    .trim();
  return stripped.length < 8;
}

function countChecklist(markdown) {
  const boxes = String(markdown || '').match(/^\s*[-*]\s+\[[ xX]\]/gm) || [];
  const done = boxes.filter(item => /\[[xX]\]/.test(item)).length;
  const unchecked = boxes.length - done;
  return { total: boxes.length, done, unchecked };
}

export function analyzeTemplate(markdown) {
  const frontmatter = parseFrontmatter(markdown);
  const templateId = frontmatter.data.template || '';
  const template = getTemplate(templateId);
  if (!template) return null;

  const required = template.requiredSections || [];
  const completed = [];
  const missing = [];
  const empty = [];
  for (const section of required) {
    const found = findSectionRange(markdown, section);
    if (!found) {
      missing.push(section);
    } else if (isPlaceholderOnly(found.text)) {
      empty.push(section);
    } else {
      completed.push(section);
    }
  }

  const checklist = countChecklist(markdown);
  const sectionProgress = required.length ? completed.length / required.length : 1;
  const checklistProgress = checklist.total ? checklist.done / checklist.total : sectionProgress;

  return {
    template,
    templateId,
    label: template.label,
    requiredSections: required,
    completedSections: completed,
    missingSections: [...missing, ...empty],
    absentSections: missing,
    emptySections: empty,
    completedCount: completed.length,
    totalCount: required.length,
    uncheckedCount: checklist.unchecked,
    checklistTotal: checklist.total,
    checklistDone: checklist.done,
    checklistProgress,
    summary: `${template.label} ${completed.length}/${required.length} sections - ${checklist.unchecked} unchecked`,
  };
}

export function replaceSectionContent(markdown, heading, newText) {
  const source = String(markdown || '');
  const range = findSectionRange(source, heading);
  if (!range) return source;
  const headingLine = source.slice(range.headingStart, range.headingEnd).replace(/\s+$/g, '');
  const sameHeading = new RegExp(`^#{2,6}\\s+${escapeRe(heading)}\\s*#*\\s*\\n`, 'i');
  const clean = String(newText || '').replace(sameHeading, '').replace(/^\n+|\n+$/g, '');
  const insert = `${headingLine}\n${clean ? `${clean}\n` : '\n'}`;
  return `${source.slice(0, range.headingStart)}${insert}${source.slice(range.end).replace(/^\n?/, '\n')}`;
}

export function updateChecklistProgressFrontmatter(markdown, progress) {
  const source = String(markdown || '');
  const value = Math.max(0, Math.min(1, Number(progress) || 0)).toFixed(2).replace(/\.?0+$/g, '');
  if (!source.startsWith('---\n')) return source;
  const end = source.indexOf('\n---', 4);
  if (end < 0) return source;
  const head = source.slice(0, end);
  const tail = source.slice(end);
  const next = /^checklist_progress:/m.test(head)
    ? head.replace(/^checklist_progress:.*$/m, `checklist_progress: ${value}`)
    : `${head}\nchecklist_progress: ${value}`;
  return `${next}${tail}`;
}

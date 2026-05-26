import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const MARKDOWN_TEMPLATES = [
  { id: 'prd', label: 'Product Requirements Document' },
  { id: 'release-checklist', label: 'Release Checklist' },
  { id: 'package-submission', label: 'Package Submission' },
  { id: 'ux-review', label: 'UX Review' },
  { id: 'handover', label: 'Handover' },
  { id: 'spec-sheet', label: 'Spec Sheet' },
  { id: 'task-list', label: 'Task List' },
  { id: 'adr', label: 'Architecture Decision Record' },
  { id: 'session-log', label: 'Session Log' },
  { id: 'run-evidence', label: 'Run Evidence' },
];

const PIPELINE_TEMPLATE_PATHS = [
  'nodes/orpad.core/examples/product-decision-gate/pipeline.or-pipeline',
  'nodes/orpad.core/examples/release-risk-routing/pipeline.or-pipeline',
  'nodes/orpad.workstream/examples/product-build-workstream/pipeline.or-pipeline',
  'nodes/orpad.workstream/examples/maintenance-workstream.or-pipeline',
];

const STARTER_PACK_IDS = [
  'orpad.starter.electron-maintenance',
  'orpad.starter.security-review',
  'orpad.starter.release-readiness',
  'orpad.starter.content-qa',
  'orpad.starter.dotnet-lab-code',
  'orpad.starter.frontend-ux',
  'orpad.starter.test-regression',
  'orpad.starter.node-pack-hardening',
];

async function importRendererTemplates(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-renderer-templates-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  await fs.cp(path.join(repoRoot, 'src/renderer/templates'), tempDir, { recursive: true });
  await fs.writeFile(path.join(tempDir, 'package.json'), '{"type":"module"}\n', 'utf-8');
  const registry = await import(pathToFileURL(path.join(tempDir, 'registry.js')).href);
  const tracker = await import(pathToFileURL(path.join(tempDir, 'tracker.js')).href);
  return { registry, tracker };
}

test('markdown document templates are registered and tracker-compatible', async (t) => {
  const { registry, tracker } = await importRendererTemplates(t);
  const templates = registry.listTemplates();

  assert.deepEqual(
    templates.map(template => ({ id: template.id, label: template.label })),
    MARKDOWN_TEMPLATES,
  );

  for (const template of templates) {
    assert.equal(typeof template.description, 'string', `${template.id} should describe its role`);
    assert.ok(template.description.length > 20, `${template.id} should have a useful description`);
    assert.ok(Array.isArray(template.requiredSections), `${template.id} should declare required sections`);
    assert.ok(template.requiredSections.length >= 3, `${template.id} should have trackable required sections`);

    const file = registry.createTemplateFile(template.id, {
      title: 'Template Hardening Smoke',
      owner: 'QA',
    });

    assert.equal(file.template.id, template.id);
    assert.equal(file.format, 'markdown');
    assert.match(file.filename, /\.md$/);
    assert.match(file.content, /^---\n/);

    const frontmatter = tracker.parseFrontmatter(file.content);
    assert.equal(frontmatter.data.template, template.id);
    assert.equal(frontmatter.data.title, 'Template Hardening Smoke');

    for (const section of template.requiredSections) {
      assert.ok(
        tracker.findSectionRange(file.content, section),
        `${template.id} missing required section ${section}`,
      );
    }

    const analysis = tracker.analyzeTemplate(file.content);
    assert.equal(analysis.templateId, template.id);
    assert.equal(analysis.totalCount, template.requiredSections.length);
    assert.match(analysis.summary, / sections - \d+ unchecked$/);
    assert.deepEqual(analysis.absentSections, [], `${template.id} should not omit required headings`);
  }
});

test('template catalog documents exposed templates and isolated candidates', async () => {
  const catalog = await fs.readFile(path.join(repoRoot, 'TEMPLATE_CATALOG.md'), 'utf-8');
  const readme = await fs.readFile(path.join(repoRoot, 'README.md'), 'utf-8');

  for (const { id, label } of MARKDOWN_TEMPLATES) {
    assert.match(catalog, new RegExp(`\\\`${id}\\\``), `${id} missing from template catalog`);
    assert.match(catalog, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${label} missing from template catalog`);
  }

  for (const pipelinePath of PIPELINE_TEMPLATE_PATHS) {
    assert.match(catalog, new RegExp(pipelinePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${pipelinePath} missing from template catalog`);
  }

  for (const packId of STARTER_PACK_IDS) {
    assert.match(catalog, new RegExp(`\\\`${packId}\\\``), `${packId} missing from starter package catalog`);
  }

  for (const isolated of ['Generic blank notes', 'Snippet bodies', 'Reserved folders']) {
    assert.match(catalog, new RegExp(isolated), `catalog should record isolated candidate ${isolated}`);
  }

  assert.doesNotMatch(catalog, /tutorial-(gate|selector|worker)/i);
  assert.match(readme, /TEMPLATE_CATALOG\.md/);
});

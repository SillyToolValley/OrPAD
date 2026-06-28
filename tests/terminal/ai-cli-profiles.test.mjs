import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { detectTerminalProfiles } = require(path.join(repoRoot, 'src/main/terminal/pty.js'));

// detectTerminalProfiles probes the filesystem for CLI availability (machine-dependent), but each profile's
// IDENTITY + the bypass ARGS it would launch with are deterministic — that's what we lock here. Bypass flags
// are safety-relevant: a regression that drops a flag, or adds one to a NORMAL profile, must fail the build.

const aiProfiles = () => detectTerminalProfiles().filter((p) => p.kind === 'ai-cli');

test('every AI CLI has a normal profile AND a clearly-labelled bypass profile', () => {
  const byId = new Map(aiProfiles().map((p) => [p.id, p]));
  for (const cli of ['claude', 'codex', 'gemini']) {
    assert.ok(byId.has(`ai-${cli}`), `normal profile ai-${cli} exists`);
    assert.ok(byId.has(`ai-${cli}-bypass`), `bypass profile ai-${cli}-bypass exists`);
    assert.equal(byId.get(`ai-${cli}`).bypass, false, `ai-${cli} is NOT bypass`);
    assert.equal(byId.get(`ai-${cli}-bypass`).bypass, true, `ai-${cli}-bypass is bypass`);
    assert.match(byId.get(`ai-${cli}-bypass`).label, /\(bypass\)/i, 'bypass profile is labelled');
  }
});

test('normal profiles carry NO skip-permission args; bypass profiles carry the right flag', () => {
  const byId = new Map(aiProfiles().map((p) => [p.id, p]));
  // normal = nothing extra (when launched directly; a gemini npm/powershell fallback wraps gemini but adds no bypass)
  for (const cli of ['claude', 'codex', 'gemini']) {
    const normal = byId.get(`ai-${cli}`);
    const dangerous = /dangerous|skip-permission|bypass-approvals|yolo/i;
    assert.ok(!normal.args.some((a) => dangerous.test(a)), `ai-${cli} args have no bypass flag (${JSON.stringify(normal.args)})`);
  }
  // claude/codex launch directly (no wrapper) → exact args.
  assert.deepEqual(byId.get('ai-claude-bypass').args, ['--dangerously-skip-permissions']);
  assert.deepEqual(byId.get('ai-codex-bypass').args, ['--dangerously-bypass-approvals-and-sandbox']);
  // gemini may launch via an npm/powershell fallback that wraps the invocation, so just assert the flag is present.
  assert.ok(byId.get('ai-gemini-bypass').args.includes('--yolo'), `gemini-bypass passes --yolo (${JSON.stringify(byId.get('ai-gemini-bypass').args)})`);
});

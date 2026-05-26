#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  readNodePackRegistryFile,
  summarizeNodePackRegistry,
} = require('../src/main/orchestration-machine/node-pack-registry.js');

const OFFICIAL_REGISTRY_ID = 'orpad.official';
const OFFICIAL_SUBMISSIONS_URL = 'https://github.com/OrPAD-Lab/orpad-registry/pulls';
const OFFICIAL_REVIEW_POLICY_URL = 'https://github.com/OrPAD-Lab/orpad-registry/blob/main/REGISTRY_POLICY.md';

function usage() {
  return [
    'Usage:',
    '  node scripts/validate-node-pack-registry.mjs [registry-json] [--json] [--allow-custom-governance]',
    '',
    'Defaults to registry/packages.json and enforces the official OrPAD-Lab registry policy.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--allow-custom-governance') {
      args.allowCustomGovernance = true;
      continue;
    }
    args._.push(arg);
  }
  return args;
}

function diagnostic(level, code, message, details = {}) {
  return { level, code, message, ...details };
}

function errorDiagnostic(code, message, details = {}) {
  return diagnostic('error', code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (isPlainObject(value)) {
    const next = {};
    for (const key of Object.keys(value).sort()) next[key] = stableJsonValue(value[key]);
    return next;
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableJsonValue(value));
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || '').trim());
}

async function aliasDiagnostics(registryPath, rawRegistry) {
  const diagnostics = [];
  const normalizedPath = path.resolve(registryPath).replace(/\\/g, '/');
  if (!normalizedPath.endsWith('/registry/packages.json')) return diagnostics;
  const aliasPath = path.resolve(path.dirname(registryPath), 'node-packs.json');
  let alias;
  try {
    alias = JSON.parse(await fs.readFile(aliasPath, 'utf-8'));
  } catch (err) {
    diagnostics.push(errorDiagnostic('ORPAD_OFFICIAL_REGISTRY_COMPAT_ALIAS_MISSING', 'registry/node-packs.json compatibility alias must exist for shipped OrPAD builds.', {
      path: aliasPath,
      error: err.message,
    }));
    return diagnostics;
  }
  if (stableJson(alias) !== stableJson(rawRegistry)) {
    diagnostics.push(errorDiagnostic('ORPAD_OFFICIAL_REGISTRY_COMPAT_ALIAS_DRIFT', 'registry/node-packs.json must match registry/packages.json until legacy OrPAD builds are retired.', {
      path: aliasPath,
    }));
  }
  return diagnostics;
}

function officialPolicyDiagnostics(rawRegistry) {
  const diagnostics = [];
  const governance = isPlainObject(rawRegistry?.governance) ? rawRegistry.governance : {};
  const submissions = isPlainObject(governance.submissions) ? governance.submissions : {};
  if (rawRegistry?.registryId !== OFFICIAL_REGISTRY_ID) {
    diagnostics.push(errorDiagnostic('ORPAD_OFFICIAL_REGISTRY_ID_INVALID', 'Official registry id must remain orpad.official.', {
      expected: OFFICIAL_REGISTRY_ID,
      actual: rawRegistry?.registryId || '',
    }));
  }
  if (governance.registryTrust !== 'official') {
    diagnostics.push(errorDiagnostic('ORPAD_OFFICIAL_REGISTRY_TRUST_INVALID', 'Official registry governance must declare registryTrust=official.', {
      actual: governance.registryTrust || '',
    }));
  }
  if (governance.reviewModel !== 'orpad-pr-reviewed') {
    diagnostics.push(errorDiagnostic('ORPAD_OFFICIAL_REGISTRY_REVIEW_MODEL_INVALID', 'Official registry governance must use orpad-pr-reviewed.', {
      actual: governance.reviewModel || '',
    }));
  }
  if (submissions.type !== 'pull-request' || submissions.url !== OFFICIAL_SUBMISSIONS_URL) {
    diagnostics.push(errorDiagnostic('ORPAD_OFFICIAL_REGISTRY_SUBMISSIONS_INVALID', 'Official registry submissions must route through OrPAD-Lab/orpad-registry pull requests.', {
      expected: OFFICIAL_SUBMISSIONS_URL,
      actual: submissions.url || '',
    }));
  }
  if (governance.reviewPolicyUrl !== OFFICIAL_REVIEW_POLICY_URL) {
    diagnostics.push(errorDiagnostic('ORPAD_OFFICIAL_REGISTRY_POLICY_URL_INVALID', 'Official registry review policy URL must point at OrPAD-Lab/orpad-registry.', {
      expected: OFFICIAL_REVIEW_POLICY_URL,
      actual: governance.reviewPolicyUrl || '',
    }));
  }

  for (const [entryIndex, entry] of (Array.isArray(rawRegistry?.entries) ? rawRegistry.entries : []).entries()) {
    const entryPath = `entries[${entryIndex}]`;
    if (!isPlainObject(entry)) continue;
    const latest = String(entry.latestVersion || '').trim();
    const latestVersion = (Array.isArray(entry.versions) ? entry.versions : [])
      .find(version => isPlainObject(version) && String(version.version || '').trim() === latest);
    if (!latestVersion) continue;
    const versionPath = `${entryPath}.versions[${entry.versions.indexOf(latestVersion)}]`;
    const review = isPlainObject(latestVersion.review) ? latestVersion.review : {};
    if (review.status !== 'approved') {
      diagnostics.push(errorDiagnostic('ORPAD_OFFICIAL_REGISTRY_LATEST_VERSION_NOT_APPROVED', 'Official registry latest versions must carry maintainer-approved review metadata before merge.', {
        path: `${versionPath}.review.status`,
        entryId: entry.id || '',
        version: latest,
      }));
    }
    for (const field of ['reviewId', 'reviewedBy', 'reviewedAt']) {
      if (!String(review[field] || '').trim()) {
        diagnostics.push(errorDiagnostic('ORPAD_OFFICIAL_REGISTRY_REVIEW_METADATA_MISSING', `Official registry approved versions must include review.${field}.`, {
          path: `${versionPath}.review.${field}`,
          entryId: entry.id || '',
          version: latest,
        }));
      }
    }
    const checksums = isPlainObject(latestVersion.checksums) ? latestVersion.checksums : {};
    if (!isSha256(checksums.manifestSha256)) {
      diagnostics.push(errorDiagnostic('ORPAD_OFFICIAL_REGISTRY_MANIFEST_SHA256_MISSING', 'Official registry versions must include checksums.manifestSha256.', {
        path: `${versionPath}.checksums.manifestSha256`,
        entryId: entry.id || '',
        version: latest,
      }));
    }
    const files = isPlainObject(checksums.files) ? checksums.files : {};
    for (const [filePath, sha256] of Object.entries(files)) {
      if (!isSha256(sha256)) {
        diagnostics.push(errorDiagnostic('ORPAD_OFFICIAL_REGISTRY_FILE_SHA256_INVALID', 'Official registry file checksums must be SHA-256 hex strings.', {
          path: `${versionPath}.checksums.files.${filePath}`,
          entryId: entry.id || '',
          version: latest,
        }));
      }
    }
  }
  return diagnostics;
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const status = result.success ? 'ok' : 'failed';
  const entryCount = result.registry?.entries?.length || 0;
  process.stdout.write(`Registry validation ${status}: ${result.path} (${entryCount} entries)\n`);
  for (const item of result.diagnostics || []) {
    const scope = [item.path, item.entryId, item.version].filter(Boolean).join(' ');
    process.stdout.write(`- ${item.level || 'info'} ${item.code}${scope ? ` (${scope})` : ''}: ${item.message}\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const registryPath = path.resolve(args._[0] || 'registry/packages.json');
  const source = await readNodePackRegistryFile(registryPath, { useCacheOnFailure: false });
  const policyDiagnostics = (!args.allowCustomGovernance && source.rawRegistry)
    ? officialPolicyDiagnostics(source.rawRegistry)
    : [];
  const compatibilityDiagnostics = source.rawRegistry
    ? await aliasDiagnostics(registryPath, source.rawRegistry)
    : [];
  const diagnostics = [
    ...(source.diagnostics || []),
    ...policyDiagnostics,
    ...compatibilityDiagnostics,
  ];
  const success = source.ok && !diagnostics.some(item => item.level === 'error');
  const result = {
    success,
    ok: success,
    path: registryPath,
    registry: source.registry ? summarizeNodePackRegistry(source.registry) : null,
    diagnostics,
  };
  printResult(result, args.json);
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});

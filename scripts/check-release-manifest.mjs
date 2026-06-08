import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST_NAMES = [
  'orpad-release-manifest-windows.json',
  'orpad-release-manifest.json',
];
const INSTALLER_PATTERN = /\.(exe|dmg)$/i;

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function releaseRelative(root, filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/');
}

function installerFiles(releaseDir) {
  return fs.readdirSync(releaseDir)
    .filter(name => INSTALLER_PATTERN.test(name))
    .sort((a, b) => a.localeCompare(b));
}

function findManifestPath(releaseDir, manifestName) {
  if (manifestName) {
    return path.join(releaseDir, manifestName);
  }

  for (const name of DEFAULT_MANIFEST_NAMES) {
    const candidate = path.join(releaseDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  const discovered = fs.readdirSync(releaseDir)
    .filter(name => /^orpad-release-manifest.*\.json$/i.test(name))
    .sort((a, b) => a.localeCompare(b));

  if (discovered.length === 1) {
    return path.join(releaseDir, discovered[0]);
  }

  if (discovered.length > 1) {
    throw new Error(`Multiple release manifests found in release/: ${discovered.join(', ')}. Set ORPAD_RELEASE_MANIFEST_NAME.`);
  }

  return path.join(releaseDir, DEFAULT_MANIFEST_NAMES[0]);
}

function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Release manifest does not exist: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  if (!Array.isArray(manifest.files)) {
    throw new Error(`Release manifest ${manifestPath} must contain a files array.`);
  }

  return manifest;
}

function expectedFileMap(manifest) {
  const entries = new Map();

  for (const file of manifest.files) {
    const name = String(file?.name || '').trim();
    if (!name) {
      throw new Error('Release manifest contains a file entry without a name.');
    }
    if (entries.has(name)) {
      throw new Error(`Release manifest contains duplicate file entry: ${name}`);
    }

    entries.set(name, {
      name,
      size: Number(file.size),
      sha256: String(file.sha256 || '').toLowerCase(),
    });
  }

  return entries;
}

function currentFileMap(releaseDir, installers) {
  const entries = new Map();

  for (const name of installers) {
    const filePath = path.join(releaseDir, name);
    entries.set(name, {
      name,
      size: fs.statSync(filePath).size,
      sha256: sha256(filePath),
    });
  }

  return entries;
}

function compareManifestFiles(expected, actual) {
  const mismatches = [];

  for (const [name, actualFile] of actual) {
    const expectedFile = expected.get(name);
    if (!expectedFile) {
      mismatches.push({
        name,
        expectedSize: 'missing from manifest',
        expectedSha256: 'missing from manifest',
        actualSize: actualFile.size,
        actualSha256: actualFile.sha256,
      });
      continue;
    }

    if (expectedFile.size !== actualFile.size || expectedFile.sha256 !== actualFile.sha256) {
      mismatches.push({
        name,
        expectedSize: expectedFile.size,
        expectedSha256: expectedFile.sha256,
        actualSize: actualFile.size,
        actualSha256: actualFile.sha256,
      });
    }
  }

  for (const [name, expectedFile] of expected) {
    if (!actual.has(name)) {
      mismatches.push({
        name,
        expectedSize: expectedFile.size,
        expectedSha256: expectedFile.sha256,
        actualSize: 'missing installer',
        actualSha256: 'missing installer',
      });
    }
  }

  return mismatches;
}

function formatMismatch(mismatch) {
  return [
    `- ${mismatch.name}`,
    `  expected size: ${mismatch.expectedSize}`,
    `  expected sha256: ${mismatch.expectedSha256}`,
    `  actual size: ${mismatch.actualSize}`,
    `  actual sha256: ${mismatch.actualSha256}`,
  ].join('\n');
}

export function checkReleaseManifest(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const releaseDir = path.resolve(options.releaseDir || process.env.ORPAD_RELEASE_DIR || path.join(root, 'release'));
  const manifestName = options.manifestName ?? String(process.env.ORPAD_RELEASE_MANIFEST_NAME || '').trim();

  if (!fs.existsSync(releaseDir)) {
    throw new Error(`release directory does not exist: ${releaseDir}`);
  }

  const installers = installerFiles(releaseDir);
  if (!installers.length) {
    throw new Error(`No installer assets found in ${releaseRelative(root, releaseDir)}.`);
  }

  const manifestPath = findManifestPath(releaseDir, manifestName);
  const manifest = readManifest(manifestPath);
  const expected = expectedFileMap(manifest);
  const actual = currentFileMap(releaseDir, installers);
  const mismatches = compareManifestFiles(expected, actual);

  if (mismatches.length) {
    throw new Error([
      `Release manifest is stale: ${releaseRelative(root, manifestPath)}`,
      ...mismatches.map(formatMismatch),
    ].join('\n'));
  }

  return {
    releaseDir,
    manifestPath,
    installers,
    filesChecked: installers.length,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const result = checkReleaseManifest();
    console.log(`Release manifest is current: ${releaseRelative(ROOT, result.manifestPath)} (${result.filesChecked} installer asset${result.filesChecked === 1 ? '' : 's'} checked)`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

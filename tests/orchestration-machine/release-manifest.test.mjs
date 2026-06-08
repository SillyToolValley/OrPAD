import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkReleaseManifest } from '../../scripts/check-release-manifest.mjs';

function sha256Fixture(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function writeFixture(tmpDir, manifestFiles) {
  const releaseDir = path.join(tmpDir, 'release');
  fs.mkdirSync(releaseDir, { recursive: true });
  const installer = Buffer.from('current installer payload');
  fs.writeFileSync(path.join(releaseDir, 'OrPAD-Setup-1.0.0-beta.5.exe'), installer);
  fs.writeFileSync(path.join(releaseDir, 'orpad-release-manifest-windows.json'), `${JSON.stringify({
    schema: 1,
    product: 'OrPAD',
    version: '1.0.0-beta.5',
    files: manifestFiles ?? [{
      name: 'OrPAD-Setup-1.0.0-beta.5.exe',
      size: installer.length,
      sha256: sha256Fixture(installer),
    }],
    signature: {
      algorithm: 'ed25519',
      value: 'fixture-signature',
    },
  }, null, 2)}\n`);
  return releaseDir;
}

test('release manifest check passes when installer size and sha256 match', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-release-manifest-'));
  const releaseDir = writeFixture(tmpDir);

  const result = checkReleaseManifest({ root: tmpDir, releaseDir });

  assert.equal(result.filesChecked, 1);
  assert.equal(result.installers[0], 'OrPAD-Setup-1.0.0-beta.5.exe');
});

test('release manifest check reports stale installer size and sha256', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-release-manifest-'));
  const releaseDir = writeFixture(tmpDir, [{
    name: 'OrPAD-Setup-1.0.0-beta.5.exe',
    size: 110744961,
    sha256: '965ca45683117df8eba78f24c4ef60931103157ffd30203efbeb8433860d3586',
  }]);

  assert.throws(
    () => checkReleaseManifest({ root: tmpDir, releaseDir }),
    (error) => {
      assert.match(error.message, /Release manifest is stale/);
      assert.match(error.message, /OrPAD-Setup-1\.0\.0-beta\.5\.exe/);
      assert.match(error.message, /expected size: 110744961/);
      assert.match(error.message, /expected sha256: 965ca45683117df8eba78f24c4ef60931103157ffd30203efbeb8433860d3586/);
      assert.match(error.message, /actual size: 25/);
      assert.match(error.message, /actual sha256: /);
      return true;
    },
  );
});

test('release manifest check fails when a current installer is missing from the manifest', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-release-manifest-'));
  const releaseDir = writeFixture(tmpDir, []);

  assert.throws(
    () => checkReleaseManifest({ root: tmpDir, releaseDir }),
    /missing from manifest/,
  );
});

test('package exposes keyless release manifest verification', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));

  assert.equal(packageJson.scripts['release:check-manifest'], 'node scripts/check-release-manifest.mjs');
  assert.equal(packageJson.scripts['release:verify'], 'npm run release:check-manifest');
  assert.match(packageJson.scripts['release:manifest'], /release:check-manifest/);
  assert.doesNotMatch(packageJson.scripts['release:check-manifest'], /ORPAD_RELEASE_SIGNING_PRIVATE_KEY|create-release-manifest/);
});

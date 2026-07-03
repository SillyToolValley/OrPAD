const { app, dialog, shell } = require('electron');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const GITHUB_OWNER = 'SillyToolValley';
const GITHUB_REPO = 'OrPAD';
const RELEASE_MANIFEST_NAMES = new Set([
  'orpad-release-manifest.json',
  'orpad-release-manifest-windows.json',
  'orpad-release-manifest-macos.json',
  'release-manifest.json',
]);

// --- Version comparison (semver-lite) ---
// Splits "1.2.3-beta.4" into { base: [1,2,3], pre: ['beta', 4] }. Any release with a
// prerelease tag sorts BELOW the same base without one (so 1.0.0-beta.9 < 1.0.0).
function parseVersion(v) {
  const clean = v.replace(/^v/, '').trim();
  const [basePart, prePart] = clean.split('-', 2);
  const base = basePart.split('.').map(n => parseInt(n, 10) || 0);
  while (base.length < 3) base.push(0);
  const pre = prePart
    ? prePart.split('.').map(x => /^\d+$/.test(x) ? parseInt(x, 10) : x)
    : null;
  return { base, pre };
}

function compareVersions(current, latest) {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  for (let i = 0; i < 3; i++) {
    if (b.base[i] > a.base[i]) return 1;
    if (b.base[i] < a.base[i]) return -1;
  }
  if (!a.pre && !b.pre) return 0;
  if (!a.pre && b.pre) return -1;
  if (a.pre && !b.pre) return 1;
  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const ap = a.pre[i], bp = b.pre[i];
    if (ap === undefined) return 1;
    if (bp === undefined) return -1;
    const aNum = typeof ap === 'number';
    const bNum = typeof bp === 'number';
    if (aNum && !bNum) return 1;
    if (!aNum && bNum) return -1;
    if (ap > bp) return -1;
    if (ap < bp) return 1;
  }
  return 0;
}

// --- Skip version persistence ---
function getSkipPath() {
  return path.join(app.getPath('userData'), 'skipped-version');
}

function getSkippedVersion() {
  try { return fs.readFileSync(getSkipPath(), 'utf-8').trim(); }
  catch { return null; }
}

function setSkippedVersion(version) {
  try { fs.writeFileSync(getSkipPath(), version, 'utf-8'); } catch {}
}

// --- Update-in-progress marker ---
// Written right before launching the NSIS installer so that any new app
// instance (e.g. user double-clicking the icon while the installer runs)
// can detect the in-flight install and bow out instead of starting up
// half-baked. The marker self-clears when the next launch's app version
// matches marker.targetVersion (install completed) or after 5 minutes
// (install was abandoned).
const STALE_MARKER_MS = 5 * 60 * 1000;

function getMarkerPath() {
  return path.join(app.getPath('userData'), 'update-in-progress');
}

function writeMarker(targetVersion) {
  try {
    fs.writeFileSync(getMarkerPath(), JSON.stringify({
      targetVersion,
      timestamp: Date.now(),
    }), 'utf-8');
  } catch {}
}

function clearMarker() {
  try { fs.unlinkSync(getMarkerPath()); } catch {}
}

function checkUpdateInProgress() {
  let marker;
  try { marker = JSON.parse(fs.readFileSync(getMarkerPath(), 'utf-8')); }
  catch { return null; }
  if (!marker) return null;
  if (marker.targetVersion && marker.targetVersion === app.getVersion()) {
    clearMarker();
    return null;
  }
  if (!marker.timestamp || Date.now() - marker.timestamp > STALE_MARKER_MS) {
    clearMarker();
    return null;
  }
  return marker;
}

// --- HTTPS helpers ---
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': `OrPAD/${app.getVersion()}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        httpsGet(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const doDownload = (downloadUrl) => {
      const req = https.get(downloadUrl, {
        headers: { 'User-Agent': `OrPAD/${app.getVersion()}` },
      }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume();
          doDownload(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
        let receivedBytes = 0;
        const file = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (totalBytes > 0 && onProgress) onProgress(receivedBytes / totalBytes);
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
      });
      req.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    };
    doDownload(url);
  });
}

function getUpdaterPublicKey() {
  if (process.env.ORPAD_UPDATER_PUBLIC_KEY) {
    return String(process.env.ORPAD_UPDATER_PUBLIC_KEY).trim();
  }
  try {
    const configured = require('./updater-public-key.json');
    return String(configured?.publicKey || '').trim();
  } catch {
    return '';
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function publicKeyObject(publicKey) {
  const key = String(publicKey || '').trim();
  if (!key) throw new Error('Updater public key is not configured.');
  if (key.includes('BEGIN PUBLIC KEY')) return crypto.createPublicKey(key);
  return crypto.createPublicKey({
    key: Buffer.from(key, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

function verifyManifestSignature(manifest, publicKey) {
  const signature = manifest?.signature;
  if (signature?.algorithm !== 'ed25519' || !signature?.value) {
    throw new Error('Release manifest signature is missing or unsupported.');
  }
  const payload = { ...manifest };
  delete payload.signature;
  const verified = crypto.verify(
    null,
    Buffer.from(stableStringify(payload), 'utf-8'),
    publicKeyObject(publicKey),
    Buffer.from(signature.value, 'base64')
  );
  if (!verified) throw new Error('Release manifest signature verification failed.');
}

function platformManifestName() {
  if (process.platform === 'darwin') return 'orpad-release-manifest-macos.json';
  if (process.platform === 'win32') return 'orpad-release-manifest-windows.json';
  return 'orpad-release-manifest.json';
}

function findManifestAssets(release) {
  const platformName = platformManifestName();
  return (release.assets || [])
    .filter(asset => RELEASE_MANIFEST_NAMES.has(String(asset.name || '').toLowerCase()))
    .sort((a, b) => {
      const an = String(a.name || '').toLowerCase() === platformName ? 0 : 1;
      const bn = String(b.name || '').toLowerCase() === platformName ? 0 : 1;
      return an - bn;
    });
}

function findManifestFile(manifest, assetName, latestVersion) {
  if (String(manifest?.version || '').replace(/^v/, '') !== latestVersion) {
    throw new Error('Release manifest version does not match the release tag.');
  }
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  const file = files.find(item => item?.name === assetName);
  if (!file?.sha256 || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
    throw new Error('Release manifest does not include a valid installer checksum.');
  }
  return file;
}

function windowsAssetArchScore(name) {
  const lower = String(name || '').toLowerCase();
  if (!lower.endsWith('.exe') || lower.includes('blockmap')) return Number.POSITIVE_INFINITY;
  const isArm64 = lower.includes('arm64') || lower.includes('aarch64');
  const isX64 = lower.includes('x64') || lower.includes('amd64') || (!isArm64 && !lower.includes('ia32'));

  if (process.arch === 'arm64') {
    if (isArm64) return 0;
    if (isX64) return 1; // Windows 11 ARM can run the x64 build if no native ARM64 asset exists.
  }
  if (process.arch === 'x64' && isX64 && !isArm64) return 0;
  return Number.POSITIVE_INFINITY;
}

function macAssetArchScore(name) {
  const lower = String(name || '').toLowerCase();
  if (!lower.endsWith('.dmg')) return Number.POSITIVE_INFINITY;
  if (lower.includes('universal')) return 0;
  if (lower.includes(process.arch)) return 0;
  if (!lower.includes('x64') && !lower.includes('arm64')) return 1;
  return Number.POSITIVE_INFINITY;
}

function selectInstallerAsset(assets = []) {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null;
  const score = process.platform === 'darwin' ? macAssetArchScore : windowsAssetArchScore;
  return assets
    .map(asset => ({ asset, score: score(asset?.name) }))
    .filter(item => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score || String(a.asset.name).localeCompare(String(b.asset.name)))[0]?.asset || null;
}

async function loadAndVerifyReleaseManifest(release, installerAsset, latestVersion) {
  const publicKey = getUpdaterPublicKey();
  if (!publicKey) throw new Error('Auto-install verification is not configured for this build.');
  const manifestAssets = findManifestAssets(release);
  if (!manifestAssets.length) {
    throw new Error('Release is missing signed installer verification metadata.');
  }
  const errors = [];
  for (const manifestAsset of manifestAssets) {
    try {
      const manifest = JSON.parse(await httpsGet(manifestAsset.browser_download_url));
      verifyManifestSignature(manifest, publicKey);
      return {
        manifest,
        file: findManifestFile(manifest, installerAsset.name, latestVersion),
      };
    } catch (err) {
      errors.push(`${manifestAsset.name}: ${err.message}`);
    }
  }
  throw new Error(`No signed manifest matched this installer. ${errors.join(' / ')}`);
}

function hashFile(filePath, algorithm = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const input = fs.createReadStream(filePath);
    input.on('data', chunk => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyDownloadedInstaller(filePath, fileEntry) {
  const actual = await hashFile(filePath, 'sha256');
  if (actual.toLowerCase() !== String(fileEntry.sha256 || '').toLowerCase()) {
    throw new Error('Downloaded installer checksum does not match the signed release manifest.');
  }
  if (Number.isFinite(Number(fileEntry.size)) && Number(fileEntry.size) > 0) {
    const stat = fs.statSync(filePath);
    if (stat.size !== Number(fileEntry.size)) {
      throw new Error('Downloaded installer size does not match the signed release manifest.');
    }
  }
}

// Pending update state per-window. Cleared when the user dismisses the prompt.
const pending = new Map();

function selectUpdateRelease(releases, currentVersion) {
  let selected = null;
  let selectedVersion = null;
  for (const release of releases) {
    if (!release || release.draft || !release.tag_name) continue;
    const releaseVersion = release.tag_name.replace(/^v/, '');
    if (compareVersions(currentVersion, releaseVersion) <= 0) continue;
    if (!selected || compareVersions(selectedVersion, releaseVersion) > 0) {
      selected = release;
      selectedVersion = releaseVersion;
    }
  }
  return selected;
}

async function checkForUpdates(win, t) {
  if (win.isDestroyed()) return;
  try {
    const raw = await httpsGet(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=20`
    );
    const releases = JSON.parse(raw);
    const currentVersion = app.getVersion();
    const release = Array.isArray(releases)
      ? selectUpdateRelease(releases, currentVersion)
      : null;
    if (!release) return;
    const latestVersion = release.tag_name.replace(/^v/, '');

    if (getSkippedVersion() === latestVersion) return;

    const installerAsset = selectInstallerAsset(release.assets || []);
    const manifestAssets = findManifestAssets(release);
    const verificationReady = !!installerAsset && manifestAssets.length > 0 && !!getUpdaterPublicKey();

    pending.set(win.id, { release, installerAsset, manifestAssets, t });

    if (win.isDestroyed()) return;
    win.webContents.send('show-update-dialog', {
      currentVersion,
      latestVersion,
      releaseBody: release.body ? release.body.substring(0, 500) : '',
      releaseUrl: release.html_url,
      hasInstaller: verificationReady,
      verificationNotice: installerAsset && !verificationReady
        ? 'Auto-install is disabled because signed verification metadata is missing or this build has no updater public key. Use View Release for manual download.'
        : '',
    });
  } catch {
    // Silent fail — don't bother user if offline or API unreachable
  }
}

async function handleUpdateAction(win, action) {
  const entry = pending.get(win.id);
  if (!entry) return;
  const { release, installerAsset, t } = entry;
  const latestVersion = release.tag_name.replace(/^v/, '');

  if (action === 'download-install' && installerAsset) {
    pending.delete(win.id);
    const safeFilename = path.basename(installerAsset.name);
    const destPath = path.join(app.getPath('temp'), safeFilename);
    win.setProgressBar(0.01);
    if (!win.isDestroyed()) win.webContents.send('update-progress', 0);
    try {
      const verification = await loadAndVerifyReleaseManifest(release, installerAsset, latestVersion);
      await downloadFile(
        installerAsset.browser_download_url,
        destPath,
        (progress) => {
          win.setProgressBar(progress);
          if (!win.isDestroyed()) win.webContents.send('update-progress', progress);
        }
      );
      win.setProgressBar(-1);
      if (!win.isDestroyed()) win.webContents.send('update-progress', 1);
      await verifyDownloadedInstaller(destPath, verification.file);
      writeMarker(latestVersion);
      const openErr = await shell.openPath(destPath);
      if (openErr) {
        clearMarker();
        if (!win.isDestroyed()) win.webContents.send('update-error', openErr);
        dialog.showErrorBox(t('update.errorTitle'), openErr);
      } else {
        setTimeout(() => app.quit(), 1500);
      }
    } catch (err) {
      try { fs.unlinkSync(destPath); } catch {}
      win.setProgressBar(-1);
      if (!win.isDestroyed()) win.webContents.send('update-error', err.message);
      const result = await dialog.showMessageBox(win, {
        type: 'error',
        title: t('update.errorTitle'),
        message: err.message,
        detail: 'For safety, OrPAD did not open the downloaded installer. You can review the GitHub release manually.',
        buttons: ['OK', 'View Release'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response === 1) shell.openExternal(release.html_url);
    }
  } else if (action === 'view-release') {
    shell.openExternal(release.html_url);
    pending.delete(win.id);
  } else if (action === 'skip') {
    setSkippedVersion(latestVersion);
    pending.delete(win.id);
  } else {
    pending.delete(win.id);
  }
}

module.exports = {
  checkForUpdates,
  handleUpdateAction,
  checkUpdateInProgress,
  stableStringify,
  verifyManifestSignature,
  findManifestFile,
  verifyDownloadedInstaller,
};

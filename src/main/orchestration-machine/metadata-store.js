const fs = require('fs');
const path = require('path');

const fsp = fs.promises;

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
  return dirPath;
}

async function atomicWriteFile(filePath, contents, encoding = 'utf8') {
  const target = path.resolve(filePath);
  await ensureDir(path.dirname(target));
  const tempPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fsp.writeFile(tempPath, contents, encoding);
  await fsp.rename(tempPath, target);
  return target;
}

async function writeJsonAtomic(filePath, value) {
  return atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function ensureRunLayout(runRoot) {
  const dirs = [
    '',
    'adapters',
    'artifacts',
    'checkpoints',
    'locks',
    path.join('locks', 'claims'),
    path.join('locks', 'write-sets'),
    'queue',
  ];
  for (const dir of dirs) {
    await ensureDir(path.join(runRoot, dir));
  }
}

module.exports = {
  atomicWriteFile,
  ensureDir,
  ensureRunLayout,
  readJsonIfExists,
  writeJsonAtomic,
};

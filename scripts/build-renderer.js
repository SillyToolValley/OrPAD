const path = require('path');
const fs = require('fs');

let esbuild;
try {
  esbuild = require('esbuild');
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    console.error('Missing renderer build dependency: esbuild. Run npm install or npm ci before npm run build:renderer.');
    process.exit(1);
  }
  throw err;
}

const distDir = path.join(__dirname, '../dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

const outputs = {
  renderer: path.join(distDir, 'renderer.js'),
  terminalWindow: path.join(distDir, 'terminal-window.js'),
  auditRuntime: path.join(distDir, 'audit-orpad-run.mjs'),
};

const common = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  minify: process.argv.includes('--minify'),
  sourcemap: false,
  target: ['chrome120'],
  loader: { '.css': 'text' },
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.ORPAD_WEB': '"false"',
    'process.env.PLAUSIBLE_DOMAIN': JSON.stringify(process.env.PLAUSIBLE_DOMAIN || ''),
    'process.env.APP_VERSION': JSON.stringify(require('../package.json').version),
  },
};

const browserSafeAliases = {
  name: 'browser-safe-aliases',
  setup(build) {
    build.onResolve({ filter: /^isomorphic-git$/ }, () => ({
      path: path.join(__dirname, '../node_modules/isomorphic-git/index.js'),
    }));
  },
};

Promise.all([
  esbuild.build({
    ...common,
    entryPoints: [path.join(__dirname, '../src/renderer/renderer.js')],
    outfile: outputs.renderer,
    plugins: [browserSafeAliases],
  }),
  esbuild.build({
    ...common,
    entryPoints: [path.join(__dirname, '../src/renderer/terminal-window.js')],
    outfile: outputs.terminalWindow,
  }),
  // The run-evidence audit (scripts/audit-orpad-run.mjs) is spawned as a child
  // process by the main process (runbooks/ipc.js). A spawned process cannot read
  // inside app.asar, so bundle the script + ALL its deps (audit-orpad-node-schemas,
  // runbooks/work-items, ajv) into one self-contained CJS file that is asar-unpacked
  // and runnable by the bundled Electron binary via ELECTRON_RUN_AS_NODE.
  esbuild.build({
    bundle: true,
    platform: 'node',
    // ESM output: the script uses top-level await and import.meta.url, neither of
    // which is supported by esbuild's "cjs" format. Output .mjs so node runs it as ESM.
    format: 'esm',
    target: ['node18'],
    minify: false,
    sourcemap: false,
    entryPoints: [path.join(__dirname, '../scripts/audit-orpad-run.mjs')],
    outfile: outputs.auditRuntime,
    // Bundled CommonJS deps (e.g. work-items) call require('fs'/'path'); in ESM
    // output esbuild's require shim throws unless a real require is in scope. Inject
    // one so builtin requires resolve natively (all non-builtins are inlined).
    banner: { js: "import { createRequire as __orpadCreateRequire } from 'node:module';\nconst require = __orpadCreateRequire(import.meta.url);" },
  }),
]).then(() => {
  const missing = Object.values(outputs).filter((outputPath) => !fs.existsSync(outputPath));
  if (missing.length > 0) {
    throw new Error(`Renderer build completed but missing expected output(s): ${missing.join(', ')}`);
  }

  const outputSummary = Object.values(outputs).map((outputPath) => {
    const sizeKb = (fs.statSync(outputPath).size / 1024).toFixed(1);
    return `${path.basename(outputPath)} ${sizeKb} KB`;
  });
  console.log(`OrPAD renderer bundled successfully: ${outputSummary.join(', ')}.`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

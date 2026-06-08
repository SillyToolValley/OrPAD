/**
 * Bundle size check for OrPAD web build.
 *
 * Builds the minified web renderer in memory so CI and local checks do not
 * touch the deploy artifact in docs/. The script measures gzip sizes for the
 * renderer and rewritten web index.html, writes a JSON report plus the esbuild
 * metafile, and exits non-zero when any budget is exceeded.
 *
 * Usage: node scripts/bundle-size.mjs
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { gzipSync } from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

// Ideal target is 1.8 MB; kept at current+10% until the heavy diagram stack is split.
const RENDERER_BUDGET_BYTES = Math.round(2.05 * 1024 * 1024);
const HTML_BUDGET_BYTES = 100 * 1024;
const INSTALLER_BUDGET_BYTES = 100 * 1024 * 1024;
const WEB_TARGETS = ['chrome90', 'firefox90', 'safari14', 'edge90'];

const kb = (value) => `${(value / 1024).toFixed(1)} KB`;
const mb = (value) => `${(value / 1024 / 1024).toFixed(2)} MB`;
const posixPath = (value) => value.replace(/\\/g, '/');
const relativeFromRoot = (file) => posixPath(path.relative(ROOT, file) || file);

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

console.log('Bundling minified web renderer (in-memory)...');

const result = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/web/entry.js')],
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'iife',
  sourcemap: false,
  target: WEB_TARGETS,
  loader: { '.css': 'text', '.png': 'dataurl' },
  plugins: [
    {
      name: 'desktop-terminal-stub',
      setup(build) {
        build.onResolve({ filter: /^isomorphic-git$/ }, () => ({
          path: path.join(ROOT, 'node_modules/isomorphic-git/index.js'),
        }));
        build.onResolve({ filter: /^@sentry\/electron\/renderer$/ }, () => ({
          path: path.join(ROOT, 'src/web/sentry-renderer-stub.js'),
        }));
        build.onResolve({ filter: /^\.\/pty-view\.js$/ }, (args) => {
          if (posixPath(args.importer).endsWith('/src/renderer/terminal/panel.js')) {
            return { path: path.join(ROOT, 'src/web/terminal-pty-stub.js') };
          }
          return undefined;
        });
      },
    },
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.ORPAD_WEB': '"true"',
    'process.env.SENTRY_DSN': JSON.stringify(process.env.SENTRY_DSN || ''),
    'process.env.PLAUSIBLE_DOMAIN': JSON.stringify(process.env.PLAUSIBLE_DOMAIN || ''),
    'process.env.APP_VERSION': JSON.stringify(PACKAGE.version),
  },
  write: false,
  metafile: true,
});

const rendererOutput = result.outputFiles?.[0];
if (!rendererOutput) {
  throw new Error('esbuild did not produce a renderer output file.');
}

const rendererBuf = Buffer.from(rendererOutput.contents);
const metafile = result.metafile;
writeJson(path.join(ROOT, 'state', 'bundle-meta.json'), metafile);

const top15Modules = Object.entries(metafile.inputs)
  .map(([file, data]) => ({ file: relativeFromRoot(file), bytes: data.bytes }))
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 15);

const srcHtml = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf-8');
const pwaHead = [
  '  <link rel="manifest" href="manifest.webmanifest">',
  '  <meta name="theme-color" content="#0f172a">',
  '  <meta name="apple-mobile-web-app-capable" content="yes">',
  '  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '  <meta name="apple-mobile-web-app-title" content="OrPAD">',
  '  <link rel="apple-touch-icon" href="icons/icon-192.png">',
].join('\n');
const builtHtml = srcHtml
  .replace(
    /<meta http-equiv="Content-Security-Policy" content="[^"]+">/,
    '<meta http-equiv="Content-Security-Policy" content="' +
      "default-src 'self'; " +
      "script-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; " +
      "font-src 'self' data:; " +
      "connect-src 'self' https://*; " +
      "worker-src 'self' blob:; " +
      "frame-src 'none'; " +
      "object-src 'none'; " +
      "base-uri 'none'; " +
      "form-action 'none';" +
      '">'
  )
  .replace(
    /<script src="\.\.\/\.\.\/dist\/renderer\.js"><\/script>/,
    '<script src="renderer.js"></script>'
  )
  .replace('  <title>OrPAD</title>', `${pwaHead}\n  <title>OrPAD</title>`);

const rendererGzip = gzipSync(rendererBuf).length;
const htmlBuf = Buffer.from(builtHtml, 'utf-8');
const htmlGzip = gzipSync(htmlBuf).length;
const rendererRaw = rendererBuf.length;
const htmlRaw = htmlBuf.length;

const rendererPassed = rendererGzip <= RENDERER_BUDGET_BYTES;
const htmlPassed = htmlGzip <= HTML_BUDGET_BYTES;
let failed = !rendererPassed || !htmlPassed;

console.log('\nBundle Size Report');
console.log(`  renderer.js   raw: ${kb(rendererRaw).padStart(10)}   gzip: ${mb(rendererGzip).padStart(8)}   budget: ${mb(RENDERER_BUDGET_BYTES)}`);
console.log(`  index.html    raw: ${kb(htmlRaw).padStart(10)}   gzip: ${kb(htmlGzip).padStart(8)}   budget: ${kb(HTML_BUDGET_BYTES)}`);
console.log('\n  Top 15 modules by uncompressed size:');
for (const { file, bytes } of top15Modules) {
  console.log(`    ${kb(bytes).padStart(10)}  ${file}`);
}

const report = {
  timestamp: new Date().toISOString(),
  package_version: PACKAGE.version,
  budgets: {
    renderer_gzip_max_bytes: RENDERER_BUDGET_BYTES,
    html_gzip_max_bytes: HTML_BUDGET_BYTES,
  },
  actual: {
    renderer_raw_bytes: rendererRaw,
    renderer_gzip_bytes: rendererGzip,
    html_raw_bytes: htmlRaw,
    html_gzip_bytes: htmlGzip,
  },
  checks: {
    renderer_gzip: {
      passed: rendererPassed,
      over_budget_bytes: Math.max(0, rendererGzip - RENDERER_BUDGET_BYTES),
    },
    html_gzip: {
      passed: htmlPassed,
      over_budget_bytes: Math.max(0, htmlGzip - HTML_BUDGET_BYTES),
    },
  },
  passed: rendererPassed && htmlPassed,
  top15_modules: top15Modules,
};
writeJson(path.join(ROOT, 'bundle-size-report.json'), report);
console.log('\nReport written to bundle-size-report.json');
console.log('Metafile written to state/bundle-meta.json');

if (!rendererPassed) {
  console.error(`\nFAIL: renderer.js gzipped (${mb(rendererGzip)}) exceeds budget (${mb(RENDERER_BUDGET_BYTES)})`);
}
if (!htmlPassed) {
  console.error(`\nFAIL: index.html gzipped (${kb(htmlGzip)}) exceeds budget (${kb(HTML_BUDGET_BYTES)})`);
}

const releaseDir = path.join(ROOT, 'release');
if (fs.existsSync(releaseDir)) {
  const exeFiles = fs.readdirSync(releaseDir).filter((file) => file.toLowerCase().endsWith('.exe'));
  if (exeFiles.length > 0) {
    for (const file of exeFiles) {
      const size = fs.statSync(path.join(releaseDir, file)).size;
      const passed = size <= INSTALLER_BUDGET_BYTES;
      console.log(`Installer: ${mb(size)} (target ${mb(INSTALLER_BUDGET_BYTES)}) ${passed ? 'PASS' : 'FAIL'} ${file}`);
      if (!passed) failed = true;
    }
  } else {
    console.log('Installer: not built yet (run npm run dist:win to measure)');
  }
} else {
  console.log('Installer: not built yet (run npm run dist:win to measure)');
}

if (!failed) {
  console.log('\nPASS: bundle within budget.');
}

process.exit(failed ? 1 : 0);

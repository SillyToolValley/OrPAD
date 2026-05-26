// Builds the OrPAD web app into docs/ (GitHub Pages target).
//
// Inputs:
//   src/web/entry.js              installs the browser adapter then imports the renderer
//   src/renderer/index.html       desktop HTML shell (rewritten for web)
//   src/renderer/styles/*.css     style assets
//   src/renderer/orpad-mark.png   welcome-screen icon
//   registry/*.json               public package Registry metadata
//
// Output tree in docs/:
//   docs/index.html
//   docs/renderer.js        (bundled JS)
//   docs/styles/base.css
//   docs/styles/katex.min.css
//   docs/orpad-mark.png
//   docs/manifest.webmanifest
//   docs/sw.js
//   docs/icons/*.png
//   docs/registry/*.json
//   docs/.nojekyll

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs');
const PACKAGE = require('../package.json');
const WEB_TARGETS = ['chrome90', 'firefox90', 'safari14', 'edge90'];
// The web manifest uses relative start_url/scope/action values so the same
// artifact works on GitHub Pages, localhost, and a future root custom domain.

function emptyDir(dir) {
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); return; }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  }
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else copyFile(src, dest);
  }
}

function injectPwaHead(html) {
  if (html.includes('rel="manifest"')) return html;
  const pwaHead = [
    '  <link rel="manifest" href="manifest.webmanifest">',
    '  <meta name="theme-color" content="#0f172a">',
    '  <meta name="apple-mobile-web-app-capable" content="yes">',
    '  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    '  <meta name="apple-mobile-web-app-title" content="OrPAD">',
    '  <link rel="apple-touch-icon" href="icons/icon-192.png">',
  ].join('\n');
  if (html.includes('  <title>OrPAD</title>')) {
    return html.replace('  <title>OrPAD</title>', `${pwaHead}\n  <title>OrPAD</title>`);
  }
  return html.replace('</head>', `${pwaHead}\n</head>`);
}

function buildIndexHtml(srcHtml) {
  let html = fs.readFileSync(srcHtml, 'utf-8');

  // Mirror the renderer CSP for the web build. connect-src allows https://* to
  // support the planned P1-7 URL-open feature (orpad.io/edit?src=<url>).
  html = html.replace(
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
  );

  // Desktop build loads dist/renderer.js from two levels up; web build colocates.
  html = html.replace(
    /<script src="\.\.\/\.\.\/dist\/renderer\.js"><\/script>/,
    '<script src="renderer.js"></script>'
  );

  return injectPwaHead(html);
}

function copyPwaAssets() {
  copyFile(
    path.join(ROOT, 'src/web/manifest.webmanifest'),
    path.join(OUT, 'manifest.webmanifest')
  );
  copyDir(
    path.join(ROOT, 'src/web/icons'),
    path.join(OUT, 'icons')
  );

  const katexFontUrls = fs.existsSync(path.join(OUT, 'styles', 'fonts'))
    ? fs.readdirSync(path.join(OUT, 'styles', 'fonts'))
        .filter(name => /\.(woff2?|ttf)$/i.test(name))
        .sort()
        .map(name => `styles/fonts/${name}`)
    : [];

  const sw = fs.readFileSync(path.join(ROOT, 'src/web/sw.js'), 'utf-8')
    .replace(/__ORPAD_SW_VERSION__/g, PACKAGE.version)
    .replace(/__ORPAD_KATEX_FONT_URLS__/g, JSON.stringify(katexFontUrls));
  fs.writeFileSync(path.join(OUT, 'sw.js'), sw, 'utf-8');
}

async function main() {
  const minify = process.argv.includes('--minify');

  console.log('OrPAD web build -> ' + path.relative(ROOT, OUT));
  emptyDir(OUT);

  // Bundle the renderer + adapter.
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/web/entry.js')],
    bundle: true,
    outfile: path.join(OUT, 'renderer.js'),
    platform: 'browser',
    format: 'iife',
    minify,
    sourcemap: false,
    target: WEB_TARGETS,
    loader: { '.css': 'text', '.png': 'dataurl' },
    plugins: [{
      name: 'desktop-terminal-stub',
      setup(build) {
        build.onResolve({ filter: /^isomorphic-git$/ }, () => ({
          path: path.join(ROOT, 'node_modules/isomorphic-git/index.js'),
        }));
        build.onResolve({ filter: /^@sentry\/electron\/renderer$/ }, () => ({
          path: path.join(ROOT, 'src/web/sentry-renderer-stub.js'),
        }));
        build.onResolve({ filter: /^\.\/pty-view\.js$/ }, (args) => {
          if (args.importer.replace(/\\/g, '/').endsWith('/src/renderer/terminal/panel.js')) {
            return { path: path.join(ROOT, 'src/web/terminal-pty-stub.js') };
          }
          return undefined;
        });
      },
    }],
    define: {
      'process.env.NODE_ENV': minify ? '"production"' : '"development"',
      'process.env.ORPAD_WEB': '"true"',
      'process.env.SENTRY_DSN': JSON.stringify(process.env.SENTRY_DSN || ''),
      'process.env.PLAUSIBLE_DOMAIN': JSON.stringify(process.env.PLAUSIBLE_DOMAIN || ''),
      'process.env.APP_VERSION': JSON.stringify(PACKAGE.version),
    },
  });

  // HTML shell
  fs.writeFileSync(
    path.join(OUT, 'index.html'),
    buildIndexHtml(path.join(ROOT, 'src/renderer/index.html')),
    'utf-8'
  );

  // Styles
  const stylesDir = path.join(ROOT, 'src/renderer/styles');
  for (const name of fs.readdirSync(stylesDir)) {
    if (name.endsWith('.css')) {
      copyFile(path.join(stylesDir, name), path.join(OUT, 'styles', name));
    }
  }
  copyFile(
    path.join(ROOT, 'src/renderer/ui-scale.js'),
    path.join(OUT, 'ui-scale.js')
  );
  copyDir(
    path.join(ROOT, 'node_modules/katex/dist/fonts'),
    path.join(OUT, 'styles', 'fonts')
  );

  // Welcome icon
  copyFile(
    path.join(ROOT, 'src/renderer/orpad-mark.png'),
    path.join(OUT, 'orpad-mark.png')
  );

  // PWA assets
  copyPwaAssets();

  // Public Package Manager registry
  const registryDir = path.join(ROOT, 'registry');
  if (fs.existsSync(registryDir)) {
    copyDir(registryDir, path.join(OUT, 'registry'));
  }

  // GitHub Pages: don't run through Jekyll
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '', 'utf-8');

  const sizeKb = (fs.statSync(path.join(OUT, 'renderer.js')).size / 1024).toFixed(0);
  console.log(`  renderer.js  ${sizeKb} KB${minify ? ' (minified)' : ''}`);
  console.log('OrPAD web build complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

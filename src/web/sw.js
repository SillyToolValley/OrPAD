const ORPAD_SW_VERSION = '__ORPAD_SW_VERSION__';
const KATEX_FONT_URLS = __ORPAD_KATEX_FONT_URLS__;

const APP_SHELL_CACHE = `orpad-app-shell-${ORPAD_SW_VERSION}`;
const RUNTIME_CACHE = `orpad-runtime-${ORPAD_SW_VERSION}`;
const GITHUB_API_CACHE = `orpad-github-api-${ORPAD_SW_VERSION}`;
const CURRENT_CACHES = new Set([
  APP_SHELL_CACHE,
  RUNTIME_CACHE,
  GITHUB_API_CACHE,
]);

const APP_SHELL_URLS = [
  './',
  'index.html',
  'renderer.js',
  'theme-boot.js',
  'styles/base.css',
  'styles/katex.min.css',
  'orpad-mark.png',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  ...KATEX_FONT_URLS,
];

const APP_SHELL_SUFFIXES = [
  '/index.html',
  '/renderer.js',
  '/theme-boot.js',
  '/styles/base.css',
  '/styles/katex.min.css',
  '/orpad-mark.png',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  ...KATEX_FONT_URLS.map(url => `/${url}`),
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then(cache => cache.addAll(APP_SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map((key) => {
        if (key.startsWith('orpad-') && !CURRENT_CACHES.has(key)) {
          return caches.delete(key);
        }
        return undefined;
      })))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

function isSameOriginGet(request, url) {
  return request.method === 'GET' && url.origin === self.location.origin;
}

function isAppShellAsset(url) {
  const scopePath = new URL(self.registration.scope).pathname;
  if (url.pathname === scopePath) return true;
  return APP_SHELL_SUFFIXES.some(suffix => url.pathname.endsWith(suffix));
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) await cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheName, timeoutMs = 5000) {
  const cache = await caches.open(cacheName);
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('network timeout')), timeoutMs);
  });
  try {
    const response = await Promise.race([fetch(request), timeout]);
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error('Network unavailable and no cached response exists.');
  }
}

async function navigateFallback(request) {
  const cache = await caches.open(APP_SHELL_CACHE);
  const scopeUrl = new URL('./', self.registration.scope).href;
  const indexUrl = new URL('index.html', self.registration.scope).href;
  return await cache.match(scopeUrl)
    || await cache.match(indexUrl)
    || await fetch(request);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(navigateFallback(request));
    return;
  }

  if (isSameOriginGet(request, url) && isAppShellAsset(url)) {
    event.respondWith(cacheFirst(request, APP_SHELL_CACHE));
    return;
  }

  if (request.method === 'GET' && url.hostname === 'api.github.com') {
    event.respondWith(networkFirst(request, GITHUB_API_CACHE));
    return;
  }

  if (request.method === 'GET' && (request.destination === 'script' || request.destination === 'style' || request.destination === 'font')) {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
  }
});

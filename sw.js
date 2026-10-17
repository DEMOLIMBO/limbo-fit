'use strict';

// Only the public application shell belongs here. Personal records remain in
// the diary's device-local storage and are never sent to the service worker.
const VERSION = '1.4.0';
const CACHE_PREFIX = 'limbo-fit-shell-';
const CACHE_NAME = CACHE_PREFIX + 'v' + VERSION;
const BASE = new URL('./', self.location.href);
const INDEX_URL = new URL('index.html', BASE).href;
const REQUIRED_FILES = ['index.html', 'styles.css', 'pwa.css', 'app.js', 'model.js', 'workspace.js', 'pwa.js'];
const OPTIONAL_FILES = ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/apple-touch-icon.png', 'icons/maskable-512.png', 'icons/favicon.svg'];
const REQUIRED_URLS = REQUIRED_FILES.map(path => new URL(path, BASE).href);
const SHELL_URLS = new Set(REQUIRED_FILES.concat(OPTIONAL_FILES).map(path => new URL(path, BASE).href));

function filename(url) { return new URL(url).pathname.split('/').pop(); }

async function isShellResponse(response, url) {
  if (!response || !response.ok || response.redirected || response.type === 'opaque') return false;
  if (response.url && response.url !== url) return false;
  const type = (response.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
  const path = new URL(url).pathname;
  if (path.endsWith('.html')) {
    if (type !== 'text/html') return false;
    const html = await response.clone().text();
    return /<title>Limbo Fit(?:\s|—)/.test(html) && /id=["']main["']/.test(html);
  }
  if (path.endsWith('.js')) return /^(?:text|application)\/(?:javascript|ecmascript)$/.test(type);
  if (path.endsWith('.css')) return type === 'text/css';
  if (path.endsWith('.png')) return type === 'image/png';
  if (path.endsWith('.svg')) return type === 'image/svg+xml';
  if (path.endsWith('.webmanifest')) return /^(?:application\/(?:manifest\+json|json)|text\/plain)$/.test(type);
  return false;
}

// A stalled connection must not leave installation or a missing-file recovery
// pending indefinitely. The limit includes response-body validation.
async function fetchShell(url, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(new Request(url, {
          cache: 'reload', credentials: 'same-origin', redirect: 'error', signal: controller.signal
        }));
        if (!await isShellResponse(response, url)) throw new Error('Invalid app file: ' + filename(url));
        // Headers can arrive while a script/style body never completes. Buffer
        // every body before the same deadline ends; cache.put then receives a
        // complete response and cannot wait forever on the network stream.
        const bytes = await response.arrayBuffer();
        return new Response(bytes, {
          status: response.status, statusText: response.statusText, headers: response.headers
        });
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('App file timeout: ' + filename(url)));
        }, timeoutMs);
      })
    ]);
  } finally { clearTimeout(timer); }
}

async function missingRequired() {
  if (!await caches.has(CACHE_NAME)) return REQUIRED_FILES.slice();
  const cache = await caches.open(CACHE_NAME);
  const checks = await Promise.all(REQUIRED_URLS.map(async url => {
    try { return await isShellResponse(await cache.match(url), url) ? null : filename(url); }
    catch (_) { return filename(url); }
  }));
  return checks.filter(Boolean);
}

async function notifyInstallFailure(missing) {
  try {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const message = {
      type: 'LIMBO_OFFLINE_ERROR', version: VERSION, missing,
      message: 'Не удалось сохранить приложение для работы без интернета. Проверьте соединение и повторите загрузку.'
    };
    windows.forEach(client => client.postMessage(message));
  } catch (_) { /* A closed window must not prevent the worker from failing safely. */ }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    let missing = REQUIRED_FILES.slice();
    try {
      // Optional installation imagery/manifest cannot block the seven core files.
      const results = await Promise.all(REQUIRED_FILES.concat(OPTIONAL_FILES).map(async path => {
        const url = new URL(path, BASE).href;
        const timeoutMs = REQUIRED_FILES.includes(path) ? 15000 : 3000;
        try { return { url, response: await fetchShell(url, timeoutMs) }; }
        catch (_) { return { url, response: null }; }
      }));
      const required = results.slice(0, REQUIRED_FILES.length);
      missing = required.filter(result => !result.response).map(result => filename(result.url));
      if (missing.length) throw new Error('Required app files are unavailable');
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(required.map(result => cache.put(result.url, result.response)));
      missing = await missingRequired();
      if (missing.length) throw new Error('Required app files were not saved');
      await Promise.all(results.slice(REQUIRED_FILES.length).map(async result => {
        if (result.response) {
          try { await cache.put(result.url, result.response); } catch (_) { /* Optional file. */ }
        }
      }));
    } catch (_) {
      // Never touch the active older version when a new version is incomplete.
      await caches.delete(CACHE_NAME);
      await notifyInstallFailure(missing.length ? missing : REQUIRED_FILES.slice());
      throw new Error('Limbo Fit: офлайн-загрузка не завершена');
    }
    // No skipWaiting: an open form stays on its current complete version.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const data = event.data;
  if (!data || data.type !== 'LIMBO_OFFLINE_STATUS' || !event.ports || !event.ports[0]) return;
  event.waitUntil((async () => {
    let missing;
    try { missing = await missingRequired(); } catch (_) { missing = REQUIRED_FILES.slice(); }
    event.ports[0].postMessage({
      type: 'LIMBO_OFFLINE_STATUS', requestId: data.requestId,
      version: VERSION, ready: missing.length === 0, missing
    });
  })());
});

function offlineError() {
  return new Response('Limbo Fit пока не сохранён для работы без интернета. Подключитесь к интернету, откройте приложение и дождитесь сообщения «Готово без интернета». Ваши записи остаются на этом устройстве.', {
    status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function navigate() {
  try {
    if (await caches.has(CACHE_NAME)) {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(INDEX_URL);
      if (await isShellResponse(cached, INDEX_URL)) return cached;
    }
    // A complete shell opens immediately, even if the network would hang.
    return await fetchShell(INDEX_URL, 8000);
  } catch (_) { return offlineError(); }
}

async function staticAsset(request) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request.url);
    if (await isShellResponse(cached, request.url)) return cached;
    const response = await fetchShell(request.url, 8000);
    try { await cache.put(request.url, response.clone()); } catch (_) { /* Storage may be full. */ }
    return response;
  } catch (_) { return offlineError(); }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('authorization')) return;
  const url = new URL(request.url);
  if (url.origin !== BASE.origin) return;
  const appDocument = url.pathname === BASE.pathname || url.pathname === new URL(INDEX_URL).pathname;
  if (request.mode === 'navigate' && appDocument) {
    // A launch query such as ?source=home does not change the cached document.
    event.respondWith(navigate());
  } else if (!url.search && SHELL_URLS.has(url.href)) {
    event.respondWith(staticAsset(request));
  }
});


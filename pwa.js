(() => {
  'use strict';
  const OFFLINE_VERSION = '1.3.0';
  const $ = selector => document.querySelector(selector);
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const iphone = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const state = { phase:'loading', detail:'Сохраняем файлы приложения на устройстве.' };
  const watchedWorkers = new WeakSet(), watchedRegistrations = new WeakSet();
  let registration = null, attempt = 0, deadline = null, checking = false, checkAgain = false, requestSequence = 0;

  function viewport() {
    const vv = window.visualViewport;
    document.documentElement.style.setProperty('--app-height', `${Math.round(vv ? vv.height : innerHeight)}px`);
    document.documentElement.style.setProperty('--viewport-top', `${Math.round(vv ? vv.offsetTop : 0)}px`);
  }
  viewport();
  window.addEventListener('resize', viewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', viewport);
    window.visualViewport.addEventListener('scroll', viewport);
  }

  function statusText() {
    if (state.phase === 'ready') return 'Готово к работе без интернета';
    if (state.phase === 'waiting') return 'Доступно обновление приложения';
    if (state.phase === 'error') return 'Офлайн-загрузка не завершена';
    return 'Подготовка к работе без интернета';
  }

  function renderStatus() {
    let panel = $('#pwa-offline-panel');
    if (!panel) {
      const header = $('.app-header');
      if (!header) return;
      panel = document.createElement('section');
      panel.id = 'pwa-offline-panel';
      panel.className = 'pwa-offline-panel';
      panel.setAttribute('aria-label', 'Работа без интернета');
      panel.innerHTML = '<div class="pwa-offline-copy" role="status" aria-live="polite" aria-atomic="true"><p class="pwa-offline-status"></p><p class="pwa-offline-detail"></p></div><button type="button" class="pwa-offline-retry" hidden>Повторить</button>';
      panel.querySelector('button').addEventListener('click', () => prepareOffline(true));
      header.parentNode.insertBefore(panel, header.nextSibling);
    }
    panel.dataset.state = state.phase;
    const title = panel.querySelector('.pwa-offline-status');
    const detail = panel.querySelector('.pwa-offline-detail');
    if (title.textContent !== statusText()) title.textContent = statusText();
    if (detail.textContent !== state.detail) detail.textContent = state.detail;
    detail.hidden = !state.detail;
    panel.querySelector('button').hidden = state.phase !== 'error';
  }

  function setState(phase, detail = '') {
    state.phase = phase;
    state.detail = detail;
    if (phase !== 'loading' && deadline) { clearTimeout(deadline); deadline = null; }
    renderStatus();
  }
  function failOffline(detail = 'Подключитесь к интернету и нажмите «Повторить». Записи на устройстве сохранены.') {
    setState('error', detail);
  }

  function afterRender() {
    // This panel is outside #main: async readiness never recreates diary forms.
    renderStatus();
    const old = $('#pwa-install');
    if (old) old.remove();
    const onProfile = !!$('.app-version');
    if (!standalone() && (iphone() || onProfile)) {
      const guide = document.createElement('details');
      guide.id = 'pwa-install';
      guide.className = 'install-guide';
      guide.innerHTML = '<summary>Как установить на iPhone</summary><ol><li>Откройте эту ссылку в Safari.</li><li>Нажмите «Поделиться» → «На экран “Домой”».</li><li>Оставьте «Открыть как веб-приложение» включённым, если такой переключатель есть, и нажмите «Добавить».</li><li>Первый раз откройте Limbo Fit через появившуюся иконку с интернетом. Дождитесь сообщения «Готово к работе без интернета».</li></ol><p>Записи хранятся на этом устройстве. Сохраняйте резервные копии перед очисткой данных сайта или удалением приложения.</p>';
      const main = $('#main');
      if (main) {
        if (onProfile) main.appendChild(guide);
        else main.insertBefore(guide, main.firstChild);
      }
    }
  }

  function withTimeout(promise, milliseconds) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Offline preparation timeout')), milliseconds);
      Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }

  function askWorker(worker) {
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const requestId = `${Date.now()}-${++requestSequence}`;
      let finished = false;
      const finish = (error, data) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        channel.port1.close();
        channel.port2.close();
        if (error) reject(error); else resolve(data);
      };
      const timer = setTimeout(() => finish(new Error('Offline status timeout')), 3000);
      channel.port1.onmessage = event => {
        const data = event.data;
        if (data && data.type === 'LIMBO_OFFLINE_STATUS' && data.requestId === requestId) finish(null, data);
      };
      if (channel.port1.start) channel.port1.start();
      try { worker.postMessage({type:'LIMBO_OFFLINE_STATUS', requestId}, [channel.port2]); }
      catch (error) { finish(error); }
    });
  }

  function watchWorkers() {
    if (!registration) return;
    for (const worker of [registration.installing, registration.waiting, registration.active]) {
      if (!worker || watchedWorkers.has(worker)) continue;
      watchedWorkers.add(worker);
      worker.addEventListener('statechange', inspectOffline);
    }
  }

  async function inspectOffline() {
    if (!registration) return;
    watchWorkers();
    if (checking) { checkAgain = true; return; }
    if (registration.waiting) {
      setState('waiting', 'Закройте все окна Limbo Fit и откройте приложение снова с интернетом.');
      return;
    }
    const worker = navigator.serviceWorker.controller;
    if (!worker) {
      const installing = registration.installing;
      if ((!installing || installing.state === 'redundant') && !registration.active) failOffline();
      return; // First activation claims this page via controllerchange.
    }
    checking = true;
    checkAgain = false;
    const thisAttempt = attempt;
    try {
      const result = await askWorker(worker);
      if (thisAttempt !== attempt) return;
      if (navigator.serviceWorker.controller !== worker) { checkAgain = true; return; }
      if (registration.waiting) {
        setState('waiting', 'Закройте все окна Limbo Fit и откройте приложение снова с интернетом.');
      } else if (result.version === OFFLINE_VERSION && result.ready === true && Array.isArray(result.missing) && result.missing.length === 0) {
        setState('ready');
      } else if (!registration.installing) {
        failOffline('Не все файлы приложения сохранены для офлайн-запуска. Подключитесь к интернету и нажмите «Повторить».');
      }
    } catch (_) {
      if (thisAttempt === attempt && !registration.installing && !registration.waiting) {
        failOffline('Не удалось проверить офлайн-загрузку. Подключитесь к интернету и нажмите «Повторить».');
      }
    } finally {
      checking = false;
      if (checkAgain || thisAttempt !== attempt) { checkAgain = false; inspectOffline(); }
    }
  }

  function adoptRegistration(next) {
    registration = next;
    if (!watchedRegistrations.has(next)) {
      watchedRegistrations.add(next);
      next.addEventListener('updatefound', () => { watchWorkers(); inspectOffline(); });
    }
    watchWorkers();
  }

  async function prepareOffline(retry = false) {
    const thisAttempt = ++attempt;
    if (deadline) clearTimeout(deadline);
    setState('loading', 'Сохраняем файлы приложения на устройстве.');
    if (!('serviceWorker' in navigator) || !window.isSecureContext || typeof MessageChannel === 'undefined') {
      failOffline('В этом браузере офлайн-загрузка недоступна. Откройте ссылку в Safari.');
      return;
    }
    deadline = setTimeout(() => {
      if (thisAttempt === attempt && state.phase === 'loading') failOffline('Подготовка заняла слишком много времени. Проверьте интернет и нажмите «Повторить».');
    }, 20000);
    try {
      // An already installed worker can prove readiness while the network is
      // unavailable. An update-check failure must not hide a working cache.
      let existing = null;
      try { existing = await withTimeout(navigator.serviceWorker.getRegistration(), 3000); }
      catch (_) { /* A fresh registration can still succeed. */ }
      if (thisAttempt !== attempt) return;
      if (existing) { adoptRegistration(existing); await inspectOffline(); }
      const next = await withTimeout(navigator.serviceWorker.register('./sw.js', {scope:'./', updateViaCache:'none'}), 10000);
      if (thisAttempt !== attempt) return;
      adoptRegistration(next);
      if (retry && !next.installing && !next.waiting) {
        try { await withTimeout(next.update(), 10000); }
        catch (_) { /* The cache handshake, not update connectivity, decides readiness. */ }
      }
      if (thisAttempt !== attempt) return;
      await inspectOffline();
    } catch (_) {
      if (thisAttempt === attempt && state.phase !== 'ready' && state.phase !== 'waiting') failOffline('Не удалось загрузить офлайн-версию. Проверьте, что ссылка открывается с интернетом, и нажмите «Повторить».');
    }
  }

  async function exportBackup(json) {
    const date = new Date();
    const name = `limbo-fit-backup-${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}.json`;
    const file = new File([json], name, {type:'application/json'});
    if (iphone() && navigator.canShare && navigator.canShare({files:[file]})) {
      try { await navigator.share({files:[file],title:'Резервная копия Limbo Fit'}); return; }
      catch (error) { if (error.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file), a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  window.LimboPWA = {afterRender, exportBackup, retryOffline:() => prepareOffline(true)};
  afterRender();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', inspectOffline);
    navigator.serviceWorker.addEventListener('message', event => {
      const data = event.data;
      if (event.source === navigator.serviceWorker.controller && data && data.type === 'LIMBO_OFFLINE_ERROR' && data.version === OFFLINE_VERSION) failOffline();
    });
  }
  window.addEventListener('online', () => { if (state.phase === 'error') prepareOffline(true); });
  prepareOffline();
})();

// collector-v8.js — Collector with use() plugin system (HW3 Module 09)
// Revealing-module IIFE: everything is private except the returned API.
const collector = (function() {
  'use strict';

  const defaults = {
    endpoint: '/collect',
    enableTechnographics: true,
    enableTiming: true,
    enableVitals: true,
    enableErrors: true,
    sampleRate: 1.0,
    debug: false
  };

  let config = {};
  let initialized = false;
  const globalProps = {};
  const extensions = {};

  function log(...args) {
    if (config.debug) console.log('[Collector]', ...args);
  }

  function warn(...args) {
    console.warn('[Collector]', ...args);
  }

  function getSessionId() {
    let sid = sessionStorage.getItem('_collector_sid');
    if (!sid) {
      sid = Math.random().toString(36).substring(2) + Date.now().toString(36);
      sessionStorage.setItem('_collector_sid', sid);
    }
    return sid;
  }

  function shouldSample() {
    // Sampling is per-session, not per-page - a user must be either tracked
    // on every page of their visit or none, never a mix.
    const sampled = sessionStorage.getItem('_collector_sampled');
    if (sampled !== null) return sampled === 'true';
    const result = Math.random() < config.sampleRate;
    sessionStorage.setItem('_collector_sampled', String(result));
    return result;
  }

  function getTechnographics() {
    let networkInfo = {};
    if ('connection' in navigator) {
      const conn = navigator.connection;
      networkInfo = {
        effectiveType: conn.effectiveType,
        downlink: conn.downlink,
        rtt: conn.rtt,
        saveData: conn.saveData
      };
    }

    return {
      userAgent: navigator.userAgent,
      language: navigator.language,
      cookiesEnabled: navigator.cookieEnabled,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      pixelRatio: window.devicePixelRatio,
      cores: navigator.hardwareConcurrency || 0,
      memory: navigator.deviceMemory || 0,
      network: networkInfo,
      colorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark' : 'light',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };
  }

  function round(n) {
    return Math.round(n * 100) / 100;
  }

  function getNavigationTiming() {
    const entries = performance.getEntriesByType('navigation');
    if (!entries.length) return {};
    const n = entries[0];
    return {
      dnsLookup: round(n.domainLookupEnd - n.domainLookupStart),
      tcpConnect: round(n.connectEnd - n.connectStart),
      tlsHandshake: n.secureConnectionStart > 0
        ? round(n.connectEnd - n.secureConnectionStart) : 0,
      ttfb: round(n.responseStart - n.requestStart),
      download: round(n.responseEnd - n.responseStart),
      domInteractive: round(n.domInteractive - n.fetchStart),
      domComplete: round(n.domComplete - n.fetchStart),
      loadEvent: round(n.loadEventEnd - n.fetchStart),
      fetchTime: round(n.responseEnd - n.fetchStart),
      transferSize: n.transferSize,
      headerSize: n.transferSize - n.encodedBodySize
    };
  }

  function getResourceSummary() {
    const resources = performance.getEntriesByType('resource');
    const summary = {
      script: { count: 0, totalSize: 0, totalDuration: 0 },
      link: { count: 0, totalSize: 0, totalDuration: 0 },
      img: { count: 0, totalSize: 0, totalDuration: 0 },
      font: { count: 0, totalSize: 0, totalDuration: 0 },
      fetch: { count: 0, totalSize: 0, totalDuration: 0 },
      xmlhttprequest: { count: 0, totalSize: 0, totalDuration: 0 },
      other: { count: 0, totalSize: 0, totalDuration: 0 }
    };
    resources.forEach(function (r) {
      const type = summary[r.initiatorType] ? r.initiatorType : 'other';
      summary[type].count++;
      summary[type].totalSize += r.transferSize || 0;
      summary[type].totalDuration += r.duration || 0;
    });
    return { totalResources: resources.length, byType: summary };
  }

  // --- Core Web Vitals ---

  const THRESHOLDS = { lcp: [2500, 4000], cls: [0.1, 0.25], inp: [200, 500] };

  function getVitalsScore(metric, value) {
    const t = THRESHOLDS[metric];
    if (!t) return null;
    if (value <= t[0]) return 'good';
    if (value <= t[1]) return 'needsImprovement';
    return 'poor';
  }

  let lcpValue = 0;
  let clsValue = 0;
  let inpValue = 0;
  const interactions = [];

  function notifyVitalsUpdate() {
    window.dispatchEvent(new CustomEvent('collector-v8:vitals-update', {
      detail: {
        lcp: { value: round(lcpValue), score: getVitalsScore('lcp', lcpValue) },
        cls: { value: round(clsValue * 1000) / 1000, score: getVitalsScore('cls', clsValue) },
        inp: { value: round(inpValue), score: getVitalsScore('inp', inpValue) }
      }
    }));
  }

  function observeLCP() {
    if (!('PerformanceObserver' in window)) return;
    try {
      const observer = new PerformanceObserver(function (list) {
        const entries = list.getEntries();
        const lastEntry = entries[entries.length - 1];
        lcpValue = lastEntry.renderTime || lastEntry.loadTime;
        notifyVitalsUpdate();
      });
      observer.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (e) { /* not supported */ }
  }

  function observeCLS() {
    if (!('PerformanceObserver' in window)) return;
    try {
      const observer = new PerformanceObserver(function (list) {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) clsValue += entry.value;
        }
        notifyVitalsUpdate();
      });
      observer.observe({ type: 'layout-shift', buffered: true });
    } catch (e) { /* not supported */ }
  }

  function observeINP() {
    if (!('PerformanceObserver' in window)) return;
    try {
      const observer = new PerformanceObserver(function (list) {
        for (const entry of list.getEntries()) {
          if (entry.interactionId) interactions.push(entry.duration);
        }
        if (interactions.length > 0) {
          interactions.sort(function (a, b) { return b - a; });
          inpValue = interactions[0];
        }
        notifyVitalsUpdate();
      });
      observer.observe({ type: 'event', buffered: true, durationThreshold: 16 });
    } catch (e) { /* not supported */ }
  }

  function initVitalsObservers() {
    observeLCP();
    observeCLS();
    observeINP();
  }

  // --- Error Tracking ---

  const reportedErrors = new Set();
  let errorCount = 0;
  const MAX_ERRORS = 10;

  function reportError(errorData) {
    if (errorCount >= MAX_ERRORS) return;

    const key = errorData.type + ':' + errorData.message + ':' +
      (errorData.source || '') + ':' + (errorData.line || '') + ':' +
      (errorData.src || '');
    if (reportedErrors.has(key)) return;
    reportedErrors.add(key);
    errorCount++;

    const payload = buildPayload('error');
    payload.error = errorData;
    send(payload);
  }

  function initErrorTracking() {
    window.addEventListener('error', function (event) {
      if (event instanceof ErrorEvent) {
        reportError({
          type: 'js-error',
          message: event.message,
          source: event.filename,
          line: event.lineno,
          column: event.colno,
          stack: event.error ? event.error.stack : ''
        });
        return;
      }
      const target = event.target;
      if (target && (target.tagName === 'IMG' || target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
        reportError({
          type: 'resource-error',
          tagName: target.tagName,
          src: target.src || target.href || ''
        });
      }
    }, true); // capture phase required - resource errors don't bubble

    window.addEventListener('unhandledrejection', function (event) {
      const reason = event.reason;
      reportError({
        type: 'promise-rejection',
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : ''
      });
    });
  }

  // --- Sending ---

  function send(payload) {
    // Dispatched regardless of debug mode so a demo page can show a live
    // log of everything the collector does without a second network call.
    window.dispatchEvent(new CustomEvent('collector-v8:sent', {
      detail: { payload: payload, debug: config.debug }
    }));

    if (config.debug) {
      log('Would send:', payload);
      return; // no network request in debug mode
    }

    const json = JSON.stringify(payload);
    const blob = new Blob([json], { type: 'application/json' });

    if (navigator.sendBeacon) {
      if (navigator.sendBeacon(config.endpoint, blob)) return;
    }

    fetch(config.endpoint, {
      method: 'POST',
      body: json,
      headers: { 'Content-Type': 'application/json' },
      keepalive: true
    }).catch(function () {
      fetch(config.endpoint, {
        method: 'POST',
        body: json,
        headers: { 'Content-Type': 'application/json' }
      }).catch(function (err) { warn('Send failed:', err.message); });
    });
  }

  function buildPayload(eventName) {
    const payload = {
      url: window.location.href,
      title: document.title,
      referrer: document.referrer,
      timestamp: new Date().toISOString(),
      type: eventName,
      session: getSessionId()
    };
    for (const k of Object.keys(globalProps)) {
      payload[k] = globalProps[k];
    }
    return payload;
  }

  function collectPageview() {
    const payload = buildPayload('pageview');
    if (config.enableTiming) {
      payload.timing = getNavigationTiming();
      payload.resources = getResourceSummary();
    }
    if (config.enableTechnographics) {
      payload.technographics = getTechnographics();
    }
    send(payload);
    return payload;
  }

  function sendVitals() {
    const payload = buildPayload('vitals');
    payload.vitals = {
      lcp: { value: round(lcpValue), score: getVitalsScore('lcp', lcpValue) },
      cls: { value: round(clsValue * 1000) / 1000, score: getVitalsScore('cls', clsValue) },
      inp: { value: round(inpValue), score: getVitalsScore('inp', inpValue) }
    };
    send(payload);
  }

  // --- Public API ---

  function init(options) {
    if (initialized) {
      warn('collector.init() called more than once');
      return;
    }

    config = {};
    for (const key of Object.keys(defaults)) {
      config[key] = (options && options[key] !== undefined)
        ? options[key]
        : defaults[key];
    }

    if (!shouldSample()) {
      log('Session not sampled (rate: ' + config.sampleRate + ')');
      return;
    }

    initialized = true;

    if (config.enableErrors) initErrorTracking();
    if (config.enableVitals) {
      initVitalsObservers();
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') sendVitals();
      });
    }

    window.addEventListener('load', function () {
      setTimeout(collectPageview, 0);
    });

    log('Collector initialized', config);
  }

  function track(eventName, data) {
    if (!initialized) {
      warn('collector.track() called before init()');
      return;
    }
    const payload = buildPayload(eventName);
    if (data) payload.data = data;
    send(payload);
    log('track:', eventName, data);
  }

  function set(key, value) {
    globalProps[key] = value;
    log('set:', key, value);
  }

  function identify(userId) {
    globalProps.userId = userId;
    log('User identified:', userId);
  }

  function use(extension) {
    if (!extension || !extension.name) {
      warn('Extension must have a name property');
      return;
    }
    if (extensions[extension.name]) {
      warn('Extension "' + extension.name + '" already registered');
      return;
    }

    extensions[extension.name] = extension;

    // Extensions get track/set but never send() directly - all extension
    // data funnels through the core, so sampling, debug mode, and endpoint
    // routing apply uniformly regardless of where the event came from.
    if (typeof extension.init === 'function') {
      extension.init({
        track: track,
        set: set,
        getConfig: function () { return config; },
        getSessionId: getSessionId
      });
    }

    log('Extension registered:', extension.name);
  }

  return { init, track, set, identify, use };
})();

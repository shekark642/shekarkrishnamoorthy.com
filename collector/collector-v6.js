// collector-v6.js — Collector with Error Tracking (HW3 Module 07)
(function() {
  'use strict';

  const ENDPOINT = '/collect';

  function getSessionId() {
    let sid = sessionStorage.getItem('_collector_sid');
    if (!sid) {
      sid = Math.random().toString(36).substring(2) + Date.now().toString(36);
      sessionStorage.setItem('_collector_sid', sid);
    }
    return sid;
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
    window.dispatchEvent(new CustomEvent('collector-v6:vitals-update', {
      detail: {
        lcp: { value: round(lcpValue), score: getVitalsScore('lcp', lcpValue) },
        cls: { value: round(clsValue * 1000) / 1000, score: getVitalsScore('cls', clsValue) },
        inp: { value: round(inpValue), score: getVitalsScore('inp', inpValue) }
      }
    }));
  }

  function observeLCP() {
    if (!('PerformanceObserver' in window)) return null;
    try {
      const observer = new PerformanceObserver(function (list) {
        const entries = list.getEntries();
        const lastEntry = entries[entries.length - 1];
        // Cross-origin resources without Timing-Allow-Origin report
        // renderTime as 0; loadTime is the fallback.
        lcpValue = lastEntry.renderTime || lastEntry.loadTime;
        notifyVitalsUpdate();
      });
      observer.observe({ type: 'largest-contentful-paint', buffered: true });
      return observer;
    } catch (e) {
      return null;
    }
  }

  function observeCLS() {
    if (!('PerformanceObserver' in window)) return null;
    try {
      const observer = new PerformanceObserver(function (list) {
        for (const entry of list.getEntries()) {
          // Shifts caused by the user's own action (e.g. expanding an
          // accordion) don't count against CLS - only unexpected ones do.
          if (!entry.hadRecentInput) {
            clsValue += entry.value;
          }
        }
        notifyVitalsUpdate();
      });
      observer.observe({ type: 'layout-shift', buffered: true });
      return observer;
    } catch (e) {
      return null;
    }
  }

  function observeINP() {
    if (!('PerformanceObserver' in window)) return null;
    try {
      const observer = new PerformanceObserver(function (list) {
        for (const entry of list.getEntries()) {
          if (entry.interactionId) {
            interactions.push(entry.duration);
          }
        }
        if (interactions.length > 0) {
          interactions.sort(function (a, b) { return b - a; });
          inpValue = interactions[0];
        }
        notifyVitalsUpdate();
      });
      observer.observe({ type: 'event', buffered: true, durationThreshold: 16 });
      return observer;
    } catch (e) {
      return null;
    }
  }

  // Start observers immediately (outside any event listener) so buffered:true
  // captures entries from the very start of the page load.
  observeLCP();
  observeCLS();
  observeINP();

  function send(payload) {
    const json = JSON.stringify(payload);
    const blob = new Blob([json], { type: 'application/json' });

    if (navigator.sendBeacon) {
      const sent = navigator.sendBeacon(ENDPOINT, blob);
      if (sent) return;
    }

    fetch(ENDPOINT, {
      method: 'POST',
      body: json,
      headers: { 'Content-Type': 'application/json' },
      keepalive: true
    }).catch(function () {
      fetch(ENDPOINT, {
        method: 'POST',
        body: json,
        headers: { 'Content-Type': 'application/json' }
      }).catch(function () {});
    });
  }

  function collect() {
    const payload = {
      url: window.location.href,
      title: document.title,
      referrer: document.referrer,
      timestamp: new Date().toISOString(),
      type: 'pageview',
      session: getSessionId(),
      technographics: getTechnographics(),
      timing: getNavigationTiming(),
      resources: getResourceSummary()
    };

    send(payload);
    console.log('[collector-v6] pageview payload:', payload);
    window.dispatchEvent(new CustomEvent('collector-v6:collected', { detail: payload }));
    return payload;
  }

  function sendVitals() {
    const vitals = {
      lcp: { value: round(lcpValue), score: getVitalsScore('lcp', lcpValue) },
      cls: { value: round(clsValue * 1000) / 1000, score: getVitalsScore('cls', clsValue) },
      inp: { value: round(inpValue), score: getVitalsScore('inp', inpValue) }
    };
    const payload = {
      type: 'vitals',
      vitals: vitals,
      url: window.location.href,
      session: getSessionId(),
      timestamp: new Date().toISOString()
    };
    send(payload);
    console.log('[collector-v6] vitals payload:', payload);
  }

  // --- Error Tracking ---

  const reportedErrors = new Set();
  let errorCount = 0;
  const MAX_ERRORS = 10;

  function reportError(errorData) {
    // Rate limit: a runaway loop (e.g. inside requestAnimationFrame) must not
    // be able to flood the endpoint with beacons.
    if (errorCount >= MAX_ERRORS) return;

    // Deduplicate by type+message+source+line+src - the same bug firing on
    // every frame/render should count once, not hundreds of times. `src` is
    // included because resource errors carry no message/source/line, so two
    // *different* broken resources (e.g. an image and a script) would
    // otherwise collide on the same key and only the first would be sent.
    const key = errorData.type + ':' + errorData.message + ':' +
      (errorData.source || '') + ':' + (errorData.line || '') + ':' +
      (errorData.src || '');
    if (reportedErrors.has(key)) return;
    reportedErrors.add(key);
    errorCount++;

    const payload = {
      type: 'error',
      error: errorData,
      timestamp: new Date().toISOString(),
      session: getSessionId(),
      url: window.location.href
    };

    send(payload);
    console.log('[collector-v6] error payload:', payload);
    window.dispatchEvent(new CustomEvent('collector-v6:error-reported', { detail: payload }));
  }

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

    // Resource errors (img/script/link) do not bubble, so this branch only
    // runs because the listener below is registered with capture:true.
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

  // Initial beacon: timing + technographics (same as v5)
  window.addEventListener('load', function () {
    setTimeout(collect, 0);
  });

  // Vitals beacon: final values, sent when the page is hidden (most
  // reliable point to capture final CLS/INP - fires on tab switch,
  // minimize, or navigation away).
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      sendVitals();
    }
  });

  window.collectorV6 = {
    getTechnographics, getSessionId, getNavigationTiming, getResourceSummary,
    getVitalsScore, collect, sendVitals, reportError
  };
})();

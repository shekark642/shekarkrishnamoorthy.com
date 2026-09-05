// collector-v4.js — Collector with Performance Timing (HW3 Module 05)
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

    return {
      totalResources: resources.length,
      byType: summary
    };
  }

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

    console.log('[collector-v4] payload:', payload);
    window.dispatchEvent(new CustomEvent('collector-v4:collected', { detail: payload }));
    return payload;
  }

  // Timing data (loadEventEnd especially) is not populated until after the
  // load event's handlers finish running - a setTimeout(fn, 0) defers our
  // read to the next task, by which point it's available. This is the
  // correct pattern, not a hack.
  window.addEventListener('load', function () {
    setTimeout(collect, 0);
  });

  window.collectorV4 = { getTechnographics, getSessionId, getNavigationTiming, getResourceSummary, collect };
})();

// collector-v2.js — Collector with Technographic Data (HW3 Module 02: Technographics)
(function() {
  'use strict';

  const endpoint = '/collect';

  function getSessionId() {
    let sid = sessionStorage.getItem('_collector_sid');
    if (!sid) {
      sid = Math.random().toString(36).substring(2) + Date.now().toString(36);
      sessionStorage.setItem('_collector_sid', sid);
    }
    return sid;
  }

  function getTechnographics() {
    // Network info (feature-detected - not available in Safari)
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
      // Browser identification
      userAgent: navigator.userAgent,
      language: navigator.language,
      cookiesEnabled: navigator.cookieEnabled,

      // Viewport (current browser window)
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,

      // Screen (physical display)
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      pixelRatio: window.devicePixelRatio,

      // Hardware (feature-detected - deviceMemory absent in Safari/Firefox)
      cores: navigator.hardwareConcurrency || 0,
      memory: navigator.deviceMemory || 0,

      // Network
      network: networkInfo,

      // Preferences
      colorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark' : 'light',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };
  }

  function collect() {
    const payload = {
      url: window.location.href,
      title: document.title,
      referrer: document.referrer,
      timestamp: new Date().toISOString(),
      type: 'pageview',
      session: getSessionId(),
      technographics: getTechnographics()
    };

    const blob = new Blob(
      [JSON.stringify(payload)],
      { type: 'application/json' }
    );

    if (navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, blob);
    } else {
      fetch(endpoint, {
        method: 'POST',
        body: blob,
        keepalive: true
      });
    }

    console.log('[collector-v2] payload:', payload);
    return payload;
  }

  // Fire on page load
  if (document.readyState === 'complete') {
    collect();
  } else {
    window.addEventListener('load', collect);
  }

  // Small public interface so a page can inspect what was collected
  // without triggering a second beacon.
  window.collectorV2 = { getTechnographics, getSessionId, collect };
})();

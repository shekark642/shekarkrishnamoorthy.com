// collector-v3.js — Configurable Endpoint + Cascading Delivery
// (HW3 Module 04: Custom Endpoint)
(function() {
  'use strict';

  // Same-origin: this collector is served from collector.shekarkrishnamoorthy.com,
  // and /collect on this domain proxies to the real Express endpoint.
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

  // Cascading delivery: sendBeacon (best - survives unload) -> fetch with
  // keepalive (also survives unload, has a response, 64KB payload cap) ->
  // plain fetch (last resort, does not survive unload).
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
      technographics: getTechnographics()
    };

    send(payload);

    console.log('[collector-v3] payload:', payload);
    return payload;
  }

  // Fire on page load
  if (document.readyState === 'complete') {
    collect();
  } else {
    window.addEventListener('load', collect);
  }

  window.collectorV3 = { getTechnographics, getSessionId, collect };
})();

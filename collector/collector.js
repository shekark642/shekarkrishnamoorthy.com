// collector.js — HW3 final collector: static, performance, and activity data.
// Served from collector.shekarkrishnamoorthy.com, posts to /collect.
(function () {
  'use strict';

  // Absolute URL, not a relative path: this script is meant to be embedded
  // on other origins (e.g. the main site's homepage), where a relative
  // '/collect' would resolve to that page's own origin instead of the
  // collector vhost's Express endpoint. The endpoint already sends
  // Access-Control-Allow-Origin: * specifically to support this.
  var ENDPOINT = 'https://collector.shekarkrishnamoorthy.com/collect';
  var SESSION_KEY = '_collector_sid';
  var IDLE_THRESHOLD_MS = 2000;
  var ACTIVITY_FLUSH_MS = 10000;
  var MOUSEMOVE_SAMPLE_MS = 150; // throttle - mousemove can fire 60-100x/sec
  var MAX_ERRORS = 25;

  // --- Session ---

  function getSessionId() {
    var sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
      sid = Math.random().toString(36).substring(2) + Date.now().toString(36);
      sessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
  }

  // --- Sending ---

  function send(type, data) {
    var payload = {
      type: type,
      session: getSessionId(),
      url: window.location.href,
      timestamp: new Date().toISOString()
    };
    for (var k in data) {
      if (Object.prototype.hasOwnProperty.call(data, k)) payload[k] = data[k];
    }

    // Purely for local debugging/verification - harmless in production, no
    // listener means no cost.
    window.dispatchEvent(new CustomEvent('collector:sent', { detail: payload }));

    var json = JSON.stringify(payload);
    var blob = new Blob([json], { type: 'application/json' });
    var sent = navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob);
    if (!sent) {
      fetch(ENDPOINT, {
        method: 'POST',
        body: json,
        headers: { 'Content-Type': 'application/json' },
        keepalive: true
      }).catch(function () {});
    }
  }

  // --- Static data (collected after load) ---

  function detectCssEnabled() {
    // No API exposes "is CSS enabled" directly, so this is measured
    // empirically: inject a rule with an unmistakable value, then check
    // whether the computed style actually picked it up.
    try {
      var style = document.createElement('style');
      style.textContent = '.__collector_css_probe__{position:absolute!important;' +
        'left:-9999px!important;color:rgb(1,2,3)!important;}';
      document.head.appendChild(style);

      var probe = document.createElement('div');
      probe.className = '__collector_css_probe__';
      document.body.appendChild(probe);

      var computed = window.getComputedStyle(probe).color;

      document.body.removeChild(probe);
      document.head.removeChild(style);

      return computed === 'rgb(1, 2, 3)';
    } catch (e) {
      return true; // detection itself failed - assume the common case
    }
  }

  function detectImagesEnabled(timeoutMs) {
    // No API exposes "are images enabled" either - load a same-document
    // 1x1 GIF (no network round trip) and see whether it actually renders.
    return new Promise(function (resolve) {
      var settled = false;
      var img = new Image();

      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(true); // neither load nor error fired - assume enabled
      }, timeoutMs || 1500);

      img.onload = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(img.naturalWidth > 0);
      };
      img.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      };

      img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    });
  }

  function getStaticData(imagesEnabled) {
    var connectionType = null;
    if ('connection' in navigator && navigator.connection) {
      connectionType = navigator.connection.effectiveType || null;
    }
    return {
      userAgent: navigator.userAgent,
      // The single most reliable automation signal available in JS:
      // Selenium/Puppeteer/Playwright all set this true by default (it only
      // reads false if a bot has deliberately patched it out - the User-Agent
      // regex on the server side is the fallback for that case).
      webdriver: navigator.webdriver === true,
      language: navigator.language,
      cookiesAccepted: navigator.cookieEnabled,
      // If this script is running at all, JavaScript is enabled by
      // definition - the false case can only ever be observed server-side,
      // e.g. via a <noscript> tracking pixel on the page (see Module 03).
      jsEnabled: true,
      imagesEnabled: imagesEnabled,
      cssEnabled: detectCssEnabled(),
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      connectionType: connectionType
    };
  }

  // --- Performance data (collected after load) ---

  function getPerformanceData() {
    var entries = performance.getEntriesByType('navigation');
    if (!entries.length) return null;
    var entry = entries[0];
    return {
      timing: entry.toJSON(), // the whole PerformanceNavigationTiming object
      pageLoadStart: new Date(performance.timeOrigin + entry.startTime).toISOString(),
      pageLoadEnd: new Date(performance.timeOrigin + entry.loadEventEnd).toISOString(),
      totalLoadTimeMs: Math.round(entry.loadEventEnd - entry.startTime)
    };
  }

  // --- Activity data (continuously collected, flushed in batches) ---

  var mouseMoves = [];
  var mouseClicks = [];
  var scrollEvents = [];
  var keyEvents = [];
  var idlePeriods = [];

  var reportedErrors = {};
  var errorCount = 0;
  var errorLog = [];

  var lastActivityTime = Date.now();

  function noteActivity() {
    var now = Date.now();
    if (now - lastActivityTime >= IDLE_THRESHOLD_MS) {
      idlePeriods.push({
        idleEndedAt: new Date(now).toISOString(),
        durationMs: now - lastActivityTime
      });
    }
    lastActivityTime = now;
  }

  var lastMouseMoveSample = 0;
  document.addEventListener('mousemove', function (e) {
    noteActivity();
    var now = Date.now();
    if (now - lastMouseMoveSample >= MOUSEMOVE_SAMPLE_MS) {
      lastMouseMoveSample = now;
      mouseMoves.push({ x: e.clientX, y: e.clientY, timestamp: new Date(now).toISOString() });
    }
  });

  document.addEventListener('click', function (e) {
    noteActivity();
    mouseClicks.push({
      x: e.clientX,
      y: e.clientY,
      button: e.button, // 0 = left, 1 = middle, 2 = right
      timestamp: new Date().toISOString()
    });
  }, true);

  var scrollTicking = false;
  window.addEventListener('scroll', function () {
    noteActivity();
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(function () {
      scrollEvents.push({
        x: window.scrollX,
        y: window.scrollY,
        timestamp: new Date().toISOString()
      });
      scrollTicking = false;
    });
  });

  document.addEventListener('keydown', function (e) {
    noteActivity();
    keyEvents.push({ type: 'keydown', key: e.key, code: e.code, timestamp: new Date().toISOString() });
  });
  document.addEventListener('keyup', function (e) {
    noteActivity();
    keyEvents.push({ type: 'keyup', key: e.key, code: e.code, timestamp: new Date().toISOString() });
  });

  function recordError(err) {
    if (errorCount >= MAX_ERRORS) return;
    var key = err.type + ':' + err.message + ':' + (err.source || '') + ':' +
      (err.line || '') + ':' + (err.src || '');
    if (reportedErrors[key]) return;
    reportedErrors[key] = true;
    errorCount++;
    err.timestamp = new Date().toISOString();
    errorLog.push(err);
  }

  window.addEventListener('error', function (event) {
    if (event instanceof ErrorEvent) {
      recordError({
        type: 'js-error',
        message: event.message,
        source: event.filename,
        line: event.lineno,
        column: event.colno,
        stack: event.error ? event.error.stack : ''
      });
      return;
    }
    var target = event.target;
    if (target && (target.tagName === 'IMG' || target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
      recordError({
        type: 'resource-error',
        tagName: target.tagName,
        src: target.src || target.href || ''
      });
    }
  }, true); // capture phase - resource errors don't bubble

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    recordError({
      type: 'promise-rejection',
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : ''
    });
  });

  function flushActivity() {
    if (!mouseMoves.length && !mouseClicks.length && !scrollEvents.length &&
        !keyEvents.length && !idlePeriods.length && !errorLog.length) {
      return;
    }
    send('activity', {
      mouseMoves: mouseMoves,
      mouseClicks: mouseClicks,
      scrollEvents: scrollEvents,
      keyEvents: keyEvents,
      idlePeriods: idlePeriods,
      errors: errorLog
    });
    mouseMoves = [];
    mouseClicks = [];
    scrollEvents = [];
    keyEvents = [];
    idlePeriods = [];
    errorLog = [];
  }

  setInterval(flushActivity, ACTIVITY_FLUSH_MS);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      flushActivity();
      send('exit', {});
    }
  });

  // --- Lifecycle ---

  send('enter', {}); // when the user entered the page

  window.addEventListener('load', function () {
    detectImagesEnabled().then(function (imagesEnabled) {
      send('load', {
        staticData: getStaticData(imagesEnabled),
        performanceData: getPerformanceData()
      });
    });
  });

  // --- Public API ---
  // Everything above is auto-collected; this is the one hook a page can call
  // itself to record something that only the page knows about (e.g. a
  // button click), reusing the same session/beacon plumbing as every other
  // event type here.
  window.collector = {
    track: function (type, data) { send(type, data || {}); }
  };
})();

/* Consolidated analytics: Google Analytics (GA4), Matomo, and LogRocket.
   Single include point - add this one line to a page's <head> to get all
   three, instead of hand-copying three different snippet styles:
     <script src="/assets/analytics.js"></script>
*/

// --- Google Analytics (GA4) ---
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag('js', new Date());
gtag('config', 'G-KYKYL3X08D');
(function () {
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=G-KYKYL3X08D';
  document.head.appendChild(s);
})();

// --- Matomo ---
var _paq = window._paq = window._paq || [];
_paq.push(['trackPageView']);
_paq.push(['enableLinkTracking']);
(function () {
  var u = "//collector.shekarkrishnamoorthy.com/analytics/";
  _paq.push(['setTrackerUrl', u + 'matomo.php']);
  _paq.push(['setSiteId', '1']);
  var g = document.createElement('script');
  g.async = true;
  g.src = u + 'matomo.js';
  document.head.appendChild(g);
})();

// --- LogRocket ---
(function () {
  var s = document.createElement('script');
  s.src = 'https://cdn.logr-in.com/LogRocket.min.js';
  s.crossOrigin = 'anonymous';
  s.onload = function () {
    if (!window.LogRocket) return;
    window.LogRocket.init('zwvdgp/shekarkrishnamoorthycom');

    // LogRocket's own product is full pixel-perfect session replay (DOM,
    // network, console - not just mouse coordinates), viewed in LogRocket's
    // own player. getSessionURL hands back a direct link to that replay for
    // this specific session; sending it through our own collector.track()
    // means it lands in the same events table as everything else, so the
    // reporting dashboard can link straight to it per session instead of
    // needing a separate trip into LogRocket's own dashboard to find it.
    window.LogRocket.getSessionURL(function (sessionURL) {
      var attempts = 0;
      (function trySend() {
        // collector.js loads async alongside this script, so its readiness
        // isn't guaranteed by the time this callback fires - retry briefly
        // rather than silently dropping the event.
        // Named logrocketUrl, not url - collector.track() merges this
        // object's keys straight into the beacon payload, and `url` there
        // already means "the page this event happened on" (see send() in
        // collector.js). Reusing that key would silently overwrite it with
        // the LogRocket link instead of the actual page URL.
        if (window.collector) { window.collector.track('logrocket_session', { logrocketUrl: sessionURL }); return; }
        if (attempts++ < 25) setTimeout(trySend, 200);
      })();
    });
  };
  document.head.appendChild(s);
})();

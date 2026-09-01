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
    window.LogRocket && window.LogRocket.init('zwvdgp/shekarkrishnamoorthycom');
  };
  document.head.appendChild(s);
})();

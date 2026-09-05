// ext-scroll.js — Scroll depth extension (HW3 Module 09)
const ScrollTracker = {
  name: 'scroll-tracker',

  _collector: null,
  _maxDepth: 0,
  _reported: {},
  _thresholds: [25, 50, 75, 100],

  init: function (collector) {
    var self = this;
    self._collector = collector;

    // Throttle scroll measurement with requestAnimationFrame - scroll
    // events can fire dozens of times per second, but one measurement per
    // frame (~60fps) is enough to catch every threshold crossing.
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(function () {
          self._measure();
          ticking = false;
        });
      }
    });

    // Report final depth on page hide - the deepest point reached matters
    // more than the depth at the exact moment of navigation.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        self._reportFinal();
      }
    });
  },

  _measure: function () {
    var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    var docHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    );
    var winHeight = window.innerHeight;
    var percent = Math.round((scrollTop + winHeight) / docHeight * 100);

    if (percent > this._maxDepth) {
      this._maxDepth = percent;
    }

    for (var i = 0; i < this._thresholds.length; i++) {
      var t = this._thresholds[i];
      if (percent >= t && !this._reported[t]) {
        this._reported[t] = true;
        this._collector.track('scroll_depth', {
          threshold: t,
          maxDepth: this._maxDepth
        });
      }
    }
  },

  _reportFinal: function () {
    this._collector.track('scroll_final', {
      maxDepth: this._maxDepth
    });
  },

  destroy: function () {
    // In a real implementation, we'd remove event listeners
    // by storing references to the bound functions.
  }
};

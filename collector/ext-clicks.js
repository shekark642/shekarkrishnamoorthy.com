// ext-clicks.js — Click tracking extension (HW3 Module 09)
const ClickTracker = {
  name: 'click-tracker',

  _handler: null,

  init: function (collector) {
    var self = this;
    var lastClick = 0;

    self._handler = function (event) {
      // Debounce: ignore clicks within 300ms of each other - avoids
      // duplicate tracking from double-clicks or programmatic re-fires.
      var now = Date.now();
      if (now - lastClick < 300) return;
      lastClick = now;

      var target = event.target;

      collector.track('click', {
        tagName: target.tagName,
        id: target.id || undefined,
        className: (typeof target.className === 'string' ? target.className : '') || undefined,
        text: (target.textContent || '').substring(0, 100),
        x: event.clientX,
        y: event.clientY,
        selector: self._getSelector(target)
      });
    };

    // Capture phase: fires before an element's own handler can call
    // stopPropagation() and hide the click from a bubble-phase listener.
    document.addEventListener('click', self._handler, true);
  },

  _getSelector: function (el) {
    var parts = [];
    while (el && el !== document.body) {
      var part = el.tagName.toLowerCase();
      if (el.id) {
        part += '#' + el.id;
        parts.unshift(part);
        break;
      }
      if (el.className && typeof el.className === 'string') {
        part += '.' + el.className.trim().split(/\s+/).join('.');
      }
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(' > ');
  },

  destroy: function () {
    if (this._handler) {
      document.removeEventListener('click', this._handler, true);
    }
  }
};

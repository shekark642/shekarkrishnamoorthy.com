// consent.js — Consent management for the collector (HW3 Module 10)
const ConsentManager = {
  COOKIE_NAME: 'analytics_consent',

  check: function () {
    // Global Privacy Control is a legally binding "do not sell/share"
    // signal under CCPA - honor it even if a stale consent cookie exists.
    if (navigator.globalPrivacyControl) return false;

    const cookies = document.cookie.split(';');
    for (let i = 0; i < cookies.length; i++) {
      const cookie = cookies[i].trim();
      if (cookie.indexOf(this.COOKIE_NAME + '=') === 0) {
        return cookie.split('=')[1] === 'true';
      }
    }
    // No consent signal found - default to opt-in required (GDPR-safe).
    return false;
  },

  grant: function () {
    const oneYear = 365 * 24 * 60 * 60;
    document.cookie = this.COOKIE_NAME + '=true; path=/; max-age=' + oneYear;
  },

  revoke: function () {
    document.cookie = this.COOKIE_NAME + '=false; path=/; max-age=' + (365 * 24 * 60 * 60);
    // A revoke means "forget this visitor" as much as we can - clear the
    // session identity so a later opt-in starts a fresh session, not a
    // continuation of one that was tracked without consent.
    try {
      sessionStorage.removeItem('_collector_sid');
      sessionStorage.removeItem('_collector_sampled');
      sessionStorage.removeItem('_collector_retry');
    } catch (e) { /* storage unavailable - nothing to clear */ }
  },

  showBanner: function (options) {
    const opts = options || {};
    if (document.getElementById('consent-banner')) return; // already shown

    const banner = document.createElement('div');
    banner.id = 'consent-banner';
    banner.setAttribute('style',
      'position:fixed;left:0;right:0;bottom:0;z-index:1000;' +
      'background:#0f172a;color:#e2e8f0;padding:1rem 1.25rem;' +
      'display:flex;align-items:center;justify-content:space-between;gap:1rem;' +
      'flex-wrap:wrap;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;' +
      'font-size:0.88rem;box-shadow:0 -4px 20px rgba(0,0,0,0.25);'
    );

    const text = document.createElement('span');
    text.textContent = opts.message ||
      'This site uses analytics cookies to understand how it is used. Do you consent?';
    banner.appendChild(text);

    const btnRow = document.createElement('span');
    btnRow.setAttribute('style', 'display:flex;gap:0.6rem;flex-shrink:0;');

    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = 'Accept';
    acceptBtn.setAttribute('style',
      'border:none;border-radius:8px;padding:0.5rem 1rem;background:#16a34a;' +
      'color:#fff;font-weight:600;cursor:pointer;font-size:0.85rem;'
    );
    acceptBtn.addEventListener('click', function () {
      ConsentManager.grant();
      banner.remove();
      if (typeof opts.onAccept === 'function') opts.onAccept();
    });

    const declineBtn = document.createElement('button');
    declineBtn.textContent = 'Decline';
    declineBtn.setAttribute('style',
      'border:none;border-radius:8px;padding:0.5rem 1rem;background:#475569;' +
      'color:#fff;font-weight:600;cursor:pointer;font-size:0.85rem;'
    );
    declineBtn.addEventListener('click', function () {
      ConsentManager.revoke();
      banner.remove();
      if (typeof opts.onDecline === 'function') opts.onDecline();
    });

    btnRow.appendChild(acceptBtn);
    btnRow.appendChild(declineBtn);
    banner.appendChild(btnRow);
    document.body.appendChild(banner);
  }
};

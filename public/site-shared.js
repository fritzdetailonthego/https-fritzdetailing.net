(function () {
  if (window.FritzSiteSharedInstalled) return;
  window.FritzSiteSharedInstalled = true;

  function isAdminPage() {
    return /\/admin\.html$/i.test(window.location.pathname);
  }

  function installAdminShortcut() {
    document.addEventListener('keydown', function (event) {
      if (!event.ctrlKey || !event.shiftKey || String(event.key).toLowerCase() !== 'a') return;
      event.preventDefault();
      window.location.href = isAdminPage() ? '/' : '/admin.html';
    });
  }

  function addTestModeStyles(keysMissing) {
    if (!document.getElementById('fritz-test-mode-style')) {
      var style = document.createElement('style');
      style.id = 'fritz-test-mode-style';
      style.textContent = [
        ':root{--purple:#2D7FF9!important;--purple-light:#5FA3FF!important;--purple-dark:#1F5AC9!important;--purple-glow:rgba(45,127,249,0.3)!important;--border:rgba(45,127,249,0.3)!important;}',
        'body.fritz-test-mode{padding-top:34px;}',
        'body.fritz-test-mode .navbar{top:34px;}',
        '#test-mode-banner{position:fixed;top:0;left:0;right:0;z-index:9999;color:#fff;padding:8px 16px;text-align:center;font-family:Rajdhani,sans-serif;font-weight:700;font-size:13px;letter-spacing:2px;text-transform:uppercase;border-bottom:2px solid;}'
      ].join('');
      document.head.appendChild(style);
    }

    document.body.classList.add('fritz-test-mode');

    if (!document.getElementById('test-mode-banner')) {
      var banner = document.createElement('div');
      banner.id = 'test-mode-banner';
      banner.style.background = keysMissing ? '#E24B4A' : '#2D7FF9';
      banner.style.borderBottomColor = keysMissing ? '#9B2A29' : '#1F5AC9';
      banner.textContent = keysMissing
        ? 'Stripe Test Mode ON - Test keys not configured - Card payments will fail'
        : 'Stripe Test Mode - No real charges - Test sales auto-delete on switch to live';
      document.body.insertBefore(banner, document.body.firstChild);
    }
  }

  async function applyGlobalTestMode() {
    try {
      var response = await fetch('/api/log-sale?action=mode', { cache: 'no-store' });
      if (!response.ok) return;
      var mode = await response.json();
      if (mode && mode.testMode === true) {
        addTestModeStyles(mode.hasTestKeys === false);
      }
    } catch (error) {
      // Test mode styling must never block the page.
    }
  }

  installAdminShortcut();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyGlobalTestMode);
  } else {
    applyGlobalTestMode();
  }
})();

(function () {
  var host = (window.location.hostname || '').toLowerCase();
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLocal) return;

  function setHref(selector, href) {
    var el = document.querySelector(selector);
    if (el) el.setAttribute('href', href);
  }

  setHref('link[rel="icon"][type="image/svg+xml"]', 'assets/local-logo.svg');
  setHref('link[rel="icon"][sizes="32x32"]', 'assets/local-logo-32.png');
  setHref('link[rel="shortcut icon"]', 'assets/local-favicon.ico');
  setHref('link[rel="apple-touch-icon"][sizes="180x180"]', 'assets/local-logo-180.png');
  setHref('link[rel="manifest"]', 'site.local.webmanifest');

  var theme = document.querySelector('meta[name="theme-color"]');
  if (theme) theme.setAttribute('content', '#fb7185');
})();

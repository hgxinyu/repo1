(function () {
  var host = (window.location.hostname || '').toLowerCase();
  var isLocal = host === '' || host === 'localhost' || host === '0.0.0.0' || host === '127.0.0.1' || host === '::1' || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  var isStage = host === 'stage' || host.startsWith('stage.') || host.startsWith('stage-') || host.startsWith('stage--') || host.indexOf('--stage') !== -1 || host.indexOf('-stage.') !== -1;
  if (!isLocal && !isStage) return;
  var prefix = isLocal ? 'local' : 'stage';
  var favicon = isLocal ? 'assets/local-favicon.ico' : 'assets/stage-favicon.ico';
  var manifest = isLocal ? 'site.local.webmanifest' : 'site.stage.webmanifest';
  var themeColor = isLocal ? '#fb7185' : '#0891b2';

  function setHref(selector, href) {
    var el = document.querySelector(selector);
    if (el) el.setAttribute('href', href);
  }

  setHref('link[rel="icon"][type="image/svg+xml"]', 'assets/' + prefix + '-logo.svg');
  setHref('link[rel="icon"][sizes="32x32"]', 'assets/' + prefix + '-logo-32.png');
  setHref('link[rel="shortcut icon"]', favicon);
  setHref('link[rel="apple-touch-icon"][sizes="180x180"]', 'assets/' + prefix + '-logo-180.png');
  setHref('link[rel="manifest"]', manifest);

  var theme = document.querySelector('meta[name="theme-color"]');
  if (theme) theme.setAttribute('content', themeColor);
})();

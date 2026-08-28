(function () {
  function isHomepageUrl(value) {
    if (!value) return false;
    try {
      const url = new URL(value, window.location.href);
      if (url.origin !== window.location.origin) return false;
      const path = url.pathname.replace(/\/+$/, "");
      return path === "" || path === "/index.html" || path.endsWith("/flipgame/index.html");
    } catch {
      return false;
    }
  }

  function isCurrentHomepage() {
    return isHomepageUrl(window.location.href);
  }

  function cameDirectlyFromHomepage() {
    return isHomepageUrl(document.referrer);
  }

  function markHistoryRestore() {
    document.documentElement.classList.add("history-restored");
  }

  window.flipgameReturnHome = function (options) {
    const replaceFallback = Boolean(options && options.replaceFallback);
    if (cameDirectlyFromHomepage() && window.history.length > 1) {
      window.history.back();
      return;
    }
    if (replaceFallback) {
      window.location.replace("index.html");
    } else {
      window.location.assign("index.html");
    }
  };

  if (isCurrentHomepage()) {
    const navigation = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    if (navigation && navigation.type === "back_forward") {
      markHistoryRestore();
    }
    window.addEventListener("pageshow", function (event) {
      if (event.persisted) markHistoryRestore();
    });
    return;
  }

  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest && event.target.closest('a[href="index.html"]');
    if (!link || link.target || link.hasAttribute("download")) return;
    event.preventDefault();
    window.flipgameReturnHome();
  });
})();

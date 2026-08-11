
(function() {
  window.__qtBridge = true;
  window.WH_TOKEN = __WH_TOKEN_JSON__;
  window.WH_IMAGE_OCR_AVAILABLE = __WH_IMAGE_OCR_AVAILABLE__;
  const origFetch = window.fetch.bind(window);
  const bridgeSnapshot = __WH_SNAPSHOT_JSON__;
  if (bridgeSnapshot !== null) {
    window.__bridgeState = bridgeSnapshot;
  } else {
    const storeLoadController = new AbortController();
    const storeLoadTimeout = setTimeout(function() { storeLoadController.abort(); }, 12000);
    window.__bridgeStatePromise = origFetch('/__store/load', {
      cache: 'no-store',
      headers: {
        'X-WH-Token': __WH_TOKEN_JSON__
      },
      signal: storeLoadController.signal
    }).then(function(response) {
      if (!response.ok) throw new Error('Store load failed: HTTP ' + response.status);
      return response.json();
    }).catch(function(error) {
      if (storeLoadController.signal.aborted) throw new Error('Store load timed out after 12 seconds');
      throw error;
    }).finally(function() { clearTimeout(storeLoadTimeout); });
  }
  window.fetch = function(input, init) {
    try {
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      if (/^https?:\/\/(www\.)?gutenberg\.org\//i.test(url)) {
        const proxied = '/__proxy?url=' + encodeURIComponent(url);
        if (typeof input === 'string') return origFetch(proxied, init);
        return origFetch(new Request(proxied, input), init);
      }
    } catch (e) {}
    return origFetch(input, init);
  };
})();

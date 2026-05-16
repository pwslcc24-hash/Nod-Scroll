// Isolated-world content script.
// Its only job is to inject main.js into the page's main world so MediaPipe's
// WASM loader can register its globals on the right window. Running MediaPipe
// directly from an isolated content script fails with "ModuleFactory not set"
// because the WASM JS loader writes to the page window, not the isolated one.

(function () {
  if (document.getElementById('nod-scroll-main')) return;
  const s = document.createElement('script');
  s.id   = 'nod-scroll-main';
  s.type = 'module';
  s.src  = chrome.runtime.getURL('main.js');
  (document.head || document.documentElement).appendChild(s);

  // Bridge for license-code validation. The page's CSP blocks fetch from the
  // main world on most reel sites, so main.js posts a message here and the
  // isolated-world content script does the actual fetch (allowed via the
  // extension's host_permissions).
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data) return;
    const { type, nonce } = e.data;

    // Cross-site persistent storage (chrome.storage.local). Once a user enters
    // a valid code, paid status persists across every site the extension runs
    // on — not just the one where they activated.
    if (type === 'nodScrollStorageGet') {
      try {
        const data = await chrome.storage.local.get(null);
        window.postMessage({ type: 'nodScrollStorageGetResult', nonce, data }, '*');
      } catch {
        window.postMessage({ type: 'nodScrollStorageGetResult', nonce, data: {} }, '*');
      }
      return;
    }
    if (type === 'nodScrollStorageSet') {
      try { await chrome.storage.local.set(e.data.data || {}); } catch {}
      window.postMessage({ type: 'nodScrollStorageSetResult', nonce }, '*');
      return;
    }

    // License validation — routes through here because page CSP blocks the
    // main world from fetching arbitrary origins.
    if (type === 'nodScrollValidate') {
      const { code, deviceId } = e.data;
      try {
        const r = await fetch('https://nod-scroll.netlify.app/.netlify/functions/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, deviceId }),
        });
        const data = await r.json().catch(() => ({ valid: false, error: 'Bad response' }));
        window.postMessage({ type: 'nodScrollValidateResult', nonce, data }, '*');
      } catch (err) {
        window.postMessage({
          type: 'nodScrollValidateResult', nonce,
          data: { valid: false, error: 'Network error' },
        }, '*');
      }
    }
  });
})();

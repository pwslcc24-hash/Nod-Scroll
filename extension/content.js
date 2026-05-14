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
})();

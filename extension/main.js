// Runs in the page's MAIN world (injected by content.js).
// Loaded as an ES module from the extension origin, so:
//   - import.meta.url is chrome-extension://<id>/main.js
//   - relative imports resolve against the extension folder
//   - MediaPipe's WASM loader registers ModuleFactory on the page window,
//     which is the same window MediaPipe then reads from. Works.

// Some sites (YouTube, others) enforce Trusted Types CSP, which blocks raw
// string assignment to .innerHTML, .src, etc. MediaPipe internally does
// `script.src = wasmJsUrl`, so we register a permissive "default" policy
// before importing it. The policy is only applied to script URLs/HTML
// originating from this main-world script.
try {
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    window.trustedTypes.createPolicy('default', {
      createHTML:       (s) => s,
      createScript:     (s) => s,
      createScriptURL:  (s) => s,
    });
  }
} catch (e) {
  console.warn('[NodScroll] could not register default TT policy:', e.message);
}

import { FaceLandmarker, FilesetResolver } from './vendor/vision_bundle.mjs';

const WASM_PATH = new URL('./vendor/wasm/', import.meta.url).href;
const MODEL_URL = new URL('./vendor/face_landmarker.task', import.meta.url).href;

// ── Tunable constants ────────────────────────────────────────────────────────
const THRESHOLD_DOWN     = 0.30;   // chin-drop side
const THRESHOLD_UP       = 0.22;   // chin-rise side (smaller = more sensitive)
const COOLDOWN_MS        = 800;
const TONGUE_THRESHOLD   = 0.40;   // MediaPipe blendshape "tongueOut" 0–1
const TONGUE_COOLDOWN_MS = 1500;   // ignore further likes within this window

// ── Paywall config ───────────────────────────────────────────────────────────
// After FREE_SCROLLS_LIMIT free nods on a given site, the user is prompted to
// buy a license. Unique codes are generated per-purchase by the webhook on
// https://nod-scroll.netlify.app, then validated via /.netlify/functions/validate.
// Each code can be activated on up to 3 devices before further activations
// are refused, blocking casual code-sharing.
const FREE_SCROLLS_LIMIT = 3;
const STRIPE_PAYMENT_URL = 'https://buy.stripe.com/4gM5kCczf04R2lRdwX1wY00';
const VALIDATE_URL       = 'https://nod-scroll.netlify.app/.netlify/functions/validate';
const SMOOTH_ALPHA       = 0.65;
const BASELINE_ALPHA     = 0.985;
const FPS_TARGET         = 30;

// ── Runtime state ────────────────────────────────────────────────────────────
let faceLandmarker = null;
let videoEl        = null;
let rafId          = null;
let enabled        = false;
let nodState       = 'idle';
let smoothedPitch  = null;
let baseline       = null;
let lastDelta      = 0;

// ── Facebook navigation ──────────────────────────────────────────────────────
// Per-site navigation config. `mode: 'click'` uses CSS selectors; `mode: 'key'`
// dispatches synthetic ArrowDown/ArrowUp events. Some sites (FB) ignore
// synthetic keys, others (YT, TikTok) respond to them just fine.
//
// To find selectors on a new site or fix a broken one, paste this in console:
//   [...document.querySelectorAll('[role="button"][aria-label],button[aria-label]')]
//     .filter(el => { const r = el.getBoundingClientRect();
//       return r.right > innerWidth*0.7 && r.width < 120 && r.height < 120 && r.top > 80; })
//     .map(el => el.getAttribute('aria-label'))
const SITE_CONFIG = {
  'www.facebook.com': {
    mode: 'click',
    next: '[aria-label="Next Card"]',
    prev: '[aria-label="Previous Card"]',
    like: '[aria-label="Like"]',
  },
  'www.youtube.com': {
    mode: 'key',  // YT Shorts responds to native ArrowDown/ArrowUp
    like: 'ytd-reel-video-renderer[is-active] button[aria-label*="like" i]:not([aria-label*="Dislike" i]), button[aria-label*="like this" i]:not([aria-label*="Dislike" i])',
  },
  'www.tiktok.com': {
    mode: 'both',
    next: '[data-e2e="arrow-right"], button[aria-label*="next" i]',
    prev: '[data-e2e="arrow-left"],  button[aria-label*="previous" i]',
    like: '[data-e2e="like-icon"], button[aria-label*="Like" i]',
  },
  'www.instagram.com': {
    mode: 'both',
    next: 'svg[aria-label="Next"]',
    prev: 'svg[aria-label="Back"], svg[aria-label="Previous"]',
    like: 'svg[aria-label="Like"]',
  },
};

function dispatchKey(isNext) {
  const key     = isNext ? 'ArrowDown' : 'ArrowUp';
  const keyCode = isNext ? 40 : 38;
  const evt = (type) => new KeyboardEvent(type, {
    key, code: key, keyCode, which: keyCode,
    bubbles: true, cancelable: true, composed: true,
  });
  const targets = [document, window, document.body, document.activeElement].filter(Boolean);
  for (const t of targets) {
    t.dispatchEvent(evt('keydown'));
    t.dispatchEvent(evt('keyup'));
  }
}

function clickNav(cfg, isNext) {
  const sel = isNext ? cfg.next : cfg.prev;
  if (!sel) return false;
  let btn = document.querySelector(sel);
  // For Instagram, the aria-label lives on the SVG — click its closest button
  if (btn && (btn.tagName === 'svg' || btn.tagName === 'SVG')) {
    btn = btn.closest('button, [role="button"]') || btn;
  }
  if (btn) { btn.click(); return true; }
  return false;
}

function executeAction(direction) {
  const isNext = direction === 'up';
  const cfg    = SITE_CONFIG[location.hostname];
  if (!cfg) { console.warn('[NodScroll] no config for', location.hostname); return; }

  if (cfg.mode === 'key') {
    dispatchKey(isNext);
  } else if (cfg.mode === 'click') {
    if (!clickNav(cfg, isNext)) {
      console.warn('[NodScroll] nav button not found on', location.hostname);
    }
  } else if (cfg.mode === 'both') {
    // Try the key first; if the site doesn't have a custom keyboard handler
    // it'll just bubble harmlessly. Then click as backup.
    dispatchKey(isNext);
    setTimeout(() => clickNav(cfg, isNext), 100);
  }
}

// ── Pitch extraction ─────────────────────────────────────────────────────────
function computePitch(result) {
  if (result.facialTransformationMatrixes?.length) {
    const m = result.facialTransformationMatrixes[0].data;
    return -Math.atan2(m[9], m[10]);
  }
  if (result.faceLandmarks?.length) {
    const lm   = result.faceLandmarks[0];
    const nose = lm[4];
    const lEye = lm[133];
    const rEye = lm[362];
    const eyeY = (lEye.y + rEye.y) / 2;
    const iod  = Math.hypot(rEye.x - lEye.x, rEye.y - lEye.y);
    return (nose.y - eyeY) / Math.max(iod, 0.001);
  }
  return null;
}

function getSensitivity() {
  const s = document.getElementById('nod-sens-slider');
  return s ? parseFloat(s.value) / 5 : 1.0;
}

// ── State machine (immediate-fire on threshold crossing) ─────────────────────
function processPitch(pitch) {
  if (smoothedPitch === null) { smoothedPitch = pitch; baseline = pitch; return; }
  smoothedPitch = smoothedPitch * SMOOTH_ALPHA + pitch * (1 - SMOOTH_ALPHA);
  if (nodState === 'idle') {
    baseline = baseline * BASELINE_ALPHA + smoothedPitch * (1 - BASELINE_ALPHA);
  }
  const delta  = smoothedPitch - baseline;
  lastDelta    = delta;
  const sens   = getSensitivity();
  const downTh = THRESHOLD_DOWN / sens;
  const upTh   = THRESHOLD_UP   / sens;
  if (nodState === 'idle') {
    if (delta > downTh)      fireNod('down');
    else if (delta < -upTh)  fireNod('up');
  }
}

// ── Cross-site persistent storage ────────────────────────────────────────────
// Routed through content.js (isolated world) which has chrome.storage.local
// access. State is shared across every site the extension runs on, so paying
// once unlocks Facebook, YouTube, TikTok, and Instagram all at the same time.
const state = {
  paid: false,
  code: '',
  deviceId: null,
  sensitivity: 5,
  enabled: false,
  freeUsedDate: '',  // YYYY-MM-DD
  freeUsedToday: 0,
};

// Reads use a two-pass strategy: synchronous localStorage first (so state is
// hydrated immediately on page load, even mid-reload), then chrome.storage
// for cross-site values. Writes go to BOTH stores. localStorage protects
// against the page reloading before the async chrome.storage message round-
// trip finishes; chrome.storage gives us cross-site (FB ↔ TikTok ↔ etc) sync.
const LS_PREFIX = 'nodScroll_';
const LS_KEYS = ['paid', 'code', 'deviceId', 'sensitivity', 'enabled',
                 'freeUsedDate', 'freeUsedToday'];

function readLocalStorage() {
  const out = {};
  for (const k of LS_KEYS) {
    const v = localStorage.getItem(LS_PREFIX + k);
    if (v === null) continue;
    if (k === 'paid' || k === 'enabled') out[k] = v === 'true';
    else if (k === 'sensitivity' || k === 'freeUsedToday') out[k] = parseInt(v, 10) || 0;
    else out[k] = v;
  }
  return out;
}
function writeLocalStorage(patch) {
  for (const k of Object.keys(patch)) {
    try { localStorage.setItem(LS_PREFIX + k, String(patch[k])); } catch {}
  }
}

function storageLoad() {
  // Step 1 — synchronous hydration from localStorage (instant, page-local)
  Object.assign(state, readLocalStorage());

  // Step 2 — async hydration from chrome.storage (cross-site truth)
  return new Promise((resolve) => {
    const nonce = String(Math.random()) + Date.now();
    const handler = (e) => {
      if (e.source !== window || !e.data
          || e.data.type !== 'nodScrollStorageGetResult'
          || e.data.nonce !== nonce) return;
      window.removeEventListener('message', handler);
      const cs = e.data.data || {};
      // Merge rules:
      //  - paid: true from either source wins
      //  - freeUsedToday for today: take the higher count (truth is whichever
      //    site logged more recently)
      const today = todayKey();
      if (cs.paid)  state.paid = true;
      if (cs.code)  state.code = cs.code;
      if (cs.deviceId) state.deviceId = cs.deviceId;
      if (cs.sensitivity) state.sensitivity = cs.sensitivity;
      if (typeof cs.enabled === 'boolean') state.enabled = cs.enabled;
      if (cs.freeUsedDate === today) {
        const csN = cs.freeUsedToday || 0;
        const lsN = state.freeUsedDate === today ? (state.freeUsedToday || 0) : 0;
        state.freeUsedDate  = today;
        state.freeUsedToday = Math.max(csN, lsN);
      }
      // Push merged state back to localStorage so it stays in sync
      writeLocalStorage(state);
      resolve();
    };
    window.addEventListener('message', handler);
    window.postMessage({ type: 'nodScrollStorageGet', nonce }, '*');
    setTimeout(() => { window.removeEventListener('message', handler); resolve(); }, 3000);
  });
}

function storageSet(patch) {
  Object.assign(state, patch);
  writeLocalStorage(patch);   // ← synchronous, instant persistence
  window.postMessage({
    type: 'nodScrollStorageSet', data: patch, nonce: String(Math.random()),
  }, '*');
}

// Live cross-site sync. When another tab (or this one) writes to chrome.storage,
// content.js broadcasts the change here. We merge it into state and refresh
// the UI so PRO status / trial counter / paywall update in real time without
// needing the tab to be reloaded.
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.type !== 'nodScrollStorageChanged') return;
  const patch = e.data.patch || {};
  Object.assign(state, patch);
  writeLocalStorage(patch);
  if (typeof updatePaywallCounter === 'function') updatePaywallCounter();
  // If the user just paid in another tab, dismiss this tab's paywall.
  if (state.paid && document.getElementById('nod-paywall')) {
    const pw = document.getElementById('nod-paywall');
    if (!pw.classList.contains('hidden')) hidePaywall();
  }
});

// ── Paywall helpers ──────────────────────────────────────────────────────────
// Local-time YYYY-MM-DD so "the day" matches the user's wall clock, not UTC.
function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isPaid() { return !!state.paid; }

function getFreeUsed() {
  if (state.freeUsedDate !== todayKey()) return 0;
  return state.freeUsedToday || 0;
}

function incrementFree() {
  const today = todayKey();
  const count = (state.freeUsedDate === today ? state.freeUsedToday : 0) + 1;
  storageSet({ freeUsedDate: today, freeUsedToday: count });
  return count;
}
function getDeviceId() {
  if (!state.deviceId) {
    const id = (crypto.randomUUID ? crypto.randomUUID()
                : String(Date.now()) + Math.random().toString(36).slice(2));
    storageSet({ deviceId: id });
  }
  return state.deviceId;
}

// Sends the code to content.js (isolated world) which does the actual fetch
// to the Netlify validate function. Page CSP on FB/IG/etc blocks main-world
// fetches to non-whitelisted origins, so we route through the content script.
function tryUnlock(raw) {
  const code = (raw || '').trim().toUpperCase();
  if (!code) return Promise.resolve({ ok: false, error: 'Enter your code.' });
  return new Promise((resolve) => {
    const nonce = String(Math.random()) + Date.now();
    const handler = (e) => {
      if (e.source !== window || !e.data
          || e.data.type !== 'nodScrollValidateResult'
          || e.data.nonce !== nonce) return;
      window.removeEventListener('message', handler);
      clearTimeout(timeout);
      const data = e.data.data || {};
      if (data.valid) {
        storageSet({ paid: true, code });
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: data.error || 'Invalid code.' });
      }
    };
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ ok: false, error: 'Timeout — try again.' });
    }, 10000);
    window.addEventListener('message', handler);
    window.postMessage({
      type: 'nodScrollValidate', code, deviceId: getDeviceId(), nonce,
    }, '*');
  });
}

// ── Tongue → Like detector ───────────────────────────────────────────────────
let lastTongueTime = 0;
let tongueArmed    = true;   // becomes true again when tongue returns inside

function processTongue(blendshapes, now) {
  if (!blendshapes || !blendshapes.length) return;
  const cats = blendshapes[0].categories;
  if (!cats) return;
  const t = cats.find(c => c.categoryName === 'tongueOut');
  if (!t) return;

  if (tongueArmed && t.score > TONGUE_THRESHOLD
      && (now - lastTongueTime) > TONGUE_COOLDOWN_MS) {
    tongueArmed = false;
    lastTongueTime = now;
    fireLike();
  } else if (!tongueArmed && t.score < TONGUE_THRESHOLD * 0.4) {
    tongueArmed = true;   // re-arm only after tongue clearly returns
  }
}

function fireLike() {
  const cfg = SITE_CONFIG[location.hostname];
  if (!cfg || !cfg.like) { console.warn('[NodScroll] no like selector for', location.hostname); return; }
  const btn = document.querySelector(cfg.like);
  if (btn) {
    const target = (btn.tagName === 'svg' || btn.tagName === 'SVG')
      ? (btn.closest('button, [role="button"]') || btn)
      : btn;
    target.click();
    console.log('[NodScroll] liked (tongue) →', cfg.like);
    setStatus('❤ Liked!', 'info');
    setTimeout(() => setStatus(''), 1500);
  } else {
    console.warn('[NodScroll] like button not found on', location.hostname, '— update SITE_CONFIG.like');
    setStatus('Like button not found', 'error');
    setTimeout(() => setStatus(''), 1500);
  }
}

function fireNod(direction) {
  if (!isPaid()) {
    if (getFreeUsed() >= FREE_SCROLLS_LIMIT) {
      showPaywall();
      return;
    }
    incrementFree();
    updatePaywallCounter();
  }
  console.log('[NodScroll] fireNod:', direction, 'delta:', lastDelta.toFixed(3));
  nodState = 'cooldown';
  executeAction(direction);
  setTimeout(() => { nodState = 'idle'; }, COOLDOWN_MS);
}

// ── UI helpers ───────────────────────────────────────────────────────────────
function setStatus(msg, type = '') {
  const el = document.getElementById('nod-status');
  if (!el) return;
  el.textContent = msg;
  el.className   = type;
}

function updateUI() {
  const pitchEl = document.getElementById('nod-pitch-val');
  const dotEl   = document.getElementById('nod-bar-dot');
  const badgeEl = document.getElementById('nod-state-badge');
  if (pitchEl) pitchEl.textContent = lastDelta.toFixed(3);
  if (dotEl) {
    const pct = Math.min(Math.max((lastDelta + 0.5) * 100, 0), 100);
    dotEl.style.left = pct + '%';
    const colors = { idle: '#4caf50', cooldown: '#64b5f6' };
    dotEl.style.background = colors[nodState] || '#4caf50';
  }
  if (badgeEl) {
    badgeEl.textContent = nodState;
    badgeEl.className   = 'badge-' + nodState;
  }
  const sens   = getSensitivity();
  const downTh = THRESHOLD_DOWN / sens;
  const upTh   = THRESHOLD_UP   / sens;
  const posEl  = document.getElementById('nod-mark-pos');
  const negEl  = document.getElementById('nod-mark-neg');
  if (posEl) posEl.style.left = Math.min(Math.max(( downTh + 0.5) * 100, 0), 100) + '%';
  if (negEl) negEl.style.left = Math.min(Math.max((-upTh   + 0.5) * 100, 0), 100) + '%';
}

// ── Detection loop ───────────────────────────────────────────────────────────
function startLoop() {
  const interval = 1000 / FPS_TARGET;
  let lastTs = 0;
  function loop(ts) {
    if (!enabled) return;
    rafId = requestAnimationFrame(loop);
    if (ts - lastTs < interval) return;
    lastTs = ts;
    if (videoEl.readyState < 2) return;
    const result = faceLandmarker.detectForVideo(videoEl, ts);
    const p = computePitch(result);
    if (p !== null) processPitch(p);
    processTongue(result.faceBlendshapes, Date.now());
    updateUI();
  }
  rafId = requestAnimationFrame(loop);
}

// ── MediaPipe init ───────────────────────────────────────────────────────────
async function initFaceLandmarker() {
  if (faceLandmarker) return;
  const fs = await FilesetResolver.forVisionTasks(WASM_PATH);
  faceLandmarker = await FaceLandmarker.createFromOptions(fs, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFacialTransformationMatrixes: true,
    outputFaceBlendshapes: true,   // enables tongueOut detection
  });
}

// ── Enable / disable ─────────────────────────────────────────────────────────
async function enableTracking() {
  const btn    = document.getElementById('nod-toggle-btn');
  const camOff = document.getElementById('nod-camera-off');
  videoEl      = document.getElementById('nod-video');
  try {
    setStatus('Loading model…', 'info');
    await initFaceLandmarker();
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    videoEl.srcObject = stream;
    await new Promise((res, rej) => {
      videoEl.onloadedmetadata = res;
      videoEl.onerror = rej;
    });
    if (camOff) camOff.style.display = 'none';
    enabled = true;
    nodState = 'idle';
    smoothedPitch = null; baseline = null; lastDelta = 0;
    if (btn) { btn.textContent = 'Disable Tracking'; btn.className = 'on'; }
    setStatus('Tracking active', 'info');
    storageSet({ enabled: true });
    startLoop();
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
    console.error('[NodScroll]', err);
    storageSet({ enabled: false });
  }
}

function disableTracking() {
  const btn    = document.getElementById('nod-toggle-btn');
  const camOff = document.getElementById('nod-camera-off');
  enabled = false; nodState = 'idle';
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (videoEl && videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
  if (camOff) camOff.style.display = '';
  if (btn) { btn.textContent = 'Enable Tracking'; btn.className = 'off'; }
  setStatus('Tracking disabled');
  storageSet({ enabled: false });
  const pitchEl = document.getElementById('nod-pitch-val');
  if (pitchEl) pitchEl.textContent = '—';
  const badgeEl = document.getElementById('nod-state-badge');
  if (badgeEl) { badgeEl.textContent = 'idle'; badgeEl.className = 'badge-idle'; }
}

// ── Overlay DOM ──────────────────────────────────────────────────────────────
function buildOverlay() {
  const style = document.createElement('style');
  style.textContent = `
    #nod-overlay {
      position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;
      background: rgba(12,12,18,0.92); color: #e0e0e0;
      border-radius: 12px; width: 190px;
      border: 1px solid rgba(255,255,255,0.08);
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
      font-family: system-ui, -apple-system, sans-serif; font-size: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5); overflow: hidden;
    }
    #nod-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 10px 7px; font-weight: 600; font-size: 12px;
      letter-spacing: 0.04em; text-transform: uppercase;
      border-bottom: 1px solid rgba(255,255,255,0.07);
      cursor: grab; user-select: none;
    }
    .nod-title-row { display: flex; align-items: center; gap: 6px; }
    #nod-pro-badge {
      font-size: 9px; font-weight: 700;
      letter-spacing: 0.08em;
      padding: 1px 5px; border-radius: 4px;
      background: rgba(96,200,110,0.18);
      color: #7ad889;
      border: 1px solid rgba(96,200,110,0.4);
    }
    #nod-pro-badge.hidden { display: none; }
    #nod-header:active { cursor: grabbing; }
    #nod-collapse-btn {
      background: none; border: none; color: #aaa; font-size: 16px;
      line-height: 1; cursor: pointer; padding: 0 2px;
    }
    #nod-collapse-btn:hover { color: #fff; }
    #nod-body { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 7px; }
    /* Collapsed: hide all controls but keep the video element rendered
       offscreen so MediaPipe keeps receiving frames. */
    #nod-body.nod-collapsed { padding: 0; gap: 0; }
    #nod-body.nod-collapsed > *:not(.nod-video-wrap) { display: none !important; }
    #nod-body.nod-collapsed > .nod-video-wrap {
      position: absolute; left: -9999px; top: 0;
      width: 160px; height: 90px; pointer-events: none;
    }
    .nod-video-wrap {
      position: relative; border-radius: 6px; overflow: hidden;
      height: 90px; background: #111;
    }
    #nod-video {
      width: 100%; height: 90px; object-fit: cover;
      transform: scaleX(-1); border-radius: 6px; display: block;
    }
    #nod-camera-off {
      position: absolute; inset: 0; display: flex; align-items: center;
      justify-content: center; font-size: 11px; color: #666; pointer-events: none;
    }
    .nod-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .nod-label { color: #888; }
    .nod-value { font-variant-numeric: tabular-nums; color: #e0e0e0; }
    .nod-bar-wrap {
      position: relative; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px;
    }
    #nod-bar-dot {
      position: absolute; top: 50%; width: 8px; height: 8px; border-radius: 50%;
      transform: translate(-50%,-50%); background: #4caf50; transition: background 0.12s;
    }
    .nod-bar-mark {
      position: absolute; top: 50%; width: 1px; height: 10px;
      background: rgba(255,255,255,0.35); transform: translate(-50%,-50%);
    }
    #nod-state-badge {
      font-size: 11px; padding: 1px 5px; border-radius: 4px;
      font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
    }
    .badge-idle     { background: rgba(255,255,255,0.08); color: #aaa; }
    .badge-cooldown { background: rgba(33,150,243,0.25); color: #64b5f6; }
    .nod-slider-row { display: flex; flex-direction: column; gap: 3px; }
    .nod-slider-label { display: flex; justify-content: space-between; }
    #nod-sens-slider { width: 100%; accent-color: #64b5f6; cursor: pointer; }
    #nod-status { font-size: 11px; min-height: 14px; color: #888; word-break: break-word; }
    #nod-status.error { color: #ef5350; }
    #nod-status.info  { color: #81c784; }
    #nod-toggle-btn {
      width: 100%; border: none; border-radius: 6px; padding: 6px 0;
      font-size: 12px; font-weight: 600; cursor: pointer;
    }
    #nod-toggle-btn.off { background: #2e7d32; color: #c8e6c9; }
    #nod-toggle-btn.off:hover { background: #388e3c; }
    #nod-toggle-btn.on  { background: #b71c1c; color: #ffcdd2; }
    #nod-toggle-btn.on:hover  { background: #c62828; }
    #nod-trial { font-size: 10px; color: #888; text-align: center; margin-top: 2px; }
    #nod-trial.hidden { display: none; }
    #nod-trial.paid { color: #7ad889; font-weight: 600; }
    /* Paywall card */
    #nod-paywall { padding: 12px 10px; display: flex; flex-direction: column; gap: 7px; }
    #nod-paywall.hidden { display: none; }
    .nod-paywall-title { font-size: 13px; font-weight: 700; color: #fff; }
    .nod-paywall-sub   { font-size: 11px; color: #aaa; line-height: 1.35; }
    .nod-paywall-or    { font-size: 10px; color: #777; margin-top: 6px; }
    #nod-buy-btn {
      width: 100%; border: none; border-radius: 6px; padding: 8px 0;
      font-size: 13px; font-weight: 700; cursor: pointer;
      background: #60c86e; color: #0a0f1a;
    }
    #nod-buy-btn:hover { background: #7ad889; }
    #nod-code-input {
      width: 100%; padding: 5px 7px; border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.05);
      color: #fff; font-size: 12px; font-family: ui-monospace, monospace;
    }
    #nod-code-input:focus { outline: 1px solid #60c86e; }
    #nod-activate-btn {
      width: 100%; border: 1px solid rgba(255,255,255,0.15);
      background: transparent; color: #ddd;
      border-radius: 4px; padding: 4px 0; font-size: 11px; cursor: pointer;
    }
    #nod-activate-btn:hover { background: rgba(255,255,255,0.06); }
    #nod-paywall-err { font-size: 10px; color: #ef5350; min-height: 12px; text-align: center; }
  `;
  document.head.appendChild(style);

  // Build DOM with createElement — innerHTML/DOMParser are blocked on sites
  // with Trusted Types CSP (e.g. YouTube). This is the only bulletproof path.
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const k in (attrs || {})) {
      const v = attrs[k];
      if (k === 'class')      n.className   = v;
      else if (k === 'text')  n.textContent = v;
      else if (v === true)    n.setAttribute(k, '');
      else                    n.setAttribute(k, v);
    }
    for (const c of kids) if (c) n.appendChild(c);
    return n;
  };

  const overlay = el('div', { id: 'nod-overlay' },
    el('div', { id: 'nod-header' },
      el('div', { class: 'nod-title-row' },
        el('span', { text: 'Nod Scroll' }),
        el('span', { id: 'nod-pro-badge', class: 'hidden', text: 'PRO' })
      ),
      el('button', { id: 'nod-collapse-btn', title: 'Collapse', text: '−' })
    ),
    el('div', { id: 'nod-body' },
      el('div', { class: 'nod-video-wrap' },
        el('video', { id: 'nod-video', autoplay: true, muted: true, playsinline: true }),
        el('div', { id: 'nod-camera-off', text: 'Camera off' })
      ),
      el('div', { class: 'nod-row' },
        el('span', { class: 'nod-label', text: 'Pitch' }),
        el('span', { class: 'nod-value', id: 'nod-pitch-val', text: '—' })
      ),
      el('div', { class: 'nod-bar-wrap' },
        el('div', { class: 'nod-bar-mark', id: 'nod-mark-pos' }),
        el('div', { class: 'nod-bar-mark', id: 'nod-mark-neg' }),
        el('div', { id: 'nod-bar-dot' })
      ),
      el('div', { class: 'nod-row' },
        el('span', { class: 'nod-label', text: 'State' }),
        el('span', { id: 'nod-state-badge', class: 'badge-idle', text: 'idle' })
      ),
      el('div', { class: 'nod-slider-row' },
        el('div', { class: 'nod-slider-label' },
          el('span', { class: 'nod-label', text: 'Sensitivity' }),
          el('span', { class: 'nod-value', id: 'nod-sens-val', text: '5' })
        ),
        el('input', { type: 'range', id: 'nod-sens-slider', min: '1', max: '10', step: '1', value: '5' })
      ),
      el('div', { id: 'nod-status', text: 'Ready' }),
      el('button', { id: 'nod-toggle-btn', class: 'off', text: 'Enable Tracking' }),
      el('div', { id: 'nod-trial', text: '' })
    ),
    // Paywall card — hidden by default, shown when trial is exhausted
    el('div', { id: 'nod-paywall', class: 'hidden' },
      el('div', { class: 'nod-paywall-title', text: 'Free trial used' }),
      el('div', { class: 'nod-paywall-sub',   text: 'Unlock unlimited nods for $0.99 — one-time.' }),
      el('button', { id: 'nod-buy-btn',  text: 'Buy ($0.99)' }),
      el('div', { class: 'nod-paywall-or', text: 'Already paid? Enter your unlock code:' }),
      el('input', { type: 'text', id: 'nod-code-input', placeholder: 'NOD-XXXX-XXXX' }),
      el('button', { id: 'nod-activate-btn', text: 'Activate' }),
      el('div', { id: 'nod-paywall-err', text: '' })
    )
  );
  document.body.appendChild(overlay);
}

function showPaywall() {
  document.getElementById('nod-body').style.display    = 'none';
  document.getElementById('nod-paywall').classList.remove('hidden');
}
function hidePaywall() {
  document.getElementById('nod-body').style.display    = '';
  document.getElementById('nod-paywall').classList.add('hidden');
}
function updatePaywallCounter() {
  const el       = document.getElementById('nod-trial');
  const proBadge = document.getElementById('nod-pro-badge');
  if (!el) return;
  if (isPaid()) {
    el.textContent = '✓ Unlimited — Pro';
    el.className   = 'paid';
    if (proBadge) proBadge.classList.remove('hidden');
    return;
  }
  const remaining = Math.max(0, FREE_SCROLLS_LIMIT - getFreeUsed());
  el.textContent = `Free trial: ${remaining}/${FREE_SCROLLS_LIMIT} scrolls left today`;
  el.className = '';
  if (proBadge) proBadge.classList.add('hidden');
}

function setupOverlay() {
  const overlay     = document.getElementById('nod-overlay');
  const header      = document.getElementById('nod-header');
  const collapseBtn = document.getElementById('nod-collapse-btn');
  const body        = document.getElementById('nod-body');
  const toggleBtn   = document.getElementById('nod-toggle-btn');
  const sensSlider  = document.getElementById('nod-sens-slider');
  const sensVal     = document.getElementById('nod-sens-val');
  const buyBtn      = document.getElementById('nod-buy-btn');
  const activateBtn = document.getElementById('nod-activate-btn');
  const codeInput   = document.getElementById('nod-code-input');
  const paywallErr  = document.getElementById('nod-paywall-err');

  buyBtn.addEventListener('click', () => {
    window.open(STRIPE_PAYMENT_URL, '_blank', 'noopener');
  });
  activateBtn.addEventListener('click', async () => {
    activateBtn.disabled = true;
    paywallErr.textContent = 'Checking…';
    paywallErr.style.color = '';
    const result = await tryUnlock(codeInput.value);
    activateBtn.disabled = false;
    if (result.ok) {
      paywallErr.textContent = '';
      updatePaywallCounter();
      hidePaywall();
    } else {
      paywallErr.textContent = result.error;
      paywallErr.style.color = '#ef5350';
    }
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') activateBtn.click();
  });

  updatePaywallCounter();
  if (!isPaid() && getFreeUsed() >= FREE_SCROLLS_LIMIT) showPaywall();

  if (state.sensitivity) {
    sensSlider.value = state.sensitivity;
    sensVal.textContent = state.sensitivity;
  }

  collapseBtn.addEventListener('click', () => {
    const c = body.classList.toggle('nod-collapsed');
    collapseBtn.textContent = c ? '+' : '−';
  });

  let dragging = false, dragOffX = 0, dragOffY = 0, usingTL = false;
  header.addEventListener('mousedown', (e) => {
    if (e.target === collapseBtn) return;
    dragging = true;
    const r = overlay.getBoundingClientRect();
    dragOffX = e.clientX - r.left; dragOffY = e.clientY - r.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    if (!usingTL) { overlay.style.right = 'auto'; overlay.style.bottom = 'auto'; usingTL = true; }
    overlay.style.left = (e.clientX - dragOffX) + 'px';
    overlay.style.top  = (e.clientY - dragOffY) + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  toggleBtn.addEventListener('click', () => {
    if (enabled) disableTracking(); else enableTracking();
  });

  sensSlider.addEventListener('input', () => {
    sensVal.textContent = sensSlider.value;
    storageSet({ sensitivity: parseInt(sensSlider.value, 10) });
  });

  if (state.enabled) {
    enableTracking();
  }
}

async function init() {
  if (document.getElementById('nod-overlay')) return;
  await storageLoad();   // hydrate cross-site state before building UI
  buildOverlay();
  setupOverlay();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

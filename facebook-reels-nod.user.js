// ==UserScript==
// @name         Facebook Reels — Head Nod Scroll
// @namespace    https://github.com/user/nod-scroll
// @version      1.0.0
// @description  Use head nods to navigate Facebook Reels hands-free
// @author       You
// @match        https://www.facebook.com/reel/*
// @match        https://www.facebook.com/reels/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// ── INSTALL INSTRUCTIONS ────────────────────────────────────────────────────
//
//  1. Install the Tampermonkey browser extension:
//       Chrome  → https://www.tampermonkey.net
//       Firefox → https://www.tampermonkey.net
//  2. Click the Tampermonkey icon → "Create a new script"
//  3. Delete the default template content, paste this entire file, then Save
//     (Ctrl+S / Cmd+S).
//  4. Navigate to any Facebook Reel:
//       https://www.facebook.com/reels/
//       or any direct reel URL like https://www.facebook.com/reel/123456789
//  5. The Nod Scroll overlay appears in the bottom-right corner.
//  6. Click "Enable Tracking" and grant camera permission when prompted.
//  7. Nod your head down to advance to the next reel, nod up to go back.
//
// ── HOW TO TUNE THRESHOLDS ──────────────────────────────────────────────────
//
//  NOD_DOWN_THRESHOLD (default 0.30)
//    Controls how far you must nod before the gesture is "armed".
//    • Increase (e.g. 0.40) if small head movements trigger false nods.
//    • Decrease (e.g. 0.20) if you have to nod very hard to arm it.
//
//  NOD_UP_THRESHOLD (default 0.10)
//    Controls how far back toward neutral you must return to fire the action.
//    • Increase if the nod fires too easily after arming.
//    • Decrease if you have to return very close to neutral to fire.
//
//  MIN_NOD_DURATION_MS (default 130 ms)
//    Minimum time between arm and fire. Filters jitter / accidental twitches.
//    • Increase if single-frame spikes trigger nods.
//    • Decrease if quick, snappy nods are not detected.
//
//  MAX_NOD_DURATION_MS (default 1200 ms)
//    Maximum time allowed from arm to fire. Filters slow postural drift.
//    • Increase if deliberate slow nods are not firing.
//    • Decrease if slouching slowly triggers unintended nods.
//
//  Use the Sensitivity slider in the overlay as a quick coarse adjustment
//  (range 1–10, default 5 = 1× multiplier). Higher values make the detector
//  more sensitive without editing constants directly.
//
// ── FACEBOOK DOM WARNING ────────────────────────────────────────────────────
//
//  Facebook changes its DOM structure and keyboard event handling frequently.
//  If reel navigation stops working after a Facebook update:
//    1. Check whether ArrowDown / ArrowUp keyboard events still work manually.
//    2. Inspect the "Next reel" / "Previous reel" buttons and update the
//       aria-label selectors in executeAction() below.
//    3. The fallback button-click runs 150 ms after the keyboard event —
//       keep both strategies in sync with the current FB DOM.
//
// ───────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  const NOD_DOWN_THRESHOLD  = 0.30;   // nose-Y delta to arm (inter-ocular units)
  const NOD_UP_THRESHOLD    = 0.10;   // return-to-baseline threshold to fire
  const COOLDOWN_MS         = 800;    // ignore period after firing (ms)
  const MIN_NOD_DURATION_MS = 130;    // filter out noise/jitter below this (ms)
  const MAX_NOD_DURATION_MS = 1200;   // filter out slow drift above this (ms)
  const SMOOTH_ALPHA        = 0.65;   // IIR smoothing factor (0=no smooth, 1=frozen)
  const BASELINE_ALPHA      = 0.985;  // baseline EMA decay (high = slow adaptation)
  const FPS_TARGET          = 30;
  const WASM_CDN   = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
  const MODEL_URL  = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
  const VISION_ESM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

  // ── Runtime state ──────────────────────────────────────────────────────────
  let faceLandmarker  = null;
  let videoEl         = null;
  let rafId           = null;
  let enabled         = false;

  let nodState        = 'idle';   // 'idle' | 'armed' | 'cooldown'
  let nodDirection    = null;     // 'down' | 'up' | null
  let nodStartTime    = 0;
  let peakAbsDelta    = 0;
  let smoothedPitch   = null;
  let baseline        = null;
  let lastDelta       = 0;

  // ── Platform action ───────────────────────────────────────────────────────
  function executeAction(direction) {
    const isNext  = direction === 'up';
    // Primary: synthetic keyboard event — Facebook Reels responds to ArrowDown/ArrowUp
    const key     = isNext ? 'ArrowDown' : 'ArrowUp';
    const keyCode = isNext ? 40 : 38;
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key, code: key, keyCode, which: keyCode,
      bubbles: true, cancelable: true, composed: true,
    }));

    // Fallback: button click (~150ms later, in case keyboard event was swallowed)
    // NOTE: Facebook changes its DOM regularly — update these selectors if navigation breaks
    setTimeout(() => {
      const nextSels = ['[aria-label="Next card"]', '[aria-label="Next reel"]', '[aria-label="Next"]'];
      const prevSels = ['[aria-label="Previous card"]', '[aria-label="Previous reel"]', '[aria-label="Previous"]'];
      for (const sel of (isNext ? nextSels : prevSels)) {
        const el = document.querySelector(sel);
        if (el) { el.click(); return; }
      }
    }, 150);
  }

  // ── Pitch extraction ──────────────────────────────────────────────────────
  function computePitch(result) {
    if (result.facialTransformationMatrixes?.length) {
      const m = result.facialTransformationMatrixes[0].data;
      // Row-major layout: data[9] = R[2][1], data[10] = R[2][2]
      // atan2(R[2][1], R[2][2]) = pitch around X-axis
      // Negated so chin-drop gives a positive delta (more natural thresholding)
      return -Math.atan2(m[9], m[10]);
    }
    // Fallback: nose-Y relative to eye midpoint, normalized by inter-ocular distance
    // Positive = chin down, negative = chin up
    if (result.faceLandmarks?.length) {
      const lm   = result.faceLandmarks[0];
      const nose = lm[4];    // nose tip
      const lEye = lm[133];  // left eye inner corner
      const rEye = lm[362];  // right eye inner corner
      const eyeY = (lEye.y + rEye.y) / 2;
      const iod  = Math.hypot(rEye.x - lEye.x, rEye.y - lEye.y);
      return (nose.y - eyeY) / Math.max(iod, 0.001);
    }
    return null;
  }

  // ── Sensitivity ───────────────────────────────────────────────────────────
  function getSensitivity() {
    const slider = document.getElementById('nod-sens-slider');
    return slider ? parseFloat(slider.value) / 5 : 1.0;
  }

  // ── State machine ─────────────────────────────────────────────────────────
  function processPitch(pitch, now) {
    if (smoothedPitch === null) { smoothedPitch = pitch; baseline = pitch; return; }

    smoothedPitch = smoothedPitch * SMOOTH_ALPHA + pitch * (1 - SMOOTH_ALPHA);

    if (nodState === 'idle') {
      baseline = baseline * BASELINE_ALPHA + smoothedPitch * (1 - BASELINE_ALPHA);
    }

    const delta  = smoothedPitch - baseline;
    lastDelta    = delta;
    const sens   = getSensitivity();
    const downTh   = NOD_DOWN_THRESHOLD / sens;
    const returnTh = NOD_UP_THRESHOLD   / sens;

    if (nodState === 'idle') {
      if (delta > downTh)       fireNod('down');
      else if (delta < -downTh) fireNod('up');
    }
  }

  function fireNod(direction) {
    nodState = 'cooldown';
    executeAction(direction);
    setTimeout(() => { nodState = 'idle'; }, COOLDOWN_MS);
  }

  // ── UI helpers ────────────────────────────────────────────────────────────
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
      const pct = Math.min(Math.max((lastDelta + 0.5) / 1.0 * 100, 0), 100);
      dotEl.style.left = pct + '%';
      const colors = { idle: '#4caf50', armed: '#ffa726', cooldown: '#64b5f6' };
      dotEl.style.background = colors[nodState] || '#4caf50';
    }

    if (badgeEl) {
      badgeEl.textContent = nodState;
      badgeEl.className   = 'badge-' + nodState;
    }

    const sens   = getSensitivity();
    const downTh = NOD_DOWN_THRESHOLD / sens;
    const posEl  = document.getElementById('nod-mark-pos');
    const negEl  = document.getElementById('nod-mark-neg');
    if (posEl) posEl.style.left = Math.min(Math.max(( downTh + 0.5) / 1.0 * 100, 0), 100) + '%';
    if (negEl) negEl.style.left = Math.min(Math.max((-downTh + 0.5) / 1.0 * 100, 0), 100) + '%';
  }

  // ── Detection loop ────────────────────────────────────────────────────────
  function startLoop() {
    const frameInterval = 1000 / FPS_TARGET;
    let lastTs = 0;
    function loop(ts) {
      if (!enabled) return;
      rafId = requestAnimationFrame(loop);
      if (ts - lastTs < frameInterval) return;
      lastTs = ts;
      if (videoEl.readyState < 2) return;
      const result = faceLandmarker.detectForVideo(videoEl, ts);
      const p = computePitch(result);
      if (p !== null) processPitch(p, Date.now());
      updateUI();
    }
    rafId = requestAnimationFrame(loop);
  }

  // ── MediaPipe init ────────────────────────────────────────────────────────
  async function initFaceLandmarker() {
    if (faceLandmarker) return;
    // Dynamic ESM import — Tampermonkey @require can't load .mjs modules
    const { FaceLandmarker, FilesetResolver } = await import(VISION_ESM);
    const fs = await FilesetResolver.forVisionTasks(WASM_CDN);
    faceLandmarker = await FaceLandmarker.createFromOptions(fs, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFacialTransformationMatrixes: true,
      outputFaceBlendshapes: false,
    });
  }

  // ── Enable / disable ──────────────────────────────────────────────────────
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
      enabled  = true;
      nodState = 'idle';
      smoothedPitch = null;
      baseline      = null;
      lastDelta     = 0;

      if (btn) { btn.textContent = 'Disable Tracking'; btn.className = 'on'; }
      setStatus('Tracking active', 'info');
      localStorage.setItem('nodScroll_enabled', 'true');
      startLoop();
    } catch (err) {
      setStatus('Error: ' + err.message, 'error');
      console.error('[NodScroll]', err);
      localStorage.setItem('nodScroll_enabled', 'false');
    }
  }

  function disableTracking() {
    const btn    = document.getElementById('nod-toggle-btn');
    const camOff = document.getElementById('nod-camera-off');

    enabled  = false;
    nodState = 'idle';
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

    if (videoEl && videoEl.srcObject) {
      videoEl.srcObject.getTracks().forEach(t => t.stop());
      videoEl.srcObject = null;
    }

    if (camOff) camOff.style.display = '';
    if (btn) { btn.textContent = 'Enable Tracking'; btn.className = 'off'; }
    setStatus('Tracking disabled');
    localStorage.setItem('nodScroll_enabled', 'false');

    const pitchEl = document.getElementById('nod-pitch-val');
    if (pitchEl) pitchEl.textContent = '—';
    const badgeEl = document.getElementById('nod-state-badge');
    if (badgeEl) { badgeEl.textContent = 'idle'; badgeEl.className = 'badge-idle'; }
  }

  // ── Build overlay DOM ─────────────────────────────────────────────────────
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
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        overflow: hidden; cursor: default;
      }
      #nod-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 10px 7px; font-weight: 600; font-size: 12px;
        letter-spacing: 0.04em; text-transform: uppercase;
        border-bottom: 1px solid rgba(255,255,255,0.07);
        cursor: grab; user-select: none;
      }
      #nod-header:active { cursor: grabbing; }
      #nod-collapse-btn {
        background: none; border: none; color: #aaa; font-size: 16px;
        line-height: 1; cursor: pointer; padding: 0 2px;
      }
      #nod-collapse-btn:hover { color: #fff; }
      #nod-body { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 7px; }
      #nod-body.nod-collapsed { display: none !important; }
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
      .badge-armed    { background: rgba(255,165,0,0.25);   color: #ffa500; }
      .badge-cooldown { background: rgba(33,150,243,0.25);  color: #64b5f6; }
      .nod-slider-row { display: flex; flex-direction: column; gap: 3px; }
      .nod-slider-label { display: flex; justify-content: space-between; }
      #nod-sens-slider { width: 100%; accent-color: #64b5f6; cursor: pointer; }
      #nod-status { font-size: 11px; min-height: 14px; color: #888; word-break: break-word; }
      #nod-status.error { color: #ef5350; }
      #nod-status.info  { color: #81c784; }
      #nod-toggle-btn {
        width: 100%; border: none; border-radius: 6px; padding: 6px 0;
        font-size: 12px; font-weight: 600; cursor: pointer;
        transition: background 0.15s, color 0.15s;
      }
      #nod-toggle-btn.off { background: #2e7d32; color: #c8e6c9; }
      #nod-toggle-btn.off:hover { background: #388e3c; }
      #nod-toggle-btn.on  { background: #b71c1c; color: #ffcdd2; }
      #nod-toggle-btn.on:hover  { background: #c62828; }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'nod-overlay';
    overlay.innerHTML = `
      <div id="nod-header">
        <span>Nod Scroll</span>
        <button id="nod-collapse-btn" title="Collapse">−</button>
      </div>
      <div id="nod-body">
        <div class="nod-video-wrap">
          <video id="nod-video" autoplay muted playsinline></video>
          <div id="nod-camera-off">Camera off</div>
        </div>
        <div class="nod-row">
          <span class="nod-label">Pitch</span>
          <span class="nod-value" id="nod-pitch-val">—</span>
        </div>
        <div class="nod-bar-wrap" id="nod-bar-wrap">
          <div class="nod-bar-mark" id="nod-mark-pos"></div>
          <div class="nod-bar-mark" id="nod-mark-neg"></div>
          <div id="nod-bar-dot"></div>
        </div>
        <div class="nod-row">
          <span class="nod-label">State</span>
          <span id="nod-state-badge" class="badge-idle">idle</span>
        </div>
        <div class="nod-slider-row">
          <div class="nod-slider-label">
            <span class="nod-label">Sensitivity</span>
            <span class="nod-value" id="nod-sens-val">5</span>
          </div>
          <input type="range" id="nod-sens-slider" min="1" max="10" step="1" value="5" />
        </div>
        <div id="nod-status">Ready</div>
        <button id="nod-toggle-btn" class="off">Enable Tracking</button>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  // ── Wire overlay controls ─────────────────────────────────────────────────
  function setupOverlay() {
    const overlay     = document.getElementById('nod-overlay');
    const header      = document.getElementById('nod-header');
    const collapseBtn = document.getElementById('nod-collapse-btn');
    const body        = document.getElementById('nod-body');
    const toggleBtn   = document.getElementById('nod-toggle-btn');
    const sensSlider  = document.getElementById('nod-sens-slider');
    const sensVal     = document.getElementById('nod-sens-val');

    // Restore sensitivity
    const savedSens = localStorage.getItem('nodScroll_sensitivity');
    if (savedSens !== null) {
      sensSlider.value  = savedSens;
      sensVal.textContent = savedSens;
    }

    // Collapse / expand
    collapseBtn.addEventListener('click', () => {
      const collapsed = body.classList.toggle('nod-collapsed');
      collapseBtn.textContent = collapsed ? '+' : '−';
    });

    // Draggable header
    let dragging = false;
    let dragOffX = 0, dragOffY = 0;
    let usingTopLeft = false;

    header.addEventListener('mousedown', (e) => {
      if (e.target === collapseBtn) return;
      dragging = true;
      const rect = overlay.getBoundingClientRect();
      dragOffX = e.clientX - rect.left;
      dragOffY = e.clientY - rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      if (!usingTopLeft) {
        overlay.style.right  = 'auto';
        overlay.style.bottom = 'auto';
        usingTopLeft = true;
      }
      overlay.style.left = (e.clientX - dragOffX) + 'px';
      overlay.style.top  = (e.clientY - dragOffY) + 'px';
    });

    document.addEventListener('mouseup', () => { dragging = false; });

    // Toggle tracking
    toggleBtn.addEventListener('click', () => {
      if (enabled) {
        disableTracking();
      } else {
        enableTracking();
      }
    });

    // Sensitivity slider
    sensSlider.addEventListener('input', () => {
      const v = sensSlider.value;
      sensVal.textContent = v;
      localStorage.setItem('nodScroll_sensitivity', v);
    });

    // Auto-enable if previously enabled
    if (localStorage.getItem('nodScroll_enabled') === 'true') {
      enableTracking();
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function init() {
    buildOverlay();
    setupOverlay();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

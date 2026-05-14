#!/usr/bin/env bash
# Downloads MediaPipe Face Landmarker assets into ./vendor/ so the extension
# can load them locally (bypasses Facebook's CSP which blocks CDN scripts).
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p vendor/wasm

VERSION="0.10.14"
BASE="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}"
MODEL="https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"

echo "→ vision_bundle.mjs"
curl -fsSL "${BASE}/vision_bundle.mjs" -o vendor/vision_bundle.mjs

echo "→ wasm/vision_wasm_internal.js"
curl -fsSL "${BASE}/wasm/vision_wasm_internal.js" -o vendor/wasm/vision_wasm_internal.js

echo "→ wasm/vision_wasm_internal.wasm"
curl -fsSL "${BASE}/wasm/vision_wasm_internal.wasm" -o vendor/wasm/vision_wasm_internal.wasm

echo "→ wasm/vision_wasm_nosimd_internal.js"
curl -fsSL "${BASE}/wasm/vision_wasm_nosimd_internal.js" -o vendor/wasm/vision_wasm_nosimd_internal.js

echo "→ wasm/vision_wasm_nosimd_internal.wasm"
curl -fsSL "${BASE}/wasm/vision_wasm_nosimd_internal.wasm" -o vendor/wasm/vision_wasm_nosimd_internal.wasm

echo "→ face_landmarker.task"
curl -fsSL "${MODEL}" -o vendor/face_landmarker.task

echo ""
echo "✓ Done. Vendor files:"
ls -lh vendor vendor/wasm

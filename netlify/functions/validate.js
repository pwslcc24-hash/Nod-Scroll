// Called by the extension when a user pastes their unlock code.
// Body: { code: "NOD-XXXX-XXXX-XXXX", deviceId: "<uuid>" }
// Response: { valid: true } or { valid: false, error: "..." }
//
// Activations are tracked per code. If a code has already been activated on
// MAX_ACTIVATIONS distinct devices, further new devices get rejected — so
// posting the code on Reddit doesn't help anyone after the limit is hit.

import { getStore } from '@netlify/blobs';

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: cors });
  }

  let body;
  try { body = await req.json(); }
  catch { return json({ valid: false, error: 'Bad JSON' }, 400); }

  const code     = (body.code     || '').trim().toUpperCase();
  const deviceId = (body.deviceId || '').trim();

  if (!code || !deviceId) {
    return json({ valid: false, error: 'Missing code or deviceId' }, 400);
  }

  const licenses = getStore('licenses');
  const license  = await licenses.get(code, { type: 'json' });

  if (!license) {
    return json({ valid: false, error: 'Invalid code' });
  }

  // Already activated on this device → still valid.
  if (license.activations.includes(deviceId)) {
    return json({ valid: true });
  }

  // New device — check activation limit.
  if (license.activations.length >= license.maxActivations) {
    return json({ valid: false, error: 'Activation limit reached for this code' });
  }

  license.activations.push(deviceId);
  await licenses.setJSON(code, license);
  return json({ valid: true });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// Called by the success page after Stripe redirects there. Looks up the
// license code for the given checkout session_id, so the buyer can see and
// copy their unique unlock code.
//
// Query: ?session_id=cs_...
// Response: { code: "NOD-XXXX-XXXX-XXXX" } or { error: "..." }

import { getStore } from '@netlify/blobs';

export default async (req) => {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('session_id');
  if (!sessionId) {
    return Response.json({ error: 'Missing session_id' }, { status: 400 });
  }

  const sessions = getStore('sessions');
  // Webhook is async — Stripe redirects before the webhook may have completed.
  // Poll Blobs briefly so the buyer doesn't have to refresh.
  let code = null;
  for (let i = 0; i < 10; i++) {
    code = await sessions.get(sessionId);
    if (code) break;
    await new Promise(r => setTimeout(r, 600));
  }

  if (!code) {
    return Response.json({ error: 'Code not ready yet — refresh in a moment.' }, { status: 404 });
  }
  return Response.json({ code });
};

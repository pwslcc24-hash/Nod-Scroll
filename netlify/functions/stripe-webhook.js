// Receives Stripe webhook calls. On a successful checkout, generates a unique
// license key, stores it in Netlify Blobs, and maps the Stripe session_id to
// the key so the success page can look it up.
//
// Environment variables required (set in Netlify dashboard, NOT in code):
//   STRIPE_SECRET_KEY      — sk_test_... or sk_live_...
//   STRIPE_WEBHOOK_SECRET  — whsec_... (from Stripe webhook settings)

import Stripe from 'stripe';
import { getStore } from '@netlify/blobs';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const MAX_ACTIVATIONS = 3;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // skip ambiguous chars

function generateCode() {
  const seg = () => Array.from({ length: 4 }, () =>
    CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  return `NOD-${seg()}-${seg()}-${seg()}`;
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const sig = req.headers.get('stripe-signature');
  const body = await req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const licenses = getStore('licenses');
    const sessions = getStore('sessions');

    // Generate a unique code (retry in unlikely collision case)
    let code;
    for (let i = 0; i < 5; i++) {
      const candidate = generateCode();
      const existing = await licenses.get(candidate);
      if (!existing) { code = candidate; break; }
    }
    if (!code) {
      console.error('Failed to generate unique code after 5 tries');
      return new Response('Code generation failed', { status: 500 });
    }

    await licenses.setJSON(code, {
      created: Date.now(),
      stripeSessionId: session.id,
      customerEmail: session.customer_details?.email || null,
      maxActivations: MAX_ACTIVATIONS,
      activations: [],
    });
    await sessions.set(session.id, code);

    console.log('Issued license:', code, 'for session:', session.id);
  }

  return new Response('ok', { status: 200 });
};

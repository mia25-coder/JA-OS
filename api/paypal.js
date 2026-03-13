// api/paypal.js — JustAbarth OS · PayPal subscription sync
// Drop this file into an /api folder in your GitHub repo.
// Vercel will automatically serve it at /api/paypal

const PAYPAL_BASE = 'https://api-m.paypal.com'; // live endpoint

const PLAN_TIER_MAP = {
  'P-5LS643056L917673CNBXI3PA': 'Premium+',
  'P-5ET38701JS2889136M7WSGGY': 'Premium',
  'P-79Y21508MP396202VMTEPYHI': 'Basic',
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // use service role key server-side
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;

// ── PayPal auth ──────────────────────────────────────────────────────────────

async function getPayPalToken() {
  const credentials = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  return data.access_token;
}

// ── PayPal API helpers ───────────────────────────────────────────────────────

async function getSubscriptionsForPlan(token, planId) {
  const res = await fetch(
    `${PAYPAL_BASE}/v1/billing/subscriptions?plan_id=${planId}&status=ACTIVE&page_size=100`,
    { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  const data = await res.json();
  return data.subscriptions || [];
}

async function getSubscriptionDetail(token, subscriptionId) {
  const res = await fetch(
    `${PAYPAL_BASE}/v1/billing/subscriptions/${subscriptionId}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  return res.json();
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function supabaseFetch(path, method = 'GET', body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'resolution=merge-duplicates' : '',
    },
    body: body ? JSON.stringify(body) : null,
  });
  if (res.status === 204) return null;
  return res.json();
}

// ── Sync all active subscriptions ────────────────────────────────────────────

async function syncAllSubscriptions() {
  const token = await getPayPalToken();
  const results = { added: 0, updated: 0, errors: [] };

  for (const [planId, tier] of Object.entries(PLAN_TIER_MAP)) {
    const subs = await getSubscriptionsForPlan(token, planId);

    for (const sub of subs) {
      try {
        const detail = await getSubscriptionDetail(token, sub.id);
        const email = detail.subscriber?.email_address || '';
        const name = detail.subscriber?.name?.given_name
          ? `${detail.subscriber.name.given_name} ${detail.subscriber.name.surname || ''}`.trim()
          : email;
        const joinDateISO = detail.start_time
          ? detail.start_time.split('T')[0]
          : new Date().toISOString().split('T')[0];
        const joinDate = new Date(joinDateISO + 'T12:00:00')
          .toLocaleDateString('en-GB');

        // Check if member already exists by paypal_subscription_id
        const existing = await supabaseFetch(
          `/members?paypal_subscription_id=eq.${sub.id}&select=id`
        );

        if (existing && existing.length > 0) {
          // Update tier in case they upgraded/downgraded
          await supabaseFetch(
            `/members?paypal_subscription_id=eq.${sub.id}`,
            'PATCH',
            { tier, paypal_status: 'ACTIVE' }
          );
          results.updated++;
        } else {
          // Insert new member
          await supabaseFetch('/members', 'POST', {
            handle: name,
            tier,
            car: '—',
            country: '—',
            points: 0,
            featured: false,
            last_feature: null,
            join_date: joinDate,
            join_date_iso: joinDateISO,
            paypal_email: email,
            paypal_subscription_id: sub.id,
            paypal_status: 'ACTIVE',
          });
          results.added++;
        }
      } catch (err) {
        results.errors.push({ sub: sub.id, error: err.message });
      }
    }
  }

  return results;
}

// ── Webhook handler ───────────────────────────────────────────────────────────
// PayPal will POST here when a subscription is created, cancelled, or suspended.
// Set your webhook URL in PayPal developer dashboard to: https://yourdomain.vercel.app/api/paypal

async function handleWebhook(body) {
  const eventType = body.event_type;
  const resource = body.resource;

  if (!resource) return { ignored: true };

  const subId = resource.id;
  const planId = resource.plan_id;
  const tier = PLAN_TIER_MAP[planId];

  if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED' || eventType === 'BILLING.SUBSCRIPTION.CREATED') {
    const email = resource.subscriber?.email_address || '';
    const name = resource.subscriber?.name?.given_name
      ? `${resource.subscriber.name.given_name} ${resource.subscriber.name.surname || ''}`.trim()
      : email;
    const joinDateISO = resource.start_time
      ? resource.start_time.split('T')[0]
      : new Date().toISOString().split('T')[0];
    const joinDate = new Date(joinDateISO + 'T12:00:00').toLocaleDateString('en-GB');

    await supabaseFetch('/members', 'POST', {
      handle: name,
      tier: tier || 'Basic',
      car: '—',
      country: '—',
      points: 0,
      featured: false,
      last_feature: null,
      join_date: joinDate,
      join_date_iso: joinDateISO,
      paypal_email: email,
      paypal_subscription_id: subId,
      paypal_status: 'ACTIVE',
    });
    return { action: 'member_added', handle: name, tier };
  }

  if (eventType === 'BILLING.SUBSCRIPTION.CANCELLED' || eventType === 'BILLING.SUBSCRIPTION.SUSPENDED') {
    await supabaseFetch(
      `/members?paypal_subscription_id=eq.${subId}`,
      'PATCH',
      { paypal_status: 'CANCELLED' }
    );
    return { action: 'member_cancelled', subId };
  }

  if (eventType === 'BILLING.SUBSCRIPTION.UPDATED') {
    if (tier) {
      await supabaseFetch(
        `/members?paypal_subscription_id=eq.${subId}`,
        'PATCH',
        { tier, paypal_status: 'ACTIVE' }
      );
      return { action: 'tier_updated', tier };
    }
  }

  return { ignored: true, eventType };
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET /api/paypal?action=sync — manual sync button in dashboard
    if (req.method === 'GET') {
      const action = req.query.action;
      if (action === 'sync') {
        const results = await syncAllSubscriptions();
        return res.status(200).json({ success: true, ...results });
      }
      return res.status(400).json({ error: 'Unknown action' });
    }

    // POST /api/paypal — PayPal webhook
    if (req.method === 'POST') {
      const result = await handleWebhook(req.body);
      return res.status(200).json({ success: true, ...result });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('PayPal handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}

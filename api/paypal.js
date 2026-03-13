// api/paypal.js — JustAbarth OS · PayPal subscription sync
const PAYPAL_BASE = 'https://api-m.paypal.com';

const PLAN_TIER_MAP = {
  'P-5LS643056L917673CNBXI3PA': 'Premium+',
  'P-5ET38701JS2889136M7WSGGY': 'Premium',
  'P-79Y21508MP396202VMTEPYHI': 'Basic',
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
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
  if (!data.access_token) throw new Error('PayPal auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

// ── Get subscription detail by ID ────────────────────────────────────────────

async function getSubscriptionDetail(token, subscriptionId) {
  const res = await fetch(`${PAYPAL_BASE}/v1/billing/subscriptions/${subscriptionId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
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

async function upsertMember(detail, tier) {
  const email = detail.subscriber?.email_address || '';
  const name = detail.subscriber?.name?.given_name
    ? `${detail.subscriber.name.given_name} ${detail.subscriber.name.surname || ''}`.trim()
    : email;
  const joinDateISO = detail.start_time
    ? detail.start_time.split('T')[0]
    : new Date().toISOString().split('T')[0];
  const joinDate = new Date(joinDateISO + 'T12:00:00').toLocaleDateString('en-GB');
  const subId = detail.id;

  const existing = await supabaseFetch(`/members?paypal_subscription_id=eq.${subId}&select=id`);

  if (existing && existing.length > 0) {
    await supabaseFetch(`/members?paypal_subscription_id=eq.${subId}`, 'PATCH', {
      tier, paypal_status: detail.status
    });
    return 'updated';
  } else {
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
      paypal_subscription_id: subId,
      paypal_status: detail.status || 'ACTIVE',
    });
    return 'added';
  }
}

// ── Sync by fetching each plan's subscriptions ───────────────────────────────
// PayPal list-subscriptions requires the subscription IDs to be known.
// We use the Subscriptions API with each plan ID and page through results.

async function syncAllSubscriptions() {
  const token = await getPayPalToken();
  const results = { added: 0, updated: 0, errors: [] };

  for (const [planId, tier] of Object.entries(PLAN_TIER_MAP)) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `${PAYPAL_BASE}/v1/billing/subscriptions?plan_id=${planId}&status=ACTIVE&page_size=20&page=${page}`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      console.log(`Plan ${planId} page ${page}:`, JSON.stringify(data));

      const subs = data.subscriptions || [];
      hasMore = subs.length === 20;
      page++;

      for (const sub of subs) {
        try {
          const detail = await getSubscriptionDetail(token, sub.id);
          const action = await upsertMember(detail, tier);
          if (action === 'added') results.added++;
          else results.updated++;
        } catch (err) {
          results.errors.push({ sub: sub.id, error: err.message });
        }
      }
    }
  }

  return results;
}

// ── Webhook handler ───────────────────────────────────────────────────────────

async function handleWebhook(body) {
  const token = await getPayPalToken();
  const eventType = body.event_type;
  const resource = body.resource;
  if (!resource) return { ignored: true };

  const subId = resource.id;
  const planId = resource.plan_id;
  const tier = PLAN_TIER_MAP[planId];

  if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED' || eventType === 'BILLING.SUBSCRIPTION.CREATED') {
    const detail = await getSubscriptionDetail(token, subId);
    await upsertMember(detail, tier || 'Basic');
    return { action: 'member_added', tier };
  }

  if (eventType === 'BILLING.SUBSCRIPTION.CANCELLED' || eventType === 'BILLING.SUBSCRIPTION.SUSPENDED') {
    await supabaseFetch(`/members?paypal_subscription_id=eq.${subId}`, 'PATCH', { paypal_status: 'CANCELLED' });
    return { action: 'member_cancelled', subId };
  }

  if (eventType === 'BILLING.SUBSCRIPTION.UPDATED') {
    if (tier) {
      await supabaseFetch(`/members?paypal_subscription_id=eq.${subId}`, 'PATCH', { tier, paypal_status: 'ACTIVE' });
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
    if (req.method === 'GET' && req.query.action === 'sync') {
      const results = await syncAllSubscriptions();
      return res.status(200).json({ success: true, ...results });
    }

    if (req.method === 'POST') {
      const result = await handleWebhook(req.body);
      return res.status(200).json({ success: true, ...result });
    }

    return res.status(400).json({ error: 'Unknown request' });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}

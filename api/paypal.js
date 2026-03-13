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

async function fetchAllPages(token) {
  // Fetch all pages, filter ACTIVE client-side
  const all = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const res = await fetch(
      `${PAYPAL_BASE}/v1/billing/subscriptions?page_size=20&page=${page}`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    const data = await res.json();
    const subs = data.subscriptions || [];
    all.push(...subs);
    // Check if there's a next page link
    const hasNext = (data.links || []).some(l => l.rel === 'next');
    hasMore = hasNext && subs.length > 0;
    page++;
    if (page > 50) break; // safety limit
  }

  // Deduplicate and filter ACTIVE only
  const unique = [...new Map(all.map(s => [s.id, s])).values()];
  return unique.filter(s => s.status === 'ACTIVE');
}

async function getSubscriptionDetail(token, subscriptionId) {
  const res = await fetch(`${PAYPAL_BASE}/v1/billing/subscriptions/${subscriptionId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return res.json();
}

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
  if (detail.status !== 'ACTIVE') return 'skipped';

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
      tier, paypal_status: 'ACTIVE'
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
      paypal_status: 'ACTIVE',
    });
    return 'added';
  }
}

async function syncAllSubscriptions() {
  const token = await getPayPalToken();
  const results = { added: 0, updated: 0, skipped: 0, errors: [], total_active: 0 };

  const activeSubs = await fetchAllPages(token);
  results.total_active = activeSubs.length;

  // Process in batches of 10 in parallel
  const BATCH = 10;
  for (let i = 0; i < activeSubs.length; i += BATCH) {
    const batch = activeSubs.slice(i, i + BATCH);
    await Promise.all(batch.map(async sub => {
      try {
        const detail = await getSubscriptionDetail(token, sub.id);
        const tier = PLAN_TIER_MAP[detail.plan_id];
        if (!tier) { results.skipped++; return; }
        const action = await upsertMember(detail, tier);
        if (action === 'added') results.added++;
        else if (action === 'updated') results.updated++;
        else results.skipped++;
      } catch (err) {
        results.errors.push({ sub: sub.id, error: err.message });
      }
    }));
  }

  return results;
}

async function handleWebhook(body) {
  const token = await getPayPalToken();
  const eventType = body.event_type;
  const resource = body.resource;
  if (!resource) return { ignored: true };

  const subId = resource.id;

  if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED' || eventType === 'BILLING.SUBSCRIPTION.CREATED') {
    const detail = await getSubscriptionDetail(token, subId);
    const tier = PLAN_TIER_MAP[detail.plan_id] || 'Basic';
    await upsertMember(detail, tier);
    return { action: 'member_added', tier };
  }

  if (eventType === 'BILLING.SUBSCRIPTION.CANCELLED' || eventType === 'BILLING.SUBSCRIPTION.SUSPENDED') {
    await supabaseFetch(`/members?paypal_subscription_id=eq.${subId}`, 'PATCH', { paypal_status: 'CANCELLED' });
    return { action: 'member_cancelled', subId };
  }

  if (eventType === 'BILLING.SUBSCRIPTION.UPDATED') {
    const detail = await getSubscriptionDetail(token, subId);
    const tier = PLAN_TIER_MAP[detail.plan_id];
    if (tier) {
      await supabaseFetch(`/members?paypal_subscription_id=eq.${subId}`, 'PATCH', { tier, paypal_status: 'ACTIVE' });
      return { action: 'tier_updated', tier };
    }
  }

  return { ignored: true, eventType };
}

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

    if (req.method === 'GET' && req.query.action === 'debug') {
      const token = await getPayPalToken();
      const active = await fetchAllPages(token);
      const sample = await Promise.all(active.slice(0, 3).map(s => getSubscriptionDetail(token, s.id)));
      return res.status(200).json({
        total_active: active.length,
        sample: sample.map(d => ({ id: d.id, plan_id: d.plan_id, tier: PLAN_TIER_MAP[d.plan_id] || 'UNKNOWN', email: d.subscriber?.email_address }))
      });
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

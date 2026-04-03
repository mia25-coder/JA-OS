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
  if (!data.access_token) {
    throw new Error(`PayPal auth failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

// ── PayPal API helpers ───────────────────────────────────────────────────────

// PayPal does NOT have a "list subscriptions by plan" endpoint.
// The correct approach is to list transactions/subscriptions via the
// Subscriptions API by fetching each subscription by ID — but since
// we don't store IDs, we use the Transactions Search API to find all
// billing agreement transactions, then fetch each subscription detail.

async function searchSubscriptionsByPlan(token, planId) {
  // Use the billing subscriptions list endpoint with plan_id filter
  // This IS supported but requires specific API permissions & pagination
  const subs = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const url = new URL(`${PAYPAL_BASE}/v1/billing/subscriptions`);
    url.searchParams.set('plan_id', planId);
    url.searchParams.set('status', 'ACTIVE');
    url.searchParams.set('page_size', '20');
    url.searchParams.set('page', String(page));

    const res = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { break; }

    if (data.subscriptions && data.subscriptions.length > 0) {
      subs.push(...data.subscriptions);
      // Check if there are more pages
      const totalPages = data.total_pages || 1;
      hasMore = page < totalPages;
      page++;
    } else {
      hasMore = false;
    }
  }

  return subs;
}

async function getSubscriptionDetail(token, subscriptionId) {
  const res = await fetch(
    `${PAYPAL_BASE}/v1/billing/subscriptions/${subscriptionId}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const text = await res.text();
  try { return JSON.parse(text); } catch { return {}; }
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
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

// ── Sync all active subscriptions ────────────────────────────────────────────

async function syncAllSubscriptions() {
  const token = await getPayPalToken();
  const results = { added: 0, updated: 0, skipped: 0, cancelled: 0, errors: [], debug: [] };

  for (const [planId, tier] of Object.entries(PLAN_TIER_MAP)) {
    results.debug.push(`Fetching plan ${planId} (${tier})...`);
    const subs = await searchSubscriptionsByPlan(token, planId);
    results.debug.push(`Found ${subs.length} subscriptions for ${tier} (will verify status of each)`);

    for (const sub of subs) {
      try {
        // Always fetch full detail to get the REAL current status
        const detail = await getSubscriptionDetail(token, sub.id);
        const actualStatus = detail.status; // ACTIVE, CANCELLED, SUSPENDED, EXPIRED etc.

        const existing = await supabaseFetch(
          `/members?paypal_subscription_id=eq.${sub.id}&select=id,paypal_status`
        );

        // If not ACTIVE — mark as cancelled in DB or skip entirely
        if (actualStatus !== 'ACTIVE') {
          if (existing && existing.length > 0) {
            await supabaseFetch(
              `/members?paypal_subscription_id=eq.${sub.id}`,
              'PATCH',
              { paypal_status: actualStatus }
            );
            results.cancelled++;
          } else {
            // Never add cancelled/expired subscribers
            results.skipped++;
          }
          continue;
        }

        // Status is ACTIVE — proceed to add or update
        const email = detail.subscriber?.email_address || '';
        const name = detail.subscriber?.name?.given_name
          ? `${detail.subscriber.name.given_name} ${detail.subscriber.name.surname || ''}`.trim()
          : email;
        const joinDateISO = detail.start_time
          ? detail.start_time.split('T')[0]
          : new Date().toISOString().split('T')[0];
        const joinDate = new Date(joinDateISO + 'T12:00:00')
          .toLocaleDateString('en-GB');

        if (existing && existing.length > 0) {
          await supabaseFetch(
            `/members?paypal_subscription_id=eq.${sub.id}`,
            'PATCH',
            { tier, paypal_status: 'ACTIVE' }
          );
          results.updated++;
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
    if (req.method === 'GET') {
      const action = req.query.action;

      if (action === 'sync') {
        const results = await syncAllSubscriptions();
        return res.status(200).json({ success: true, ...results });
      }

      // Debug endpoint — visit /api/paypal?action=debug in browser to test
      if (action === 'debug') {
        const token = await getPayPalToken();
        const debugInfo = { tokenOk: !!token, plans: {} };
        for (const [planId, tier] of Object.entries(PLAN_TIER_MAP)) {
          const subs = await searchSubscriptionsByPlan(token, planId);
          debugInfo.plans[tier] = { planId, count: subs.length, ids: subs.map(s => s.id) };
        }
        return res.status(200).json(debugInfo);
      }

      if (action === 'sync-countries') {
        // Placeholder — country sync is handled client-side
        return res.status(200).json({ success: true, updated: 0 });
      }

      return res.status(400).json({ error: 'Unknown action. Use ?action=sync or ?action=debug' });
    }

    if (req.method === 'POST') {
      const result = await handleWebhook(req.body);
      return res.status(200).json({ success: true, ...result });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('PayPal handler error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

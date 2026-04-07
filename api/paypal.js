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
  if (!data.access_token) throw new Error(`PayPal auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

// Fetch ALL subscription IDs by paginating through every page
async function getAllSubscriptionIds(token, planId) {
  const ids = [];
  let page = 1;

  while (true) {
    const res = await fetch(
      `${PAYPAL_BASE}/v1/billing/subscriptions?plan_id=${planId}&page_size=20&page=${page}`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { break; }

    const subs = data.subscriptions || [];
    subs.forEach(s => ids.push(s.id));

    // Stop if we got fewer than 20 — means we're on the last page
    if (subs.length < 20) break;
    page++;

    // Safety cap at 20 pages (400 members)
    if (page > 20) break;
  }

  return ids;
}

async function getSubscriptionDetail(token, subscriptionId) {
  const res = await fetch(`${PAYPAL_BASE}/v1/billing/subscriptions/${subscriptionId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return {}; }
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
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

async function syncAllSubscriptions() {
  const token = await getPayPalToken();
  const results = { added: 0, updated: 0, skipped: 0, cancelled: 0, errors: [], debug: [] };

  for (const [planId, tier] of Object.entries(PLAN_TIER_MAP)) {
    const ids = await getAllSubscriptionIds(token, planId);
    results.debug.push(`${tier}: found ${ids.length} subscriptions`);

    for (const subId of ids) {
      try {
        const detail = await getSubscriptionDetail(token, subId);
        const actualStatus = detail.status;

        const existing = await supabaseFetch(
          `/members?paypal_subscription_id=eq.${subId}&select=id`
        );

        if (actualStatus !== 'ACTIVE') {
          if (existing && existing.length > 0) {
            await supabaseFetch(`/members?id=eq.${existing[0].id}`, 'DELETE');
            results.cancelled++;
          } else {
            results.skipped++;
          }
          continue;
        }

        const email = detail.subscriber?.email_address || '';
        const name = detail.subscriber?.name?.given_name
          ? `${detail.subscriber.name.given_name} ${detail.subscriber.name.surname || ''}`.trim()
          : email;
        const joinDateISO = detail.start_time
          ? detail.start_time.split('T')[0]
          : new Date().toISOString().split('T')[0];
        const joinDate = new Date(joinDateISO + 'T12:00:00').toLocaleDateString('en-GB');

        if (existing && existing.length > 0) {
          await supabaseFetch(
            `/members?paypal_subscription_id=eq.${subId}`,
            'PATCH',
            { tier, paypal_status: 'ACTIVE' }
          );
          results.updated++;
        } else {
          await supabaseFetch('/members', 'POST', {
            handle: name, tier, car: '—', country: '—',
            points: 0, featured: false, last_feature: null,
            join_date: joinDate, join_date_iso: joinDateISO,
            paypal_email: email, paypal_subscription_id: subId,
            paypal_status: 'ACTIVE',
          });
          results.added++;
        }
      } catch (err) {
        results.errors.push({ sub: subId, error: err.message });
      }
    }
  }

  return results;
}

async function cleanupCancelledMembers() {
  const token = await getPayPalToken();
  const allMembers = await supabaseFetch(
    `/members?paypal_subscription_id=not.is.null&select=id,handle,paypal_subscription_id`
  );

  if (!allMembers || !allMembers.length) {
    return { deleted: 0, kept: 0, removed: [] };
  }

  let deleted = 0, kept = 0;
  const removedHandles = [];

  for (const member of allMembers) {
    try {
      const detail = await getSubscriptionDetail(token, member.paypal_subscription_id);
      if (detail.status !== 'ACTIVE') {
        await supabaseFetch(`/members?id=eq.${member.id}`, 'DELETE');
        removedHandles.push(`${member.handle} (${detail.status || 'unknown'})`);
        deleted++;
      } else {
        kept++;
      }
    } catch { kept++; }
  }

  return { deleted, kept, removed: removedHandles };
}

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
      handle: name, tier: tier || 'Basic', car: '—', country: '—',
      points: 0, featured: false, last_feature: null,
      join_date: joinDate, join_date_iso: joinDateISO,
      paypal_email: email, paypal_subscription_id: subId, paypal_status: 'ACTIVE',
    });
    return { action: 'member_added', handle: name, tier };
  }

  if (eventType === 'BILLING.SUBSCRIPTION.CANCELLED' || eventType === 'BILLING.SUBSCRIPTION.SUSPENDED') {
    await supabaseFetch(`/members?paypal_subscription_id=eq.${subId}`, 'DELETE');
    return { action: 'member_deleted', subId };
  }

  if (eventType === 'BILLING.SUBSCRIPTION.UPDATED' && tier) {
    await supabaseFetch(`/members?paypal_subscription_id=eq.${subId}`, 'PATCH', { tier, paypal_status: 'ACTIVE' });
    return { action: 'tier_updated', tier };
  }

  return { ignored: true, eventType };
}

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

      if (action === 'cleanup') {
        const results = await cleanupCancelledMembers();
        return res.status(200).json({ success: true, ...results });
      }

      if (action === 'debug') {
        const token = await getPayPalToken();
        const debugInfo = { tokenOk: !!token, plans: {} };
        for (const [planId, tier] of Object.entries(PLAN_TIER_MAP)) {
          const ids = await getAllSubscriptionIds(token, planId);
          debugInfo.plans[tier] = { planId, totalFound: ids.length, ids };
        }
        return res.status(200).json(debugInfo);
      }

      if (action === 'sync-countries') {
        return res.status(200).json({ success: true, updated: 0 });
      }

      return res.status(400).json({ error: 'Unknown action' });
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

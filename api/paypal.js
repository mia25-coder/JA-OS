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


// ISO 3166-1 alpha-2 → country name
function isoToCountry(code) {
  const map = {
    'AF':'Afghanistan','AL':'Albania','DZ':'Algeria','AR':'Argentina','AU':'Australia',
    'AT':'Austria','BE':'Belgium','BR':'Brazil','BG':'Bulgaria','CA':'Canada',
    'CL':'Chile','CN':'China','CO':'Colombia','HR':'Croatia','CZ':'Czech Republic',
    'DK':'Denmark','EG':'Egypt','FI':'Finland','FR':'France','DE':'Germany',
    'GR':'Greece','HU':'Hungary','IN':'India','ID':'Indonesia','IE':'Ireland',
    'IL':'Israel','IT':'Italy','JP':'Japan','JO':'Jordan','KE':'Kenya',
    'KW':'Kuwait','LB':'Lebanon','LT':'Lithuania','LU':'Luxembourg','MY':'Malaysia',
    'MX':'Mexico','MA':'Morocco','NL':'Netherlands','NZ':'New Zealand','NG':'Nigeria',
    'NO':'Norway','OM':'Oman','PK':'Pakistan','PE':'Peru','PH':'Philippines',
    'PL':'Poland','PT':'Portugal','QA':'Qatar','RO':'Romania','RU':'Russia',
    'SA':'Saudi Arabia','RS':'Serbia','SG':'Singapore','SK':'Slovakia','ZA':'South Africa',
    'ES':'Spain','SE':'Sweden','CH':'Switzerland','TW':'Taiwan','TH':'Thailand',
    'TN':'Tunisia','TR':'Turkey','UA':'Ukraine','AE':'UAE','GB':'United Kingdom',
    'US':'United States','UY':'Uruguay','VE':'Venezuela','VN':'Vietnam'
  };
  return map[code?.toUpperCase()] || code || '—';
}

async function upsertMember(detail, tier) {
  if (detail.status !== 'ACTIVE') return 'skipped';

  const email = detail.subscriber?.email_address || '';
  const name = detail.subscriber?.name?.given_name
    ? `${detail.subscriber.name.given_name} ${detail.subscriber.name.surname || ''}`.trim()
    : email;
  // Extract country from PayPal address (ISO 2-letter code)
  const countryCode =
    detail.subscriber?.shipping_address?.country_code ||
    detail.subscriber?.address?.country_code ||
    null;
  const country = countryCode ? isoToCountry(countryCode) : '—';
  const joinDateISO = detail.start_time
    ? detail.start_time.split('T')[0]
    : new Date().toISOString().split('T')[0];
  const joinDate = new Date(joinDateISO + 'T12:00:00').toLocaleDateString('en-GB');
  const subId = detail.id;

  const existing = await supabaseFetch(`/members?paypal_subscription_id=eq.${subId}&select=id`);

  if (existing && existing.length > 0) {
    // Update tier, status, and country if we have it
    const patch = { tier, paypal_status: 'ACTIVE' };
    if (country && country !== '—') patch.country = country;
    await supabaseFetch(`/members?paypal_subscription_id=eq.${subId}`, 'PATCH', patch);
    return 'updated';
  } else {
    await supabaseFetch('/members', 'POST', {
      handle: name,
      tier,
      car: '—',
      country,
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
      const details = [];
      for (const sub of active.slice(0, 5)) {
        try {
          const d = await getSubscriptionDetail(token, sub.id);
          details.push({
            list_id: sub.id,
            list_status: sub.status,
            detail_id: d.id,
            plan_id: d.plan_id,
            email: d.subscriber?.email_address,
            country: d.subscriber?.shipping_address?.country_code || d.subscriber?.address?.country_code || null,
            raw_subscriber_keys: d.subscriber ? Object.keys(d.subscriber) : [],
          });
        } catch(e) {
          details.push({ list_id: sub.id, error: e.message });
        }
      }
      const tierCount = {};
      details.forEach(d => { const t = PLAN_TIER_MAP[d.plan_id]; if(t) tierCount[t] = (tierCount[t]||0)+1; });
      return res.status(200).json({
        total_found: active.length,
        first_5_details: details,
        tier_counts: tierCount,
        plan_ids_in_map: Object.keys(PLAN_TIER_MAP),
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

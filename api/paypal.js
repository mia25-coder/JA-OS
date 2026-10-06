// JustAbarth PayPal integration. Server only: never put secrets in index.html.
import { timingSafeEqual, createHash } from 'node:crypto';

const LEGACY_PLAN_TIERS = {
  'P-5LS643056L917673CNBXI3PA': 'Premium+',
  'P-5ET38701JS2889136M7WSGGY': 'Premium',
  'P-79Y21508MP396202VMTEPYHI': 'Basic',
  'P-0R809568M14149021NLACRVI': 'Basic',
};
const PLAN_PRICES = {'P-5LS643056L917673CNBXI3PA':19.99,'P-5ET38701JS2889136M7WSGGY':9.99,'P-79Y21508MP396202VMTEPYHI':3.50,'P-0R809568M14149021NLACRVI':5.99};
const STATUSES = new Set(['APPROVAL_PENDING', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'CANCELLED', 'EXPIRED']);
const EVENTS = new Set(['BILLING.SUBSCRIPTION.CREATED', 'BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.UPDATED', 'BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.EXPIRED', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED']);
const PAGE_SIZE = 5;
class IntegrationError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}
function settings() {
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_SECRET'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length) throw new IntegrationError('Missing Vercel environment variables: ' + missing.join(', '), 503);
  const environment = process.env.PAYPAL_ENVIRONMENT || 'live';
  if (!['live', 'sandbox'].includes(environment)) throw new IntegrationError('PAYPAL_ENVIRONMENT must be live or sandbox.', 503);
  const plans = { ...LEGACY_PLAN_TIERS }, prices = {...PLAN_PRICES};
  // Keep old IDs mapped so existing members retain their correct tier.
  if (process.env.PAYPAL_BASIC_PLAN_ID) {plans[process.env.PAYPAL_BASIC_PLAN_ID.trim()] = 'Basic';prices[process.env.PAYPAL_BASIC_PLAN_ID.trim()]=5.99;}
  if (process.env.PAYPAL_PLAN_TIER_MAP) {
    let extra;
    try { extra = JSON.parse(process.env.PAYPAL_PLAN_TIER_MAP); } catch { throw new IntegrationError('PAYPAL_PLAN_TIER_MAP is not valid JSON.', 503); }
    if (!extra || Array.isArray(extra) || typeof extra !== 'object') throw new IntegrationError('PAYPAL_PLAN_TIER_MAP must be a JSON object.', 503);
    for (const [id, tier] of Object.entries(extra)) {
      if (!/^P-[A-Z0-9]+$/.test(id) || !['Basic', 'Premium', 'Premium+'].includes(tier)) throw new IntegrationError('Invalid plan ID or tier in PAYPAL_PLAN_TIER_MAP.', 503);
      plans[id] = tier;
    }
  }
  if (process.env.PAYPAL_PLAN_PRICE_MAP) {let extra;try{extra=JSON.parse(process.env.PAYPAL_PLAN_PRICE_MAP);}catch{throw new IntegrationError('PAYPAL_PLAN_PRICE_MAP is not valid JSON.',503);}if(!extra||Array.isArray(extra)||typeof extra!=='object')throw new IntegrationError('PAYPAL_PLAN_PRICE_MAP must be an object.',503);for(const [id,price] of Object.entries(extra)){if(!plans[id]||typeof price!=='number'||!Number.isFinite(price)||price<0)throw new IntegrationError('Invalid price mapping.',503);prices[id]=price;}}
  if(Object.keys(plans).some(id=>prices[id]===undefined))throw new IntegrationError('Every plan needs a monthly EUR price in PAYPAL_PLAN_PRICE_MAP.',503);
  if (Object.keys(plans).some(id => !/^P-[A-Z0-9]+$/.test(id))) throw new IntegrationError('PayPal plan IDs must start with P-.', 503);
  return { base: environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com', database: process.env.SUPABASE_URL.replace(/\/$/, ''), key: process.env.SUPABASE_SERVICE_KEY, plans, prices };
}
async function requireAdmin(req) {
  const authorization = req.headers?.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    const base = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!base || !key) throw new IntegrationError('Supabase server configuration is missing.', 503);
    const access = authorization.slice(7);
    // Validate with Auth; never trust client-provided JWT claims or user IDs.
    const response = await fetch(base + '/auth/v1/user', { headers: {apikey:key,Authorization:'Bearer '+access}, signal:AbortSignal.timeout(8000) });
    if (!response.ok) throw new IntegrationError('Your session expired. Sign in again.',401);
    const user = await response.json();
    if (!user?.id || !/^[0-9a-f-]{36}$/i.test(user.id)) throw new IntegrationError('Invalid sign-in session.',401);
    const admin = await jsonRequest(base + '/rest/v1/ops_admins?user_id=eq.' + encodeURIComponent(user.id) + '&select=user_id', {headers:{apikey:key,Authorization:'Bearer '+key}}, 'Access check');
    if (!Array.isArray(admin) || admin.length !== 1) throw new IntegrationError('This account cannot sync the Club.',403);
    return;
  }
  const expected = process.env.SYNC_ADMIN_TOKEN;
  if (!expected || expected.length < 24) throw new IntegrationError('Set SYNC_ADMIN_TOKEN to a random value of at least 24 characters in Vercel.', 503);
  const supplied = req.headers?.['x-club-sync-key'];
  if (typeof supplied !== 'string') throw new IntegrationError('Enter the dashboard sync key to continue.', 401);
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new IntegrationError('The dashboard sync key was not accepted.', 401);
}
async function jsonRequest(url, options, service) {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) }); }
  catch (error) { throw new IntegrationError(service + (error.name === 'TimeoutError' || error.name === 'AbortError' ? ' request timed out.' : ' could not be reached.')); }
  const text = await response.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { throw new IntegrationError(service + ' returned a non-JSON response (HTTP ' + response.status + ').'); } }
  if (!response.ok) {
    // Return diagnostic codes, not response dumps containing subscriber information.
    const code = data?.name || data?.error || data?.code;
    const debug = data?.debug_id ? ' · reference ' + data.debug_id : '';
    const suffix = response.status === 401 ? ' Check credentials and the live/sandbox environment.' : response.status === 403 ? ' Check the PayPal app permissions or database permissions.' : '';
    throw new IntegrationError(service + ' failed (HTTP ' + response.status + ')' + (typeof code === 'string' ? ': ' + code : '') + debug + suffix);
  }
  return data;
}
async function token(config) {
  const credentials = Buffer.from(process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_SECRET).toString('base64');
  const data = await jsonRequest(config.base + '/v1/oauth2/token', { method: 'POST', headers: { Authorization: 'Basic ' + credentials, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' }, 'PayPal authentication');
  if (typeof data?.access_token !== 'string') throw new IntegrationError('PayPal did not return an access token.');
  return data.access_token;
}
const paypal = (config, access, path, method = 'GET', body) => jsonRequest(config.base + path, { method, headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, 'PayPal');
const database = (config, path, method = 'GET', body, prefer = 'return=representation') => jsonRequest(config.database + '/rest/v1' + path, { method, headers: { apikey: config.key, Authorization: 'Bearer ' + config.key, 'Content-Type': 'application/json', Prefer: prefer }, ...(body ? { body: JSON.stringify(body) } : {}) }, 'Supabase');
function validateId(id) { if (typeof id !== 'string' || !/^I-[A-Z0-9]+$/.test(id)) throw new IntegrationError('PayPal returned an invalid subscription ID.'); return id; }
function countryName(detail) {
  const code = detail.subscriber?.shipping_address?.address?.country_code;
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) return null;
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code); } catch { return code; }
}
function validateDetail(detail, id) {
  if (!detail || detail.id !== id || !STATUSES.has(detail.status) || typeof detail.plan_id !== 'string') throw new IntegrationError('PayPal returned incomplete details for a subscription; no member was changed.');
}
async function applySubscription(config, detail, countriesOnly = false) {
  const id = validateId(detail.id);
  validateDetail(detail, id);
  const tier = config.plans[detail.plan_id];
  if (!tier) return { action: 'skipped', unknownPlan: detail.plan_id };
  const existing = await database(config, '/members?paypal_subscription_id=eq.' + encodeURIComponent(id) + '&select=id,handle,car,country');
  if (!Array.isArray(existing)) throw new IntegrationError('Supabase returned an invalid member lookup.');
  if (existing.length > 1) throw new IntegrationError('Duplicate subscription IDs exist in members. Resolve the duplicates before syncing.');
  const country = countryName(detail);
  if (countriesOnly) {
    if (!existing.length || !country || existing[0].country && !['—', '-'].includes(existing[0].country)) return { action: 'skipped' };
    const changed = await database(config, '/members?id=eq.' + encodeURIComponent(existing[0].id), 'PATCH', { country });
    if (!Array.isArray(changed) || !changed.length) throw new IntegrationError('Country update was not saved.');
    return { action: 'updated' };
  }
  // Never delete a member on sync. Keep their profile, history and actual status.
  if (existing.length) {
    const patch = { tier, paypal_status: detail.status, paypal_plan_id:detail.plan_id, monthly_price:config.prices[detail.plan_id] };
    if (detail.subscriber?.email_address) patch.paypal_email = detail.subscriber.email_address;
    if (country && (!existing[0].country || ['—', '-'].includes(existing[0].country))) patch.country = country;
    const changed = await database(config, '/members?id=eq.' + encodeURIComponent(existing[0].id), 'PATCH', patch);
    if (!Array.isArray(changed) || !changed.length) throw new IntegrationError('Member update was not saved.');
    return { action: 'updated', inactive: detail.status !== 'ACTIVE' };
  }
  if (detail.status !== 'ACTIVE') return { action: 'skipped' };
  const date = detail.start_time || detail.create_time;
  const joinDateISO = typeof date === 'string' && Number.isFinite(Date.parse(date)) ? date.slice(0, 10) : null;
  const name = [detail.subscriber?.name?.given_name, detail.subscriber?.name?.surname].filter(Boolean).join(' ');
  const row = { paypal_plan_id:detail.plan_id, monthly_price:config.prices[detail.plan_id], handle: name || detail.subscriber?.email_address || '', tier, car: '—', country: country || '—', points: 0, featured: false, last_feature: null, join_date: joinDateISO ? new Date(joinDateISO + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC' }) : null, join_date_iso: joinDateISO, paypal_email: detail.subscriber?.email_address || '', paypal_subscription_id: id, paypal_status: detail.status };
  // Unique subscription index + ignore duplicates prevents concurrent deliveries from
  // overwriting a member's handle, car, points and history.
  const inserted = await database(config, '/members?on_conflict=paypal_subscription_id', 'POST', row, 'resolution=ignore-duplicates,return=representation');
  if (!Array.isArray(inserted)) throw new IntegrationError('Supabase did not confirm member insertion.');
  return { action: inserted.length ? 'added' : 'skipped' };
}
async function syncPage(config, access, page, countriesOnly) {
  const listed = await paypal(config, access, '/v1/billing/subscriptions?page_size=' + PAGE_SIZE + '&page=' + page);
  if (!Array.isArray(listed?.subscriptions)) throw new IntegrationError('PayPal did not return a subscription list. Check app access to the Subscriptions API.');
  const results = { added: 0, updated: 0, skipped: 0, inactive: 0, processed: 0, errors: [], unknownPlans: [] };
  // Five per request keeps each function invocation bounded. The dashboard requests
  // subsequent pages rather than attempting a multi-year scan in one invocation.
  await Promise.all(listed.subscriptions.map(async item => {
    try {
      const id = validateId(item.id);
      const detail = await paypal(config, access, '/v1/billing/subscriptions/' + id);
      validateDetail(detail, id);
      const result = await applySubscription(config, detail, countriesOnly);
      results[result.action]++;if (result.inactive) results.inactive++;
      if (result.unknownPlan) results.unknownPlans.push(result.unknownPlan);
    } catch (error) { results.errors.push({ subscription: item.id, error: error.message }); }
    finally { results.processed++; }
  }));
  results.unknownPlans = [...new Set(results.unknownPlans)];
  const more = Array.isArray(listed.links) && listed.links.some(link => link.rel === 'next');
  return { ...results, page, pageFingerprint: createHash('sha256').update(listed.subscriptions.map(x=>x.id).sort().join(',')).digest('hex'), nextPage: more ? page + 1 : null, complete: !more, partial: results.errors.length > 0 };
}
// Recheck stored subscription IDs independently of discovery. Cancelled subscriptions
// missing from PayPal's list still receive their current status; 404s are errors,
// never inferred cancellations or deletions.
async function syncExisting(config, access, page, countriesOnly) {
  const rows = await database(config, '/members?select=paypal_subscription_id&paypal_subscription_id=not.is.null&order=id&limit='+PAGE_SIZE+'&offset='+((page-1)*PAGE_SIZE));
  if (!Array.isArray(rows)) throw new IntegrationError('Invalid stored subscription list.');
  const result={added:0,updated:0,inactive:0,skipped:0,processed:0,errors:[],unknownPlans:[]};
  await Promise.all(rows.map(async row=>{try{const id=validateId(row.paypal_subscription_id),detail=await paypal(config,access,'/v1/billing/subscriptions/'+id);validateDetail(detail,id);const r=await applySubscription(config,detail,countriesOnly);result[r.action]++;if(r.inactive)result.inactive++;if(r.unknownPlan)result.unknownPlans.push(r.unknownPlan);}catch(e){result.errors.push({subscription:row.paypal_subscription_id,error:e.message});}finally{result.processed++;}}));
  return {...result,page,nextPage:rows.length===PAGE_SIZE?page+1:null,complete:rows.length<PAGE_SIZE,partial:result.errors.length>0};
}
async function webhook(req, config, access) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new IntegrationError('PAYPAL_WEBHOOK_ID is not configured in Vercel.', 503);
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { throw new IntegrationError('Invalid webhook JSON.', 400); } }
  if (!body || typeof body !== 'object') throw new IntegrationError('Missing webhook body.', 400);
  const headers = req.headers || {};
  const required = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
  if (required.some(name => typeof headers[name] !== 'string')) throw new IntegrationError('Missing PayPal signature headers.', 401);
  const verification = await paypal(config, access, '/v1/notifications/verify-webhook-signature', 'POST', { auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'], transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'], webhook_id: webhookId, webhook_event: body });
  if (verification?.verification_status !== 'SUCCESS') throw new IntegrationError('PayPal webhook signature was not accepted.', 401);
  if (!EVENTS.has(body.event_type)) return { ignored: true, eventType: body.event_type };
  const id = validateId(body.resource?.id);
  // Fetch current state so a delayed CREATED/UPDATED event cannot reactivate a
  // cancelled member, and payment-failure events are not treated as cancellation.
  const detail = await paypal(config, access, '/v1/billing/subscriptions/' + id);
  validateDetail(detail, id);
  if (!config.plans[detail.plan_id]) throw new IntegrationError('Unmapped PayPal plan ' + detail.plan_id + '. Add its mapping before retrying this webhook.', 409);
  return applySubscription(config, detail);
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      await requireAdmin(req);
      const config = settings(), action = req.query?.action;
      if (action === 'cleanup') throw new IntegrationError('Automatic deletion is disabled. Sync now retains members and updates their PayPal status.', 410);
      if (!['sync', 'sync-countries', 'debug'].includes(action)) throw new IntegrationError('Unknown action.', 400);
      const page = Number(req.query?.page || 1);
      if (!Number.isSafeInteger(page) || page < 1 || page > 10000000) throw new IntegrationError('Invalid page.', 400);
      const access = await token(config);
      if (action === 'debug') return res.status(200).json({ success: true, tokenOk: true, environment: process.env.PAYPAL_ENVIRONMENT || 'live', configuredPlans: config.plans, webhookConfigured: !!process.env.PAYPAL_WEBHOOK_ID });
      const results = req.query?.phase === 'existing' ? await syncExisting(config, access, page, action === 'sync-countries') : await syncPage(config, access, page, action === 'sync-countries');
      return res.status(200).json({ success: true, ...results });
    }
    if (req.method === 'POST') {
      // Reject unsigned requests before making an authentication request.
      if (!req.headers?.['paypal-transmission-sig']) throw new IntegrationError('Missing PayPal webhook signature.', 401);
      const config = settings(), access = await token(config);
      const result = await webhook(req, config, access);
      return res.status(200).json({ success: true, ...result });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, error: error instanceof IntegrationError ? error.message : 'Unexpected sync error. Check the Vercel function logs.' });
  }
}

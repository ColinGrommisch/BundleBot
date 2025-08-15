// api/build-bundle.js
// Vercel Node serverless function (NOT Edge).
// - AI spec via OpenAI (strict JSON) with safe fallback
// - Product search via RapidAPI Google Shopping (primary)
// - Optional Apify fallback
// - 45-min in-memory cache for product queries
// - Budget-aware composer
// - Always returns SOMETHING (demo fallback) so UI doesn't break

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const RAPIDAPI_KEY   = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST  = process.env.RAPIDAPI_HOST; // e.g. "google-shopping-results.p.rapidapi.com"

const APIFY_TOKEN    = process.env.APIFY_TOKEN;    // optional
const APIFY_ACTOR_ID = process.env.APIFY_ACTOR_ID; // optional

/** ---------------- In-memory cache ---------------- */
const CACHE  = new Map();           // key -> { ts, data }
const TTL_MS = 45 * 60 * 1000;      // 45 minutes
function getCache(key){ const v = CACHE.get(key); return v && (Date.now()-v.ts<TTL_MS) ? v.data : null; }
function setCache(key,data){ CACHE.set(key,{ ts:Date.now(), data }); }

/** ---------------- Main handler ---------------- */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const raw  = req.body || '{}';
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const prompt   = String(body.prompt || '').trim();
    const budgetIn = Number(body.budget || NaN);
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // 1) AI → structured spec (safe)
    const spec = await safeGetSpecFromAI({ prompt, budget: isFinite(budgetIn) ? budgetIn : undefined });

    // 2) Build candidates from spec (search with cache wrap)
    const candidates = await getCandidatesFromSpec(spec);

    // 3) Compose bundle
    const bundle = composeBundle({ spec, candidates });

    return res.status(200).json(bundle);
  } catch (err) {
    console.error('API error:', err);
    // Final fallback so the UI still shows something
    const items = [
      { name:'Twin XL Bedding Set', price:79.99, link:'https://example.com/bedding', image:'https://via.placeholder.com/300', reason:'Fits dorm beds; reviewed well', source:'fallback' },
      { name:'LED Desk Lamp',       price:24.99, link:'https://example.com/lamp',    image:'https://via.placeholder.com/300', reason:'Dimmable + USB',               source:'fallback' },
      { name:'Over-the-Door Hooks', price:12.99, link:'https://example.com/hooks',   image:'https://via.placeholder.com/300', reason:'Instant storage',             source:'fallback' }
    ];
    const total = items.reduce((s,i)=>s+i.price,0);
    return res.status(200).json({
      title: 'Bundle (Fallback)',
      budget: 500,
      total: Number(total.toFixed(2)),
      items,
      note: 'Fallback mode due to server error'
    });
  }
}

/** ---------------- Step 1: AI prompt → strict JSON spec (safe) ---------------- */
async function safeGetSpecFromAI({ prompt, budget }) {
  try {
    if (!OPENAI_API_KEY) throw new Error('No OPENAI_API_KEY set');

    const system = `
You are BundleBot. Output STRICT JSON only:
{ "title": string, "budget": number, "must_have": string[], "nice_to_have": string[], "max_items": number }
If user gives a budget, use it; else choose a reasonable one.
Keep categories short: "bedding","lighting","storage","desk accessories","fan","laundry","bath","kitchen".
`.trim();

    const user = `
User request: "${prompt}"
User budget: ${isFinite(budget) ? budget : 'N/A'}
Return exactly:
{"title":"...","budget":500,"must_have":["..."],"nice_to_have":["..."],"max_items":10}
`.trim();

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user }
        ]
      })
    });

    if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text().catch(()=>resp.statusText)}`);
    const data = await resp.json();
    const raw  = data?.choices?.[0]?.message?.content || '{}';

    let spec = JSON.parse(raw);
    // normalize
    spec.title        = stringOr(spec.title, `Bundle for: ${prompt}`);
    spec.budget       = numberOr(spec.budget, isFinite(budget) ? budget : 500);
    spec.max_items    = clamp(numberOr(spec.max_items, 10), 3, 15);
    spec.must_have    = arrayOfStringsOr(spec.must_have,    ['bedding','lighting','storage']).slice(0, 10);
    spec.nice_to_have = arrayOfStringsOr(spec.nice_to_have, ['desk accessories','fan','laundry']).slice(0, 10);
    spec.budget       = clamp(spec.budget, 50, 5000);
    return spec;
  } catch (e) {
    console.warn('AI spec fallback:', e?.message || e);
    return {
      title:        `Bundle for: ${prompt}`,
      budget:       isFinite(budget) ? budget : 500,
      must_have:    ['bedding','lighting','storage'],
      nice_to_have: ['desk accessories','fan','laundry'],
      max_items:    10
    };
  }
}

/** ---------------- Step 2: Candidates from spec (cache-wrapped search) ---------------- */
async function getCandidatesFromSpec(spec) {
  const cats = [...(spec.must_have || []), ...(spec.nice_to_have || [])];
  const uniqueCats = [...new Set(cats)].slice(0, 8); // keep small for MVP

  const results = [];
  for (const cat of uniqueCats) {
    const cacheKey = `q:${cat.toLowerCase()}|l:3`;
    let items = getCache(cacheKey);
    if (!items) {
      items = await searchProducts({ query: cat, limit: 3 }).catch(() => []);
      if (items?.length) setCache(cacheKey, items);
    }
    results.push(...(items || []).map(i => ({ ...i, category: cat })));
  }
  return results;
}

/** ---------------- Search: RapidAPI primary + optional Apify fallback ---------------- */
const RAPIDAPI_ENABLED = () => !!(RAPIDAPI_KEY && RAPIDAPI_HOST);
const APIFY_ENABLED    = () => !!(APIFY_TOKEN && APIFY_ACTOR_ID);

async function searchProducts({ query, limit = 3 }) {
  // 1) RapidAPI (primary)
  if (RAPIDAPI_ENABLED()) {
    const rapid = await rapidApiGoogleShopping({ query, limit }).catch(() => null);
    if (rapid?.length) return rapid;
  }
  // 2) Apify fallback (optional)
  if (APIFY_ENABLED()) {
    const apify = await apifyRetailSearch({ query, limit }).catch(() => null);
    if (apify?.length) return apify;
  }
  // 3) Demo fallback
  return [
    { name: `${capitalize(query)} — Option A`, price: 24.99, link: 'https://example.com/a', image: 'https://via.placeholder.com/300', reason: 'Good reviews • Low price', source: 'demo' },
    { name: `${capitalize(query)} — Option B`, price: 32.50, link: 'https://example.com/b', image: 'https://via.placeholder.com/300', reason: 'Solid quality • Popular pick', source: 'demo' },
    { name: `${capitalize(query)} — Option C`, price: 18.75, link: 'https://example.com/c', image: 'https://via.placeholder.com/300', reason: 'Cheapest viable option', source: 'demo' }
  ].slice(0, limit).sort((a,b)=>a.price-b.price);
}

/** RapidAPI Google Shopping: normalize to {name, price, link, image, reason, source} */
async function rapidApiGoogleShopping({ query, limit }) {
  const url = new URL(`https://${RAPIDAPI_HOST}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('gl', 'US');
  url.searchParams.set('hl', 'en');
  url.searchParams.set('num', String(Math.max(3, limit))); // if supported

  const resp = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-RapidAPI-Key': RAPIDAPI_KEY,
      'X-RapidAPI-Host': RAPIDAPI_HOST
    }
  });
  if (!resp.ok) throw new Error(`RapidAPI ${resp.status}: ${await resp.text().catch(()=>resp.statusText)}`);

  const json = await resp.json();
  const rows = json?.results || json?.shopping_results || json?.data || [];
  const items = rows.map((r) => {
    const name   = r.title || r.name || r.product_title || 'Item';
    const price  = parsePrice(r.price || r.extracted_price || r.price_str || r.price_string || '');
    const link   = r.link || r.product_link || r.url || '#';
    const image  = r.thumbnail || r.image || r.image_link || 'https://via.placeholder.com/300';
    const rating = r.rating || r.stars || r.reviews || '';
    const store  = r.source || r.store || r.merchant || '';
    const reason = buildReason({ rating, merchant: store });
    return { name, price, link, image, reason, source: 'rapidapi' };
  })
  .filter(i => isFinite(i.price) && i.link && i.name)
  .sort((a, b) => a.price - b.price)
  .slice(0, limit);

  return items;
}

/** Apify actor (optional) */
async function apifyRetailSearch({ query, limit }) {
  const start = await fetch(`https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { query, maxItems: Math.max(3, limit) } })
  });
  if (!start.ok) throw new Error(`Apify start ${start.status}: ${await start.text().catch(()=>start.statusText)}`);
  const started = await start.json();
  const runId = started?.data?.id;
  if (!runId) throw new Error('Apify run id missing');

  const maxWaitMs = 15000, intervalMs = 1200, t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    await wait(intervalMs);
    const runResp = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`);
    if (!runResp.ok) break;
    const run = await runResp.json();
    const status = run?.data?.status;
    if (status === 'SUCCEEDED') {
      const dsId = run?.data?.defaultDatasetId;
      if (!dsId) break;
      const ds = await fetch(`https://api.apify.com/v2/datasets/${dsId}/items?limit=${Math.max(3, limit)}`);
      const arr = await ds.json();
      const items = (Array.isArray(arr) ? arr : []).map((r) => {
        const name   = r.title || r.name || 'Item';
        const price  = parsePrice(r.price || r.extracted_price || r.price_str || '');
        const link   = r.link || r.url || '#';
        const image  = r.image || r.thumbnail || 'https://via.placeholder.com/300';
        const rating = r.rating || r.stars || '';
        const store  = r.store || r.source || '';
        const reason = buildReason({ rating, merchant: store });
        return { name, price, link, image, reason, source: 'apify' };
      })
      .filter(i => isFinite(i.price) && i.link && i.name)
      .sort((a,b)=>a.price-b.price)
      .slice(0, limit);
      return items;
    }
    if (['FAILED','ABORTED','TIMED_OUT'].includes(status)) break;
  }
  throw new Error('Apify run did not complete in time');
}

/** ---------------- Composer (budget-aware) ---------------- */
function composeBundle({ spec, candidates }) {
  const budget   = spec.budget ?? 500;
  const maxItems = spec.max_items ?? 10;

  const selected = [];
  let total = 0;

  const pick = (item) => {
    if (selected.length >= maxItems) return false;
    if (!isFinite(item.price)) return false;
    if (total + item.price > budget) return false;
    selected.push(item);
    total += item.price;
    return true;
  };

  // 1) Ensure each must-have category is represented (cheapest per cat)
  for (const cat of (spec.must_have || [])) {
    const options = candidates.filter(c => c.category === cat).sort((a,b)=>a.price-b.price);
    for (const opt of options) { if (pick(opt)) break; }
  }

  // 2) Fill remainder by cheapest-first
  const remaining = candidates
    .filter(c => !selected.includes(c))
    .sort((a,b)=>a.price-b.price);
  for (const opt of remaining) pick(opt);

  return {
    title: spec.title,
    budget,
    total: Number(total.toFixed(2)),
    items: selected
  };
}

/** ---------------- Utils ---------------- */
function parsePrice(p){ if (typeof p==='number') return p; const s=String(p||'').replace(/[, ]/g,''); const m=s.match(/(\d+(\.\d+)?)/); return m?Number(m[1]):NaN; }
function buildReason({ rating, merchant }){ const parts=[]; if(merchant) parts.push(String(merchant)); if(rating) parts.push(`Rating: ${rating}`); return parts.length?parts.join(' • '):'Good value'; }
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
function stringOr(v,d=''){ return (typeof v==='string'&&v.trim())?v.trim():d; }
function numberOr(v,d=0){ const n=Number(v); return isFinite(n)?n:d; }
function arrayOfStringsOr(v,d=[]){ return Array.isArray(v)?v.map(x=>String(x||'').trim()).filter(Boolean):d; }
function clamp(n,min,max){ return Math.max(min, Math.min(max, Number(n)||min)); }
function capitalize(s){ return String(s||'').replace(/\b\w/g, m => m.toUpperCase()); }

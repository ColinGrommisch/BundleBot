// api/build-bundle.js
// Vercel Node serverless function (NOT Edge).
// Debug-friendly version for RapidAPI "Real Time Product Search" (RPS).
// - Reads { debug: true } to include non-sensitive debug info in response
// - Logs URL and response shapes to Function Logs
// - AI spec via OpenAI (optional; safe fallback)
// - Product search via RapidAPI RPS (primary), optional Apify fallback
// - 45-min in-memory cache per category
// - Budget-aware composer

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const RAPIDAPI_KEY   = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST  = process.env.RAPIDAPI_HOST; // real-time-product-search.p.rapidapi.com

const APIFY_TOKEN    = process.env.APIFY_TOKEN;    // optional
const APIFY_ACTOR_ID = process.env.APIFY_ACTOR_ID; // optional

/** ---------------- In-memory cache ---------------- */
const CACHE  = new Map();           // key -> { ts, data }
const TTL_MS = 45 * 60 * 1000;      // 45 minutes
function getCache(k){ const v=CACHE.get(k); return v && (Date.now()-v.ts<TTL_MS) ? v.data : null; }
function setCache(k,d){ CACHE.set(k,{ ts:Date.now(), data:d }); }

/** ---------------- Main handler ---------------- */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const raw  = req.body || '{}';
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw;

    const prompt   = String(body.prompt || '').trim();
    const budgetIn = Number(body.budget || NaN);
    const debug    = Boolean(body.debug); // <-- turn on extra logs + debug block
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // 1) AI → structured spec (safe fallback if OPENAI not set or fails)
    const spec = await safeGetSpecFromAI({ prompt, budget: isFinite(budgetIn) ? budgetIn : undefined, debug });

    // 2) Build candidates (cache-wrapped search per category)
    const candidates = await getCandidatesFromSpec(spec, debug);

    // 3) Compose bundle
    const bundle = composeBundle({ spec, candidates });

    if (debug) {
      bundle.debug = {
        rapid_host: RAPIDAPI_HOST || null,
        candidates_count: Array.isArray(candidates) ? candidates.length : null,
        categories: [...new Set([...(spec.must_have||[]), ...(spec.nice_to_have||[])])],
        spec
      };
    }

    return res.status(200).json(bundle);
  } catch (err) {
    console.error('API error:', err);
    // Always return something to keep UX working
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
async function safeGetSpecFromAI({ prompt, budget, debug }) {
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
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
      })
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${text}`);

    let json = {};
    try { json = JSON.parse(text); } catch {}
    const raw  = json?.choices?.[0]?.message?.content || '{}';

    let spec = {};
    try { spec = JSON.parse(raw); } catch {}
    // normalize
    spec.title        = stringOr(spec.title, `Bundle for: ${prompt}`);
    spec.budget       = clamp(numberOr(spec.budget, isFinite(budget) ? budget : 500), 50, 5000);
    spec.max_items    = clamp(numberOr(spec.max_items, 10), 3, 15);
    spec.must_have    = arrayOfStringsOr(spec.must_have,    ['bedding','lighting','storage']).slice(0, 10);
    spec.nice_to_have = arrayOfStringsOr(spec.nice_to_have, ['desk accessories','fan','laundry']).slice(0, 10);

    if (debug) console.log('[AI] spec:', spec);
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
async function getCandidatesFromSpec(spec, debug = false) {
  const cats = [...(spec.must_have || []), ...(spec.nice_to_have || [])];
  const uniqueCats = [...new Set(cats)].slice(0, 8);

  const results = [];
  for (const cat of uniqueCats) {
    const key = `q:${cat.toLowerCase()}|l:3`;
    let items = getCache(key);
    if (!items) {
      items = await searchProducts({ query: cat, limit: 3, debug }).catch((e) => {
        console.warn('[searchProducts] error:', e?.message || e);
        return [];
      });
      if (items?.length) setCache(key, items);
    } else if (debug) {
      console.log('[cache] hit for', key, 'items:', items.length);
    }
    results.push(...(items || []).map(i => ({ ...i, category: cat })));
  }

  if (debug) console.log('[candidates] total:', results.length);
  return results;
}

/** ---------------- Search: RapidAPI primary + optional Apify fallback ---------------- */
const RAPIDAPI_ENABLED = () => !!(RAPIDAPI_KEY && RAPIDAPI_HOST);
const APIFY_ENABLED    = () => !!(APIFY_TOKEN && APIFY_ACTOR_ID);

async function searchProducts({ query, limit = 3, debug = false }) {
  // 1) RapidAPI (primary)
  if (RAPIDAPI_ENABLED()) {
    const rapid = await rapidRPS({ query, limit, _debug: debug }).catch((e) => {
      console.warn('[RPS] error:', e?.message || e);
      return null;
    });
    if (rapid?.length) return rapid;

    // Uncomment this to *force* an error instead of falling back, for debugging:
    // throw new Error('RapidAPI returned no items (forced for debugging)');
  }

  // 2) Apify fallback (optional)
  if (APIFY_ENABLED()) {
    const apify = await apifyRetailSearch({ query, limit }).catch((e) => {
      console.warn('[Apify] error:', e?.message || e);
      return null;
    });
    if (apify?.length) return apify;
  }

  // 3) Demo fallback
  return [
    { name: `${capitalize(query)} — Option A`, price: 24.99, link: 'https://example.com/a', image: 'https://via.placeholder.com/300', reason: 'Good reviews • Low price', source: 'demo' },
    { name: `${capitalize(query)} — Option B`, price: 32.50, link: 'https://example.com/b', image: 'https://via.placeholder.com/300', reason: 'Solid quality • Popular pick', source: 'demo' },
    { name: `${capitalize(query)} — Option C`, price: 18.75, link: 'https://via.placeholder.com/300', image: 'https://via.placeholder.com/300', reason: 'Cheapest viable option', source: 'demo' }
  ].slice(0, limit).sort((a,b)=>a.price-b.price);
}

/** RapidAPI: Real Time Product Search → normalize from json.data[] or similar */
async function rapidRPS({ query, limit, _debug = false }) {
  if (!RAPIDAPI_ENABLED()) throw new Error('RapidAPI not configured');

  const url = new URL(`https://${RAPIDAPI_HOST}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('country', 'us');

  if (_debug) console.log('[RPS] URL:', url.toString());

  const resp = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-RapidAPI-Key': RAPIDAPI_KEY,
      'X-RapidAPI-Host': RAPIDAPI_HOST
    }
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`RapidAPI ${resp.status}: ${text}`);

  let json = {};
  try { json = JSON.parse(text); } catch {}
  if (_debug) console.log('[RPS] root keys:', Object.keys(json || {}));

  // Try multiple possible shapes
  const arraysToTry = [
    Array.isArray(json?.data) ? json.data : null,
    Array.isArray(json?.data?.items) ? json.data.items : null,
    Array.isArray(json?.data?.products) ? json.data.products : null,
    Array.isArray(json?.results) ? json.results : null,
    Array.isArray(json?.products) ? json.products : null,
    Array.isArray(json?.items) ? json.items : null
  ].filter(Boolean);

  const rows = arraysToTry[0] || [];
  if (_debug) {
    console.log('[RPS] counts:', {
      data: Array.isArray(json?.data) ? json.data.length : null,
      data_items: Array.isArray(json?.data?.items) ? json.data.items.length : null,
      data_products: Array.isArray(json?.data?.products) ? json.data.products.length : null,
      results: Array.isArray(json?.results) ? json.results.length : null,
      products: Array.isArray(json?.products) ? json.products.length : null,
      items: Array.isArray(json?.items) ? json.items.length : null,
      mapped: rows.length
    });
  }

  const items = rows.map((r) => {
    const name   = r.product_title || r.title || r.name || r.heading || 'Item';
    const price  = parsePrice(r.product_price || r.price || r.price_str || r.amount || '');
    const link   = r.product_link || r.link || r.url || r.permalink || '#';
    const image  = r.product_photo || r.image || r.thumbnail || r.imageUrl || 'https://via.placeholder.com/300';
    const rating = r.product_rating || r.rating || r.stars || '';
    const store  = r.product_source || r.source || r.store || r.seller || '';
    const reason = buildReason({ rating, merchant: store });
    return { name, price, link, image, reason, source: 'rapidapi:rps' };
  })
  .filter(i => isFinite(i.price) && i.link && i.name)
  .sort((a,b) => a.price - b.price)
  .slice(0, limit);

  if (_debug) console.log('[RPS] mapped items:', items.length);
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

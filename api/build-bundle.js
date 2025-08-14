// api/build-bundle.js
// Node serverless function for Vercel (NOT Edge).
// Phase 3 Step 2: add getCandidatesFromSpec() that wraps searchProducts() calls with a cache.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/** ------------ In-memory cache (per serverless instance) ------------ */
const CACHE = new Map(); // key -> { ts, data }
const TTL_MS = 45 * 60 * 1000; // 45 minutes

function getCache(key) {
  const v = CACHE.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > TTL_MS) return null;
  return v.data;
}
function setCache(key, data) {
  CACHE.set(key, { ts: Date.now(), data });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const raw = req.body || '{}';
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw;

    const prompt = (body.prompt || '').toString().trim();
    const budgetIn = Number(body.budget || NaN);
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // 1) AI → structured spec (resilient: falls back if OpenAI missing/fails)
    const spec = await safeGetSpecFromAI({ prompt, budget: isFinite(budgetIn) ? budgetIn : undefined });

    // 2) Build candidates from spec (this is where we WRAP searchProducts with cache)
    const candidates = await getCandidatesFromSpec(spec);

    // 3) Compose bundle
    const bundle = composeBundle({ spec, candidates });

    return res.status(200).json(bundle);
  } catch (err) {
    console.error('API error:', err);
    // Final fallback so the UI still shows something
    const items = [
      { name:'Twin XL Bedding Set', price:79.99, link:'https://example.com/bedding', image:'https://via.placeholder.com/300', reason:'Fits dorm beds; reviewed well' },
      { name:'LED Desk Lamp',       price:24.99, link:'https://example.com/lamp',    image:'https://via.placeholder.com/300', reason:'Dimmable + USB' },
      { name:'Over-the-Door Hooks', price:12.99, link:'https://example.com/hooks',   image:'https://via.placeholder.com/300', reason:'Instant storage' }
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

/** ------------ Step 1: AI prompt → spec (safe) ------------ */
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
          { role: 'user', content: user }
        ]
      })
    });

    if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text().catch(()=>resp.statusText)}`);
    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || '{}';

    let spec = JSON.parse(raw);
    spec.title = stringOr(spec.title, `Bundle for: ${prompt}`);
    spec.budget = numberOr(spec.budget, isFinite(budget) ? budget : 500);
    spec.max_items = clamp(numberOr(spec.max_items, 10), 3, 15);
    spec.must_have = arrayOfStringsOr(spec.must_have, ['bedding','lighting','storage']).slice(0, 10);
    spec.nice_to_have = arrayOfStringsOr(spec.nice_to_have, ['desk accessories','fan','laundry']).slice(0, 10);
    spec.budget = clamp(spec.budget, 50, 5000);
    return spec;
  } catch (e) {
    console.warn('AI spec fallback:', e?.message || e);
    return {
      title: `Bundle for: ${prompt}`,
      budget: isFinite(budget) ? budget : 500,
      must_have: ['bedding','lighting','storage'],
      nice_to_have: ['desk accessories','fan','laundry'],
      max_items: 10
    };
  }
}

/** ------------ Step 2: Build candidates from spec (WRAPS searchProducts with cache) ------------ */
async function getCandidatesFromSpec(spec) {
  const cats = [...(spec.must_have || []), ...(spec.nice_to_have || [])];
  const uniqueCats = [...new Set(cats)].slice(0, 8); // keep it small for MVP

  const results = [];
  for (const cat of uniqueCats) {
    const cacheKey = `q:${cat.toLowerCase()}|l:3`;
    let items = getCache(cacheKey);
    if (!items) {
      items = await searchProducts({ query: cat, limit: 3 }); // <— ALL calls pass through here
      setCache(cacheKey, items);
    }
    // Attach category for the composer
    results.push(...(items || []).map(i => ({ ...i, category: cat })));
  }
  return results;
}

/** ------------ searchProducts(): TEMP stub you can swap with a real API ------------ */
async function searchProducts({ query, limit = 3 }) {
  // TODO: Replace this stub with a real source (Apify / RapidAPI / your scraper).
  // Normalize to: { name, price, link, image, reason, source }
  const demo = [
    { name: `${capitalize(query)} — Option A`, price: 24.99, link: 'https://example.com/a', image: 'https://via.placeholder.com/300', reason: 'Good reviews • Low price', source: 'demo' },
    { name: `${capitalize(query)} — Option B`, price: 32.50, link: 'https://example.com/b', image: 'https://via.placeholder.com/300', reason: 'Solid quality • Popular pick', source: 'demo' },
    { name: `${capitalize(query)} — Option C`, price: 18.75, link: 'https://example.com/c', image: 'https://via.placeholder.com/300', reason: 'Cheapest viable option', source: 'demo' }
  ];
  // Sort cheap-first to help the composer stay under budget
  return demo.slice(0, limit).sort((a, b) => a.price - b.price);
}

/** ------------ Step 3: Compose bundle under budget ------------ */
function composeBundle({ spec, candidates }) {
  const budget = spec.budget ?? 500;
  const maxItems = spec.max_items ?? 10;

  const selected = [];
  let total = 0;

  const pick = (item) => {
    if (selected.length >= maxItems) return false;
    if (total + item.price > budget) return false;
    selected.push(item);
    total += item.price;
    return true;
  };

  // 1) Ensure each must-have category is represented (pick cheapest per cat)
  for (const cat of (spec.must_have || [])) {
    const options = candidates.filter(c => c.category === cat).sort((a,b)=>a.price-b.price);
    for (const opt of options) { if (pick(opt)) break; }
  }

  // 2) Fill remainder with cheapest items first (MVP heuristic)
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

/** ------------ utils ------------ */
function stringOr(v, d='') { return (typeof v === 'string' && v.trim()) ? v.trim() : d; }
function numberOr(v, d=0) { const n = Number(v); return isFinite(n) ? n : d; }
function arrayOfStringsOr(v, d=[]) { return Array.isArray(v) ? v.map(x => String(x||'').trim()).filter(Boolean) : d; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, Number(n)||min)); }
function capitalize(s){ return String(s||'').replace(/\b\w/g, m => m.toUpperCase()); }

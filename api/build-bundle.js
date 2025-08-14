// api/build-bundle.js
// Resilient Node serverless function for Vercel.
// Will fall back to a default spec if OpenAI isn't available.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const bodyRaw = req.body || '{}';
    const body = typeof bodyRaw === 'string' ? JSON.parse(bodyRaw) : bodyRaw;
    const prompt = (body.prompt || '').toString().trim();
    const budgetIn = Number(body.budget || NaN);

    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // 1) Try to get a spec from OpenAI; if anything fails, fall back
    let spec = await safeGetSpecFromAI({ prompt, budget: isFinite(budgetIn) ? budgetIn : undefined });

    // 2) Still stub candidates (replace later with real search)
    const candidates = getStubCandidates();

    // 3) Compose a bundle
    const bundle = composeBundle({ spec, candidates });

    return res.status(200).json(bundle);
  } catch (err) {
    console.error('API error:', err);
    // Last-resort fallback: return a static bundle so UI still works
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

/** -------- Safe AI helper (never throws) -------- */
async function safeGetSpecFromAI({ prompt, budget }) {
  try {
    if (!OPENAI_API_KEY) throw new Error('No OPENAI_API_KEY set');

    const system = `
You are BundleBot. Output STRICT JSON only:
{ "title": string, "budget": number, "must_have": string[], "nice_to_have": string[], "max_items": number }
If user gives a budget, use it; else choose a reasonable one.
Keep categories short: "bedding","lighting","storage","desk accessories","fan","laundry".
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
    // Normalize
    spec.title = stringOr(spec.title, `Bundle for: ${prompt}`);
    spec.budget = numberOr(spec.budget, isFinite(budget) ? budget : 500);
    spec.max_items = numberOr(spec.max_items, 10);
    spec.must_have = arrayOfStringsOr(spec.must_have, ['bedding','lighting','storage']).slice(0, 10);
    spec.nice_to_have = arrayOfStringsOr(spec.nice_to_have, ['desk accessories','fan','laundry']).slice(0, 10);
    spec.budget = clamp(spec.budget, 50, 5000);
    spec.max_items = clamp(spec.max_items, 3, 15);
    return spec;
  } catch (e) {
    console.warn('AI spec fallback:', e?.message || e);
    // Default spec fallback
    return {
      title: `Bundle for: ${prompt}`,
      budget: isFinite(budget) ? budget : 500,
      must_have: ['bedding','lighting','storage'],
      nice_to_have: ['desk accessories','fan','laundry'],
      max_items: 10
    };
  }
}

/** -------- Stubs & composer -------- */
function getStubCandidates() {
  const S = (name, price, link, image, reason, category) =>
    ({ name, price, link, image, reason, category });
  return [
    S('Twin XL Bedding Set', 79.99, 'https://example.com/bedding', 'https://via.placeholder.com/300', 'Fits dorm beds; good reviews', 'bedding'),
    S('LED Desk Lamp', 24.99, 'https://example.com/lamp', 'https://via.placeholder.com/300', 'Dimmable + USB port', 'lighting'),
    S('Clip-on Fan', 21.49, 'https://example.com/fan', 'https://via.placeholder.com/300', 'Quiet; small footprint', 'fan'),
    S('Foldable Laundry Hamper', 18.99, 'https://example.com/hamper', 'https://via.placeholder.com/300', 'Space-saving', 'laundry'),
    S('Over-the-Door Hooks', 12.99, 'https://example.com/hooks', 'https://via.placeholder.com/300', 'Instant storage', 'storage'),
    S('Under-bed Storage Bins (2pk)', 32.00, 'https://example.com/bins', 'https://via.placeholder.com/300', 'Use dead space', 'storage'),
    S('Desk Organizer', 15.99, 'https://example.com/organizer', 'https://via.placeholder.com/300', 'Keep essentials tidy', 'desk accessories'),
    S('Power Strip + USB', 16.99, 'https://example.com/power', 'https://via.placeholder.com/300', 'Surge protection', 'desk accessories'),
    S('Shower Caddy', 14.49, 'https://example.com/caddy', 'https://via.placeholder.com/300', 'Shared bathroom friendly', 'bath'),
    S('LED Light Strip (10ft)', 13.99, 'https://example.com/strip', 'https://via.placeholder.com/300', 'Ambient lighting', 'lighting')
  ];
}

function composeBundle({ spec, candidates }) {
  const budget = spec.budget ?? 500;
  const maxItems = spec.max_items ?? 10;

  const selected = [];
  let total = 0;
  const pick = (item) => {
    if (selected.length >= maxItems) return false;
    if (total + item.price > budget) return false;
    selected.push(item); total += item.price; return true;
  };

  for (const cat of (spec.must_have || [])) {
    const options = candidates.filter(c => c.category === cat).sort((a,b)=>a.price-b.price);
    for (const opt of options) { if (pick(opt)) break; }
  }

  const remaining = candidates.filter(c => !selected.includes(c)).sort((a,b)=>a.price-b.price);
  for (const opt of remaining) pick(opt);

  return { title: spec.title, budget, total: Number(total.toFixed(2)), items: selected };
}

/** -------- utils -------- */
function stringOr(v, d='') { return (typeof v === 'string' && v.trim()) ? v.trim() : d; }
function numberOr(v, d=0) { const n = Number(v); return isFinite(n) ? n : d; }
function arrayOfStringsOr(v, d=[]) { return Array.isArray(v) ? v.map(x => String(x||'').trim()).filter(Boolean) : d; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, Number(n)||min)); }

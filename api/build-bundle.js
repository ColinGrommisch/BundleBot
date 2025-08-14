// api/build-bundle.js
// Node serverless function for Vercel (NOT Edge).
// Phase 3 Step 1: real AI call to build a strict JSON "spec" from the user prompt.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const bodyRaw = req.body || '{}';
    const body = typeof bodyRaw === 'string' ? JSON.parse(bodyRaw) : bodyRaw;
    const prompt = (body.prompt || '').toString().trim();
    const budgetIn = Number(body.budget || NaN);

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Missing OPENAI_API_KEY server env var' });
    }
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // 1) Get a strict JSON spec from AI
    const spec = await getSpecFromAI({ prompt, budget: isFinite(budgetIn) ? budgetIn : undefined });

    // 2) (Still stub) source a small candidate list
    const candidates = getStubCandidates();

    // 3) Compose a bundle that fits the spec
    const bundle = composeBundle({ spec, candidates });

    res.status(200).json(bundle);
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: String(err?.message || err) });
  }
}

/** ---------------- AI: prompt → spec ---------------- **/

async function getSpecFromAI({ prompt, budget }) {
  // Force strict JSON via response_format
  const system = `
You are BundleBot. You transform a natural-language shopping request into STRICT JSON with keys:
- title: string
- budget: number (USD)
- must_have: string[]  // categories that must appear at least once
- nice_to_have: string[] // optional categories to include if budget allows
- max_items: number     // hard cap (5–12)

Rules:
- Output JSON ONLY (no prose, no markdown).
- If user gives a budget, use it; otherwise choose a reasonable one.
- Keep category names short and practical (e.g., "bedding", "lighting", "storage", "desk accessories", "fan", "laundry").
- max_items should usually be 8–12 for setups like dorm/first apartment.
  `.trim();

  const user = `
User request: "${prompt}"
User-provided budget (if any): ${isFinite(budget) ? budget : 'N/A'}

Return JSON exactly like:
{
  "title": "Dorm Room Setup • UConn Freshman • Under $500",
  "budget": 500,
  "must_have": ["bedding","lighting","storage"],
  "nice_to_have": ["desk accessories","fan","laundry"],
  "max_items": 10
}
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
      response_format: { type: 'json_object' }, // Enforce JSON
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => '');
    throw new Error(`OpenAI error ${resp.status}: ${errTxt || resp.statusText}`);
  }

  const data = await resp.json();
  const raw = data?.choices?.[0]?.message?.content || '{}';

  let spec;
  try {
    spec = JSON.parse(raw);
  } catch {
    // Fallback spec if the model ever drifts
    spec = {
      title: `Bundle for: ${prompt}`,
      budget: isFinite(budget) ? budget : 500,
      must_have: ['bedding', 'lighting', 'storage'],
      nice_to_have: ['desk accessories', 'fan', 'laundry'],
      max_items: 10
    };
  }

  // Normalize & validate
  spec.title = stringOr(spec.title, `Bundle for: ${prompt}`);
  spec.budget = numberOr(spec.budget, isFinite(budget) ? budget : 500);
  spec.max_items = numberOr(spec.max_items, 10);
  spec.must_have = arrayOfStringsOr(spec.must_have, ['bedding', 'lighting', 'storage']).slice(0, 10);
  spec.nice_to_have = arrayOfStringsOr(spec.nice_to_have, ['desk accessories', 'fan', 'laundry']).slice(0, 10);

  // Clamp sensible ranges
  spec.budget = Math.max(50, Math.min(5000, spec.budget));
  spec.max_items = Math.max(3, Math.min(15, spec.max_items));

  return spec;
}

/** ---------------- Candidates (still stub in Step 1) ---------------- **/

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

/** ---------------- Composer ---------------- **/

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

  // 1) Must-haves: pick cheapest option per category
  for (const cat of (spec.must_have || [])) {
    const options = candidates.filter(c => c.category === cat).sort((a,b)=>a.price-b.price);
    for (const opt of options) { if (pick(opt)) break; }
  }

  // 2) Fill remainder by cheapest-first (placeholder heuristic)
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

/** ---------------- Small validators ---------------- **/

function stringOr(v, d='') { return (typeof v === 'string' && v.trim()) ? v.trim() : d; }
function numberOr(v, d=0) { const n = Number(v); return isFinite(n) ? n : d; }
function arrayOfStringsOr(v, d=[]) {
  return Array.isArray(v) ? v.map(x => String(x || '').trim()).filter(Boolean) : d;
}

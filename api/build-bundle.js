// api/build-bundle.js
// Node serverless function for Vercel (NOT Edge).
export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // Ensure the client sent JSON with the header: Content-Type: application/json
    const bodyRaw = req.body || '{}';
    const body = typeof bodyRaw === 'string' ? JSON.parse(bodyRaw) : bodyRaw;

    const prompt = (body.prompt || '').toString().trim();
    if (!prompt) {
      res.status(400).json({ error: 'Missing prompt' });
      return;
    }

    // Stub bundle (replace later with AI + search)
    const items = [
      { name:'Twin XL Bedding Set', price:79.99, link:'https://example.com/bedding', image:'https://via.placeholder.com/300', reason:'Fits dorm beds; reviewed well' },
      { name:'LED Desk Lamp',       price:24.99, link:'https://example.com/lamp',    image:'https://via.placeholder.com/300', reason:'Dimmable + USB' },
      { name:'Over-the-Door Hooks', price:12.99, link:'https://example.com/hooks',   image:'https://via.placeholder.com/300', reason:'Instant storage' }
    ];
    const total = items.reduce((s,i)=>s+i.price,0);

    res.status(200).json({
      title: `Bundle for: ${prompt}`,
      budget: 500,
      total: Number(total.toFixed(2)),
      items
    });
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: String(err?.message || err) });
  }
}

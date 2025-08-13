// api/build-bundle.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { prompt } = JSON.parse(req.body || '{}');
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    const items = [
      { name:'Twin XL Bedding Set', price:79.99, link:'https://example.com/bedding', image:'https://via.placeholder.com/300', reason:'Fits dorm beds; good reviews' },
      { name:'LED Desk Lamp',       price:24.99, link:'https://example.com/lamp',    image:'https://via.placeholder.com/300', reason:'Dimmable + USB' },
      { name:'Over-the-Door Hooks', price:12.99, link:'https://example.com/hooks',   image:'https://via.placeholder.com/300', reason:'Instant storage' }
    ];
    const total = items.reduce((s,i)=>s+i.price,0);

    return res.status(200).json({
      title: `Bundle for: ${prompt}`,
      budget: 500,
      total: Number(total.toFixed(2)),
      items
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to build bundle' });
  }
}

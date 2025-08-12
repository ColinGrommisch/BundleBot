// api/build-bundle.js  (Node function)
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { prompt } = JSON.parse(req.body || '{}');
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // TODO: Call your AI/search here. For now, return a stub bundle:
    const bundle = {
      title: `Bundle for: ${prompt}`,
      budget: 500,
      total: 472.31,
      items: [
        { name: 'Twin XL Bedding Set', price: 79.99, link: 'https://example.com/bedding', image: 'https://via.placeholder.com/300', reason: 'Fits dorm beds; good reviews' },
        { name: 'LED Desk Lamp',       price: 24.99, link: 'https://example.com/lamp',    image: 'https://via.placeholder.com/300', reason: 'Dimmable + USB' },
        { name: 'Compact Fan',         price: 19.99, link: 'https://example.com/fan',     image: 'https://via.placeholder.com/300', reason: 'Quiet; small footprint' }
      ]
    };

    res.status(200).json(bundle);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build bundle' });
  }
}

// Proxies images through our server to bypass hotlink restrictions
// Usage: /api/image-proxy?url=ENCODED_IMAGE_URL

module.exports = async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url param');

  try {
    const response = await fetch(decodeURIComponent(url), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.instagram.com/',
        'Accept': 'image/*',
      }
    });

    if (!response.ok) return res.status(response.status).send('Image fetch failed');

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // cache 24h
    res.setHeader('Access-Control-Allow-Origin', '*');

    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch(e) {
    res.status(500).send('Proxy error');
  }
};

// Fetches Instagram post images via oEmbed / media redirect
// Admin pastes Instagram post URLs, this returns the image URLs

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  // GET: return cached/stored images from gallery.json post URLs
  // POST: resolve a single Instagram URL to an image

  if (req.method === 'GET') {
    try {
      const fs = require('fs');
      const path = require('path');
      const galleryPath = path.join(__dirname, '..', 'public', 'gallery.json');
      const gallery = JSON.parse(fs.readFileSync(galleryPath, 'utf8'));

      const images = [];
      for (const item of (gallery.images || [])) {
        if (item.url) {
          // If it's already a direct image URL, use it
          if (item.url.match(/\.(jpg|jpeg|png|webp|gif)/i) || item.url.includes('ibb.co') || item.url.includes('imgur')) {
            images.push(item);
          }
          // If it's an Instagram post URL, try to get the media
          else if (item.url.includes('instagram.com/p/') || item.url.includes('instagram.com/reel/')) {
            try {
              // Strip query params and trailing slash, then add /media/?size=l
              const cleanUrl = item.url.split('?')[0].replace(/\/$/, '');
              const mediaUrl = cleanUrl + '/media/?size=l';
              const mediaRes = await fetch(mediaUrl, { redirect: 'follow' });
              if (mediaRes.ok && mediaRes.url) {
                // Proxy through our server to bypass hotlink blocking
                const proxyUrl = '/api/image-proxy?url=' + encodeURIComponent(mediaRes.url);
                images.push({ ...item, url: proxyUrl });
              } else {
                // If media redirect fails, skip
                images.push({ ...item, url: '' });
              }
            } catch(e) {
              // Skip this image if fetch fails
            }
          } else {
            images.push(item);
          }
        }
      }

      res.json({ images, source: 'gallery', instagram: gallery.instagram || 'fritzdetailonthego' });
    } catch(e) {
      res.json({ images: [], source: 'empty', instagram: 'fritzdetailonthego' });
    }
    return;
  }

  // POST: resolve a single Instagram URL to check if it works
  if (req.method === 'POST') {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL provided' });

    try {
      if (url.includes('instagram.com/p/') || url.includes('instagram.com/reel/')) {
        const cleanUrl = url.split('?')[0].replace(/\/$/, '');
        const mediaUrl = cleanUrl + '/media/?size=l';
        const mediaRes = await fetch(mediaUrl, { redirect: 'follow' });
        if (mediaRes.ok) {
          const proxyUrl = '/api/image-proxy?url=' + encodeURIComponent(mediaRes.url);
          return res.json({ success: true, imageUrl: proxyUrl, original: url });
        }
      }
      // Not an Instagram URL or fetch failed — treat as direct image
      return res.json({ success: true, imageUrl: url, original: url });
    } catch(e) {
      return res.status(400).json({ error: 'Could not resolve URL: ' + e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};

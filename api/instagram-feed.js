// Attempts to fetch Instagram posts for the gallery slideshow
// Falls back to gallery.json manual images if Instagram blocks the request

const INSTAGRAM_USER = 'fritzdetailonthego';
const CACHE_DURATION = 3600000; // 1 hour cache

let cachedData = null;
let cacheTime = 0;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300'); // browser caches 5 min

  // Return cache if fresh
  if (cachedData && (Date.now() - cacheTime) < CACHE_DURATION) {
    return res.json(cachedData);
  }

  try {
    // Method 1: Try Instagram's public page and extract from HTML
    const response = await fetch(`https://www.instagram.com/${INSTAGRAM_USER}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
      }
    });

    if (!response.ok) throw new Error('Instagram returned ' + response.status);

    const html = await response.text();

    // Try to extract image URLs from meta tags and embedded JSON
    const images = [];

    // Extract og:image (profile/post images in meta tags)
    const ogMatches = html.matchAll(/property="og:image"\s+content="([^"]+)"/g);
    for (const match of ogMatches) {
      if (match[1] && !match[1].includes('profile_pic')) {
        images.push({ url: match[1], caption: '', source: 'instagram' });
      }
    }

    // Try to find image URLs in the page's JSON data
    // Instagram embeds post data in script tags
    const scriptMatches = html.matchAll(/"display_url"\s*:\s*"([^"]+)"/g);
    for (const match of scriptMatches) {
      const url = match[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
      if (url.startsWith('http')) {
        images.push({ url, caption: '', source: 'instagram' });
      }
    }

    // Also try thumbnail URLs
    const thumbMatches = html.matchAll(/"thumbnail_src"\s*:\s*"([^"]+)"/g);
    for (const match of thumbMatches) {
      const url = match[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
      if (url.startsWith('http') && !images.find(i => i.url === url)) {
        images.push({ url, caption: '', source: 'instagram' });
      }
    }

    if (images.length > 0) {
      // Dedupe and limit to 12
      const unique = [];
      const seen = new Set();
      for (const img of images) {
        const key = img.url.split('?')[0]; // ignore query params for dedup
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(img);
        }
        if (unique.length >= 12) break;
      }

      const result = { images: unique, source: 'instagram', instagram: INSTAGRAM_USER };
      cachedData = result;
      cacheTime = Date.now();
      return res.json(result);
    }

    throw new Error('No images found in Instagram response');

  } catch (error) {
    console.log('Instagram fetch failed:', error.message, '— falling back to gallery.json');

    // Fallback: return empty so frontend uses gallery.json
    res.json({
      images: [],
      source: 'fallback',
      instagram: INSTAGRAM_USER,
      message: 'Instagram feed unavailable — using manual gallery'
    });
  }
};

// Serves gallery images. Reads gallery.json directly.
// Instagram blocks all server-side approaches, so we use direct image URLs
// Fritz uploads photos to imgbb.com and pastes the links in the admin panel

const fs = require('fs');
const path = require('path');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');

  try {
    const galleryPath = path.join(__dirname, '..', 'public', 'gallery.json');
    const gallery = JSON.parse(fs.readFileSync(galleryPath, 'utf8'));
    const images = (gallery.images || []).filter(img => img.url && !img.url.includes('instagram.com'));
    res.json({ images, instagram: gallery.instagram || 'fritzdetailonthego' });
  } catch(e) {
    res.json({ images: [], instagram: 'fritzdetailonthego' });
  }
};

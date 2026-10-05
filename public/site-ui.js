(function () {
  const menu = document.querySelector('[data-menu]');
  const nav = document.querySelector('[data-nav]');

  function closeMenu(restoreFocus) {
    if (!menu || !nav || !nav.classList.contains('open')) return;
    nav.classList.remove('open');
    menu.setAttribute('aria-expanded', 'false');
    if (restoreFocus) menu.focus();
  }

  if (menu && nav) {
    menu.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      menu.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', event => {
      if (event.target.closest('a')) closeMenu(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeMenu(true);
    });
  }

  document.querySelectorAll('[data-year]').forEach(element => {
    element.textContent = new Date().getFullYear();
  });

  fetch('/site-config.json?t=' + Date.now(), { cache: 'no-store' })
    .then(response => {
      if (!response.ok) throw new Error('Config unavailable');
      return response.json();
    })
    .then(applySiteConfig)
    .catch(() => {});

  function applySiteConfig(config) {
    const pricingVisible = config.showPricing !== false;
    const pricingSection = document.getElementById('pricing');
    if (pricingSection) pricingSection.hidden = !pricingVisible;
    document.querySelectorAll('a[href="#pricing"],a[href="/#pricing"]').forEach(link => {
      link.hidden = !pricingVisible;
    });
    document.querySelectorAll('[data-weekend]').forEach(element => {
      element.hidden = config.worksWeekends !== true;
    });

    if (config.acceptingNewClients === false) {
      document.querySelectorAll('a[href="/checkout.html"]').forEach(link => {
        link.href = 'tel:+12762470921';
        link.textContent = 'Call for availability';
        link.setAttribute('aria-label', 'Call Fritz for current availability at (276) 247-0921');
      });
      if (!document.querySelector('.booking-notice')) {
        const notice = document.createElement('div');
        notice.className = 'booking-notice';
        notice.setAttribute('role', 'status');
        notice.textContent = 'Online booking is temporarily paused. Call Fritz for current availability.';
        document.querySelector('.site-header')?.insertAdjacentElement('afterend', notice);
      }
    }
  }

  const pricingRoot = document.querySelector('[data-pricing]');
  if (pricingRoot) {
    fetch('/pricing.json?t=' + Date.now())
      .then(response => {
        if (!response.ok) throw new Error('Pricing unavailable');
        return response.json();
      })
      .then(data => renderPricing(pricingRoot, data))
      .catch(() => {
        pricingRoot.innerHTML = '<p class="pricing-note">Pricing is temporarily unavailable. Call or text Fritz for current options.</p>';
      });
  }

  function serviceValue(raw) {
    return typeof raw === 'number' ? raw : Number(raw && (raw.price || raw.amount)) || 0;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function renderPricing(root, data) {
    const entries = Object.entries(data || {});
    if (!entries.length) throw new Error('No pricing tiers');
    root.innerHTML = '<div class="vehicle-tabs" role="group" aria-label="Vehicle type"></div><div class="price-columns" aria-live="polite"></div><div class="pricing-note">Prices are loaded from the current service menu. Final scope may vary with vehicle condition or special requests; any added fee is reviewed before service.</div>';
    const controls = root.querySelector('.vehicle-tabs');
    const columns = root.querySelector('.price-columns');

    function show(key) {
      const tier = data[key];
      controls.querySelectorAll('button').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.key === key));
      });
      columns.innerHTML = ['exterior', 'interior', 'packages'].map(section => {
        const rows = Object.entries(tier[section] || {}).filter(([, raw]) => serviceValue(raw) > 0);
        return `<section class="price-group"><h3>${section[0].toUpperCase() + section.slice(1)}</h3>${rows.map(([name, raw]) => `<div class="price-line"><span>${escapeHtml(name)}</span><span>$${serviceValue(raw).toLocaleString()}</span></div>`).join('') || '<p>No services listed.</p>'}</section>`;
      }).join('');
    }

    entries.forEach(([key, tier]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.key = key;
      button.setAttribute('aria-pressed', 'false');
      button.textContent = tier.label || key;
      button.addEventListener('click', () => show(key));
      controls.appendChild(button);
    });
    show(entries[0][0]);
  }

  const gallery = document.querySelector('[data-gallery]');
  if (gallery) {
    fetch('/gallery.json?t=' + Date.now())
      .then(response => response.json())
      .then(data => renderGallery(gallery, data.images || []))
      .catch(() => renderGallery(gallery, []));
  }

  function isSafeUrl(value) {
    try {
      return ['https:', 'http:'].includes(new URL(value, window.location.href).protocol);
    } catch {
      return false;
    }
  }

  function renderGallery(root, images) {
    const usable = images.filter(item => item && isSafeUrl(item.url));
    if (!usable.length) {
      root.innerHTML = '<div class="empty-gallery"><strong>Fresh work is posted on Instagram.</strong><br><a href="https://instagram.com/fritzdetailonthego" target="_blank" rel="noopener">Visit @fritzdetailonthego</a></div>';
      return;
    }
    root.innerHTML = '';
    usable.forEach(item => {
      if (item.url.includes('instagram.com')) {
        const link = document.createElement('a');
        link.className = 'service-card';
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.innerHTML = `<span class="number">Instagram</span><h3>${escapeHtml(item.caption || 'View this detail')}</h3><span class="arrow">Open post ↗</span>`;
        root.appendChild(link);
        return;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gallery-card';
      button.innerHTML = `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.caption || 'Vehicle detailing work by Fritz')}" loading="lazy"><span>${escapeHtml(item.caption || 'Detailing work')}</span>`;
      button.addEventListener('click', () => openLightbox(item, button));
      root.appendChild(button);
    });
  }

  let lightboxTrigger = null;
  let previousBodyOverflow = '';

  function getLightbox() {
    let box = document.querySelector('.lightbox');
    if (box) return box;
    box = document.createElement('div');
    box.className = 'lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Expanded gallery image');
    box.innerHTML = '<button type="button" aria-label="Close expanded image">×</button><img alt="">';
    box.addEventListener('click', event => {
      if (event.target === box || event.target.tagName === 'BUTTON') closeLightbox();
    });
    box.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeLightbox();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        box.querySelector('button').focus();
      }
    });
    document.body.appendChild(box);
    return box;
  }

  function openLightbox(item, trigger) {
    const box = getLightbox();
    lightboxTrigger = trigger;
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    box.querySelector('img').src = item.url;
    box.querySelector('img').alt = item.caption || 'Vehicle detailing work by Fritz';
    box.classList.add('open');
    box.querySelector('button').focus();
  }

  function closeLightbox() {
    const box = document.querySelector('.lightbox.open');
    if (!box) return;
    box.classList.remove('open');
    document.body.style.overflow = previousBodyOverflow;
    const trigger = lightboxTrigger;
    lightboxTrigger = null;
    trigger?.focus();
  }
})();

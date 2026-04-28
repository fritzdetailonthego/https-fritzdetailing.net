const fs = require('fs');
const path = require('path');

const DEFAULT_PRICES_DOLLARS = [
  25, 40, 50, 60, 75, 90, 100, 125, 140, 150,
  175, 180, 200, 275, 325, 350, 400, 1000, 1250, 1500
];

const DEFAULT_DURATION_BY_SERVICE = {
  'premium wash': 120,
  decontamination: 60,
  'paint correction': 180,
  wax: 60,
  'trim restoration': 60,
  'tire shine': 30,
  'headlight restoration': 60,
  'ceramic glass protection': 30,
  'engine bay clean': 60,
  'ceramic coat': 480,
  'interior clean': 120,
  'carpet shampoo': 60,
  'steam clean': 60,
  maintenance: 120,
  'the shiny package': 240,
  'wash, clay, seal': 120,
  'truck bed clean': 30
};

function loadPricing() {
  const filePath = path.join(__dirname, '..', 'public', 'pricing.json');

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function getDefaultDurationMinutes(name) {
  const key = String(name || '').trim().toLowerCase();
  return DEFAULT_DURATION_BY_SERVICE[key] || 120;
}

function readServiceValue(name, value) {
  if (typeof value === 'number') {
    return {
      price: value,
      durationMinutes: getDefaultDurationMinutes(name)
    };
  }

  if (value && typeof value === 'object') {
    const price = Number(value.price ?? value.amount);
    const durationMinutes = Number(value.durationMinutes ?? value.duration ?? value.minutes);

    return {
      price: Number.isFinite(price) && price > 0 ? price : 0,
      durationMinutes:
        Number.isInteger(durationMinutes) && durationMinutes > 0
          ? durationMinutes
          : getDefaultDurationMinutes(name)
    };
  }

  return {
    price: 0,
    durationMinutes: getDefaultDurationMinutes(name)
  };
}

function getServiceCatalog(pricing = loadPricing()) {
  if (!pricing || typeof pricing !== 'object') return [];

  const services = [];
  for (const [vehicleType, tier] of Object.entries(pricing)) {
    if (!tier || typeof tier !== 'object') continue;

    const vehicleLabel = typeof tier.label === 'string' && tier.label.trim()
      ? tier.label.trim()
      : vehicleType;

    for (const section of ['exterior', 'interior', 'packages']) {
      const items = tier[section];
      if (!items || typeof items !== 'object') continue;

      for (const [name, rawValue] of Object.entries(items)) {
        const service = readServiceValue(name, rawValue);
        if (!Number.isFinite(service.price) || service.price <= 0) continue;

        services.push({
          id: `${slugify(vehicleType)}:${section}:${slugify(name)}`,
          vehicleType,
          vehicleLabel,
          category: section,
          name,
          price: Math.round(service.price * 100) / 100,
          durationMinutes: service.durationMinutes
        });
      }
    }
  }

  return services;
}

function getCanonicalPrices() {
  const prices = new Set();
  for (const service of getServiceCatalog()) {
    prices.add(service.price);
  }

  return prices.size > 0 ? prices : new Set(DEFAULT_PRICES_DOLLARS);
}

function getValidPricesInDollars() {
  return getCanonicalPrices();
}

function getValidPricesInCents() {
  return new Set(Array.from(getCanonicalPrices(), (price) => Math.round(price * 100)));
}

function validateOrderServices(serviceIds) {
  const requestedIds = Array.isArray(serviceIds)
    ? serviceIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [];

  const uniqueRequestedIds = [...new Set(requestedIds)];
  if (uniqueRequestedIds.length === 0) {
    const error = new Error('Select at least one service.');
    error.statusCode = 400;
    throw error;
  }

  if (uniqueRequestedIds.length > 12) {
    const error = new Error('Too many services selected.');
    error.statusCode = 400;
    throw error;
  }

  const catalog = getServiceCatalog();
  const byId = new Map(catalog.map((service) => [service.id, service]));
  const services = uniqueRequestedIds.map((id) => byId.get(id));

  if (services.some((service) => !service)) {
    const error = new Error('One or more selected services are no longer available.');
    error.statusCode = 400;
    throw error;
  }

  const cleanServices = services.map((service) => ({
    id: service.id,
    vehicleType: service.vehicleType,
    vehicleLabel: service.vehicleLabel,
    category: service.category,
    name: service.name,
    price: service.price,
    durationMinutes: service.durationMinutes
  }));

  const subtotal = cleanServices.reduce((sum, service) => sum + service.price, 0);
  const durationMinutes = cleanServices.reduce((sum, service) => sum + service.durationMinutes, 0);

  return {
    services: cleanServices,
    subtotal: Math.round(subtotal * 100) / 100,
    durationMinutes,
    serviceSummary: cleanServices.map((service) => service.name).join(' + ')
  };
}

async function getValidPaymentAmountsInDollars() {
  return getValidPricesInDollars();
}

async function getValidPaymentAmountsInCents() {
  return getValidPricesInCents();
}

module.exports = {
  getDefaultDurationMinutes,
  getServiceCatalog,
  getValidPricesInCents,
  getValidPricesInDollars,
  getValidPaymentAmountsInCents,
  getValidPaymentAmountsInDollars,
  readServiceValue,
  validateOrderServices
};

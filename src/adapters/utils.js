(() => {
  const globalNS = (window.LimitraAdapters = window.LimitraAdapters || {});

  function cleanText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parsePrice(text) {
    if (typeof text === 'number' && Number.isFinite(text)) return text;
    const raw = String(text || '').trim();
    if (!raw) return null;
    const match = raw.replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
    if (!match) return null;
    const num = Number(match[1]);
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  function detectCurrency(text, hostname = '') {
    const raw = String(text || '').toUpperCase();
    if (raw.includes('₦') || raw.includes('NGN')) return 'NGN';
    if (raw.includes('£') || raw.includes('GBP')) return 'GBP';
    if (raw.includes('€') || raw.includes('EUR')) return 'EUR';
    if (raw.includes('CA$') || raw.includes('CAD')) return 'CAD';
    if (raw.includes('$') || raw.includes('USD')) return 'USD';

    const host = String(hostname || '').toLowerCase();
    if (host.endsWith('.co.uk')) return 'GBP';
    if (host.endsWith('.ca')) return 'CAD';
    if (host.endsWith('.de') || host.endsWith('.fr')) return 'EUR';
    return 'USD';
  }

  function parseWeightLb(text) {
    const raw = String(text || '').toLowerCase();
    if (!raw) return null;
    const lbMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:pounds?|lbs?)\b/);
    if (lbMatch) return Number(lbMatch[1]);
    const ozMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:ounces?|oz)\b/);
    if (ozMatch) return Number((Number(ozMatch[1]) / 16).toFixed(3));
    const kgMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:kilograms?|kgs?)\b/);
    if (kgMatch) return Number((Number(kgMatch[1]) * 2.20462).toFixed(3));
    const gMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:grams?|g)\b/);
    if (gMatch) return Number((Number(gMatch[1]) * 0.00220462).toFixed(3));
    return null;
  }

  function uniqueStrings(arr, limit = 12) {
    const seen = new Set();
    const out = [];
    for (const item of arr || []) {
      const val = String(item || '').trim();
      if (!val || !/^https?:\/\//i.test(val) || seen.has(val)) continue;
      seen.add(val);
      out.push(val);
      if (out.length >= limit) break;
    }
    return out;
  }

  function parseJsonSafe(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function extractJsonLdProducts(doc) {
    const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
    const products = [];
    for (const script of scripts) {
      const data = parseJsonSafe(script.textContent || '');
      if (!data) continue;
      const items = Array.isArray(data) ? data : data['@graph'] ? data['@graph'] : [data];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const type = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
        if (type.includes('Product') || type.includes('ProductGroup')) {
          products.push(item);
        }
      }
    }
    return products;
  }

  globalNS.utils = {
    cleanText,
    parsePrice,
    detectCurrency,
    parseWeightLb,
    uniqueStrings,
    parseJsonSafe,
    extractJsonLdProducts,
  };
})();


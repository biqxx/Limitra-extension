(() => {
  const globalNS = (window.LimitraAdapters = window.LimitraAdapters || {});
  const { cleanText, parsePrice, detectCurrency, uniqueStrings, parseJsonSafe, extractJsonLdProducts } =
    globalNS.utils;

  function extractItemId(url) {
    const match = String(url || '').match(/\/itm\/(?:[^/]+\/)?(\d{9,14})/i);
    return match ? match[1] : null;
  }

  function isProductPage(url) {
    return Boolean(extractItemId(url));
  }

  function findProductCards(doc = document) {
    const cards = Array.from(doc.querySelectorAll('li.s-item, li.s-card, .srp-results .s-item'));
    const out = [];
    for (const card of cards) {
      const link = card.querySelector('a.s-item__link[href*="/itm/"], a[href*="/itm/"]');
      const href = link?.getAttribute('href');
      const itemId = extractItemId(href);
      if (!itemId) continue;
      out.push({
        element: card,
        externalId: itemId,
        productUrl: href.split('?')[0],
        source: 'ebay',
      });
    }
    return out;
  }

  function extractEbayVariants(doc, currency, baseImages) {
    const variants = [];
    const scripts = Array.from(doc.querySelectorAll('script'));
    for (const s of scripts) {
      const text = s.textContent || '';
      if (!text.includes('variationMap') && !text.includes('itemVariationsMap')) continue;
      const m = text.match(/"(?:variationMap|itemVariationsMap)"\s*:\s*(\{[\s\S]*?\})\s*,\s*"/);
      const map = m ? parseJsonSafe(m[1]) : null;
      if (map && typeof map === 'object') {
        for (const [varId, entry] of Object.entries(map)) {
          if (!entry || typeof entry !== 'object') continue;
          const selected = entry.traitValuesMap || entry.attributes || {};
          const priceVal =
            parsePrice(entry.price?.value ?? entry.binModel?.price?.value ?? entry.convertedFromPrice?.value) ??
            null;
          const availQty = Number(entry.quantityAvailable ?? entry.availableQuantity ?? 0);
          variants.push({
            id: String(varId),
            sku: entry.sku || String(varId),
            label: Object.keys(selected).join(' / ') || 'Option',
            value: Object.values(selected).join(' / ') || String(varId),
            selected_options: selected,
            price: priceVal,
            original_price: parsePrice(entry.originalPrice?.value) ?? null,
            currency,
            available: availQty > 0 || entry.available !== false,
            stock: Number.isFinite(availQty) && availQty > 0 ? availQty : null,
            images: baseImages.slice(0, 1),
          });
        }
        if (variants.length > 0) return variants;
      }
    }

    // Fallback: JSON-LD offers array if present
    const ldProducts = extractJsonLdProducts(doc);
    for (const prod of ldProducts) {
      const offers = Array.isArray(prod.offers) ? prod.offers : [];
      for (const offer of offers) {
        if (!offer || typeof offer !== 'object') continue;
        const val = cleanText(offer.name || offer.sku || '');
        if (!val) continue;
        variants.push({
          id: offer.sku || val,
          sku: offer.sku || null,
          label: 'Option',
          value: val,
          selected_options: { Option: val },
          price: parsePrice(offer.price),
          original_price: null,
          currency: offer.priceCurrency || currency,
          available: !/OutOfStock/i.test(String(offer.availability || '')),
          stock: null,
          images: baseImages.slice(0, 1),
        });
      }
    }

    return variants;
  }

  function extractProduct(doc = document, pageUrl = window.location.href) {
    const itemId = extractItemId(pageUrl);
    if (!itemId) return null;

    const title = cleanText(
      doc.querySelector('h1.x-item-title__mainTitle span, h1#itemTitle')?.textContent
    );
    const priceText =
      doc.querySelector('.x-price-primary span.ux-textspans, #prcIsum')?.textContent || '';
    const originalPriceText =
      doc.querySelector('.x-price-was span.ux-textspans, #orgPrc')?.textContent || '';
    const currency = detectCurrency(priceText || originalPriceText, window.location.hostname);
    const price = parsePrice(priceText);
    const originalPrice = parsePrice(originalPriceText);

    const shippingText = cleanText(
      doc.querySelector('.ux-labels-values--shipping .ux-labels-values__values-content')?.textContent
    );
    const shippingPrice = /free/i.test(shippingText) ? 0 : parsePrice(shippingText);

    const specs = [];
    let brand = null;
    doc.querySelectorAll('.ux-labels-values--features .ux-labels-values__labels-content, .ux-layout-section--features dl').forEach((row) => {
      const name = cleanText(row.querySelector('.ux-labels-values__labels, dt')?.textContent).replace(/:$/, '');
      const value = cleanText(row.querySelector('.ux-labels-values__values, dd')?.textContent);
      if (name && value) {
        if (/^brand$/i.test(name) && !brand) brand = value;
        specs.push({ name, value });
      }
    });

    const imageCandidates = [];
    doc.querySelectorAll('.ux-image-carousel-item img, #icImg').forEach((img) => {
      const src = img.getAttribute('data-zoom-src') || img.getAttribute('src') || '';
      if (src) imageCandidates.push(src.replace(/s-l\d+/i, 's-l1600'));
    });
    const images = uniqueStrings(imageCandidates, 10);

    const categoryPath = Array.from(doc.querySelectorAll('.seo-breadcrumb-text span, nav.breadcrumbs a span'))
      .map((el) => cleanText(el.textContent))
      .filter(Boolean);

    const description =
      cleanText(doc.querySelector('meta[name="description"]')?.getAttribute('content')) || title;

    const variants = extractEbayVariants(doc, currency, images);

    return {
      source: 'ebay',
      external_product_id: itemId,
      product_url: `${window.location.origin}/itm/${itemId}`,
      title: title || `eBay Item ${itemId}`,
      brand,
      description,
      bullet_points: [],
      specifications: specs.slice(0, 12),
      price,
      original_price: originalPrice,
      currency,
      shipping_price: shippingPrice,
      weight_lb: null,
      available: !/ended|out of stock/i.test(doc.body?.textContent || ''),
      category: categoryPath[categoryPath.length - 1] || null,
      category_path: categoryPath,
      image_url: images[0] || '',
      images,
      variants,
    };
  }

  globalNS.ebay = {
    name: 'ebay',
    label: 'eBay',
    matchesHost: (host) => /(^|\.)ebay\.(com|co\.uk|ca|de)$/i.test(host),
    isProductPage,
    findProductCards,
    extractProduct,
  };
})();


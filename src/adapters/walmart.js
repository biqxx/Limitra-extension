(() => {
  const globalNS = (window.LimitraAdapters = window.LimitraAdapters || {});
  const { cleanText, parsePrice, detectCurrency, uniqueStrings, parseJsonSafe } = globalNS.utils;

  function resolveWalmartProductUrl(href, itemId) {
    if (href) {
      try {
        const parsed = new URL(href, window.location.origin);
        if (parsed.pathname.includes('/sp/track')) {
          const rd =
            parsed.searchParams.get('rd') ||
            parsed.searchParams.get('url') ||
            parsed.searchParams.get('adUrl');
          if (rd) {
            const decoded = decodeURIComponent(rd);
            if (decoded.includes('/ip/')) {
              return decoded.split('?')[0];
            }
          }
        }
        if (parsed.pathname.includes('/ip/')) {
          return `${parsed.origin}${parsed.pathname}`;
        }
      } catch {
        // fall back below
      }
    }
    return itemId ? `${window.location.origin}/ip/${itemId}` : null;
  }

  function extractItemId(url) {
    const raw = String(url || '');
    const match = raw.match(/\/ip\/(?:[^/?#]+\/)?(\d{5,15})/i);
    if (match) return match[1];
    try {
      const parsed = new URL(raw, window.location.origin);
      const rd = parsed.searchParams.get('rd') || parsed.searchParams.get('url');
      if (rd) {
        const inner = decodeURIComponent(rd).match(/\/ip\/(?:[^/?#]+\/)?(\d{5,15})/i);
        if (inner) return inner[1];
      }
    } catch {
      // ignore
    }
    return null;
  }

  function isProductPage(url) {
    return Boolean(extractItemId(url));
  }

  function findProductCards(doc = document) {
    const cards = Array.from(
      doc.querySelectorAll(
        '[data-item-id], [data-testid="list-view"] > div, [data-testid="item-stack"] > div, [data-dca-type="product-card"], div[role="group"]:has(a[href*="/ip/"]), div[role="group"]:has(a[href*="/sp/track"])'
      )
    );
    const out = [];
    const seenElements = new Set();

    for (const card of cards) {
      // Skip nested wrappers if an ancestor/descendant already owns this card
      if (seenElements.has(card)) continue;
      if (card.parentElement?.closest('[data-item-id]')) continue;

      const link = card.querySelector('a[href*="/ip/"], a[href*="/sp/track"], a[link-identifier]');
      const href = link?.getAttribute('href') || '';
      const itemId = card.getAttribute('data-item-id') || extractItemId(href);
      const productUrl = resolveWalmartProductUrl(href, itemId);
      if (!itemId || !productUrl) continue;

      seenElements.add(card);
      out.push({
        element: card,
        externalId: String(itemId),
        productUrl,
        source: 'walmart',
      });
    }
    return out;
  }

  function extractFromNextData(doc) {
    const script = doc.querySelector('script#__NEXT_DATA__');
    if (!script) return null;
    const json = parseJsonSafe(script.textContent || '');
    return json?.props?.pageProps?.initialData?.data?.product || null;
  }

  function extractProduct(doc = document, pageUrl = window.location.href) {
    const itemId = extractItemId(pageUrl);
    if (!itemId) return null;

    const productData = extractFromNextData(doc);
    if (productData) {
      const priceInfo = productData.priceInfo || {};
      const price = parsePrice(priceInfo.currentPrice?.price ?? priceInfo.currentPrice?.priceString);
      const originalPrice = parsePrice(priceInfo.wasPrice?.price ?? priceInfo.wasPrice?.priceString);
      const currency = priceInfo.currentPrice?.currencyUnit || 'USD';

      const images = uniqueStrings(
        (productData.imageInfo?.allImages || []).map((img) => img?.url),
        10
      );

      const variantsMap = productData.variantsMap || {};
      const variants = Object.values(variantsMap).map((v) => {
        const selected = {};
        (v.selectedVariants || []).forEach((sv) => {
          if (sv?.name && sv?.value) selected[sv.name] = sv.value;
        });
        return {
          id: String(v.usItemId || v.id || ''),
          sku: String(v.usItemId || v.id || ''),
          label: Object.keys(selected).join(' / ') || 'Option',
          value: Object.values(selected).join(' / ') || String(v.usItemId || ''),
          selected_options: selected,
          price: parsePrice(v.priceInfo?.currentPrice?.price) ?? price,
          original_price: parsePrice(v.priceInfo?.wasPrice?.price),
          currency,
          available: v.availabilityStatus !== 'OUT_OF_STOCK',
          stock: null,
          images: uniqueStrings((v.imageInfo?.allImages || []).map((i) => i?.url), 2),
        };
      });

      const specs = (productData.idml?.specifications || []).slice(0, 12).map((s) => ({
        name: cleanText(s.name),
        value: cleanText(s.value),
      }));

      const categoryPath = (productData.category?.path || []).map((c) => cleanText(c.name)).filter(Boolean);

      return {
        source: 'walmart',
        external_product_id: String(productData.usItemId || itemId),
        product_url: `${window.location.origin}/ip/${itemId}`,
        title: cleanText(productData.name) || `Walmart Product ${itemId}`,
        brand: cleanText(productData.brand) || null,
        description: cleanText(productData.shortDescription || productData.detailedDescription || ''),
        bullet_points: [],
        specifications: specs.filter((s) => s.name && s.value),
        price,
        original_price: originalPrice,
        currency,
        shipping_price: null,
        weight_lb: null,
        available: productData.availabilityStatus !== 'OUT_OF_STOCK',
        rating: productData.averageRating ? Number(productData.averageRating) : null,
        review_count: productData.numberOfReviews ? Number(productData.numberOfReviews) : null,
        category: categoryPath[categoryPath.length - 1] || null,
        category_path: categoryPath,
        image_url: images[0] || '',
        images,
        variants,
      };
    }

    // DOM fallback
    const title = cleanText(doc.querySelector('h1[itemprop="name"], h1')?.textContent);
    const priceText = doc.querySelector('[itemprop="price"], [data-testid="price-wrap"]')?.textContent || '';
    const currency = detectCurrency(priceText, window.location.hostname);
    const price = parsePrice(priceText);
    const images = uniqueStrings(
      Array.from(doc.querySelectorAll('[data-testid="media-thumbnail"] img, img[data-testid="hero-image"]')).map(
        (img) => img.getAttribute('src')
      ),
      10
    );

    return {
      source: 'walmart',
      external_product_id: itemId,
      product_url: `${window.location.origin}/ip/${itemId}`,
      title: title || `Walmart Product ${itemId}`,
      brand: null,
      description: cleanText(doc.querySelector('meta[name="description"]')?.getAttribute('content')),
      bullet_points: [],
      specifications: [],
      price,
      original_price: null,
      currency,
      shipping_price: null,
      weight_lb: null,
      available: true,
      category: null,
      category_path: [],
      image_url: images[0] || '',
      images,
      variants: [],
    };
  }

  globalNS.walmart = {
    name: 'walmart',
    label: 'Walmart',
    matchesHost: (host) => /(^|\.)walmart\.com$/i.test(host),
    isProductPage,
    findProductCards,
    extractProduct,
  };
})();


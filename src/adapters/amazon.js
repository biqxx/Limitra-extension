(() => {
  const globalNS = (window.LimitraAdapters = window.LimitraAdapters || {});
  const { cleanText, parsePrice, detectCurrency, parseWeightLb, uniqueStrings, parseJsonSafe } =
    globalNS.utils;

  function extractAsin(url) {
    const match = String(url || '').match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
    return match ? match[1].toUpperCase() : null;
  }

  function isProductPage(url) {
    return Boolean(extractAsin(url));
  }

  function findProductCards(doc = document) {
    const cards = Array.from(
      doc.querySelectorAll('[data-component-type="s-search-result"][data-asin], .s-result-item[data-asin]')
    );
    const out = [];
    for (const card of cards) {
      const asin = card.getAttribute('data-asin')?.trim();
      if (!asin || asin.length !== 10) continue;
      const link = card.querySelector('h2 a, a.a-link-normal[href*="/dp/"]');
      const href = link?.getAttribute('href');
      const productUrl = href
        ? new URL(href, window.location.origin).toString()
        : `${window.location.origin}/dp/${asin}`;
      out.push({
        element: card,
        externalId: asin,
        productUrl,
        source: 'amazon',
      });
    }
    return out;
  }

  function dedupeAmazonImages(urls, limit = 10) {
    const seen = new Set();
    const out = [];
    for (const rawUrl of uniqueStrings(urls, 40)) {
      const normalized = rawUrl.replace(/\._[A-Z0-9_,]+_\./i, '._AC_SL1500_.');
      const baseKey = normalized.replace(/\._[A-Z0-9_,]+_\./i, '.');
      if (seen.has(baseKey)) continue;
      seen.add(baseKey);
      out.push(normalized);
      if (out.length >= limit) break;
    }
    return out;
  }

  function extractBalancedJson(text, keyPattern) {
    const match = text.match(keyPattern);
    if (!match) return null;
    const start = text.indexOf('{', match.index);
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let quoteChar = '';
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (inString) {
        if (ch === quoteChar) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        quoteChar = ch;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const raw = text.slice(start, i + 1);
          const direct = parseJsonSafe(raw);
          if (direct) return direct;
          // Convert single-quoted JS keys/values carefully only when JSON.parse fails
          const normalized = raw
            .replace(/([{,]\s*)'([^']+?)'\s*:/g, '$1"$2":')
            .replace(/:\s*'([^']*?)'(\s*[,}])/g, ':"$1"$2');
          return parseJsonSafe(normalized);
        }
      }
    }
    return null;
  }

  function extractTwisterVariants(doc, basePrice, currency, baseImages) {
    const scripts = Array.from(doc.querySelectorAll('script'));
    let dimensionValues = null;
    let asinVariationValues = null;
    let variationDisplayLabels = null;
    let colorImages = null;

    for (const s of scripts) {
      const text = s.textContent || '';
      if (!text.includes('dimensionValuesDisplayData') && !text.includes('colorImages')) continue;

      if (!dimensionValues && text.includes('dimensionValuesDisplayData')) {
        dimensionValues = extractBalancedJson(text, /"dimensionValuesDisplayData"\s*:/);
      }
      if (!asinVariationValues && text.includes('asinVariationValues')) {
        asinVariationValues = extractBalancedJson(text, /"asinVariationValues"\s*:/);
      }
      if (!variationDisplayLabels && text.includes('variationDisplayLabels')) {
        variationDisplayLabels = extractBalancedJson(text, /"variationDisplayLabels"\s*:/);
      }
      if (!colorImages && text.includes('colorImages')) {
        colorImages = extractBalancedJson(text, /['"]colorImages['"]\s*:/);
      }
    }

    // Fallback DOM map of color swatch thumbnails
    const swatchColorMap = {};
    doc.querySelectorAll('#variation_color_name li, #twister [id*="color"] li').forEach((li) => {
      const img = li.querySelector('img');
      const colorName = cleanText(
        img?.getAttribute('alt') ||
          li.getAttribute('title')?.replace(/^Click to select\s+/i, '') ||
          ''
      );
      const src = img?.getAttribute('src') || '';
      if (colorName && src && !/transparent-pixel/i.test(src)) {
        swatchColorMap[colorName.toLowerCase()] = dedupeAmazonImages([src], 1);
      }
    });

    const variants = [];
    const dimKeys = variationDisplayLabels ? Object.keys(variationDisplayLabels) : [];
    const dimNames = dimKeys.map((k) => variationDisplayLabels[k] || k);

    if (dimensionValues && typeof dimensionValues === 'object') {
      for (const [asin, values] of Object.entries(dimensionValues)) {
        if (!Array.isArray(values)) continue;
        const selectedOptions = {};
        values.forEach((val, idx) => {
          const key = dimNames[idx] || `Option ${idx + 1}`;
          selectedOptions[key] = cleanText(val);
        });

        const colorVal = selectedOptions.Color || selectedOptions.Colour || values[0];
        let variantImgs = [];
        if (colorImages && colorVal) {
          const exact = colorImages[colorVal];
          const ciKey = exact
            ? colorVal
            : Object.keys(colorImages).find((k) => k.toLowerCase() === String(colorVal).toLowerCase());
          if (ciKey && Array.isArray(colorImages[ciKey])) {
            variantImgs = dedupeAmazonImages(
              colorImages[ciKey].map((x) => x.hiRes || x.large || x.thumb),
              5
            );
          }
        }
        if (variantImgs.length === 0 && colorVal) {
          variantImgs = swatchColorMap[String(colorVal).toLowerCase()] || [];
        }

        variants.push({
          id: asin,
          sku: asin,
          label: Object.keys(selectedOptions).join(' / ') || 'Variant',
          value: Object.values(selectedOptions).join(' / '),
          selected_options: selectedOptions,
          price: asin === extractAsin(doc.location?.href || '') ? basePrice : null,
          original_price: null,
          currency,
          available: true,
          stock: null,
          images: variantImgs.length ? variantImgs : baseImages.slice(0, 1),
          needs_price_fetch: asin !== extractAsin(doc.location?.href || ''),
        });
      }
    }

    if (variants.length === 0) {
      // Fallback: inspect DOM swatch / dropdown options
      const swatchGroups = Array.from(doc.querySelectorAll('#twister [id^="variation_"]'));
      for (const grp of swatchGroups) {
        const label = cleanText(grp.querySelector('.a-form-label')?.textContent || 'Option').replace(/:$/, '');
        const items = Array.from(grp.querySelectorAll('li[data-defaultasin], option[value]'));
        for (const item of items) {
          const asin =
            item.getAttribute('data-defaultasin') ||
            (item.getAttribute('value') || '').split(',')[1] ||
            null;
          const val = cleanText(
            item.getAttribute('title')?.replace(/^Click to select\s+/i, '') ||
              item.textContent
          );
          if (!val || /select/i.test(val)) continue;
          const itemPriceText = item.querySelector('.a-price .a-offscreen, .twisterSwatchPrice')?.textContent;
          variants.push({
            id: asin || `${label}-${val}`,
            sku: asin || null,
            label,
            value: val,
            selected_options: { [label]: val },
            price: parsePrice(itemPriceText) ?? null,
            original_price: null,
            currency,
            available: !item.classList.contains('swatchUnavailable'),
            stock: null,
            images: [],
            needs_price_fetch: Boolean(asin && !parsePrice(itemPriceText)),
          });
        }
      }
    }

    return variants;
  }

  function extractAmazonPrice(doc, hostname) {
    const selectors = [
      '#corePriceDisplay_desktop_feature_div .a-price.priceToPay .a-offscreen',
      '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
      '#corePrice_feature_div .a-price.priceToPay .a-offscreen',
      '#corePrice_feature_div .a-price .a-offscreen',
      '.a-price.apexPriceToPay .a-offscreen',
      '#tp_price_block_total_price_ww .a-offscreen',
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      '#priceblock_saleprice',
      '#price_inside_buybox',
      '#newBuyBoxPrice',
      '.a-price .a-offscreen',
    ];

    for (const sel of selectors) {
      const txt = doc.querySelector(sel)?.textContent;
      const parsed = parsePrice(txt);
      if (parsed) {
        return { price: parsed, currency: detectCurrency(txt, hostname) };
      }
    }

    // Fallback: whole + fraction spans
    const whole = cleanText(
      doc.querySelector('#corePriceDisplay_desktop_feature_div .a-price-whole, #corePrice_feature_div .a-price-whole, .a-price-whole')?.textContent
    ).replace(/[^\d]/g, '');
    const frac = cleanText(
      doc.querySelector('#corePriceDisplay_desktop_feature_div .a-price-fraction, #corePrice_feature_div .a-price-fraction, .a-price-fraction')?.textContent
    ).replace(/[^\d]/g, '');
    if (whole) {
      const combined = Number(`${whole}.${frac || '00'}`);
      if (Number.isFinite(combined) && combined > 0) {
        const sym = cleanText(doc.querySelector('.a-price-symbol')?.textContent);
        return { price: combined, currency: detectCurrency(sym, hostname) };
      }
    }

    // Fallback: embedded Amazon JSON price fields in script tags
    const scripts = Array.from(doc.querySelectorAll('script'));
    for (const s of scripts) {
      const text = s.textContent || '';
      if (!text.includes('priceAmount') && !text.includes('buyingPrice')) continue;
      const m = text.match(/"(?:priceAmount|buyingPrice)"\s*:\s*"?(\d+(?:\.\d{1,2})?)"?/);
      if (m) {
        const val = Number(m[1]);
        if (Number.isFinite(val) && val > 0) {
          return { price: val, currency: detectCurrency('', hostname) };
        }
      }
    }

    return { price: null, currency: detectCurrency('', hostname) };
  }

  function extractProduct(doc = document, pageUrl = window.location.href) {
    const asin =
      extractAsin(pageUrl) ||
      doc.querySelector('#ASIN')?.value ||
      doc.querySelector('[data-asin]')?.getAttribute('data-asin');
    if (!asin) return null;

    const title = cleanText(doc.querySelector('#productTitle, #title')?.textContent);
    const brand = cleanText(
      doc.querySelector('#bylineInfo')?.textContent?.replace(/^(Visit the|Brand:)\s*/i, '').replace(/\s*Store$/i, '')
    );

    const { price, currency } = extractAmazonPrice(doc, window.location.hostname);
    const originalPriceText =
      doc.querySelector('#corePriceDisplay_desktop_feature_div [data-a-strike="true"] .a-offscreen')?.textContent ||
      doc.querySelector('.basisPrice .a-offscreen')?.textContent ||
      '';
    const originalPrice = parsePrice(originalPriceText);

    const shippingText = cleanText(
      doc.querySelector('#mir-layout-DELIVERY_BLOCK, #deliveryBlockMessage')?.textContent
    );
    const shippingPrice = /free/i.test(shippingText) ? 0 : parsePrice(shippingText);

    const bullets = Array.from(doc.querySelectorAll('#feature-bullets li span.a-list-item'))
      .map((el) => cleanText(el.textContent))
      .filter((t) => t && !/make sure this fits/i.test(t));

    const description =
      cleanText(doc.querySelector('#productDescription p, #productDescription')?.textContent) ||
      bullets.join(' ');

    const specs = [];
    const specRows = Array.from(
      doc.querySelectorAll('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #detailBullets_feature_div li')
    );
    let weightLb = null;
    for (const row of specRows) {
      const th = row.querySelector('th, .a-text-bold');
      const td = row.querySelector('td, span:not(.a-text-bold)');
      const name = cleanText(th?.textContent).replace(/[:\u200F\u200E]/g, '');
      const value = cleanText(td?.textContent).replace(/[\u200F\u200E]/g, '');
      if (!name || !value || name.length > 80) continue;
      if (/weight/i.test(name) && !weightLb) {
        weightLb = parseWeightLb(value);
      }
      if (!/customer reviews|best sellers rank|asin/i.test(name)) {
        specs.push({ name, value });
      }
    }

    const imageCandidates = [];
    const mainImg = doc.querySelector('#landingImage, #imgBlkFront');
    if (mainImg) {
      let bestMain = mainImg.getAttribute('data-old-hires');
      if (!bestMain) {
        const dynRaw = mainImg.getAttribute('data-a-dynamic-image');
        const dynObj = dynRaw ? parseJsonSafe(dynRaw) : null;
        if (dynObj && typeof dynObj === 'object') {
          bestMain = Object.entries(dynObj).sort(
            (a, b) => ((b[1]?.[0] || 0) * (b[1]?.[1] || 0)) - ((a[1]?.[0] || 0) * (a[1]?.[1] || 0))
          )[0]?.[0];
        }
      }
      if (bestMain || mainImg.getAttribute('src')) {
        imageCandidates.push(bestMain || mainImg.getAttribute('src'));
      }
    }

    // Prefer embedded hi-res gallery JSON (ImageBlockATF / colorImages)
    const imgScripts = Array.from(doc.querySelectorAll('script'));
    for (const s of imgScripts) {
      const text = s.textContent || '';
      if (!text.includes('colorImages')) continue;
      const hiResMatches = text.matchAll(/"hiRes"\s*:\s*"(https:[^"]+)"/g);
      for (const m of hiResMatches) imageCandidates.push(m[1]);
      const largeMatches = text.matchAll(/"large"\s*:\s*"(https:[^"]+)"/g);
      for (const m of largeMatches) imageCandidates.push(m[1]);
    }

    doc.querySelectorAll('#altImages li.imageThumbnail img, #altImages img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (src && !/play-icon|360|overlay|transparent-pixel/i.test(src)) {
        imageCandidates.push(src.replace(/\._[A-Z0-9_,]+_\./i, '._AC_SL1500_.'));
      }
    });

    // Deduplicate by Amazon base image ID (ignoring size/crop suffixes like ._AC_SX425_.)
    const seenBaseIds = new Set();
    const images = [];
    for (const rawUrl of uniqueStrings(imageCandidates, 40)) {
      const normalized = rawUrl.replace(/\._[A-Z0-9_,]+_\./i, '._AC_SL1500_.');
      const baseKey = normalized.replace(/\._[A-Z0-9_,]+_\./i, '.');
      if (seenBaseIds.has(baseKey)) continue;
      seenBaseIds.add(baseKey);
      images.push(normalized);
      if (images.length >= 10) break;
    }

    const categoryPath = Array.from(doc.querySelectorAll('#wayfinding-breadcrumbs_feature_div a'))
      .map((a) => cleanText(a.textContent))
      .filter(Boolean);

    const availText = cleanText(doc.querySelector('#availability')?.textContent);
    const available = !/currently unavailable|out of stock/i.test(availText);

    const ratingText = cleanText(doc.querySelector('#acrPopover')?.getAttribute('title') || '');
    const ratingMatch = ratingText.match(/([\d.]+)\s*out of/i);
    const reviewText = cleanText(doc.querySelector('#acrCustomerReviewText')?.textContent || '');
    const reviewMatch = reviewText.replace(/,/g, '').match(/(\d+)/);

    const variants = extractTwisterVariants(doc, price, currency, images);

    return {
      source: 'amazon',
      external_product_id: asin,
      product_url: `${window.location.origin}/dp/${asin}`,
      title: title || `Amazon Product ${asin}`,
      brand: brand || null,
      description,
      bullet_points: bullets,
      specifications: specs.slice(0, 12),
      price,
      original_price: originalPrice,
      currency,
      shipping_price: shippingPrice,
      weight_lb: weightLb,
      available,
      rating: ratingMatch ? Number(ratingMatch[1]) : null,
      review_count: reviewMatch ? Number(reviewMatch[1]) : null,
      category: categoryPath[categoryPath.length - 1] || null,
      category_path: categoryPath,
      image_url: images[0] || '',
      images,
      variants,
    };
  }

  globalNS.amazon = {
    name: 'amazon',
    label: 'Amazon',
    matchesHost: (host) => /(^|\.)amazon\.(com|co\.uk|ca|de|fr)$/i.test(host),
    isProductPage,
    findProductCards,
    extractProduct,
  };
})();


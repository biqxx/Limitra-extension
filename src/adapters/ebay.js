(() => {
  const globalNS = (window.LimitraAdapters = window.LimitraAdapters || {});
  const {
    cleanText,
    parsePrice,
    detectCurrency,
    uniqueStrings,
    parseJsonSafe,
    extractBalancedJson,
    extractJsonLdProducts,
  } = globalNS.utils;

  function extractItemId(url) {
    const match = String(url || '').match(/\/itm\/(?:[^/?#]+\/)?(\d{9,15})/i);
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

  function normalizeEbayImageUrl(url) {
    const raw = String(url || '').trim();
    if (!raw || !/^https?:\/\//i.test(raw)) return '';
    return raw.replace(/s-l\d+/i, 's-l1600');
  }

  function extractEbayText(node) {
    if (!node) return '';
    if (typeof node === 'string' || typeof node === 'number') return cleanText(node);
    if (typeof node === 'object') {
      if (node.displayName) return cleanText(node.displayName);
      if (node.valueName) return cleanText(node.valueName);
      if (node.name) return cleanText(node.name);
      if (node.label) return cleanText(node.label);
      if (node.text) return cleanText(node.text);
      if (node.value && (typeof node.value === 'string' || typeof node.value === 'number')) {
        return cleanText(node.value);
      }
      if (Array.isArray(node.textSpans) && node.textSpans.length > 0) {
        return cleanText(node.textSpans.map((s) => s?.text || '').join(' '));
      }
    }
    return '';
  }

  function extractEbayMoney(node) {
    if (node == null) return null;
    if (typeof node === 'number' || typeof node === 'string') {
      return parsePrice(node);
    }
    if (typeof node === 'object') {
      const candidates = [
        node.value?.value,
        node.value,
        node.amount?.value,
        node.amount,
        node.convertedFromValue?.value,
        node.convertedFromValue,
        node.displayPrice,
        node.formattedValue,
        Array.isArray(node.textSpans) ? node.textSpans.map((t) => t?.text || '').join(' ') : null,
      ];
      for (const c of candidates) {
        if (c != null && typeof c !== 'object') {
          const parsed = parsePrice(c);
          if (parsed != null) return parsed;
        }
      }
    }
    return null;
  }

  function extractOptionImage(menuItem) {
    if (!menuItem || typeof menuItem !== 'object') return '';
    const candidate =
      menuItem.pictureUrl ||
      menuItem.thumbnailUrl ||
      menuItem.imageUrl ||
      menuItem.image?.URL ||
      menuItem.image?.url ||
      menuItem.picture?.url ||
      menuItem.picture?.URL ||
      (Array.isArray(menuItem.pictures) && (menuItem.pictures[0]?.url || menuItem.pictures[0]?.URL)) ||
      '';
    return normalizeEbayImageUrl(candidate);
  }

  function parseMskuFromScripts(doc) {
    const scripts = Array.from(doc.querySelectorAll('script'));
    let variationMap = null;
    let menuModels = null;
    let menuItemMap = null;

    for (const s of scripts) {
      let text = s.textContent || '';
      if (
        !text.includes('itemVariationsMap') &&
        !text.includes('variationMap') &&
        !text.includes('menuItemMap') &&
        !text.includes('menuModels')
      ) {
        continue;
      }

      if (
        (text.includes('\\"itemVariationsMap\\"') || text.includes('\\"menuItemMap\\"')) &&
        !text.includes('"itemVariationsMap"')
      ) {
        text = text.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }

      if (!variationMap && (text.includes('itemVariationsMap') || text.includes('variationMap'))) {
        variationMap =
          extractBalancedJson(text, /"itemVariationsMap"\s*:/) ||
          extractBalancedJson(text, /"variationMap"\s*:/);
      }

      if (!menuModels && (text.includes('menuModels') || text.includes('selectMenus'))) {
        menuModels =
          extractBalancedJson(text, /"menuModels"\s*:/) ||
          extractBalancedJson(text, /"selectMenus"\s*:/);
      }

      if (!menuItemMap && text.includes('menuItemMap')) {
        menuItemMap = extractBalancedJson(text, /"menuItemMap"\s*:/);
      }

      if (variationMap && menuModels && menuItemMap) break;
    }

    return { variationMap, menuModels, menuItemMap };
  }

  function buildMskuLookups(menuModels, menuItemMap) {
    const menusList = Array.isArray(menuModels)
      ? menuModels
      : menuModels && typeof menuModels === 'object'
        ? Object.values(menuModels)
        : [];
    const itemsObj = menuItemMap && typeof menuItemMap === 'object' ? menuItemMap : {};

    const menuLabelByIndex = {};
    const menuLabelByValueId = {};

    menusList.forEach((menu, idx) => {
      if (!menu || typeof menu !== 'object') return;
      const label =
        extractEbayText(menu.displayName) ||
        extractEbayText(menu.name) ||
        extractEbayText(menu.label) ||
        `Option ${idx + 1}`;
      menuLabelByIndex[String(idx)] = label;
      if (menu.id != null) menuLabelByIndex[String(menu.id)] = label;
      if (menu.menuId != null) menuLabelByIndex[String(menu.menuId)] = label;
      if (menu.name) menuLabelByIndex[String(menu.name)] = label;

      const valueIds =
        menu.menuItemValueIds ||
        menu.valueIds ||
        (Array.isArray(menu.menuItems) ? menu.menuItems.map((mi) => mi?.valueId ?? mi?.id) : []);
      if (Array.isArray(valueIds)) {
        for (const vid of valueIds) {
          if (vid != null) menuLabelByValueId[String(vid)] = label;
        }
      }

      if (Array.isArray(menu.menuItems)) {
        for (const mi of menu.menuItems) {
          const vid = mi?.valueId ?? mi?.id;
          if (vid != null && !itemsObj[String(vid)]) {
            itemsObj[String(vid)] = mi;
          }
        }
      }
    });

    return { menusList, itemsObj, menuLabelByIndex, menuLabelByValueId };
  }

  function extractDomEbayVariants(doc, currency, baseImages, basePrice) {
    const dimensions = [];
    const seenLabels = new Set();

    const containers = Array.from(
      doc.querySelectorAll(
        '.x-msku__box-cont, [data-testid="x-msku"] .x-msku__box-cont, .vim.x-msku .x-msku__box-cont, .x-msku-evo .x-msku__box-cont'
      )
    );

    for (const box of containers) {
      const rawLabel = cleanText(
        box.querySelector(
          '.x-msku__label-text, .x-msku__label, .listbox-button__label, label, .form-label'
        )?.textContent || ''
      )
        .replace(/[:*]+$/, '')
        .replace(/^Select\s+/i, '')
        .trim();
      const label = rawLabel || `Option ${dimensions.length + 1}`;
      const options = [];
      const seenValues = new Set();

      const optionEls = Array.from(
        box.querySelectorAll(
          '[role="listbox"] [role="option"], .listbox__options [role="option"], .listbox__option, select option, .x-msku__swatch-list button'
        )
      );

      for (const optEl of optionEls) {
        const valAttr = optEl.getAttribute('value');
        if (valAttr === '-1') continue;

        const rawText = cleanText(
          optEl.querySelector('.listbox__value, span')?.textContent ||
            optEl.getAttribute('aria-label') ||
            optEl.getAttribute('title') ||
            optEl.textContent ||
            ''
        );
        if (!rawText || /^(-?\s*select\s*-?|choose\b|please select)/i.test(rawText)) continue;

        const isOutOfStock =
          optEl.getAttribute('aria-disabled') === 'true' ||
          optEl.hasAttribute('disabled') ||
          optEl.classList.contains('listbox__option--disabled') ||
          /out of stock|sold out|unavailable/i.test(rawText);

        const cleanVal = cleanText(
          rawText
            .replace(/\(?\s*(?:out of stock|sold out|unavailable)\s*\)?/gi, '')
            .replace(/\[?\s*(?:out of stock|sold out|unavailable)\s*\]?/gi, '')
        );
        if (!cleanVal || /^(-?\s*select\s*-?)$/i.test(cleanVal) || seenValues.has(cleanVal.toLowerCase())) {
          continue;
        }
        seenValues.add(cleanVal.toLowerCase());

        const imgEl = optEl.querySelector('img');
        const imgUrl = normalizeEbayImageUrl(
          imgEl?.getAttribute('data-zoom-src') || imgEl?.getAttribute('src') || ''
        );

        options.push({
          value: cleanVal,
          available: !isOutOfStock,
          image: imgUrl,
        });
      }

      if (options.length > 0 && !seenLabels.has(label.toLowerCase())) {
        seenLabels.add(label.toLowerCase());
        dimensions.push({ label, options });
      }
    }

    if (dimensions.length === 0) {
      const selects = Array.from(
        doc.querySelectorAll('select.x-msku__select-box, select[id^="msku-sel"], select.msku-sel')
      );
      for (const sel of selects) {
        const wrapper = sel.closest('.x-msku__box-cont, .msku-sel, div') || sel.parentElement;
        const label =
          cleanText(
            sel.getAttribute('aria-label') ||
              wrapper?.querySelector('label, .x-msku__label-text')?.textContent ||
              `Option ${dimensions.length + 1}`
          )
            .replace(/[:*]+$/, '')
            .replace(/^Select\s+/i, '')
            .trim() || `Option ${dimensions.length + 1}`;

        const options = [];
        const seenValues = new Set();
        for (const opt of Array.from(sel.querySelectorAll('option'))) {
          if (opt.value === '-1' || opt.value === '') continue;
          const rawText = cleanText(opt.textContent);
          if (!rawText || /^(-?\s*select\s*-?|choose\b)/i.test(rawText)) continue;

          const isOutOfStock =
            opt.disabled || /out of stock|sold out|unavailable/i.test(rawText);
          const cleanVal = cleanText(
            rawText
              .replace(/\(?\s*(?:out of stock|sold out|unavailable)\s*\)?/gi, '')
              .replace(/\[?\s*(?:out of stock|sold out|unavailable)\s*\]?/gi, '')
          );
          if (!cleanVal || seenValues.has(cleanVal.toLowerCase())) continue;
          seenValues.add(cleanVal.toLowerCase());

          options.push({
            value: cleanVal,
            available: !isOutOfStock,
            image: '',
          });
        }

        if (options.length > 0 && !seenLabels.has(label.toLowerCase())) {
          seenLabels.add(label.toLowerCase());
          dimensions.push({ label, options });
        }
      }
    }

    if (dimensions.length === 0) return [];

    const MAX_VARIANTS = 60;
    let combos = [{ selected: {}, available: true, images: [] }];

    for (const dim of dimensions) {
      const next = [];
      for (const prefix of combos) {
        for (const opt of dim.options) {
          next.push({
            selected: { ...prefix.selected, [dim.label]: opt.value },
            available: prefix.available && opt.available,
            images: opt.image ? [opt.image, ...prefix.images] : prefix.images,
          });
          if (next.length >= MAX_VARIANTS) break;
        }
        if (next.length >= MAX_VARIANTS) break;
      }
      combos = next;
    }

    return combos.map((c, idx) => {
      const labelStr = Object.keys(c.selected).join(' / ') || 'Option';
      const valStr = Object.values(c.selected).join(' / ') || `Variant ${idx + 1}`;
      const slug = valStr.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return {
        id: slug || `var-${idx + 1}`,
        sku: slug || `var-${idx + 1}`,
        label: labelStr,
        value: valStr,
        selected_options: c.selected,
        price: basePrice ?? null,
        original_price: null,
        currency,
        available: c.available,
        stock: null,
        images: c.images.length > 0 ? uniqueStrings(c.images, 3) : baseImages.slice(0, 1),
      };
    });
  }

  function extractEbayVariants(doc, currency, baseImages, basePrice = null) {
    const variants = [];
    const { variationMap, menuModels, menuItemMap } = parseMskuFromScripts(doc);
    const { menusList, itemsObj, menuLabelByIndex, menuLabelByValueId } = buildMskuLookups(
      menuModels,
      menuItemMap
    );

    if (variationMap && typeof variationMap === 'object') {
      for (const [varId, entry] of Object.entries(variationMap)) {
        if (!entry || typeof entry !== 'object') continue;
        const rawTraits =
          entry.traitValuesMap || entry.attributes || entry.variationAspects || {};
        const selected = {};
        const variantImages = [];

        for (const [rawKey, rawVal] of Object.entries(rawTraits)) {
          const valKey = String(rawVal);
          const menuItem = itemsObj[valKey];
          const resolvedLabel =
            menuLabelByValueId[valKey] ||
            menuLabelByIndex[String(rawKey)] ||
            (!/^\d+$/.test(String(rawKey)) ? cleanText(rawKey) : `Option ${Number(rawKey) + 1}`);
          const resolvedValue = menuItem
            ? extractEbayText(menuItem) || valKey
            : cleanText(extractEbayText(rawVal) || valKey);

          if (resolvedLabel && resolvedValue) {
            selected[resolvedLabel] = resolvedValue;
          }

          const optImg = extractOptionImage(menuItem);
          if (optImg) variantImages.push(optImg);
        }

        const entryImg = normalizeEbayImageUrl(
          entry.pictureUrl || entry.imageUrl || entry.image?.URL || entry.image?.url || ''
        );
        if (entryImg) variantImages.unshift(entryImg);

        const priceVal =
          extractEbayMoney(entry.price) ??
          extractEbayMoney(entry.binModel?.price) ??
          extractEbayMoney(entry.binModel?.price?.price) ??
          extractEbayMoney(entry.convertedFromPrice) ??
          extractEbayMoney(entry.binModel?.convertedPrice) ??
          basePrice ??
          null;

        const origPriceVal =
          extractEbayMoney(entry.originalPrice) ??
          extractEbayMoney(entry.strikethroughPrice) ??
          extractEbayMoney(entry.binModel?.originalPrice) ??
          extractEbayMoney(entry.binModel?.strikethroughPrice) ??
          null;

        const rawQty =
          entry.quantityAvailable ?? entry.availableQuantity ?? entry.qtyAvailable ?? null;
        const availQty = rawQty != null ? Number(rawQty) : null;
        const isUnavail =
          entry.outOfStock === true ||
          entry.soldOut === true ||
          entry.isUnavailable === true ||
          entry.available === false ||
          entry.inStock === false ||
          (availQty != null && Number.isFinite(availQty) && availQty <= 0 && entry.inStock !== true);

        const optionValues = Object.values(selected);
        if (optionValues.length === 0 && !priceVal) continue;

        variants.push({
          id: String(entry.variationId || varId),
          sku: String(entry.sku || entry.variationId || varId),
          label: Object.keys(selected).join(' / ') || 'Option',
          value: optionValues.join(' / ') || String(varId),
          selected_options: selected,
          price: priceVal,
          original_price: origPriceVal,
          currency,
          available: !isUnavail,
          stock: availQty != null && Number.isFinite(availQty) && availQty > 0 ? availQty : null,
          images:
            variantImages.length > 0
              ? uniqueStrings(variantImages, 3)
              : baseImages.slice(0, 1),
        });
      }
      if (variants.length > 0) return variants;
    }

    if (Object.keys(itemsObj).length > 0) {
      const byVarId = new Map();
      for (const [valId, item] of Object.entries(itemsObj)) {
        if (!item || typeof item !== 'object') continue;
        const valText = extractEbayText(item);
        if (!valText) continue;
        const label = menuLabelByValueId[String(valId)] || 'Option';
        const img = extractOptionImage(item);
        const isOut =
          item.outOfStock === true ||
          item.unavailable === true ||
          item.Unavailable === true ||
          item.disabled === true;
        const matchingIds = Array.isArray(item.matchingVariationIds)
          ? item.matchingVariationIds
          : [];

        if (matchingIds.length > 0 && menusList.length <= 1) {
          const vid = String(matchingIds[0]);
          byVarId.set(vid, {
            id: vid,
            selected: { [label]: valText },
            available: !isOut,
            images: img ? [img] : [],
          });
        } else if (matchingIds.length > 0) {
          for (const rawVid of matchingIds) {
            const vid = String(rawVid);
            const existing = byVarId.get(vid) || {
              id: vid,
              selected: {},
              available: true,
              images: [],
            };
            existing.selected[label] = valText;
            if (isOut) existing.available = false;
            if (img) existing.images.push(img);
            byVarId.set(vid, existing);
          }
        }
      }

      const expectedDimCount = menusList.length || 1;
      for (const entry of byVarId.values()) {
        if (Object.keys(entry.selected).length < expectedDimCount) continue;
        variants.push({
          id: entry.id,
          sku: entry.id,
          label: Object.keys(entry.selected).join(' / ') || 'Option',
          value: Object.values(entry.selected).join(' / '),
          selected_options: entry.selected,
          price: basePrice ?? null,
          original_price: null,
          currency,
          available: entry.available,
          stock: null,
          images:
            entry.images.length > 0 ? uniqueStrings(entry.images, 3) : baseImages.slice(0, 1),
        });
      }
      if (variants.length > 0) return variants;
    }

    const domVariants = extractDomEbayVariants(doc, currency, baseImages, basePrice);
    if (domVariants.length > 0) return domVariants;

    const ldProducts = extractJsonLdProducts(doc);
    for (const prod of ldProducts) {
      const hasVariants = Array.isArray(prod.hasVariant) ? prod.hasVariant : [];
      for (const hv of hasVariants) {
        if (!hv || typeof hv !== 'object') continue;
        const val = cleanText(hv.name || hv.sku || '');
        if (!val) continue;
        const offer = Array.isArray(hv.offers) ? hv.offers[0] : hv.offers;
        variants.push({
          id: String(hv.sku || val),
          sku: hv.sku ? String(hv.sku) : null,
          label: 'Option',
          value: val,
          selected_options: { Option: val },
          price: parsePrice(offer?.price) ?? basePrice ?? null,
          original_price: null,
          currency: offer?.priceCurrency || currency,
          available: !/OutOfStock/i.test(String(offer?.availability || '')),
          stock: null,
          images: hv.image
            ? uniqueStrings(Array.isArray(hv.image) ? hv.image : [hv.image], 2)
            : baseImages.slice(0, 1),
        });
      }

      const rawOffers = Array.isArray(prod.offers)
        ? prod.offers
        : Array.isArray(prod.offers?.offers)
          ? prod.offers.offers
          : [];
      for (const offer of rawOffers) {
        if (!offer || typeof offer !== 'object') continue;
        const val = cleanText(offer.name || offer.sku || '');
        if (!val) continue;
        variants.push({
          id: String(offer.sku || val),
          sku: offer.sku ? String(offer.sku) : null,
          label: 'Option',
          value: val,
          selected_options: { Option: val },
          price: parsePrice(offer.price) ?? basePrice ?? null,
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
      doc.querySelector(
        '.x-price-primary span.ux-textspans, [data-testid="x-price-primary"] span.ux-textspans, #prcIsum, #mm-saleDscPrc'
      )?.textContent || '';
    const originalPriceText =
      doc.querySelector(
        '.x-price-was span.ux-textspans, .ux-textspans--STRIKETHROUGH, #orgPrc'
      )?.textContent || '';
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
      const src =
        img.getAttribute('data-zoom-src') ||
        img.getAttribute('data-src') ||
        img.getAttribute('src') ||
        '';
      if (src) imageCandidates.push(src.replace(/s-l\d+/i, 's-l1600'));
    });
    const images = uniqueStrings(imageCandidates, 10);

    const categoryPath = Array.from(doc.querySelectorAll('.seo-breadcrumb-text span, nav.breadcrumbs a span'))
      .map((el) => cleanText(el.textContent))
      .filter(Boolean);

    const description =
      cleanText(doc.querySelector('meta[name="description"]')?.getAttribute('content')) || title;

    const rawVariants = extractEbayVariants(doc, currency, images, price);
    const resolvedPrice =
      price ?? rawVariants.find((v) => v.price != null && Number(v.price) > 0)?.price ?? null;
    const variants = rawVariants.map((v) => ({
      ...v,
      price: v.price != null && Number(v.price) > 0 ? v.price : resolvedPrice,
    }));

    return {
      source: 'ebay',
      external_product_id: itemId,
      product_url: `${window.location.origin}/itm/${itemId}`,
      title: title || `eBay Item ${itemId}`,
      brand,
      description,
      bullet_points: [],
      specifications: specs.slice(0, 12),
      price: resolvedPrice,
      original_price: originalPrice,
      currency,
      shipping_price: shippingPrice,
      weight_lb: null,
      available: !/this listing was ended|out of stock/i.test(
        doc.querySelector('.x-status-message, #vi-statusmessage-panel')?.textContent || ''
      ),
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


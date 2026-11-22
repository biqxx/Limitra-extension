(() => {
  const adapters = window.LimitraAdapters;
  if (!adapters) return;

  const adapter = adapters.getAdapterForHost(window.location.hostname);
  if (!adapter) return;

  let queuedKeys = new Set();

  function keyOf(source, externalId) {
    return `${source}:${externalId}`;
  }

  function refreshQueuedState() {
    chrome.storage.local.get(['reviewQueue'], (res) => {
      const list = Array.isArray(res?.reviewQueue) ? res.reviewQueue : [];
      queuedKeys = new Set(list.map((item) => keyOf(item.source, item.external_product_id)));
      updateAllButtons();
    });
  }

  function createCartButton(labelText = 'Add to Limitra Review') {
    const host = document.createElement('div');
    host.className = 'limitra-cart-host';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: none;
        border-radius: 999px;
        padding: 7px 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        background: #111827;
        color: #ffffff;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.24);
        transition: transform 0.14s ease, background 0.14s ease;
        z-index: 2147483000;
      }
      .btn:hover { transform: translateY(-1px); background: #2563eb; }
      .btn.loading { opacity: 0.78; cursor: wait; }
      .btn.queued { background: #16a34a; }
      svg { width: 15px; height: 15px; flex-shrink: 0; }
    `;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.title = labelText;
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="9" cy="21" r="1"></circle>
        <circle cx="20" cy="21" r="1"></circle>
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path>
      </svg>
      <span class="txt"></span>
    `;

    shadow.appendChild(style);
    shadow.appendChild(btn);
    return { host, btn };
  }

  function setButtonVisual(btn, state, compact = false) {
    const txt = btn.querySelector('.txt');
    btn.classList.remove('loading', 'queued');
    if (state === 'loading') {
      btn.classList.add('loading');
      txt.textContent = compact ? '…' : 'Extracting…';
    } else if (state === 'queued') {
      btn.classList.add('queued');
      txt.textContent = compact ? 'Queued ✓' : 'In Review ✓';
    } else {
      txt.textContent = compact ? 'Add' : 'Add to Limitra';
    }
  }

  function updateAllButtons() {
    document.querySelectorAll('[data-limitra-key]').forEach((el) => {
      const k = el.getAttribute('data-limitra-key');
      const compact = el.getAttribute('data-limitra-compact') === '1';
      if (el._limitraBtn) {
        setButtonVisual(el._limitraBtn, queuedKeys.has(k) ? 'queued' : 'idle', compact);
      }
    });
  }

  async function fetchAndExtract(productUrl) {
    const res = await fetch(productUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const extracted = adapter.extractProduct(doc, productUrl);
    if (!extracted) throw new Error('Could not extract product details from page.');
    return extracted;
  }

  async function handleQueueClick(btn, compact, extractorFn) {
    setButtonVisual(btn, 'loading', compact);
    try {
      const product = await extractorFn();
      if (!product) throw new Error('Product extraction returned empty.');
      const res = await chrome.runtime.sendMessage({
        type: 'LIMITRA_ADD_TO_REVIEW',
        payload: product,
      });
      if (res && res.ok === false) {
        throw new Error(res.error || 'Failed to save to review queue.');
      }
      const k = keyOf(product.source, product.external_product_id);
      queuedKeys.add(k);
      setButtonVisual(btn, 'queued', compact);
    } catch (err) {
      const errMsg = err?.message || 'Extract error';
      console.warn('[Limitra Extension] Extract error:', errMsg);
      chrome.runtime
        .sendMessage({
          type: 'LIMITRA_LOG_ERROR',
          level: 'error',
          scope: `extract:${adapter.name}`,
          message: errMsg,
          details: { url: window.location.href },
        })
        .catch(() => {});
      setButtonVisual(btn, 'idle', compact);
      btn.querySelector('.txt').textContent = 'Retry';
      btn.title = errMsg;
    }
  }

  function injectProductDetailButton() {
    if (!adapter.isProductPage(window.location.href)) return;
    if (document.querySelector('.limitra-detail-fab')) return;

    const preview = adapter.extractProduct(document, window.location.href);
    const k = preview ? keyOf(preview.source, preview.external_product_id) : '';
    const { host, btn } = createCartButton('Add this product & variations to Limitra Review');
    host.classList.add('limitra-detail-fab');
    host.setAttribute('data-limitra-key', k);
    host.setAttribute('data-limitra-compact', '0');
    host._limitraBtn = btn;
    Object.assign(host.style, {
      position: 'fixed',
      bottom: '22px',
      right: '22px',
      zIndex: '2147483000',
    });

    setButtonVisual(btn, queuedKeys.has(k) ? 'queued' : 'idle', false);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleQueueClick(btn, false, async () =>
        adapter.extractProduct(document, window.location.href)
      );
    });

    document.body.appendChild(host);
  }

  function injectCardButtons() {
    const cards = adapter.findProductCards(document);
    for (const card of cards) {
      if (!card.element || card.element.querySelector('.limitra-card-fab')) continue;
      const computed = window.getComputedStyle(card.element);
      if (computed.position === 'static') {
        card.element.style.position = 'relative';
      }

      const k = keyOf(card.source, card.externalId);
      const { host, btn } = createCartButton('Add product to Limitra Review');
      host.classList.add('limitra-card-fab');
      host.setAttribute('data-limitra-key', k);
      host.setAttribute('data-limitra-compact', '1');
      host._limitraBtn = btn;
      Object.assign(host.style, {
        position: 'absolute',
        top: '8px',
        right: '8px',
        zIndex: '9999',
      });

      setButtonVisual(btn, queuedKeys.has(k) ? 'queued' : 'idle', true);
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleQueueClick(btn, true, () => fetchAndExtract(card.productUrl));
      });

      card.element.appendChild(host);
    }
  }

  function scanAndInject() {
    injectProductDetailButton();
    injectCardButtons();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'LIMITRA_EXTRACT_CURRENT') {
      try {
        const product = adapter.extractProduct(document, window.location.href);
        sendResponse({ ok: Boolean(product), product });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || 'Extraction failed' });
      }
      return true;
    }

    if (msg?.type === 'LIMITRA_BULK_EXTRACT_CARDS') {
      (async () => {
        const cards = adapter.findProductCards(document);
        const limit = Math.min(cards.length, Number(msg.limit || 24));
        let added = 0;
        let failed = 0;

        for (let i = 0; i < limit; i += 1) {
          const card = cards[i];
          const k = keyOf(card.source, card.externalId);
          chrome.runtime
            .sendMessage({
              type: 'LIMITRA_VARIANT_PROGRESS',
              queueId: '__bulk_extract__',
              current: i + 1,
              total: limit,
            })
            .catch(() => {});

          if (queuedKeys.has(k)) continue;

          try {
            const product = await fetchAndExtract(card.productUrl);
            const res = await chrome.runtime.sendMessage({
              type: 'LIMITRA_ADD_TO_REVIEW',
              payload: product,
              autoProcess: false,
            });
            if (res?.ok !== false) {
              queuedKeys.add(k);
              added += 1;
            } else {
              failed += 1;
            }
          } catch (err) {
            failed += 1;
            chrome.runtime
              .sendMessage({
                type: 'LIMITRA_LOG_ERROR',
                level: 'error',
                scope: `bulk-extract:${adapter.name}`,
                message: err?.message || 'Failed to extract card',
                details: { url: card.productUrl },
              })
              .catch(() => {});
          }
        }
        updateAllButtons();
        sendResponse({ ok: true, total: limit, added, failed });
      })();
      return true;
    }

    if (msg?.type === 'LIMITRA_FETCH_VARIANT_PRICES') {
      (async () => {
        const variants = Array.isArray(msg.variants) ? msg.variants : [];
        const updated = [...variants];
        let fetchedCount = 0;

        for (let i = 0; i < updated.length; i += 1) {
          const v = updated[i];
          if (v.price != null && Number(v.price) > 0) {
            continue;
          }
          if (!v.id || adapter.name !== 'amazon') {
            continue;
          }

          chrome.runtime
            .sendMessage({
              type: 'LIMITRA_VARIANT_PROGRESS',
              queueId: msg.queueId,
              current: i + 1,
              total: updated.length,
            })
            .catch(() => {});

          try {
            const url = `${window.location.origin}/dp/${encodeURIComponent(v.id)}?th=1&psc=1`;
            const extracted = await fetchAndExtract(url);
            if (extracted?.price) fetchedCount += 1;
            updated[i] = {
              ...v,
              price: extracted?.price ?? v.price,
              original_price: extracted?.original_price ?? v.original_price,
              available: extracted?.available ?? v.available,
              images: extracted?.images?.length ? extracted.images.slice(0, 5) : v.images,
              needs_price_fetch: !extracted?.price,
            };
          } catch {
            // keep existing variant entry
          }
        }
        sendResponse({ ok: true, variants: updated, fetchedCount });
      })();
      return true;
    }

    if (msg?.type === 'LIMITRA_QUEUE_UPDATED') {
      refreshQueuedState();
    }
    return false;
  });

  refreshQueuedState();
  scanAndInject();

  let timer = null;
  const observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(scanAndInject, 450);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();


let categories = [];
let activeQueueId = null;
const selectedQueueIds = new Set();

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(val) {
  return String(val || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `tab-${tabName}`);
  });
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function isJwtExpired(token) {
  if (!token || typeof token !== 'string') return true;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64));
    return typeof payload?.exp === 'number' && payload.exp * 1000 <= Date.now();
  } catch {
    return false;
  }
}

async function loadState() {
  const state = await chrome.storage.local.get([
    'apiBaseUrl',
    'token',
    'user',
    'authExpired',
    'authCredentials',
    'reviewQueue',
    'publishedHistory',
    'proxyConfig',
    'variantFetchProgress',
    'errorLogs',
  ]);

  const proxy = state.proxyConfig || {};
  $('proxy-enabled').checked = Boolean(proxy.enabled);
  if (proxy.scheme) $('proxy-scheme').value = proxy.scheme;
  if (proxy.host) $('proxy-host').value = proxy.host;
  if (proxy.port) $('proxy-port').value = proxy.port;
  if (proxy.username) $('proxy-user').value = proxy.username;
  if (proxy.password) $('proxy-pass').value = proxy.password;
  $('proxy-status').textContent =
    proxy.enabled && proxy.host && proxy.port
      ? `Proxy Active (${proxy.scheme || 'HTTP'} ${proxy.host}:${proxy.port}) — target sites only`
      : 'Direct connection (no proxy)';

  if (state.apiBaseUrl) $('api-url').value = state.apiBaseUrl;
  const user = state.user;
  if (user?.email && !$('login-email').value) {
    $('login-email').value = user.email;
  }

  const hasAutoRenew = Boolean(state.authCredentials?.email && state.authCredentials?.password);
  const tokenExpired = state.token ? isJwtExpired(state.token) : true;

  if (state.token && (!tokenExpired || hasAutoRenew) && user) {
    $('auth-status').textContent = `Signed in as ${user.email || user.name}`;
    $('auth-status').style.color = '';
    $('btn-logout').classList.remove('hidden');
  } else if (state.token && (!tokenExpired || hasAutoRenew)) {
    $('auth-status').textContent = 'Signed in';
    $('auth-status').style.color = '';
    $('btn-logout').classList.remove('hidden');
  } else if (state.authExpired || (state.token && tokenExpired && !hasAutoRenew)) {
    $('auth-status').textContent = `Session expired${user?.email ? ` (${user.email})` : ''} — sign in on Account tab`;
    $('auth-status').style.color = '#f87171';
    $('btn-logout').classList.remove('hidden');
  } else {
    $('auth-status').textContent = 'Not signed in — open Account tab';
    $('auth-status').style.color = '';
    $('btn-logout').classList.add('hidden');
  }

  const queue = Array.isArray(state.reviewQueue) ? state.reviewQueue : [];
  $('queue-badge').textContent = String(queue.length);

  renderQueue(queue);
  renderHistory(Array.isArray(state.publishedHistory) ? state.publishedHistory : []);
  const logs = Array.isArray(state.errorLogs) ? state.errorLogs : [];
  const errCount = logs.filter((l) => l.level === 'error').length;
  $('logs-badge').textContent = String(errCount);
  renderLogs(logs);
  if (activeQueueId) {
    const item = queue.find((i) => i.queue_id === activeQueueId);
    if (item) renderEditor(item);
    else closeEditor();
  }
}

function renderQueue(queue) {
  const container = $('queue-list');
  const bulkBar = $('bulk-bar');
  if (activeQueueId) {
    container.classList.add('hidden');
    bulkBar?.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  if (!queue.length) {
    selectedQueueIds.clear();
    bulkBar?.classList.add('hidden');
    container.innerHTML =
      '<div class="card"><p class="muted">No products in review yet. Click the Limitra cart icon on Amazon, eBay, or Walmart products, or click "Add All on Page".</p></div>';
    return;
  }

  bulkBar?.classList.remove('hidden');
  const validIds = new Set(queue.map((i) => i.queue_id));
  for (const id of [...selectedQueueIds]) {
    if (!validIds.has(id)) selectedQueueIds.delete(id);
  }
  $('selected-count').textContent = String(selectedQueueIds.size);
  $('chk-select-all').checked = queue.length > 0 && selectedQueueIds.size === queue.length;

  container.innerHTML = queue
    .map((item) => {
      const statusClass =
        item.review_status === 'ready'
          ? 'badge-ready'
          : item.review_status === 'reviewing'
            ? 'badge-reviewing'
            : item.review_status === 'error'
              ? 'badge-error'
              : '';
      const ngn = item.quote?.proposed_price_ngn
        ? `₦${Number(item.quote.proposed_price_ngn).toLocaleString()}`
        : `${item.currency || 'USD'} ${item.price ?? '?'}`;
      const varCount = Array.isArray(item.variants) ? item.variants.length : 0;
      const checked = selectedQueueIds.has(item.queue_id) ? 'checked' : '';

      return `
        <div class="card queue-item" data-qid="${escapeHtml(item.queue_id)}">
          <input type="checkbox" class="queue-chk" data-chk-qid="${escapeHtml(item.queue_id)}" ${checked} style="width:auto;margin-top:4px" />
          <img src="${escapeHtml(item.image_url || item.images?.[0] || '')}" alt="" />
          <div style="flex:1;min-width:0">
            <h3>${escapeHtml(item.reviewed_name || item.title)}</h3>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
              <span class="badge">${escapeHtml(item.source)}</span>
              <span class="badge ${statusClass}">${escapeHtml(item.review_status || 'pending')}</span>
              <span class="muted">${escapeHtml(ngn)} · ${varCount} variants</span>
              ${(item.review_status === 'error' || item.review_status === 'pending') ? `<button class="btn btn-secondary btn-retry-ai" data-retry-qid="${escapeHtml(item.queue_id)}" style="padding:2px 8px;font-size:11px">Retry AI</button>` : ''}
            </div>
            ${item.review_error ? `<div class="muted" style="color:#f87171;margin-top:4px">${escapeHtml(item.review_error)}</div>` : ''}
          </div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('.queue-chk').forEach((chk) => {
    chk.addEventListener('click', (e) => e.stopPropagation());
    chk.addEventListener('change', () => {
      const qid = chk.getAttribute('data-chk-qid');
      if (chk.checked) selectedQueueIds.add(qid);
      else selectedQueueIds.delete(qid);
      $('selected-count').textContent = String(selectedQueueIds.size);
      $('chk-select-all').checked = queue.length > 0 && selectedQueueIds.size === queue.length;
    });
  });

  container.querySelectorAll('.btn-retry-ai').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const qid = btn.getAttribute('data-retry-qid');
      btn.disabled = true;
      btn.textContent = 'Retrying…';
      await chrome.runtime.sendMessage({ type: 'LIMITRA_RUN_REVIEW', queueId: qid });
      loadState();
    });
  });

  container.querySelectorAll('[data-qid]').forEach((card) => {
    card.addEventListener('click', async () => {
      const qid = card.getAttribute('data-qid');
      if (!categories.length) await fetchCategories(true);
      const { reviewQueue = [] } = await chrome.storage.local.get(['reviewQueue']);
      const item = reviewQueue.find((i) => i.queue_id === qid);
      if (item) {
        activeQueueId = qid;
        renderQueue(reviewQueue);
        renderEditor(item);
      }
    });
  });
}

function closeEditor() {
  activeQueueId = null;
  $('editor-view').classList.add('hidden');
  $('queue-list').classList.remove('hidden');
}

function renderEditor(item) {
  const view = $('editor-view');
  view.classList.remove('hidden');

  const catOptions = categories
    .map(
      (c) =>
        `<option value="${c.id}" ${Number(item.reviewed_category_id) === Number(c.id) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
    )
    .join('');

  const selectedCat = categories.find(
    (c) => Number(c.id) === Number(item.reviewed_category_id)
  );
  const subOptions = (selectedCat?.subcategories || [])
    .map(
      (s) =>
        `<option value="${s.id}" ${Number(item.reviewed_subcategory_id) === Number(s.id) ? 'selected' : ''}>${escapeHtml(s.name)}</option>`
    )
    .join('');

  const variantsHtml = (item.variants || [])
    .map(
      (v, idx) => `
      <div class="variant-row">
        <input type="checkbox" class="var-keep" data-idx="${idx}" checked />
        <div>
          <strong>${escapeHtml(v.value || Object.values(v.selected_options || {}).join(' / '))}</strong>
          <div class="muted">${escapeHtml(v.sku || v.id || '')} · ${(v.images || []).length} img(s)</div>
        </div>
        <input type="number" step="0.01" class="var-price" data-idx="${idx}" value="${v.price ?? item.price ?? ''}" placeholder="Price" />
        <div class="muted">${v.proposed_price_ngn ? `₦${Number(v.proposed_price_ngn).toLocaleString()}` : (item.quote?.proposed_price_ngn ? `₦${Number(item.quote.proposed_price_ngn).toLocaleString()}` : '—')}</div>
      </div>`
    )
    .join('');

  const isReviewing = item.review_status === 'reviewing';

  view.innerHTML = `
    <div class="stack">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <button id="ed-back" class="btn btn-secondary">← Back</button>
        <div style="display:flex;gap:6px">
          <button id="ed-ai" class="btn btn-secondary" ${isReviewing ? 'disabled' : ''}>${isReviewing ? 'Running AI + Quote…' : 'Re-run AI + Quote'}</button>
          <button id="ed-remove" class="btn btn-danger">Remove</button>
        </div>
      </div>

      ${(item.warnings || []).length ? `<div class="card"><p class="muted">${escapeHtml(item.warnings.join(' | '))}</p></div>` : ''}

      <div class="card stack">
        <label>Product Title (AI Optimized)
          <input id="ed-name" value="${escapeHtml(item.reviewed_name || item.title)}" />
        </label>
        <label>Brand
          <input id="ed-brand" value="${escapeHtml(item.reviewed_brand || item.brand || '')}" />
        </label>
        <label>Category
          <select id="ed-cat"><option value="">Select category…</option>${catOptions}</select>
        </label>
        <label>Subcategory
          <select id="ed-sub"><option value="">Optional subcategory…</option>${subOptions}</select>
        </label>
        <label>Description
          <textarea id="ed-desc">${escapeHtml(item.reviewed_description || item.description || '')}</textarea>
        </label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <label>Supplier Price (${escapeHtml(item.currency || 'USD')})
            <input id="ed-price" type="number" step="0.01" value="${item.price ?? ''}" />
          </label>
          <label>Stock Qty
            <input id="ed-stock" type="number" min="0" value="${item.default_stock ?? 10}" />
          </label>
        </div>
        <div class="muted">
          Calculated Limitra Price: <strong>${item.quote?.proposed_price_ngn ? `₦${Number(item.quote.proposed_price_ngn).toLocaleString()}` : 'Run AI + Quote to calculate'}</strong>
        </div>
      </div>

      <div class="card stack">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>Variations (${(item.variants || []).length})</strong>
          ${item.source === 'amazon' ? '<button id="ed-fetch-vars" class="btn btn-secondary">Fetch Variation Prices</button>' : ''}
        </div>
        ${variantsHtml || '<p class="muted">No variations detected for this product.</p>'}
      </div>

      <div style="display:flex;gap:8px">
        <button id="ed-publish" class="btn btn-success" style="flex:1" ${isReviewing ? 'disabled' : ''}>Add Officially to Limitra</button>
        <button id="ed-draft" class="btn btn-secondary" ${isReviewing ? 'disabled' : ''}>Save Draft</button>
      </div>
      <p id="ed-status" class="muted">${isReviewing ? 'Running Limitra AI enhancement & NGN pricing…' : (item.review_error ? escapeHtml(item.review_error) : '')}</p>
    </div>
  `;

  $('ed-back').addEventListener('click', closeEditor);

  $('ed-cat').addEventListener('change', () => {
    const chosen = categories.find((c) => Number(c.id) === Number($('ed-cat').value));
    $('ed-sub').innerHTML =
      '<option value="">Optional subcategory…</option>' +
      (chosen?.subcategories || [])
        .map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`)
        .join('');
  });

  $('ed-ai').addEventListener('click', async () => {
    const btn = $('ed-ai');
    btn.disabled = true;
    btn.textContent = 'Running AI + Quote…';
    $('ed-status').textContent = 'Running Limitra AI enhancement & NGN pricing…';
    try {
      const { reviewQueue = [] } = await chrome.storage.local.get(['reviewQueue']);
      const idx = reviewQueue.findIndex((i) => i.queue_id === item.queue_id);
      if (idx !== -1) {
        reviewQueue[idx].price = Number($('ed-price').value) || reviewQueue[idx].price;
        await chrome.storage.local.set({ reviewQueue });
      }
      const res = await chrome.runtime.sendMessage({ type: 'LIMITRA_RUN_REVIEW', queueId: item.queue_id });
      await loadState();
      if ($('ed-status') && res?.item?.review_status === 'ready') {
        $('ed-status').textContent = 'AI enhancement & NGN quote updated.';
      }
    } catch (err) {
      if ($('ed-status')) $('ed-status').textContent = err?.message || 'AI review failed.';
    } finally {
      if ($('ed-ai')) {
        $('ed-ai').disabled = false;
        $('ed-ai').textContent = 'Re-run AI + Quote';
      }
    }
  });

  $('ed-fetch-vars')?.addEventListener('click', async () => {
    const btn = $('ed-fetch-vars');
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    $('ed-status').textContent = 'Locating Amazon tab to fetch live variation prices…';

    try {
      const tabs = await chrome.tabs.query({ url: ['https://*.amazon.com/*', 'https://*.amazon.co.uk/*', 'https://*.amazon.ca/*', 'https://*.amazon.de/*'] });
      const targetTab = tabs.find((t) => t.active) || tabs[0];
      if (!targetTab?.id) {
        $('ed-status').textContent = 'Open any Amazon tab first so variation prices can be fetched in your session.';
        btn.disabled = false;
        btn.textContent = 'Fetch Variation Prices';
        return;
      }

      const progressListener = (changes) => {
        const p = changes?.variantFetchProgress?.newValue;
        if (p && p.queueId === item.queue_id) {
          btn.textContent = `Fetching ${p.current}/${p.total}…`;
          $('ed-status').textContent = `Fetching variation ${p.current} of ${p.total} from Amazon…`;
        }
      };
      chrome.storage.onChanged.addListener(progressListener);

      const res = await chrome.tabs
        .sendMessage(targetTab.id, {
          type: 'LIMITRA_FETCH_VARIANT_PRICES',
          queueId: item.queue_id,
          variants: item.variants || [],
        })
        .finally(() => {
          chrome.storage.onChanged.removeListener(progressListener);
        });

      if (res?.ok) {
        const { reviewQueue = [] } = await chrome.storage.local.get(['reviewQueue']);
        const idx = reviewQueue.findIndex((i) => i.queue_id === item.queue_id);
        if (idx !== -1) {
          reviewQueue[idx].variants = res.variants;
          await chrome.storage.local.set({ reviewQueue });
          $('ed-status').textContent = `Fetched ${res.fetchedCount ?? 0} variation price(s). Running NGN quote…`;
          await chrome.runtime.sendMessage({ type: 'LIMITRA_RUN_REVIEW', queueId: item.queue_id });
          loadState();
          return;
        }
      }
      $('ed-status').textContent = 'Could not fetch variation prices. Refresh the Amazon tab and try again.';
    } catch (err) {
      $('ed-status').textContent = err?.message || 'Failed to fetch variation prices.';
    } finally {
      if ($('ed-fetch-vars')) {
        $('ed-fetch-vars').disabled = false;
        $('ed-fetch-vars').textContent = 'Fetch Variation Prices';
      }
    }
  });

  $('ed-remove').addEventListener('click', async () => {
    const { reviewQueue = [] } = await chrome.storage.local.get(['reviewQueue']);
    const next = reviewQueue.filter((i) => i.queue_id !== item.queue_id);
    await chrome.storage.local.set({ reviewQueue: next });
    closeEditor();
    loadState();
  });

  const submitImport = async (publish) => {
    const categoryId = Number($('ed-cat').value);
    if (!categoryId) {
      $('ed-status').textContent = 'Please select a category first.';
      return;
    }

    const defaultProductPrice = Number($('ed-price').value) || item.price;
    const keptVariants = [];
    document.querySelectorAll('.var-keep').forEach((chk) => {
      if (!chk.checked) return;
      const idx = Number(chk.dataset.idx);
      const baseVar = item.variants[idx];
      const priceInput = document.querySelector(`.var-price[data-idx="${idx}"]`);
      const editedPrice = Number(priceInput?.value);
      const fallbackVarPrice =
        baseVar.price != null && Number(baseVar.price) > 0
          ? Number(baseVar.price)
          : defaultProductPrice;
      keptVariants.push({
        ...baseVar,
        price: Number.isFinite(editedPrice) && editedPrice > 0 ? editedPrice : fallbackVarPrice,
      });
    });

    $('ed-status').textContent = publish ? 'Publishing officially to Limitra…' : 'Saving draft…';
    const res = await chrome.runtime.sendMessage({
      type: 'LIMITRA_PUBLISH_PRODUCT',
      queueId: item.queue_id,
      payload: {
        source: item.source,
        external_product_id: item.external_product_id,
        category_id: categoryId,
        subcategory_id: $('ed-sub').value ? Number($('ed-sub').value) : null,
        name: $('ed-name').value.trim(),
        brand: $('ed-brand').value.trim() || null,
        description: $('ed-desc').value.trim(),
        seo_meta: item.seo_meta || null,
        publish,
        stock: Number($('ed-stock').value) || 10,
        specifications: item.reviewed_specifications || item.specifications || [],
        price: Number($('ed-price').value) || item.price,
        original_price: item.original_price || null,
        currency: item.currency || 'USD',
        shipping_price: item.shipping_price ?? null,
        weight_lb: item.weight_lb ?? null,
        available: item.available ?? true,
        image_url: item.image_url,
        images: item.images || [],
        product_url: item.product_url,
        variants: keptVariants,
      },
    });

    if (res?.ok) {
      closeEditor();
      loadState();
    } else {
      $('ed-status').textContent = res?.error || 'Import failed.';
    }
  };

  $('ed-publish').addEventListener('click', () => submitImport(true));
  $('ed-draft').addEventListener('click', () => submitImport(false));
}

function renderHistory(history) {
  const el = $('history-list');
  if (!history.length) {
    el.innerHTML = '<div class="card"><p class="muted">No products published yet.</p></div>';
    return;
  }
  el.innerHTML = history
    .map(
      (h) => `
      <div class="card">
        <strong>${escapeHtml(h.name)}</strong>
        <div class="muted">${escapeHtml(h.source)} · ${h.price_ngn ? `₦${Number(h.price_ngn).toLocaleString()}` : ''} · ${h.published ? 'Live on Limitra' : 'Draft'}</div>
      </div>`
    )
    .join('');
}

function renderLogs(logs) {
  const el = $('logs-list');
  if (!logs.length) {
    el.innerHTML = '<div class="card"><p class="muted">No logs recorded yet.</p></div>';
    return;
  }
  el.innerHTML = logs
    .map(
      (log) => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;gap:6px;align-items:center;margin-bottom:4px">
          <span class="badge ${log.level === 'error' ? 'badge-error' : 'badge-ready'}">${escapeHtml(log.level)} · ${escapeHtml(log.scope)}</span>
          <span class="muted">${escapeHtml(new Date(log.timestamp).toLocaleTimeString())}</span>
        </div>
        <div style="word-break:break-word">${escapeHtml(log.message)}</div>
        ${log.details ? `<pre class="muted" style="white-space:pre-wrap;word-break:break-all;margin:6px 0 0;font-size:11px">${escapeHtml(log.details)}</pre>` : ''}
      </div>`
    )
    .join('');
}

$('btn-copy-logs').addEventListener('click', async () => {
  const { errorLogs = [] } = await chrome.storage.local.get(['errorLogs']);
  await navigator.clipboard.writeText(JSON.stringify(errorLogs, null, 2));
  $('btn-copy-logs').textContent = 'Copied ✓';
  setTimeout(() => { $('btn-copy-logs').textContent = 'Copy Logs'; }, 1500);
});

$('btn-clear-logs').addEventListener('click', async () => {
  await chrome.storage.local.set({ errorLogs: [] });
  loadState();
});

$('chk-select-all').addEventListener('change', async () => {
  const { reviewQueue = [] } = await chrome.storage.local.get(['reviewQueue']);
  if ($('chk-select-all').checked) {
    reviewQueue.forEach((i) => selectedQueueIds.add(i.queue_id));
  } else {
    selectedQueueIds.clear();
  }
  renderQueue(reviewQueue);
});

$('btn-bulk-scan').addEventListener('click', async () => {
  const btn = $('btn-bulk-scan');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  $('bulk-status').textContent = 'Extracting all products on the active supplier page…';

  const progressListener = (changes) => {
    const p = changes?.variantFetchProgress?.newValue;
    if (p?.queueId === '__bulk_extract__') {
      btn.textContent = `Adding ${p.current}/${p.total}…`;
      $('bulk-status').textContent = `Extracting product ${p.current} of ${p.total}…`;
    }
  };
  chrome.storage.onChanged.addListener(progressListener);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found.');
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: 'LIMITRA_BULK_EXTRACT_CARDS',
      limit: 24,
    });
    if (res?.ok) {
      $('bulk-status').textContent = `Added ${res.added} product(s) to Review (${res.failed} failed). Click "Run AI on All" next.`;
    } else {
      $('bulk-status').textContent = res?.error || 'Could not bulk-scan this page.';
    }
    await loadState();
  } catch (err) {
    $('bulk-status').textContent = err?.message || 'Open an Amazon, eBay, or Walmart search/category page first.';
  } finally {
    chrome.storage.onChanged.removeListener(progressListener);
    btn.disabled = false;
    btn.textContent = 'Add All on Page';
  }
});

async function runBulkImport(publish) {
  const { reviewQueue = [] } = await chrome.storage.local.get(['reviewQueue']);
  const targets = selectedQueueIds.size
    ? reviewQueue.filter((i) => selectedQueueIds.has(i.queue_id))
    : reviewQueue;

  if (!targets.length) {
    $('bulk-status').textContent = 'No products in queue to import.';
    return;
  }

  const pubBtn = $('btn-bulk-publish');
  const draftBtn = $('btn-bulk-draft');
  pubBtn.disabled = true;
  draftBtn.disabled = true;

  let succeeded = 0;
  let skipped = 0;

  try {
    for (let i = 0; i < targets.length; i += 1) {
      const item = targets[i];
      $('bulk-status').textContent = `${publish ? 'Publishing' : 'Saving draft'} ${i + 1}/${targets.length}: ${item.reviewed_name || item.title}…`;

      const categoryId = Number(item.reviewed_category_id);
      const price = Number(item.price);
      if (!categoryId || !Number.isFinite(price) || price <= 0) {
        skipped += 1;
        continue;
      }

      const res = await chrome.runtime.sendMessage({
        type: 'LIMITRA_PUBLISH_PRODUCT',
        queueId: item.queue_id,
        payload: {
          source: item.source,
          external_product_id: item.external_product_id,
          category_id: categoryId,
          subcategory_id: item.reviewed_subcategory_id ? Number(item.reviewed_subcategory_id) : null,
          name: (item.reviewed_name || item.title || '').trim(),
          brand: (item.reviewed_brand || item.brand || '').trim() || null,
          description: (item.reviewed_description || item.description || '').trim(),
          seo_meta: item.seo_meta || null,
          publish,
          stock: Number(item.default_stock) || 10,
          specifications: item.reviewed_specifications || item.specifications || [],
          price,
          original_price: item.original_price || null,
          currency: item.currency || 'USD',
          shipping_price: item.shipping_price ?? null,
          weight_lb: item.weight_lb ?? null,
          available: item.available ?? true,
          image_url: item.image_url,
          images: item.images || [],
          product_url: item.product_url,
          variants: (item.variants || []).map((v) => ({
            ...v,
            price: v.price != null && Number(v.price) > 0 ? Number(v.price) : price,
          })),
        },
      });

      if (res?.ok) {
        selectedQueueIds.delete(item.queue_id);
        succeeded += 1;
      } else {
        skipped += 1;
      }
    }

    $('bulk-status').textContent = `Bulk ${publish ? 'publish' : 'draft'} done: ${succeeded} succeeded, ${skipped} skipped (missing category/price or duplicate).`;
    await loadState();
  } finally {
    pubBtn.disabled = false;
    draftBtn.disabled = false;
  }
}

$('btn-bulk-publish').addEventListener('click', () => runBulkImport(true));
$('btn-bulk-draft').addEventListener('click', () => runBulkImport(false));

$('btn-bulk-remove').addEventListener('click', async () => {
  if (!selectedQueueIds.size) return;
  const { reviewQueue = [] } = await chrome.storage.local.get(['reviewQueue']);
  const next = reviewQueue.filter((i) => !selectedQueueIds.has(i.queue_id));
  selectedQueueIds.clear();
  await chrome.storage.local.set({ reviewQueue: next });
  $('bulk-status').textContent = 'Removed selected items from Review Queue.';
  loadState();
});

$('btn-scan-tab').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const res = await chrome.tabs.sendMessage(tab.id, { type: 'LIMITRA_EXTRACT_CURRENT' }).catch(() => null);
  if (res?.ok && res.product) {
    await chrome.runtime.sendMessage({ type: 'LIMITRA_ADD_TO_REVIEW', payload: res.product });
    loadState();
  }
});

$('btn-ai-all').addEventListener('click', async () => {
  const btn = $('btn-ai-all');
  btn.disabled = true;
  try {
    const { reviewQueue = [] } = await chrome.storage.local.get(['reviewQueue']);
    const targets = selectedQueueIds.size
      ? reviewQueue.filter((i) => selectedQueueIds.has(i.queue_id))
      : reviewQueue;
    if (!targets.length) return;
    for (let i = 0; i < targets.length; i += 1) {
      btn.textContent = `Running AI (${i + 1}/${targets.length})…`;
      $('bulk-status').textContent = `Running AI + NGN quote (${i + 1}/${targets.length})…`;
      await chrome.runtime.sendMessage({ type: 'LIMITRA_RUN_REVIEW', queueId: targets[i].queue_id });
    }
    $('bulk-status').textContent = `AI + quote finished for ${targets.length} item(s).`;
    await loadState();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run AI on All';
  }
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-msg').textContent = 'Signing in…';
  const res = await chrome.runtime.sendMessage({
    type: 'LIMITRA_LOGIN',
    apiBaseUrl: $('api-url').value.trim(),
    email: $('login-email').value.trim(),
    password: $('login-password').value,
  });
  $('login-msg').textContent = res?.ok ? 'Signed in!' : res?.error || 'Login failed.';
  if (res?.ok) {
    await fetchCategories();
    loadState();
  }
});

$('btn-logout').addEventListener('click', async () => {
  await chrome.storage.local.remove(['token', 'user', 'authCredentials', 'authExpired']);
  loadState();
});

$('proxy-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const proxyConfig = {
    enabled: $('proxy-enabled').checked,
    scheme: $('proxy-scheme').value,
    host: $('proxy-host').value.trim(),
    port: Number($('proxy-port').value) || 0,
    username: $('proxy-user').value.trim(),
    password: $('proxy-pass').value,
  };
  $('proxy-status').textContent = 'Applying proxy settings…';
  const res = await chrome.runtime.sendMessage({
    type: 'LIMITRA_SET_PROXY',
    proxyConfig,
  });
  if (res?.ok) {
    loadState();
  } else {
    $('proxy-status').textContent = res?.error || 'Failed to apply proxy settings.';
  }
});

async function fetchCategories(forceRefresh = false) {
  const res = await chrome.runtime.sendMessage({
    type: 'LIMITRA_GET_CATEGORIES',
    forceRefresh,
  });
  if (res?.ok) categories = res.categories || [];
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes && Object.keys(changes).length === 1 && changes.variantFetchProgress) return;
  loadState();
});

fetchCategories().then(loadState);


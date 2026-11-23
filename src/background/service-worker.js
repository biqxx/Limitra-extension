const DEFAULT_API_BASE = 'https://api.limitra.com.ng/api/v1';
const TARGET_HOST_PATTERNS = [
  'amazon.com',
  'amazon.co.uk',
  'amazon.ca',
  'amazon.de',
  'amazon.fr',
  'ebay.com',
  'ebay.co.uk',
  'ebay.ca',
  'ebay.de',
  'walmart.com',
];

let activeProxyConfig = null;

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

function buildPacScript(proxy) {
  const scheme = String(proxy.scheme || 'HTTP').toUpperCase();
  const directive =
    scheme === 'SOCKS5'
      ? `SOCKS5 ${proxy.host}:${proxy.port}`
      : scheme === 'HTTPS'
        ? `HTTPS ${proxy.host}:${proxy.port}`
        : `PROXY ${proxy.host}:${proxy.port}`;
  const checks = TARGET_HOST_PATTERNS.map(
    (d) => `dnsDomainIs(host, ".${d}") || host === "${d}"`
  ).join(' || ');

  return `function FindProxyForURL(url, host) {
    if (${checks}) { return "${directive}; DIRECT"; }
    return "DIRECT";
  }`;
}

async function applyProxySettings(proxy) {
  if (!proxy || !proxy.enabled || !proxy.host || !proxy.port) {
    activeProxyConfig = null;
    await chrome.proxy.settings.clear({ scope: 'regular' });
    return { enabled: false };
  }
  activeProxyConfig = proxy;
  const pacData = buildPacScript(proxy);
  await chrome.proxy.settings.set({
    value: { mode: 'pac_script', pacScript: { data: pacData } },
    scope: 'regular',
  });
  return { enabled: true };
}

chrome.storage.local.get(['proxyConfig'], (res) => {
  if (res?.proxyConfig?.enabled) {
    applyProxySettings(res.proxyConfig).catch(() => {});
  }
});

chrome.webRequest?.onAuthRequired?.addListener(
  (details, callback) => {
    if (
      details.isProxy &&
      activeProxyConfig?.enabled &&
      activeProxyConfig.username
    ) {
      callback({
        authCredentials: {
          username: activeProxyConfig.username,
          password: activeProxyConfig.password || '',
        },
      });
      return;
    }
    callback({});
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

async function getConfig() {
  const res = await chrome.storage.local.get([
    'apiBaseUrl',
    'token',
    'user',
    'authCredentials',
  ]);
  return {
    apiBaseUrl: (res.apiBaseUrl || DEFAULT_API_BASE).replace(/\/+$/, ''),
    token: res.token || null,
    user: res.user || null,
    authCredentials: res.authCredentials || null,
  };
}

function getJwtExpMs(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(base64));
    return typeof json?.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

let refreshPromise = null;

async function refreshOrRelogin(apiBaseUrl, currentToken, authCredentials, forceRelogin = false) {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    // 1. Try JWT /refresh if we have a token and aren't forced directly to relogin
    if (currentToken && !forceRelogin) {
      try {
        const res = await fetch(`${apiBaseUrl}/refresh`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${currentToken}`,
          },
        });
        const json = await res.json().catch(() => null);
        const refreshedData = json?.data ?? json;
        const newToken = refreshedData?.access_token || refreshedData?.token;
        if (res.ok && newToken) {
          await chrome.storage.local.set({
            token: newToken,
            user: refreshedData?.user || undefined,
            authExpired: false,
          });
          return newToken;
        }
      } catch {
        // fall through to credential re-login
      }
    }

    // 2. Fall back to automatic re-login if credentials were saved locally
    if (authCredentials?.email && authCredentials?.password) {
      try {
        const res = await fetch(`${apiBaseUrl}/login`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: authCredentials.email,
            password: authCredentials.password,
          }),
        });
        const json = await res.json().catch(() => null);
        const loginData = json?.data ?? json;
        const newToken = loginData?.access_token || loginData?.token;
        if (res.ok && newToken) {
          await chrome.storage.local.set({
            token: newToken,
            user: loginData?.user || undefined,
            authExpired: false,
          });
          await appendLog('info', 'auth', 'Automatically refreshed expired session token.');
          return newToken;
        }
      } catch {
        // ignore and return null below
      }
    }

    return null;
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

async function appendLog(level, scope, message, details = null) {
  try {
    const res = await chrome.storage.local.get(['errorLogs']);
    const logs = Array.isArray(res.errorLogs) ? res.errorLogs : [];
    logs.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      level,
      scope,
      message: String(message || 'Unknown error'),
      details: details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null,
    });
    await chrome.storage.local.set({ errorLogs: logs.slice(0, 100) });
  } catch {
    // ignore storage errors
  }
}

async function apiRequest(path, { method = 'GET', body, auth = true } = {}) {
  const { apiBaseUrl, token: storedToken, authCredentials } = await getConfig();
  let activeToken = storedToken;

  // Proactively refresh or re-login if the JWT is expired or within 5 minutes of expiring
  if (auth && activeToken) {
    const expMs = getJwtExpMs(activeToken);
    if (expMs !== null) {
      const remainingMs = expMs - Date.now();
      if (remainingMs <= 0) {
        const renewed = await refreshOrRelogin(apiBaseUrl, activeToken, authCredentials, false);
        if (renewed) activeToken = renewed;
      } else if (remainingMs < 5 * 60 * 1000) {
        const renewed = await refreshOrRelogin(apiBaseUrl, activeToken, authCredentials, false);
        if (renewed) activeToken = renewed;
      }
    }
  } else if (auth && !activeToken && authCredentials?.email && authCredentials?.password) {
    const renewed = await refreshOrRelogin(apiBaseUrl, null, authCredentials, true);
    if (renewed) activeToken = renewed;
  }

  const buildHeaders = (jwt) => {
    const h = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (auth && jwt) {
      h.Authorization = `Bearer ${jwt}`;
    }
    return h;
  };

  const url = `${apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  let res = await fetch(url, {
    method,
    headers: buildHeaders(activeToken),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // On 401 Unauthenticated, attempt token refresh / auto-relogin once and retry the request
  if (auth && res.status === 401) {
    const renewed = await refreshOrRelogin(apiBaseUrl, activeToken, authCredentials, false);
    if (renewed) {
      activeToken = renewed;
      res = await fetch(url, {
        method,
        headers: buildHeaders(activeToken),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } else {
      await chrome.storage.local.set({ token: null, authExpired: true });
      const expiredMsg = 'Session expired (JWT valid for 60 mins). Please sign in again on the Account tab.';
      await appendLog('error', `api:${path}`, expiredMsg, { status: 401, url });
      throw new Error(expiredMsg);
    }
  }

  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.success === false)) {
    const validationErrors = json?.errors ? ` (${JSON.stringify(json.errors)})` : '';
    const errMsg = `${json?.message || `API Error (${res.status})`}${validationErrors}`;
    await appendLog('error', `api:${path}`, errMsg, { status: res.status, url });
    throw new Error(errMsg);
  }
  return json?.data ?? json;
}

async function updateBadge(queue) {
  const count = Array.isArray(queue) ? queue.length : 0;
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
}

async function notifyTabsQueueUpdated() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'LIMITRA_QUEUE_UPDATED' }).catch(() => {});
    }
  }
}

async function fetchLimitraCategories(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await chrome.storage.local.get(['limitraCategories', 'limitraCategoriesAt']);
    const age = Date.now() - Number(cached.limitraCategoriesAt || 0);
    if (Array.isArray(cached.limitraCategories) && cached.limitraCategories.length && age < 15 * 60 * 1000) {
      return cached.limitraCategories;
    }
  }
  const data = await apiRequest('/categories', { auth: false });
  const list = Array.isArray(data) ? data : data?.items || [];
  await chrome.storage.local.set({
    limitraCategories: list,
    limitraCategoriesAt: Date.now(),
  });
  return list;
}

async function runAiReviewOnItem(itemId) {
  const res = await chrome.storage.local.get(['reviewQueue']);
  const queue = Array.isArray(res.reviewQueue) ? res.reviewQueue : [];
  const idx = queue.findIndex((i) => i.queue_id === itemId);
  if (idx === -1) return null;

  const item = queue[idx];
  const { token, authCredentials } = await getConfig();
  if (!token && !(authCredentials?.email && authCredentials?.password)) return item;

  queue[idx] = { ...item, review_status: 'reviewing', review_error: null };
  await chrome.storage.local.set({ reviewQueue: queue });

  try {
    const limitraCategories = await fetchLimitraCategories(false).catch(() => []);
    const compactCategories = limitraCategories.map((c) => ({
      id: c.id,
      name: c.name,
      subcategories: (c.subcategories || []).map((s) => ({ id: s.id, name: s.name })),
    }));

    const reviewed = await apiRequest('/admin/sourcing/extension-review', {
      method: 'POST',
      body: {
        source: item.source,
        external_product_id: item.external_product_id,
        title: item.title,
        brand: item.brand,
        description: item.description,
        bullet_points: item.bullet_points || [],
        specifications: item.specifications || [],
        price: item.price,
        original_price: item.original_price,
        currency: item.currency || 'USD',
        shipping_price: item.shipping_price,
        weight_lb: item.weight_lb,
        available: item.available ?? true,
        image_url: item.image_url,
        images: item.images || [],
        product_url: item.product_url,
        category: item.category,
        category_path: item.category_path || [],
        variants: item.variants || [],
        categories: compactCategories,
      },
    });

    const fresh = (await chrome.storage.local.get(['reviewQueue'])).reviewQueue || [];
    const freshIdx = fresh.findIndex((i) => i.queue_id === itemId);
    if (freshIdx !== -1) {
      const enhanced = reviewed?.enhanced || {};
      fresh[freshIdx] = {
        ...fresh[freshIdx],
        review_status: 'ready',
        review_error: null,
        ai_enhanced: enhanced,
        seo_meta: reviewed?.seo_meta || null,
        quote: reviewed?.quote || null,
        warnings: reviewed?.warnings || [],
        reviewed_name: enhanced.name || fresh[freshIdx].title,
        reviewed_brand: enhanced.brand || fresh[freshIdx].brand || '',
        reviewed_description: enhanced.description || fresh[freshIdx].description || '',
        reviewed_category_id: enhanced.category_id || fresh[freshIdx].reviewed_category_id || '',
        reviewed_subcategory_id:
          enhanced.subcategory_id || fresh[freshIdx].reviewed_subcategory_id || '',
        reviewed_specifications:
          Array.isArray(enhanced.specifications) && enhanced.specifications.length
            ? enhanced.specifications
            : fresh[freshIdx].specifications || [],
        variants: Array.isArray(reviewed?.variants)
          ? reviewed.variants
          : fresh[freshIdx].variants || [],
      };
      await chrome.storage.local.set({ reviewQueue: fresh });
      return fresh[freshIdx];
    }
  } catch (err) {
    await appendLog('error', 'ai-review', err?.message || 'AI review failed', { queueId: itemId });
    const fresh = (await chrome.storage.local.get(['reviewQueue'])).reviewQueue || [];
    const freshIdx = fresh.findIndex((i) => i.queue_id === itemId);
    if (freshIdx !== -1) {
      fresh[freshIdx] = {
        ...fresh[freshIdx],
        review_status: 'error',
        review_error: err.message,
      };
      await chrome.storage.local.set({ reviewQueue: fresh });
    }
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'LIMITRA_ADD_TO_REVIEW') {
    (async () => {
      try {
        const product = msg.payload;
        if (!product || !product.external_product_id) {
          throw new Error('Missing product identifier (ASIN / Item ID).');
        }
        const res = await chrome.storage.local.get(['reviewQueue']);
        const queue = Array.isArray(res.reviewQueue) ? res.reviewQueue : [];
        const queueId = `${product.source}:${product.external_product_id}`;
        const existingIdx = queue.findIndex((i) => i.queue_id === queueId);

        const entry = {
          ...product,
          queue_id: queueId,
          added_at: new Date().toISOString(),
          review_status: 'pending',
          review_error: null,
          reviewed_name: product.title,
          reviewed_brand: product.brand || '',
          reviewed_description: product.description || '',
          reviewed_specifications: product.specifications || [],
          publish_immediately: true,
          default_stock: 10,
        };

        if (existingIdx !== -1) {
          queue[existingIdx] = { ...queue[existingIdx], ...entry };
        } else {
          queue.unshift(entry);
        }

        await chrome.storage.local.set({ reviewQueue: queue });
        await updateBadge(queue);
        await notifyTabsQueueUpdated();
        await appendLog('info', 'queue', `Added to Review Queue: ${product.title}`, { queueId });

        // Add first, then process asynchronously so add never fails if AI/API fails.
        sendResponse({ ok: true, count: queue.length, queueId });
        if (msg.autoProcess !== false) {
          runAiReviewOnItem(queueId).catch(() => {});
        }
      } catch (err) {
        await appendLog('error', 'queue:add', err?.message || 'Failed to add product to queue', msg?.payload);
        sendResponse({ ok: false, error: err?.message || 'Failed to add product' });
      }
    })();
    return true;
  }

  if (msg?.type === 'LIMITRA_LOG_ERROR') {
    appendLog(msg.level || 'error', msg.scope || 'extension', msg.message, msg.details);
    return false;
  }

  if (msg?.type === 'LIMITRA_RUN_REVIEW') {
    runAiReviewOnItem(msg.queueId)
      .then((item) => sendResponse({ ok: true, item }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg?.type === 'LIMITRA_LOGIN') {
    (async () => {
      try {
        if (msg.apiBaseUrl) {
          await chrome.storage.local.set({ apiBaseUrl: msg.apiBaseUrl });
        }
        const data = await apiRequest('/login', {
          method: 'POST',
          auth: false,
          body: { email: msg.email, password: msg.password },
        });
        const token = data?.access_token || data?.token;
        if (!token) throw new Error('No access token returned.');
        await chrome.storage.local.set({
          token,
          user: data?.user || null,
          authExpired: false,
          authCredentials: { email: msg.email, password: msg.password },
        });
        sendResponse({ ok: true, user: data?.user || null });

        // Automatically retry any queued products that previously failed due to expired auth
        const { reviewQueue = [] } = await chrome.storage.local.get(['reviewQueue']);
        for (const item of reviewQueue) {
          if (
            item.review_status === 'pending' ||
            (item.review_status === 'error' && /unauthenticated|session expired/i.test(item.review_error || ''))
          ) {
            runAiReviewOnItem(item.queue_id).catch(() => {});
          }
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg?.type === 'LIMITRA_GET_CATEGORIES') {
    fetchLimitraCategories(Boolean(msg.forceRefresh))
      .then((cats) => sendResponse({ ok: true, categories: cats }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg?.type === 'LIMITRA_PUBLISH_PRODUCT') {
    (async () => {
      try {
        const result = await apiRequest('/admin/sourcing/extension-import', {
          method: 'POST',
          body: msg.payload,
        });

        const res = await chrome.storage.local.get(['reviewQueue', 'publishedHistory']);
        const queue = (res.reviewQueue || []).filter((i) => i.queue_id !== msg.queueId);
        const history = Array.isArray(res.publishedHistory) ? res.publishedHistory : [];
        history.unshift({
          queue_id: msg.queueId,
          product_id: result?.product?.id || result?.product_id,
          name: msg.payload.name,
          source: msg.payload.source,
          price_ngn: result?.product?.price || result?.final_price_ngn,
          published: Boolean(msg.payload.publish),
          imported_at: new Date().toISOString(),
        });

        await chrome.storage.local.set({
          reviewQueue: queue,
          publishedHistory: history.slice(0, 50),
        });
        await updateBadge(queue);
        await notifyTabsQueueUpdated();
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg?.type === 'LIMITRA_SET_PROXY') {
    (async () => {
      try {
        const proxyConfig = msg.proxyConfig || { enabled: false };
        await chrome.storage.local.set({ proxyConfig });
        await applyProxySettings(proxyConfig);
        sendResponse({ ok: true, proxyConfig });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg?.type === 'LIMITRA_VARIANT_PROGRESS') {
    chrome.storage.local.set({
      variantFetchProgress: {
        queueId: msg.queueId,
        current: msg.current,
        total: msg.total,
      },
    });
    return false;
  }

  return false;
});


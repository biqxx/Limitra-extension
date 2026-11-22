(() => {
  const globalNS = (window.LimitraAdapters = window.LimitraAdapters || {});

  function getAdapterForHost(hostname = window.location.hostname) {
    const candidates = [globalNS.amazon, globalNS.ebay, globalNS.walmart].filter(Boolean);
    return candidates.find((adapter) => adapter.matchesHost(hostname)) || null;
  }

  globalNS.getAdapterForHost = getAdapterForHost;
})();


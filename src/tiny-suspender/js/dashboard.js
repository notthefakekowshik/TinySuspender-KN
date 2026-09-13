// Per-tab memory is NOT measurable from an extension: chrome.processes, the only
// API that reports per-process memory, is Dev-channel only (the diagnostics page
// says so). A suspended tab reclaims a renderer whose footprint scales with the
// page, so the dashboard reports a rough ESTIMATE, never a measurement. This is
// the flat per-tab figure the estimate multiplies the suspended-tab count by.
const BYTES_PER_TAB = 150 * 1024 * 1024;

// Only the busiest domains are listed; this is a dashboard, not a full report.
const TOP_DOMAINS = 10;


let setRows = (tableId, rows) => {
  let table = document.querySelector('#' + tableId);
  table.textContent = '';

  rows.forEach((row) => {
    let tr = document.createElement('tr');
    let label = document.createElement('td');
    let value = document.createElement('td');
    label.textContent = row[0];
    value.textContent = row[1];
    tr.appendChild(label);
    tr.appendChild(value);
    table.appendChild(tr);
  });
};


class TinySuspenderDashboard {

  constructor() {
    this.debug = false;
    this.chrome = null;
    this.origin = null;
  }

  log() {
    if (this.debug)
      console.log(...arguments);
  }

  setChrome(chrome) {
    this.chrome = chrome;
    this.origin = chrome.runtime.getURL('suspend.html');
  }

  // Matches a suspend placeholder regardless of which extension id owns it, so
  // tabs suspended by another install are recognized too.
  isSuspendPageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      let parsed = new URL(url);
      return parsed.protocol === 'chrome-extension:' && parsed.pathname === '/suspend.html';
    }
    catch (error) {
      return false;
    }
  }

  isOwnSuspendPageUrl(url) {
    return !!url && !!this.origin && url.startsWith(this.origin);
  }

  // Counts every tab into exactly one bucket. A suspend page is matched first
  // because our own suspended tabs are ALSO discarded (the extension swaps the
  // URL, then discards the tab). Letting them fall through to `discarded` as
  // well is the bug that drove the diagnostics page's "live" count negative, so
  // own + orphaned + discarded + live always equals tabs.length.
  classifyTabs(tabs) {
    let buckets = {own: 0, orphaned: 0, discarded: 0, live: 0};

    (tabs || []).forEach((tab) => {
      if (this.isSuspendPageUrl(tab.url)) {
        if (this.isOwnSuspendPageUrl(tab.url)) buckets.own++;
        else buckets.orphaned++;
      }
      else if (tab.discarded) {
        buckets.discarded++;
      }
      else {
        buckets.live++;
      }
    });

    return buckets;
  }

  // Every suspend placeholder — ours and any other install's — from a tab list.
  suspendedPages(tabs) {
    return (tabs || []).filter((tab) => this.isSuspendPageUrl(tab.url));
  }

  // Hostname of the page a suspend tab stands in for. Newer suspend pages carry
  // it in the `url` query param; the legacy format puts it in `#uri=`. Anything
  // unrecoverable goes to '(unknown)' rather than being dropped.
  domainForSuspendTab(tab) {
    let raw = (tab && tab.url) || '';
    let pageUrl = null;

    try {
      let suspendUrl = new URL(raw);
      pageUrl = suspendUrl.searchParams.get('url');

      if (!pageUrl && suspendUrl.hash) {
        let hashParams = new URLSearchParams(suspendUrl.hash.replace(/^#/, ''));
        pageUrl = hashParams.get('uri');
      }
    }
    catch (error) {
      return '(unknown)';
    }

    if (!pageUrl) return '(unknown)';

    try {
      let hostname = new URL(pageUrl).hostname;
      return hostname || '(unknown)';
    }
    catch (error) {
      return '(unknown)';
    }
  }

  // [{domain, count}] most-suspended first, ties broken alphabetically so the
  // table is stable between loads.
  groupByDomain(suspendTabs) {
    let counts = {};

    (suspendTabs || []).forEach((tab) => {
      let domain = this.domainForSuspendTab(tab);
      counts[domain] = (counts[domain] || 0) + 1;
    });

    return Object.keys(counts)
      .map((domain) => ({domain: domain, count: counts[domain]}))
      .sort((a, b) => (b.count - a.count) || a.domain.localeCompare(b.domain));
  }

  // ESTIMATE ONLY — see BYTES_PER_TAB. Suspended-tab count times a flat,
  // per-tab constant; it is never a measurement.
  estimateReclaimedBytes(suspendedCount) {
    return suspendedCount * BYTES_PER_TAB;
  }

  formatBytes(bytes) {
    if (!bytes || bytes < 0) return '0 MB';

    let megabytes = bytes / (1024 * 1024);
    if (megabytes < 1024) {
      return Math.round(megabytes) + ' MB';
    }

    return (Math.round((megabytes / 1024) * 10) / 10) + ' GB';
  }

  render(tabs) {
    let buckets = this.classifyTabs(tabs);
    let suspended = buckets.own + buckets.orphaned;

    setRows('summary', [
      ['Total tabs', String(tabs.length)],
      ['Suspended by Tiny Suspender', String(buckets.own)],
      ['Suspended by another install (orphaned)', String(buckets.orphaned)],
      ['Suspended by native tab discard', String(buckets.discarded)],
      ['Live (not suspended)', String(buckets.live)],
      ['Estimated memory reclaimed (estimate, not measured)', this.formatBytes(this.estimateReclaimedBytes(suspended))]
    ]);

    let domains = this.groupByDomain(this.suspendedPages(tabs)).slice(0, TOP_DOMAINS);
    setRows('domains', domains.map((entry) => [entry.domain, String(entry.count)]));
  }

  init() {
    document.querySelector('#version_string').textContent = 'v' + this.chrome.runtime.getManifest().version;

    this.chrome.storage.sync.get('dark_mode', (items) => {
      if (items.dark_mode) document.body.classList.add('dark-mode');
    });

    this.chrome.tabs.query({}, (tabs) => {
      this.render(tabs);
    });
  }

}


let tsd = new TinySuspenderDashboard();

if (this.chrome) {
  tsd.setChrome(chrome);
  tsd.init();
}


try {
  module.exports = tsd;
}
catch (err) {

}

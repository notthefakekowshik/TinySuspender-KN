// Per-tab memory is NOT measurable from an extension: chrome.processes, the only
// API that reports per-process memory, is Dev-channel only (the diagnostics page
// says so). A suspended tab reclaims a renderer whose footprint scales with the
// page, so the dashboard reports a rough ESTIMATE, never a measurement. This is
// the flat per-tab figure the estimate multiplies the suspended-tab count by.
const BYTES_PER_TAB = 150 * 1024 * 1024;

// Only the busiest domains are listed; this is a dashboard, not a full report.
const TOP_DOMAINS = 10;

// How many history samples the table shows. The window core.js keeps in
// storage.local holds more of them; this page is a summary, not a log.
const HISTORY_ROWS = 24;

// Written by the service worker (core.js), so a sample is taken even when this
// page is closed.
const HISTORY_KEY = 'suspendHistory';

// Why a reclaim (or the idle sweep) left a tab alone, in words. The states come
// from core's getTabState.
const SKIP_LABELS = {
  'suspendable:auto_disabled': 'automatic suspension is off',
  'suspendable:form_changed': 'unsaved form data',
  'suspendable:audible': 'playing audio',
  'suspendable:pinned': 'pinned',
  'suspendable:offline': 'offline',
  'suspendable:tab_whitelist': 'snoozed on that tab',
  'suspendable:url_whitelist': 'whitelisted url',
  'suspendable:domain_whitelist': 'whitelisted domain',
  'suspendable:no_response': 'did not respond',
  'suspendable:busy': 'busy (transfer, live connection or picture-in-picture)',
  'nonsuspendible:temporary_disabled': 'suspension turned off for that tab',
  'nonsuspendible:system_page': 'system page',
  'nonsuspendible:discarded': 'already discarded',
  'nonsuspendible:not_running': 'content script not running',
  'nonsuspendible:error': 'state could not be read',
};


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

let setTable = (tableId, headers, rows) => {
  let table = document.querySelector('#' + tableId);
  table.textContent = '';

  let head = document.createElement('tr');
  headers.forEach((text) => {
    let th = document.createElement('th');
    th.textContent = text;
    head.appendChild(th);
  });
  table.appendChild(head);

  rows.forEach((row) => {
    let tr = document.createElement('tr');
    row.forEach((text) => {
      let td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
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

  // Newest first, capped at what the table shows. Kept free of formatting so it
  // can be asserted directly.
  historyRows(samples, limit) {
    return (samples || [])
      .slice(-(limit || HISTORY_ROWS))
      .reverse()
      .map((sample) => {
        let suspended = (sample.own || 0) + (sample.orphaned || 0);
        return {
          at: sample.at,
          suspended: suspended,
          estimated: this.estimateReclaimedBytes(suspended),
        };
      });
  }

  formatTime(at) {
    if (!at) return '(unknown)';
    return new Date(at).toLocaleString();
  }

  // What the reclaim reports when it finishes: how many idle tabs were examined,
  // how many were suspended, and in words why the rest were left alone.
  reclaimSummary(stats) {
    if (!stats) return '';
    if (!stats.total) return 'No background tab has been idle that long.';

    let skipped = Object.keys(stats.skipped || {}).map((state) =>
      (SKIP_LABELS[state] || state) + ' (' + stats.skipped[state] + ')');

    let summary = 'Suspended ' + stats.suspended + ' of ' + stats.total + ' idle tab(s)';
    if (skipped.length) summary += '. Skipped ' + skipped.join(', ');

    return summary + '.';
  }

  renderHistory(samples) {
    let rows = this.historyRows(samples);
    setTable('history', ['When', 'Suspended', 'Estimated reclaimed'],
      rows.map((row) => [this.formatTime(row.at), String(row.suspended), this.formatBytes(row.estimated)]));
  }

  refresh() {
    this.chrome.tabs.query({}, (tabs) => this.render(tabs));

    this.chrome.storage.local.get([HISTORY_KEY], (items) => {
      this.renderHistory(items && items[HISTORY_KEY]);
    });
  }

  onReclaim() {
    let button = document.querySelector('#reclaim_now');
    let message = document.querySelector('#reclaim_message');
    let minAgeMinutes = parseInt(document.querySelector('#reclaim_age').value);

    button.disabled = true;
    message.textContent = 'Suspending idle tabs…';

    this.chrome.runtime.sendMessage({command: 'ts_reclaim_idle_tabs', minAgeMinutes: minAgeMinutes}, (response) => {
      if (this.chrome.runtime.lastError) {
        button.disabled = false;
        message.textContent = 'Could not start: ' + this.chrome.runtime.lastError.message;
        return;
      }

      if (response && response.error) {
        button.disabled = false;
        message.textContent = 'Could not start: ' + response.error;
        return;
      }

      // A sweep that was already running is not an error: polling picks up the
      // one in flight.
      this.pollReclaim();
    });
  }

  // The sweep navigates every tab it reclaims, so core paces it. Poll like the
  // options page does for adoption, and report what it skipped at the end.
  pollReclaim() {
    let button = document.querySelector('#reclaim_now');
    let message = document.querySelector('#reclaim_message');

    let poll = setInterval(() => {
      this.chrome.runtime.sendMessage({command: 'ts_reclaim_status'}, (response) => {
        let stats = response && response.stats;

        if (response && response.running) {
          message.textContent = 'Suspending idle tabs… '
            + (stats ? stats.processed + ' of ' + stats.total : '');
          return;
        }

        clearInterval(poll);
        button.disabled = false;
        message.textContent = this.reclaimSummary(stats) || 'Nothing was reclaimed.';
        this.refresh();

        // core samples the history shortly after the sweep finishes, once the
        // swaps it made have landed; pick that row up as well.
        setTimeout(() => this.refresh(), 2500);
      });
    }, 500);
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

    document.querySelector('#reclaim_now').onclick = this.onReclaim.bind(this);

    this.refresh();
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

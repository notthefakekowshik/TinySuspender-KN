# Changelog

What each release changes and why, newest first. The version numbers match
`src/tiny-suspender/manifest.json` and `package.json` (a test keeps the two in sync), and
each release lists the branch(es) that make it up, since features land on their own branch
before being merged.

When you bump the version, add a section here in the same commit.

## 2.6.0 — 2026-09-13 (branch: memory-dashboard)

- Added a Memory Dashboard (`dashboard.html`), linked from Settings next to Diagnostics, that shows
  at a glance how many tabs are suspended: by Tiny Suspender, by another install (orphaned), and by
  native tab discard, alongside the live count and the top 10 domains by suspended-tab count.
- The dashboard reports "estimated memory reclaimed" — but that figure is explicitly an estimate,
  never a measurement. Per-tab memory is not measurable from an extension because `chrome.processes`,
  the only per-process memory API, is Dev-channel only.
- The estimate is the suspended-tab count times a flat 150 MB-per-tab constant, a rough stand-in for
  the renderer a suspension reclaims.

## 2.5.1 — 2026-09-13 (branch: `alarm-scheduler`)

- Auto-suspension now runs from a single one-minute alarm that scans for idle tabs, instead of one
  alarm per background tab. Chrome caps an extension at 500 alarms, so past roughly that many tabs
  the old model silently stopped scheduling suspensions — and restoring a session created one alarm
  (and one `chrome.alarms.get`) per tab.
- A tab counts as idle from `tabs.Tab.lastAccessed`, so no per-tab timers are needed and the clock
  survives a worker restart. Suspensions are capped per tick, so a large idle set drains gradually
  instead of navigating hundreds of tabs at once.
- Diagnostics reports the scheduler instead of listing every alarm, and `Live (not suspended)` no
  longer goes negative: our own suspended tabs are discarded too, so they were being subtracted twice.

## 2.5.0 — 2026-09-13 (branches: `install-migration`, `adopt-throttle`, `scale-fixes`)

### Cross-install migration (branch: `install-migration`)

- Suspended tabs now survive switching installs. A suspend page is recognized by its URL
  shape instead of this extension's id, so tabs left behind by another install still count
  as suspended and can be restored rather than being treated as dead foreign pages.
- Settings gain **Export/Import Suspended Tabs** and **Export/Import Settings**. Exporting
  before removing an install and importing afterwards keeps tabs suspended, and the same
  importer accepts suspend urls recovered from History or a "Bookmark all tabs" dump when
  the tabs were already closed.
- Suspended tabs held by another install can be adopted in one click (popup or Settings),
  re-homing them onto this install with their params intact so they stay suspended. The
  sweep is paced in small batches — each adoption is a navigation — so a large set no
  longer floods the browser; progress is shown and the active tab is adopted last. On
  startup it is opt-in, so a still-installed build is never hijacked.

### Large-session scaling (branch: `scale-fixes`)

- Discarding suspended tabs is paced like adoption, so startup no longer fires a discard
  at every suspended tab in one pass.
- Switching tabs no longer re-checks every background tab for a suspension timer. Only the
  tab that just left the foreground is checked, removing an O(tabs) cost from every switch
  that made a few-hundred-tab session feel stuck.

## 2.4.0 — 2026-09-13 (branch: `lab-and-diagnostics`)

- Suspension now discards the suspend placeholder, which is what actually reclaims memory
  (measured ~337 MB for a 200 MB page). Swapping the URL alone reclaimed nothing: the old
  document stayed alive in the back/forward cache, keeping its renderer running.
- Suspended tabs show the site's favicon again, taken from Chrome's own favicon store so
  the dimming is never blocked by a tainted canvas. Also covers suspended tabs that carry
  no favicon, such as "open link in new suspended tab".
- Added `diagnostics.html` (environment, alarm budget, per-process memory) and `lab/`, a
  zero-dependency harness that measures suspension against upstream.

## 2.3.0 — 2026-09-12 (branches: `background-black`, `robustness-fixes`, `youtube-resume`, `busy-sensor`)

- Persistent scroll restore, stronger form protection, and fail-safe suspension timeouts,
  so suspension no longer loses scroll position or gives up on unresponsive pages.
- YouTube videos resume at the position they were suspended from.
- Tabs with a live connection, an in-flight transfer, or picture-in-picture are no longer
  auto-suspended.
- Suspended pages render on a black background instead of the default white flash.

## 2.2.0 and earlier

Upstream Tiny Suspender. The store-facing changelog up to v2.1.0 lives in
[store-entry.md](store-entry.md).

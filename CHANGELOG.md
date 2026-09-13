# Changelog

What each release changes and why, newest first. The version numbers match
`src/tiny-suspender/manifest.json` and `package.json` (a test keeps the two in sync), and
each release lists the branch(es) that make it up, since features land on their own branch
before being merged.

When you bump the version, add a section here in the same commit.

## Unreleased

### Cross-install migration (branch: `install-migration`)

- Suspended tabs now survive switching installs. A suspend page is recognized by its URL
  shape instead of this extension's id, so tabs left behind by another install still count
  as suspended and can be restored rather than being treated as dead foreign pages.
- Settings gain **Export/Import Suspended Tabs** and **Export/Import Settings**. Exporting
  before removing an install and importing afterwards keeps tabs suspended, and the same
  importer accepts suspend urls recovered from History or a "Bookmark all tabs" dump when
  the tabs were already closed.
- Suspended tabs held by another install can be adopted in one click (popup or Settings),
  re-homing them onto this install with their params intact so they stay suspended. On
  startup it is opt-in, so a still-installed build is never hijacked.

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

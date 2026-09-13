# Memory lab

Measures what tab suspension actually reclaims, in a real browser, with **zero
dependencies**. The extension cannot answer these questions from the inside:
there is no per-tab memory API available to a Manifest V3 extension on stable
Chrome (`chrome.processes` is Dev-channel only), so the measurements live here.

```sh
node lab/memory-lab.js              # headless
node lab/memory-lab.js --headed     # visible window
node lab/memory-lab.js --keep       # leave the browser running to poke at
CHROME_PATH=/path/to/chromium node lab/memory-lab.js
```

## What it measures

| Scenario | Question |
| --- | --- |
| discard probe | What does `chrome.tabs.discard` do to the tab list? |
| heavy page | How much renderer memory does a 200 MB page cost, and how much comes back when suspended? |
| native discard | What does native discard reclaim on the same page, without any URL swap? |
| same-site pair | Do two same-site tabs share one renderer, and does suspending one of them free anything? |
| cross-site pair | Does suspending one of two different sites reclaim a whole renderer? |
| opener pair | Same question for a tab opened by the page (`window.open`), which shares a browsing instance. |
| busy sensor | Does an open WebSocket actually block auto-suspension, and does closing it unblock? |
| alarm budget | How many `chrome.alarms` does the extension hold as tabs pile up? (Chrome caps an extension at 500.) |
| diagnostics page | Does `diagnostics.html` render its environment table in a real browser? |

## The 20-tab comparison (Brave 152, macOS, headless, Memory Saver disabled)

Twenty tabs of the same page, measured live, then suspended the upstream way
(URL swap only, discard paths neutralized), then suspended this fork's way
(swap + discard) — same browser, same session, same pages.

| 20 tabs | Live | Upstream suspension (swap only) | This fork (swap + discard) |
| --- | --- | --- | --- |
| Light pages | 3140 MB / 20 renderers | 3170 MB / 20 renderers | 418 MB / 0 renderers |
| 50 MB pages | 4292 MB / 20 renderers | 4303 MB / 20 renderers | 426 MB / 0 renderers |
| 200 MB pages | 7357 MB / 20 renderers | 7369 MB / 20 renderers | 422 MB / 0 renderers |

Baseline (browser plus one control tab, no page tabs): 388 / 419 / 427 MB.
Memory returned per suspended tab: 138 / 194 / 347 MB.

The upstream algorithm leaves every renderer running — its suspended numbers
land within noise of the live ones, and the placeholder pages even add a little.
Discarding is what returns the memory.

## Findings (Brave 152, macOS, headless)

| Question | Result |
| --- | --- |
| Memory added by a 200 MB page | ~350 MB, in its own renderer |
| Reclaimed by the URL swap alone | **~0 MB** — the document survives in the back/forward cache, so its renderer never dies |
| Reclaimed once the placeholder is discarded | **~340 MB** |
| Native discard without a swap | ~345 MB (same win, page state preserved) |
| Two independently opened same-site tabs | separate renderers; suspending one frees its own ~295 MB |
| Auto-suspension with an open WebSocket | blocked; allowed again once the socket closes |
| Alarm growth | one alarm per background tab, linear toward the 500 cap |

Platform facts worth remembering:

- Discarding is what reclaims memory; the URL swap is only bookkeeping. The
  extension discards the placeholder as soon as its URL commits.
- The retained document is genuinely alive, and the back/forward cache explains
  it: walking the tab's history back through `Page.navigateToHistoryEntry`
  returns the **same document instance** (same in-page marker, same JS state),
  and the memory stays flat for a full minute until something discards it.
  `Cache-Control: no-store` does not change that in this build.
- `chrome.tabs.goBack` **cannot** make that navigation — from the placeholder it
  fails with "Cannot find a next page in history" even though
  `Page.getNavigationHistory` shows the entry (index 1 of 2) and the protocol can
  walk it. Use the protocol to test history, not the tabs API.
- `chrome.tabs.discard` replaces the tab's WebContents, so `chrome.tabs` reports
  a **new tab id** afterwards, with **no events fired** for the change. Anything
  holding a tab id across a discard (including this lab) must re-resolve it.

## How it works

1. Serves `lab/pages/*.html` on `localhost:8123`, including a minimal RFC6455
   websocket endpoint so the socket page can hold a real connection.
2. Launches Brave/Chromium/Chrome-for-Testing with `--load-extension` pointing
   at `src/tiny-suspender` and a throwaway profile.
3. Drives the extension through its service worker over the DevTools protocol
   (`ts.suspendTab` / `ts.autoSuspendTab`), exactly like the popup does.
4. Samples renderer processes with `ps -ww -Ao pid=,rss=,command=` filtered by
   the throwaway profile directory, and waits for two consecutive identical
   readings before recording.
5. Prints a markdown table of results and cleans up the browser and profile.

## Caveats

- Branded **Chrome 137+ refuses `--load-extension`**; the lab prefers Brave,
  Chromium, Chrome for Testing, and only falls back to Chrome last.
- `ps` RSS is shared-inclusive and not the same as private memory. Absolute
  values differ from Chrome's Task Manager; the **deltas** are the point.
- The extension's own idle alarm would not fire during a short run, so the lab
  triggers suspension explicitly rather than waiting for the timer.

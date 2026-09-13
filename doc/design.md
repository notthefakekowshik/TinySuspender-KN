Design Document
===============

Goals
-----

- small extension size and memory footprint
- packed with essential features
- should not contain bloated or rarely used features
- should not slow the browser down


Feature Set
===========

Extension Pop-up
-----------------

- Status Section:
    - Display status of current tab
    - Status: Display user-friendly text derived from suspender's state

- Suspension Commands:
    - Suspend Tab: Suspend current tab.
    - Suspend All Tabs: Suspend all tabs in current browser window
    - Suspend Other Tabs: Suspend all tabs in current browser window except the 
      foreground tab

- Tab Restore Commands:
    - Restore Tab: Restore current tab (if suspended)
    - Restore All Suspended Tabs: Restore all suspended tabs in current browser 
      window

- Automatic Suspension Commands:
    - Disable automatic suspension on this tab: Prevent automatic suspension for current 
      tab
    - Enable automatic suspension on this tab

- Whitelisting
    - Add current page to whitelist

- Settings Section:
    - Settings: Open settings page
    - Quick settings:
        - Automatically suspend backgroud tabs after (minutes)


Settings
--------

- Automatically suspend backgroud tabs after (minutes): integer
- Whitelist: text
- Automatically restore suspended tab when brought to foreground: boolean
- Don't automatically suspend audible tabs: boolean

- Experimental: added option to use chrome.tabs.discard api from CORE
  - https://developer.chrome.com/extensions/tabs#method-discard
  - programmatic restore is not available when using this feature
  - active tab cannot be suspended when using the tab discard api


Internals
=========

Suspender's State
-----------------
- `suspendable`
    - `auto`: Green icon. the page will be suspended automatically.
    - `auto_disabled`: Yellow icon. the page will NOT be suspended automatically
       since automatic suspension is disable.
    - `form_changed`: Yellow icon. the page will NOT be suspended automatically.
      Manual suspension is still possible
    - `no_response`: Yellow icon. the content script did not answer in time.
      The page will NOT be suspended automatically. Manual suspension is still
      possible
    - `busy`: Yellow icon. the page is mid-transfer, holds a live connection or
      is showing a picture-in-picture video, so it will NOT be suspended
      automatically. Manual suspension is still possible
    - `audible`: Yellow icon. the page will NOT be suspended automatically.
      Manual suspension is still possible
    - `pinned`: Yellow icon. the page will NOT be suspended automatically.
      Manual suspension is still possible
    - `offline`: Yellow icon. The page will NOT be suspended automatically.
      Manual suspension is still possible
    - `tab_whitelist`: Yellow icon. the page will NOT be suspended automatically.
      Manual suspension is still possible
    - `url_whitelist`: Yellow icon. the page will NOT be suspended automatically.
      Manual suspension is still possible
- `nonsuspenable`
    - `temporary_disabled`: The user temporarily disable automatic tab suspension 
       for this tab
    - `system_page`: Gray icon. system page cannot be suspended
    - `not_running`: Red icon. content script is not running. Suspension is not 
       possible
    - `discarded`: Red icon. This tab is currently suspended via native tab discard
    - `error`: Red icon. unknown error: Suspension is not 
       possible
- `suspended`
    - `suspended`: Standard icon. the page is already suspended. Can be restored


IPC Commands (CORE)
-------------------
- `ts_suspend_tab`: suspend specified tab. ignore whitelists and form changed status.
- `ts_auto_suspend_tab`: suspend specified tab. respect whitelist and form changed status.
- `ts_restore_tab`: restore specified tab
- `ts_tab_disable_auto_suspension`: temporarily disable automatic suspension on 
   specified tab
- `ts_tab_enable_auto_suspension`: enable automatic suspension on specified tab
- `ts_whitelist_url`: whitelist specified url
- `ts_get_tab_state`: get state of specified tab. It will ask content script 
  for state, and then override the returned value if necessary


Suspension and memory reclaim
-----------------------------
Swapping a tab's URL to the suspend page does not free anything by itself: the
original document stays alive in the back/forward cache, so its renderer keeps
running. The suspended tab is therefore discarded once the placeholder URL has
committed (driven by tabs.onUpdated), which is what actually reclaims the
renderer. Measured with lab/memory-lab.js on Brave 152: a 200 MB page reclaims
~0 MB from the URL swap alone and ~340 MB once the placeholder is discarded;
native discard without any swap reclaims the same ~345 MB.

Note for future work: discarding replaces the tab's WebContents, so chrome.tabs
reports a *new* tab id afterwards — and fires no events for the change. Never
hold a tab id across a discard; look it up again with a fresh tabs.query.


Page Agent (MAIN world)
-----------------------
`js/page-agent.js` runs in the page's own context at document_start, before any
page script can capture the platform APIs. It wraps fetch/XHR and tracks
WebSocket, EventSource, RTCPeerConnection and picture-in-picture, then posts a
single busy boolean to the content script via window.postMessage. Requests that
stay in flight for less than 3 seconds are ignored so polling and analytics
beacons cannot block suspension. The agent only ever observes, and only shares
that one boolean with the extension.


IPC Commands (Content Script)
-----------------------------
- `ts_get_tab_state`: answer with `suspendable:auto` or `suspended:suspended`.
  May be overridden by CORE
- `ts_get_tab_scroll`: answer with current scroll position. e.g. `{x: 0, y: 0}`
- `ts_get_tab_media`: answer with the current media playback position.
  e.g. `{media: {currentTime: 754}}`
- `ts_set_tab_scroll`: set current page scroll position.
  - parameter:
    - `scroll`: e.g. `{x: 0, y: 0}`

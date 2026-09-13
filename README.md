# Tiny Suspender

Unload idle tabs to reduce memory and cpu usage.

Available on Chrome Web Store: https://chrome.google.com/webstore/detail/tiny-suspender/bbomjaikkcabgmfaomdichgcodnaeecf


## Features

- Automatically suspend background tabs. All suspended background tabs are
  grouped within a single process, significantly reducing memory and cpu usage.
- Form changes detection to prevent losing edit data on unsubmitted forms.
- Whitelisting to prevent specific site/pages from getting suspended. Regex is supported.
- Temporarily disable automatic suspension on a specific tabs or domains.
- Optional automatic restore when suspended tabs brought to foreground.
- Open links in new suspended tab.


## Screenshots

![Main Menu](https://raw.githubusercontent.com/arifwn/TinySuspender/master/store-assets/screenshot-1.png)

![Suspended Page](https://raw.githubusercontent.com/arifwn/TinySuspender/master/store-assets/screenshot-2.png)

![Context Menu Integration](https://raw.githubusercontent.com/arifwn/TinySuspender/master/store-assets/screenshot-3.png)

![Settings](https://raw.githubusercontent.com/arifwn/TinySuspender/master/store-assets/screenshot-4.png)

![Form Detection](https://raw.githubusercontent.com/arifwn/TinySuspender/master/store-assets/screenshot-5.png)

## Migrating Between Installs

A suspended tab is a tab whose URL was swapped to this extension's `suspend.html`, so the
tab itself is the only copy of the suspended page's data. Removing an extension closes
those tabs. Before switching installs (for example from the store build to a locally
loaded copy):

1. Open **Settings** and use **Export Suspended Tabs** to save `tiny-suspender-tabs.json`,
   and **Export Settings** to save your whitelist and preferences.
2. Remove the old extension and load the new one.
3. In the new install, use **Import Suspended Tabs** (choose the JSON file, or paste suspend
   urls) and **Import Settings**.

If the tabs were already closed, their suspend urls can still be recovered from Chrome's
History (`Ctrl+H`) or a "Bookmark all tabs" dump (`Ctrl+Shift+D`) taken beforehand, and
pasted into the import box.

When a previous install is still present and holding suspended tabs, the new install can
take them over with **Adopt Suspended Tabs From Another Install** (also offered in the
popup when orphaned tabs are detected), or automatically by enabling the opt-in in
Settings.

## Notes

- Manifest v2 version of Tiny Suspender is available here: https://github.com/arifwn/TinySuspender-manifest-v2 . The manfest v2 version is no longer maintained.

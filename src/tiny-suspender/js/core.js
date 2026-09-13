// Adopting a tab navigates it, which reloads the suspend page and is then
// discarded. Firing a whole set at once floods the browser with renderer churn
// (memory stays low, but the UI can appear to hang), so the sweep runs in small
// batches instead.
const ADOPT_BATCH_SIZE = 3;
const ADOPT_BATCH_DELAY_MS = 250;


class TinySuspenderCore {

  constructor() {
    this.debug = false;
    this.log('start');
    this.chrome = null;

    // tabState is used to store per-tab status overrides,
    // e.g. don't suspend this tab for one hour, don't suspend for now, etc
    this.tabState = {};
    this.tabScrolls = {};
    this.excludedDomains = {};

    // Guards the paced adoption sweep so a second request cannot start a
    // parallel sweep over the same tabs.
    this.adoptInProgress = false;
    this.adoptCount = 0;

    this.idleTimeMinutes = 30;
    this.whitelist = [];
    this.autorestore = false;
    this.skipAudible = false;
    this.skipPinned= false;
    this.skipWhenOffline = false;
    this.enableTabDiscard = false;

    this.darkMode = false;
    this.autoAdoptOnStartup = false;

    // Tracks the first settings load so alarm-creating paths don't
    // race with readSettings and use the constructor's default 30 min.
    this.settingsReady = Promise.resolve();
  }

  log() {
    if (this.debug)
      console.log(...arguments);
  }

  saveState() {
    this.chrome.storage.local.set({'tabState': this.tabState, 'excludedDomains': this.excludedDomains}, () => {
      this.log('state saved');
    });
  }

  loadState() {
    this.chrome.storage.local.get(['tabState', 'excludedDomains'], (items) => {
      var tabState = items.tabState;
      if (!tabState) {
        this.tabState = {};
      }
      else {
        this.tabState = tabState;
      }

      var excludedDomains = items.excludedDomains;
      if (!excludedDomains) {
        this.excludedDomains = {};
      }
      else {
        this.excludedDomains = excludedDomains;
      }

      this.trimState();
      this.log('state loaded', this.tabState, this.excludedDomains);
    });
  }

  scrollKey(tabId) {
    return 'scroll_' + tabId;
  }

  // The scroll handoff is mirrored in storage.session: it only needs to survive
  // until the restored page reports 'complete', but that window can outlast
  // this service worker instance. Keys are per tab so concurrent restores
  // never clobber each other.
  saveTabScroll(tabId, scroll) {
    this.tabScrolls[tabId] = scroll;
    this.chrome.storage.session.set({[this.scrollKey(tabId)]: scroll});
  }

  clearTabScroll(tabId) {
    delete this.tabScrolls[tabId];
    this.chrome.storage.session.remove(this.scrollKey(tabId));
  }

  trimState() {
    this.chrome.tabs.query({}, (tabs) => {
      let tabIds = {};
      tabs.forEach((tab) => {
        tabIds[tab.id] = tab.id;
      });

      for (let key in this.tabState) {
        if (this.tabState.hasOwnProperty(key)) {
          if (!tabIds[key]) {
            this.log('trimming', key);
            delete this.tabState[key];
          }
        }
      }
      this.saveState();
    });
  }

  setChrome(chrome) {
    this.chrome = chrome;
    this.chrome.runtime.onMessage.addListener(this.eventHandler.bind(this));
    
    this.loadState();
    this.chrome.runtime.onSuspend.addListener(this.saveState.bind(this));

    this.chrome.tabs.onUpdated.addListener(this.onTabUpdated.bind(this));
    this.chrome.tabs.onActivated.addListener(this.onTabActivated.bind(this));
    this.chrome.tabs.onRemoved.addListener(this.onTabRemoved.bind(this));
    this.chrome.tabs.onCreated.addListener(this.onTabCreated.bind(this));
    this.chrome.runtime.onInstalled.addListener(this.onPluginInstalled.bind(this));
    this.chrome.contextMenus.onClicked.addListener(this.onContextMenuClickHandler.bind(this));
    this.chrome.commands.onCommand.addListener(this.onCommand.bind(this));

    this.settingsReady = this.readSettings();
    this.chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace !== 'sync') return;

      const timerKeys = [
        'idleTimeMinutes',
        'skip_audible',
        'skip_pinned',
        'skip_when_offline',
        'whitelist',
        'enable_tab_discard'
      ];
      const affectsTimers = timerKeys.some((key) => key in changes);

      this.readSettings();
      if (affectsTimers) {
        this.resetAutoSuspensionTimers();
      }
    });
    this.chrome.alarms.onAlarm.addListener(this.onAlarm.bind(this));
    this.initTimersForBackgroundTabs();
    this.discardInactiveSuspendedTabs();
  }

  readSettings() {
    let promise = new Promise((resolve, reject) => {
      this.chrome.storage.sync.get([
        'idleTimeMinutes',
        'autorestore',
        'whitelist',
        'skip_audible',
        'skip_pinned',
        'skip_when_offline',
        'enable_tab_discard',
        'dark_mode',
        'auto_adopt'], (items) => {
        this.autorestore = items.autorestore;
        this.skipAudible = items.skip_audible;
        this.skipPinned = items.skip_pinned;
        this.skipWhenOffline = items.skip_when_offline;
        this.enableTabDiscard = items.enable_tab_discard;
        this.darkMode = items.dark_mode;
        this.autoAdoptOnStartup = !!items.auto_adopt;

        this.idleTimeMinutes = parseInt(items.idleTimeMinutes);
        if (isNaN(this.idleTimeMinutes)) {
          this.idleTimeMinutes = 30;
        }

        this.whitelist = [];
        if (items.whitelist) {
          let list = items.whitelist.split("\n");

          for (let i = 0; i < list.length; i++) {
            let line = list[i];
            line = line.trim();
            if (line) {
              this.whitelist.push(line);
            }
          }
        }

        resolve({
          idleTimeMinutes: this.idleTimeMinutes,
          whitelist: this.whitelist,
          autorestore: this.autorestore,
          skipAudible: this.skipAudible,
          skipPinned: this.skipPinned,
          skipWhenOffline: this.skipWhenOffline,
          enableTabDiscard: this.enableTabDiscard,
          darkMode: this.darkMode
        });
      });
    });

    return promise;
  }

  isSystemPage(tab) {
    if (!tab) return true;
    
    return !tab.url || 
      tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('about:') ||
      tab.url === '' ||
      tab.title === 'New tab' ||
      tab.title === 'Extensions' ||
      tab.title === 'New Tab';
  }

  isMatch(pattern, string) {
    let isRegex = false;
    if ((pattern.length > 2) && (pattern.charAt(0) == '/') && (pattern.charAt(pattern.length-1) == '/')) {
      pattern = pattern.substr(1, pattern.length-2);
      isRegex = true;
    }

    if (!isRegex) {
      if (string.startsWith(pattern)) {
        return true;
      }
    }
    else {
      let re = new RegExp(pattern);
      if (re.exec(string)) {
        return true;
      }
    }

    return false;
  }

  setIconState(state, tabId) {
    const stateToIcon = {
      normal: 'icon-default-38.png',
      green: 'icon-green-38.png',
      yellow: 'icon-yellow-38.png',
      red: 'icon-red-38.png',
      gray: 'icon-gray-38.png',
    };

    // Use the default icon if the state is not found in the mapping
    const icon = stateToIcon[state] || 'icon-default-38.png';

    let param = {
      path: `chrome-extension://${this.chrome.runtime.id}/img/browser-icons/${icon}`
    }

    if (tabId) {
      param.tabId = tabId;
    }
  
    this.chrome.action.setIcon(param);
  }

  setIconFromStateString(state, tabId) {
    const stateToIconMap = {
      'suspended:suspended': 'normal',
      'suspendable:auto': 'green',
      'suspendable:auto_disabled': 'yellow',
      'suspendable:form_changed': 'yellow',
      'suspendable:audible': 'yellow',
      'suspendable:pinned': 'yellow',
      'suspendable:offline': 'yellow',
      'suspendable:tab_whitelist': 'yellow',
      'suspendable:url_whitelist': 'yellow',
      'suspendable:domain_whitelist': 'yellow',
      'suspendable:no_response': 'yellow',
      'suspendable:busy': 'yellow',
      'nonsuspendible:temporary_disabled': 'yellow',
      'nonsuspendible:system_page': 'gray',
      'nonsuspendible:discarded': 'normal',
      'nonsuspendible:not_running': 'red',
      'nonsuspendible:error': 'red'
    };
  
    const iconState = stateToIconMap[state] || 'red'; // Default to 'red' for unknown states
  
    this.setIconState(iconState, tabId);
  }

  getTabState(tabId) {
    let promise = new Promise((resolve, reject) => {
      this.chrome.tabs.get(tabId, (tab) => {
        if (!tab) {
          reject(new Error('Tab with id: ' + tabId + ' is not found!'));
          return;
        }

        try {
          // Validate URL before creating URL object
          if (!tab.url || typeof tab.url !== 'string' || tab.url.trim() === '') {
            resolve({state: 'nonsuspendible:system_page'});
            return;
          }

          let url = new URL(tab.url);

          if (this.isSuspendPageUrl(tab.url)) {
            resolve({state: 'suspended:suspended'});
            return;
          }

          if (tab.discarded) {
            resolve({state: 'nonsuspendible:discarded'});
            return;
          }

          if (url && url.protocol === 'chrome-extension:') {
            resolve({state: 'nonsuspendible:system_page'});
            return;
          }

          if (url && url.protocol === 'chrome:') {
            resolve({state: 'nonsuspendible:system_page'});
            return;
          }

          if (this.excludedDomains[url.hostname]) {
            resolve({state: 'suspendable:domain_whitelist'});
            return;
          }
        } catch (error) {
          this.log(error);
          resolve({state: 'nonsuspendible:system_page'});
          return;
        }

        let answered = false;

        // Check if this is a system page that won't have content scripts
        if (this.isSystemPage(tab)) {
          // Skip content script communication for system pages
          let state = 'nonsuspendible:system_page';
          answered = true;
          resolve({state: state});
          return;
        }

        // If the content script did not answer within 2 seconds, assume the page
        // may hold unsaved state that we could not detect and don't auto-suspend.
        let timer = setTimeout(() => {
          if (!answered) {
            answered = true;
            resolve({state: 'suspendable:no_response'});
          }
        }, 2000);

        // ask content script for current state
        // Content script may prevent autosuspension if the user has unsaved form data
        const getTabState = (tabId, tab, resolve) => {
          this.chrome.tabs.sendMessage(tabId, {command: 'ts_get_tab_state'}, (response) => {
            this.log('>> ts_get_tab_state', response);
            // suppress chrome.runtime.lastError; missing content script is expected on many pages
            void this.chrome.runtime.lastError;
            
            let state = 'suspendable:auto';
            if (this.idleTimeMinutes == 0) {
              state = 'suspendable:auto_disabled';
            }

            if (response && response.state) {
              state = response.state;
            }

            if (state === 'suspendable:auto' && this.skipAudible && tab.audible) {
              state = 'suspendable:audible';
            }

            if (state === 'suspendable:auto' && this.skipPinned && tab.pinned) {
              state = 'suspendable:pinned';
            }

            if (state === 'suspendable:auto' && this.skipWhenOffline && (!navigator.onLine)) {
              state = 'suspendable:offline';
            }

            // ignore form changes when native tab discard in enabled.
            // native tab discard should be able to persist form data

            if (this.enableTabDiscard && (state == 'suspendable:form_changed')) {
              state = 'suspendable:auto';
            }

            // check this.tabState and whitelist to determine final state
            let storedState = this.tabState[tabId];

            if (storedState && (state != 'suspendable:form_changed')) {
              state = storedState.state;
            }

            // check whitelist

            if (this.whitelist.some(pattern => this.isMatch(pattern, tab.url))) {
              state = 'suspendable:url_whitelist';
            }


            answered = true;
            clearTimeout(timer);
            resolve({state: state});
          });
        }
        getTabState(tabId, tab, resolve);

      });

    });
    return promise;
  }

  getTabScroll(tabId) {
    return new Promise((resolve, reject) => {
      // First check if this tab exists and get its info
      this.chrome.tabs.get(tabId, (tab) => {
        if (this.chrome.runtime.lastError || !tab) {
          resolve({ x: 0, y: 0 });
          return;
        }

        // Check if this is a system page that won't have content scripts
        if (this.isSystemPage(tab)) {
          // Skip content script communication for system pages
          resolve({ x: 0, y: 0 });
          return;
        }

        // Set a timeout for 500 milliseconds
        let timer = setTimeout(() => {
          // If the content script hasn't answered within the timeout, resolve the promise
          resolve({ x: 0, y: 0 });
        }, 500);
    
        // Ask content script for current scroll position
        this.chrome.tabs.sendMessage(tabId, { command: 'ts_get_tab_scroll' }, {}, (response) => {
          clearTimeout(timer);

          if (this.chrome.runtime.lastError) {
            resolve({ x: 0, y: 0 });
          } else {
            resolve(response?.scroll || { x: 0, y: 0 });
          }
        });
      });
    });
  } 

  isYoutubeUrl(url) {
    try {
      let host = new URL(url).hostname;
      return host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com');
    }
    catch (error) {
      return false;
    }
  }

  getTabMedia(tab) {
    return new Promise((resolve) => {
      // Asking every page would cost a round trip for a feature it does not
      // support, so only YouTube tabs are queried.
      if (!tab || !this.isYoutubeUrl(tab.url)) {
        resolve(null);
        return;
      }

      let timer = setTimeout(() => resolve(null), 500);

      this.chrome.tabs.sendMessage(tab.id, {command: 'ts_get_tab_media'}, {}, (response) => {
        clearTimeout(timer);

        if (this.chrome.runtime.lastError) {
          resolve(null);
          return;
        }

        resolve((response && response.media) ? response.media : null);
      });
    });
  }

  isSuspendable(state) {
    if (state && state.split) {
      let suspendable = state.split(':')[0];
      if (suspendable === 'suspendable') return true;
    }
    return false;
  }

  isAutoSuspendable(state) {
    if (state) {
      if (state === 'suspendable:auto') return true;
    }
    return false;
  }

  cancelTabAutosuspensionTimer(tabId) {
    this.log('canceling suspension timer for ', tabId)
    let alarmName = `${tabId}`;
    this.chrome.alarms.clear(alarmName);
  }

  createTabAutosuspensionTimer(tabId) {
    this.log('creating suspension timer for ', tabId)
    let alarmName = `${tabId}`;
    this.chrome.alarms.create(alarmName, {delayInMinutes: this.idleTimeMinutes})
  }

  initTimersForBackgroundTabs() {
    this.log('initTimersForBackgroundTabs');
    this.readSettings()
      .then((settings) => {
        if (settings.idleTimeMinutes == 0) return;
        // The alarm handler re-checks isAutoSuspendable when it fires, so we don't
        // need to query each tab's state here — just ensure an alarm exists.
        this.chrome.tabs.query({ active: false }, (tabs) => {
          tabs.forEach((tab) => this.ensureTabAutosuspensionTimer(tab.id));
        });
      })
      .catch((error) => {});
  }

  resetAutoSuspensionTimers() {
    this.chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        this.cancelTabAutosuspensionTimer(tab.id);
      });
      this.initTimersForBackgroundTabs();
    });
  }

  buildSuspendUrl(tab, scroll, media) {
    let url = 'suspend.html?url=' + encodeURIComponent(tab.url)
         + '&title=' + encodeURIComponent(tab.title)
         + '&favIconUrl=' + encodeURIComponent(tab.favIconUrl)
         + '&scroll_x=' + encodeURIComponent(scroll.x)
         + '&scroll_y=' + encodeURIComponent(scroll.y);

    if (media && media.currentTime > 0) {
      url += '&media_t=' + encodeURIComponent(media.currentTime);
    }

    return url;
  }

  doSuspend(tabId, guard) {
    let tabState;
    this.getTabState(tabId)
      .then((state) => {
        tabState = state;
        return this.getTabScroll(tabId);
      })
      .then((scroll) => {
        if (!guard(tabState.state)) return;
        this.chrome.tabs.get(tabId, (tab) => {
          if (this.enableTabDiscard) {
            this.chrome.tabs.discard(tab.id);
          }
          else if (tab.discarded) {
            this.log('this tab is already suspended via native tab discard: ', tab.id);
          }
          else {
            this.getTabMedia(tab).then((media) => {
              // The discard happens in onTabUpdated once the suspend URL has
              // actually committed; discarding from this callback would cancel
              // the navigation before the placeholder is in place.
              this.chrome.tabs.update(tab.id, {url: this.buildSuspendUrl(tab, scroll, media)});
            });
          }
        });
      })
      .catch((error) => {});
  }

  suspendTab(tabId) {
    this.doSuspend(tabId, this.isSuspendable.bind(this));
  }

  autoSuspendTab(tabId) {
    this.doSuspend(tabId, this.isAutoSuspendable.bind(this));
  }

  restoreTab(tabId) {
    this.chrome.tabs.get(tabId, (tab) => {
      let url = new URL(tab.url);
      if (this.isSuspendPageUrl(tab.url)) {
        this.saveTabScroll(tabId, {
          x: url.searchParams.get('scroll_x'),
          y: url.searchParams.get('scroll_y')
        });

        let pageUrl = url.searchParams.get('url');
        let mediaTime = url.searchParams.get('media_t');
        if (mediaTime) {
          pageUrl = this.addMediaStartTime(pageUrl, mediaTime);
        }

        this.chrome.tabs.update(tab.id, {url: pageUrl});
      }
    });
  }

  isSuspendedUrl(url) {
    return !!url && url.startsWith(this.chrome.runtime.getURL('suspend.html'));
  }

  // Matches a suspend placeholder regardless of which extension id owns it, so
  // tabs suspended by another install are still recognized and recoverable.
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

  // Re-points a tab suspended by a different install onto this extension's own
  // suspend page, keeping every param so the tab stays suspended while becoming
  // discardable and click-to-restore again under this install.
  adoptSuspendedTab(tab) {
    if (!this.isSuspendPageUrl(tab.url) || this.isSuspendedUrl(tab.url)) return false;

    let url = new URL(tab.url);
    if (!url.searchParams.get('url') && !url.hash) return false;

    this.chrome.tabs.update(tab.id, {url: this.chrome.runtime.getURL('suspend.html') + url.search + url.hash});
    return true;
  }

  listOrphanedSuspendedTabs(callback) {
    this.chrome.tabs.query({}, (tabs) => {
      let orphans = tabs.filter((tab) => this.isSuspendPageUrl(tab.url) && !this.isSuspendedUrl(tab.url));

      // Background tabs first: navigating the tab the user is looking at
      // half-way through the sweep is jarring, so it is adopted last.
      orphans.sort((a, b) => (a.active ? 1 : 0) - (b.active ? 1 : 0));

      callback(orphans);
    });
  }

  // Paced on purpose — see ADOPT_BATCH_SIZE. Returns false when a sweep is
  // already running, so callers can tell the request was ignored.
  adoptOrphanedSuspendedTabs(callback) {
    if (this.adoptInProgress) return false;

    this.adoptInProgress = true;
    this.adoptCount = 0;

    this.listOrphanedSuspendedTabs((orphans) => {
      let index = 0;

      let step = () => {
        let limit = Math.min(index + ADOPT_BATCH_SIZE, orphans.length);
        for (; index < limit; index++) {
          if (this.adoptSuspendedTab(orphans[index])) this.adoptCount++;
        }

        if (index < orphans.length) {
          setTimeout(step, ADOPT_BATCH_DELAY_MS);
          return;
        }

        this.adoptInProgress = false;
        if (callback) callback(this.adoptCount);
      };

      step();
    });

    return true;
  }

  countOrphanedSuspendedTabs(callback) {
    this.chrome.tabs.query({}, (tabs) => {
      let count = tabs.filter((tab) => this.isSuspendPageUrl(tab.url) && !this.isSuspendedUrl(tab.url)).length;
      callback(count);
    });
  }

  collectSuspendedTabs(callback) {
    this.chrome.tabs.query({}, (tabs) => {
      let entries = tabs.filter((tab) => this.isSuspendPageUrl(tab.url)).map((tab) => {
        let url = new URL(tab.url);
        return {
          url: url.searchParams.get('url'),
          title: url.searchParams.get('title'),
          favIconUrl: url.searchParams.get('favIconUrl'),
          scroll_x: url.searchParams.get('scroll_x'),
          scroll_y: url.searchParams.get('scroll_y'),
          media_t: url.searchParams.get('media_t'),
          raw: tab.url
        };
      });
      callback(entries);
    });
  }

  // Accepts raw suspend urls (from any install, including the legacy hash format)
  // or entries produced by collectSuspendedTabs, and recreates each as a
  // suspended tab owned by this install.
  importSuspendedTabs(entries, callback) {
    let imported = 0;

    (entries || []).forEach((entry) => {
      if (!entry) return;

      let raw = typeof entry === 'string' ? entry : entry.raw;
      let url;
      try {
        url = new URL(raw);
      }
      catch (error) {
        return;
      }

      if (!url.searchParams.get('url') && !url.hash) return;

      this.chrome.tabs.create({active: false, url: this.chrome.runtime.getURL('suspend.html') + url.search + url.hash});
      imported++;
    });

    if (callback) callback(imported);
  }

  // Swapping the tab URL to the suspend page is not enough on its own: the old
  // document stays alive in the back/forward cache, keeping its renderer (and
  // its memory) running. Discarding the suspended tab is what reclaims it —
  // lab/memory-lab.js measures ~0 MB from the swap alone and ~347 MB for a
  // 200 MB page once the tab is discarded.
  discardSuspendedTab(tabId) {
    this.chrome.tabs.get(tabId, (tab) => {
      if (!tab || tab.active || tab.discarded || !this.isSuspendedUrl(tab.url)) return;
      this.chrome.tabs.discard(tabId, () => { void this.chrome.runtime.lastError; });
    });
  }

  // Chrome refuses to discard the active tab, so a tab suspended while the user
  // was looking at it gets discarded here once it goes to the background.
  discardInactiveSuspendedTabs() {
    this.chrome.tabs.query({active: false}, (tabs) => {
      tabs.forEach((tab) => {
        if (tab.discarded || !this.isSuspendedUrl(tab.url)) return;
        this.chrome.tabs.discard(tab.id, () => { void this.chrome.runtime.lastError; });
      });
    });
  }

  addMediaStartTime(pageUrl, seconds) {
    if (!this.isYoutubeUrl(pageUrl)) return pageUrl;

    try {
      let url = new URL(pageUrl);
      url.searchParams.set('t', seconds + 's');
      return url.toString();
    }
    catch (error) {
      return pageUrl;
    }
  }

  shouldAutorestore(tabId) {
    if (this.autorestore) {
      this.restoreTab(tabId);
    }
  }

  scrollTabToPosition(tabId) {
    let scroll = this.tabScrolls[tabId];
    this.clearTabScroll(tabId);
    this.sendScrollCommand(tabId, scroll);
  }

  applySavedScroll(tabId) {
    if (this.tabScrolls[tabId]) {
      this.scrollTabToPosition(tabId);
      return;
    }

    // The worker may have been torn down between tabs.update and this event,
    // in which case the handoff only exists in storage.session.
    let key = this.scrollKey(tabId);
    this.chrome.storage.session.get([key], (items) => {
      let scroll = items && items[key];
      if (!scroll) return;

      this.chrome.storage.session.remove(key);
      this.sendScrollCommand(tabId, scroll);
    });
  }

  sendScrollCommand(tabId, scroll) {
    this.chrome.tabs.sendMessage(tabId, {command: 'ts_set_tab_scroll', scroll: scroll});
  }

  // event handlers:

  onPluginInstalled() {
    this.chrome.contextMenus.removeAll(() => {
      // Create one test item for each context type.
      var contexts = [
        ["page", "Suspend Tab"],
        ["link", "Open link in new suspended tab"]];
      for (var i = 0; i < contexts.length; i++) {
        var context = contexts[i][0];
        var title = contexts[i][1];
        var id = this.chrome.contextMenus.create({
          "title": title,
          "contexts":[context],
          "id": "context-" + context
        });
      }
    });

    // Off by default: adopting silently would hijack the tabs of a still-installed
    // build, so this only runs when the user opts in.
    this.settingsReady.then(() => {
      if (this.autoAdoptOnStartup) {
        this.adoptOrphanedSuspendedTabs();
      }
    });
  }

  onAlarm(alarm) {
    this.log('timer alarm fired:', alarm);
    let tabId = parseInt(alarm.name);
    if (isNaN(tabId)) return;

    this.autoSuspendTab(tabId);
  }

  onContextMenuClickHandler(info, tab) {
    this.log('context', info);
    if (info.menuItemId === 'context-link') {
      this.chrome.tabs.create({
        active: false,
        url: 'suspend.html?url=' + encodeURIComponent(info.linkUrl)
        + '&title=' + encodeURIComponent(info.linkUrl)
      });
    }
    else {
      this.suspendTab(tab.id);
    }
  };

  onCommand(command) {
    if (command === 'suspend-active-tab') {
      this.chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        tabs.forEach((tab) => {
          let tabId = tab.id;
          this.suspendTab(tabId);
        });
      });
    }
    if (command === 'suspend-all-tabs') {
      this.chrome.tabs.query({lastFocusedWindow: true}, (tabs) => {
        tabs.forEach((tab) => {
          let tabId = tab.id;
          this.autoSuspendTab(tabId);
        });
      });
    }
    if (command === 'suspend-all-tabs-all-windows') {
      this.chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
          let tabId = tab.id;
          this.autoSuspendTab(tabId);
        });
      });
    }
    if (command === 'suspend-other-tabs') {
      this.chrome.tabs.query({ active: false, lastFocusedWindow: true }, (tabs) => {
        tabs.forEach((tab) => {
          let tabId = tab.id;
          this.autoSuspendTab(tabId);
        });
      });
    }
    if (command === 'restore-active-tab') {
      this.chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        tabs.forEach((tab) => {
          let tabId = tab.id;
          this.restoreTab(tabId);
        });
      });
    }
    if (command === 'restore-other-tabs') {
      this.chrome.tabs.query({ active: false, lastFocusedWindow: true }, (tabs) => {
        tabs.forEach((tab) => {
          let tabId = tab.id;
          this.restoreTab(tabId);
        });
      });
    }
    if (command === 'restore-all-tabs') {
      this.chrome.tabs.query({ lastFocusedWindow: true }, (tabs) => {
        tabs.forEach((tab) => {
          let tabId = tab.id;
          this.restoreTab(tabId);
        });
      });
    }
    if (command === 'restore-all-tabs-all-windows') {
      this.chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
          let tabId = tab.id;
          this.restoreTab(tabId);
        });
      });
    }
  }

  onTabUpdated(tabId, changeInfo, tab) {
    if (changeInfo.status === 'complete') {
      this.applySavedScroll(tabId);
    }

    // Safety net for every path that lands a tab on the suspend page (manual,
    // automatic, context menu, autorestore): the swap alone frees nothing, the
    // discard is what returns the memory.
    if (changeInfo.url !== undefined || changeInfo.status === 'complete') {
      this.discardSuspendedTab(tabId);
    }

    // Only refresh the icon for the active tab, and only on changes that can flip state.
    const stateRelevant = changeInfo.url !== undefined
      || changeInfo.audible !== undefined
      || changeInfo.pinned !== undefined
      || changeInfo.discarded !== undefined
      || changeInfo.status === 'complete';
    if (!tab.active || !stateRelevant) return;

    this.getTabState(tabId)
      .then((state) => {
        this.setIconFromStateString(state.state, tabId);
      })
      .catch((error) => {});
  }

  onTabRemoved(tabId, removeInfo) {
    this.cancelTabAutosuspensionTimer(tabId);
    if (this.tabState[tabId]) {
      delete this.tabState[tabId];
      this.saveState();
    }
    this.clearTabScroll(tabId);
  }

  onTabCreated(tab) {
    if (tab.active) return;
    this.ensureTabAutosuspensionTimer(tab.id);
  }

  ensureTabAutosuspensionTimer(tabId) {
    // Wait for the first settings load — without this gate, alarms created
    // immediately after a service-worker wake use the constructor default
    // (30 min) instead of the user's actual idleTimeMinutes.
    this.settingsReady.then(() => {
      if (this.idleTimeMinutes == 0) return;
      let alarmName = `${tabId}`;
      this.chrome.alarms.get(alarmName, (alarm) => {
        if (alarm) return;
        this.createTabAutosuspensionTimer(tabId);
      });
    });
  }

  onTabActivated(activeInfo) {
    let tabId = activeInfo.tabId;
    this.getTabState(tabId)
      .then((state) => {
        this.setIconFromStateString(state.state, tabId);
        if (state.state === 'suspended:suspended') {
          this.shouldAutorestore(tabId);
        }
      })
      .catch((error) => {});

    // The new active tab should not auto-suspend.
    this.cancelTabAutosuspensionTimer(tabId);
    // Chrome's onActivated doesn't tell us which tab was deactivated, so we
    // ensure alarms for all background tabs. ensureTabAutosuspensionTimer is
    // cheap on tabs that already have an alarm (one chrome.alarms.get call).
    this.initTimersForBackgroundTabs();
    // A tab suspended while the user was looking at it could not be discarded
    // yet; now that it is in the background, reclaim its renderer.
    this.discardInactiveSuspendedTabs();
  }

  suspend_tab(request, sender, sendResponse) {
    this.log('suspend_tab');
    this.suspendTab(request.tabId);
  }

  auto_suspend_tab(request, sender, sendResponse) {
    this.log('suspend_tab');
    this.autoSuspendTab(request.tabId);
  }

  restore_tab(request, sender, sendResponse) {
    this.log('restore_tab');
    if (request.tabId) {
      this.restoreTab(request.tabId);
    }
  }

  adopt_orphaned_suspended_tabs(request, sender, sendResponse) {
    let started = this.adoptOrphanedSuspendedTabs((adopted) => sendResponse({adopted: adopted}));
    if (!started) sendResponse({adopted: this.adoptCount, running: true});
    return true;
  }

  count_orphaned_suspended_tabs(request, sender, sendResponse) {
    this.countOrphanedSuspendedTabs((count) => sendResponse({count: count}));
    return true;
  }

  export_suspended_tabs(request, sender, sendResponse) {
    this.collectSuspendedTabs((tabs) => sendResponse({tabs: tabs}));
    return true;
  }

  import_suspended_tabs(request, sender, sendResponse) {
    this.importSuspendedTabs(request.urls, (imported) => sendResponse({imported: imported}));
    return true;
  }

  get_tab_state(request, sender, sendResponse) {
    if (request.tabId) {
      this.getTabState(request.tabId)
      .then((state) => {
        sendResponse(state);
        this.setIconFromStateString(state.state, request.tabId);
      })
      .catch((error) => {
        sendResponse({state: 'nonsuspendible:error'});
      });
      return true;
    }
  }

  update_tab_icon(request, sender, sendResponse) {
    if (sender.tab) {
      this.setIconFromStateString(request.state, sender.tab.id);
      sendResponse(request.state);
    }
  }

  tab_disable_auto_suspension(request, sender, sendResponse) {
    let state = {
      state: 'suspendable:tab_whitelist'
    }
    this.tabState[request.tabId] = state;
    this.saveState();
  }

  tab_enable_auto_suspension(request, sender, sendResponse) {
    if (this.tabState[request.tabId]) {
      delete this.tabState[request.tabId];
      this.saveState();
    }
  }

  disable_auto_suspension_domain(request, sender, sendResponse) {
    this.log('disable_auto_suspension_domain', request.domain);
    this.excludedDomains[request.domain] = true;
    this.saveState();
  }

  enable_auto_suspension_domain(request, sender, sendResponse) {
    this.log('enable_auto_suspension_domain', request.domain);
    if (this.excludedDomains[request.domain]) {
      delete this.excludedDomains[request.domain];
      this.saveState();
    }
  }

  eventHandler(request, sender, sendResponse) {
    if (request.command && request.command.startsWith('ts_')) {
      let command = request.command.substr(3);
      if (this[command]) {
        this.log('calling', command, request, sender);
        let commandFunc = this[command].bind(this);
        return commandFunc(request, sender, sendResponse);
      }
    }

    this.log('unhandled event:', request, sender);
  }

}


let ts = new TinySuspenderCore();

if (this.chrome) {
  ts.setChrome(chrome);
}


try {
  module.exports = ts;
}
catch (err) {

}

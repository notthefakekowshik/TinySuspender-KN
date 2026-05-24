class TinySuspenderPopup {
  constructor() {
    this.debug = true;
    this.chrome = null;
    this.state = null;
    this.idleTimeMinutes = 30;
  }

  log() {
    if (this.debug)
      console.log(...arguments);
  }

  setChrome(chrome) {
    this.chrome = chrome;
  }

  initEventHandlers() {
    document.querySelector('.suspend-btn').onclick = this.onSuspend.bind(this);
    document.querySelector('.suspend-all-btn').onclick = this.onSuspendAll.bind(this);
    document.querySelector('.suspend-all-windows-btn').onclick = this.onSuspendAllWindows.bind(this);
    document.querySelector('.suspend-others-btn').onclick = this.onSuspendOthers.bind(this);
    document.querySelector('.restore-btn').onclick = this.onRestore.bind(this);
    document.querySelector('.restore-all-btn').onclick = this.onRestoreAll.bind(this);
    document.querySelector('.restore-all-windows-btn').onclick = this.onRestoreAllWindows.bind(this);

    document.querySelector('.disable-tab-auto-suspend-btn').onclick = this.onDisableAutoSuspensionThisTab.bind(this);
    document.querySelector('.enable-tab-auto-suspend-btn').onclick = this.onEnableAutoSuspensionThisTab.bind(this);

    document.querySelector('.disable-tab-auto-suspend-domain-btn').onclick = this.onDisableAutoSuspensionThisDomain.bind(this);
    document.querySelector('.enable-tab-auto-suspend-domain-btn').onclick = this.onEnableAutoSuspensionThisDomain.bind(this);

    document.querySelector('.add-to-whitelist-btn').onclick = this.onAddPageToWhitelist.bind(this);

    document.querySelector('.settings-btn').onclick = this.onSettings.bind(this);

    document.querySelector('#config').onsubmit = this.onQuickSettingsSubmit.bind(this);
    document.querySelector('#config input').onchange = this.onQuickSettingsChanged.bind(this);
  }

  initQuickSettings() {
    this.chrome.storage.sync.get(['idleTimeMinutes', 'enable_tab_discard', 'dark_mode'], (items) => {
      this.idleTimeMinutes = parseInt(items.idleTimeMinutes);
      if (isNaN(this.idleTimeMinutes)) {
        this.idleTimeMinutes = 30;
      }

      document.querySelector('#config input[name=idle_time]').value = this.idleTimeMinutes;

      this.enableTabDiscard = items.enable_tab_discard;
      if (this.enableTabDiscard) {
        let tabDiscardElement = document.createElement('span');
        let tabDiscardMessage = document.createTextNode('Native tab discard is enabled. Many features are not available in this mode.');
        tabDiscardElement.appendChild(tabDiscardMessage);
        tabDiscardElement.classList.add('bottom-status');
        tabDiscardElement.classList.add('red');
    
        document.querySelector('#bottom_status_container').appendChild(tabDiscardElement);
      }

      // enable dark mode
      this.darkMode = items.dark_mode;
      if(this.darkMode) {
        document.body.classList.add('dark-mode');
      }
    });
  }

  getTabState() {
    this.chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      tabs.forEach((tab) => {
        this.chrome.runtime.sendMessage({command: "ts_get_tab_state", tabId: tab.id}, (response) => {
          this.state = response.state;
          this.updateStatusFromState(response.state);
        });
      });
    });
  }

  updateStatusFromState(state) {
    const ALL_BUTTONS = [
      'suspend-btn', 'suspend-all-btn', 'suspend-all-windows-btn', 'suspend-others-btn',
      'restore-btn', 'restore-all-btn', 'restore-all-windows-btn',
      'disable-tab-auto-suspend-btn', 'enable-tab-auto-suspend-btn',
      'disable-tab-auto-suspend-domain-btn', 'enable-tab-auto-suspend-domain-btn',
      'add-to-whitelist-btn'
    ];
    const RESTORE_ALL = ['restore-all-btn', 'restore-all-windows-btn'];
    const SUSPEND_ALL = ['suspend-all-btn', 'suspend-all-windows-btn', 'suspend-others-btn'];
    const SUSPENDABLE_BASE = ['suspend-btn', ...SUSPEND_ALL, ...RESTORE_ALL, 'add-to-whitelist-btn'];
    const INACTIVE_BASE = [...SUSPEND_ALL, ...RESTORE_ALL, 'add-to-whitelist-btn'];

    const STATE_UI = {
      'suspended:suspended': {
        text: 'This tab is currently suspended.',
        color: null,
        show: ['restore-btn', ...RESTORE_ALL]
      },
      'suspendable:auto': {
        text: `This tab will be suspended automatically after ${this.idleTimeMinutes} minutes in the background.`,
        color: 'blue',
        show: [...SUSPENDABLE_BASE, 'disable-tab-auto-suspend-btn', 'disable-tab-auto-suspend-domain-btn']
      },
      'suspendable:auto_disabled': {
        text: 'This tab will not be suspended automatically since automatic suspension is disabled.',
        color: 'yellow',
        show: SUSPENDABLE_BASE
      },
      'suspendable:form_changed': {
        text: 'This tab will not be suspended automatically since it may contains unsaved form data.',
        color: 'yellow',
        show: SUSPENDABLE_BASE
      },
      'suspendable:audible': {
        text: 'Audible tab will not be suspended automatically.',
        color: 'yellow',
        show: SUSPENDABLE_BASE
      },
      'suspendable:pinned': {
        text: 'Pinned tab will not be suspended automatically.',
        color: 'yellow',
        show: SUSPENDABLE_BASE
      },
      'suspendable:offline': {
        text: 'Network appears to be down. Tabs will not be suspended automatically.',
        color: 'yellow',
        show: SUSPENDABLE_BASE
      },
      'suspendable:tab_whitelist': {
        text: 'This tab will not be suspended automatically for now.',
        color: 'yellow',
        show: [...SUSPENDABLE_BASE, 'enable-tab-auto-suspend-btn']
      },
      'suspendable:url_whitelist': {
        text: 'This url is whitelisted and will not be suspended automatically.',
        color: 'yellow',
        show: ['suspend-btn', ...SUSPEND_ALL, ...RESTORE_ALL]
      },
      'suspendable:domain_whitelist': {
        text: 'This domain will not be suspended automatically for now.',
        color: 'yellow',
        show: [...SUSPENDABLE_BASE, 'enable-tab-auto-suspend-domain-btn']
      },
      'nonsuspendible:temporary_disabled': {
        text: 'This tab will not be suspended automatically for now.',
        color: 'yellow',
        show: SUSPENDABLE_BASE
      },
      'nonsuspendible:discarded': {
        text: 'This tab is currently suspended via native tab discard.',
        color: 'yellow',
        show: SUSPENDABLE_BASE
      },
      'nonsuspendible:system_page': {
        text: 'System page cannot be suspended.',
        color: 'gray',
        show: [...SUSPEND_ALL, ...RESTORE_ALL]
      },
      'nonsuspendible:not_running': {
        text: "Content script is not running. Reload the tab to make sure it's running.",
        color: 'red',
        show: INACTIVE_BASE
      },
      'nonsuspendible:error': {
        text: 'Cannot suspend this page.',
        color: 'red',
        show: INACTIVE_BASE
      }
    };

    const ui = STATE_UI[state] || {
      text: 'Unknown error occurs.',
      color: 'red',
      show: INACTIVE_BASE
    };

    let show = ui.show;
    if (this.enableTabDiscard) {
      show = show.filter((b) => b !== 'suspend-btn'
        && b !== 'suspend-all-btn'
        && b !== 'suspend-all-windows-btn'
        && b !== 'restore-btn'
        && b !== 'restore-all-btn'
        && b !== 'restore-all-windows-btn');
      if (!show.includes('suspend-others-btn')) show = [...show, 'suspend-others-btn'];
      document.querySelector('.suspend-others-btn').text = 'Suspend all background tabs';
    }

    const visible = new Set(show);
    ALL_BUTTONS.forEach((cls) => {
      document.querySelector('.' + cls).style.display = visible.has(cls) ? 'block' : 'none';
    });

    const statusText = document.querySelector('#status_text');
    statusText.classList.remove('red', 'yellow', 'blue', 'gray');
    if (ui.color) statusText.classList.add(ui.color);
    statusText.textContent = ui.text;
  }

  onSuspend(e) {
    this.log('onSuspend');

    this.chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      tabs.forEach((tab) => {
        this.chrome.runtime.sendMessage({command: "ts_suspend_tab", tabId: tab.id});
      });
      setTimeout(() => {
        window.close();
      }, 100);
    });
  }

  onSuspendAll(e) {
    this.log('onSuspendAll');

    this.chrome.tabs.query({ currentWindow: true }, (tabs) => {
      tabs.forEach((tab) => {
        this.chrome.runtime.sendMessage({command: "ts_auto_suspend_tab", tabId: tab.id});
      });
      setTimeout(() => {
        window.close();
      }, 100);
    });
  }

  onSuspendAllWindows(e) {
    this.log('onSuspendAllWindows');

    this.chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        this.chrome.runtime.sendMessage({command: "ts_auto_suspend_tab", tabId: tab.id});
      });
      setTimeout(() => {
        window.close();
      }, 100);
    });
  }

  onSuspendOthers(e) {
    this.log('onSuspendOthers');

    this.chrome.tabs.query({ active: false, currentWindow: true }, (tabs) => {
      tabs.forEach((tab) => {
        this.chrome.runtime.sendMessage({command: "ts_auto_suspend_tab", tabId: tab.id});
      });
      setTimeout(() => {
        window.close();
      }, 100);
    });
  }

  onRestore(e) {
    this.log('onRestore');

    this.chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      tabs.forEach((tab) => {
        this.chrome.runtime.sendMessage({command: "ts_restore_tab", tabId: tab.id});
      });
      setTimeout(() => {
        window.close();
      }, 100);
    });
  }

  onRestoreAll(e) {
    this.log('onRestoreAll');

    this.chrome.tabs.query({ currentWindow: true }, (tabs) => {
      tabs.forEach((tab) => {
        this.chrome.runtime.sendMessage({command: "ts_restore_tab", tabId: tab.id});
      });
      setTimeout(() => {
        window.close();
      }, 100);
    });
  }

  onRestoreAllWindows(e) {
    this.log('onRestoreAllWindows');

    this.chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        this.chrome.runtime.sendMessage({command: "ts_restore_tab", tabId: tab.id});
      });
      setTimeout(() => {
        window.close();
      }, 100);
    });
  }

  onDisableAutoSuspensionThisTab(e) {
    this.log('onDisableAutoSuspensionThisTab');

    this.chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      tabs.forEach((tab) => {
        this.chrome.runtime.sendMessage({command: "ts_tab_disable_auto_suspension", tabId: tab.id});
      });
      setTimeout(() => {
        this.getTabState();
      }, 100);
      setTimeout(() => {
        window.close();
      }, 200);
    });
  }

  onEnableAutoSuspensionThisTab(e) {
    this.log('onEnableAutoSuspensionThisTab');

    this.chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      tabs.forEach((tab) => {
        this.chrome.runtime.sendMessage({command: "ts_tab_enable_auto_suspension", tabId: tab.id});
      });
      setTimeout(() => {
        this.getTabState();
      }, 100);
      setTimeout(() => {
        window.close();
      }, 200);
    });
  }

  onDisableAutoSuspensionThisDomain(e) {
    this.log('onDisableAutoSuspensionThisDomain');

    this.chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      tabs.forEach((tab) => {
        let url = new URL(tab.url);
        this.chrome.runtime.sendMessage({command: "ts_disable_auto_suspension_domain", domain: url.hostname});
      });
      setTimeout(() => {
        this.getTabState();
      }, 100);
      setTimeout(() => {
        window.close();
      }, 200);
    });
  }

  onEnableAutoSuspensionThisDomain(e) {
    this.log('onEnableAutoSuspensionThisDomain');

    this.chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      tabs.forEach((tab) => {
        let url = new URL(tab.url);
        this.chrome.runtime.sendMessage({command: "ts_enable_auto_suspension_domain", domain: url.hostname});
      });
      setTimeout(() => {
        this.getTabState();
      }, 100);
      setTimeout(() => {
        window.close();
      }, 200);
    });
  }

  onAddPageToWhitelist(e) {
    this.log('onAddPageToWhitelist');

    this.chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      tabs.forEach((tab) => {
        let url = new URL(tab.url);
        let pageUrl = `${url.origin}${url.pathname}`;

        this.chrome.storage.sync.get('whitelist', (items) => {
          let whitelist = items.whitelist || '';
          let entries = whitelist.split('\n').map(line => line.trim()).filter(Boolean);
          if (!entries.includes(pageUrl)) {
            entries.push(pageUrl);
          }
          this.chrome.storage.sync.set({'whitelist': entries.join('\n')}, () => {
            setTimeout(() => {
              window.close();
            }, 100);
          });
        });
      });
    });
  }

  onSettings(e) {
    this.log('onSettings');
    chrome.runtime.openOptionsPage();
  }

  onQuickSettingsChanged(e) {
    this.log('onQuickSettingsChanged');

    let idleTimeMinutes = parseInt(document.querySelector('#config input[name=idle_time]').value);
    if (isNaN(idleTimeMinutes)) return;

    this.idleTimeMinutes = idleTimeMinutes;

    this.chrome.storage.sync.set({'idleTimeMinutes': idleTimeMinutes}, () => {
      setTimeout(this.getTabState.bind(this), 500);
    });
  }

  onQuickSettingsSubmit(e) {
    this.log('onQuickSettingsSubmit');
    e.preventDefault();

    let idleTimeMinutes = parseInt(document.querySelector('#config input[name=idle_time]').value);
    if (isNaN(idleTimeMinutes)) return;

    this.idleTimeMinutes = idleTimeMinutes;

    this.chrome.storage.sync.set({'idleTimeMinutes': idleTimeMinutes}, () => {
      setTimeout(this.getTabState.bind(this), 500);
    });
  }
}


let tsp = new TinySuspenderPopup();

if (this.chrome) {
  tsp.setChrome(chrome);
  tsp.initEventHandlers();
  tsp.initQuickSettings();
  setTimeout(() => {
    tsp.getTabState();
  }, 200);

}

try {
  module.exports = ts;
}
catch (err) {

}

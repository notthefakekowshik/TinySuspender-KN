class TinySuspenderContent {

  constructor() {
    this.debug = false;
    this.chrome = null;
    this.formUpdated = false;
  }

  log() {
    if (this.debug)
      console.log(...arguments);
  }

  setChrome(chrome) {
    this.chrome = chrome;
  }

  initEventHandlers() {
    this.chrome.runtime.onMessage.addListener(this.eventHandler.bind(this));

    // capture-phase listener catches input/textarea changes once, including dynamically added elements,
    // without overwriting any onchange handlers the page itself sets.
    document.addEventListener('change', (e) => {
      let t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
        this.formDataChanged();
      }
    }, true);
  }

  eventHandler(request, sender, sendResponse) {
    if (request.command && request.command.startsWith('ts_')) {
      let command = request.command.substr(3);
      if (this[command]) {
        (this[command])(request, sender, sendResponse);
      }
    }
    else {
      this.log('unhandled event:', request, sender);
    }
  }

  formDataChanged() {
    if (this.formUpdated) return;
    this.formUpdated = true;
    this.chrome.runtime.sendMessage({command: "ts_update_tab_icon", state: this.get_current_state()}, (response) => {

    });
  }

  get_current_state() {
    if (document.querySelector('body').getAttribute('data-suspended') === 'true' ) {
      return 'suspended:suspended';
    }
    else if (this.formUpdated) {
      return 'suspendable:form_changed';
    }
    
    return 'suspendable:auto';
  }

  get_tab_state(request, sender, sendResponse) {
    sendResponse({state: this.get_current_state()});
  }

  get_tab_scroll(request, sender, sendResponse) {
    let scrollPosition = {
      x: window.scrollX,
      y: window.scrollY
    };

    sendResponse({scroll: scrollPosition});
  }

  set_tab_scroll(request, sender, sendResponse) {
    let scroll = request.scroll;
    setTimeout(() => {
      window.scrollTo(scroll.x, scroll.y);
    }, 100);
  }
}


let tsc = new TinySuspenderContent();

if (this.chrome) {
  tsc.setChrome(chrome);
  tsc.initEventHandlers();
}


try {
  module.exports = ts;
}
catch (err) {

}

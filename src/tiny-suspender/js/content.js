class TinySuspenderContent {

  constructor() {
    this.debug = false;
    this.chrome = null;
    this.formUpdated = false;
    this.pageBusy = false;
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

    // Capture-phase listeners catch edits once, including on dynamically added
    // elements, without overwriting any handlers the page itself sets.
    // 'input' fires while typing (before blur), 'change' covers controls that
    // only report on commit. Together they also cover contenteditable regions.
    let onEdit = (e) => {
      if (this.isFormField(e.target)) {
        this.formDataChanged();
      }
    };
    document.addEventListener('input', onEdit, true);
    document.addEventListener('change', onEdit, true);

    // page-agent.js (MAIN world) posts one busy boolean whenever the page
    // starts or finishes work that must not be interrupted.
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;

      let data = event.data;
      if (!data || data.__tinySuspenderAgent !== true) return;

      let busy = data.busy === true;
      if (this.pageBusy === busy) return;

      this.pageBusy = busy;
      this.updateTabIcon();
    });
  }

  isFormField(element) {
    if (!element) return false;
    if (element.isContentEditable) return true;

    let tag = element.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
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
    this.updateTabIcon();
  }

  updateTabIcon() {
    this.chrome.runtime.sendMessage({command: "ts_update_tab_icon", state: this.get_current_state()}, (response) => {

    });
  }

  get_current_state() {
    if (document.querySelector('body').getAttribute('data-suspended') === 'true' ) {
      return 'suspended:suspended';
    }
    else if (this.pageBusy) {
      return 'suspendable:busy';
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

  get_tab_media(request, sender, sendResponse) {
    let video = document.querySelector('video');

    if (!video) {
      sendResponse({media: null});
      return;
    }

    sendResponse({media: {currentTime: Math.floor(video.currentTime)}});
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
  module.exports = tsc;
}
catch (err) {

}

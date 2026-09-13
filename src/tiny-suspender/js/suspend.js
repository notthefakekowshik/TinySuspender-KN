
// Opacity of the favicon shown in the browser tab while the page is suspended.
// Low enough to read as inactive, high enough to still identify the site.
const DIM_ALPHA = 0.5;

const FAVICON_SIZE = 32;


class TinySuspenderSuspend {

  constructor() {
    this.debug = false;
    this.chrome = null;
    this.pageUrl = null;
    this.favIconUrl = null;
    this.title = null;
  }

  log() {
    if (this.debug)
      console.log(...arguments);
  }

  setChrome(chrome) {
    this.chrome = chrome;
  }

  readParams() {
    let suspendUrl = new URL(location.href);
    this.pageUrl = suspendUrl.searchParams.get('url');
    this.favIconUrl = suspendUrl.searchParams.get('favIconUrl');
    this.title = suspendUrl.searchParams.get('title');

    // compatibility with previous version
    // will be removed in the next version
    if (!this.pageUrl) {
      let hash = suspendUrl.hash ? suspendUrl.hash.replace('#', '') : '';

      let hashParams = {};
      let e,
          a = /\+/g,  // Regex for replacing addition symbol with a space
          r = /([^&;=]+)=?([^&;]*)/g,
          d = function (s) { return decodeURIComponent(s.replace(a, " ")); },
          q = hash;

      while (e = r.exec(q))
         hashParams[d(e[1])] = d(e[2]);

      this.pageUrl = hashParams.uri;
      this.title = hashParams.title;
    }
  }

  init() {
    this.readParams();

    document.onclick = () => {
      this.chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        tabs.forEach((tab) => {
          this.chrome.runtime.sendMessage({command: "ts_restore_tab", tabId: tab.id});
        });
      });
    };

    if (this.pageUrl) {
      document.querySelector('.title .description').setAttribute('href', this.pageUrl);
      document.querySelector('.title .url').setAttribute('href', this.pageUrl);
      document.querySelector('.title .url').textContent = this.pageUrl;
    }

    if (this.title) {
      document.title = this.title;
      document.querySelector('.title .description').textContent = this.title;
    }

    this.setTabIcon();
  }

  // Chrome's own favicon store. This URL is same-origin with the suspend page,
  // so drawing it never taints the canvas and the dimmed icon always renders.
  // It also covers suspended tabs that carry no favIconUrl at all, such as the
  // ones created by the "open link in new suspended tab" context menu.
  faviconApiUrl() {
    if (!/^https?:/i.test(this.pageUrl || '')) return null;

    let url = new URL(this.chrome.runtime.getURL('/_favicon/'));
    url.searchParams.set('pageUrl', this.pageUrl);
    url.searchParams.set('size', String(FAVICON_SIZE));
    return url.toString();
  }

  iconSources() {
    return [this.faviconApiUrl(), this.favIconUrl]
      .filter((source, index, sources) => source && sources.indexOf(source) === index);
  }

  setTabIcon() {
    let sources = this.iconSources();
    let next = 0;

    let trySource = () => {
      // Without a favicon the tab keeps Chrome's default for this page, which
      // is the extension's power icon.
      if (next >= sources.length) {
        this.notifyReady();
        return;
      }

      let source = sources[next++];
      let img = new Image();

      img.onload = () => {
        this.setPageIcon(source);
        this.setBrowserTabIcon(img, source);
        this.notifyReady();
      };
      img.onerror = trySource;
      img.src = source;
    };

    trySource();
  }

  // Tell the worker the placeholder has applied its title and favicon, so its
  // renderer can be discarded without the tab losing them. The worker also has a
  // timeout, in case this never arrives.
  notifyReady() {
    this.chrome.runtime.sendMessage({command: 'ts_suspend_page_ready'});
  }

  setPageIcon(source) {
    let icon = document.createElement('img');
    icon.setAttribute('src', source);
    document.querySelector('.title .icon').appendChild(icon);
  }

  setBrowserTabIcon(img, source) {
    let link = document.createElement('link');
    link.type = 'image/x-icon';
    link.rel = 'shortcut icon';
    link.href = this.dimmedHref(img, source);
    document.getElementsByTagName('head')[0].appendChild(link);
  }

  // Exporting a cross-origin favicon throws because the canvas is tainted by
  // its pixels. Falling back to the raw favicon loses the dimming but still
  // identifies the suspended tab; no icon at all is what made every suspended
  // tab show the extension's power icon.
  dimmedHref(img, source) {
    if (!img.width || !img.height) return source;

    try {
      let canvas = document.createElement('canvas');
      let ctx = canvas.getContext('2d');
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.globalAlpha = DIM_ALPHA;
      ctx.drawImage(img, 0, 0);
      return canvas.toDataURL();
    }
    catch (error) {
      this.log('favicon canvas is tainted, using the favicon as-is', error);
      return source;
    }
  }

}


let tss = new TinySuspenderSuspend();

if (this.chrome) {
  tss.setChrome(chrome);
  tss.init();
}


try {
  module.exports = tss;
}
catch (err) {

}

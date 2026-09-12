// Runs in the page's MAIN world at document_start. Its only job is to decide
// whether this tab is currently doing something that must not be interrupted,
// and to post a single boolean to the isolated content script. Nothing else is
// shared with the page.
//
// Busy means any of:
//   - a fetch/XHR that has been in flight for 3+ seconds (uploads, streams,
//     long polls); short requests such as analytics beacons and polling are
//     ignored so they cannot flap the state
//   - an open WebSocket or EventSource (live dashboards)
//   - an RTCPeerConnection that is connecting or connected (calls, even muted)
//   - a picture-in-picture video
(() => {
  if (window.__tinySuspenderAgent) return;
  window.__tinySuspenderAgent = true;

  const LONG_REQUEST_MS = 3000;

  const requests = new Map();
  const sockets = new Set();
  const streams = new Set();
  const peers = new Set();

  let nextRequestId = 0;
  let reportedBusy = false;
  let recheckTimer = null;

  const now = () => Date.now();

  const hasLongRequest = () => {
    let earliest = Infinity;
    for (const startedAt of requests.values()) {
      if (startedAt < earliest) earliest = startedAt;
    }
    return earliest !== Infinity && (now() - earliest >= LONG_REQUEST_MS);
  };

  const isBusy = () => {
    if (sockets.size > 0 || streams.size > 0 || peers.size > 0) return true;
    if (document.pictureInPictureElement) return true;
    return hasLongRequest();
  };

  const post = (busy) => {
    try {
      window.postMessage({__tinySuspenderAgent: true, busy: busy}, '*');
    }
    catch (error) {
      // Never let reporting break the page.
    }
  };

  const scheduleRecheck = () => {
    if (recheckTimer || requests.size === 0) return;

    let earliest = Infinity;
    for (const startedAt of requests.values()) {
      if (startedAt < earliest) earliest = startedAt;
    }

    let delay = (earliest + LONG_REQUEST_MS) - now();
    if (delay < 0) delay = 0;

    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      refresh();
    }, delay + 1);
  };

  const refresh = () => {
    if (recheckTimer) {
      clearTimeout(recheckTimer);
      recheckTimer = null;
    }

    let busy = isBusy();
    if (!busy) scheduleRecheck();

    if (busy === reportedBusy) return;
    reportedBusy = busy;
    post(busy);
  };

  const trackRequest = () => {
    const id = nextRequestId++;
    requests.set(id, now());
    refresh();
    return id;
  };

  const finishRequest = (id) => {
    if (!requests.delete(id)) return;
    refresh();
  };

  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch;

    window.fetch = function (...args) {
      const id = trackRequest();
      let result;

      try {
        result = originalFetch.apply(this, args);
      }
      catch (error) {
        finishRequest(id);
        throw error;
      }

      return result.then(
        (response) => {
          finishRequest(id);
          return response;
        },
        (error) => {
          finishRequest(id);
          throw error;
        }
      );
    };
  }

  if (typeof window.XMLHttpRequest === 'function') {
    const originalSend = window.XMLHttpRequest.prototype.send;

    window.XMLHttpRequest.prototype.send = function (...args) {
      const id = trackRequest();

      const done = () => {
        this.removeEventListener('loadend', done);
        finishRequest(id);
      };
      this.addEventListener('loadend', done);

      try {
        return originalSend.apply(this, args);
      }
      catch (error) {
        finishRequest(id);
        throw error;
      }
    };
  }

  if (typeof window.WebSocket === 'function') {
    class TrackedWebSocket extends window.WebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('open', () => {
          sockets.add(this);
          refresh();
        });
        this.addEventListener('close', () => {
          sockets.delete(this);
          refresh();
        });
      }
    }

    window.WebSocket = TrackedWebSocket;
  }

  if (typeof window.EventSource === 'function') {
    class TrackedEventSource extends window.EventSource {
      constructor(...args) {
        super(...args);
        this.addEventListener('open', () => {
          streams.add(this);
          refresh();
        });
        this.addEventListener('error', () => {
          // readyState CLOSED means it gave up; anything else is reconnecting.
          if (this.readyState === 2) {
            streams.delete(this);
            refresh();
          }
        });
      }
    }

    window.EventSource = TrackedEventSource;
  }

  if (typeof window.RTCPeerConnection === 'function') {
    class TrackedRTCPeerConnection extends window.RTCPeerConnection {
      constructor(...args) {
        super(...args);
        this.addEventListener('connectionstatechange', () => {
          if (this.connectionState === 'connecting' || this.connectionState === 'connected') {
            peers.add(this);
          }
          else {
            peers.delete(this);
          }
          refresh();
        });
      }
    }

    window.RTCPeerConnection = TrackedRTCPeerConnection;
  }

  document.addEventListener('enterpictureinpicture', refresh);
  document.addEventListener('leavepictureinpicture', refresh);
})();

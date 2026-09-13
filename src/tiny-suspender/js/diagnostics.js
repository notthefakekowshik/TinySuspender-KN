let setRows = (tableId, rows) => {
  let table = document.querySelector('#' + tableId);
  table.textContent = '';

  rows.forEach((row) => {
    let tr = document.createElement('tr');
    let label = document.createElement('td');
    let value = document.createElement('td');
    label.textContent = row[0];
    value.textContent = row[1];
    tr.appendChild(label);
    tr.appendChild(value);
    table.appendChild(tr);
  });
};

let suspendPagePrefix = 'chrome-extension://' + chrome.runtime.id + '/suspend.html';

// Suspend pages owned by any install, so tabs left behind by a previous install
// are counted too instead of looking like ordinary extension pages.
let isSuspendPageUrl = (url) => {
  try {
    let parsed = new URL(url);
    return parsed.protocol === 'chrome-extension:' && parsed.pathname === '/suspend.html';
  }
  catch (error) {
    return false;
  }
};

let loadEnvironment = () => {
  setRows('environment', [
    ['Extension version', chrome.runtime.getManifest().version],
    ['User agent', navigator.userAgent],
    ['Device memory class', navigator.deviceMemory ? navigator.deviceMemory + ' GB' : 'unavailable'],
    ['CPU threads', navigator.hardwareConcurrency ? String(navigator.hardwareConcurrency) : 'unavailable'],
    ['storage.session', chrome.storage.session ? 'available' : 'unavailable'],
    ['chrome.system.memory', (chrome.system && chrome.system.memory) ? 'available' : 'unavailable'],
    ['chrome.processes', chrome.processes ? 'available' : 'unavailable (Dev channel only)'],
    ['runtime.getContexts', typeof chrome.runtime.getContexts === 'function' ? 'available' : 'unavailable']
  ]);

  chrome.storage.sync.get(['idleTimeMinutes'], (items) => {
    let idle = parseInt(items.idleTimeMinutes);
    if (isNaN(idle)) idle = 30;
    let row = document.createElement('tr');
    let label = document.createElement('td');
    let value = document.createElement('td');
    label.textContent = 'Idle threshold';
    value.textContent = idle === 0 ? 'automatic suspension disabled' : idle + ' minutes';
    row.appendChild(label);
    row.appendChild(value);
    document.querySelector('#environment').appendChild(row);
  });
};

let loadState = () => {
  chrome.alarms.getAll((alarms) => {
    let names = alarms.map((alarm) => alarm.name).sort();

    chrome.tabs.query({}, (tabs) => {
      let suspended = tabs.filter((tab) => isSuspendPageUrl(tab.url));
      let own = tabs.filter((tab) => (tab.url || '').startsWith(suspendPagePrefix));
      let orphaned = suspended.filter((tab) => !(tab.url || '').startsWith(suspendPagePrefix));
      let discarded = tabs.filter((tab) => tab.discarded);

      setRows('state', [
        ['Active alarms', alarms.length + ' (Chrome caps an extension at 500)'],
        ['Alarm names', names.length ? names.join(', ') : '(none)'],
        ['Tabs', String(tabs.length)],
        ['Suspended by Tiny Suspender', String(own.length)],
        ['Suspended by another install (orphaned)', String(orphaned.length)],
        ['Suspended by native tab discard', String(discarded.length)],
        ['Live (not suspended)', String(tabs.length - suspended.length - discarded.length)]
      ]);
    });
  });
};

let loadProcesses = () => {
  let message = document.querySelector('#process_message');

  if (!chrome.processes) {
    setRows('processes', []);
    message.textContent = 'chrome.processes is not available in this browser build.';
    return;
  }

  message.textContent = 'Reading process info…';

  chrome.tabs.query({}, (tabs) => {
    let tabIds = tabs.map((tab) => tab.id);

    Promise.all(tabIds.map((tabId) => chrome.processes.getProcessIdForTab(tabId)))
      .then((processIds) => {
        let byProcess = {};
        processIds.forEach((processId, index) => {
          if (!byProcess[processId]) byProcess[processId] = [];
          byProcess[processId].push(tabs[index].title || tabs[index].url);
        });

        return chrome.processes.getProcessInfo(Object.keys(byProcess).map((id) => parseInt(id)), true)
          .then((info) => ({byProcess, info}));
      })
      .then(({byProcess, info}) => {
        let rows = Object.keys(byProcess).map((processId) => {
          let process = info[processId] || {};
          let memory = process.privateMemory ? Math.round(process.privateMemory / (1024 * 1024)) + ' MB' : 'unknown';
          let titles = byProcess[processId].join(', ');
          return ['process ' + processId + ' (' + (process.type || '?') + ', ' + memory + ')', titles];
        });

        setRows('processes', rows);
        message.textContent = rows.length + ' processes across ' + tabIds.length + ' tabs. Tabs sharing one process are shown together.';
      })
      .catch((error) => {
        message.textContent = 'Failed to read process info: ' + error.message;
      });
  });
};

let requestProcesses = () => {
  let message = document.querySelector('#process_message');

  chrome.permissions.request({permissions: ['processes']}, (granted) => {
    if (chrome.runtime.lastError) {
      message.textContent = 'Permission request failed: ' + chrome.runtime.lastError.message;
      return;
    }

    message.textContent = granted ? 'Granted. Use Refresh to read process info.' : 'Permission denied.';
    loadEnvironment();
  });
};

document.querySelector('#version_string').textContent = 'v' + chrome.runtime.getManifest().version;
document.querySelector('#request_processes').onclick = requestProcesses;
document.querySelector('#refresh_processes').onclick = loadProcesses;

chrome.storage.sync.get('dark_mode', (items) => {
  if (items.dark_mode) document.body.classList.add('dark-mode');
});

loadEnvironment();
loadState();


let initSettings = () => {
  chrome.storage.sync.get([
    'idleTimeMinutes',
    'whitelist',
    'autorestore',
    'skip_audible',
    'skip_pinned',
    'skip_when_offline',
    'enable_tab_discard',
    'dark_mode',
    'auto_adopt'
  ], (items) => {
    let idleTimeMinutes = parseInt(items.idleTimeMinutes);
    if (isNaN(idleTimeMinutes)) {
      idleTimeMinutes = 30;
    }

    document.querySelector('#config input[name=idle_time]').value = idleTimeMinutes;

    let whitelist = items.whitelist;
    if (!whitelist) {
      whitelist = '';
    }
    document.querySelector('#config textarea[name=whitelist]').value = whitelist;

    if (items.autorestore) {
      document.querySelector('#config input[name=autorestore]').setAttribute('checked', 'checked');
    }
    else {
      document.querySelector('#config input[name=autorestore]').removeAttribute('checked');
    }

    if (items.skip_audible) {
      document.querySelector('#config input[name=skip_audible]').setAttribute('checked', 'checked');
    }
    else {
      document.querySelector('#config input[name=skip_audible]').removeAttribute('checked');
    }

    if (items.skip_pinned) {
      document.querySelector('#config input[name=skip_pinned]').setAttribute('checked', 'checked');
    }
    else {
      document.querySelector('#config input[name=skip_pinned]').removeAttribute('checked');
    }

    if (items.skip_when_offline) {
      document.querySelector('#config input[name=skip_when_offline]').setAttribute('checked', 'checked');
    }
    else {
      document.querySelector('#config input[name=skip_when_offline]').removeAttribute('checked');
    }

    if (items.enable_tab_discard) {
      document.querySelector('#config input[name=enable_tab_discard]').setAttribute('checked', 'checked');
    }
    else {
      document.querySelector('#config input[name=enable_tab_discard]').removeAttribute('checked');
    }

    if (items.dark_mode) {
      document.querySelector('#config input[name=dark_mode]').setAttribute('checked', 'checked');
      document.body.classList.add('dark-mode');
    }
    else {
      document.querySelector('#config input[name=dark_mode]').removeAttribute('checked');
      document.body.classList.remove('dark-mode');
    }

    if (items.auto_adopt) {
      document.querySelector('#config input[name=auto_adopt]').setAttribute('checked', 'checked');
    }
    else {
      document.querySelector('#config input[name=auto_adopt]').removeAttribute('checked');
    }


  });
}


let onSettingsSubmit = (e) => {
  e.preventDefault();

  let idleTimeMinutes = parseInt(document.querySelector('#config input[name=idle_time]').value);
  if (isNaN(idleTimeMinutes)) return;

  let whitelist = document.querySelector('#config textarea[name=whitelist]').value;
  if (!whitelist) whitelist = '';

  let autorestore = document.querySelector('#config input[name=autorestore]').checked;
  let skip_audible = document.querySelector('#config input[name=skip_audible]').checked;
  let skip_pinned = document.querySelector('#config input[name=skip_pinned]').checked;
  let skip_when_offline = document.querySelector('#config input[name=skip_when_offline]').checked;
  let enable_tab_discard = document.querySelector('#config input[name=enable_tab_discard]').checked;
  let dark_mode = document.querySelector('#config input[name=dark_mode]').checked;
  let auto_adopt = document.querySelector('#config input[name=auto_adopt]').checked;

  chrome.storage.sync.set({
    'idleTimeMinutes': idleTimeMinutes,
    'whitelist': whitelist,
    'autorestore': autorestore,
    'skip_audible': skip_audible,
    'skip_when_offline': skip_when_offline,
    'skip_pinned': skip_pinned,
    'enable_tab_discard': enable_tab_discard,
    'dark_mode': dark_mode,
    'auto_adopt': auto_adopt
  }, () => {
    document.querySelector('#message').textContent = 'Setting saved!';
    document.querySelector('#message2').textContent = 'Setting saved!';

    // check if dark mode is enabled
    if (dark_mode) document.body.classList.add('dark-mode');
    else document.body.classList.remove('dark-mode');
  });
}


document.querySelector('#config').onsubmit = onSettingsSubmit;


let onKeyboardShortcuts = (e) => {
  e.preventDefault();
  chrome.tabs.create({url: 'chrome://extensions/configureCommands'});
}

document.querySelector('.shortcuts').onclick = onKeyboardShortcuts;

document.querySelector('#version_string').textContent = 'v' + chrome.runtime.getManifest().version;

initSettings();


const SETTINGS_KEYS = [
  'idleTimeMinutes',
  'whitelist',
  'autorestore',
  'skip_audible',
  'skip_pinned',
  'skip_when_offline',
  'enable_tab_discard',
  'dark_mode',
  'auto_adopt'
];

let downloadJson = (filename, data) => {
  let blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
  let url = URL.createObjectURL(blob);
  let link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

let readFileText = (file, callback) => {
  let reader = new FileReader();
  reader.onload = () => callback(reader.result);
  reader.readAsText(file);
};

// Accepts an exported {"tabs": [...]} payload, a bare array, or a newline
// separated list of raw suspend urls (e.g. recovered from History or a bookmark export).
let parseTabEntries = (text) => {
  try {
    let parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.tabs)) return parsed.tabs;
  }
  catch (error) {
    // not JSON: fall through to the plain url list
  }

  return text.split('\n').map((line) => line.trim()).filter(Boolean);
};

let importTabs = (entries) => {
  if (!entries.length) {
    document.querySelector('#migration_message').textContent = 'Nothing to import.';
    return;
  }

  chrome.runtime.sendMessage({command: 'ts_import_suspended_tabs', urls: entries}, (response) => {
    let imported = (response && response.imported) || 0;
    document.querySelector('#migration_message').textContent = 'Imported ' + imported + ' suspended tab(s).';
  });
};

let onExportTabs = () => {
  chrome.runtime.sendMessage({command: 'ts_export_suspended_tabs'}, (response) => {
    let tabs = (response && response.tabs) || [];
    downloadJson('tiny-suspender-tabs.json', {tabs: tabs});
    document.querySelector('#migration_message').textContent = 'Exported ' + tabs.length + ' suspended tab(s).';
  });
};

let onAdoptTabs = () => {
  chrome.runtime.sendMessage({command: 'ts_adopt_orphaned_suspended_tabs'}, (response) => {
    let adopted = (response && response.adopted) || 0;
    document.querySelector('#migration_message').textContent = adopted
      ? 'Adopted ' + adopted + ' suspended tab(s) from another install.'
      : 'No suspended tabs from another install were found.';
  });
};

let onImportTabs = () => {
  let file = document.querySelector('#import_tabs_file').files[0];

  if (file) {
    readFileText(file, (content) => importTabs(parseTabEntries(content)));
    return;
  }

  importTabs(parseTabEntries(document.querySelector('#import_tabs_text').value || ''));
};

let onExportSettings = () => {
  chrome.storage.sync.get(SETTINGS_KEYS, (items) => {
    downloadJson('tiny-suspender-settings.json', items);
    document.querySelector('#settings_backup_message').textContent = 'Settings exported.';
  });
};

let onImportSettings = () => {
  let file = document.querySelector('#import_settings_file').files[0];
  if (!file) {
    document.querySelector('#settings_backup_message').textContent = 'Choose a settings file first.';
    return;
  }

  readFileText(file, (content) => {
    let items;
    try {
      items = JSON.parse(content);
    }
    catch (error) {
      document.querySelector('#settings_backup_message').textContent = 'That file is not valid JSON.';
      return;
    }

    chrome.storage.sync.set(items, () => {
      document.querySelector('#settings_backup_message').textContent = 'Settings imported.';
      initSettings();
    });
  });
};

document.querySelector('#export_tabs').onclick = onExportTabs;
document.querySelector('#adopt_tabs').onclick = onAdoptTabs;
document.querySelector('#import_tabs').onclick = onImportTabs;
document.querySelector('#export_settings').onclick = onExportSettings;
document.querySelector('#import_settings').onclick = onImportSettings;
const DEFAULT_SETTINGS = {
  clientId: '',
  squareCover: true,
  cleanTitles: true,
  hideAds: true
};

const els = {
  performButton: document.querySelector('#performButton'),
  performText: document.querySelector('#performText'),
  clientId: document.querySelector('#clientId'),
  squareCover: document.querySelector('#squareCover'),
  cleanTitles: document.querySelector('#cleanTitles'),
  hideAds: document.querySelector('#hideAds'),
  cover: document.querySelector('#cover'),
  preview: document.querySelector('#preview'),
  trackTitle: document.querySelector('#trackTitle'),
  trackArtist: document.querySelector('#trackArtist'),
  message: document.querySelector('#message'),
  statusDot: document.querySelector('#statusDot'),
  companionText: document.querySelector('#companionText')
};

let enabled = false;

void init();

async function init() {
  const state = await chrome.runtime.sendMessage({ type: 'PERFORMATRON_GET_STATE' });
  const settings = state?.settings || await chrome.storage.sync.get(DEFAULT_SETTINGS);
  enabled = Boolean(state?.enabled);

  els.clientId.value = settings.clientId || '';
  els.squareCover.checked = settings.squareCover !== false;
  els.cleanTitles.checked = settings.cleanTitles !== false;
  els.hideAds.checked = settings.hideAds !== false;

  renderToggle();
  renderTrack(state?.track || null);
  await refreshTrackFromActiveTab();
  await refreshCompanion();
}

els.performButton.addEventListener('click', async () => {
  clearMessage();
  const next = !enabled;
  const result = await chrome.runtime.sendMessage({
    type: 'PERFORMATRON_SET_ENABLED',
    enabled: next
  });

  if (!result?.ok) {
    showMessage(result?.error || 'Não consegui ligar.', true);
    enabled = false;
  } else {
    enabled = Boolean(result.enabled);
    showMessage(enabled ? 'Showtime. O Discord agora recebe a música.' : 'Performance encerrada.');
  }
  renderToggle();
});

els.clientId.addEventListener('input', debounce(saveSettings, 350));
els.squareCover.addEventListener('change', saveSettings);
els.cleanTitles.addEventListener('change', saveSettings);
els.hideAds.addEventListener('change', saveSettings);

async function saveSettings() {
  const settings = {
    clientId: els.clientId.value.trim(),
    squareCover: els.squareCover.checked,
    cleanTitles: els.cleanTitles.checked,
    hideAds: els.hideAds.checked
  };
  await chrome.storage.sync.set(settings);
  await chrome.runtime.sendMessage({ type: 'PERFORMATRON_SETTINGS_CHANGED' });
  await refreshTrackFromActiveTab();
}

async function refreshTrackFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/(www\.)?youtube\.com\//i.test(tab.url || '')) return;

    const result = await chrome.tabs.sendMessage(tab.id, { type: 'PERFORMATRON_GET_TRACK' });
    if (!result?.track) return;

    await chrome.runtime.sendMessage({ type: 'PERFORMATRON_TRACK', track: result.track });
    const state = await chrome.runtime.sendMessage({ type: 'PERFORMATRON_GET_STATE' });
    renderTrack(state?.track || null);
  } catch {
    // A freshly installed extension may need the YouTube tab to be reloaded once.
  }
}

async function refreshCompanion() {
  const status = await chrome.runtime.sendMessage({ type: 'PERFORMATRON_CHECK_COMPANION' });
  if (status?.ok) {
    els.statusDot.className = 'dot ok';
    els.companionText.textContent = status.discordConnected ? 'Companion + Discord conectados' : 'Companion aberto • esperando Discord';
  } else {
    els.statusDot.className = 'dot bad';
    els.companionText.textContent = 'Companion não encontrado';
  }
}

function renderToggle() {
  els.performButton.classList.toggle('on', enabled);
  els.performButton.classList.toggle('off', !enabled);
  els.performText.textContent = enabled ? 'PARAR DE PERFORMAR' : 'PERFORMAR NO DISCORD';
}

function renderTrack(track) {
  if (!track) {
    els.preview.classList.add('empty');
    els.trackTitle.textContent = 'Abra uma música no YouTube';
    els.trackArtist.textContent = '—';
    els.cover.removeAttribute('src');
    return;
  }

  els.preview.classList.remove('empty');
  els.trackTitle.textContent = track.title || 'YouTube';
  els.trackArtist.textContent = track.artist || 'YouTube';
  els.cover.src = track.coverUrl || track.thumbnail || '';
}

function showMessage(text, error = false) {
  els.message.textContent = text;
  els.message.classList.toggle('error', error);
}

function clearMessage() {
  showMessage('', false);
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const API_BASE = 'http://127.0.0.1:42421';
const TRACK_TTL_MS = 12_000;
const SEND_THROTTLE_MS = 4_500;

const DEFAULT_SETTINGS = {
  clientId: '',
  squareCover: true,
  cleanTitles: true,
  hideAds: true
};

const tracks = new Map();
let enabled = false;
let lastPresenceKey = '';
let lastSentAt = 0;
let pendingTimer = null;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set(current);
  await chrome.storage.session.set({ enabled: false });
  await setBadge(false);
});

chrome.runtime.onStartup.addListener(async () => {
  enabled = false;
  await chrome.storage.session.set({ enabled: false });
  await setBadge(false);
});

(async function bootstrap() {
  const session = await chrome.storage.session.get({ enabled: false });
  enabled = Boolean(session.enabled);
  await setBadge(enabled);
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'PERFORMATRON_TRACK') {
    void onTrack(message.track, sender);
    sendResponse?.({ ok: true });
    return true;
  }

  if (message.type === 'PERFORMATRON_SET_ENABLED') {
    void setEnabled(Boolean(message.enabled)).then(sendResponse);
    return true;
  }

  if (message.type === 'PERFORMATRON_GET_STATE') {
    void getState().then(sendResponse);
    return true;
  }

  if (message.type === 'PERFORMATRON_SETTINGS_CHANGED') {
    void schedulePresenceUpdate(true).then(() => sendResponse?.({ ok: true }));
    return true;
  }

  if (message.type === 'PERFORMATRON_CHECK_COMPANION') {
    void checkCompanion().then(sendResponse);
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tracks.delete(tabId)) void schedulePresenceUpdate(true);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && tracks.has(tabId)) {
    tracks.delete(tabId);
    void schedulePresenceUpdate(true);
  }
});

async function onTrack(track, sender) {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== 'number' || !track) return;

  let tab = sender.tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    // The tab may have disappeared between message dispatch and lookup.
  }

  tracks.set(tabId, {
    ...track,
    tabId,
    active: Boolean(tab?.active),
    audible: Boolean(tab?.audible),
    seenAt: Date.now()
  });

  if (enabled) await schedulePresenceUpdate(false);
}

async function setEnabled(next) {
  enabled = next;
  await chrome.storage.session.set({ enabled });
  await setBadge(enabled);

  if (!enabled) {
    cancelPending();
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    await clearPresence(settings.clientId);
    lastPresenceKey = '';
    return { ok: true, enabled };
  }

  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  if (!isValidClientId(settings.clientId)) {
    enabled = false;
    await chrome.storage.session.set({ enabled: false });
    await setBadge(false);
    return { ok: false, enabled: false, error: 'Cole um Application ID do Discord primeiro.' };
  }

  await schedulePresenceUpdate(true);
  return { ok: true, enabled };
}

async function getState() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const selected = pickBestTrack(settings);
  return {
    enabled,
    settings,
    track: selected ? presentableTrack(selected, settings) : null
  };
}

async function checkCompanion() {
  try {
    const response = await fetch(`${API_BASE}/v1/status`, {
      method: 'GET',
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return { ok: true, ...data };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function schedulePresenceUpdate(force) {
  if (!enabled) return;

  const wait = force ? 0 : Math.max(0, SEND_THROTTLE_MS - (Date.now() - lastSentAt));
  if (wait > 0) {
    if (!pendingTimer) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        void updatePresenceNow();
      }, wait);
    }
    return;
  }

  cancelPending();
  await updatePresenceNow();
}

async function updatePresenceNow() {
  if (!enabled) return;

  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  if (!isValidClientId(settings.clientId)) return;

  pruneTracks();
  const track = pickBestTrack(settings);

  if (!track || (settings.hideAds && track.isAd)) {
    if (lastPresenceKey !== '') {
      await clearPresence(settings.clientId);
      lastPresenceKey = '';
      lastSentAt = Date.now();
    }
    return;
  }

  const activity = buildActivity(track, settings);
  const key = JSON.stringify(activity);
  if (key === lastPresenceKey) return;

  try {
    const response = await fetch(`${API_BASE}/v1/activity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: settings.clientId.trim(), activity })
    });

    const body = await safeJson(response);
    if (!response.ok || body?.ok === false) {
      throw new Error(body?.error || `HTTP ${response.status}`);
    }

    lastPresenceKey = key;
    lastSentAt = Date.now();
  } catch (error) {
    console.warn('[Performatron] companion indisponível:', error);
  }
}

async function clearPresence(clientId) {
  if (!isValidClientId(clientId)) return;
  try {
    await fetch(`${API_BASE}/v1/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientId.trim() })
    });
  } catch {
    // If the companion is already closed there is nothing useful to do.
  }
}

function pruneTracks() {
  const cutoff = Date.now() - TRACK_TTL_MS;
  for (const [tabId, track] of tracks) {
    if (track.seenAt < cutoff) tracks.delete(tabId);
  }
}

function pickBestTrack(settings) {
  pruneTracks();
  let best = null;
  let bestScore = -Infinity;
  const now = Date.now();

  for (const track of tracks.values()) {
    if (!track.videoId || !track.title || !track.url) continue;

    let score = 0;
    if (!track.paused && !track.ended) score += 100;
    if (track.audible) score += 60;
    if (track.active) score += 20;
    if (track.isAd && settings.hideAds) score -= 500;
    score += Math.max(0, 10 - (now - track.seenAt) / 1000);

    if (score > bestScore) {
      best = track;
      bestScore = score;
    }
  }

  return best;
}

function buildActivity(rawTrack, settings) {
  const track = presentableTrack(rawTrack, settings);
  const state = rawTrack.paused
    ? `⏸ Pausado • ${track.artist}`
    : track.artist;

  const activity = {
    name: 'YouTube',
    type: 2,
    status_display_type: 2,
    details: clamp(track.title, 128),
    details_url: track.url,
    state: clamp(state || 'YouTube', 128),
    assets: {
      large_image: track.coverUrl,
      large_text: clamp(`${track.artist} — ${track.title}`, 128),
      large_url: track.url
    },
    buttons: [
      {
        label: 'Abrir no YouTube',
        url: track.url
      }
    ]
  };

  if (!rawTrack.paused && !rawTrack.ended && Number.isFinite(rawTrack.duration) && rawTrack.duration > 0) {
    const sampledAt = Number(rawTrack.sampledAt) || Date.now();
    const currentTime = Math.max(0, Number(rawTrack.currentTime) || 0);
    const duration = Math.max(1, Number(rawTrack.duration));
    const start = Math.round(sampledAt / 1000 - currentTime);
    activity.timestamps = {
      start,
      end: Math.round(start + duration)
    };
  }

  return activity;
}

function presentableTrack(rawTrack, settings) {
  let title = normalizeWhitespace(rawTrack.title || 'YouTube');
  let artist = normalizeWhitespace(rawTrack.channel || 'YouTube');

  if (settings.cleanTitles) {
    const parsed = cleanMusicMetadata(title, artist);
    title = parsed.title;
    artist = parsed.artist;
  }

  const thumbnail = rawTrack.thumbnail || `https://i.ytimg.com/vi/${encodeURIComponent(rawTrack.videoId)}/hqdefault.jpg`;
  const coverUrl = settings.squareCover ? squareCoverUrl(thumbnail) : thumbnail;

  return {
    title: title || 'YouTube',
    artist: artist || 'YouTube',
    url: rawTrack.url,
    thumbnail,
    coverUrl,
    paused: Boolean(rawTrack.paused),
    isAd: Boolean(rawTrack.isAd)
  };
}

function cleanMusicMetadata(inputTitle, inputArtist) {
  let title = normalizeWhitespace(inputTitle);
  let artist = normalizeWhitespace(inputArtist)
    .replace(/\s+-\s+Topic$/i, '')
    .replace(/VEVO$/i, '')
    .trim();

  title = title
    .replace(/\s*[\[(](?:official\s+)?(?:music\s+)?video[^\])]*[\])]/gi, '')
    .replace(/\s*[\[(](?:official\s+)?audio[^\])]*[\])]/gi, '')
    .replace(/\s*[\[(](?:lyrics?|lyric\s+video)[^\])]*[\])]/gi, '')
    .replace(/\s*[\[(](?:visuali[sz]er|visualizer)[^\])]*[\])]/gi, '')
    .replace(/\s*[\[(](?:hd|4k|remaster(?:ed)?[^\])]*?)[\])]/gi, '')
    .replace(/\s*\|\s*(?:official\s+)?(?:music\s+)?video.*$/i, '')
    .replace(/\s*\|\s*(?:official\s+)?audio.*$/i, '')
    .replace(/\s*(?:[-–—|•·]\s*)?(?:ft\.?|feat\.?|featuring)\s+.*$/i, '')
    .trim();

  // Artist | Song
  const pipe = title.match(/^(.{1,80}?)\s*\|\s*(.{1,140})$/);
  if (pipe) {
    const left = normalizeWhitespace(pipe[1]);
    const right = normalizeWhitespace(pipe[2]);
    if (left && right) {
      artist = left;
      title = right;
    }
  }

  // YouTube titles are inconsistent about which dash character they use.
  // Hyphen-minus is treated as a separator only when surrounded by whitespace
  // (so artist names like blink-182 remain intact). Unicode dash characters are
  // accepted even without spaces. This catches "C418 - Minecraft - Minecraft
  // Volume Alpha" plus visually identical variants copied from metadata.
  const dashParts = splitMusicDashes(title);

  if (dashParts.length >= 3 && dashParts[0].length <= 80 && dashParts[1].length <= 140) {
    artist = dashParts[0];
    title = dashParts[1];
  } else if (dashParts.length === 2) {
    const left = dashParts[0];
    const right = dashParts[1];
    const comparableChannel = comparable(artist);
    const comparableLeft = comparable(left);

    if (!artist || comparableChannel.includes(comparableLeft) || comparableLeft.includes(comparableChannel)) {
      artist = left;
      title = right;
    } else if (/topic$/i.test(inputArtist) || /vevo$/i.test(inputArtist)) {
      artist = left;
      title = right;
    }
  }

  return {
    title: normalizeWhitespace(title),
    artist: normalizeWhitespace(artist)
  };
}

function splitMusicDashes(value) {
  return normalizeWhitespace(value)
    .split(/(?:\s+-\s+|\s*[‐‑‒–—―−]\s*)/u)
    .map(normalizeWhitespace)
    .filter(Boolean);
}

function comparable(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9\p{L}]/gu, '');
}

function squareCoverUrl(url) {
  const params = new URLSearchParams({
    url,
    w: '512',
    h: '512',
    fit: 'cover',
    output: 'jpg',
    q: '90'
  });
  return `https://images.weserv.nl/?${params.toString()}`;
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clamp(value, max) {
  const str = String(value || '');
  return str.length <= max ? str : `${str.slice(0, Math.max(0, max - 1))}…`;
}

function isValidClientId(value) {
  return /^\d{15,25}$/.test(String(value || '').trim());
}

function cancelPending() {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
}

async function setBadge(on) {
  await chrome.action.setBadgeText({ text: on ? '♪' : '' });
  if (on) await chrome.action.setBadgeBackgroundColor({ color: '#6d5dfc' });
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

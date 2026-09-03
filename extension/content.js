(() => {
  let lastSerialized = '';
  let lastSentAt = 0;
  let video = null;
  let heartbeat = null;

  const IMPORTANT_EVENTS = ['play', 'pause', 'seeking', 'seeked', 'loadedmetadata', 'durationchange', 'ended', 'emptied'];

  function attachVideo(nextVideo) {
    if (video === nextVideo) return;

    if (video) {
      for (const eventName of IMPORTANT_EVENTS) video.removeEventListener(eventName, sendNow);
    }

    video = nextVideo;
    if (video) {
      for (const eventName of IMPORTANT_EVENTS) video.addEventListener(eventName, sendNow, { passive: true });
    }
  }

  function currentVideo() {
    return document.querySelector('video.html5-main-video, video');
  }

  function getVideoId() {
    const url = new URL(location.href);
    const watchId = url.searchParams.get('v');
    if (watchId) return watchId;

    const shortMatch = url.pathname.match(/^\/shorts\/([^/?#]+)/);
    if (shortMatch) return shortMatch[1];

    return '';
  }

  function getTitle() {
    const selectors = [
      'ytd-watch-metadata h1 yt-formatted-string',
      '#title h1 yt-formatted-string',
      'h1.title yt-formatted-string'
    ];

    for (const selector of selectors) {
      const value = document.querySelector(selector)?.textContent?.trim();
      if (value) return value;
    }

    const meta = document.querySelector('meta[name="title"]')?.content?.trim();
    if (meta) return meta;

    return document.title.replace(/\s*-\s*YouTube\s*$/i, '').trim();
  }

  function getChannel() {
    const selectors = [
      'ytd-watch-metadata #owner ytd-channel-name a',
      'ytd-watch-metadata ytd-channel-name a',
      '#owner ytd-channel-name a',
      '#upload-info ytd-channel-name a'
    ];

    for (const selector of selectors) {
      const value = document.querySelector(selector)?.textContent?.trim();
      if (value) return value;
    }

    return document.querySelector('link[itemprop="name"]')?.getAttribute('content')?.trim() || 'YouTube';
  }

  function isAdPlaying() {
    return Boolean(
      document.querySelector('.html5-video-player.ad-showing') ||
      document.querySelector('ytd-player.ad-showing')
    );
  }

  function collectTrack() {
    const id = getVideoId();
    const current = currentVideo();
    attachVideo(current);

    if (!id || !current) return null;

    const duration = Number.isFinite(current.duration) ? current.duration : 0;
    const currentTime = Number.isFinite(current.currentTime) ? current.currentTime : 0;

    return {
      videoId: id,
      title: getTitle(),
      channel: getChannel(),
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
      thumbnail: `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`,
      currentTime,
      duration,
      paused: current.paused,
      ended: current.ended,
      isAd: isAdPlaying(),
      sampledAt: Date.now()
    };
  }

  async function sendTrack(force = false) {
    const track = collectTrack();
    if (!track) return;

    const identity = JSON.stringify({
      videoId: track.videoId,
      title: track.title,
      channel: track.channel,
      paused: track.paused,
      ended: track.ended,
      isAd: track.isAd,
      duration: Math.round(track.duration)
    });

    const now = Date.now();
    if (!force && identity === lastSerialized && now - lastSentAt < 2_000) return;

    lastSerialized = identity;
    lastSentAt = now;

    try {
      await chrome.runtime.sendMessage({
        type: 'PERFORMATRON_TRACK',
        track
      });
    } catch {
      // Extension reloads can invalidate the current content script.
    }
  }

  function sendNow() {
    void sendTrack(true);
  }

  function startHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => void sendTrack(false), 2_000);
  }

  document.addEventListener('yt-navigate-finish', () => {
    lastSerialized = '';
    setTimeout(sendNow, 250);
    setTimeout(sendNow, 1_000);
  });

  const observer = new MutationObserver(() => {
    const nextVideo = currentVideo();
    if (nextVideo !== video) {
      attachVideo(nextVideo);
      sendNow();
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  attachVideo(currentVideo());
  startHeartbeat();
  setTimeout(sendNow, 500);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'PERFORMATRON_GET_TRACK') {
      const track = collectTrack();
      sendResponse({ ok: Boolean(track), track });
      return true;
    }
  });
})();

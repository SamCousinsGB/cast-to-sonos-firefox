/**
 * Cast to Sonos for Firefox — Tab Audio Capture, Video Frame Sync & Metadata Engine
 * Injected into active tabs on demand via browser.scripting.executeScript.
 */
(() => {
  if (window.__castToSonosCaptureLoaded) return;
  window.__castToSonosCaptureLoaded = true;

  const isTopFrame = window === window.top;
  const SUPPORTED_RATES = new Set([32000, 44100, 48000]);

  // Persistent registry of already-bound HTMLMediaElements so repeated cast
  // sessions never throw InvalidStateError on createMediaElementSource.
  const boundElements = new WeakMap(); // HTMLMediaElement -> { source, localGain, tapGain }

  const captureState = {
    active: false,
    muteLocal: true,
    audioCtx: null,
    masterBus: null,
    processor: null,
    sinkGain: null,
    port: null,
    observer: null,
    attachedSet: new Set(),
    drmDetected: false,
    corsBlocked: false,
    lastLevelSentAt: 0,
    lastMetadataKey: '',
    metadataTimer: null,
    // Frame Sync state
    frameSyncEnabled: false,
    frameSyncDelayMs: 2100,
    frameSyncController: null,
  };

  // =========================================================================
  // 1. Metadata & Dynamic Accent Color Extraction
  // =========================================================================
  function getYoutubeVideoId() {
    try {
      const url = new URL(location.href);
      if (url.hostname.includes('youtube.com')) {
        if (url.searchParams.get('v')) return url.searchParams.get('v');
        const shorts = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{6,})/);
        if (shorts) return shorts[1];
      }
      if (url.hostname === 'youtu.be') {
        return url.pathname.slice(1).split('/')[0] || null;
      }
    } catch {
      // ignore
    }
    return null;
  }

  function extractAccentColor() {
    // 1. Well-known media site accents first (avoids YouTube's white light-mode theme-color!)
    const host = location.hostname.toLowerCase();
    if (host.includes('youtube.com') || host === 'youtu.be') return '#ff3b30';
    if (host.includes('twitch.tv')) return '#9146ff';
    if (host.includes('soundcloud.com')) return '#ff5500';
    if (host.includes('spotify.com')) return '#1db954';
    if (host.includes('bandcamp.com')) return '#1da0c3';
    if (host.includes('vimeo.com')) return '#1ab7ea';
    if (host.includes('mixcloud.com')) return '#5000ff';
    if (host.includes('netflix.com')) return '#e50914';
    if (host.includes('music.apple.com')) return '#fa243c';

    // 2. Explicit page theme-color meta tag (only if colorful and not near-white / near-black)
    const themeMeta = document.querySelector('meta[name="theme-color"]')?.getAttribute('content');
    if (themeMeta && /^#[0-9a-f]{3,6}$|^rgb\(/i.test(themeMeta.trim())) {
      return themeMeta.trim();
    }

    // 3. Try sampling active video frame or computed body/header accent
    try {
      const video = findPrimaryVideo();
      if (video && video.videoWidth > 0 && video.readyState >= 2) {
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 9;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, 16, 9);
        const data = ctx.getImageData(0, 0, 16, 9).data;
        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < data.length; i += 4) {
          const max = Math.max(data[i], data[i + 1], data[i + 2]);
          const min = Math.min(data[i], data[i + 1], data[i + 2]);
          // Weight colorful pixels higher than black/white letterboxes
          const sat = max > 0 ? (max - min) / max : 0;
          if (max > 35 && max < 240 && sat > 0.2) {
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            count++;
          }
        }
        if (count > 0) {
          return `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
        }
      }
    } catch {
      // cross-origin canvas taint, safely ignored
    }

    return '#ff6b4a';
  }

  function extractPageMetadata() {
    const ms = navigator.mediaSession?.metadata;
    const ytId = getYoutubeVideoId();

    let title =
      ms?.title ||
      document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      document.title ||
      location.hostname;

    // Clean common browser suffixes
    title = title.replace(/\s*[-|–]\s*YouTube$/i, '').trim() || location.hostname;

    let artist =
      ms?.artist ||
      document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ||
      location.hostname.replace(/^www\./, '');

    let artworkUrl = '';
    if (ms?.artwork && ms.artwork.length > 0) {
      const sorted = [...ms.artwork].sort((a, b) => {
        const aw = parseInt(String(a.sizes || '0'), 10) || 0;
        const bw = parseInt(String(b.sizes || '0'), 10) || 0;
        return bw - aw;
      });
      artworkUrl = sorted[0]?.src || '';
    }
    if (!artworkUrl && ytId) {
      artworkUrl = `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`;
    }
    if (!artworkUrl) {
      artworkUrl =
        document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
        document.querySelector('link[rel~="icon"]')?.href ||
        '';
    }

    const mediaElements = collectMediaElements();
    const hasVideo = mediaElements.some((el) => el.tagName === 'VIDEO' && el.readyState >= 1);
    const hasAudio = mediaElements.length > 0;
    const isPlaying = mediaElements.some((el) => !el.paused && !el.ended);
    const drmDetected = mediaElements.some((el) => Boolean(el.mediaKeys));

    return {
      title,
      artist,
      artworkUrl,
      accentColor: extractAccentColor(),
      tabUrl: location.href,
      hasVideo,
      hasAudio,
      isPlaying,
      drmDetected,
      mediaCount: mediaElements.length,
    };
  }

  // =========================================================================
  // 2. Audio Capture (HTMLMediaElement + Web Audio API Hook)
  // =========================================================================
  function collectMediaElements(root = document) {
    const found = [];
    const scan = (node) => {
      if (!node || !node.querySelectorAll) return;
      const els = node.querySelectorAll('video, audio');
      for (const el of els) found.push(el);
      // Also traverse open shadow roots (some modern players use web components)
      const all = node.querySelectorAll('*');
      for (const item of all) {
        if (item.shadowRoot) scan(item.shadowRoot);
      }
    };
    scan(root);
    return found;
  }

  function findPrimaryVideo() {
    const videos = collectMediaElements().filter((el) => el.tagName === 'VIDEO');
    if (videos.length === 0) return null;
    // Prefer actively playing largest video
    videos.sort((a, b) => {
      const aPlaying = !a.paused && !a.ended ? 1 : 0;
      const bPlaying = !b.paused && !b.ended ? 1 : 0;
      if (aPlaying !== bPlaying) return bPlaying - aPlaying;
      const aArea = (a.clientWidth || 0) * (a.clientHeight || 0);
      const bArea = (b.clientWidth || 0) * (b.clientHeight || 0);
      return bArea - aArea;
    });
    return videos[0];
  }

  function ensureAudioContext() {
    if (!captureState.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      captureState.audioCtx = new AudioCtx();
      captureState.masterBus = captureState.audioCtx.createGain();
      captureState.sinkGain = captureState.audioCtx.createGain();
      captureState.sinkGain.gain.value = 0;
      captureState.sinkGain.connect(captureState.audioCtx.destination);
    }
    if (captureState.audioCtx.state === 'suspended') {
      captureState.audioCtx.resume().catch(() => {});
    }
    return captureState.audioCtx;
  }

  function attachMediaElement(el) {
    if (!el) return;
    if (el.mediaKeys) {
      captureState.drmDetected = true;
    }

    const ctx = ensureAudioContext();
    let entry = boundElements.get(el);

    if (!entry) {
      let source = null;
      let usedCaptureStream = false;

      // Prefer createMediaElementSource for clean local gain control without muting capture
      try {
        source = ctx.createMediaElementSource(el);
      } catch {
        // Fallback to mozCaptureStream / captureStream if element is already attached elsewhere
        try {
          const stream =
            typeof el.mozCaptureStream === 'function'
              ? el.mozCaptureStream()
              : typeof el.captureStream === 'function'
                ? el.captureStream()
                : null;
          if (stream) {
            source = ctx.createMediaStreamSource(stream);
            usedCaptureStream = true;
          }
        } catch {
          captureState.corsBlocked = true;
          return;
        }
      }

      if (!source) return;

      const localGain = ctx.createGain();
      const tapGain = ctx.createGain();

      source.connect(tapGain);
      if (!usedCaptureStream) {
        source.connect(localGain);
        localGain.connect(ctx.destination);
      }

      entry = { source, localGain, tapGain, usedCaptureStream };
      boundElements.set(el, entry);
    }

    // Wire into master capture bus and apply current local mute preference
    try {
      entry.tapGain.disconnect();
    } catch {
      // ignore
    }
    entry.tapGain.connect(captureState.masterBus);
    entry.localGain.gain.value = captureState.active && captureState.muteLocal ? 0 : 1;
    captureState.attachedSet.add(el);
  }

  function updateLocalMuteState() {
    for (const el of captureState.attachedSet) {
      const entry = boundElements.get(el);
      if (entry && entry.localGain) {
        entry.localGain.gain.value = captureState.active && captureState.muteLocal ? 0 : 1;
      }
    }
    window.postMessage(
      {
        __castToSonos: true,
        type: 'webaudio-control',
        active: captureState.active,
        muteLocal: captureState.muteLocal,
      },
      '*'
    );
  }

  /**
   * Downsample/resample stereo Float32 arrays to 44100 Hz if the system audio clock
   * uses a rate unsupported by MPEG-1 Layer 3 (e.g. 96000 Hz or 192000 Hz).
   */
  function encodeFloat32ToInt16Interleaved(left, right, srcRate) {
    if (SUPPORTED_RATES.has(srcRate)) {
      const out = new Int16Array(left.length * 2);
      for (let i = 0; i < left.length; i++) {
        const l = Math.max(-1, Math.min(1, left[i]));
        const r = Math.max(-1, Math.min(1, right[i]));
        out[i * 2] = l < 0 ? l * 0x8000 : l * 0x7fff;
        out[i * 2 + 1] = r < 0 ? r * 0x8000 : r * 0x7fff;
      }
      return { pcm: out, sampleRate: srcRate };
    }

    const targetRate = 44100;
    const ratio = srcRate / targetRate;
    const outLen = Math.max(1, Math.floor(left.length / ratio));
    const out = new Int16Array(outLen * 2);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i * ratio;
      const idx0 = Math.floor(srcIdx);
      const idx1 = Math.min(left.length - 1, idx0 + 1);
      const frac = srcIdx - idx0;
      const l = Math.max(-1, Math.min(1, left[idx0] + (left[idx1] - left[idx0]) * frac));
      const r = Math.max(-1, Math.min(1, right[idx0] + (right[idx1] - right[idx0]) * frac));
      out[i * 2] = l < 0 ? l * 0x8000 : l * 0x7fff;
      out[i * 2 + 1] = r < 0 ? r * 0x8000 : r * 0x7fff;
    }
    return { pcm: out, sampleRate: targetRate };
  }

  function ensureProcessorRunning(ctx) {
    if (captureState.processor) return;
    const processor = ctx.createScriptProcessor(2048, 2, 2);
    processor.onaudioprocess = (event) => {
      if (!captureState.active || !captureState.port) return;
      // If a child iframe has no attached media elements, stay completely silent
      if (!isTopFrame && captureState.attachedSet.size === 0) return;

      const input = event.inputBuffer;
      const left = input.getChannelData(0);
      const right = input.numberOfChannels > 1 ? input.getChannelData(1) : left;

      let sumL = 0;
      let sumR = 0;
      let peak = 0;
      for (let i = 0; i < left.length; i += 4) {
        const l = left[i];
        const r = right[i];
        sumL += l * l;
        sumR += r * r;
        const p = Math.max(Math.abs(l), Math.abs(r));
        if (p > peak) peak = p;
      }
      const count = Math.max(1, Math.ceil(left.length / 4));
      const rmsL = Math.min(1, Math.sqrt(sumL / count) * 2.2);
      const rmsR = Math.min(1, Math.sqrt(sumR / count) * 2.2);

      const { pcm, sampleRate } = encodeFloat32ToInt16Interleaved(left, right, ctx.sampleRate);

      try {
        captureState.port.postMessage({
          type: 'pcm',
          sampleRate,
          isTopFrame,
          hasAudio: peak > 0.0004,
          mediaCount: captureState.attachedSet.size,
          pcm: new Uint8Array(pcm.buffer),
        });

        const now = performance.now();
        if (now - captureState.lastLevelSentAt > 90) {
          captureState.lastLevelSentAt = now;
          captureState.port.postMessage({
            type: 'levels',
            left: rmsL,
            right: rmsR,
            drmDetected: captureState.drmDetected,
          });
        }
      } catch {
        // port closed
      }
    };

    captureState.masterBus.connect(processor);
    processor.connect(captureState.sinkGain);
    captureState.processor = processor;
  }

  function startAudioCapture({ muteLocal = true, frameSyncEnabled = false, frameSyncDelayMs = 2100 } = {}) {
    captureState.muteLocal = muteLocal;
    captureState.frameSyncEnabled = frameSyncEnabled;
    captureState.frameSyncDelayMs = frameSyncDelayMs;
    captureState.drmDetected = false;
    captureState.corsBlocked = false;

    const ctx = ensureAudioContext();
    const effectiveSampleRate = SUPPORTED_RATES.has(ctx.sampleRate) ? ctx.sampleRate : 44100;

    // Open persistent streaming port to background script
    if (!captureState.port) {
      captureState.port = browser.runtime.connect({ name: 'sonos-audio-stream' });
      captureState.port.onDisconnect.addListener(() => {
        captureState.port = null;
        if (captureState.active) {
          stopAudioCapture();
        }
      });
    }

    captureState.active = true;

    // Attach all current media elements
    for (const el of collectMediaElements()) {
      attachMediaElement(el);
    }

    // Watch for dynamically inserted video/audio elements (YouTube SPA, Twitch, etc.)
    if (!captureState.observer) {
      captureState.observer = new MutationObserver(() => {
        if (!captureState.active) return;
        const prevCount = captureState.attachedSet.size;
        for (const el of collectMediaElements()) {
          if (!captureState.attachedSet.has(el)) {
            attachMediaElement(el);
          }
        }
        // If a child iframe just gained a media element, start its processor now
        if (prevCount === 0 && captureState.attachedSet.size > 0 && !captureState.processor) {
          ensureProcessorRunning(ctx);
        }
      });
      captureState.observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
      });
    }

    // CRITICAL: Never stream silent PCM from empty child iframes (e.g. YouTube ad/analytics iframes)!
    // Only run the PCM ScriptProcessor in frames that actually own media elements (or top frame).
    if (isTopFrame || captureState.attachedSet.size > 0) {
      ensureProcessorRunning(ctx);
    }

    // Activate Web Audio MAIN-world hook
    updateLocalMuteState();

    // Start Frame Sync if requested and we're in the top frame (or frame containing primary video)
    if (frameSyncEnabled) {
      startFrameSync(frameSyncDelayMs);
    }

    // Periodically push metadata updates when YouTube/SPA navigates to next track
    if (isTopFrame && !captureState.metadataTimer) {
      captureState.metadataTimer = setInterval(() => {
        if (!captureState.active || !captureState.port) return;
        const meta = extractPageMetadata();
        const key = `${meta.title}|${meta.artist}|${meta.artworkUrl}`;
        if (key !== captureState.lastMetadataKey) {
          captureState.lastMetadataKey = key;
          try {
            captureState.port.postMessage({ type: 'metadata', metadata: meta });
          } catch {
            // ignore
          }
        }
      }, 2500);
    }

    return {
      ok: true,
      sampleRate: effectiveSampleRate,
      mediaCount: captureState.attachedSet.size,
      drmDetected: captureState.drmDetected,
      metadata: isTopFrame ? extractPageMetadata() : null,
    };
  }

  function stopAudioCapture() {
    captureState.active = false;
    stopFrameSync();

    // Restore local speaker volume on every attached element
    for (const el of captureState.attachedSet) {
      const entry = boundElements.get(el);
      if (entry && entry.localGain) {
        entry.localGain.gain.value = 1;
      }
      if (entry && entry.tapGain) {
        try {
          entry.tapGain.disconnect();
        } catch {
          // ignore
        }
      }
    }
    captureState.attachedSet.clear();

    if (captureState.processor) {
      try {
        captureState.masterBus.disconnect(captureState.processor);
        captureState.processor.disconnect();
      } catch {
        // ignore
      }
      captureState.processor = null;
    }

    if (captureState.observer) {
      captureState.observer.disconnect();
      captureState.observer = null;
    }

    if (captureState.metadataTimer) {
      clearInterval(captureState.metadataTimer);
      captureState.metadataTimer = null;
    }

    if (captureState.port) {
      try {
        captureState.port.disconnect();
      } catch {
        // ignore
      }
      captureState.port = null;
    }

    window.postMessage(
      { __castToSonos: true, type: 'webaudio-control', active: false, muteLocal: false },
      '*'
    );

    return { ok: true };
  }

  // Forward Web Audio PCM tapped from MAIN-world hook
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || !event.data.__castToSonos) return;
    if (event.data.type === 'webaudio-pcm' && captureState.active && captureState.port) {
      try {
        captureState.port.postMessage({
          type: 'pcm',
          sampleRate: event.data.sampleRate || 44100,
          pcm: new Uint8Array(event.data.pcm),
        });
      } catch {
        // ignore
      }
    }
  });

  // =========================================================================
  // 3. Automatic Video Frame Sync (Delays Video Visuals to Match Sonos Buffer)
  // =========================================================================
  function startFrameSync(delayMs = 2100) {
    stopFrameSync();
    const video = findPrimaryVideo();
    if (!video) return { ok: false, reason: 'No video element found on page' };

    captureState.frameSyncEnabled = true;
    captureState.frameSyncDelayMs = Math.max(0, Math.min(5000, Number(delayMs) || 2100));

    const canvas = document.createElement('canvas');
    canvas.className = '__cast-to-sonos-sync-overlay';
    Object.assign(canvas.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483645',
      background: '#000',
      display: 'none',
      objectFit: 'contain',
    });

    // Attach to fullscreen element when in fullscreen, otherwise document.body
    const getOverlayHost = () => document.fullscreenElement || document.body || document.documentElement;
    getOverlayHost().appendChild(canvas);

    const ctx2d = canvas.getContext('2d', { alpha: false });
    const ring = []; // { bitmap: ImageBitmap, ts: number }
    let running = true;
    let lastCaptureTs = 0;
    let rafId = null;

    const clearRing = () => {
      while (ring.length > 0) {
        const item = ring.shift();
        try {
          item.bitmap.close();
        } catch {
          // ignore
        }
      }
    };

    const syncGeometry = () => {
      const rect = video.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20 || video.paused || video.ended) {
        canvas.style.display = 'none';
        return null;
      }
      const host = getOverlayHost();
      if (canvas.parentElement !== host) {
        host.appendChild(canvas);
      }
      canvas.style.left = `${rect.left}px`;
      canvas.style.top = `${rect.top}px`;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      return rect;
    };

    const onSeekOrPause = () => {
      clearRing();
      canvas.style.display = 'none';
    };

    video.addEventListener('seeking', onSeekOrPause);
    video.addEventListener('pause', onSeekOrPause);
    video.addEventListener('ended', onSeekOrPause);

    const tick = () => {
      if (!running) return;
      rafId = requestAnimationFrame(tick);

      const delay = captureState.frameSyncDelayMs;
      if (delay < 80 || video.paused || video.ended || video.readyState < 2) {
        canvas.style.display = 'none';
        return;
      }

      const rect = syncGeometry();
      if (!rect) return;

      const now = performance.now();

      // Capture at ~24fps to keep memory & CPU light while staying silky smooth
      if (now - lastCaptureTs >= 40 && video.videoWidth > 0 && video.videoHeight > 0) {
        lastCaptureTs = now;
        const maxW = 960;
        const scale = video.videoWidth > maxW ? maxW / video.videoWidth : 1;
        const w = Math.max(2, Math.round(video.videoWidth * scale));
        const h = Math.max(2, Math.round(video.videoHeight * scale));

        createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' })
          .then((bitmap) => {
            if (!running) {
              bitmap.close();
              return;
            }
            ring.push({ bitmap, ts: now });
            // Cap buffer length defensively (max 150 frames ~6 seconds)
            while (ring.length > 150) {
              const evicted = ring.shift();
              try {
                evicted.bitmap.close();
              } catch {
                // ignore
              }
            }
          })
          .catch(() => {
            // Cross-origin/DRM video frame capture not permitted; hide overlay cleanly
            canvas.style.display = 'none';
          });
      }

      // Display the frame from `now - delay`
      const targetTs = now - delay;
      let frameToDraw = null;
      while (ring.length > 1 && ring[1].ts <= targetTs) {
        const old = ring.shift();
        try {
          old.bitmap.close();
        } catch {
          // ignore
        }
      }
      if (ring.length > 0 && ring[0].ts <= targetTs) {
        frameToDraw = ring[0].bitmap;
      }

      if (frameToDraw) {
        if (canvas.width !== frameToDraw.width || canvas.height !== frameToDraw.height) {
          canvas.width = frameToDraw.width;
          canvas.height = frameToDraw.height;
        }
        ctx2d.drawImage(frameToDraw, 0, 0);
        canvas.style.display = 'block';
      }
    };

    rafId = requestAnimationFrame(tick);

    captureState.frameSyncController = {
      stop() {
        running = false;
        if (rafId) cancelAnimationFrame(rafId);
        video.removeEventListener('seeking', onSeekOrPause);
        video.removeEventListener('pause', onSeekOrPause);
        video.removeEventListener('ended', onSeekOrPause);
        clearRing();
        canvas.remove();
      },
    };

    return { ok: true, delayMs: captureState.frameSyncDelayMs };
  }

  function stopFrameSync() {
    captureState.frameSyncEnabled = false;
    if (captureState.frameSyncController) {
      captureState.frameSyncController.stop();
      captureState.frameSyncController = null;
    }
  }

  // =========================================================================
  // 4. Tab Transport Control (Play/Pause synced with extension popup)
  // =========================================================================
  function controlTabMedia(action) {
    const media = collectMediaElements();
    for (const el of media) {
      try {
        if (action === 'play') el.play().catch(() => {});
        else if (action === 'pause') el.pause();
      } catch {
        // ignore
      }
    }
    return { ok: true, count: media.length };
  }

  // =========================================================================
  // 5. Message Listener from Background / Popup
  // =========================================================================
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.command) return;

    switch (msg.command) {
      case 'get_metadata':
        return isTopFrame ? Promise.resolve(extractPageMetadata()) : undefined;

      case 'start_capture':
        return Promise.resolve(startAudioCapture(msg.options || {}));

      case 'stop_capture':
        return Promise.resolve(stopAudioCapture());

      case 'set_local_mute':
        captureState.muteLocal = Boolean(msg.muted);
        updateLocalMuteState();
        return Promise.resolve({ ok: true, muteLocal: captureState.muteLocal });

      case 'set_frame_sync':
        if (isTopFrame) {
          if (msg.enabled) {
            return Promise.resolve(startFrameSync(msg.delayMs));
          }
          stopFrameSync();
          return Promise.resolve({ ok: true, enabled: false });
        }
        return undefined;

      case 'update_frame_sync_delay':
        captureState.frameSyncDelayMs = Math.max(0, Math.min(5000, Number(msg.delayMs) || 2100));
        return Promise.resolve({ ok: true, delayMs: captureState.frameSyncDelayMs });

      case 'media_transport':
        return Promise.resolve(controlTabMedia(msg.action));

      default:
        return undefined;
    }
  });
})();

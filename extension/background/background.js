/**
 * Cast to Sonos for Firefox — Background Coordinator
 * Manages local bridge communication (HTTP + WebSocket), tab capture lifecycle,
 * audio streaming, metadata updates, and toolbar badge indicators.
 */

const NATIVE_HOST_NAME = 'cast_to_sonos_firefox';

const DEFAULT_SETTINGS = {
  bridgePort: 41900,
  quality: 'hifi',
  selectedGroupId: null,
  muteLocalTab: true,
  dynamicColors: true,
  frameSyncEnabled: false,
  frameSyncDelayMs: 2100,
  manualIps: [],
};

const state = {
  settingsLoaded: false,
  settings: { ...DEFAULT_SETTINGS },
  bridgeConnected: false,
  bridgeInfo: null,
  cachedGroups: [],
  casting: false,
  paused: false,
  tabId: null,
  targetGroup: null,
  liveVolume: null,
  liveMuted: false,
  quality: 'hifi',
  sampleRate: 44100,
  muteLocalTab: true,
  frameSyncEnabled: false,
  frameSyncDelayMs: 2100,
  estimatedLatencyMs: 2000,
  metadata: null,
  levels: { left: 0, right: 0 },
  drmDetected: false,
  lastError: null,
  ws: null,
  wsReady: false,
  audioTransport: 'ws', // 'ws' or 'http' fallback
  httpPcmQueue: [],
  httpFlushTimer: null,
  activePorts: new Set(),
  activeAudioPort: null,
  activeAudioPortLastSoundAt: 0,
};

function getBridgeBaseUrl() {
  return `http://127.0.0.1:${state.settings.bridgePort || 41900}`;
}

function getBridgeWsUrl() {
  return `ws://127.0.0.1:${state.settings.bridgePort || 41900}/ws/audio`;
}

async function ensureSettingsLoaded() {
  if (state.settingsLoaded) return;
  try {
    const stored = await browser.storage.local.get(['settings', 'cachedGroups', 'activeSession']);
    if (stored.settings) {
      state.settings = { ...DEFAULT_SETTINGS, ...stored.settings };
      state.quality = state.settings.quality;
      state.muteLocalTab = state.settings.muteLocalTab;
      state.frameSyncEnabled = state.settings.frameSyncEnabled;
      state.frameSyncDelayMs = state.settings.frameSyncDelayMs;
    }
    if (Array.isArray(stored.cachedGroups)) {
      state.cachedGroups = stored.cachedGroups;
    }
    if (stored.activeSession && stored.activeSession.casting) {
      state.casting = true;
      state.paused = Boolean(stored.activeSession.paused);
      state.tabId = stored.activeSession.tabId ?? null;
      state.targetGroup = stored.activeSession.targetGroup || null;
      state.quality = stored.activeSession.quality || state.quality;
      state.metadata = stored.activeSession.metadata || null;
    }
  } catch {
    // use defaults
  }
  state.settingsLoaded = true;
}

async function persistSessionSnapshot() {
  try {
    await browser.storage.local.set({
      activeSession: state.casting
        ? {
            casting: true,
            paused: state.paused,
            tabId: state.tabId,
            targetGroup: state.targetGroup,
            quality: state.quality,
            metadata: state.metadata,
          }
        : { casting: false },
      cachedGroups: state.cachedGroups,
    });
  } catch {
    // ignore storage errors
  }
}

async function saveSettings(patch) {
  await ensureSettingsLoaded();
  state.settings = { ...state.settings, ...patch };
  await browser.storage.local.set({ settings: state.settings });
  return state.settings;
}

/**
 * Reconciles extension state with the local bridge's live /api/status so reopening
 * the popup (even after Firefox MV3 suspends the event page) ALWAYS reflects ground truth.
 */
async function syncWithBridgeStatus() {
  try {
    const status = await bridgeFetch('/api/status', { method: 'GET' });
    if (Array.isArray(status.cachedGroups) && status.cachedGroups.length > 0) {
      state.cachedGroups = status.cachedGroups;
    }

    if (status.casting) {
      state.casting = true;
      state.targetGroup = status.targetGroup || state.targetGroup;
      state.quality = status.quality || state.quality;
      state.metadata = status.metadata || state.metadata;
      if (status.metadata?.tabId !== undefined && status.metadata?.tabId !== null) {
        state.tabId = status.metadata.tabId;
      }
      state.estimatedLatencyMs = status.estimatedLatencyMs || state.estimatedLatencyMs;
      if (typeof status.liveVolume === 'number') state.liveVolume = status.liveVolume;
      if (typeof status.liveMuted === 'boolean') state.liveMuted = status.liveMuted;
      if (status.liveTransportState === 'PAUSED_PLAYBACK') state.paused = true;
      else if (status.liveTransportState === 'PLAYING') state.paused = false;

      // If Firefox MV3 suspended & woke background.js while casting, re-attach WebSocket automatically
      if (!state.wsReady && state.audioTransport === 'ws') {
        openAudioWebSocket().catch(() => startHttpAudioFallback());
      }
      // If the cast tab exists and lost its content port after suspend, ensure capture is alive
      if (state.tabId !== null && state.activePorts.size === 0) {
        browser.tabs
          .get(state.tabId)
          .then(async () => {
            await ensureCaptureScriptInjected(state.tabId);
            await browser.tabs.sendMessage(state.tabId, {
              command: 'start_capture',
              options: {
                muteLocal: state.muteLocalTab,
                frameSyncEnabled: state.frameSyncEnabled,
                frameSyncDelayMs: state.frameSyncDelayMs,
              },
            });
          })
          .catch(() => {
            // Tab was closed while suspended; stop cast cleanly
            stopCasting();
          });
      }
    } else if (state.casting) {
      // Bridge is no longer casting (e.g. restarted externally) — clear stale UI state
      state.casting = false;
      state.paused = false;
      state.levels = { left: 0, right: 0 };
      closeAudioWebSocket();
    }

    updateBadge();
    await persistSessionSnapshot();
  } catch {
    // bridge offline
  }
}

async function bridgeFetch(path, options = {}) {
  const res = await fetch(`${getBridgeBaseUrl()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Bridge HTTP ${res.status}`);
  }
  return data;
}

async function tryAutoLaunchBridgeViaNativeHost() {
  try {
    const resp = await browser.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      command: 'ensure_running',
    });
    return Boolean(resp && resp.ok);
  } catch {
    // Native host not installed (user runs start-bridge.bat manually) — completely fine
    return false;
  }
}

async function checkBridgeHealth(allowNativeLaunch = true) {
  try {
    const info = await bridgeFetch('/api/health', { method: 'GET' });
    state.bridgeConnected = true;
    state.bridgeInfo = info;
    // Sync any saved manual IPs into the bridge
    for (const ip of state.settings.manualIps || []) {
      bridgeFetch('/api/devices/manual', {
        method: 'POST',
        body: JSON.stringify({ ip }),
      }).catch(() => {});
    }
    return { connected: true, info };
  } catch {
    if (allowNativeLaunch) {
      const launched = await tryAutoLaunchBridgeViaNativeHost();
      if (launched) {
        return checkBridgeHealth(false);
      }
    }
    state.bridgeConnected = false;
    state.bridgeInfo = null;
    return { connected: false, info: null };
  }
}

function updateBadge() {
  if (state.casting) {
    browser.action.setBadgeText({ text: state.paused ? 'II' : 'ON' });
    browser.action.setBadgeBackgroundColor({ color: state.paused ? '#f59e0b' : '#ff4d5a' });
  } else {
    browser.action.setBadgeText({ text: '' });
  }
}

function openAudioWebSocket() {
  return new Promise((resolve, reject) => {
    closeAudioWebSocket();

    const ws = new WebSocket(getBridgeWsUrl());
    ws.binaryType = 'arraybuffer';

    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error('Timed out connecting audio WebSocket to local bridge.'));
    }, 5000);

    ws.onopen = () => {
      clearTimeout(timeout);
      state.ws = ws;
      state.wsReady = true;
      ws.send(
        JSON.stringify({
          type: 'config',
          quality: state.quality,
          sampleRate: state.sampleRate,
        })
      );
      resolve(ws);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'pong' && typeof msg.latencyMs === 'number') {
          state.estimatedLatencyMs = msg.latencyMs;
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      state.wsReady = false;
      if (state.ws === ws) state.ws = null;
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      state.wsReady = false;
      reject(new Error('Could not connect audio stream to local bridge.'));
    };
  });
}

function closeAudioWebSocket() {
  state.wsReady = false;
  if (state.httpFlushTimer) {
    clearInterval(state.httpFlushTimer);
    state.httpFlushTimer = null;
  }
  state.httpPcmQueue = [];
  if (state.ws) {
    try {
      state.ws.close();
    } catch {
      // ignore
    }
    state.ws = null;
  }
}

function flushHttpPcmQueue() {
  if (!state.casting || state.httpPcmQueue.length === 0) return;
  const chunks = state.httpPcmQueue.splice(0, state.httpPcmQueue.length);
  let totalLen = 0;
  for (const c of chunks) totalLen += c.byteLength;
  if (totalLen === 0) return;

  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }

  fetch(`${getBridgeBaseUrl()}/api/audio/pcm`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Sample-Rate': String(state.sampleRate),
      'X-Quality': String(state.quality),
    },
    body: merged,
  }).catch(() => {});
}

function startHttpAudioFallback() {
  state.audioTransport = 'http';
  state.httpPcmQueue = [];
  if (!state.httpFlushTimer) {
    state.httpFlushTimer = setInterval(flushHttpPcmQueue, 90);
  }
}

async function ensureCaptureScriptInjected(tabId) {
  await browser.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/capture.js'],
  });
}

async function inspectTab(tabId) {
  try {
    await ensureCaptureScriptInjected(tabId);
    const meta = await browser.tabs.sendMessage(tabId, { command: 'get_metadata' });
    return meta;
  } catch (err) {
    // Fallback for restricted pages like about:blank, addons.mozilla.org, etc.
    const tab = await browser.tabs.get(tabId).catch(() => null);
    return {
      title: tab?.title || 'Current Tab',
      artist: 'Firefox',
      artworkUrl: tab?.favIconUrl || '',
      accentColor: '#ff6b4a',
      tabUrl: tab?.url || '',
      hasVideo: false,
      hasAudio: false,
      restricted: true,
      error: err.message,
    };
  }
}

async function startCasting({ tabId, group, quality, muteLocalTab, frameSyncEnabled, frameSyncDelayMs }) {
  state.lastError = null;

  // Stop previous session cleanly if switching tabs or speakers
  if (state.casting) {
    await stopCasting();
  }

  const health = await checkBridgeHealth(true);
  if (!health.connected) {
    throw new Error('Local Sonos Bridge is not running. Launch start-bridge.bat first.');
  }

  state.quality = quality || state.settings.quality || 'hifi';
  state.muteLocalTab = muteLocalTab !== undefined ? Boolean(muteLocalTab) : state.settings.muteLocalTab;
  state.frameSyncEnabled = frameSyncEnabled !== undefined ? Boolean(frameSyncEnabled) : state.settings.frameSyncEnabled;
  state.frameSyncDelayMs = Number(frameSyncDelayMs) || state.settings.frameSyncDelayMs || 2100;

  // 1. Inject capture script into the tab (all frames)
  await ensureCaptureScriptInjected(tabId);

  // 2. Start capturing audio in the tab so we know its exact hardware sampleRate & metadata
  const captureResp = await browser.tabs.sendMessage(tabId, {
    command: 'start_capture',
    options: {
      muteLocal: state.muteLocalTab,
      frameSyncEnabled: state.frameSyncEnabled,
      frameSyncDelayMs: state.frameSyncDelayMs,
    },
  });

  state.sampleRate = captureResp?.sampleRate || 44100;
  state.drmDetected = Boolean(captureResp?.drmDetected);
  state.metadata = captureResp?.metadata || (await inspectTab(tabId));
  state.tabId = tabId;
  state.targetGroup = group;

  // 3. Open WebSocket audio stream to local bridge (auto-fallback to HTTP binary PCM if ws:// is blocked)
  try {
    await openAudioWebSocket();
    state.audioTransport = 'ws';
  } catch {
    startHttpAudioFallback();
  }

  // 4. Command Sonos coordinator via local bridge to play our live LAN stream
  const startRes = await bridgeFetch('/api/cast/start', {
    method: 'POST',
    body: JSON.stringify({
      coordinatorIp: group.coordinatorIp,
      coordinatorUuid: group.coordinatorUuid,
      groupId: group.id,
      groupName: group.name,
      members: group.members,
      quality: state.quality,
      sampleRate: state.sampleRate,
      title: state.metadata?.title || 'Firefox Tab Audio',
      artist: state.metadata?.artist || 'Cast to Sonos for Firefox',
      artworkUrl: state.metadata?.artworkUrl || '',
      tabId,
      tabUrl: state.metadata?.tabUrl || '',
    }),
  });

  state.casting = true;
  state.paused = false;
  state.estimatedLatencyMs = startRes.estimatedLatencyMs || 2100;

  // Save preferred quality, speaker & toggles
  await saveSettings({
    quality: state.quality,
    selectedGroupId: group.id,
    muteLocalTab: state.muteLocalTab,
    frameSyncEnabled: state.frameSyncEnabled,
    frameSyncDelayMs: state.frameSyncDelayMs,
  });

  updateBadge();
  await persistSessionSnapshot();
  return getPublicState();
}

async function stopCasting() {
  const prevTabId = state.tabId;
  state.casting = false;
  state.paused = false;
  state.tabId = null;
  state.activeAudioPort = null;
  state.activeAudioPortLastSoundAt = 0;
  state.levels = { left: 0, right: 0 };
  state.drmDetected = false;

  closeAudioWebSocket();

  if (prevTabId !== null) {
    await browser.tabs.sendMessage(prevTabId, { command: 'stop_capture' }).catch(() => {});
  }

  await bridgeFetch('/api/cast/stop', { method: 'POST', body: '{}' }).catch(() => {});
  updateBadge();
  await persistSessionSnapshot();
  return getPublicState();
}

function getPublicState() {
  return {
    bridgeConnected: state.bridgeConnected,
    bridgeInfo: state.bridgeInfo,
    cachedGroups: state.cachedGroups,
    casting: state.casting,
    paused: state.paused,
    tabId: state.tabId,
    targetGroup: state.targetGroup,
    liveVolume: state.liveVolume,
    liveMuted: state.liveMuted,
    quality: state.quality,
    sampleRate: state.sampleRate,
    muteLocalTab: state.muteLocalTab,
    frameSyncEnabled: state.frameSyncEnabled,
    frameSyncDelayMs: state.frameSyncDelayMs,
    estimatedLatencyMs: state.estimatedLatencyMs,
    metadata: state.metadata,
    levels: state.levels,
    drmDetected: state.drmDetected,
    lastError: state.lastError,
    settings: state.settings,
  };
}

// =========================================================================
// Receive live PCM audio chunks from content script ports -> forward to WS
// =========================================================================
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sonos-audio-stream') return;
  state.activePorts.add(port);

  port.onMessage.addListener((msg) => {
    if (!msg) return;

    if (msg.type === 'pcm') {
      const now = Date.now();
      // Enforce strict single-source clock: NEVER interleave PCM chunks from multiple iframes!
      if (!state.activeAudioPort || !state.activePorts.has(state.activeAudioPort)) {
        if (msg.isTopFrame || msg.hasAudio || (msg.mediaCount || 0) > 0) {
          state.activeAudioPort = port;
        } else {
          return;
        }
      } else if (state.activeAudioPort !== port) {
        // Switch active port ONLY if the other port has real audio and current port has been silent >1s
        if (msg.hasAudio && now - state.activeAudioPortLastSoundAt > 1000) {
          state.activeAudioPort = port;
        } else {
          return;
        }
      }

      if (msg.hasAudio) {
        state.activeAudioPortLastSoundAt = now;
      }

      const bytes = msg.pcm instanceof Uint8Array ? msg.pcm : new Uint8Array(msg.pcm);

      if (msg.sampleRate && msg.sampleRate !== state.sampleRate) {
        state.sampleRate = msg.sampleRate;
        if (state.wsReady && state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(
            JSON.stringify({
              type: 'config',
              quality: state.quality,
              sampleRate: state.sampleRate,
            })
          );
        }
      }

      if (state.audioTransport === 'ws' && state.wsReady && state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      } else if (state.casting) {
        if (state.audioTransport !== 'http') startHttpAudioFallback();
        state.httpPcmQueue.push(bytes);
        if (state.httpPcmQueue.length > 20) {
          state.httpPcmQueue.shift(); // cap latency if network stalls
        }
      }
      return;
    }

    if (msg.type === 'levels') {
      if (state.activeAudioPort && state.activeAudioPort !== port) return;
      state.levels = { left: msg.left || 0, right: msg.right || 0 };
      if (msg.drmDetected) state.drmDetected = true;
      return;
    }

    if (msg.type === 'metadata' && msg.metadata && state.casting) {
      state.metadata = msg.metadata;
      bridgeFetch('/api/cast/metadata', {
        method: 'POST',
        body: JSON.stringify({
          title: msg.metadata.title,
          artist: msg.metadata.artist,
          artworkUrl: msg.metadata.artworkUrl,
          tabUrl: msg.metadata.tabUrl,
        }),
      }).catch(() => {});
    }
  });

  port.onDisconnect.addListener(() => {
    state.activePorts.delete(port);
    if (state.activeAudioPort === port) {
      state.activeAudioPort = null;
    }
  });
});

// Clean up casting if the cast tab is closed
browser.tabs.onRemoved.addListener((removedTabId) => {
  if (state.casting && state.tabId === removedTabId) {
    stopCasting();
  }
});

// =========================================================================
// Popup & Options Page RPC Handler
// =========================================================================
browser.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.action) return;

  return (async () => {
    await ensureSettingsLoaded();

    switch (msg.action) {
      case 'get_state': {
        const health = await checkBridgeHealth(true);
        if (health.connected) {
          await syncWithBridgeStatus();
        }
        return getPublicState();
      }

      case 'set_quality': {
        state.quality = msg.quality || 'hifi';
        await saveSettings({ quality: state.quality });
        if (state.casting && state.tabId !== null && state.targetGroup) {
          return startCasting({
            tabId: state.tabId,
            group: state.targetGroup,
            quality: state.quality,
            muteLocalTab: state.muteLocalTab,
            frameSyncEnabled: state.frameSyncEnabled,
            frameSyncDelayMs: state.frameSyncDelayMs,
          });
        }
        return getPublicState();
      }

      case 'set_selected_group': {
        await saveSettings({ selectedGroupId: msg.groupId || null });
        return getPublicState();
      }

      case 'get_levels':
        return {
          casting: state.casting,
          paused: state.paused,
          metadata: state.metadata,
          levels: state.levels,
          drmDetected: state.drmDetected,
          estimatedLatencyMs: state.estimatedLatencyMs,
        };

      case 'inspect_tab':
        return inspectTab(msg.tabId);

      case 'discover_devices': {
        const health = await checkBridgeHealth(true);
        if (!health.connected) {
          return { connected: false, groups: [], households: [] };
        }
        const data = await bridgeFetch(`/api/devices?refresh=${msg.refresh === false ? 'false' : 'true'}`);
        if (Array.isArray(data.groups)) {
          state.cachedGroups = data.groups;
          await persistSessionSnapshot();
        }
        return { connected: true, ...data };
      }

      case 'add_manual_ip': {
        const ip = String(msg.ip || '').trim();
        const res = await bridgeFetch('/api/devices/manual', {
          method: 'POST',
          body: JSON.stringify({ ip }),
        });
        const ips = new Set(state.settings.manualIps || []);
        ips.add(ip);
        await saveSettings({ manualIps: Array.from(ips) });
        return res;
      }

      case 'remove_manual_ip': {
        const ip = String(msg.ip || '').trim();
        const res = await bridgeFetch('/api/devices/manual', {
          method: 'DELETE',
          body: JSON.stringify({ ip }),
        }).catch(() => ({ ok: true }));
        const ips = (state.settings.manualIps || []).filter((x) => x !== ip);
        await saveSettings({ manualIps: ips });
        return res;
      }

      case 'start_cast':
        return startCasting(msg);

      case 'stop_cast':
        return stopCasting();

      case 'transport': {
        if (state.tabId !== null && (msg.command === 'play' || msg.command === 'pause')) {
          await browser.tabs
            .sendMessage(state.tabId, { command: 'media_transport', action: msg.command })
            .catch(() => {});
        }
        await bridgeFetch('/api/transport', {
          method: 'POST',
          body: JSON.stringify({
            coordinatorIp: msg.coordinatorIp || state.targetGroup?.coordinatorIp,
            action: msg.command,
          }),
        });
        state.paused = msg.command === 'pause';
        updateBadge();
        return getPublicState();
      }

      case 'set_volume': {
        const res = await bridgeFetch('/api/volume', {
          method: 'POST',
          body: JSON.stringify({
            coordinatorIp: msg.coordinatorIp || state.targetGroup?.coordinatorIp,
            volume: msg.volume,
            muted: msg.muted,
          }),
        });
        if (typeof res.volume === 'number') state.liveVolume = res.volume;
        if (typeof res.muted === 'boolean') state.liveMuted = res.muted;
        return res;
      }

      case 'set_local_mute': {
        state.muteLocalTab = Boolean(msg.muted);
        await saveSettings({ muteLocalTab: state.muteLocalTab });
        if (state.tabId !== null) {
          await browser.tabs
            .sendMessage(state.tabId, { command: 'set_local_mute', muted: state.muteLocalTab })
            .catch(() => {});
        }
        return getPublicState();
      }

      case 'set_frame_sync': {
        state.frameSyncEnabled = Boolean(msg.enabled);
        if (typeof msg.delayMs === 'number') {
          state.frameSyncDelayMs = msg.delayMs;
        }
        await saveSettings({
          frameSyncEnabled: state.frameSyncEnabled,
          frameSyncDelayMs: state.frameSyncDelayMs,
        });
        if (state.tabId !== null) {
          await browser.tabs
            .sendMessage(state.tabId, {
              command: 'set_frame_sync',
              enabled: state.frameSyncEnabled,
              delayMs: state.frameSyncDelayMs,
            })
            .catch(() => {});
        }
        return getPublicState();
      }

      case 'update_frame_sync_delay': {
        state.frameSyncDelayMs = Number(msg.delayMs) || 2100;
        await saveSettings({ frameSyncDelayMs: state.frameSyncDelayMs });
        if (state.tabId !== null) {
          await browser.tabs
            .sendMessage(state.tabId, {
              command: 'update_frame_sync_delay',
              delayMs: state.frameSyncDelayMs,
            })
            .catch(() => {});
        }
        return getPublicState();
      }

      case 'group_join':
        return bridgeFetch('/api/group/join', {
          method: 'POST',
          body: JSON.stringify({
            memberIp: msg.memberIp,
            coordinatorUuid: msg.coordinatorUuid,
          }),
        });

      case 'group_leave':
        return bridgeFetch('/api/group/leave', {
          method: 'POST',
          body: JSON.stringify({ memberIp: msg.memberIp }),
        });

      case 'save_settings':
        return saveSettings(msg.settings || {});

      case 'reset_all': {
        if (state.casting) await stopCasting();
        await browser.storage.local.clear();
        state.settings = { ...DEFAULT_SETTINGS };
        return { ok: true, settings: state.settings };
      }

      default:
        return { error: `Unknown action: ${msg.action}` };
    }
  })().catch((err) => {
    state.lastError = err.message;
    return { error: err.message };
  });
});

// Initialize settings & reconcile with bridge on extension startup
ensureSettingsLoaded().then(() => checkBridgeHealth(false).then((h) => h.connected && syncWithBridgeStatus()));

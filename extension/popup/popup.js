const $ = (id) => document.getElementById(id);

const ui = {
  app: $('app'),
  statusPill: $('statusPill'),
  statusText: $('statusText'),
  refreshBtn: $('refreshBtn'),
  optionsBtn: $('optionsBtn'),
  tabArtwork: $('tabArtwork'),
  liveBadge: $('liveBadge'),
  tabTitle: $('tabTitle'),
  tabArtist: $('tabArtist'),
  vuMeter: $('vuMeter'),
  vuLeft: $('vuLeft'),
  vuRight: $('vuRight'),
  alertBanner: $('alertBanner'),
  offlineCard: $('offlineCard'),
  retryBridgeBtn: $('retryBridgeBtn'),
  mainControls: $('mainControls'),
  toggleManualIpBtn: $('toggleManualIpBtn'),
  manualIpForm: $('manualIpForm'),
  manualIpInput: $('manualIpInput'),
  deviceList: $('deviceList'),
  qualityGrid: $('qualityGrid'),
  castBtn: $('castBtn'),
  castBtnLabel: $('castBtnLabel'),
  playPauseBtn: $('playPauseBtn'),
  playPauseIcon: $('playPauseIcon'),
  switchTabBtn: $('switchTabBtn'),
  sonosMuteBtn: $('sonosMuteBtn'),
  volumeSlider: $('volumeSlider'),
  volumeValue: $('volumeValue'),
  localMuteToggle: $('localMuteToggle'),
  frameSyncToggle: $('frameSyncToggle'),
  syncControls: $('syncControls'),
  syncDelaySlider: $('syncDelaySlider'),
  syncDelayValue: $('syncDelayValue'),
  measuredLatencyLabel: $('measuredLatencyLabel'),
  autoSyncBtn: $('autoSyncBtn'),
};

let activeTab = null;
let tabMeta = null;
let extState = null;
let devices = [];
let selectedGroupId = null;
let selectedQuality = 'hifi';
let sonosMuted = false;
let levelTimer = null;
let volumeDebounce = null;

function showAlert(message, isError = false) {
  if (!message) {
    ui.alertBanner.classList.add('hidden');
    return;
  }
  ui.alertBanner.textContent = message;
  ui.alertBanner.classList.toggle('error', isError);
  ui.alertBanner.classList.remove('hidden');
}

function parseRgb(color) {
  if (!color) return null;
  const c = color.trim();
  if (c.startsWith('#') && (c.length === 7 || c.length === 4)) {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  const m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

function applyAccentColor(color) {
  if (!color || extState?.settings?.dynamicColors === false) return;
  const rgb = parseRgb(color);
  if (!rgb) return;
  const [r, g, b] = rgb;
  // Reject near-white, near-black, or low-saturation grays so contrast stays sharp
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sat = max > 0 ? (max - min) / max : 0;
  if (luma > 210 || luma < 45 || sat < 0.22) return;

  document.documentElement.style.setProperty('--accent', `rgb(${r}, ${g}, ${b})`);
  document.documentElement.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.22)`);
}

function updateStatusPill() {
  ui.statusPill.classList.remove('status-checking', 'status-ready', 'status-live', 'status-offline');
  if (!extState?.bridgeConnected) {
    ui.statusPill.classList.add('status-offline');
    ui.statusText.textContent = 'Bridge Offline';
  } else if (extState.casting) {
    ui.statusPill.classList.add('status-live');
    ui.statusText.textContent = extState.paused ? 'Paused' : 'Casting';
  } else {
    ui.statusPill.classList.add('status-ready');
    ui.statusText.textContent = 'Ready';
  }
}

function renderMetadata() {
  const meta = extState?.casting && extState.metadata ? extState.metadata : tabMeta;
  if (!meta) return;

  ui.tabTitle.textContent = meta.title || activeTab?.title || 'Current Firefox Tab';
  ui.tabArtist.textContent = meta.artist || 'Firefox';

  if (meta.artworkUrl) {
    ui.tabArtwork.src = meta.artworkUrl;
    ui.tabArtwork.onerror = () => {
      ui.tabArtwork.src = '../icons/icon.svg';
    };
  } else {
    ui.tabArtwork.src = '../icons/icon.svg';
  }

  if (meta.accentColor) {
    applyAccentColor(meta.accentColor);
  }

  if (meta.restricted) {
    showAlert('Browser internal pages cannot be captured. Switch to a media tab like YouTube or Twitch.');
  } else if (meta.drmDetected || extState?.drmDetected) {
    showAlert('Protected DRM (Widevine) media detected. Firefox blocks audio capture on DRM-encrypted streams.');
  } else if (!extState?.lastError) {
    showAlert('');
  }
}

function renderDevices() {
  ui.deviceList.replaceChildren();

  if (devices.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No Sonos speakers found automatically. Make sure you are on the same Wi-Fi or click "+ Manual IP".';
    ui.deviceList.appendChild(empty);
    ui.castBtn.disabled = !extState?.casting;
    return;
  }

  // Keep current target selected if casting, else restore last chosen speaker, else default to first
  if (extState?.casting && extState.targetGroup) {
    selectedGroupId = extState.targetGroup.id;
  } else if (!selectedGroupId || !devices.some((d) => d.id === selectedGroupId)) {
    const savedId = extState?.settings?.selectedGroupId;
    selectedGroupId = savedId && devices.some((d) => d.id === savedId) ? savedId : devices[0].id;
  }

  for (const group of devices) {
    const isSelected = group.id === selectedGroupId;
    const isCastingHere = extState?.casting && extState.targetGroup?.coordinatorIp === group.coordinatorIp;

    const btn = document.createElement('button');
    btn.className = `device-item${isSelected ? ' selected' : ''}`;
    btn.type = 'button';

    const roomNames = group.members.map((m) => m.name).join(', ');
    const infoEl = document.createElement('div');
    infoEl.className = 'device-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'device-name';
    nameEl.textContent = group.name;

    const subEl = document.createElement('div');
    subEl.className = 'device-sub';
    subEl.textContent =
      group.members.length > 1 ? `${roomNames} · ${group.coordinatorIp}` : group.coordinatorIp;

    infoEl.append(nameEl, subEl);

    const badgeEl = document.createElement('span');
    badgeEl.className = 'device-badge';
    const displayVol =
      isCastingHere && typeof extState?.liveVolume === 'number'
        ? extState.liveVolume
        : group.volume ?? 30;
    badgeEl.textContent = isCastingHere
      ? 'LIVE'
      : group.members.length > 1
        ? `${group.members.length} rooms`
        : `${displayVol}%`;

    btn.append(infoEl, badgeEl);

    btn.addEventListener('click', () => {
      selectedGroupId = group.id;
      browser.runtime.sendMessage({ action: 'set_selected_group', groupId: group.id }).catch(() => {});
      syncVolumeFromGroup(group);
      renderDevices();
      updateActionButtons();
    });

    ui.deviceList.appendChild(btn);
  }

  const activeGroup = getSelectedGroup();
  if (activeGroup) syncVolumeFromGroup(activeGroup);
  updateActionButtons();
}

function getSelectedGroup() {
  return devices.find((d) => d.id === selectedGroupId) || devices[0] || null;
}

function syncVolumeFromGroup(group) {
  if (!group) return;
  const isCastingHere = extState?.casting && extState.targetGroup?.coordinatorIp === group.coordinatorIp;
  const vol =
    isCastingHere && typeof extState?.liveVolume === 'number'
      ? extState.liveVolume
      : typeof group.volume === 'number'
        ? group.volume
        : 30;
  ui.volumeSlider.value = String(vol);
  ui.volumeValue.textContent = `${vol}%`;
  sonosMuted = isCastingHere && typeof extState?.liveMuted === 'boolean' ? extState.liveMuted : Boolean(group.muted);
  ui.sonosMuteBtn.style.color = sonosMuted ? '#fb7185' : '';
}

function updateQualityUI() {
  for (const pill of ui.qualityGrid.querySelectorAll('.quality-pill')) {
    pill.classList.toggle('active', pill.dataset.quality === selectedQuality);
  }
}

function setPlayPauseIcon(isPaused) {
  const ns = 'http://www.w3.org/2000/svg';
  ui.playPauseIcon.replaceChildren();
  if (isPaused) {
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', '6 4 20 12 6 20 6 4');
    ui.playPauseIcon.appendChild(poly);
  } else {
    for (const x of ['6', '14']) {
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', '4');
      rect.setAttribute('width', '4');
      rect.setAttribute('height', '16');
      rect.setAttribute('rx', '1');
      ui.playPauseIcon.appendChild(rect);
    }
  }
}

function updateActionButtons() {
  const isCasting = Boolean(extState?.casting);
  const hasDevice = Boolean(getSelectedGroup());
  const isRestricted = Boolean(tabMeta?.restricted);
  const castingDifferentTab =
    isCasting && activeTab && extState.tabId !== null && extState.tabId !== activeTab.id && !isRestricted;

  ui.liveBadge.classList.toggle('hidden', !isCasting);
  ui.vuMeter.classList.toggle('hidden', !isCasting);
  ui.playPauseBtn.classList.toggle('hidden', !isCasting);
  ui.switchTabBtn.classList.toggle('hidden', !castingDifferentTab);

  if (isCasting) {
    ui.castBtn.classList.remove('btn-primary');
    ui.castBtn.classList.add('btn-danger');
    ui.castBtn.disabled = false;
    ui.castBtnLabel.textContent = `Stop Casting (${extState.targetGroup?.name || 'Sonos'})`;
    setPlayPauseIcon(Boolean(extState.paused));
  } else {
    ui.castBtn.classList.remove('btn-danger');
    ui.castBtn.classList.add('btn-primary');
    ui.castBtn.disabled = !hasDevice || isRestricted;
    const target = getSelectedGroup();
    ui.castBtnLabel.textContent = target ? `Cast Tab to ${target.name}` : 'Select a Sonos Speaker';
  }
}

function updateSyncUI() {
  const enabled = Boolean(extState?.frameSyncEnabled);
  const delayMs = Number(extState?.frameSyncDelayMs ?? 2100);
  const estMs = Number(extState?.estimatedLatencyMs ?? 2100);

  ui.frameSyncToggle.checked = enabled;
  ui.syncControls.classList.toggle('hidden', !enabled);
  ui.syncDelaySlider.value = String(delayMs);
  ui.syncDelayValue.textContent = `${(delayMs / 1000).toFixed(2)}s`;
  ui.measuredLatencyLabel.textContent = `Estimated Sonos buffer: ${(estMs / 1000).toFixed(2)}s`;
}

function startLevelPolling() {
  if (levelTimer) clearInterval(levelTimer);
  levelTimer = setInterval(async () => {
    if (!extState?.casting) return;
    try {
      const res = await browser.runtime.sendMessage({ action: 'get_levels' });
      if (!res) return;
      ui.vuLeft.style.width = `${Math.round((res.levels?.left || 0) * 100)}%`;
      ui.vuRight.style.width = `${Math.round((res.levels?.right || 0) * 100)}%`;
      if (res.estimatedLatencyMs) {
        extState.estimatedLatencyMs = res.estimatedLatencyMs;
        ui.measuredLatencyLabel.textContent = `Estimated Sonos buffer: ${(res.estimatedLatencyMs / 1000).toFixed(2)}s`;
      }
      if (res.drmDetected) {
        showAlert('Protected DRM (Widevine) media detected. Firefox blocks audio capture on DRM-encrypted streams.');
      }
    } catch {
      // popup closing
    }
  }, 110);
}

async function loadAll(refreshDevices = false) {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs[0] || null;

  const [stateRes, metaRes] = await Promise.all([
    browser.runtime.sendMessage({ action: 'get_state' }),
    activeTab ? browser.runtime.sendMessage({ action: 'inspect_tab', tabId: activeTab.id }) : null,
  ]);

  extState = stateRes;
  tabMeta = metaRes;
  selectedQuality = extState?.quality || extState?.settings?.quality || 'hifi';
  ui.localMuteToggle.checked = extState?.muteLocalTab !== false;

  updateStatusPill();
  renderMetadata();
  updateQualityUI();
  updateSyncUI();

  if (!extState?.bridgeConnected) {
    ui.offlineCard.classList.remove('hidden');
    ui.mainControls.classList.add('hidden');
    return;
  }

  ui.offlineCard.classList.add('hidden');
  ui.mainControls.classList.remove('hidden');

  // Instant render from cached speakers so reopening the popup feels immediate & tied together
  if (Array.isArray(extState.cachedGroups) && extState.cachedGroups.length > 0) {
    devices = extState.cachedGroups;
    renderDevices();
  } else {
    updateActionButtons();
    const scanning = document.createElement('div');
    scanning.className = 'empty-state';
    scanning.textContent = 'Scanning Wi-Fi for Sonos speakers...';
    ui.deviceList.replaceChildren(scanning);
  }

  if (extState.casting) {
    startLevelPolling();
  }

  // Silently refresh speaker list if requested or if no cached speakers exist yet
  if (refreshDevices || devices.length === 0) {
    const disc = await browser.runtime.sendMessage({ action: 'discover_devices', refresh: true });
    if (disc && Array.isArray(disc.groups) && disc.groups.length > 0) {
      devices = disc.groups;
      renderDevices();
    } else if (devices.length === 0) {
      devices = [];
      renderDevices();
    }
  }
}

// =========================================================================
// Event Listeners
// =========================================================================
ui.refreshBtn.addEventListener('click', () => loadAll(true));
ui.retryBridgeBtn.addEventListener('click', () => loadAll(true));
ui.optionsBtn.addEventListener('click', () => browser.runtime.openOptionsPage());

ui.toggleManualIpBtn.addEventListener('click', () => {
  ui.manualIpForm.classList.toggle('hidden');
  if (!ui.manualIpForm.classList.contains('hidden')) {
    ui.manualIpInput.focus();
  }
});

ui.manualIpForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const ip = ui.manualIpInput.value.trim();
  if (!ip) return;
  showAlert('');
  try {
    const res = await browser.runtime.sendMessage({ action: 'add_manual_ip', ip });
    if (res?.error) {
      showAlert(res.error, true);
      return;
    }
    ui.manualIpInput.value = '';
    ui.manualIpForm.classList.add('hidden');
    devices = res?.discovery?.groups || [];
    renderDevices();
  } catch (err) {
    showAlert(err.message || 'Could not reach speaker at that IP.', true);
  }
});

ui.qualityGrid.addEventListener('click', async (e) => {
  const pill = e.target.closest('.quality-pill');
  if (!pill) return;
  const nextQuality = pill.dataset.quality;
  if (nextQuality === selectedQuality) return;
  selectedQuality = nextQuality;
  updateQualityUI();

  const res = await browser.runtime.sendMessage({ action: 'set_quality', quality: selectedQuality });
  if (res && !res.error) {
    extState = res;
    updateStatusPill();
    updateActionButtons();
    updateSyncUI();
  } else if (res?.error) {
    showAlert(res.error, true);
  }
});

ui.switchTabBtn.addEventListener('click', async () => {
  const group = getSelectedGroup();
  if (!group || !activeTab) return;
  ui.switchTabBtn.disabled = true;
  const res = await browser.runtime.sendMessage({
    action: 'start_cast',
    tabId: activeTab.id,
    group,
    quality: selectedQuality,
    muteLocalTab: ui.localMuteToggle.checked,
    frameSyncEnabled: ui.frameSyncToggle.checked,
    frameSyncDelayMs: Number(ui.syncDelaySlider.value),
  });
  ui.switchTabBtn.disabled = false;
  if (res && !res.error) {
    extState = res;
    updateStatusPill();
    renderMetadata();
    renderDevices();
    updateSyncUI();
    startLevelPolling();
  } else if (res?.error) {
    showAlert(res.error, true);
  }
});

ui.castBtn.addEventListener('click', async () => {
  showAlert('');
  ui.castBtn.disabled = true;

  try {
    if (extState?.casting) {
      extState = await browser.runtime.sendMessage({ action: 'stop_cast' });
      updateStatusPill();
      updateActionButtons();
      renderDevices();
      return;
    }

    const group = getSelectedGroup();
    if (!group || !activeTab) return;

    ui.castBtnLabel.textContent = 'Connecting to Sonos...';
    const res = await browser.runtime.sendMessage({
      action: 'start_cast',
      tabId: activeTab.id,
      group,
      quality: selectedQuality,
      muteLocalTab: ui.localMuteToggle.checked,
      frameSyncEnabled: ui.frameSyncToggle.checked,
      frameSyncDelayMs: Number(ui.syncDelaySlider.value),
    });

    if (res?.error) {
      showAlert(res.error, true);
      updateActionButtons();
      return;
    }

    extState = res;
    updateStatusPill();
    renderMetadata();
    renderDevices();
    updateSyncUI();
    startLevelPolling();
  } catch (err) {
    showAlert(err.message || 'Failed to start casting.', true);
    updateActionButtons();
  }
});

ui.playPauseBtn.addEventListener('click', async () => {
  const command = extState?.paused ? 'play' : 'pause';
  const res = await browser.runtime.sendMessage({ action: 'transport', command });
  if (res && !res.error) {
    extState = res;
    updateStatusPill();
    updateActionButtons();
  }
});

ui.volumeSlider.addEventListener('input', () => {
  const vol = Number(ui.volumeSlider.value);
  ui.volumeValue.textContent = `${vol}%`;
  const group = getSelectedGroup();
  if (group) group.volume = vol;

  clearTimeout(volumeDebounce);
  volumeDebounce = setTimeout(() => {
    browser.runtime.sendMessage({
      action: 'set_volume',
      coordinatorIp: group?.coordinatorIp,
      volume: vol,
    });
  }, 60);
});

ui.sonosMuteBtn.addEventListener('click', async () => {
  sonosMuted = !sonosMuted;
  ui.sonosMuteBtn.style.color = sonosMuted ? '#fb7185' : '';
  const group = getSelectedGroup();
  await browser.runtime.sendMessage({
    action: 'set_volume',
    coordinatorIp: group?.coordinatorIp,
    muted: sonosMuted,
  });
});

ui.localMuteToggle.addEventListener('change', async () => {
  const res = await browser.runtime.sendMessage({
    action: 'set_local_mute',
    muted: ui.localMuteToggle.checked,
  });
  if (res && !res.error) extState = res;
});

ui.frameSyncToggle.addEventListener('change', async () => {
  const enabled = ui.frameSyncToggle.checked;
  const delayMs = Number(ui.syncDelaySlider.value);
  ui.syncControls.classList.toggle('hidden', !enabled);
  const res = await browser.runtime.sendMessage({
    action: 'set_frame_sync',
    enabled,
    delayMs,
  });
  if (res && !res.error) extState = res;
});

ui.syncDelaySlider.addEventListener('input', () => {
  const delayMs = Number(ui.syncDelaySlider.value);
  ui.syncDelayValue.textContent = `${(delayMs / 1000).toFixed(2)}s`;
  browser.runtime.sendMessage({ action: 'update_frame_sync_delay', delayMs });
});

ui.autoSyncBtn.addEventListener('click', () => {
  const est = Math.max(0, Math.min(4500, Math.round((extState?.estimatedLatencyMs || 2100) / 50) * 50));
  ui.syncDelaySlider.value = String(est);
  ui.syncDelayValue.textContent = `${(est / 1000).toFixed(2)}s`;
  browser.runtime.sendMessage({ action: 'update_frame_sync_delay', delayMs: est });
});

window.addEventListener('unload', () => {
  if (levelTimer) clearInterval(levelTimer);
});

loadAll(false);

const bridgePort = document.getElementById('bridgePort');
const defaultQuality = document.getElementById('defaultQuality');
const muteLocalTab = document.getElementById('muteLocalTab');
const dynamicColors = document.getElementById('dynamicColors');
const frameSyncDelayMs = document.getElementById('frameSyncDelayMs');
const manualIpList = document.getElementById('manualIpList');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const statusMsg = document.getElementById('statusMsg');

function showStatus(text) {
  statusMsg.textContent = text;
  setTimeout(() => {
    if (statusMsg.textContent === text) statusMsg.textContent = '';
  }, 2600);
}

function renderManualIps(ips = []) {
  manualIpList.replaceChildren();
  if (!ips.length) {
    const empty = document.createElement('div');
    empty.className = 'desc';
    empty.textContent = 'No manual IPs saved.';
    manualIpList.appendChild(empty);
    return;
  }
  for (const ip of ips) {
    const row = document.createElement('div');
    row.className = 'ip-row';
    const label = document.createElement('span');
    label.textContent = ip;
    const btn = document.createElement('button');
    btn.className = 'btn btn-danger btn-sm';
    btn.textContent = 'Remove';
    btn.addEventListener('click', async () => {
      await browser.runtime.sendMessage({ action: 'remove_manual_ip', ip });
      load();
    });
    row.append(label, btn);
    manualIpList.appendChild(row);
  }
}

async function load() {
  const state = await browser.runtime.sendMessage({ action: 'get_state' });
  const s = state?.settings || {};
  bridgePort.value = s.bridgePort || 41900;
  defaultQuality.value = s.quality || 'hifi';
  muteLocalTab.checked = s.muteLocalTab !== false;
  dynamicColors.checked = s.dynamicColors !== false;
  frameSyncDelayMs.value = s.frameSyncDelayMs ?? 2100;
  renderManualIps(s.manualIps || []);
}

saveBtn.addEventListener('click', async () => {
  await browser.runtime.sendMessage({
    action: 'save_settings',
    settings: {
      bridgePort: Number(bridgePort.value) || 41900,
      quality: defaultQuality.value,
      muteLocalTab: muteLocalTab.checked,
      dynamicColors: dynamicColors.checked,
      frameSyncDelayMs: Number(frameSyncDelayMs.value) || 2100,
    },
  });
  showStatus('Settings saved.');
});

resetBtn.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ action: 'reset_all' });
  await load();
  showStatus('All extension data cleared and reset to defaults.');
});

load();

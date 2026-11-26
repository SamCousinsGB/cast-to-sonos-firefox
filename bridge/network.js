import os from 'node:os';

/**
 * Picks the best local IPv4 address on the LAN that Sonos speakers can reach.
 * Optionally matches the subnet of a target Sonos IP when one is known.
 */
export function getLocalLanIp(targetIp = null) {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    const lowerName = name.toLowerCase();
    // Deprioritize virtual adapters (WSL, Hyper-V, Docker, VirtualBox, VMware, VPNs)
    const isVirtual = /vethernet|wsl|docker|virtual|vmware|vbox|tailscale|zerotier|loopback|hyper-v|tun|tap|nord|wireguard/.test(lowerName);

    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      // Ignore APIPA 169.254.x.x
      if (addr.address.startsWith('169.254.')) continue;

      let score = 0;
      if (!isVirtual) score += 100;
      if (addr.address.startsWith('192.168.')) score += 30;
      else if (addr.address.startsWith('10.')) score += 20;
      else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(addr.address)) score += 10;

      if (targetIp && sameSubnet24(addr.address, targetIp)) {
        score += 500;
      }

      candidates.push({ address: addr.address, name, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || '127.0.0.1';
}

export function getAllLocalLanIps() {
  const interfaces = os.networkInterfaces();
  const results = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) {
        results.push({ name, address: addr.address });
      }
    }
  }
  return results;
}

function sameSubnet24(ipA, ipB) {
  const a = ipA.split('.');
  const b = ipB.split('.');
  return a.length === 4 && b.length === 4 && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

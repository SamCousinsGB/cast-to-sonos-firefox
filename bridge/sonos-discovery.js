import dgram from 'node:dgram';
import { getZoneGroupState, getGroupVolume, getGroupMute, getTransportInfo, extractTag } from './sonos-upnp.js';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SONOS_SEARCH_TARGET = 'urn:schemas-upnp-org:device:ZonePlayer:1';

/**
 * Parse ZoneGroupState XML into normalized households, groups, and visible rooms.
 */
export function parseZoneGroupState(zoneGroupXml, householdId = 'local') {
  const groups = [];
  if (!zoneGroupXml) return groups;

  const groupRegex = /<ZoneGroup\s+([^>]+)>([\s\S]*?)<\/ZoneGroup>/gi;
  let groupMatch;

  while ((groupMatch = groupRegex.exec(zoneGroupXml)) !== null) {
    const groupAttrs = parseXmlAttributes(groupMatch[1]);
    const innerXml = groupMatch[2];
    const coordinatorUuid = groupAttrs.Coordinator || '';
    const groupId = groupAttrs.ID || coordinatorUuid;

    const members = [];
    const memberRegex = /<ZoneGroupMember\s+([^>]+?)(?:\/>|>([\s\S]*?)<\/ZoneGroupMember>)/gi;
    let memberMatch;

    while ((memberMatch = memberRegex.exec(innerXml)) !== null) {
      const attrs = parseXmlAttributes(memberMatch[1]);
      // Skip bonded surrounds, subs, stereo-pair secondary channels, and Boosts
      if (attrs.Invisible === '1' || attrs.IsZoneBridge === '1') continue;

      const ip = extractIpFromLocation(attrs.Location || '');
      if (!ip) continue;

      members.push({
        uuid: attrs.UUID || '',
        name: attrs.ZoneName || 'Sonos Speaker',
        ip,
        location: attrs.Location || `http://${ip}:1400/xml/device_description.xml`,
        isCoordinator: attrs.UUID === coordinatorUuid,
        softwareVersion: attrs.SWGen || '',
      });
    }

    if (members.length === 0) continue;

    const coordinator = members.find((m) => m.isCoordinator) || members[0];
    const displayName =
      members.length === 1
        ? coordinator.name
        : `${coordinator.name} + ${members.length - 1}`;

    groups.push({
      id: groupId,
      householdId,
      coordinatorUuid: coordinator.uuid,
      coordinatorIp: coordinator.ip,
      coordinatorName: coordinator.name,
      name: displayName,
      members,
    });
  }

  groups.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}

export function parseXmlAttributes(attrString = '') {
  const attrs = {};
  const regex = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = regex.exec(attrString)) !== null) {
    attrs[match[1]] = match[2]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }
  return attrs;
}

export function extractIpFromLocation(location = '') {
  const match = location.match(/https?:\/\/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/i);
  return match ? match[1] : null;
}

/**
 * Send SSDP M-SEARCH packets to find Sonos ZonePlayers on the LAN.
 */
export function discoverSonosIpsViaSsdp(timeoutMs = 2200) {
  return new Promise((resolve) => {
    const found = new Map(); // ip -> { ip, location, household }
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const finish = () => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(Array.from(found.values()));
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on('error', () => {
      clearTimeout(timer);
      finish();
    });

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      if (!/sonos|ZonePlayer/i.test(text)) return;

      const locMatch = text.match(/^LOCATION:\s*(.+)$/im);
      const hhMatch = text.match(/^X-RINCON-HOUSEHOLD:\s*(.+)$/im);
      const location = locMatch ? locMatch[1].trim() : `http://${rinfo.address}:1400/xml/device_description.xml`;
      const ip = extractIpFromLocation(location) || rinfo.address;
      const household = hhMatch ? hhMatch[1].trim() : 'default';

      if (!found.has(ip)) {
        found.set(ip, { ip, location, household });
      }
    });

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(4);
      } catch {
        // ignore if interface rejects multicast TTL
      }

      const packet = Buffer.from(
        [
          'M-SEARCH * HTTP/1.1',
          `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
          'MAN: "ssdp:discover"',
          'MX: 2',
          `ST: ${SONOS_SEARCH_TARGET}`,
          '',
          '',
        ].join('\r\n')
      );

      // Send twice for UDP reliability
      socket.send(packet, 0, packet.length, SSDP_PORT, SSDP_ADDRESS);
      setTimeout(() => {
        try {
          socket.send(packet, 0, packet.length, SSDP_PORT, SSDP_ADDRESS);
        } catch {
          // ignore
        }
      }, 350);
    });
  });
}

/**
 * Fetches device metadata (room name, model, household) directly from a speaker IP.
 */
export async function probeSonosSpeaker(ip, timeoutMs = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${ip}:1400/xml/device_description.xml`, {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const roomName = extractTag(xml, 'roomName') || extractTag(xml, 'friendlyName') || `Sonos (${ip})`;
    const modelName = extractTag(xml, 'modelName') || 'Sonos';
    const udn = (extractTag(xml, 'UDN') || '').replace(/^uuid:/i, '');
    return { ip, roomName, modelName, uuid: udn };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Discovers all Sonos households, groups, and speakers (merging SSDP + manual seed IPs).
 */
export async function discoverSonosTopology(manualIps = []) {
  const ssdpDevices = await discoverSonosIpsViaSsdp(2200);
  const seedMap = new Map();

  for (const dev of ssdpDevices) {
    seedMap.set(dev.ip, dev.household || 'default');
  }
  for (const ip of manualIps) {
    const trimmed = String(ip || '').trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(trimmed) && !seedMap.has(trimmed)) {
      seedMap.set(trimmed, 'manual');
    }
  }

  const households = new Map(); // householdId -> { id, groups: Map<groupId, group> }
  const queriedHouseholds = new Set();

  for (const [ip, householdHint] of seedMap.entries()) {
    if (queriedHouseholds.has(householdHint) && householdHint !== 'default' && householdHint !== 'manual') {
      continue;
    }

    try {
      const zoneStateXml = await getZoneGroupState(ip);
      const parsedGroups = parseZoneGroupState(zoneStateXml, householdHint);
      if (parsedGroups.length > 0) {
        queriedHouseholds.add(householdHint);
        const hhKey = householdHint === 'manual' ? 'default' : householdHint;
        if (!households.has(hhKey)) {
          households.set(hhKey, new Map());
        }
        const hhGroups = households.get(hhKey);
        for (const group of parsedGroups) {
          hhGroups.set(group.coordinatorUuid || group.id, group);
        }
      }
    } catch {
      // Fallback: probe device_description.xml directly if ZoneGroupTopology fails
      try {
        const info = await probeSonosSpeaker(ip);
        const hhKey = 'default';
        if (!households.has(hhKey)) households.set(hhKey, new Map());
        const hhGroups = households.get(hhKey);
        if (!hhGroups.has(info.uuid || ip)) {
          hhGroups.set(info.uuid || ip, {
            id: info.uuid || ip,
            householdId: hhKey,
            coordinatorUuid: info.uuid || ip,
            coordinatorIp: ip,
            coordinatorName: info.roomName,
            name: info.roomName,
            modelName: info.modelName,
            members: [
              {
                uuid: info.uuid || ip,
                name: info.roomName,
                ip,
                isCoordinator: true,
                modelName: info.modelName,
              },
            ],
          });
        }
      } catch {
        // unreachable manual IP
      }
    }
  }

  // Enrich each discovered group with live volume, mute, and transport state
  const allGroups = [];
  for (const [hhId, groupMap] of households.entries()) {
    for (const group of groupMap.values()) {
      const [volume, muted, transport] = await Promise.all([
        getGroupVolume(group.coordinatorIp).catch(() => 30),
        getGroupMute(group.coordinatorIp).catch(() => false),
        getTransportInfo(group.coordinatorIp).catch(() => ({ state: 'STOPPED' })),
      ]);

      allGroups.push({
        ...group,
        householdId: hhId,
        volume,
        muted,
        transportState: transport.state,
      });
    }
  }

  allGroups.sort((a, b) => a.name.localeCompare(b.name));
  return {
    households: Array.from(households.keys()),
    groups: allGroups,
    discoveredAt: Date.now(),
  };
}

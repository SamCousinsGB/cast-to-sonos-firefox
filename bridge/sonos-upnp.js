/**
 * Sonos UPnP / SOAP Control Client
 * Communicates directly with Sonos speakers on local port 1400.
 */

export function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function decodeXmlEntities(str = '') {
  return String(str)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Send a raw UPnP SOAP action to a Sonos speaker.
 */
export async function sendSoapAction(ip, path, service, action, params = {}, timeoutMs = 6000) {
  const paramsXml = Object.entries(params)
    .map(([key, val]) => `<${key}>${escapeXml(val)}</${key}>`)
    .join('');

  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${service}">${paramsXml}</u:${action}>
  </s:Body>
</s:Envelope>`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`http://${ip}:1400${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${service}#${action}"`,
      },
      body,
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      const errCode = extractTag(text, 'errorCode') || res.status;
      throw new Error(`Sonos SOAP ${action} failed (${res.status}, UPnP error ${errCode})`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export function extractTag(xml, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? decodeXmlEntities(match[1].trim()) : null;
}

/**
 * Builds DIDL-Lite XML metadata so the Sonos app displays rich track title,
 * site/artist name, and album artwork while casting from Firefox.
 */
export function buildDidlLiteMetadata({
  streamUri,
  title = 'Firefox Tab Audio',
  artist = 'Cast to Sonos for Firefox',
  albumArtUri = '',
  mimeType = 'audio/mpeg',
  sampleRate = 44100,
  channels = 2,
}) {
  const safeTitle = escapeXml(title || 'Firefox Tab Audio');
  const safeArtist = escapeXml(artist || 'Cast to Sonos for Firefox');
  const safeUri = escapeXml(streamUri);
  const artTag = albumArtUri ? `<upnp:albumArtURI>${escapeXml(albumArtUri)}</upnp:albumArtURI>` : '';

  if (mimeType === 'audio/wav') {
    const dlnaFlags = 'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
    return `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="0" parentID="-1" restricted="true"><dc:title>${safeTitle}</dc:title><dc:creator>${safeArtist}</dc:creator><upnp:artist>${safeArtist}</upnp:artist>${artTag}<upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="http-get:*:audio/wav:${dlnaFlags}" sampleFrequency="${sampleRate}" nrAudioChannels="${channels}" bitsPerSample="16">${safeUri}</res></item></DIDL-Lite>`;
  }

  return `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="R:0/0/0" parentID="R:0/0" restricted="true"><dc:title>${safeTitle}</dc:title><dc:creator>${safeArtist}</dc:creator><upnp:artist>${safeArtist}</upnp:artist>${artTag}<upnp:class>object.item.audioItem.audioBroadcast</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON65031_</desc><res protocolInfo="http-get:*:audio/mpeg:*">${safeUri}</res></item></DIDL-Lite>`;
}

/**
 * Converts an HTTP stream URL into the appropriate Sonos URI scheme.
 * For live MP3 streams, x-rincon-mp3radio:// tells Sonos to treat the source
 * as an infinite live broadcast stream with fast startup and no range seeking.
 */
export function toSonosStreamUri(httpUrl, format = 'mp3') {
  if (format === 'wav') {
    return httpUrl;
  }
  return httpUrl.replace(/^https?:\/\//i, 'x-rincon-mp3radio://');
}

export async function setAvTransportUri(ip, streamUri, metadataXml = '') {
  return sendSoapAction(
    ip,
    '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1',
    'SetAVTransportURI',
    {
      InstanceID: 0,
      CurrentURI: streamUri,
      CurrentURIMetaData: metadataXml,
    }
  );
}

export async function play(ip) {
  return sendSoapAction(
    ip,
    '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1',
    'Play',
    {
      InstanceID: 0,
      Speed: 1,
    }
  );
}

export async function pause(ip) {
  return sendSoapAction(
    ip,
    '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1',
    'Pause',
    {
      InstanceID: 0,
    }
  );
}

export async function stop(ip) {
  return sendSoapAction(
    ip,
    '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1',
    'Stop',
    {
      InstanceID: 0,
    }
  );
}

export async function getTransportInfo(ip) {
  const xml = await sendSoapAction(
    ip,
    '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1',
    'GetTransportInfo',
    { InstanceID: 0 }
  );
  return {
    state: extractTag(xml, 'CurrentTransportState') || 'STOPPED',
    status: extractTag(xml, 'CurrentTransportStatus') || 'OK',
  };
}

export async function getGroupVolume(ip) {
  try {
    const xml = await sendSoapAction(
      ip,
      '/MediaRenderer/GroupRenderingControl/Control',
      'urn:schemas-upnp-org:service:GroupRenderingControl:1',
      'GetGroupVolume',
      { InstanceID: 0 }
    );
    const val = Number(extractTag(xml, 'CurrentVolume'));
    return Number.isFinite(val) ? val : 30;
  } catch {
    return getVolume(ip);
  }
}

export async function setGroupVolume(ip, volume) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(volume))));
  try {
    await sendSoapAction(
      ip,
      '/MediaRenderer/GroupRenderingControl/Control',
      'urn:schemas-upnp-org:service:GroupRenderingControl:1',
      'SetGroupVolume',
      { InstanceID: 0, DesiredVolume: clamped }
    );
  } catch {
    await setVolume(ip, clamped);
  }
  return clamped;
}

export async function getGroupMute(ip) {
  try {
    const xml = await sendSoapAction(
      ip,
      '/MediaRenderer/GroupRenderingControl/Control',
      'urn:schemas-upnp-org:service:GroupRenderingControl:1',
      'GetGroupMute',
      { InstanceID: 0 }
    );
    return extractTag(xml, 'CurrentMute') === '1';
  } catch {
    return getMute(ip);
  }
}

export async function setGroupMute(ip, muted) {
  const desired = muted ? 1 : 0;
  try {
    await sendSoapAction(
      ip,
      '/MediaRenderer/GroupRenderingControl/Control',
      'urn:schemas-upnp-org:service:GroupRenderingControl:1',
      'SetGroupMute',
      { InstanceID: 0, DesiredMute: desired }
    );
  } catch {
    await setMute(ip, muted);
  }
  return Boolean(muted);
}

export async function getVolume(ip) {
  const xml = await sendSoapAction(
    ip,
    '/MediaRenderer/RenderingControl/Control',
    'urn:schemas-upnp-org:service:RenderingControl:1',
    'GetVolume',
    { InstanceID: 0, Channel: 'Master' }
  );
  const val = Number(extractTag(xml, 'CurrentVolume'));
  return Number.isFinite(val) ? val : 30;
}

export async function setVolume(ip, volume) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(volume))));
  await sendSoapAction(
    ip,
    '/MediaRenderer/RenderingControl/Control',
    'urn:schemas-upnp-org:service:RenderingControl:1',
    'SetVolume',
    { InstanceID: 0, Channel: 'Master', DesiredVolume: clamped }
  );
  return clamped;
}

export async function getMute(ip) {
  const xml = await sendSoapAction(
    ip,
    '/MediaRenderer/RenderingControl/Control',
    'urn:schemas-upnp-org:service:RenderingControl:1',
    'GetMute',
    { InstanceID: 0, Channel: 'Master' }
  );
  return extractTag(xml, 'CurrentMute') === '1';
}

export async function setMute(ip, muted) {
  await sendSoapAction(
    ip,
    '/MediaRenderer/RenderingControl/Control',
    'urn:schemas-upnp-org:service:RenderingControl:1',
    'SetMute',
    { InstanceID: 0, Channel: 'Master', DesiredMute: muted ? 1 : 0 }
  );
  return Boolean(muted);
}

export async function getZoneGroupState(ip) {
  const xml = await sendSoapAction(
    ip,
    '/ZoneGroupTopology/Control',
    'urn:schemas-upnp-org:service:ZoneGroupTopology:1',
    'GetZoneGroupState',
    {}
  );
  return extractTag(xml, 'ZoneGroupState') || '';
}

export async function joinGroup(memberIp, coordinatorUuid) {
  return setAvTransportUri(memberIp, `x-rincon:${coordinatorUuid}`, '');
}

export async function leaveGroup(memberIp) {
  return sendSoapAction(
    memberIp,
    '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1',
    'BecomeCoordinatorOfStandaloneGroup',
    { InstanceID: 0 }
  );
}

import http from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';
import { getLocalLanIp, getAllLocalLanIps } from './network.js';
import { discoverSonosTopology, probeSonosSpeaker } from './sonos-discovery.js';
import * as sonos from './sonos-upnp.js';
import { AudioStreamPipeline, QUALITY_PRESETS } from './audio-pipeline.js';

export const DEFAULT_PORT = Number(process.env.CAST_SONOS_PORT || 41900);

// Minimal built-in SVG artwork served to Sonos when a tab has no thumbnail/og:image
const DEFAULT_ARTWORK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#111318"/>
      <stop offset="100%" stop-color="#221933"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ff7139"/>
      <stop offset="100%" stop-color="#ff2e63"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="96" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="140" fill="none" stroke="url(#accent)" stroke-width="24" opacity="0.25"/>
  <circle cx="256" cy="256" r="92" fill="none" stroke="url(#accent)" stroke-width="24" opacity="0.55"/>
  <circle cx="256" cy="256" r="44" fill="url(#accent)"/>
</svg>`;

export function createBridgeServer({ port = DEFAULT_PORT, host = '0.0.0.0' } = {}) {
  const pipeline = new AudioStreamPipeline();

  const state = {
    casting: false,
    sessionId: null,
    targetGroup: null,
    quality: 'hifi',
    sampleRate: 44100,
    metadata: {
      title: 'Firefox Tab Audio',
      artist: 'Cast to Sonos for Firefox',
      artworkUrl: '',
      tabId: null,
      tabUrl: '',
    },
    cachedArtwork: {
      buffer: Buffer.from(DEFAULT_ARTWORK_SVG, 'utf8'),
      contentType: 'image/svg+xml',
      sourceUrl: '',
      version: 1,
    },
    manualIps: new Set(),
    lastDiscovery: { households: [], groups: [], discoveredAt: 0 },
    streamRequestedAt: 0,
    sonosPulledAt: 0,
    estimatedLatencyMs: 2100,
  };

  async function refreshArtworkCache(artworkUrl) {
    if (!artworkUrl || artworkUrl === state.cachedArtwork.sourceUrl) {
      return state.cachedArtwork.version;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      const res = await fetch(artworkUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'CastToSonosFirefox/1.0' },
      });
      clearTimeout(timer);

      if (res.ok) {
        const contentType = res.headers.get('content-type') || 'image/jpeg';
        if (contentType.startsWith('image/')) {
          const arrBuf = await res.arrayBuffer();
          if (arrBuf.byteLength > 0 && arrBuf.byteLength <= 5 * 1024 * 1024) {
            state.cachedArtwork = {
              buffer: Buffer.from(arrBuf),
              contentType,
              sourceUrl: artworkUrl,
              version: state.cachedArtwork.version + 1,
            };
            return state.cachedArtwork.version;
          }
        }
      }
    } catch {
      // Fallback to default artwork silently
    }

    state.cachedArtwork = {
      buffer: Buffer.from(DEFAULT_ARTWORK_SVG, 'utf8'),
      contentType: 'image/svg+xml',
      sourceUrl: '',
      version: state.cachedArtwork.version + 1,
    };
    return state.cachedArtwork.version;
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          reject(new Error('Request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res, status, data) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
  }

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = parsedUrl.pathname;

    // Handle CORS preflight from Firefox extension popup/background
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Sample-Rate, X-Quality',
      });
      res.end();
      return;
    }

    // ---------------------------------------------------------
    // 1. Live Audio Stream Endpoints (Pulled by Sonos Speakers)
    // ---------------------------------------------------------
    const isStreamPath =
      pathname === '/stream.mp3' ||
      pathname === '/stream.wav' ||
      /^\/stream\/[^/]+\.(mp3|wav)$/i.test(pathname);

    if (isStreamPath && (req.method === 'HEAD' || req.method === 'GET')) {
      const format = pathname.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3';
      const contentType = format === 'wav' ? 'audio/wav' : 'audio/mpeg';

      if (req.method === 'HEAD') {
        console.log(`[Bridge] Sonos HEAD probe ${pathname} from ${req.socket.remoteAddress}`);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Accept-Ranges': 'none',
          'transferMode.dlna.org': 'Streaming',
          'contentFeatures.dlna.org':
            'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
          Connection: 'close',
        });
        res.end();
        return;
      }

      const now = Date.now();
      state.sonosPulledAt = now;
      if (state.streamRequestedAt > 0) {
        const connectDelay = Math.min(2000, Math.max(100, now - state.streamRequestedAt));
        const baseSonosBuffer = format === 'wav' ? 1400 : 1950;
        state.estimatedLatencyMs = Math.round(baseSonosBuffer + connectDelay * 0.35);
        pipeline.measuredLatencyMs = state.estimatedLatencyMs;
      }

      const rangeHdr = req.headers.range ? ` [Range: ${req.headers.range}]` : '';
      console.log(`[Bridge] Sonos GET ${pathname} from ${req.socket.remoteAddress}${rangeHdr}`);
      pipeline.attachHttpClient(res, format, state.metadata.title || 'Cast to Sonos for Firefox');
      return;
    }

    // ---------------------------------------------------------
    // 2. Artwork Proxy Endpoint (Pulled by Sonos App / Speaker)
    // ---------------------------------------------------------
    if (req.method === 'GET' && pathname === '/artwork') {
      res.writeHead(200, {
        'Content-Type': state.cachedArtwork.contentType,
        'Content-Length': state.cachedArtwork.buffer.length,
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(state.cachedArtwork.buffer);
      return;
    }

    // ---------------------------------------------------------
    // 2b. HTTP Binary PCM Ingest Fallback (immune to ws:// blocks)
    // ---------------------------------------------------------
    if (req.method === 'POST' && pathname === '/api/audio/pcm') {
      const sampleRateHdr = Number(req.headers['x-sample-rate']);
      const qualityHdr = req.headers['x-quality'];
      if (sampleRateHdr && sampleRateHdr !== state.sampleRate) {
        pipeline.configure({
          quality: qualityHdr || state.quality,
          sampleRate: sampleRateHdr,
        });
        state.sampleRate = pipeline.inputSampleRate;
      }

      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        if (chunks.length > 0) {
          pipeline.ingestPcm(Buffer.concat(chunks));
        }
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, X-Sample-Rate, X-Quality',
          'Cache-Control': 'no-store',
        });
        res.end();
      });
      return;
    }

    // ---------------------------------------------------------
    // 3. Control & Discovery REST API (Used by Firefox Extension)
    // ---------------------------------------------------------
    try {
      if (req.method === 'GET' && pathname === '/api/health') {
        const lanIp = getLocalLanIp(state.targetGroup?.coordinatorIp);
        return sendJson(res, 200, {
          ok: true,
          version: '1.0.0',
          lanIp,
          allLanIps: getAllLocalLanIps(),
          port: server.address()?.port || port,
          presets: Object.values(QUALITY_PRESETS),
        });
      }

      if (req.method === 'GET' && pathname === '/api/status') {
        let liveVolume = null;
        let liveMuted = null;
        let liveTransportState = null;

        if (state.targetGroup?.coordinatorIp) {
          const [vol, mut, tr] = await Promise.all([
            sonos.getGroupVolume(state.targetGroup.coordinatorIp).catch(() => null),
            sonos.getGroupMute(state.targetGroup.coordinatorIp).catch(() => null),
            sonos.getTransportInfo(state.targetGroup.coordinatorIp).catch(() => null),
          ]);
          liveVolume = vol;
          liveMuted = mut;
          liveTransportState = tr?.state || null;
        }

        return sendJson(res, 200, {
          casting: state.casting,
          sessionId: state.sessionId,
          targetGroup: state.targetGroup,
          quality: state.quality,
          sampleRate: state.sampleRate,
          metadata: state.metadata,
          estimatedLatencyMs: state.estimatedLatencyMs,
          liveVolume,
          liveMuted,
          liveTransportState,
          cachedGroups: state.lastDiscovery.groups || [],
          pipeline: pipeline.getStats(),
          manualIps: Array.from(state.manualIps),
        });
      }

      if (req.method === 'GET' && pathname === '/api/devices') {
        const refresh = parsedUrl.searchParams.get('refresh') !== 'false';
        if (refresh || state.lastDiscovery.discoveredAt === 0) {
          state.lastDiscovery = await discoverSonosTopology(Array.from(state.manualIps));
        }
        return sendJson(res, 200, {
          ...state.lastDiscovery,
          manualIps: Array.from(state.manualIps),
        });
      }

      if (req.method === 'POST' && pathname === '/api/devices/manual') {
        const body = await readJsonBody(req);
        const ip = String(body.ip || '').trim();
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
          return sendJson(res, 400, { error: 'Please provide a valid IPv4 address (e.g. 192.168.1.50).' });
        }
        // Probe speaker to give immediate feedback
        const info = await probeSonosSpeaker(ip);
        state.manualIps.add(ip);
        state.lastDiscovery = await discoverSonosTopology(Array.from(state.manualIps));
        return sendJson(res, 200, { ok: true, speaker: info, discovery: state.lastDiscovery });
      }

      if (req.method === 'DELETE' && pathname === '/api/devices/manual') {
        const body = await readJsonBody(req);
        state.manualIps.delete(String(body.ip || '').trim());
        state.lastDiscovery = await discoverSonosTopology(Array.from(state.manualIps));
        return sendJson(res, 200, { ok: true, discovery: state.lastDiscovery });
      }

      if (req.method === 'POST' && pathname === '/api/cast/start') {
        const body = await readJsonBody(req);
        const coordinatorIp = String(body.coordinatorIp || '').trim();
        if (!coordinatorIp) {
          return sendJson(res, 400, { error: 'coordinatorIp is required.' });
        }

        const quality = QUALITY_PRESETS[body.quality] ? body.quality : 'hifi';
        const sampleRate = Number(body.sampleRate) || 44100;
        const preset = QUALITY_PRESETS[quality];

        pipeline.disconnectAllClients();
        pipeline.configure({ quality, sampleRate, forceReset: true });

        state.quality = quality;
        state.sampleRate = pipeline.inputSampleRate;
        state.sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        state.targetGroup = {
          id: body.groupId || coordinatorIp,
          coordinatorIp,
          coordinatorUuid: body.coordinatorUuid || '',
          name: body.groupName || coordinatorIp,
          members: body.members || [],
        };
        state.metadata = {
          title: body.title || 'Firefox Tab Audio',
          artist: body.artist || 'Cast to Sonos for Firefox',
          artworkUrl: body.artworkUrl || '',
          tabId: body.tabId ?? null,
          tabUrl: body.tabUrl || '',
        };

        const artVersion = await refreshArtworkCache(state.metadata.artworkUrl);
        const activePort = server.address()?.port || port;
        const lanIp = getLocalLanIp(coordinatorIp);
        const ext = preset.format === 'wav' ? 'wav' : 'mp3';
        const httpStreamUrl = `http://${lanIp}:${activePort}/stream/${state.sessionId}.${ext}`;
        const sonosUri = sonos.toSonosStreamUri(httpStreamUrl, preset.format);
        const albumArtUri = `http://${lanIp}:${activePort}/artwork?v=${artVersion}`;

        const didl = sonos.buildDidlLiteMetadata({
          streamUri: sonosUri,
          title: state.metadata.title,
          artist: state.metadata.artist,
          albumArtUri,
          mimeType: preset.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
          sampleRate: pipeline.sampleRate,
          channels: preset.channels,
        });

        state.streamRequestedAt = Date.now();
        await sonos.setAvTransportUri(coordinatorIp, sonosUri, didl);
        await sonos.play(coordinatorIp);

        state.casting = true;
        console.log(`[Bridge] Casting "${state.metadata.title}" -> ${state.targetGroup.name} (${coordinatorIp}) [${preset.label}]`);

        return sendJson(res, 200, {
          ok: true,
          sessionId: state.sessionId,
          streamUrl: httpStreamUrl,
          sonosUri,
          lanIp,
          preset,
          estimatedLatencyMs: state.estimatedLatencyMs,
        });
      }

      if (req.method === 'POST' && pathname === '/api/cast/metadata') {
        const body = await readJsonBody(req);
        state.metadata = {
          ...state.metadata,
          title: body.title || state.metadata.title,
          artist: body.artist || state.metadata.artist,
          artworkUrl: body.artworkUrl ?? state.metadata.artworkUrl,
          tabUrl: body.tabUrl ?? state.metadata.tabUrl,
        };
        await refreshArtworkCache(state.metadata.artworkUrl);
        return sendJson(res, 200, { ok: true, metadata: state.metadata });
      }

      if (req.method === 'POST' && pathname === '/api/cast/stop') {
        const ip = state.targetGroup?.coordinatorIp;
        state.casting = false;
        state.sessionId = null;
        pipeline.disconnectAllClients();
        if (ip) {
          await sonos.stop(ip).catch(() => {});
        }
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && pathname === '/api/transport') {
        const body = await readJsonBody(req);
        const ip = body.coordinatorIp || state.targetGroup?.coordinatorIp;
        if (!ip) return sendJson(res, 400, { error: 'No Sonos device targeted.' });

        if (body.action === 'play') await sonos.play(ip);
        else if (body.action === 'pause') await sonos.pause(ip);
        else if (body.action === 'stop') await sonos.stop(ip);
        else return sendJson(res, 400, { error: 'Unknown transport action.' });

        return sendJson(res, 200, { ok: true, action: body.action });
      }

      if (req.method === 'POST' && pathname === '/api/volume') {
        const body = await readJsonBody(req);
        const ip = body.coordinatorIp || state.targetGroup?.coordinatorIp;
        if (!ip) return sendJson(res, 400, { error: 'No Sonos device targeted.' });

        const result = {};
        if (typeof body.volume === 'number') {
          result.volume = await sonos.setGroupVolume(ip, body.volume);
        }
        if (typeof body.muted === 'boolean') {
          result.muted = await sonos.setGroupMute(ip, body.muted);
        }
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (req.method === 'POST' && pathname === '/api/group/join') {
        const body = await readJsonBody(req);
        if (!body.memberIp || !body.coordinatorUuid) {
          return sendJson(res, 400, { error: 'memberIp and coordinatorUuid are required.' });
        }
        await sonos.joinGroup(body.memberIp, body.coordinatorUuid);
        state.lastDiscovery = await discoverSonosTopology(Array.from(state.manualIps));
        return sendJson(res, 200, { ok: true, discovery: state.lastDiscovery });
      }

      if (req.method === 'POST' && pathname === '/api/group/leave') {
        const body = await readJsonBody(req);
        if (!body.memberIp) {
          return sendJson(res, 400, { error: 'memberIp is required.' });
        }
        await sonos.leaveGroup(body.memberIp);
        state.lastDiscovery = await discoverSonosTopology(Array.from(state.manualIps));
        return sendJson(res, 200, { ok: true, discovery: state.lastDiscovery });
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error(`[Bridge] Error handling ${req.method} ${pathname}:`, err.message);
      return sendJson(res, 500, { error: err.message || 'Internal bridge error' });
    }
  });

  // ---------------------------------------------------------
  // 4. WebSocket Binary Audio Ingest (/ws/audio)
  // ---------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (parsedUrl.pathname !== '/ws/audio') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    console.log('[Bridge] Firefox audio WebSocket connected');
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        pipeline.ingestPcm(data);
        return;
      }

      // JSON control messages over the audio socket (e.g. config handshake)
      try {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.type === 'config') {
          pipeline.configure({
            quality: msg.quality || state.quality,
            sampleRate: msg.sampleRate || state.sampleRate,
          });
          state.quality = pipeline.preset.id;
          state.sampleRate = pipeline.inputSampleRate;
          ws.send(JSON.stringify({ type: 'ack', preset: pipeline.preset, sampleRate: pipeline.sampleRate }));
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now(), latencyMs: state.estimatedLatencyMs }));
        }
      } catch {
        // ignore malformed text message
      }
    });
  });

  return {
    server,
    wss,
    pipeline,
    state,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const actualPort = server.address()?.port || port;
          const lanIp = getLocalLanIp();
          console.log('======================================================');
          console.log('  Cast to Sonos for Firefox — Local Audio Bridge');
          console.log(`  Local API:    http://127.0.0.1:${actualPort}`);
          console.log(`  LAN Stream:   http://${lanIp}:${actualPort}/stream.mp3`);
          console.log('  Status:       Ready (waiting for Firefox extension)');
          console.log('======================================================');
          resolve({ port: actualPort, lanIp });
        });
      });
    },
    stop() {
      pipeline.disconnectAllClients();
      for (const client of wss.clients) {
        try {
          client.close();
        } catch {
          // ignore
        }
      }
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// Run directly when executed via `node bridge/server.js`
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain && !process.env.CAST_SONOS_NO_AUTOSTART) {
  const bridge = createBridgeServer();
  bridge.start().catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Bridge] Port ${DEFAULT_PORT} is already in use. Is Cast to Sonos Bridge already running?`);
    } else {
      console.error('[Bridge] Failed to start:', err);
    }
    process.exit(1);
  });
}

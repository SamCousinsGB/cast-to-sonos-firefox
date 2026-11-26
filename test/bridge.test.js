import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { parseZoneGroupState } from '../bridge/sonos-discovery.js';
import { buildDidlLiteMetadata, toSonosStreamUri, escapeXml } from '../bridge/sonos-upnp.js';
import { AudioStreamPipeline, buildStreamingWavHeader } from '../bridge/audio-pipeline.js';
import { createBridgeServer } from '../bridge/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

test('parseZoneGroupState parses multi-room groups and filters bonded Invisible satellites', () => {
  const sampleXml = `
    <ZoneGroupState>
      <ZoneGroups>
        <ZoneGroup Coordinator="RINCON_AAA" ID="RINCON_AAA:1">
          <ZoneGroupMember UUID="RINCON_AAA" Location="http://192.168.1.21:1400/xml/device_description.xml" ZoneName="Living Room" />
          <ZoneGroupMember UUID="RINCON_SUB" Location="http://192.168.1.22:1400/xml/device_description.xml" ZoneName="Living Room" Invisible="1" />
          <ZoneGroupMember UUID="RINCON_BBB" Location="http://192.168.1.25:1400/xml/device_description.xml" ZoneName="Kitchen" />
        </ZoneGroup>
        <ZoneGroup Coordinator="RINCON_CCC" ID="RINCON_CCC:4">
          <ZoneGroupMember UUID="RINCON_CCC" Location="http://192.168.1.30:1400/xml/device_description.xml" ZoneName="Office &amp; Studio" />
        </ZoneGroup>
      </ZoneGroups>
    </ZoneGroupState>
  `;

  const groups = parseZoneGroupState(sampleXml, 'Sonos_HH1');
  assert.equal(groups.length, 2);

  const livingGroup = groups.find((g) => g.coordinatorUuid === 'RINCON_AAA');
  assert.ok(livingGroup);
  assert.equal(livingGroup.name, 'Living Room + 1');
  assert.equal(livingGroup.coordinatorIp, '192.168.1.21');
  assert.equal(livingGroup.members.length, 2, 'Invisible Sub must be filtered out');

  const officeGroup = groups.find((g) => g.coordinatorUuid === 'RINCON_CCC');
  assert.equal(officeGroup.name, 'Office & Studio');
  assert.equal(officeGroup.coordinatorIp, '192.168.1.30');
});

test('buildDidlLiteMetadata and toSonosStreamUri produce valid Sonos radio and WAV URIs', () => {
  const mp3Uri = toSonosStreamUri('http://192.168.1.10:41900/stream.mp3?s=abc', 'mp3');
  assert.equal(mp3Uri, 'x-rincon-mp3radio://192.168.1.10:41900/stream.mp3?s=abc');

  const wavUri = toSonosStreamUri('http://192.168.1.10:41900/stream.wav?s=abc', 'wav');
  assert.equal(wavUri, 'http://192.168.1.10:41900/stream.wav?s=abc');

  const didl = buildDidlLiteMetadata({
    streamUri: mp3Uri,
    title: 'Lo-Fi Beats <Live> & Chill',
    artist: 'YouTube',
    albumArtUri: 'http://192.168.1.10:41900/artwork?v=2',
  });

  assert.ok(didl.includes('<dc:title>Lo-Fi Beats &lt;Live&gt; &amp; Chill</dc:title>'));
  assert.ok(didl.includes('<upnp:albumArtURI>http://192.168.1.10:41900/artwork?v=2</upnp:albumArtURI>'));
  assert.ok(didl.includes('x-rincon-mp3radio://192.168.1.10:41900/stream.mp3?s=abc'));
  assert.equal(escapeXml('A&B'), 'A&amp;B');
});

test('AudioStreamPipeline encodes real-time stereo PCM into valid MPEG MP3 frames and WAV headers', () => {
  const wavHeader = buildStreamingWavHeader(48000, 2, 16);
  assert.equal(wavHeader.length, 44);
  assert.equal(wavHeader.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wavHeader.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wavHeader.readUInt32LE(24), 48000);

  const pipeline = new AudioStreamPipeline();
  pipeline.configure({ quality: 'hifi', sampleRate: 48000 });

  const chunks = [];
  const fakeRes = {
    destroyed: false,
    writableEnded: false,
    writeHead() {},
    write(buf) {
      chunks.push(Buffer.from(buf));
    },
    on() {},
    end() {},
  };

  pipeline.attachHttpClient(fakeRes, 'mp3', 'Test Stream 🎵 — Café “Live”');

  // Generate 440Hz stereo sine wave at 48kHz (4096 stereo frames) -> resampled cleanly to 44.1kHz
  const frames = 4096;
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 16000);
    pcm[i * 2] = sample;
    pcm[i * 2 + 1] = sample;
  }

  pipeline.ingestPcm(Buffer.from(pcm.buffer));
  const stats = pipeline.getStats();
  assert.equal(stats.sampleRate, 44100);
  assert.ok(stats.channelPeaks.left > 0.3 && stats.channelPeaks.right > 0.3);
  pipeline.disconnectAllClients();

  const mp3Data = Buffer.concat(chunks);
  assert.ok(mp3Data.length > 500, `Expected >500 bytes of MP3 data, got ${mp3Data.length}`);
  // Verify MPEG audio frame sync header (0xFF followed by 0xE0 mask)
  assert.equal(mp3Data[0], 0xff);
  assert.equal(mp3Data[1] & 0xe0, 0xe0);
});

test('Bridge HTTP + WebSocket end-to-end streaming test', async () => {
  const bridge = createBridgeServer({ port: 0, host: '127.0.0.1' });
  const { port } = await bridge.start();

  try {
    // 1. Health endpoint
    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.presets.length, 4);

    // 2. Artwork endpoint
    const artRes = await fetch(`http://127.0.0.1:${port}/artwork`);
    assert.equal(artRes.status, 200);
    assert.ok(artRes.headers.get('content-type').startsWith('image/'));

    // 3. Connect WebSocket audio source and stream PCM while HTTP client pulls /stream.mp3
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/audio`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    ws.send(JSON.stringify({ type: 'config', quality: 'stereo', sampleRate: 44100 }));

    const controller = new AbortController();
    const streamRes = await fetch(`http://127.0.0.1:${port}/stream.mp3`, {
      signal: controller.signal,
    });
    assert.equal(streamRes.status, 200);
    assert.equal(streamRes.headers.get('content-type'), 'audio/mpeg');

    // Push PCM over WebSocket
    const pcm = Buffer.alloc(1152 * 4 * 2);
    ws.send(pcm);

    // Read live encoded bytes from HTTP stream
    const reader = streamRes.body.getReader();
    const { value, done } = await reader.read();
    assert.equal(done, false);
    assert.ok(value && value.byteLength > 0);

    controller.abort();
    ws.close();

    // 4. Verify HTTP binary PCM fallback endpoint (/api/audio/pcm)
    const pcmPost = await fetch(`http://127.0.0.1:${port}/api/audio/pcm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Sample-Rate': '48000',
        'X-Quality': 'lossless',
      },
      body: Buffer.alloc(2048 * 4),
    });
    assert.equal(pcmPost.status, 204);
  } finally {
    await bridge.stop();
  }
});

test('Firefox extension manifest.json is valid MV3 with all referenced files present', () => {
  const extDir = path.join(rootDir, 'extension');
  const manifestPath = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.browser_specific_settings?.gecko?.id);
  assert.ok(Array.isArray(manifest.background?.scripts));

  const requiredFiles = [
    ...manifest.background.scripts,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((cs) => cs.js),
    'content/capture.js',
    'popup/popup.css',
    'popup/popup.js',
    'options/options.css',
    'options/options.js',
  ];

  for (const rel of requiredFiles) {
    const fullPath = path.join(extDir, rel);
    assert.ok(fs.existsSync(fullPath), `Missing extension asset: ${rel}`);
  }
});

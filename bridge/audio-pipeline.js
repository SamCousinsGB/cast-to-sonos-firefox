import * as lamejsModule from '@breezystack/lamejs';

const Mp3Encoder = lamejsModule.Mp3Encoder || lamejsModule.default?.Mp3Encoder;

export const QUALITY_PRESETS = {
  mono: { id: 'mono', label: 'Standard Mono', format: 'mp3', channels: 1, bitrate: 96 },
  stereo: { id: 'stereo', label: 'HD Stereo', format: 'mp3', channels: 2, bitrate: 192 },
  hifi: { id: 'hifi', label: 'Hi-Fi Stereo', format: 'mp3', channels: 2, bitrate: 320 },
  lossless: { id: 'lossless', label: 'Lossless PCM', format: 'wav', channels: 2, bitrate: 1411 },
};

const MP3_BLOCK_SIZE = 1152;
const TARGET_OUTPUT_RATE = 44100; // Sonos bonded stereo pairs (e.g. Era 100) sync most reliably at 44.1 kHz

/**
 * Generates a streaming WAV header with maximum chunk sizes so HTTP audio players
 * treat it as an infinite live uncompressed PCM stream.
 */
export function buildStreamingWavHeader(sampleRate = 44100, channels = 2, bitsPerSample = 16) {
  const buf = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const infiniteSize = 0x7fffffff;

  buf.write('RIFF', 0);
  buf.writeUInt32LE(infiniteSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(infiniteSize - 36, 40);
  return buf;
}

/**
 * Real-time PCM -> MP3 / WAV fan-out pipeline with automatic silence keep-alive
 * so Sonos speakers never time out when a video pauses or switches tracks.
 */
export class AudioStreamPipeline {
  constructor() {
    this.preset = QUALITY_PRESETS.hifi;
    this.inputSampleRate = 44100;
    this.sampleRate = TARGET_OUTPUT_RATE;
    this.encoder = null;
    this.leftBuf = new Int16Array(MP3_BLOCK_SIZE);
    this.rightBuf = new Int16Array(MP3_BLOCK_SIZE);
    this.bufOffset = 0;

    // Continuous resampler state (e.g. 48000 Hz Windows/Firefox -> 44100 Hz Sonos)
    this.prevL = 0;
    this.prevR = 0;
    this.resamplePhase = 1.0;

    /** @type {Set<{ res: import('node:http').ServerResponse, format: 'mp3'|'wav', connectedAt: number, bytesSent: number }>} */
    this.clients = new Set();
    this.lastPcmAt = 0;
    this.firstClientConnectedAt = 0;
    this.lastIngestStartedAt = 0;
    this.measuredLatencyMs = 2000;
    this.totalBytesEncoded = 0;
    this.totalPcmChunks = 0;
    this.channelPeaks = { left: 0, right: 0 };
    this.keepAliveTimer = null;
    this.ringMp3Prime = []; // Last ~100ms of MP3 frames for fast low-latency Sonos startup
    this.maxPrimeFrames = 4;
    this.recentChunksWindow = []; // timestamps of PCM chunks in last 2s for live rate telemetry

    this.configure({ quality: 'hifi', sampleRate: 44100 });
  }

  configure({ quality = 'hifi', sampleRate = 44100, forceReset = false } = {}) {
    const nextPreset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.hifi;
    const nextInputRate = Number(sampleRate) > 8000 ? Number(sampleRate) : 44100;

    const changed =
      forceReset ||
      !this.encoder ||
      this.preset.id !== nextPreset.id ||
      this.inputSampleRate !== nextInputRate;

    this.preset = nextPreset;
    this.inputSampleRate = nextInputRate;
    this.sampleRate = TARGET_OUTPUT_RATE;

    if (changed) {
      this.prevL = 0;
      this.prevR = 0;
      this.resamplePhase = 1.0;
    }

    if (changed && nextPreset.format === 'mp3') {
      if (!Mp3Encoder) {
        throw new Error('Mp3Encoder not available from @breezystack/lamejs');
      }
      this.encoder = new Mp3Encoder(nextPreset.channels, TARGET_OUTPUT_RATE, nextPreset.bitrate);
      this.bufOffset = 0;
      this.ringMp3Prime = [];
      this.totalPcmChunks = 0;
      this.totalBytesEncoded = 0;
      this.recentChunksWindow = [];
      this.channelPeaks = { left: 0, right: 0 };
    }
  }

  /**
   * Resample interleaved Int16 stereo PCM from inputSampleRate to TARGET_OUTPUT_RATE (44100 Hz)
   * with phase-continuous linear interpolation across chunk boundaries.
   */
  resampleTo44100(samples, frameCount) {
    if (this.inputSampleRate === TARGET_OUTPUT_RATE) {
      return { samples, frameCount };
    }

    const step = this.inputSampleRate / TARGET_OUTPUT_RATE;
    const maxOutFrames = Math.ceil(frameCount / step) + 2;
    const out = new Int16Array(maxOutFrames * 2);
    let outCount = 0;
    let pos = this.resamplePhase;

    while (pos < frameCount) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const l0 = idx === 0 ? this.prevL : samples[(idx - 1) * 2];
      const r0 = idx === 0 ? this.prevR : samples[(idx - 1) * 2 + 1];
      const l1 = samples[idx * 2];
      const r1 = samples[idx * 2 + 1];

      out[outCount * 2] = Math.round(l0 + (l1 - l0) * frac);
      out[outCount * 2 + 1] = Math.round(r0 + (r1 - r0) * frac);
      outCount += 1;
      pos += step;
    }

    this.prevL = samples[(frameCount - 1) * 2];
    this.prevR = samples[(frameCount - 1) * 2 + 1];
    this.resamplePhase = pos - frameCount;

    return { samples: out.subarray(0, outCount * 2), frameCount: outCount };
  }

  /**
   * Ingest interleaved 16-bit signed little-endian stereo PCM from the Firefox extension.
   * Format: [L0, R0, L1, R1, ...] as Buffer or Int16Array.
   */
  ingestPcm(chunk) {
    if (!chunk || chunk.byteLength < 4) return;

    const now = Date.now();
    if (!this.lastIngestStartedAt || now - this.lastPcmAt > 4000) {
      this.lastIngestStartedAt = now;
    }
    this.lastPcmAt = now;
    this.totalPcmChunks += 1;
    this.recentChunksWindow.push(now);
    while (this.recentChunksWindow.length > 0 && now - this.recentChunksWindow[0] > 2000) {
      this.recentChunksWindow.shift();
    }

    const rawBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const inFrameCount = Math.floor(rawBuf.byteLength / 4);
    if (inFrameCount <= 0) return;
    // Ensure 2-byte alignment for Int16Array view
    const alignedBuf = rawBuf.byteOffset % 2 === 0 ? rawBuf : Buffer.from(rawBuf);
    const inSamples = new Int16Array(alignedBuf.buffer, alignedBuf.byteOffset, inFrameCount * 2);

    const { samples, frameCount } = this.resampleTo44100(inSamples, inFrameCount);
    if (frameCount <= 0) return;

    // Measure live L/R peaks for diagnostics
    let peakL = 0;
    let peakR = 0;
    for (let i = 0; i < frameCount; i += 8) {
      const al = Math.abs(samples[i * 2]);
      const ar = Math.abs(samples[i * 2 + 1]);
      if (al > peakL) peakL = al;
      if (ar > peakR) peakR = ar;
    }
    this.channelPeaks = {
      left: Number((peakL / 32768).toFixed(3)),
      right: Number((peakR / 32768).toFixed(3)),
    };

    // Fan out directly to any lossless WAV clients (always 44100 Hz stereo PCM)
    if (this.hasClientsOfFormat('wav')) {
      const wavBuf = Buffer.from(samples.buffer, samples.byteOffset, frameCount * 4);
      this.broadcast('wav', wavBuf);
    }

    // Encode to MP3 if preset is mp3 OR if any MP3 client is listening
    if (this.preset.format === 'mp3' || this.hasClientsOfFormat('mp3')) {
      if (!this.encoder) {
        this.encoder = new Mp3Encoder(this.preset.channels, TARGET_OUTPUT_RATE, this.preset.bitrate);
      }

      const isMono = this.preset.channels === 1;

      for (let i = 0; i < frameCount; i++) {
        const l = samples[i * 2];
        const r = samples[i * 2 + 1];

        if (isMono) {
          this.leftBuf[this.bufOffset] = (l + r) >> 1;
        } else {
          this.leftBuf[this.bufOffset] = l;
          this.rightBuf[this.bufOffset] = r;
        }

        this.bufOffset += 1;
        if (this.bufOffset === MP3_BLOCK_SIZE) {
          const encoded = isMono
            ? this.encoder.encodeBuffer(this.leftBuf)
            : this.encoder.encodeBuffer(this.leftBuf, this.rightBuf);
          this.bufOffset = 0;
          if (encoded && encoded.length > 0) {
            const out = Buffer.from(encoded);
            this.totalBytesEncoded += out.length;
            this.pushPrimeFrame(out);
            this.broadcast('mp3', out);
          }
        }
      }
    }
  }

  pushPrimeFrame(frameBuf) {
    this.ringMp3Prime.push(frameBuf);
    if (this.ringMp3Prime.length > this.maxPrimeFrames) {
      this.ringMp3Prime.shift();
    }
  }

  hasClientsOfFormat(format) {
    for (const c of this.clients) {
      if (c.format === format) return true;
    }
    return false;
  }

  broadcast(format, buffer) {
    for (const client of this.clients) {
      if (client.format !== format) continue;
      if (client.res.destroyed || client.res.writableEnded) {
        this.clients.delete(client);
        continue;
      }
      try {
        client.res.write(buffer);
        client.bytesSent += buffer.length;
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /**
   * Attach an HTTP response (typically from a Sonos speaker pulling /stream.mp3 or /stream.wav).
   */
  attachHttpClient(res, format = 'mp3', streamTitle = 'Cast to Sonos for Firefox') {
    const clientFormat = format === 'wav' ? 'wav' : 'mp3';
    const contentType = clientFormat === 'wav' ? 'audio/wav' : 'audio/mpeg';
    // HTTP headers only permit printable ASCII (0x20-0x7E); full Unicode title goes in DIDL-Lite XML
    const safeIcyName =
      String(streamTitle || 'Cast to Sonos for Firefox')
        .replace(/[^\x20-\x7E]/g, '')
        .trim()
        .slice(0, 120) || 'Cast to Sonos for Firefox';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      'Accept-Ranges': 'none',
      'transferMode.dlna.org': 'Streaming',
      'contentFeatures.dlna.org':
        'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
      'icy-name': safeIcyName,
      'icy-br': String(this.preset.bitrate),
      Connection: 'close',
    });

    const client = {
      res,
      format: clientFormat,
      connectedAt: Date.now(),
      bytesSent: 0,
    };

    if (!this.firstClientConnectedAt) {
      this.firstClientConnectedAt = client.connectedAt;
    }

    if (clientFormat === 'wav') {
      const wavHeader = buildStreamingWavHeader(this.sampleRate, 2, 16);
      res.write(wavHeader);
      client.bytesSent += wavHeader.length;
    } else {
      // Prime Sonos decoder immediately so playback begins quickly without stalling
      if (this.ringMp3Prime.length > 0) {
        for (const frame of this.ringMp3Prime) {
          res.write(frame);
          client.bytesSent += frame.length;
        }
      } else {
        // Send 6 silent MP3 frames (~150ms) immediately
        const silentPcm = Buffer.alloc(MP3_BLOCK_SIZE * 4 * 6);
        this.clients.add(client);
        this.emitSilentChunk(silentPcm, client);
      }
    }

    this.clients.add(client);
    this.ensureKeepAliveLoop();

    const cleanup = () => {
      this.clients.delete(client);
      if (this.clients.size === 0) {
        this.stopKeepAliveLoop();
        this.firstClientConnectedAt = 0;
      }
    };

    res.on('close', cleanup);
    res.on('error', cleanup);

    return client;
  }

  emitSilentChunk(silentStereoPcm, singleClient = null) {
    if (singleClient) {
      if (singleClient.format === 'wav') {
        singleClient.res.write(silentStereoPcm);
        singleClient.bytesSent += silentStereoPcm.length;
        return;
      }
    }

    // Feed real-time silence through a clean temporary or main encoder
    if (this.hasClientsOfFormat('wav') && !singleClient) {
      this.broadcast('wav', silentStereoPcm);
    }

    if (this.hasClientsOfFormat('mp3') || singleClient?.format === 'mp3') {
      if (!this.encoder) {
        this.encoder = new Mp3Encoder(this.preset.channels, this.sampleRate, this.preset.bitrate);
      }
      const zeroBlock = new Int16Array(MP3_BLOCK_SIZE);
      const blocks = Math.max(1, Math.floor(silentStereoPcm.byteLength / (MP3_BLOCK_SIZE * 4)));
      for (let b = 0; b < blocks; b++) {
        const encoded =
          this.preset.channels === 1
            ? this.encoder.encodeBuffer(zeroBlock)
            : this.encoder.encodeBuffer(zeroBlock, zeroBlock);
        if (encoded && encoded.length > 0) {
          const out = Buffer.from(encoded);
          if (singleClient) {
            singleClient.res.write(out);
            singleClient.bytesSent += out.length;
          } else {
            this.broadcast('mp3', out);
          }
        }
      }
    }
  }

  ensureKeepAliveLoop() {
    if (this.keepAliveTimer) return;
    // Every ~52ms (2 MP3 frames at 44.1kHz), emit silence if browser stopped sending PCM
    const intervalMs = Math.round((MP3_BLOCK_SIZE * 2 * 1000) / this.sampleRate);
    const silentPcm = Buffer.alloc(MP3_BLOCK_SIZE * 4 * 2);

    this.keepAliveTimer = setInterval(() => {
      if (this.clients.size === 0) {
        this.stopKeepAliveLoop();
        return;
      }
      const idleMs = Date.now() - this.lastPcmAt;
      if (idleMs > 450) {
        this.emitSilentChunk(silentPcm);
      }
    }, Math.max(25, intervalMs));
  }

  stopKeepAliveLoop() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  disconnectAllClients() {
    for (const client of this.clients) {
      try {
        client.res.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.stopKeepAliveLoop();
    this.ringMp3Prime = [];
  }

  getStats() {
    const now = Date.now();
    while (this.recentChunksWindow.length > 0 && now - this.recentChunksWindow[0] > 2000) {
      this.recentChunksWindow.shift();
    }
    return {
      preset: this.preset,
      inputSampleRate: this.inputSampleRate,
      sampleRate: this.sampleRate,
      connectedSonosClients: this.clients.size,
      isReceivingAudio: this.lastPcmAt > 0 && now - this.lastPcmAt < 1000,
      chunksPerSec: Number((this.recentChunksWindow.length / 2).toFixed(1)),
      channelPeaks: this.channelPeaks,
      totalPcmChunks: this.totalPcmChunks,
      totalBytesEncoded: this.totalBytesEncoded,
      measuredLatencyMs: this.measuredLatencyMs,
    };
  }
}

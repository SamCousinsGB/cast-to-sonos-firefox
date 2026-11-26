#!/usr/bin/env node
/**
 * Optional Firefox Native Messaging Host for Cast to Sonos.
 * When installed via install-native-host.ps1, Firefox can automatically launch
 * the local Sonos bridge on demand if it is not already running.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CAST_SONOS_PORT || 41900);

function writeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

async function isBridgeRunning() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBridgeRunning() {
  if (await isBridgeRunning()) {
    return { ok: true, alreadyRunning: true, port: PORT };
  }

  const serverScript = path.join(__dirname, 'server.js');
  const child = spawn(process.execPath, [serverScript], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await isBridgeRunning()) {
      return { ok: true, started: true, port: PORT };
    }
  }
  return { ok: false, error: 'Timed out waiting for bridge server to start.' };
}

let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', async (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (inputBuffer.length >= 4) {
    const msgLen = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < 4 + msgLen) break;

    const payload = inputBuffer.subarray(4, 4 + msgLen).toString('utf8');
    inputBuffer = inputBuffer.subarray(4 + msgLen);

    try {
      const msg = JSON.parse(payload);
      if (msg.command === 'ensure_running' || msg.command === 'ping') {
        const result = await ensureBridgeRunning();
        writeMessage(result);
      } else {
        writeMessage({ ok: false, error: `Unknown command: ${msg.command}` });
      }
    } catch (err) {
      writeMessage({ ok: false, error: err.message });
    }
  }
});

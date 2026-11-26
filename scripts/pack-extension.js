/**
 * Builds official AMO-compliant release archives for Cast to Sonos for Firefox:
 *   - dist/cast-to-sonos-firefox-<version>.zip  (for addons.mozilla.org signing)
 *   - dist/cast-to-sonos-firefox-<version>.xpi  (for Firefox Dev Edition / Nightly / unsigned testing)
 *   - dist/cast-to-sonos-firefox.xpi            (stable filename alias)
 *
 * Uses pure Node.js ZIP generation with POSIX forward slashes ('/') as strictly
 * required by Mozilla Add-ons (AMO) validation.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const extDir = path.join(root, 'extension');
const distDir = path.join(root, 'dist');

const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
const version = manifest.version || '1.0.0';

// Standard CRC32 table
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function collectFiles(dir, baseDir = dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, baseDir));
    } else if (entry.isFile()) {
      // Strictly POSIX forward slashes for AMO compatibility
      const rel = path.relative(baseDir, full).split(path.sep).join('/');
      results.push({ rel, full });
    }
  }
  results.sort((a, b) => a.rel.localeCompare(b.rel));
  return results;
}

function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { rel, full } of entries) {
    const data = fs.readFileSync(full);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const nameBuf = Buffer.from(rel, 'utf8');

    // Local file header (30 bytes + name)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x5421, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    // Central directory header (46 bytes + name)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(8, 10); // deflate
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x5421, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

fs.mkdirSync(distDir, { recursive: true });
const entries = collectFiles(extDir);
const zipBuffer = buildZipBuffer(entries);

const versionedZip = path.join(distDir, `cast-to-sonos-firefox-${version}.zip`);
const versionedXpi = path.join(distDir, `cast-to-sonos-firefox-${version}.xpi`);
const latestXpi = path.join(distDir, 'cast-to-sonos-firefox.xpi');

fs.writeFileSync(versionedZip, zipBuffer);
fs.writeFileSync(versionedXpi, zipBuffer);
fs.writeFileSync(latestXpi, zipBuffer);

console.log(`Built official AMO-ready Firefox extension packages (${entries.length} files, ${zipBuffer.length} bytes):`);
console.log(`  AMO Upload ZIP: ${versionedZip}`);
console.log(`  Versioned XPI:  ${versionedXpi}`);
console.log(`  Latest XPI:     ${latestXpi}`);

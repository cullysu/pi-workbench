// Minimal ZIP writer/reader (deflate + stored, no zip64, no encryption).
// Enough for the workbench backup archives; keeps backup endpoints platform-free.
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const dosDateTime = (d = new Date()) => ({
  time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f),
  date: (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f),
});

/** entries: [{ name: string, data: Buffer, mode?: number }] → zip Buffer.
 *  mode (POSIX bits, e.g. 0o755) is stored in the unix external attributes so
 *  executables survive a zip round-trip; omitted mode keeps the legacy DOS entry. */
export function createZip(entries, { mtime } = {}) {
  if (entries.length > 0xffff) throw new Error('too many entries for a non-zip64 archive (max 65535)'); // the 16-bit count field would silently wrap
  const { time, date } = dosDateTime(mtime || new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, mode } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    let method = 8;
    let payload = zlib.deflateRawSync(data, { level: 9 });
    if (payload.length >= data.length) { method = 0; payload = data; }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(mode === undefined ? 0 : (3 << 8) | 20, 6); // version made by: unix when a mode is present
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(mode === undefined ? 0 : (mode & 0xffff) << 16, 38); // unix mode lives in the high 16 bits
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + payload.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/** zip Buffer → [{ name, data: Buffer }] — extraction is capped so a crafted
 *  backup zip (bomb) cannot exhaust memory: 50k entries, 1 GB total uncompressed */
export function readZip(buf) {
  const MAX_ENTRIES = 50000;
  const MAX_TOTAL_UNCOMPRESSED = 1024 * 1024 * 1024;
  const MAX_ENTRY_UNCOMPRESSED = 64 * 1024 * 1024; // a config backup never needs a bigger single entry; bounds one inflate before the total check sees anything
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('not a zip (no EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_ENTRIES) throw new Error(`zip has too many entries (${count} > ${MAX_ENTRIES})`);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out = [];
  const seen = new Set();
  let totalUncompressed = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(ptr + 10);
    const csize = buf.readUInt32LE(ptr + 20);
    const crc = buf.readUInt32LE(ptr + 16);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const extAttrs = buf.readUInt32LE(ptr + 38);
    const mode = (extAttrs >>> 16) & 0xffff; // unix mode in the high 16 bits (0 = not stored)
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    const l = localOffset;
    if (buf.readUInt32LE(l) !== 0x04034b50) throw new Error(`bad local header for "${name}"`);
    if (seen.has(name)) throw new Error(`duplicate entry: ${name}`);
    seen.add(name);
    const lNameLen = buf.readUInt16LE(l + 26);
    const lExtraLen = buf.readUInt16LE(l + 28);
    const dataStart = l + 30 + lNameLen + lExtraLen;
    const payload = buf.subarray(dataStart, dataStart + csize);
    let data;
    try {
      data = method === 0 ? Buffer.from(payload) : zlib.inflateRawSync(payload, { maxOutputLength: MAX_ENTRY_UNCOMPRESSED });
    } catch (e) {
      if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`entry "${name}" expands beyond ${MAX_ENTRY_UNCOMPRESSED} bytes — refusing (zip bomb?)`);
      throw e;
    }
    totalUncompressed += data.length;
    if (data.length > MAX_ENTRY_UNCOMPRESSED) throw new Error(`entry "${name}" expands beyond ${MAX_ENTRY_UNCOMPRESSED} bytes — refusing (zip bomb?)`);
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) throw new Error(`zip expands beyond ${MAX_TOTAL_UNCOMPRESSED} bytes — refusing (zip bomb?)`);
    if (crc32(data) !== crc) throw new Error('crc mismatch for ' + name); // a torn backup must fail loudly, not import half-configs
    out.push({ name, data, mode });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

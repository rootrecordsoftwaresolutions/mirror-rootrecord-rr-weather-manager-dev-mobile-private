'use strict';

/**
 * Multi-resolution Windows .ico (32bpp DIB+XOR+AND per entry) from a raster source via Sharp.
 * Icon directory entries are strictly ascending by size (required by Explorer).
 */

const fs = require('fs');
const path = require('path');

/**
 * @param {Buffer} rgbaTopDown — width*height*4 bytes, Sharp raw RGBA top-to-bottom
 */
function encodeIcoDib32(width, height, rgbaTopDown) {
  const biSize = 40;
  const xorBytes = width * height * 4;
  const andRowStride = Math.floor((width + 31) / 32) * 4;
  const biSizeImage = xorBytes + andRowStride * height;
  const imageSize = biSize + biSizeImage;
  const buf = Buffer.alloc(imageSize, 0);

  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(width, 4);
  buf.writeInt32LE(height * 2, 8);
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(0, 16);
  buf.writeUInt32LE(biSizeImage, 20);
  buf.writeUInt32LE(0, 24);
  buf.writeUInt32LE(0, 28);
  buf.writeUInt32LE(0, 32);
  buf.writeUInt32LE(0, 36);

  let off = biSize;
  for (let y = height - 1; y >= 0; y -= 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const i = row + x * 4;
      buf[off] = rgbaTopDown[i + 2];
      buf[off + 1] = rgbaTopDown[i + 1];
      buf[off + 2] = rgbaTopDown[i];
      buf[off + 3] = rgbaTopDown[i + 3];
      off += 4;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let b = 0; b < andRowStride; b += 1) {
      buf[off] = 0;
      off += 1;
    }
  }
  return buf;
}

function buildIcoFrom32bppEntries(entries) {
  const n = entries.length;
  const blobs = entries.map((e) => encodeIcoDib32(e.width, e.height, e.data));
  const headerSize = 6 + 16 * n;
  let offset = headerSize;
  const offsets = [];
  const sizes = [];
  for (let i = 0; i < n; i += 1) {
    offsets.push(offset);
    sizes.push(blobs[i].length);
    offset += blobs[i].length;
  }
  const out = Buffer.alloc(offset, 0);
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2);
  out.writeUInt16LE(n, 4);
  let dir = 6;
  for (let i = 0; i < n; i += 1) {
    const w = entries[i].width;
    const h = entries[i].height;
    out.writeUInt8(w >= 256 ? 0 : w, dir);
    out.writeUInt8(h >= 256 ? 0 : h, dir + 1);
    out.writeUInt8(0, dir + 2);
    out.writeUInt8(0, dir + 3);
    out.writeUInt16LE(1, dir + 4);
    out.writeUInt16LE(32, dir + 6);
    out.writeUInt32LE(sizes[i], dir + 8);
    out.writeUInt32LE(offsets[i], dir + 12);
    dir += 16;
  }
  for (let i = 0; i < n; i += 1) {
    blobs[i].copy(out, offsets[i]);
  }
  return out;
}

/**
 * @param {*} sharpFactory — sharp module (function)
 * @param {string} sourcePath
 * @param {string} outputIcoPath
 * @param {{ sizes?: number[]; fit?: string; position?: string }} [opts]
 */
async function writeWinMultiSizeIco(sharpFactory, sourcePath, outputIcoPath, opts = {}) {
  const sizes = opts.sizes || [16, 24, 32, 48, 64, 128, 256];
  const fit = opts.fit || 'cover';
  const position = opts.position || 'centre';
  const entries = [];
  for (const s of sizes) {
    const { data, info } = await sharpFactory(sourcePath)
      .resize(s, s, { fit, position })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4 || info.width !== s || info.height !== s) {
      throw new Error(`Expected ${s}x${s} RGBA for ICO, got ${info.width}x${info.height} ${info.channels}ch`);
    }
    entries.push({ width: s, height: s, data });
  }
  fs.mkdirSync(path.dirname(outputIcoPath), { recursive: true });
  fs.writeFileSync(outputIcoPath, buildIcoFrom32bppEntries(entries));
}

module.exports = { writeWinMultiSizeIco };

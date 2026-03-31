#!/usr/bin/env node
'use strict';

const { Resvg } = require('@resvg/resvg-js');
const png2icons = require('png2icons');
const fs = require('fs');
const path = require('path');

const SVG_PATH = path.join(__dirname, '..', 'assets', 'icon.svg');
const OUT_DIR  = path.join(__dirname, '..', 'assets', 'icons');

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

function renderPng(svgData, size) {
  const resvg = new Resvg(svgData, { fitTo: { mode: 'width', value: size } });
  return Buffer.from(resvg.render().asPng());
}

// Pack an array of { size, png } into a multi-size ICO binary.
// PNGs are stored as-is (PNG-compressed ICO, supported on Vista+).
function buildIco(images) {
  const HEADER     = 6;
  const DIR_ENTRY  = 16;
  let offset = HEADER + images.length * DIR_ENTRY;
  const dirs = [];
  const data = [];

  for (const { size, png } of images) {
    const dir = Buffer.alloc(DIR_ENTRY);
    dir.writeUInt8(size >= 256 ? 0 : size, 0);  // width  (0 = 256)
    dir.writeUInt8(size >= 256 ? 0 : size, 1);  // height
    dir.writeUInt8(0,          2);               // color count
    dir.writeUInt8(0,          3);               // reserved
    dir.writeUInt16LE(1,       4);               // planes
    dir.writeUInt16LE(32,      6);               // bit depth
    dir.writeUInt32LE(png.length, 8);            // data size
    dir.writeUInt32LE(offset,    12);            // data offset
    dirs.push(dir);
    data.push(png);
    offset += png.length;
  }

  const header = Buffer.alloc(HEADER);
  header.writeUInt16LE(0,              0);  // reserved
  header.writeUInt16LE(1,              2);  // type: ICO
  header.writeUInt16LE(images.length,  4);

  return Buffer.concat([header, ...dirs, ...data]);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const svgData = fs.readFileSync(SVG_PATH, 'utf-8');

  // Render all sizes from icon.svg
  const buffers = {};
  for (const size of SIZES) {
    buffers[size] = renderPng(svgData, size);
    fs.writeFileSync(path.join(OUT_DIR, `${size}x${size}.png`), buffers[size]);
    console.log(`  ${size}x${size}.png`);
  }

  // Windows ICO — all sizes bundled
  const ico = buildIco(SIZES.map(size => ({ size, png: buffers[size] })));
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
  console.log('  icon.ico');

  // macOS ICNS
  const icns = png2icons.createICNS(buffers[1024], png2icons.BILINEAR, 0);
  if (!icns) throw new Error('ICNS generation failed');
  fs.writeFileSync(path.join(OUT_DIR, 'icon.icns'), icns);
  console.log('  icon.icns');

  // Linux PNG
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), buffers[256]);
  console.log('  icon.png');

  console.log('\nIcon generation complete.');
}

main().catch(err => { console.error(err); process.exit(1); });

#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = resolve(here, "..", "assets");

const BROWN = "#674A2B";
const CREAM = "#F2DEC6";

const FONT_STACK = "Segoe UI, Helvetica, Arial, sans-serif";

function iconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="${BROWN}"/>
  <text x="512" y="540"
        font-family="${FONT_STACK}"
        font-size="380"
        font-weight="900"
        fill="${CREAM}"
        text-anchor="middle"
        dominant-baseline="central"
        letter-spacing="-20">SFM</text>
</svg>`;
}

function adaptiveForegroundSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <text x="512" y="540"
        font-family="${FONT_STACK}"
        font-size="300"
        font-weight="900"
        fill="${CREAM}"
        text-anchor="middle"
        dominant-baseline="central"
        letter-spacing="-16">SFM</text>
</svg>`;
}

function splashSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1284" height="2778" viewBox="0 0 1284 2778">
  <rect width="1284" height="2778" fill="${BROWN}"/>
  <text x="642" y="1410"
        font-family="${FONT_STACK}"
        font-size="280"
        font-weight="900"
        fill="${CREAM}"
        text-anchor="middle"
        dominant-baseline="central"
        letter-spacing="-14">SFM</text>
</svg>`;
}

async function render(svg, outPath) {
  await sharp(Buffer.from(svg), { density: 300 })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(`wrote ${outPath}`);
}

await mkdir(ASSETS_DIR, { recursive: true });
await render(iconSvg(), resolve(ASSETS_DIR, "icon.png"));
await render(adaptiveForegroundSvg(), resolve(ASSETS_DIR, "adaptive-icon.png"));
await render(splashSvg(), resolve(ASSETS_DIR, "splash.png"));

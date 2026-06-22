// Rasterize the app logo → PNGs at all the sizes electron-builder + Windows
// expect, then pack the smaller ones into a multi-resolution build/icon.ico.
//
// Source preference: build/icon-source.png (the master raster logo — kept in
// sync with the mobile app's assets/icon.png so both apps share one logo),
// falling back to build/icon.svg. sharp reads either.

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import toIco from "png-to-ico";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUILD = path.join(ROOT, "build");
const PNG_SOURCE = path.join(BUILD, "icon-source.png");
const SVG = path.join(BUILD, "icon.svg");

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIZES = [512];

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function main() {
  await mkdir(BUILD, { recursive: true });
  const usePng = await exists(PNG_SOURCE);
  const svg = await readFile(usePng ? PNG_SOURCE : SVG);
  console.log(`  source: ${path.basename(usePng ? PNG_SOURCE : SVG)}`);

  // Render each PNG.
  const icoBuffers = [];
  for (const size of [...ICO_SIZES, ...PNG_SIZES]) {
    const png = await sharp(svg).resize(size, size).png().toBuffer();
    const outPath = path.join(BUILD, `icon-${size}.png`);
    await writeFile(outPath, png);
    if (ICO_SIZES.includes(size)) icoBuffers.push(png);
    console.log(`  wrote ${path.basename(outPath)}`);
  }

  // The 512 also becomes the default icon.png (used by Linux/Mac/installer).
  const main512 = await sharp(svg).resize(512, 512).png().toBuffer();
  await writeFile(path.join(BUILD, "icon.png"), main512);
  console.log("  wrote icon.png (512)");

  // Pack ICO.
  const ico = await toIco(icoBuffers);
  await writeFile(path.join(BUILD, "icon.ico"), ico);
  console.log("  wrote icon.ico (multi-size)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

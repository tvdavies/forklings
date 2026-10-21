// Write every icon from the hand-drawn maps in scripts/icon-art.ts.
// Run with: bun scripts/icons.ts
import { mkdirSync } from 'node:fs';
import { encodePng } from '../src/shared/png';
import { appIcon, FACE_16, FACE_24, FACE_32, favicon, ico, type Raster, svg } from './icon-art';

const png = (r: Raster) => encodePng(r.width, r.height, r.rgba);
const write = async (path: string, data: Uint8Array | string) => {
  await Bun.write(path, data);
  console.log(`wrote ${path}`);
};

// Favicons: transparent, one hand-drawn grid per size.
const fav16 = await png(favicon(FACE_16, 16));
const fav32 = await png(favicon(FACE_32, 32));
const fav48 = await png(favicon(FACE_24, 48));
await write('public/favicon-16.png', fav16);
await write('public/favicon-32.png', fav32);
await write('public/favicon-48.png', fav48);
await write(
  'public/favicon.ico',
  ico([
    { size: 16, png: fav16 },
    { size: 32, png: fav32 },
    { size: 48, png: fav48 },
  ]),
);

// Home-screen and PWA icons: the 32 grid on a dusk tile.
await write('public/apple-touch-icon.png', await png(appIcon(180)));
await write('public/icon-192.png', await png(appIcon(192)));
await write('public/icon-512.png', await png(appIcon(512)));
await write('public/icon-maskable-192.png', await png(appIcon(192, true)));
await write('public/icon-maskable-512.png', await png(appIcon(512, true)));

// Brand assets: the GitHub OAuth app icon and a vector mark for docs.
mkdirSync('docs/assets/brand', { recursive: true });
await write('docs/assets/brand/forklings-app-icon-512.png', await png(appIcon(512)));
await write('docs/assets/brand/forklings-app-icon-1024.png', await png(appIcon(1024)));
await write('docs/assets/brand/forklings-mark.svg', svg(FACE_32));

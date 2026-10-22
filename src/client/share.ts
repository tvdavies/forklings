// A shareable picture of a newly hatched Forkling, for the hatch card's Copy picture button.

import { type Genome, INK, RARITY, RCOL } from '../shared/genome';
import { spr } from './engine';

const SIZE = 480;

/** Render the pet as a square PNG: name, sprite on its rarity glow, rarity, type and hatcher. */
export async function hatchPicture(g: Genome, handle: string, typeLine: string): Promise<Blob> {
  await Promise.all([document.fonts.load('700 44px "Pixelify Sans"'), document.fonts.load('600 22px "Pixelify Sans"')]);
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const x = c.getContext('2d')!;
  x.imageSmoothingEnabled = false;
  const rc = RCOL[g.rarity] ?? RCOL[0];
  x.fillStyle = INK;
  x.fillRect(0, 0, SIZE, SIZE);
  x.fillStyle = '#2c2146';
  x.fillRect(8, 8, SIZE - 16, SIZE - 16);
  x.fillStyle = '#4a3a6b';
  x.fillRect(8, 352, SIZE - 16, SIZE - 360);
  x.fillStyle = '#5a4a7b';
  x.fillRect(8, 352, SIZE - 16, 4);
  const glow = x.createRadialGradient(SIZE / 2, 230, 0, SIZE / 2, 230, 170);
  glow.addColorStop(0, rc);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  x.globalAlpha = 0.35;
  x.fillStyle = glow;
  x.fillRect(8, 8, SIZE - 16, 344);
  x.globalAlpha = 1;
  // 32 art pixels at 9x, standing on the floor line.
  x.drawImage(spr(g, { stage: 0 }), (SIZE - 288) / 2, 352 - 270, 288, 288);
  x.textAlign = 'center';
  x.textBaseline = 'top';
  x.fillStyle = '#fff2dc';
  x.font = '700 44px "Pixelify Sans", system-ui, sans-serif';
  x.fillText(g.name, SIZE / 2, 30);
  x.fillStyle = rc;
  x.font = '600 24px "Pixelify Sans", system-ui, sans-serif';
  x.fillText(RARITY[g.rarity] ?? '', SIZE / 2, 80);
  x.font = '600 20px "Pixelify Sans", system-ui, sans-serif';
  x.fillStyle = '#fff2dc';
  x.fillText(typeLine, SIZE / 2, 374, SIZE - 48);
  x.fillStyle = '#b9a8cf';
  x.fillText(`Hatched by @${handle} · forklings.dev`, SIZE / 2, 414, SIZE - 48);
  return new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error('Could not draw the picture'))), 'image/png'));
}

/** Copy a picture to the clipboard, or download it where the browser can't copy images. */
export async function copyPicture(picture: Promise<Blob>, filename: string): Promise<'copied' | 'saved'> {
  try {
    if (!('ClipboardItem' in window) || !navigator.clipboard?.write) throw new Error('No image clipboard');
    // Pass the promise straight in so Safari still counts this as part of the click.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': picture })]);
    return 'copied';
  } catch {
    const url = URL.createObjectURL(await picture);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return 'saved';
  }
}

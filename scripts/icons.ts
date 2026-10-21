// Generate the PWA icons from the sprite generator itself; nothing is hand-drawn.
// Run with: bun scripts/icons.ts
import { genome, type Genome } from '../src/shared/genome';
import { compose } from '../src/shared/compose';
import { encodePng, paintSprite } from '../src/shared/png';

// A fixed seed with a few traits pinned so the icon reads well at small sizes.
const g: Genome = { ...genome('5ab1e5eed0000000000000000000000000000000000000000000000000000000'), pal: ['butter', 'lilac'], eyes: 'big', ears: 'cat', mouth: 'smile', pattern: 'belly', shape: 'round' };
const { cols } = compose(g, { stage: 1 });
for (const size of [192, 512]) {
  const png = await encodePng(size, size, paintSprite(cols, size, Math.floor(size / 40), '#271d3b'));
  await Bun.write(`public/icon-${size}.png`, png);
}
console.log('icons written');

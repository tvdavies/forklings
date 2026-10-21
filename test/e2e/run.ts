// End-to-end check of the deployed game in a real browser, at desktop and phone sizes.
// It signs up one demo player, so it counts against the five demo sign-ups per network
// per day. Screenshots go to test/e2e/out/.
//
//   CHROMIUM=/usr/bin/chromium bun test/e2e/run.ts [https://forklings.dev]
import { mkdirSync } from 'node:fs';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'https://forklings.dev';
const OUT = 'test/e2e/out';
mkdirSync(OUT, { recursive: true });

let failures = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (e) {
    failures++;
    console.error(`✘ ${name}\n  ${(e as Error).message.split('\n')[0]}`);
  }
}
function expect(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
const shot = (p: Page, name: string) => p.screenshot({ path: `${OUT}/${name}.png` });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const errors: string[] = [];
const watch = (p: Page) => {
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // HTTP error statuses (401 before login, 409 for a rejected script) are expected; only count real errors.
  p.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(`console: ${m.text()}`));
};

// ---------- desktop ----------
const desktop: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
const p = await desktop.newPage();
watch(p);
const handle = `e2e-${Math.random().toString(36).slice(2, 8)}`;

await step('login page loads and marks demo players as unverified', async () => {
  await p.goto(BASE);
  await p.locator('#demoHandle').waitFor();
  await shot(p, 'desktop-login');
  await p.fill('#demoHandle', handle);
  await p.locator('#demoForm button[type=submit]').click();
  await p.locator('#hatchBtn').waitFor({ state: 'visible' });
  expect((await p.textContent('#whoBadge'))?.includes('unverified'), 'badge should say unverified');
});

await step('hatching reveals a creature card', async () => {
  await p.click('#hatchBtn');
  await p.locator('#meetBtn').waitFor({ state: 'visible', timeout: 15000 });
  expect(((await p.textContent('#hatchCard')) ?? '').includes(`@${handle}`), 'card names the hatcher');
  await shot(p, 'desktop-hatch');
  await p.click('#meetBtn');
  await p.locator('#homeCanvas').waitFor({ state: 'visible' });
});

await step('care actions respond', async () => {
  await p.click('[data-care=pat]');
  await p.waitForFunction(() => (document.querySelector('#careMsg')?.textContent ?? '').length > 0);
});

await step('wardrobe equips a starter item', async () => {
  await p.locator('#wardrobe button[aria-label^="Beanie"]').click();
  await p.waitForFunction(() => document.querySelector('#wardrobe button[aria-label^="Beanie"]')?.getAttribute('aria-pressed') === 'true');
  await p.waitForTimeout(600);
  await shot(p, 'desktop-home');
});

const purse = async (pg: Page) => Number(await pg.textContent('#purseBits'));

await step('shop: a level-locked item says how far away it is', async () => {
  await p.goto(`${BASE}/#shop`);
  await p.locator('#shelf .offer').first().waitFor();
  // 50 to start, plus 10 for the daily care bonus the pat above earned
  expect((await purse(p)) === 60, `expected 50 + 10 bits, has ${await purse(p)}`);
  await p.locator('#shelf .offer[aria-label^="Crown"]').click();
  await p.waitForFunction(() => /Unlocks at level 15: 14 levels to go/.test(document.querySelector('#shopPick')?.textContent ?? ''));
  expect(await p.locator('#shopPick [data-act=buy]').isDisabled(), 'buy is disabled while locked');
  await p.waitForTimeout(500);
  await shot(p, 'desktop-shop-locked');
});

let bought = '';
await step('shop: try on, buy with two taps, then wear it', async () => {
  // today's cheapest item a level-1 Forkling can buy: one generated common always opens at level 1
  const pick = await p.evaluate(() => {
    const left = Number(document.querySelector('#purseBits')?.textContent);
    const ok = [...document.querySelectorAll<HTMLElement>('#shelf .offer:not(.locked)')].filter(
      (b) => b.querySelector('.tg.new') && Number(b.querySelector('.price')?.textContent) <= left,
    );
    return ok[0]?.dataset.id ?? 'scarf';
  });
  bought = pick;
  await p.locator(`#shelf .offer[data-id="${pick}"]`).click();
  await p.locator('#shopPick [data-act=buy]').waitFor();
  await p.waitForTimeout(700);
  await shot(p, 'desktop-shop-preview');
  const before = await purse(p);
  await p.click('#shopPick [data-act=buy]');
  expect(((await p.textContent('#shopPick [data-act=buy]')) ?? '').startsWith('Tap again'), 'first tap asks to confirm');
  expect((await purse(p)) === before, 'nothing spent on the first tap');
  await p.click('#shopPick [data-act=buy]');
  await p.waitForFunction(() => /^Bought/.test(document.querySelector('#shopPick .toastline')?.textContent ?? ''));
  expect((await purse(p)) < before, 'bits were spent');
  await p.click('#shopPick [data-act=wear]');
  await p.waitForFunction(() => /^Wearing/.test(document.querySelector('#shopPick .toastline')?.textContent ?? ''));
  await p.waitForTimeout(900);
  await shot(p, 'desktop-shop-bought');
});

await step('shop: the purchase is in the wardrobe, here and at home', async () => {
  await p.click('#shopFilters [data-f=mine]');
  await p.locator(`#shelf .offer[data-id="${bought}"] .tg.worn`).waitFor();
  await p.goto(`${BASE}/#home`);
  await p.locator('#wardrobe .item[aria-pressed=true]').first().waitFor();
  const worn = await p.locator('#wardrobe .item[aria-pressed=true]').count();
  expect(worn >= 1, 'home wardrobe shows what is worn');
});

await step('coaching tactics save', async () => {
  await p.goto(`${BASE}/#coach`);
  await p.locator('#coachForm').waitFor({ state: 'visible' });
  await p.locator('[name=special][value=save]').check();
  await p.locator('#coachForm button[type=submit]').click();
  await p.waitForFunction(() => (document.querySelector('#coachMsg')?.textContent ?? '').startsWith('Plan saved'));
});

await step('strategy script reports errors and saves', async () => {
  await p.locator('#scriptPanel summary').click();
  await p.fill('#scriptSrc', 'when hp < : heal');
  await p.locator('#scriptForm button[type=submit]').click();
  await p.waitForFunction(() => (document.querySelector('#scriptMsg')?.textContent ?? '').includes('line 1, column 11'));
  await p.fill(
    '#scriptSrc',
    'style steady\nwhen hp < 40 and ready heal: heal\nwhen foe_hp < 35: special\nwhen chance 70: strike\notherwise: guard',
  );
  await p.locator('#scriptForm button[type=submit]').click();
  await p.waitForFunction(() => (document.querySelector('#scriptMsg')?.textContent ?? '').startsWith('Script saved'));
  await shot(p, 'desktop-coach');
});

await step('a battle plays out and lands in the log', async () => {
  await p.goto(`${BASE}/#battle`);
  await p.click('#fightBtn');
  await p.waitForFunction(() => /^vs @/.test(document.querySelector('#battleMsg')?.textContent ?? ''), null, { timeout: 15000 });
  await p.waitForTimeout(2500);
  await shot(p, 'desktop-battle');
  await p.click('#skipBtn');
  await p.waitForFunction(() => /^(Won|Lost|Draw)/.test(document.querySelector('#battleMsg')?.textContent ?? ''), null, { timeout: 20000 });
  await p.locator('#battleLog li [data-replay]').first().waitFor();
});

await step('leaderboard lists NPCs and this player as unranked', async () => {
  await p.goto(`${BASE}/#ranks`);
  await p.locator('#ranks li').first().waitFor();
  expect((await p.locator('#ranks .badge.npc').count()) > 0, 'ranked list should include NPCs');
  await p.waitForFunction((h) => (document.querySelector('#ranksU')?.textContent ?? '').includes(`@${h}`), handle);
  await shot(p, 'desktop-ranks');
});

let token = '';
await step('API tokens can be created, used for MCP, and revoked', async () => {
  await p.goto(`${BASE}/#api`);
  await p.fill('#tokenName', 'e2e');
  await p.locator('#tokenForm button[type=submit]').click();
  await p.locator('#tokenOut').waitFor({ state: 'visible' });
  token = ((await p.textContent('#tokenOut')) ?? '').split('\n')[0].trim();
  expect(token.startsWith('fk_'), 'token shown once');
  const call = (body: object) =>
    fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const r = await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_forkling', arguments: { portrait: true } } });
  const j = (await r.json()) as { result: { content: { type: string }[] } };
  expect(
    j.result.content.some((c) => c.type === 'image'),
    'portrait returned',
  );
  await p.locator('#tokenList [data-revoke]').first().click();
  await p.waitForFunction(() => !document.querySelector('#tokenList [data-revoke]'));
  const after = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  expect(after.status === 401, `revoked token should get 401, got ${after.status}`);
});

// ---------- phone, same player ----------
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  storageState: await desktop.storageState(),
});
const m = await phone.newPage();
watch(m);

await step('phone: home fits the screen without sideways scrolling', async () => {
  await m.goto(`${BASE}/#home`);
  await m.locator('#homeCanvas').waitFor({ state: 'visible' });
  await m.waitForTimeout(800);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow <= 1, `page is ${overflow}px wider than the screen`);
  expect(await m.locator('#tabs').isVisible(), 'tab bar visible');
  await shot(m, 'phone-home');
});

await step('phone: battle and leaderboard render', async () => {
  await m.goto(`${BASE}/#battle`);
  await m.locator('#battleCanvas').waitFor({ state: 'visible' });
  await m.locator('#battleLog [data-replay]').first().click();
  await m.waitForTimeout(2500);
  await shot(m, 'phone-battle');
  await m.goto(`${BASE}/#ranks`);
  await m.locator('#ranks li').first().waitFor();
  await m.waitForTimeout(400);
  await shot(m, 'phone-ranks');
});

await step('phone: the shop fits and shows the fitting room first', async () => {
  await m.goto(`${BASE}/#shop`);
  await m.locator('#shelf .offer').first().waitFor();
  await m.locator('#shelf .offer.locked').first().click();
  await m.waitForTimeout(800);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow <= 1, `shop is ${overflow}px wider than the screen`);
  const fit = await m.locator('#fitCanvas').boundingBox();
  expect(fit && fit.y < 300 && fit.width > 300, 'fitting room is near the top and nearly full width');
  await shot(m, 'phone-shop');
});

await step('phone: tap targets are at least 44px tall', async () => {
  await m.goto(`${BASE}/#home`);
  await m.locator('[data-care=feed]').waitFor({ state: 'visible' });
  const small = await m.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-care], .tabs a')]
      .filter((e) => e.getBoundingClientRect().height < 44)
      .map((e) => e.textContent),
  );
  expect(small.length === 0, `small targets: ${small.join(', ')}`);
});

await step('no script errors in the console', async () => {
  expect(errors.length === 0, errors.join(' | '));
});

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

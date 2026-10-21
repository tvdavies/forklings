// End-to-end check of the game in a real browser, at desktop and phone sizes.
// Screenshots go to test/e2e/out/.
//
// Signed out, it checks the GitHub sign-in page and its error messages. Signing in needs
// GitHub, so the rest runs only when you pass a session: copy the value of the fk_session
// cookie from a browser signed in to the same server.
//
//   CHROMIUM=/usr/bin/chromium FORKLINGS_SESSION=<fk_session> bun test/e2e/run.ts [https://forklings.dev]
import { mkdirSync } from 'node:fs';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'https://forklings.dev';
const SESSION = process.env.FORKLINGS_SESSION ?? '';
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
// Wait out the 0.25 s view fade so screenshots aren't half-faded.
const shot = async (p: Page, name: string) => {
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/${name}.png` });
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const errors: string[] = [];
const watch = (p: Page) => {
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // HTTP error statuses (401 before login, 409 for a rejected script) are expected; only count real errors.
  p.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(`console: ${m.text()}`));
};
const noSidewaysScroll = async (pg: Page) => {
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow <= 1, `page is ${overflow}px wider than the screen`);
};

// ---------- boot, with /api slow and then unreachable ----------
await step('the first HTML response already paints a loading state', async () => {
  const html = await (await fetch(BASE)).text();
  expect(html.includes('id="boot"') && html.includes('Waking your Forkling'), 'index.html should carry the static loader');
});

const offline = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const o = await offline.newPage();
watch(o);
await step('with /api blocked, the loader gives way to a retry panel', async () => {
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await o.route('**/api/**', async (r) => {
    await held;
    await r.abort('connectionrefused');
  });
  await o.goto(BASE);
  await o.locator('#boot').waitFor({ state: 'visible' });
  expect((await o.textContent('#bootLine')) === 'Waking your Forkling…', 'loader line shows while /api is pending');
  await shot(o, 'phone-boot-loading');
  release();
  await o.waitForFunction(() => document.querySelector('#bootLine')?.textContent === "Can't reach Forklings");
  await o.locator('#bootRetry').waitFor({ state: 'visible' });
  expect(await o.evaluate(() => document.activeElement?.id === 'bootRetry'), 'Try again should take keyboard focus');
  expect(await o.locator('[role=status]', { hasText: "Can't reach Forklings" }).count(), 'failure is announced in a status region');
  await shot(o, 'phone-boot-offline');
});

await step('Try again recovers once /api is back, without reloading the page', async () => {
  expect(await o.locator('#bootRetry').isVisible(), 'Try again should be showing');
  await o.evaluate(() => {
    (window as unknown as { stillHere: boolean }).stillHere = true;
  });
  await o.unroute('**/api/**');
  await o.keyboard.press('Enter');
  await o.locator('#boot').waitFor({ state: 'hidden' });
  await o.locator('#v-login').waitFor({ state: 'visible' });
  expect(await o.evaluate(() => (window as unknown as { stillHere?: boolean }).stillHere === true), 'page was reloaded');
});
await offline.close();

// ---------- signed out ----------
const guest = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
const g = await guest.newPage();
watch(g);

await step('sign-in page offers GitHub and nothing else', async () => {
  await g.goto(BASE);
  await g.locator('#ghBtn').waitFor({ state: 'visible' });
  expect((await g.getAttribute('#ghBtn', 'href')) === '/auth/github', 'button goes to /auth/github');
  expect((await g.locator('#v-login input, #v-login form').count()) === 0, 'no handle field or demo form');
  expect(await g.locator('#signinMsg').isHidden(), 'no error on a first visit');
  expect(await g.locator('#meadowCanvas').isVisible(), 'hero art shows');
  await noSidewaysScroll(g);
  await g.waitForTimeout(600);
  await shot(g, 'desktop-signin');
});

await step('GitHub errors come back as friendly messages', async () => {
  for (const [reason, words] of [
    ['denied', 'cancelled'],
    ['expired', 'took too long'],
    ['unavailable', "couldn't reach GitHub"],
  ]) {
    await g.goto(`${BASE}/?signin=${reason}`);
    await g.locator('#signinMsg').waitFor({ state: 'visible' });
    const text = ((await g.textContent('#signinMsg')) ?? '').toLowerCase();
    expect(text.includes(words.toLowerCase()), `${reason}: "${text}"`);
    expect(!g.url().includes('signin='), 'reason is tidied out of the address bar');
  }
  await shot(g, 'desktop-signin-error');
});

await step('demo sign-in is gone and stray sessions are refused', async () => {
  const demo = await fetch(`${BASE}/auth/demo`, {
    method: 'POST',
    body: '{"handle":"x"}',
    headers: { 'content-type': 'application/json' },
  });
  expect(demo.status === 404, `/auth/demo should be 404, got ${demo.status}`);
  const me = await fetch(`${BASE}/api/me`, { headers: { cookie: 'fk_session=not.a-session' } });
  expect(me.status === 401, `a bad session should get 401, got ${me.status}`);
  const mcp = await fetch(`${BASE}/mcp`, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  expect(mcp.status === 401, `MCP without a token should get 401, got ${mcp.status}`);
});

await step('leaderboard still lists NPCs, with no unverified players', async () => {
  const r = (await (await fetch(`${BASE}/api/leaderboard`)).json()) as { players: object[]; npcs: object[]; unranked: object[] };
  expect(r.npcs.length > 0, 'house NPCs should be listed');
  expect(
    [...r.players, ...r.npcs, ...r.unranked].every((x) => !('verified' in x)),
    'rows no longer carry a verified flag',
  );
});

const guestPhone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
const gm = await guestPhone.newPage();
watch(gm);
await step('phone: sign-in page fits, with a full-width GitHub button', async () => {
  await gm.goto(BASE);
  await gm.locator('#ghBtn').waitFor({ state: 'visible' });
  await noSidewaysScroll(gm);
  const box = await gm.locator('#ghBtn').boundingBox();
  expect(box && box.height >= 44 && box.width >= 300, `button is ${box?.width}x${box?.height}`);
  await gm.waitForTimeout(600);
  await shot(gm, 'phone-signin');
});

if (!SESSION) {
  console.log('\nSet FORKLINGS_SESSION to run the signed-in checks too.');
  await step('no script errors in the console', async () => {
    expect(errors.length === 0, errors.join(' | '));
  });
  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

// ---------- signed in (desktop) ----------
const desktop: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
const u = new URL(BASE);
await desktop.addCookies([
  { name: 'fk_session', value: SESSION, domain: u.hostname, path: '/', httpOnly: true, secure: u.protocol === 'https:' },
]);
const p = await desktop.newPage();
watch(p);
let handle = '';

await step('a GitHub session signs straight in', async () => {
  await p.goto(BASE);
  await p.locator('#whoHandle').filter({ hasText: '@' }).waitFor();
  handle = ((await p.textContent('#whoHandle')) ?? '').replace(/^@/, '');
  expect(handle.length > 0, 'header shows the handle');
});

await step('hatching reveals a creature card (or the pet is already home)', async () => {
  await p.locator('#hatchBtn:visible, #homeCanvas:visible').first().waitFor();
  if (await p.locator('#hatchBtn').isVisible()) {
    await p.click('#hatchBtn');
    await p.locator('#meetBtn').waitFor({ state: 'visible', timeout: 15000 });
    expect(((await p.textContent('#hatchCard')) ?? '').includes(`@${handle}`), 'card names the hatcher');
    await shot(p, 'desktop-hatch');
    await p.click('#meetBtn');
  }
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

await step('first-day list ticks off dressing up and feeding', async () => {
  await p.locator('#firstDay li.done').first().waitFor();
  await p.click('#firstDay [data-fd-go=feed]');
  await p.waitForFunction(() => document.querySelectorAll('#firstDay li.done').length === 2);
  expect(((await p.textContent('#firstDay')) ?? '').includes('2 of 4'), 'list shows 2 of 4');
});

await step('coaching tactics save', async () => {
  await p.goto(`${BASE}/#coach`);
  await p.locator('#coachForm').waitFor({ state: 'visible' });
  await p.locator('[name=special][value=save]').check();
  await p.locator('#coachForm button[type=submit]').click();
  await p.waitForFunction(() => (document.querySelector('#coachMsg')?.textContent ?? '').startsWith('Plan saved'));
});

await step('strategy script reports errors and saves', async () => {
  // A player who already saved a script finds the panel open; anyone else opens it.
  await p.locator('#scriptPanel').evaluate((d) => {
    (d as HTMLDetailsElement).open = true;
  });
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

await step('a battle plays out, ends on a result card with a reason, and lands in the log', async () => {
  await p.goto(`${BASE}/#battle`);
  expect(/Energy\s*\d+\/100/.test((await p.textContent('#energyLine')) ?? ''), 'energy shows where you fight');
  // The session is a real player, so its pet may be worn out from an earlier run.
  expect((await p.getAttribute('#fightBtn', 'data-rest')) !== 'true', 'pet needs a rest first: wait, or use a fresh player');
  await p.click('#fightBtn');
  await p.waitForFunction(() => /^vs @/.test(document.querySelector('#battleMsg')?.textContent ?? ''), null, { timeout: 15000 });
  expect((await p.textContent('#fightBtn')) === 'Battling…', 'the fight button says Battling… mid-fight');
  await p.waitForTimeout(2500);
  await shot(p, 'desktop-battle');
  await p.click('#skipBtn');
  await p.locator('#resultCard').waitFor({ state: 'visible', timeout: 20000 });
  expect(/^(Won|Lost|Draw)$/.test((await p.textContent('#resultTitle')) ?? ''), 'result card names the outcome');
  expect(((await p.textContent('#resultWhy')) ?? '').length > 10, 'result card gives a reason');
  await shot(p, 'desktop-battle-result');
  await p.locator('#battleLog li [data-replay]').first().waitFor();
});

await step('leaderboard pins this player and keeps NPCs apart', async () => {
  await p.goto(`${BASE}/#ranks`);
  await p.locator('#rankMe').waitFor({ state: 'visible' });
  const mine = (await p.textContent('#rankMe')) ?? '';
  expect(mine.includes(`@${handle}`), 'pinned row shows this player');
  expect((await p.locator('#ranks .badge.npc').count()) === 0, 'ranked players list has no NPCs');
  expect((await p.locator('#ranksN .badge.npc').count()) > 0, 'NPCs are listed under House NPCs');
  expect(!(await p.locator('#ranksN').isVisible()), 'NPCs start collapsed');
  // A GitHub player is ranked or, under 30 days old, in practice: either way they're listed.
  await p.waitForFunction(
    (h) => `${document.querySelector('#ranks')?.textContent}${document.querySelector('#ranksU')?.textContent}`.includes(`@${h}`),
    handle,
  );
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
  const before = await p.locator('#tokenList [data-revoke]').count();
  await p.locator('#tokenList [data-revoke]').last().click();
  await p.waitForFunction((n) => document.querySelectorAll('#tokenList [data-revoke]').length < n, before);
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
  await noSidewaysScroll(m);
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
  await m.locator('#rankMe').waitFor({ state: 'visible' });
  await m.waitForTimeout(400);
  await shot(m, 'phone-ranks');
  // Open the NPC list so the page is long enough to scroll, then check the row stays pinned.
  await m.locator('#npcFold summary').click();
  await m.locator('#ranksN li').first().waitFor({ state: 'visible' });
  await m.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const top = await m.evaluate(() => document.getElementById('rankMe')?.getBoundingClientRect().top ?? -1);
  expect(top >= 0 && top < 20, `pinned row should stay at the top when scrolled, top is ${top}`);
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

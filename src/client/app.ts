// Forklings web client: a small hash-routed PWA over the JSON API.

import { type BattleResult, fighter, heldEffect, MOVES, type Snapshot, type Tactics } from '../shared/battle';
import { compose, ITEMS, type ItemDef, SLOTS, type Slot } from '../shared/compose';
import { CURRENCY, checkPurchase, type Offer, type REWARDS } from '../shared/economy';
import { describe, type Genome, genome, RARITY, RCOL, STAGE_NAMES } from '../shared/genome';
import { type PetState, STAGE_XP } from '../shared/state';
import { itemIcon, paintStatic, RM, spr } from './engine';
import { makeBattle, makeEvo, makeFitting, makeHatch, makeHome } from './scenes';

// ---------- API shapes (the fields of the Worker's JSON responses that the client reads) ----------
interface Session {
  handle: string;
  verified: boolean;
  pid: string;
}
interface CreatureView {
  seed: string;
  items: Record<string, string | null>;
  /** Definitions of the equipped shop items. */
  gear?: Record<string, ItemDef>;
  tactics: Tactics;
  state: PetState;
  level: number;
  stage: number;
  mood: string;
  nextStageXp: number | null;
  evolving: { from: number; to: number } | null;
  battleEnergy: number;
  strategy: StrategyView;
}
interface StrategyView {
  source: 'tactics' | 'script';
  script: string;
  rules: number;
  style: string;
}
/** The player view every write endpoint returns alongside its own result. */
interface PlayerView {
  creature: CreatureView | null;
  /** Owned items; shop items carry their definition. */
  inventory: { item: string; def?: ItemDef }[];
  wallet?: WalletView;
  unseenDefences: number;
}
interface WalletView {
  bits: number;
  today: { day: string; battles: number; firstWin: boolean; care: boolean; earned: number };
  rewards: typeof REWARDS;
}
interface ShopResponse extends PlayerView {
  day: string;
  restockAt: number;
  offers: Offer[];
}
interface BuyResponse extends Partial<PlayerView> {
  ok?: boolean;
  replay?: boolean;
  balance?: number;
  error?: string;
  code?: string;
}
interface Me extends PlayerView {
  session: Session;
}
interface Config {
  github: boolean;
  demo: boolean;
}
interface CareResponse extends Partial<PlayerView> {
  ok?: boolean;
  message?: string;
  error?: string;
  xpGain?: number;
}
interface BattleOut {
  a: Snapshot;
  b: Snapshot;
  seed: string;
  xp: number;
  /** Bits this battle paid you. */
  bits: number;
  loot: string | null;
  lootNote: string | null;
  ranked: boolean;
  ratingDelta: number;
}
interface BattleRow {
  id: string;
  at: number;
  side: number;
  opp_handle: string;
  opp_bot: number;
  outcome: string;
  xp: number;
  loot: string | null;
  rating_delta: number;
  seen: number;
}
interface ReplayResponse {
  id: string;
  side: number;
  a: Snapshot;
  b: Snapshot;
  seed: string;
}
interface LeaderRow {
  handle: string;
  verified: number;
  npc: number;
  persona: string | null;
  name: string;
  seed: string | null;
  level: number;
  stage: number;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  xp: number;
}
interface TokenRow {
  id: string;
  name: string;
  created_at: number;
  last_used: number | null;
}

/** The page's fixed elements (see public/index.html); pass the element type when it matters. */
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

interface ApiOpts {
  method?: string;
  body?: unknown;
  soft?: boolean;
}
type ApiError = Error & { status: number; body: unknown };
const errMsg = (e: unknown) => (e as Error).message;

async function api<T = unknown>(path: string, opts: ApiOpts = {}): Promise<T & { status: number }> {
  const r = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  // JSON from our own API: callers say which shape they expect via T.
  const j = (await r.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!r.ok && !opts.soft) {
    const e: ApiError = Object.assign(new Error(j.error || j.message || 'Request failed'), { status: r.status, body: j as unknown });
    throw e;
  }
  return { status: r.status, ...j };
}

interface AppState {
  me: Me | null;
  g: Genome | null;
  view: string | null;
  config: Config | null;
}
const S: AppState = { me: null, g: null, view: null, config: null };
let homeStage: ReturnType<typeof makeHome> | undefined;
let battleStage: ReturnType<typeof makeBattle>;

/** A Forkling in an outfit. The id includes the outfit, so sprite caching keeps outfits apart. */
function dressed(seed: string, items: Record<string, string | null>, gear?: Record<string, ItemDef>): Genome {
  const g: Genome = { ...genome(seed) };
  g.items = { ...items };
  g.gear = gear;
  g.id = `${g.id}|${SLOTS.map(([s]) => items[s] || '').join('.')}`;
  return g;
}
const petGenome = (c: CreatureView) => dressed(c.seed, c.items, c.gear);

// ---------- routing ----------
const VIEWS = ['login', 'hatch', 'home', 'shop', 'coach', 'battle', 'ranks', 'api'];
function show(v: string) {
  S.view = v;
  for (const id of VIEWS) $(`v-${id}`).hidden = id !== v;
  const authed = !!S.me;
  $('top').hidden = !authed;
  $('tabs').hidden = !authed || !S.me?.creature;
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.tabs a'))
    a.setAttribute('aria-current', a.dataset.tab === v ? 'page' : 'false');
  if (v === 'home') renderHome();
  if (v === 'shop') loadShop();
  if (v === 'coach') renderCoach();
  if (v === 'battle') renderBattleLog();
  if (v === 'ranks') renderRanks();
  if (v === 'api') renderTokens();
  window.scrollTo(0, 0);
}
function route() {
  if (!S.me) return show('login');
  if (!S.me.creature) return show('hatch');
  const h = location.hash.replace('#', '') || 'home';
  show(VIEWS.includes(h) && h !== 'login' && h !== 'hatch' ? h : 'home');
}
window.addEventListener('hashchange', route);

async function refresh() {
  try {
    S.me = await api<Me>('/api/me');
  } catch (e) {
    if ((e as ApiError).status === 401) S.me = null;
    else throw e;
  }
  if (S.me?.creature) S.g = petGenome(S.me.creature);
  if (S.me) {
    $('whoHandle').textContent = `@${S.me.session.handle}`;
    const b = $('whoBadge');
    b.textContent = S.me.session.verified ? 'GitHub' : 'unverified';
    b.className = `badge${S.me.session.verified ? '' : ' warn'}`;
  }
  $('battleDot').hidden = !((S.me?.unseenDefences ?? 0) > 0);
}

// ---------- login ----------
async function initLogin() {
  $('logoutBtn').addEventListener('click', async () => {
    await api('/auth/logout', { body: {} });
    S.me = null;
    S.g = null;
    location.hash = '';
    route();
  });
  S.config = await api<Config>('/api/config');
  const gh = $<HTMLButtonElement>('ghBtn');
  if (!S.config.github) {
    gh.disabled = true;
    $('ghNote').textContent = 'GitHub login is coming soon (it needs an OAuth app). Use the demo login below for now.';
  }
  gh.addEventListener('click', () => {
    location.href = '/auth/github';
  });
  if (!S.config.demo) $('demoForm').hidden = true;
  $('demoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('demoErr').textContent = '';
    try {
      await api('/auth/demo', { body: { handle: $<HTMLInputElement>('demoHandle').value } });
      await refresh();
      route();
    } catch (err) {
      $('demoErr').textContent = errMsg(err);
    }
  });
}

// ---------- hatch ----------
function cardHTML(g: Genome) {
  return `<div class="rowc"><span class="nm">${esc(g.name)}</span><span class="stars" title="${RARITY[g.rarity]}" style="color:${RCOL[g.rarity]}">${'★'.repeat(g.rarity + 1)}${'☆'.repeat(4 - g.rarity)}</span></div>
  <div class="rowc"><span class="whoc">Hatched by @${esc(S.me!.session.handle)}</span><span class="whoc">${RARITY[g.rarity]} ${g.type} type</span></div><div class="traits">${esc(describe(g))}</div>`;
}
function initHatch() {
  // Before hatching, the egg is a neutral placeholder: the real seed doesn't exist until you press Hatch.
  const placeholder = genome('0f0e1e5000000000000000000000000000000000000000000000000000000000');
  placeholder.pal = ['frost', 'lilac'];
  const hatchStage = makeHatch($<HTMLCanvasElement>('hatchCanvas'), {
    g: placeholder,
    onHatched: (g) => {
      $('hatchCard').innerHTML = cardHTML(g);
      $('hatchCard').classList.add('show');
      $('meetBtn').hidden = false;
    },
  });
  $('hatchBtn').addEventListener('click', async () => {
    $<HTMLButtonElement>('hatchBtn').disabled = true;
    try {
      const r = await api<PlayerView>('/api/hatch', { body: {} });
      S.me = { ...S.me!, ...r };
      S.g = petGenome(S.me.creature!);
      $('hatchBtn').hidden = true;
      hatchStage.hatch(S.g);
    } catch (e) {
      $<HTMLButtonElement>('hatchBtn').disabled = false;
      alert(errMsg(e));
    }
  });
  $('meetBtn').addEventListener('click', async () => {
    await refresh();
    location.hash = '#home';
    route();
  });
}

// ---------- home ----------
const STAT_DEF: ['fullness' | 'mood' | 'energy', string, string][] = [
  ['fullness', 'Fullness', '#ff9f78'],
  ['mood', 'Mood', '#ff86bd'],
  ['energy', 'Energy', '#86bdff'],
];
function renderHome() {
  const c = S.me?.creature;
  if (!c) return;
  if (!homeStage) homeStage = makeHome($<HTMLCanvasElement>('homeCanvas'));
  const g = S.g!; // set by refresh() whenever there is a creature
  const napping = Date.now() < c.state.napUntil;
  homeStage.set(g, c.stage, napping, c.mood);
  $('petName').textContent = g.name;
  $('petStars').innerHTML = '★'.repeat(g.rarity + 1);
  $('petStars').style.color = RCOL[g.rarity];
  $('petStars').title = RARITY[g.rarity];
  $('petMeta').textContent = `Lv ${c.level} ${STAGE_NAMES[c.stage]} · ${g.type} type · ${c.mood}`;
  $('napBtn').textContent = napping ? 'Wake' : 'Nap';
  const xpNext = c.nextStageXp,
    xp = Math.floor(c.state.xp),
    prev = STAGE_XP[c.stage];
  const growth = xpNext ? Math.max(0, Math.min(100, ((xp - prev) / (xpNext - prev)) * 100)) : 100;
  $('stats').innerHTML =
    STAT_DEF.map(
      ([k, label, col]) =>
        `<div class="stat"><span>${label}</span><div class="bar"><i style="width:${Math.round(c.state[k])}%;background-color:${col}"></i></div><span class="v">${Math.round(c.state[k])}</span></div>`,
    ).join('') +
    `<div class="stat"><span>Growth</span><div class="bar"><i style="width:${growth}%;background-color:#6fdc9c"></i></div><span class="v">${xp}</span></div>` +
    `<p class="statnote">${xpNext ? `${Math.max(0, xpNext - xp)} XP until it evolves into a ${STAGE_NAMES[c.stage + 1]}.` : 'Fully evolved. A Prime.'} Needs change over time, even while you're away.</p>`;
  renderWardrobe();
  if (c.evolving) startEvolution();
}

/** What an owned or offered item is: shop items carry their def, classics come from ITEMS. */
function defOf(id: string): ItemDef | undefined {
  return (
    S.me?.inventory.find((i) => i.item === id)?.def ?? SHOP.offers.find((o) => o.id === id)?.def ?? S.me?.creature?.gear?.[id] ?? ITEMS[id]
  );
}
const owns = (id: string) => !!S.me?.inventory.some((i) => i.item === id);
const effectLine = (id: string, d: ItemDef) => heldEffect(id, { [id]: d })?.label;

async function equip(slot: Slot, item: string | null) {
  const r = await api<PlayerView>('/api/equip', { body: { slot, item } });
  S.me = { ...S.me!, ...r };
  S.g = petGenome(S.me.creature!);
}

/** The home wardrobe: what you own, slot by slot, with a way into the shop for more. */
function renderWardrobe() {
  const c = S.me!.creature!;
  const w = $('wardrobe');
  w.innerHTML = '';
  for (const [slot, label] of SLOTS) {
    const div = document.createElement('div');
    div.className = 'slot';
    div.innerHTML = `<h4>${label}</h4><div class="opts"></div>`;
    const opts = div.querySelector('.opts')!;
    const ids = [null, ...S.me!.inventory.map((i) => i.item).filter((id) => defOf(id)?.slot === slot)];
    for (const id of ids) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'item';
      const on = (c.items[slot] || null) === id;
      b.setAttribute('aria-pressed', String(on));
      const it = id ? defOf(id) : undefined;
      if (id && it) {
        b.style.setProperty('--bc', on ? '#ffd166' : RCOL[it.rarity]);
        const fx = effectLine(id, it);
        b.title = `${it.name} (${RARITY[it.rarity]}): ${it.blurb}${fx ? ` Battle: ${fx}.` : ''}`;
        b.setAttribute('aria-label', `${it.name}, ${RARITY[it.rarity]}${fx ? `, ${fx}` : ''}`);
        const cv = document.createElement('canvas');
        b.appendChild(cv);
        paintStatic(cv, itemIcon(id, it), 38);
      } else {
        b.innerHTML = '<span class="none">None</span>';
        b.setAttribute('aria-label', `No ${label.toLowerCase()} item`);
      }
      b.addEventListener('click', async () => {
        try {
          await equip(slot, id);
          renderHome();
          homeStage!.react('equip');
        } catch (e) {
          $('careMsg').textContent = errMsg(e);
        }
      });
      opts.appendChild(b);
    }
    const more = document.createElement('a');
    more.className = 'item more';
    more.href = '#shop';
    more.innerHTML = '<span class="none">Shop</span>';
    more.setAttribute('aria-label', `Shop for ${label.toLowerCase()} items`);
    more.addEventListener('click', () => {
      SHOP.filter = slot;
    });
    opts.appendChild(more);
    w.appendChild(div);
  }
}

// ---------- shop ----------
type ShopFilter = 'all' | 'mine' | Slot;
const SHOP = {
  offers: [] as Offer[],
  restockAt: 0,
  filter: 'all' as ShopFilter,
  /** The item in the fitting room. */
  pick: null as string | null,
  /** The item whose Buy button is waiting for a second tap. */
  confirm: null as string | null,
  /** A purchase that hasn't been confirmed by the server yet: retrying reuses its request id, so it can't charge twice. */
  pending: null as { id: string; requestId: string } | null,
  busy: false,
  msg: '',
};
let fitStage: ReturnType<typeof makeFitting> | undefined;
const coin = (n: number) => `<span class="price"><i class="coin" aria-hidden="true"></i>${n}</span>`;
const bitsWord = (n: number) => `${n} ${n === 1 ? CURRENCY.one : CURRENCY.many}`;

async function loadShop() {
  if (!S.me?.creature) return;
  if (!fitStage) fitStage = makeFitting($<HTMLCanvasElement>('fitCanvas'));
  try {
    const r = await api<ShopResponse>('/api/shop');
    S.me = { ...S.me, ...r };
    S.g = petGenome(S.me.creature!);
    SHOP.offers = r.offers;
    SHOP.restockAt = r.restockAt;
    if (SHOP.pick && !SHOP.offers.some((o) => o.id === SHOP.pick) && !owns(SHOP.pick)) SHOP.pick = null;
  } catch (e) {
    SHOP.msg = errMsg(e);
  }
  renderShop();
}

function renderShop() {
  const c = S.me?.creature;
  if (!c || S.view !== 'shop') return;
  const wallet = S.me!.wallet;
  $('purseBits').textContent = String(wallet?.bits ?? 0);
  renderRestock();
  for (const b of document.querySelectorAll<HTMLButtonElement>('#shopFilters button'))
    b.setAttribute('aria-pressed', String(b.dataset.f === SHOP.filter));
  // the shelf: today's stock, or your wardrobe
  const shelf = $('shelf');
  shelf.innerHTML = '';
  const entries: { id: string; def: ItemDef; offer?: Offer }[] =
    SHOP.filter === 'mine'
      ? S.me!.inventory.flatMap((i) => {
          const def = defOf(i.item);
          return def ? [{ id: i.item, def, offer: SHOP.offers.find((o) => o.id === i.item) }] : [];
        })
      : SHOP.offers.filter((o) => SHOP.filter === 'all' || o.def.slot === SHOP.filter).map((o) => ({ id: o.id, def: o.def, offer: o }));
  if (!entries.length)
    shelf.innerHTML = `<p class="dim small empty">${SHOP.filter === 'mine' ? 'Nothing here yet. Everything you buy or win lands in your wardrobe.' : 'Nothing in this slot today. New stock arrives at midnight UTC.'}</p>`;
  for (const e of entries) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'offer';
    b.dataset.id = e.id;
    b.style.setProperty('--bc', SHOP.pick === e.id ? '#ffd166' : RCOL[e.def.rarity]);
    b.setAttribute('aria-pressed', String(SHOP.pick === e.id));
    const have = owns(e.id),
      worn = c.items[e.def.slot] === e.id;
    const locked = !have && e.offer && e.offer.level > c.level;
    const tag = worn
      ? '<span class="tg worn">Wearing</span>'
      : have
        ? '<span class="tg own">Owned</span>'
        : locked
          ? `<span class="tg lock">Lv ${e.offer!.level}</span>`
          : e.offer?.tag === 'new'
            ? '<span class="tg new">New</span>'
            : e.offer?.tag === 'back'
              ? '<span class="tg back">Back</span>'
              : '';
    b.innerHTML = `<canvas aria-hidden="true"></canvas><span class="on">${esc(e.def.name)}</span>${have || !e.offer ? '' : coin(e.offer.price)}${tag}`;
    if (locked) b.classList.add('locked');
    b.setAttribute(
      'aria-label',
      `${e.def.name}, ${RARITY[e.def.rarity]} ${e.def.slot}${have ? ', owned' : e.offer ? `, ${bitsWord(e.offer.price)}` : ''}${locked ? `, unlocks at level ${e.offer!.level}` : ''}`,
    );
    paintStatic(b.querySelector('canvas')!, itemIcon(e.id, e.def), 52);
    b.addEventListener('click', () => {
      SHOP.pick = SHOP.pick === e.id ? null : e.id;
      SHOP.confirm = null;
      SHOP.msg = '';
      renderShop();
      // On a phone the shelf is below the fitting room: bring the try-on into view.
      const fit = $('fitCanvas').getBoundingClientRect();
      if (SHOP.pick && (fit.top < 0 || fit.bottom > window.innerHeight))
        $('fitCanvas').scrollIntoView({ behavior: RM ? 'auto' : 'smooth', block: 'start' });
    });
    shelf.appendChild(b);
  }
  renderPick();
  renderEarnings();
}

function renderRestock() {
  const left = Math.max(0, SHOP.restockAt - Date.now());
  const h = Math.floor(left / 3600e3),
    m = Math.ceil((left % 3600e3) / 60e3);
  $('shopRestock').textContent = left
    ? `New stock in ${h ? `${h} h ` : ''}${m} min (midnight UTC). Classics are always here.`
    : 'Restocking…';
}

/**
 * Babies have no neck and don't hold things, and a very few shapes hide a collar under the chin:
 * say so, from the render itself, rather than let someone buy an item they can't see.
 */
function hiddenNote(g: Genome, stage: number, slot: Slot, battles: boolean): string {
  if (compose(g, { stage }).meta.items[slot]?.visible) return '';
  const later = stage === 0 ? 'It shows once your Forkling evolves.' : "It doesn't show on your Forkling's shape.";
  return `<p class="why hidden">${later}${battles ? ' It still works in battle.' : ''}</p>`;
}

/** The fitting room's card: what the picked item is, does and costs, and the one thing you can do with it. */
function renderPick() {
  const c = S.me!.creature!;
  const box = $('shopPick');
  const id = SHOP.pick;
  const d = id ? defOf(id) : undefined;
  const items = { ...c.items },
    gear = { ...(c.gear ?? {}) };
  if (id && d) {
    items[d.slot] = id;
    gear[id] = d;
  }
  const look = dressed(c.seed, items, gear);
  fitStage!.set(look, c.stage, !!id);
  if (!id || !d) {
    box.innerHTML = `<p class="lead">Tap anything to try it on.</p><p class="dim small">Head, face, neck and body items are just for looks. A held item gives a small battle edge, never more than +6% to one stat.</p><p class="toastline" role="status">${esc(SHOP.msg)}</p>`;
    return;
  }
  const offer = SHOP.offers.find((o) => o.id === id);
  const have = owns(id),
    worn = c.items[d.slot] === id;
  const bits = S.me!.wallet?.bits ?? 0;
  const fx = effectLine(id, d);
  const chk = offer && !have ? checkPurchase(offer, { level: c.level, bits, owned: have }) : null;
  let action = '',
    why = '';
  if (have)
    action = worn
      ? '<button class="btn ghost" type="button" data-act="off">Take it off</button>'
      : '<button class="btn" type="button" data-act="wear">Wear it</button>';
  else if (offer && chk) {
    const confirming = SHOP.confirm === id;
    const label = SHOP.busy
      ? 'Buying…'
      : !chk.ok && chk.code === 'locked'
        ? `Level ${offer.level} needed`
        : confirming
          ? `Tap again to pay ${offer.price}`
          : `Buy for ${offer.price}`;
    action = `<button class="btn${confirming ? ' confirm' : ''}" type="button" data-act="buy"${chk.ok && !SHOP.busy ? '' : ' disabled'}>${label}</button>`;
    if (!chk.ok) why = `<p class="why ${chk.code}">${esc(chk.error)}</p>`;
  }
  const where =
    offer?.tag === 'new'
      ? 'New today'
      : offer?.tag === 'back'
        ? `Back from ${offer.def.day ?? 'an earlier day'}`
        : offer
          ? 'Classic'
          : 'In your wardrobe';
  box.innerHTML = `<div class="pick-top"><span class="nm">${esc(d.name)}</span>${offer && !have ? coin(offer.price) : ''}</div>
    <p class="meta"><span style="color:${RCOL[d.rarity]}">${RARITY[d.rarity]}</span> · ${esc(SLOTS.find(([s]) => s === d.slot)?.[1] ?? d.slot)} · ${where}${offer && offer.level > 1 ? ` · Level ${offer.level}+` : ''}</p>
    <p class="blurb">${esc(d.blurb)}</p>
    ${fx ? `<p class="fx">Battle: ${esc(fx)}</p>` : '<p class="fx dim">Just for looks</p>'}
    ${hiddenNote(look, c.stage, d.slot, !!fx)}${why}<div class="row">${action}<button class="btn ghost" type="button" data-act="close">Back to my look</button></div>
    <p class="toastline" role="status">${esc(SHOP.msg)}</p>`;
  box.querySelector<HTMLButtonElement>('[data-act=buy]')?.addEventListener('click', () => buyPick(id));
  box.querySelector<HTMLButtonElement>('[data-act=close]')?.addEventListener('click', () => {
    SHOP.pick = null;
    SHOP.msg = '';
    renderShop();
  });
  for (const [act, item] of [
    ['wear', id],
    ['off', null],
  ] as const)
    box.querySelector<HTMLButtonElement>(`[data-act=${act}]`)?.addEventListener('click', async () => {
      try {
        await equip(d.slot, item);
        SHOP.msg = item ? `Wearing the ${d.name}.` : `Took off the ${d.name}.`;
      } catch (e) {
        SHOP.msg = errMsg(e);
      }
      renderShop();
    });
}

async function buyPick(id: string) {
  const offer = SHOP.offers.find((o) => o.id === id);
  if (!offer || SHOP.busy) return;
  // Spending takes two taps, so a stray one never costs anything.
  if (SHOP.confirm !== id) {
    SHOP.confirm = id;
    renderPick();
    setTimeout(() => {
      if (SHOP.confirm === id) {
        SHOP.confirm = null;
        renderPick();
      }
    }, 4000);
    return;
  }
  SHOP.confirm = null;
  if (SHOP.pending?.id !== id) SHOP.pending = { id, requestId: crypto.randomUUID() };
  const body = { item: id, requestId: SHOP.pending.requestId };
  SHOP.busy = true;
  renderPick();
  try {
    // One automatic retry if the network drops: the same request id can only ever charge once.
    const r = await api<BuyResponse>('/api/shop/buy', { body, soft: true }).catch(() =>
      api<BuyResponse>('/api/shop/buy', { body, soft: true }),
    );
    if (r.creature) {
      S.me = { ...S.me!, ...(r as PlayerView) };
      S.g = petGenome(S.me.creature!);
    }
    if (r.ok || r.code !== 'request') SHOP.pending = null;
    SHOP.msg = r.ok
      ? `${r.replay ? 'Already yours' : 'Bought'}: the ${offer.def.name}. ${bitsWord(r.balance ?? 0)} left.`
      : (r.error ?? 'That didn’t work. Try again.');
    if (r.code === 'gone') await loadShop();
  } catch {
    SHOP.msg = 'Couldn’t reach the shop. Tap Buy again: you won’t be charged twice.';
  } finally {
    SHOP.busy = false;
  }
  renderShop();
}

function renderEarnings() {
  const w = S.me!.wallet;
  if (!w) return;
  const R = w.rewards,
    t = w.today;
  const done = (ok: boolean) => (ok ? '<span class="ok">done</span>' : '<span class="dim">not yet</span>');
  $('earnBody').innerHTML = `<p class="small">Today you've earned ${coin(t.earned)}. Bits come only from play: they can't be bought.</p>
    <ul class="earn-list small">
      <li><span>First win of the day</span><span>${coin(R.firstWinOfDay)} ${done(t.firstWin)}</span></li>
      <li><span>Battles: win, draw, loss</span><span>${R.win} / ${R.draw} / ${R.loss} · ${Math.min(t.battles, R.fullBattlesPerDay)} of ${R.fullBattlesPerDay} today</span></li>
      <li><span>Look after it (all needs ${R.careBonusMin}+)</span><span>${coin(R.dailyCare)} ${done(t.care)}</span></li>
      <li><span>Each level up</span><span>5 + 2 × level</span></li>
      <li><span>Evolving</span><span>${coin(R.evolve[1])} then ${coin(R.evolve[2])}</span></li>
    </ul>
    <p class="dim small">After ${R.fullBattlesPerDay} battles a day, wins pay ${R.taperedWin}. Winning a defence while you're away pays ${R.defendWin}.</p>`;
}

function initShop() {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#shopFilters button'))
    b.addEventListener('click', () => {
      SHOP.filter = b.dataset.f as ShopFilter;
      renderShop();
    });
  setInterval(() => {
    if (S.view !== 'shop' || document.visibilityState !== 'visible') return;
    if (SHOP.restockAt && Date.now() >= SHOP.restockAt) loadShop();
    else renderRestock();
  }, 30000);
}

function initCare() {
  for (const b of document.querySelectorAll<HTMLElement>('[data-care]'))
    b.addEventListener('click', async () => {
      const action = b.dataset.care!;
      const r = await api<CareResponse>('/api/care', { body: { action }, soft: true });
      $('careMsg').textContent = (r.message || r.error || '') + (r.xpGain ? `  +${r.xpGain} XP` : '');
      if (r.creature) {
        S.me = { ...S.me!, ...r };
        S.g = petGenome(S.me.creature!);
      }
      if (r.ok) homeStage!.react(action);
      renderHome();
    });
}

// ---------- evolution ----------
let evoRunning = false;
function startEvolution() {
  if (evoRunning) return;
  evoRunning = true;
  const c = S.me!.creature!,
    evolving = c.evolving!;
  const from = evolving.from,
    to = evolving.to;
  // fighter() only reads these fields of a snapshot.
  const before = fighter({ seed: c.seed, stage: from, level: c.level, tactics: c.tactics, items: c.items } as Snapshot),
    after = fighter({ seed: c.seed, stage: to, level: c.level, tactics: c.tactics, items: c.items } as Snapshot);
  const chips: [string, string][] = [
    [`+${after.maxHp - before.maxHp} HP`, '#6fdc9c'],
    [`+${Math.round(after.atk - before.atk)} Attack`, '#ff6f62'],
    [`Now a ${STAGE_NAMES[to]}`, '#ffd166'],
  ];
  $('evoOverlay').hidden = false;
  $('evoDone').hidden = true;
  const st = makeEvo($<HTMLCanvasElement>('evoCanvas'), S.g!, from, to, chips, () => {
    $('evoDone').hidden = false;
    $('evoDone').focus();
  });
  $('evoDone').onclick = async () => {
    try {
      const r = await api<PlayerView>('/api/evolve', { body: {} });
      S.me = { ...S.me!, ...r };
      S.g = petGenome(S.me.creature!);
    } finally {
      $('evoOverlay').hidden = true;
      st.destroy();
      evoRunning = false;
      renderHome();
    }
  };
}

// ---------- coach ----------
/** The coach form's named controls (form.aggression and form.healAt are the browser's named-element lookups). */
interface CoachForm extends HTMLFormElement {
  aggression: HTMLInputElement;
  healAt: HTMLSelectElement;
}
function renderCoach() {
  const t = S.me!.creature!.tactics,
    f = $<CoachForm>('coachForm');
  f.aggression.value = String(t.aggression);
  $('aggrVal').textContent = `${t.aggression}%`;
  f.querySelector<HTMLInputElement>(`[name=special][value=${t.special}]`)!.checked = true;
  f.healAt.value = String(t.healAt);
  f.querySelector<HTMLInputElement>(`[name=style][value=${t.style}]`)!.checked = true;
  const mv = MOVES[S.g!.type];
  $('specialName').textContent = `(${mv.special}; everyday attack: ${mv.strike})`;
  renderScript(S.me!.creature!.strategy);
}
function renderScript(s: StrategyView) {
  $<HTMLTextAreaElement>('scriptSrc').value = s.script;
  $('scriptState').textContent = s.source === 'script' ? '(in use)' : '(your tactics, written as a script)';
  if (s.source === 'script') $<HTMLDetailsElement>('scriptPanel').open = true;
}
function initCoach() {
  const f = $<CoachForm>('coachForm');
  f.aggression.addEventListener('input', () => {
    $('aggrVal').textContent = `${f.aggression.value}%`;
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tactics = {
      aggression: Number(f.aggression.value),
      special: f.querySelector<HTMLInputElement>('[name=special]:checked')!.value,
      healAt: Number(f.healAt.value),
      style: f.querySelector<HTMLInputElement>('[name=style]:checked')!.value,
    };
    try {
      const r = await api<{ tactics: Tactics; strategy: StrategyView }>('/api/tactics', { body: { tactics } });
      S.me!.creature!.tactics = r.tactics;
      S.me!.creature!.strategy = r.strategy;
      renderScript(r.strategy);
      $('coachMsg').textContent = 'Plan saved. It will fight this way from now on.';
    } catch (err) {
      $('coachMsg').textContent = errMsg(err);
    }
  });
  $('scriptForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ta = $<HTMLTextAreaElement>('scriptSrc');
    try {
      const r = await api<{ strategy: StrategyView }>('/api/script', { body: { script: ta.value } });
      S.me!.creature!.strategy = r.strategy;
      renderScript(r.strategy);
      $('scriptMsg').textContent = `Script saved: ${r.strategy.rules} rules. It fights this way from the next battle.`;
    } catch (err) {
      $('scriptMsg').textContent = errMsg(err);
      const b = (err as ApiError).body as { line?: number; col?: number } | undefined;
      if (b?.line) {
        const lines = ta.value.split('\n');
        const at = lines.slice(0, b.line - 1).reduce((n, l) => n + l.length + 1, 0) + (b.col ?? 1) - 1;
        ta.focus();
        ta.setSelectionRange(at, at + 1);
      }
    }
  });
}

// ---------- battle ----------
let speed = 1;
function initBattle() {
  battleStage = makeBattle($<HTMLCanvasElement>('battleCanvas'));
  $('fightBtn').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('fightBtn');
    btn.disabled = true;
    $('battleMsg').textContent = 'Looking for a rival…';
    try {
      const out = await api<BattleOut>('/api/battle', { body: {} });
      $('battleMsg').textContent =
        `vs @${out.b.handle}${out.b.bot ? ' (house bot)' : out.b.pid.startsWith('npc:') ? ' (NPC)' : out.b.verified ? '' : ' (unverified)'}`;
      battleStage.play(out, 0, {
        speed,
        onDone: async (res: BattleResult) => {
          const won = res.winner === 0;
          $('battleMsg').textContent =
            `${won ? 'Won' : res.winner === null ? 'Draw' : 'Lost'} vs @${out.b.handle}. +${out.xp} XP, ${out.ranked ? `rating ${out.ratingDelta >= 0 ? '+' : ''}${out.ratingDelta}` : 'unranked'}${out.loot ? `, found ${ITEMS[out.loot]?.name ?? 'something'}${out.lootNote === 'duplicate' ? ' (duplicate, +10 XP)' : ''}` : ''}.`;
          btn.disabled = false;
          await refresh();
          renderBattleLog();
          if (out.bits) $('battleMsg').textContent += ` +${bitsWord(out.bits)}.`;
          if (S.me!.creature?.evolving) {
            location.hash = '#home';
          }
        },
      });
    } catch (e) {
      $('battleMsg').textContent = errMsg(e);
      btn.disabled = false;
    }
  });
  $('speedBtn').addEventListener('click', () => {
    speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
    $('speedBtn').textContent = `Speed ×${speed}`;
    battleStage.setSpeed(speed);
  });
  $('skipBtn').addEventListener('click', () => battleStage.skip());
}
async function renderBattleLog() {
  const c = S.me?.creature;
  if (!c) return;
  $('fightBtn').textContent = `Find a battle (−${c.battleEnergy} energy)`;
  const r = await api<{ battles: BattleRow[] }>('/api/battles');
  $('battleDot').hidden = true;
  const ul = $('battleLog');
  if (!r.battles.length) {
    ul.innerHTML = '<li class="dim">No battles yet. Find one!</li>';
    return;
  }
  ul.innerHTML = r.battles
    .map(
      (
        b,
      ) => `<li><div><span class="res ${b.outcome}">${b.outcome === 'win' ? 'Won' : b.outcome === 'loss' ? 'Lost' : 'Draw'}</span> vs @${esc(b.opp_handle)}${b.opp_bot ? ' <span class="meta">bot</span>' : ''} ${b.side === 1 ? '<span class="meta">(they challenged you)</span>' : ''} ${b.seen === 0 ? '<span class="new">NEW</span>' : ''}
    <div class="meta">${new Date(b.at).toLocaleString()} · +${b.xp} XP${b.rating_delta ? ` · rating ${b.rating_delta > 0 ? '+' : ''}${b.rating_delta}` : ''}${b.loot ? ` · ${esc(ITEMS[b.loot.split(':')[0]]?.name || '')}` : ''}</div></div>
    <button class="btn ghost" type="button" data-replay="${esc(b.id)}">Replay</button></li>`,
    )
    .join('');
  for (const btn of ul.querySelectorAll<HTMLElement>('[data-replay]'))
    btn.addEventListener('click', async () => {
      const rep = await api<ReplayResponse>(`/api/battles/${encodeURIComponent(btn.dataset.replay!)}`);
      const loot = rep.side === 0 ? (r.battles.find((x) => x.id === rep.id)?.loot || '').split(':')[0] || null : null;
      $('battleMsg').textContent = `Replay vs @${rep.side === 0 ? rep.b.handle : rep.a.handle}`;
      battleStage.play({ ...rep, loot }, rep.side, { speed });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
}

// ---------- leaderboard ----------
function rankList(ol: HTMLElement, players: LeaderRow[], ranked: boolean) {
  if (!players.length) {
    ol.innerHTML = `<li class="empty">${ranked ? 'No ranked players yet. Ranked play opens to GitHub accounts at least 30 days old.' : 'No one yet.'}</li>`;
    return;
  }
  ol.innerHTML = players
    .map(
      (p, i) => `<li class="${p.handle === S.me!.session.handle ? 'me' : ''}"><canvas data-i="${i}" aria-hidden="true"></canvas>
    <div><div class="nm">${esc(p.name)}</div><div class="hd">@${esc(p.handle)} ${p.npc ? `<span class="badge npc" title="House NPC: ${esc(p.persona || '')}">NPC</span>` : p.verified ? '' : '<span class="badge warn">unverified</span>'} · Lv ${p.level} ${STAGE_NAMES[p.stage]}</div></div>
    <div><div class="rt">${ranked ? p.rating : `${p.wins}W`}</div><div class="wl">${ranked ? `${p.wins}W ${p.losses}L${p.draws ? ` ${p.draws}D` : ''}` : `${p.losses}L · ${p.xp} XP`}</div></div></li>`,
    )
    .join('');
  ol.querySelectorAll('canvas').forEach((cv) => {
    const p = players[Number(cv.dataset.i)];
    if (!p.seed) return;
    const g: Genome = { ...genome(p.seed) };
    paintStatic(cv, spr(g, { stage: p.stage }), 48);
  });
}
async function renderRanks() {
  const r = await api<{ players: LeaderRow[]; unranked?: LeaderRow[] }>('/api/leaderboard');
  rankList($('ranks'), r.players, true);
  rankList($('ranksU'), r.unranked || [], false);
}

// ---------- tokens ----------
async function renderTokens() {
  const r = await api<{ tokens: TokenRow[] }>('/api/tokens');
  const ul = $('tokenList');
  ul.innerHTML = r.tokens.length
    ? r.tokens
        .map(
          (t) =>
            `<li><div><span class="res">${esc(t.name)}</span><div class="meta">created ${new Date(t.created_at).toLocaleDateString()}${t.last_used ? ` · last used ${new Date(t.last_used).toLocaleString()}` : ' · never used'}</div></div><button class="btn ghost" data-revoke="${esc(t.id)}" type="button">Revoke</button></li>`,
        )
        .join('')
    : '<li class="dim">No tokens yet.</li>';
  for (const b of ul.querySelectorAll<HTMLElement>('[data-revoke]'))
    b.addEventListener('click', async () => {
      await api(`/api/tokens/${b.dataset.revoke}`, { method: 'DELETE' });
      $('tokenOut').hidden = true;
      renderTokens();
    });
}
function initTokens() {
  $('tokenForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api<{ token: string }>('/api/tokens', { body: { name: $<HTMLInputElement>('tokenName').value || 'API token' } });
      $('tokenOut').hidden = false;
      $('tokenOut').textContent = `${r.token}\n\nShown once. Copy it now.`;
      $<HTMLInputElement>('tokenName').value = '';
      renderTokens();
    } catch (err) {
      $('tokenOut').hidden = false;
      $('tokenOut').textContent = errMsg(err);
    }
  });
}

// ---------- live needs ----------
// Needs are derived from timestamps on the server; the client just re-reads now and then.
setInterval(async () => {
  if (S.view === 'home' && document.visibilityState === 'visible') {
    await refresh();
    renderHome();
  }
}, 60000);

(async function main() {
  initHatch();
  initCare();
  initCoach();
  initBattle();
  initShop();
  initTokens();
  await initLogin().catch(() => {
    $('demoErr').textContent = "Couldn't reach Forklings. Check your connection and reload.";
  });
  await refresh();
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();

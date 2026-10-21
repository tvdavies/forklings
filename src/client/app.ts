// Forklings web client: a small hash-routed PWA over the JSON API.

import { type BattleResult, fighter, HELD_EFFECTS, MOVES, type Snapshot, strongAgainst, type Tactics, TYPE_EDGE } from '../shared/battle';
import { ITEMS, SLOTS } from '../shared/compose';
import { FIRST_DAY_STEPS, type FirstDayStep, type FirstDayView } from '../shared/firstday';
import { describe, type Genome, genome, RARITY, RCOL, STAGE_NAMES } from '../shared/genome';
import { advance, HUNGRY_BELOW, type PetState, STAGE_XP, TIRED_BELOW } from '../shared/state';
import { battleVerdict } from '../shared/verdict';
import { itemIcon, paintStatic, RM, spr } from './engine';
import { makeMeadow } from './meadow';
import { makeBattle, makeEvo, makeHatch, makeHome } from './scenes';
import { copyPicture, hatchPicture } from './share';

// ---------- API shapes (the fields of the Worker's JSON responses that the client reads) ----------
interface Session {
  handle: string;
  pid: string;
}
interface CreatureView {
  seed: string;
  items: Record<string, string | null>;
  tactics: Tactics;
  state: PetState;
  level: number;
  stage: number;
  mood: string;
  nextStageXp: number | null;
  evolving: { from: number; to: number } | null;
  cooldowns: Record<string, number>;
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
  inventory: { item: string }[];
  unseenDefences: number;
  firstDay?: FirstDayView | null;
}
interface Me extends PlayerView {
  session: Session;
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
/** The viewer's own row; see MyPlace in src/worker/leaderboard.ts. */
type MyPlace = LeaderRow & ({ ranked: true; rank: number; of: number } | { ranked: false; rankedAt: number | null });
interface LeaderboardResponse {
  players: LeaderRow[];
  npcs: LeaderRow[];
  unranked: LeaderRow[];
  me: MyPlace | null;
}
interface TokenRow {
  id: string;
  name: string;
  created_at: number;
  last_used: number | null;
}
/** An app connected over OAuth (see src/worker/oauth.ts). */
interface ConnectionRow {
  id: string;
  client: string;
  domain: string | null;
  redirectHost: string;
  local: boolean;
  scopes: string[];
  connectedAt: number;
  lastActive: number | null;
}
/** Short labels for the OAuth scopes, as the connected-apps list shows them. */
const SCOPE_LABEL: Record<string, string> = {
  'pet:read': 'see',
  'pet:care': 'care',
  'strategy:read': 'read strategy',
  'strategy:write': 'coach',
  'battle:read': 'battle log',
  'battle:spar': 'spar',
  'battle:simulate': 'simulate',
};

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
  /** Why the sign-in page is showing, if it isn't a plain first visit: see SIGN_IN_MESSAGES. */
  signInReason: string | null;
}
const S: AppState = { me: null, g: null, view: null, signInReason: null };
let homeStage: ReturnType<typeof makeHome> | undefined;
let meadow: ReturnType<typeof makeMeadow> | undefined;
let battleStage: ReturnType<typeof makeBattle>;

function petGenome(c: CreatureView): Genome {
  const g: Genome = { ...genome(c.seed) };
  g.items = { ...c.items };
  g.id = `${g.id}|${SLOTS.map(([s]) => c.items[s] || '').join('.')}`;
  return g;
}

// ---------- routing ----------
const VIEWS = ['login', 'hatch', 'home', 'coach', 'battle', 'ranks', 'api'];
function show(v: string) {
  const from = S.view;
  // Picking a tab from the keyboard moves focus to the new screen, not back to the top of the page.
  const fromTabs = S.view !== v && !!document.activeElement?.closest('#tabs');
  S.view = v;
  for (const id of VIEWS) $(`v-${id}`).hidden = id !== v;
  const authed = !!S.me;
  $('top').hidden = !authed;
  $('tabs').hidden = !authed || !S.me?.creature;
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.tabs a'))
    a.setAttribute('aria-current', a.dataset.tab === v ? 'page' : 'false');
  if (v === 'login') renderSignIn();
  if (v === 'home') renderHome();
  // Coach and other clients can tick first-day steps without returning the player view.
  if (v === 'home' && from && from !== 'home' && S.me?.firstDay && !S.me.firstDay.complete)
    refresh().then(
      () => S.view === 'home' && renderHome(),
      () => {},
    );
  if (v === 'coach') renderCoach();
  if (v === 'battle') renderBattleLog();
  if (v === 'ranks') renderRanks();
  if (v === 'api') {
    renderConnections();
    renderTokens();
  }
  window.scrollTo(0, 0);
  if (fromTabs) {
    const sec = $(`v-${v}`);
    sec.tabIndex = -1;
    sec.focus({ preventScroll: true });
  }
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
    const err = e as ApiError;
    if (err.status !== 401) throw e;
    S.me = null;
    // The Worker says so when it had to clear a session cookie that no longer works.
    if ((err.body as { ended?: boolean } | null)?.ended) S.signInReason ??= 'ended';
  }
  if (S.me?.creature) S.g = petGenome(S.me.creature);
  if (S.me) $('whoHandle').textContent = `@${S.me.session.handle}`;
  $('battleDot').hidden = !((S.me?.unseenDefences ?? 0) > 0);
}

// ---------- sign-in ----------
// Reasons the Worker sends back from GitHub (/?signin=<reason>), plus 'ended' from /api/me.
// When the API doesn't answer at all, boot() shows its retry panel instead.
const SIGN_IN_MESSAGES: Record<string, string> = {
  denied: 'Sign-in was cancelled on GitHub, so nothing was shared. Sign in whenever you like.',
  expired: 'That sign-in took too long or started in another tab. Start again here.',
  failed: "GitHub couldn't confirm who you are. Try signing in again.",
  unavailable: "Forklings couldn't reach GitHub just now. Try again in a minute.",
  unconfigured: "GitHub sign-in isn't set up on this server yet.",
  ended: 'Your session has ended. Sign in with GitHub to carry on.',
};

function renderSignIn() {
  const msg = $('signinMsg');
  const text = S.signInReason ? (SIGN_IN_MESSAGES[S.signInReason] ?? SIGN_IN_MESSAGES.failed) : '';
  msg.textContent = text;
  msg.hidden = !text;
  if (!meadow) meadow = makeMeadow($<HTMLCanvasElement>('meadowCanvas'));
}

function initSignIn() {
  // Read the reason GitHub's callback sent us back with, then tidy it out of the address bar.
  const url = new URL(location.href);
  const reason = url.searchParams.get('signin');
  if (reason) {
    S.signInReason = reason;
    url.searchParams.delete('signin');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  const gh = $('ghBtn');
  // The Forklings look over at the button: left of the meadow on wide screens, below it on phones.
  const towards = () => (window.matchMedia('(max-width: 860px)').matches ? 0 : -1);
  gh.addEventListener('pointerenter', () => meadow?.excite(towards()));
  gh.addEventListener('focus', () => meadow?.excite(towards()));
  gh.addEventListener('pointerleave', () => meadow?.calm());
  gh.addEventListener('blur', () => meadow?.calm());
  $('logoutBtn').addEventListener('click', async () => {
    await api('/auth/logout', { body: {} });
    S.me = null;
    S.g = null;
    S.signInReason = null;
    location.hash = '';
    route();
  });
}

// ---------- hatch ----------
/** One line on what a type means in battle, such as "Markup type: hits Data types 15% harder". */
const typeLine = (type: string) => `${type} type: hits ${strongAgainst(type)} types ${Math.round((TYPE_EDGE - 1) * 100)}% harder`;
function cardHTML(g: Genome) {
  return `<div class="rowc"><span class="nm">${esc(g.name)}</span><span class="rarity" style="--rc:${RCOL[g.rarity]}">${RARITY[g.rarity]} <span aria-hidden="true">${'★'.repeat(g.rarity + 1)}</span></span></div>
  <div class="typeline">${typeLine(g.type)}</div><div class="whoc">Hatched by @${esc(S.me!.session.handle)}</div><div class="traits">${esc(describe(g))}</div>`;
}
function initHatch() {
  // Before hatching, the egg is a neutral placeholder: the real seed doesn't exist until you press Hatch.
  const placeholder = genome('0f0e1e5000000000000000000000000000000000000000000000000000000000');
  placeholder.pal = ['frost', 'lilac'];
  const hatchStage = makeHatch($<HTMLCanvasElement>('hatchCanvas'), {
    g: placeholder,
    onHatched: (g) => {
      $('hatchTitle').textContent = `Meet ${g.name}`;
      $('hatchCard').innerHTML = cardHTML(g);
      $('hatchCard').classList.add('show');
      $('meetBtn').hidden = false;
      $('copyPic').hidden = false;
    },
  });
  $('hatchInfo').addEventListener('click', () => {
    const open = $('hatchWhy').hidden;
    $('hatchWhy').hidden = !open;
    $('hatchInfo').setAttribute('aria-expanded', String(open));
  });
  $('copyPic').addEventListener('click', async () => {
    const g = S.g!;
    const how = await copyPicture(hatchPicture(g, S.me!.session.handle, typeLine(g.type)), `${g.name}.png`).catch(() => null);
    $('hatchMsg').textContent =
      how === 'copied' ? 'Copied. Paste it anywhere.' : how === 'saved' ? `Saved as ${g.name}.png` : "Couldn't make the picture.";
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
/** A need bar below this turns coral. */
const LOW_NEED = 25;
const CORAL = '#ff6f62';
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
  renderNeedChips(c.state, napping);
  $('napBtn').textContent = napping ? 'Wake' : 'Nap';
  const xpNext = c.nextStageXp,
    xp = Math.floor(c.state.xp),
    prev = STAGE_XP[c.stage];
  const growth = xpNext ? Math.max(0, Math.min(100, ((xp - prev) / (xpNext - prev)) * 100)) : 100;
  $('stats').innerHTML =
    STAT_DEF.map(([k, label, col]) => {
      const v = Math.round(c.state[k]),
        low = c.state[k] < LOW_NEED;
      return `<div class="stat${low ? ' low' : ''}"><span>${label}</span><div class="bar"><i style="width:${v}%;background-color:${low ? CORAL : col}"></i></div><span class="v">${v}${low ? '<span class="visually-hidden"> (low)</span>' : ''}</span></div>`;
    }).join('') +
    `<div class="stat"><span>Growth</span><div class="bar"><i style="width:${growth}%;background-color:#6fdc9c"></i></div><span class="v">${xp}</span></div>` +
    `<p class="statnote">${xpNext ? `${Math.max(0, xpNext - xp)} XP until it evolves into a ${STAGE_NAMES[c.stage + 1]}.` : 'Fully evolved. A Prime.'} Needs change over time, even while you're away.</p>`;
  renderWardrobe();
  renderFirstDay();
  if (c.evolving) startEvolution();
}

/** "Hungry" and "Tired" chips by the name, at the levels where mood starts to suffer. Re-rendered only when they change, so they pop in once. */
function renderNeedChips(s: PetState, napping: boolean) {
  const chips = [s.fullness < HUNGRY_BELOW ? 'Hungry' : '', !napping && s.energy < TIRED_BELOW ? 'Tired' : ''].filter(Boolean);
  const el = $('petChips');
  const key = chips.join(',');
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = chips.map((t) => `<span class="chip">${t}</span>`).join('');
}

// ---------- first day ----------
const FIRST_DAY_COPY: Record<FirstDayStep, { label: string; next: string }> = {
  feed: { label: 'Feed it', next: 'Tap Feed. A fed, happy Forkling keeps growing while you’re away.' },
  dress: { label: 'Put something on', next: 'Pick something from the wardrobe. A held item gives a small battle edge.' },
  plan: { label: 'Set a plan', next: 'Open Coach and save a plan. Your Forkling fights that way, even while you’re away.' },
  win: { label: 'Win a battle', next: 'Find a battle. If you lose, try a different plan in Coach.' },
};
/** Steps ticked as of the last render, so a newly ticked one gets its burst. Null before the first render. */
let fdShown: Set<FirstDayStep> | null = null;

function firstDayGo(step: FirstDayStep) {
  if (step === 'feed') document.querySelector<HTMLButtonElement>('[data-care=feed]')?.click();
  if (step === 'dress') {
    $('wardrobe').scrollIntoView({ behavior: RM ? 'auto' : 'smooth', block: 'center' });
    $('wardrobe')
      .querySelector<HTMLButtonElement>('.item:not(.locked)[aria-pressed=false]:not(:first-child)')
      ?.focus({ preventScroll: true });
  }
  if (step === 'plan') location.hash = '#coach';
  if (step === 'win') location.hash = '#battle';
}

async function closeFirstDay() {
  try {
    const r = await api<PlayerView>('/api/first-day/close', { body: {} });
    S.me = { ...S.me!, ...r };
  } catch {
    S.me = { ...S.me!, firstDay: null };
  }
  renderHome();
}

function renderFirstDay() {
  const fd = S.me?.firstDay,
    el = $('firstDay');
  el.hidden = !fd;
  // Rebuild only when something changed, so the minute-by-minute refresh doesn't steal focus.
  const key = fd ? JSON.stringify(fd) : '';
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  if (!fd) return;
  const ticked = new Set(FIRST_DAY_STEPS.filter((s) => fd.steps[s]));
  const fresh = (s: FirstDayStep) => fdShown !== null && ticked.has(s) && !fdShown.has(s);
  const name = esc(S.g!.name);
  if (fd.complete) {
    const it = fd.reward ? ITEMS[fd.reward] : undefined;
    el.innerHTML = `<div class="fd-head"><h3 id="fdTitle">First day done!</h3></div>
      <div class="fd-reward${fdShown && fdShown.size < FIRST_DAY_STEPS.length ? ' just' : ''}">${it ? '<span class="fd-gift"><canvas aria-hidden="true"></canvas></span>' : ''}
      <p>${it ? `${name} found a <b>${esc(it.name)}</b> for you. It’s in the wardrobe.` : `${name} had a great first day.`}</p></div>
      <div class="row">${it ? '<button class="btn" type="button" data-fd-wear>Wear it</button>' : ''}<button class="btn ghost" type="button" data-fd-close>${it ? 'Later' : 'Close'}</button></div>`;
    if (it) paintStatic(el.querySelector('canvas')!, itemIcon(fd.reward!), 44);
    el.querySelector('[data-fd-wear]')?.addEventListener('click', async () => {
      try {
        const r = await api<PlayerView>('/api/equip', { body: { slot: it!.slot, item: fd.reward } });
        S.me = { ...S.me!, ...r };
        S.g = petGenome(S.me.creature!);
        homeStage?.react('equip');
      } catch (e) {
        homeStage?.say(errMsg(e), false);
      }
      await closeFirstDay();
    });
  } else {
    const next = FIRST_DAY_STEPS.find((s) => !ticked.has(s))!;
    el.innerHTML = `<div class="fd-head"><h3 id="fdTitle">First day</h3><span class="fd-count">${ticked.size} of ${FIRST_DAY_STEPS.length}</span>
      <button class="fd-close" type="button" data-fd-close aria-label="Hide the first-day list">×</button></div>
      <ol class="fd-steps">${FIRST_DAY_STEPS.map((s) =>
        ticked.has(s)
          ? `<li class="done${fresh(s) ? ' just' : ''}"><span class="fd-box" aria-hidden="true"></span><span><span class="visually-hidden">Done: </span>${FIRST_DAY_COPY[s].label}</span></li>`
          : `<li><button type="button" data-fd-go="${s}"><span class="fd-box" aria-hidden="true"></span>${FIRST_DAY_COPY[s].label}</button></li>`,
      ).join('')}</ol>
      <p class="fd-next">${FIRST_DAY_COPY[next].next}</p>`;
    for (const b of el.querySelectorAll<HTMLElement>('[data-fd-go]'))
      b.addEventListener('click', () => firstDayGo(b.dataset.fdGo as FirstDayStep));
  }
  el.querySelector('[data-fd-close]')?.addEventListener('click', closeFirstDay);
  fdShown = ticked;
}

function renderWardrobe() {
  const c = S.me!.creature!;
  const owned = new Set(S.me!.inventory.map((i) => i.item));
  const w = $('wardrobe');
  w.innerHTML = '';
  for (const [slot, label] of SLOTS) {
    const div = document.createElement('div');
    div.className = 'slot';
    div.innerHTML = `<h4>${label}</h4><div class="opts"></div>`;
    const opts = div.querySelector('.opts')!;
    const ids = [null, ...Object.keys(ITEMS).filter((id) => ITEMS[id].slot === slot)];
    for (const id of ids) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'item';
      const on = (c.items[slot] || null) === id;
      b.setAttribute('aria-pressed', String(on));
      if (id) {
        const it = ITEMS[id];
        const have = owned.has(id);
        b.style.setProperty('--bc', on ? '#ffd166' : RCOL[it.rarity]);
        const fx = HELD_EFFECTS[id] ? ` Battle: ${HELD_EFFECTS[id].label}.` : '';
        b.title = have ? `${it.name} (${RARITY[it.rarity]}): ${it.blurb}${fx}` : `Locked: win battles to find the ${it.name}.${fx}`;
        b.setAttribute('aria-label', have ? `${it.name}, ${RARITY[it.rarity]}` : `${it.name}, locked`);
        if (!have) {
          b.classList.add('locked');
          b.disabled = true;
        }
        const cv = document.createElement('canvas');
        b.appendChild(cv);
        paintStatic(cv, itemIcon(id), 38);
      } else {
        b.innerHTML = '<span class="none">None</span>';
        b.setAttribute('aria-label', `No ${label.toLowerCase()} item`);
      }
      b.addEventListener('click', async () => {
        try {
          const r = await api<PlayerView>('/api/equip', { body: { slot, item: id } });
          S.me = { ...S.me!, ...r };
          S.g = petGenome(S.me.creature!);
          renderHome();
          homeStage!.react('equip');
        } catch (e) {
          $('careMsg').textContent = errMsg(e);
          homeStage?.say(errMsg(e), false);
        }
      });
      opts.appendChild(b);
    }
    w.appendChild(div);
  }
}

function initCare() {
  for (const b of document.querySelectorAll<HTMLElement>('[data-care]'))
    b.addEventListener('click', async () => {
      const action = b.dataset.care!;
      const r = await api<CareResponse>('/api/care', { body: { action }, soft: true });
      const said = (r.message || r.error || '') + (r.xpGain ? `  +${r.xpGain}\u00a0XP` : '');
      $('careMsg').textContent = said;
      homeStage?.say(said, !!r.ok);
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
    [`${S.g!.name} is now a ${STAGE_NAMES[to]}`, '#ffd166'],
    [`+${after.maxHp - before.maxHp} HP`, '#6fdc9c'],
    [`+${Math.round(after.atk - before.atk)} Attack`, '#ff6f62'],
  ];
  // A modal moment: the page behind can't be reached until the player closes it.
  const back = document.activeElement as HTMLElement | null;
  for (const id of ['top', 'app', 'tabs']) $(id).inert = true;
  $('evoOverlay').hidden = false;
  $('evoDone').hidden = true;
  $('evoBox').focus();
  $('evoMsg').textContent = `${S.g!.name} is evolving into a ${STAGE_NAMES[to]}.`;
  const st = makeEvo($<HTMLCanvasElement>('evoCanvas'), S.g!, from, to, chips, () => {
    $('evoMsg').textContent = `${S.g!.name} is now a ${STAGE_NAMES[to]}: ${chips
      .filter(([txt]) => txt.startsWith('+'))
      .map(([txt]) => txt)
      .join(', ')}.`;
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
      for (const id of ['top', 'app', 'tabs']) $(id).inert = false;
      st.destroy();
      evoRunning = false;
      renderHome();
      if (back?.isConnected) back.focus();
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
/** Clears the hidden narration list and returns a callback that adds each canvas line to it, for screen readers. */
function sayLine() {
  const ol = $('battleLines');
  ol.replaceChildren();
  return (text: string) => {
    const li = document.createElement('li');
    li.textContent = text;
    ol.appendChild(li);
  };
}
let fighting = false;
let battleReadyAt = 0; // the server keeps a short gap between battles
const oppTag = (s: Snapshot) => (s.bot ? ' (house bot)' : s.pid.startsWith('npc:') ? ' (NPC)' : '');

/** Energy now (needs drift between reads), and whether the pet can fight or should rest at Home first. */
function fightReadiness(c: CreatureView) {
  const now = Date.now(),
    energy = Math.floor(advance(c.state, now).energy),
    napping = now < c.state.napUntil;
  return { energy, napping, rest: napping || energy < c.battleEnergy };
}

/** Energy where the player fights: its level, what a fight costs, and what to do when it runs out. */
function renderEnergy() {
  const c = S.me?.creature;
  if (!c) return;
  const cost = c.battleEnergy,
    { energy, napping, rest } = fightReadiness(c),
    fights = Math.floor(energy / cost);
  const btn = $<HTMLButtonElement>('fightBtn');
  if (!fighting) {
    btn.classList.remove('busy');
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
    btn.dataset.rest = String(rest);
    btn.textContent = napping ? 'Wake it on Home' : rest ? 'Rest at Home' : `Find a battle (−${cost} energy)`;
  }
  const note = napping
    ? `It's napping, which refills energy fastest.`
    : rest
      ? `A fight needs ${cost}. A nap refills energy fastest.`
      : `Enough for ${fights} fight${fights === 1 ? '' : 's'}.`;
  $('energyLine').innerHTML =
    `<span>Energy</span><div class="bar" aria-hidden="true"><i style="width:${energy}%;background-color:#86bdff"></i></div><b>${energy}/100</b><span class="note">${note}</span>`;
}

function hideResult() {
  $('resultCard').hidden = true;
  $('fightBtn').parentElement!.hidden = false; // the row with Speed and Skip
  $('energyLine').hidden = false;
}

/** The result card: won or lost, one reason why, what it earned, and the next step. */
function showResult(out: BattleOut, res: BattleResult) {
  const c = S.me!.creature!;
  const v = battleVerdict(out.a, out.b, res, 0);
  const title = $('resultTitle');
  title.textContent = v.outcome === 'win' ? 'Won' : v.outcome === 'loss' ? 'Lost' : 'Draw';
  title.className = `result-title ${v.outcome}`;
  $('resultVs').textContent = `vs @${out.b.handle}${oppTag(out.b)}`;
  $('resultWhy').textContent = v.reason;

  const xpLeft = c.nextStageXp ? Math.max(0, c.nextStageXp - Math.floor(c.state.xp)) : 0;
  const xpNote = c.evolving ? 'Ready to evolve!' : xpLeft ? `${xpLeft} XP until it becomes a ${STAGE_NAMES[c.stage + 1]}` : '';
  const sign = out.ratingDelta > 0 ? '+' : out.ratingDelta < 0 ? '−' : '±';
  let rows =
    `<dt>XP</dt><dd>+${out.xp}<span class="note">${xpNote}</span></dd>` +
    `<dt>Rating</dt><dd>${out.ranked ? `<span class="${out.ratingDelta < 0 ? 'down' : 'up'}">${sign}${Math.abs(out.ratingDelta)}</span>` : 'Unranked'}</dd>`;
  const it = out.loot ? ITEMS[out.loot] : undefined;
  if (out.loot && it) {
    const fx = HELD_EFFECTS[out.loot] ? ` · Battle: ${HELD_EFFECTS[out.loot].label}` : '';
    rows += `<dt>Loot</dt><dd class="loot"><canvas aria-hidden="true"></canvas><span>${esc(it.name)} · <span style="color:${RCOL[it.rarity]}">${RARITY[it.rarity]}</span><span class="note">${out.lootNote === 'duplicate' ? 'Already yours: +10 XP' : 'New'}${fx}</span></span></dd>`;
  }
  const dl = $('resultRows');
  dl.innerHTML = rows;
  if (out.loot && it) {
    const id = out.loot;
    paintStatic(dl.querySelector('canvas')!, itemIcon(id), 32);
    if (c.items[it.slot] !== id) {
      const wear = document.createElement('button');
      wear.type = 'button';
      wear.className = 'btn small-btn';
      wear.id = 'resultWear';
      wear.textContent = 'Wear it';
      wear.addEventListener('click', async () => {
        wear.disabled = true;
        try {
          const r = await api<PlayerView>('/api/equip', { body: { slot: it.slot, item: id } });
          S.me = { ...S.me!, ...r };
          S.g = petGenome(S.me.creature!);
          const worn = document.createElement('span');
          worn.className = 'worn';
          worn.textContent = 'Wearing it';
          wear.replaceWith(worn);
          $('resultAgain').focus({ preventScroll: true }); // the focused button just went away
        } catch (e) {
          wear.disabled = false;
          $('battleMsg').textContent = errMsg(e);
        }
      });
      dl.querySelector('.loot')!.appendChild(wear);
    }
  }

  // One primary action: the plan when the reason is about tactics, otherwise another fight.
  const coach = $('resultCoach'),
    again = $<HTMLButtonElement>('resultAgain');
  coach.className = v.nudge === 'coach' ? 'btn' : 'btn ghost';
  again.className = v.nudge === 'coach' ? 'btn ghost' : 'btn';
  const { energy, rest } = fightReadiness(c);
  again.innerHTML = rest
    ? `Rest at Home<small>Has ${energy} of ${c.battleEnergy} energy</small>`
    : `Fight again<small>${energy} energy left</small>`;
  again.dataset.rest = String(rest);

  $('battleMsg').textContent = '';
  $('fightBtn').parentElement!.hidden = true; // the card's Fight again takes over
  $('energyLine').hidden = true;
  $('resultCard').hidden = false;
  title.focus({ preventScroll: true });
}

async function startFight() {
  const c = S.me?.creature;
  if (fighting || !c) return;
  const btn = $<HTMLButtonElement>('fightBtn');
  fighting = true;
  hideResult();
  // Busy, not disabled-looking: the fight is happening.
  btn.disabled = true;
  btn.classList.add('busy');
  btn.setAttribute('aria-busy', 'true');
  $('battleMsg').textContent = '';
  const wait = battleReadyAt - Date.now();
  if (wait > 0) {
    btn.textContent = 'Catching its breath…';
    await new Promise((r) => setTimeout(r, wait));
  }
  btn.textContent = 'Finding a rival…';
  try {
    const out = await api<BattleOut>('/api/battle', { body: {} });
    const now = Date.now(),
      st = advance(c.state, now);
    c.state = { ...st, energy: Math.max(0, st.energy - c.battleEnergy) };
    btn.textContent = 'Battling…';
    renderEnergy();
    $('battleMsg').textContent = `vs @${out.b.handle}${oppTag(out.b)}`;
    battleStage.play(out, 0, {
      speed,
      onLine: sayLine(),
      onDone: async (res: BattleResult) => {
        fighting = false;
        await refresh().catch(() => {});
        battleReadyAt = Date.now() + (S.me?.creature?.cooldowns.battle ?? 0);
        showResult(out, res);
        renderEnergy();
        renderBattleLog();
        if (S.me!.creature?.evolving) location.hash = '#home';
      },
    });
  } catch (e) {
    fighting = false;
    $('battleMsg').textContent = errMsg(e);
    renderEnergy();
  }
}

function initBattle() {
  battleStage = makeBattle($<HTMLCanvasElement>('battleCanvas'));
  for (const id of ['fightBtn', 'resultAgain'])
    $(id).addEventListener('click', () => {
      if ($(id).dataset.rest === 'true') location.hash = '#home';
      else startFight();
    });
  $('resultClose').addEventListener('click', hideResult);
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
  renderEnergy();
  const r = await api<{ battles: BattleRow[] }>('/api/battles');
  $('battleDot').hidden = true;
  const ul = $('battleLog');
  if (!r.battles.length) {
    ul.innerHTML = `<li class="empty"><p>No battles yet. Your Forkling fights on its own, using the plan you set in Coach.</p>
    <div class="row"><button class="btn" type="button" id="firstFightBtn">Find a battle</button><a class="btn ghost" href="#coach">Check the plan</a></div></li>`;
    $('firstFightBtn').addEventListener('click', () => {
      $('fightBtn').click();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
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
      hideResult();
      $('battleMsg').textContent = `Replay vs @${rep.side === 0 ? rep.b.handle : rep.a.handle}`;
      battleStage.play({ ...rep, loot }, rep.side, { speed, onLine: sayLine() });
      window.scrollTo({ top: 0, behavior: RM ? 'auto' : 'smooth' });
    });
}

// ---------- leaderboard ----------
/** A row's name, handle line and score cells (everything after the sprite). */
function rankCells(p: LeaderRow, ranked: boolean, badge = true) {
  const tag = badge && p.npc ? `<span class="badge npc" title="House NPC: ${esc(p.persona || '')}">NPC</span>` : '';
  return `<div><div class="nm">${esc(p.name)}</div><div class="hd">@${esc(p.handle)} ${tag} · Lv ${p.level} ${STAGE_NAMES[p.stage]}</div></div>
    <div><div class="rt">${ranked ? p.rating : `${p.wins}W`}</div><div class="wl">${ranked ? `${p.wins}W ${p.losses}L${p.draws ? ` ${p.draws}D` : ''}` : `${p.losses}L · ${p.xp} XP`}</div></div>`;
}
function paintRow(cv: HTMLCanvasElement, p: LeaderRow) {
  if (p.seed) paintStatic(cv, spr({ ...genome(p.seed) }, { stage: p.stage }), 48);
}
function rankList(ol: HTMLElement, players: LeaderRow[], ranked: boolean, empty: string) {
  if (!players.length) {
    ol.innerHTML = `<li class="empty">${empty}</li>`;
    return;
  }
  ol.innerHTML = players
    .map(
      (p, i) =>
        `<li class="${p.handle === S.me!.session.handle ? 'me' : ''}"><canvas data-i="${i}" aria-hidden="true"></canvas>
    ${rankCells(p, ranked)}</li>`,
    )
    .join('');
  ol.querySelectorAll('canvas').forEach((cv) => {
    paintRow(cv, players[Number(cv.dataset.i)]);
  });
}
/** The pinned "You" row: your place, or why you're in the practice bracket. */
function renderMyPlace(me: MyPlace | null) {
  const box = $('rankMe');
  box.hidden = !me;
  if (!me) return;
  let status: string;
  if (me.ranked) status = `#${me.rank} of ${me.of} ranked ${me.of === 1 ? 'player' : 'players'}`;
  else if (me.rankedAt === null) status = 'Practice: ranked play opens when your GitHub account is 30 days old';
  else {
    const days = Math.max(1, Math.ceil((me.rankedAt - Date.now()) / 86400e3));
    status = `Practice: ranked play opens in ${days} ${days === 1 ? 'day' : 'days'}`;
  }
  box.innerHTML = `<div class="pos">${me.ranked ? `#${me.rank}` : '–'}<span>You</span></div><canvas aria-hidden="true"></canvas>
    ${rankCells(me, me.ranked, false)}<p class="status">${esc(status)}</p>`;
  paintRow(box.querySelector('canvas')!, me);
}
async function renderRanks() {
  const r = await api<LeaderboardResponse>('/api/leaderboard');
  renderMyPlace(r.me);
  rankList($('ranks'), r.players, true, 'No ranked players yet. Ranked play opens to GitHub accounts at least 30 days old.');
  rankList($('ranksU'), r.unranked, false, 'No one in practice right now.');
  $('npcFold').hidden = !r.npcs.length;
  $('npcCount').textContent = String(r.npcs.length);
  rankList($('ranksN'), r.npcs, true, '');
}

// ---------- connected apps ----------
async function renderConnections() {
  const ul = $('connList');
  let rows: ConnectionRow[];
  try {
    rows = (await api<{ connections: ConnectionRow[] }>('/api/connections')).connections;
  } catch (err) {
    ul.innerHTML = `<li class="dim">${esc(errMsg(err))}</li>`;
    return;
  }
  ul.innerHTML = rows.length
    ? rows
        .map((c) => {
          const who = c.domain ? `${c.domain}` : `unverified${c.local ? ', on your computer' : ` · ${c.redirectHost}`}`;
          const can = c.scopes
            .map((s) => SCOPE_LABEL[s])
            .filter(Boolean)
            .join(', ');
          const seen = c.lastActive ? ` · active ${new Date(c.lastActive).toLocaleString()}` : '';
          return `<li><div><span class="res">${esc(c.client)}</span><div class="meta">${esc(who)} · can ${esc(can || 'see')}</div><div class="meta">connected ${new Date(c.connectedAt).toLocaleDateString()}${seen}</div></div><button class="btn ghost" data-disconnect="${esc(c.id)}" data-name="${esc(c.client)}" type="button">Disconnect</button></li>`;
        })
        .join('')
    : '<li class="dim">No apps connected yet.</li>';
  for (const b of ul.querySelectorAll<HTMLElement>('[data-disconnect]'))
    b.addEventListener('click', async () => {
      if (!confirm(`Disconnect ${b.dataset.name}? It stops working at once and has to sign in again.`)) return;
      await api(`/api/connections/${encodeURIComponent(b.dataset.disconnect ?? '')}`, { method: 'DELETE' });
      renderConnections();
    });
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
    : '<li class="empty"><p>No tokens yet. Name one above, then paste it into Claude Code, Pi or any MCP client.</p></li>';
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

// ---------- boot ----------
// index.html paints a loader before this script runs. boot() swaps it for the app once /api answers,
// or for a retry panel if it doesn't; Try again runs boot() again without reloading the page.
async function boot() {
  bootState('loading');
  try {
    await refresh();
  } catch {
    bootState('error');
    return;
  }
  $('boot').hidden = true;
  route();
}
function bootState(state: 'loading' | 'error') {
  const failed = state === 'error',
    retry = $<HTMLButtonElement>('bootRetry');
  $('boot').dataset.state = state;
  $('bootLine').textContent = failed ? "Can't reach Forklings" : 'Waking your Forkling…';
  $('bootWhy').textContent = failed
    ? "The game server didn't answer, but your Forkling is safe. Check your connection, then try again."
    : '';
  if (failed) {
    retry.hidden = false;
    retry.removeAttribute('aria-disabled');
    retry.textContent = 'Try again';
    retry.focus();
  } else if (!retry.hidden) {
    // Retrying: keep the button (and keyboard focus) where it is, but inert until this attempt ends.
    retry.setAttribute('aria-disabled', 'true');
    retry.textContent = 'Trying…';
  }
}
$('bootRetry').addEventListener('click', () => {
  if ($('bootRetry').getAttribute('aria-disabled') !== 'true') boot();
});

(async function main() {
  initHatch();
  initCare();
  initCoach();
  initBattle();
  initTokens();
  initSignIn();
  await boot();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();

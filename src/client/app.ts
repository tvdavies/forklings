// Forklings web client: a small hash-routed PWA over the JSON API.

import { type BattleResult, fighter, HELD_EFFECTS, MOVES, type Snapshot, type Tactics } from '../shared/battle';
import { ITEMS, SLOTS } from '../shared/compose';
import { describe, type Genome, genome, RARITY, RCOL, STAGE_NAMES } from '../shared/genome';
import { type PetState, STAGE_XP } from '../shared/state';
import { itemIcon, paintStatic, spr } from './engine';
import { makeBattle, makeEvo, makeHatch, makeHome } from './scenes';

// ---------- API shapes (the fields of the Worker's JSON responses that the client reads) ----------
interface Session {
  handle: string;
  verified: boolean;
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

function petGenome(c: CreatureView): Genome {
  const g: Genome = { ...genome(c.seed) };
  g.items = { ...c.items };
  g.id = `${g.id}|${SLOTS.map(([s]) => c.items[s] || '').join('.')}`;
  return g;
}

// ---------- routing ----------
const VIEWS = ['login', 'hatch', 'home', 'coach', 'battle', 'ranks', 'api'];
function show(v: string) {
  S.view = v;
  for (const id of VIEWS) $(`v-${id}`).hidden = id !== v;
  const authed = !!S.me;
  $('top').hidden = !authed;
  $('tabs').hidden = !authed || !S.me?.creature;
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.tabs a'))
    a.setAttribute('aria-current', a.dataset.tab === v ? 'page' : 'false');
  if (v === 'home') renderHome();
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
  const placeholder = genome('0f0rk11ng5000000000000000000000000000000000000000000000000000000');
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
  initTokens();
  await initLogin().catch(() => {
    $('demoErr').textContent = "Couldn't reach Forklings. Check your connection and reload.";
  });
  await refresh();
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();

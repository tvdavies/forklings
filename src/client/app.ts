// @ts-nocheck
// Forklings web client: a small hash-routed PWA over the JSON API.
import { genome, describe, RARITY, RCOL, STAGE_NAMES, Genome } from '../shared/genome';
import { ITEMS, SLOTS } from '../shared/compose';
import { MOVES, fighter, HELD_EFFECTS } from '../shared/battle';
import { STAGE_XP } from '../shared/state';
import { makeHatch, makeHome, makeBattle, makeEvo } from './scenes';
import { spr, itemIcon, paintStatic, idlePose } from './engine';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts: any = {}) {
  const r = await fetch(path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: opts.body ? { 'content-type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !opts.soft) { const e: any = new Error(j.error || j.message || 'Request failed'); e.status = r.status; e.body = j; throw e; }
  return { status: r.status, ...j };
}

const S: any = { me: null, g: null, view: null, config: null };
let homeStage, hatchStage, battleStage;

function petGenome(c): Genome { const g: any = { ...genome(c.seed) }; g.items = { ...c.items }; g.id = g.id + '|' + SLOTS.map(([s]) => c.items[s] || '').join('.'); return g; }

// ---------- routing ----------
const VIEWS = ['login', 'hatch', 'home', 'coach', 'battle', 'ranks', 'api'];
function show(v) {
  S.view = v;
  for (const id of VIEWS) $('v-' + id).hidden = id !== v;
  const authed = !!S.me;
  $('top').hidden = !authed; $('tabs').hidden = !authed || !S.me?.creature;
  document.querySelectorAll('.tabs a').forEach((a: any) => a.setAttribute('aria-current', a.dataset.tab === v ? 'page' : 'false'));
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
  try { S.me = (await api('/api/me')); } catch (e) { if (e.status === 401) S.me = null; else throw e; }
  if (S.me?.creature) S.g = petGenome(S.me.creature);
  if (S.me) { $('whoHandle').textContent = '@' + S.me.session.handle; const b = $('whoBadge'); b.textContent = S.me.session.verified ? 'GitHub' : 'unverified'; b.className = 'badge' + (S.me.session.verified ? '' : ' warn'); }
  $('battleDot').hidden = !(S.me?.unseenDefences > 0);
}

// ---------- login ----------
async function initLogin() {
  S.config = await api('/api/config');
  const gh = $('ghBtn');
  if (!S.config.github) { gh.disabled = true; $('ghNote').textContent = 'GitHub login is coming soon (it needs an OAuth app). Use the demo login below for now.'; }
  gh.addEventListener('click', () => { location.href = '/auth/github'; });
  if (!S.config.demo) $('demoForm').hidden = true;
  $('demoForm').addEventListener('submit', async (e) => {
    e.preventDefault(); $('demoErr').textContent = '';
    try { await api('/auth/demo', { body: { handle: $('demoHandle').value } }); await refresh(); route(); }
    catch (err) { $('demoErr').textContent = err.message; }
  });
  $('logoutBtn').addEventListener('click', async () => { await api('/auth/logout', { body: {} }); S.me = null; S.g = null; location.hash = ''; route(); });
}

// ---------- hatch ----------
function cardHTML(g) {
  return `<div class="rowc"><span class="nm">${esc(g.name)}</span><span class="stars" title="${RARITY[g.rarity]}" style="color:${RCOL[g.rarity]}">${'★'.repeat(g.rarity + 1)}${'☆'.repeat(4 - g.rarity)}</span></div>
  <div class="rowc"><span class="whoc">Hatched by @${esc(S.me.session.handle)}</span><span class="whoc">${RARITY[g.rarity]} ${g.type} type</span></div><div class="traits">${esc(describe(g))}</div>`;
}
function initHatch() {
  // Before hatching, the egg is a neutral placeholder: the real seed doesn't exist until you press Hatch.
  const placeholder: any = genome('0f0rk11ng5000000000000000000000000000000000000000000000000000000');
  placeholder.pal = ['frost', 'lilac'];
  hatchStage = makeHatch($('hatchCanvas'), { g: placeholder, onHatched: (g) => { $('hatchCard').innerHTML = cardHTML(g); $('hatchCard').classList.add('show'); $('meetBtn').hidden = false; } });
  $('hatchBtn').addEventListener('click', async () => {
    $('hatchBtn').disabled = true;
    try {
      const r = await api('/api/hatch', { body: {} });
      S.me = { ...S.me, ...r }; S.g = petGenome(S.me.creature);
      $('hatchBtn').hidden = true; hatchStage.hatch(S.g);
    } catch (e) { $('hatchBtn').disabled = false; alert(e.message); }
  });
  $('meetBtn').addEventListener('click', async () => { await refresh(); location.hash = '#home'; route(); });
}

// ---------- home ----------
const STAT_DEF = [['fullness', 'Fullness', '#ff9f78'], ['mood', 'Mood', '#ff86bd'], ['energy', 'Energy', '#86bdff']];
function renderHome() {
  const c = S.me?.creature; if (!c) return;
  if (!homeStage) homeStage = makeHome($('homeCanvas'));
  const napping = Date.now() < c.state.napUntil;
  homeStage.set(S.g, c.stage, napping, c.mood);
  $('petName').textContent = S.g.name;
  $('petStars').innerHTML = '★'.repeat(S.g.rarity + 1); $('petStars').style.color = RCOL[S.g.rarity]; $('petStars').title = RARITY[S.g.rarity];
  $('petMeta').textContent = `Lv ${c.level} ${STAGE_NAMES[c.stage]} · ${S.g.type} type · ${c.mood}`;
  $('napBtn').textContent = napping ? 'Wake' : 'Nap';
  const xpNext = c.nextStageXp, xp = Math.floor(c.state.xp), prev = STAGE_XP[c.stage];
  const growth = xpNext ? Math.max(0, Math.min(100, ((xp - prev) / (xpNext - prev)) * 100)) : 100;
  $('stats').innerHTML = STAT_DEF.map(([k, label, col]) => `<div class="stat"><span>${label}</span><div class="bar"><i style="width:${Math.round(c.state[k])}%;background-color:${col}"></i></div><span class="v">${Math.round(c.state[k])}</span></div>`).join('')
    + `<div class="stat"><span>Growth</span><div class="bar"><i style="width:${growth}%;background-color:#6fdc9c"></i></div><span class="v">${xp}</span></div>`
    + `<p class="statnote">${xpNext ? `${Math.max(0, xpNext - xp)} XP until it evolves into a ${STAGE_NAMES[c.stage + 1]}.` : 'Fully evolved. A Prime.'} Needs change over time, even while you're away.</p>`;
  renderWardrobe();
  if (c.evolving) startEvolution();
}

function renderWardrobe() {
  const c = S.me.creature; const owned = new Set(S.me.inventory.map((i) => i.item));
  const w = $('wardrobe'); w.innerHTML = '';
  for (const [slot, label] of SLOTS) {
    const div = document.createElement('div'); div.className = 'slot'; div.innerHTML = `<h4>${label}</h4><div class="opts"></div>`; const opts = div.querySelector('.opts');
    const ids = [null, ...Object.keys(ITEMS).filter((id) => ITEMS[id].slot === slot)];
    for (const id of ids) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'item'; const on = (c.items[slot] || null) === id; b.setAttribute('aria-pressed', String(on));
      if (id) {
        const it = ITEMS[id]; const have = owned.has(id);
        b.style.setProperty('--bc', on ? '#ffd166' : RCOL[it.rarity]);
        const fx = HELD_EFFECTS[id] ? ` Battle: ${HELD_EFFECTS[id].label}.` : '';
        b.title = have ? `${it.name} (${RARITY[it.rarity]}): ${it.blurb}${fx}` : `Locked: win battles to find the ${it.name}.${fx}`;
        b.setAttribute('aria-label', have ? `${it.name}, ${RARITY[it.rarity]}` : `${it.name}, locked`);
        if (!have) { b.classList.add('locked'); b.disabled = true; }
        const cv = document.createElement('canvas'); b.appendChild(cv); paintStatic(cv, itemIcon(id), 38);
      } else { b.innerHTML = '<span class="none">None</span>'; b.setAttribute('aria-label', `No ${label.toLowerCase()} item`); }
      b.addEventListener('click', async () => {
        try { const r = await api('/api/equip', { body: { slot, item: id } }); S.me = { ...S.me, ...r }; S.g = petGenome(S.me.creature); renderHome(); homeStage.react('equip'); }
        catch (e) { $('careMsg').textContent = e.message; }
      });
      opts.appendChild(b);
    }
    w.appendChild(div);
  }
}

function initCare() {
  document.querySelectorAll('[data-care]').forEach((b: any) => b.addEventListener('click', async () => {
    const action = b.dataset.care;
    const r = await api('/api/care', { body: { action }, soft: true });
    $('careMsg').textContent = (r.message || r.error || '') + (r.xpGain ? `  +${r.xpGain} XP` : '');
    if (r.creature) { S.me = { ...S.me, ...r }; S.g = petGenome(S.me.creature); }
    if (r.ok) homeStage.react(action);
    renderHome();
  }));
}

// ---------- evolution ----------
let evoRunning = false;
function startEvolution() {
  if (evoRunning) return; evoRunning = true;
  const c = S.me.creature; const from = c.evolving.from, to = c.evolving.to;
  const before = fighter({ seed: c.seed, stage: from, level: c.level, tactics: c.tactics, items: c.items } as any), after = fighter({ seed: c.seed, stage: to, level: c.level, tactics: c.tactics, items: c.items } as any);
  const chips = [[`+${after.maxHp - before.maxHp} HP`, '#6fdc9c'], [`+${Math.round(after.atk - before.atk)} Attack`, '#ff6f62'], [`Now a ${STAGE_NAMES[to]}`, '#ffd166']];
  $('evoOverlay').hidden = false; $('evoDone').hidden = true;
  const st = makeEvo($('evoCanvas'), S.g, from, to, chips, () => { $('evoDone').hidden = false; $('evoDone').focus(); });
  $('evoDone').onclick = async () => {
    const r = await api('/api/evolve', { body: {} }); S.me = { ...S.me, ...r }; S.g = petGenome(S.me.creature);
    $('evoOverlay').hidden = true; st.destroy(); evoRunning = false; renderHome();
  };
}

// ---------- coach ----------
function renderCoach() {
  const t = S.me.creature.tactics, f = $('coachForm');
  f.aggression.value = t.aggression; $('aggrVal').textContent = t.aggression + '%';
  f.querySelector(`[name=special][value=${t.special}]`).checked = true;
  f.healAt.value = String(t.healAt);
  f.querySelector(`[name=style][value=${t.style}]`).checked = true;
  const mv = MOVES[S.g.type]; $('specialName').textContent = `(${mv.special}; everyday attack: ${mv.strike})`;
}
function initCoach() {
  const f = $('coachForm');
  f.aggression.addEventListener('input', () => { $('aggrVal').textContent = f.aggression.value + '%'; });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tactics = { aggression: Number(f.aggression.value), special: f.querySelector('[name=special]:checked').value, healAt: Number(f.healAt.value), style: f.querySelector('[name=style]:checked').value };
    try { const r = await api('/api/tactics', { body: { tactics } }); S.me.creature.tactics = r.tactics; $('coachMsg').textContent = 'Plan saved. It will fight this way from now on.'; }
    catch (err) { $('coachMsg').textContent = err.message; }
  });
}

// ---------- battle ----------
let speed = 1;
function initBattle() {
  battleStage = makeBattle($('battleCanvas'));
  $('fightBtn').addEventListener('click', async () => {
    const btn = $('fightBtn'); btn.disabled = true; $('battleMsg').textContent = 'Looking for a rival…';
    try {
      const out = await api('/api/battle', { body: {} });
      $('battleMsg').textContent = `vs @${out.b.handle}${out.b.bot ? ' (house bot)' : out.b.verified ? '' : ' (unverified)'}`;
      battleStage.play(out, 0, { speed, onDone: async (res) => {
        const won = res.winner === 0;
        $('battleMsg').textContent = `${won ? 'Won' : res.winner === null ? 'Draw' : 'Lost'} vs @${out.b.handle}. +${out.xp} XP, ${out.ranked ? `rating ${out.ratingDelta >= 0 ? '+' : ''}${out.ratingDelta}` : 'unranked'}${out.loot ? `, found ${ITEMS[out.loot].name}${out.lootNote === 'duplicate' ? ' (duplicate, +10 XP)' : ''}` : ''}.`;
        btn.disabled = false; await refresh(); renderBattleLog(); if (S.me.creature?.evolving) { location.hash = '#home'; }
      } });
    } catch (e) { $('battleMsg').textContent = e.message; btn.disabled = false; }
  });
  $('speedBtn').addEventListener('click', () => { speed = speed === 1 ? 2 : speed === 2 ? 4 : 1; $('speedBtn').textContent = 'Speed ×' + speed; battleStage.setSpeed(speed); });
  $('skipBtn').addEventListener('click', () => battleStage.skip());
}
async function renderBattleLog() {
  const c = S.me?.creature; if (!c) return;
  $('fightBtn').textContent = `Find a battle (−${c.battleEnergy} energy)`;
  const r = await api('/api/battles');
  $('battleDot').hidden = true;
  const ul = $('battleLog');
  if (!r.battles.length) { ul.innerHTML = '<li class="dim">No battles yet. Find one!</li>'; return; }
  ul.innerHTML = r.battles.map((b) => `<li><div><span class="res ${b.outcome}">${b.outcome === 'win' ? 'Won' : b.outcome === 'loss' ? 'Lost' : 'Draw'}</span> vs @${esc(b.opp_handle)}${b.opp_bot ? ' <span class="meta">bot</span>' : ''} ${b.side === 1 ? '<span class="meta">(they challenged you)</span>' : ''} ${b.seen === 0 ? '<span class="new">NEW</span>' : ''}
    <div class="meta">${new Date(b.at).toLocaleString()} · +${b.xp} XP${b.rating_delta ? ` · rating ${b.rating_delta > 0 ? '+' : ''}${b.rating_delta}` : ''}${b.loot ? ` · ${esc(ITEMS[b.loot.split(':')[0]]?.name || '')}` : ''}</div></div>
    <button class="btn ghost" type="button" data-replay="${esc(b.id)}">Replay</button></li>`).join('');
  ul.querySelectorAll('[data-replay]').forEach((btn: any) => btn.addEventListener('click', async () => {
    const rep = await api('/api/battles/' + encodeURIComponent(btn.dataset.replay));
    const loot = rep.side === 0 ? (r.battles.find((x) => x.id === rep.id)?.loot || '').split(':')[0] || null : null;
    $('battleMsg').textContent = `Replay vs @${rep.side === 0 ? rep.b.handle : rep.a.handle}`;
    battleStage.play({ ...rep, loot }, rep.side, { speed });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
}

// ---------- leaderboard ----------
function rankList(ol, players, ranked) {
  if (!players.length) { ol.innerHTML = `<li class="empty">${ranked ? 'No ranked players yet. Ranked play opens to GitHub accounts at least 30 days old.' : 'No one yet.'}</li>`; return; }
  ol.innerHTML = players.map((p, i) => `<li class="${p.handle === S.me.session.handle ? 'me' : ''}"><canvas data-i="${i}" aria-hidden="true"></canvas>
    <div><div class="nm">${esc(p.name)}</div><div class="hd">@${esc(p.handle)} ${p.verified ? '' : '<span class="badge warn">unverified</span>'} · Lv ${p.level} ${STAGE_NAMES[p.stage]}</div></div>
    <div><div class="rt">${ranked ? p.rating : p.wins + 'W'}</div><div class="wl">${ranked ? `${p.wins}W ${p.losses}L${p.draws ? ' ' + p.draws + 'D' : ''}` : `${p.losses}L · ${p.xp} XP`}</div></div></li>`).join('');
  ol.querySelectorAll('canvas').forEach((cv: any) => { const p = players[cv.dataset.i]; if (!p.seed) return; const g: any = { ...genome(p.seed) }; paintStatic(cv, spr(g, { stage: p.stage }), 48); });
}
async function renderRanks() {
  const r = await api('/api/leaderboard');
  rankList($('ranks'), r.players, true);
  rankList($('ranksU'), r.unranked || [], false);
}

// ---------- tokens ----------
async function renderTokens() {
  const r = await api('/api/tokens');
  const ul = $('tokenList');
  ul.innerHTML = r.tokens.length ? r.tokens.map((t) => `<li><div><span class="res">${esc(t.name)}</span><div class="meta">created ${new Date(t.created_at).toLocaleDateString()}${t.last_used ? ' · last used ' + new Date(t.last_used).toLocaleString() : ' · never used'}</div></div><button class="btn ghost" data-revoke="${esc(t.id)}" type="button">Revoke</button></li>`).join('') : '<li class="dim">No tokens yet.</li>';
  ul.querySelectorAll('[data-revoke]').forEach((b: any) => b.addEventListener('click', async () => { await api('/api/tokens/' + b.dataset.revoke, { method: 'DELETE' }); $('tokenOut').hidden = true; renderTokens(); }));
}
function initTokens() {
  $('tokenForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await api('/api/tokens', { body: { name: $('tokenName').value || 'API token' } }); $('tokenOut').hidden = false; $('tokenOut').textContent = `${r.token}\n\nShown once. Copy it now.`; $('tokenName').value = ''; renderTokens(); }
    catch (err) { $('tokenOut').hidden = false; $('tokenOut').textContent = err.message; }
  });
}

// ---------- live needs ----------
// Needs are derived from timestamps on the server; the client just re-reads now and then.
setInterval(async () => { if (S.view === 'home' && document.visibilityState === 'visible') { await refresh(); renderHome(); } }, 60000);

(async function main() {
  initLogin(); initHatch(); initCare(); initCoach(); initBattle(); initTokens();
  await refresh();
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();

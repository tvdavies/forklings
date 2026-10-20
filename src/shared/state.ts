// Pet needs and growth, worked out lazily from timestamps.
// Nothing ticks on the server: the stored state is a snapshot at `at`, and
// advance(state, now) integrates it forward whenever it is read or changed.

export interface PetState {
  at: number;          // ms timestamp the values below are valid for
  fullness: number;    // 0..100, falls over time
  mood: number;        // 0..100, drifts down, faster when hungry or tired
  energy: number;      // 0..100, recovers over time, faster while napping
  xp: number;          // growth points, never falls
  napUntil: number;    // ms; napping while now < napUntil
  stage: number;       // 0 Sprout, 1 Junior, 2 Prime (the stage the player has seen)
}

export const STAGE_XP = [0, 120, 480];   // XP needed to reach each stage
export const MAX_CATCHUP_MS = 30 * 24 * 3600 * 1000;
const STEP_MS = 5 * 60 * 1000;          // integrate in 5-minute steps
const H = 3600 * 1000;

export const RATES = {
  fullnessPerHour: -5,
  moodPerHour: -3,
  moodHungryPerHour: -8,   // extra when fullness < 25
  moodTiredPerHour: -3,    // extra when energy < 15
  energyPerHour: 8,
  energyNapPerHour: 60,
  xpPerHourContent: 4,     // passive growth while fed (>30) and content (>40)
};

export function newState(now: number): PetState {
  return { at: now, fullness: 70, mood: 70, energy: 80, xp: 0, napUntil: 0, stage: 0 };
}

const clamp = (v: number) => Math.max(0, Math.min(100, v));

/** Integrate the state forward to `now`. Pure and deterministic. */
export function advance(s: PetState, now: number): PetState {
  const out = { ...s };
  if (now <= s.at) return out;
  let t = s.at;
  const end = Math.min(now, s.at + MAX_CATCHUP_MS);
  while (t < end) {
    const dt = Math.min(STEP_MS, end - t);
    const h = dt / H;
    const napping = t < out.napUntil;
    out.fullness = clamp(out.fullness + RATES.fullnessPerHour * h);
    let dm = RATES.moodPerHour;
    if (out.fullness < 25) dm += RATES.moodHungryPerHour;
    if (out.energy < 15) dm += RATES.moodTiredPerHour;
    if (napping) dm = Math.max(dm, -1);
    out.mood = clamp(out.mood + dm * h);
    out.energy = clamp(out.energy + (napping ? RATES.energyNapPerHour : RATES.energyPerHour) * h);
    if (out.fullness > 30 && out.mood > 40) out.xp += RATES.xpPerHourContent * h;
    t += dt;
  }
  out.at = now;
  return out;
}

export function stageForXp(xp: number): number { return xp >= STAGE_XP[2] ? 2 : xp >= STAGE_XP[1] ? 1 : 0; }
export function levelForXp(xp: number): number { return Math.min(50, 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 6))); }
export function nextStageXp(stage: number): number | null { return stage >= 2 ? null : STAGE_XP[stage + 1]; }

export type CareAction = 'feed' | 'play' | 'pat' | 'nap';
export interface CareResult { state: PetState; ok: boolean; message: string; xpGain: number }

// Feeding is limited by fullness and play by energy, so only patting needs a cooldown.
export const COOLDOWNS: Record<CareAction, number> = { feed: 0, play: 0, pat: 30 * 1000, nap: 0 };

/** Apply a care action at `now` (state must already be advanced to `now`). */
export function care(s0: PetState, action: CareAction, now: number): CareResult {
  const s = { ...s0 };
  const napping = now < s.napUntil;
  if (napping && action !== 'nap') return { state: s, ok: false, message: 'Shh, napping. Wake it first.', xpGain: 0 };
  let xp = 0, message = '';
  switch (action) {
    case 'feed':
      if (s.fullness >= 95) return { state: s, ok: false, message: 'Not hungry right now.', xpGain: 0 };
      if (s.fullness < 70) xp = 6;
      s.fullness = clamp(s.fullness + 35); s.mood = clamp(s.mood + 5);
      message = xp ? 'Nom. That hit the spot.' : 'A little snack.';
      break;
    case 'play':
      if (s.energy < 12) return { state: s, ok: false, message: 'Too tired to play. Try a nap.', xpGain: 0 };
      s.energy = clamp(s.energy - 12); s.fullness = clamp(s.fullness - 6); s.mood = clamp(s.mood + 18); xp = 8;
      message = 'Zoomies!';
      break;
    case 'pat':
      s.mood = clamp(s.mood + 6); xp = s.mood < 90 ? 1 : 0;
      message = 'Happy wiggle.';
      break;
    case 'nap':
      if (napping) { s.napUntil = now; message = 'Awake and blinking.'; }
      else { s.napUntil = now + 20 * 60 * 1000; message = 'Curled up for a 20-minute nap.'; }
      break;
  }
  s.xp += xp;
  return { state: s, ok: true, message, xpGain: xp };
}

export function moodWord(s: PetState, now: number): string {
  if (now < s.napUntil) return 'napping';
  if (s.fullness < 20) return 'hungry';
  if (s.energy < 15) return 'sleepy';
  if (s.mood > 75) return 'delighted';
  if (s.mood > 45) return 'content';
  if (s.mood > 20) return 'grumpy';
  return 'sulking';
}

// Why a battle went the way it did, in one line for the result card.
// Pure: it reads the snapshots and the simulated result, so a replay gives the same reason.

import { type BattleResult, fighter, type Snapshot, strategyOf, typeMult } from './battle';
import { STAGE_NAMES } from './genome';

export type Outcome = 'win' | 'loss' | 'draw';
/** The next step the reason points at: change the plan, grow the pet, or just go again. */
export type Nudge = 'coach' | 'grow' | 'again';
export interface Verdict {
  outcome: Outcome;
  reason: string;
  nudge: Nudge;
}

interface SideStats {
  attacks: number;
  misses: number;
  crits: number;
  dealt: number;
  critDealt: number;
  heals: number;
  healed: number;
}

const pct = (hp: number, max: number) => Math.round((100 * hp) / max);

/** One reason for the result, from side `me`'s point of view (0 is the challenger). */
export function battleVerdict(a: Snapshot, b: Snapshot, res: BattleResult, me: 0 | 1 = 0): Verdict {
  const foe = (1 - me) as 0 | 1;
  const snaps = [a, b];
  const F = [fighter(a), fighter(b)];
  const mine = F[me],
    theirs = F[foe];
  const myName = mine.g.name,
    foeName = theirs.g.name;
  const myLv = snaps[me].level,
    foeLv = snaps[foe].level;

  const st: SideStats[] = [0, 1].map(() => ({ attacks: 0, misses: 0, crits: 0, dealt: 0, critDealt: 0, heals: 0, healed: 0 }));
  // My HP just before the last hit I took, to tell when a heal never had the chance to fire.
  let hpBeforeLastHit = 100;
  let prevHp = [res.maxHp[0], res.maxHp[1]];
  for (const e of res.events) {
    const s = st[e.who];
    if (e.kind === 'strike' || e.kind === 'special') {
      s.attacks++;
      if (e.miss) s.misses++;
      s.dealt += e.dmg;
      if (e.crit) {
        s.crits++;
        s.critDealt += e.dmg;
      }
      if (e.who === foe && !e.miss) hpBeforeLastHit = pct(prevHp[me], res.maxHp[me]);
    } else if (e.kind === 'heal') {
      s.heals++;
      s.healed += e.heal;
    }
    prevHp = e.hp;
  }
  const myEnd = pct(prevHp[me], res.maxHp[me]),
    foeEnd = pct(prevHp[foe], res.maxHp[foe]);
  const outcome: Outcome = res.winner === null ? 'draw' : res.winner === me ? 'win' : 'loss';
  const say = (reason: string, nudge: Nudge): Verdict => ({ outcome, reason, nudge });

  if (outcome === 'draw')
    return say(
      myEnd === foeEnd
        ? `Time ran out after ${res.rounds} rounds, with both on ${myEnd}% HP.`
        : `Time ran out after ${res.rounds} rounds. Nobody could finish it.`,
      'coach',
    );

  if (!res.events.some((e) => e.kind === 'faint'))
    return say(
      outcome === 'win'
        ? `Time ran out after ${res.rounds} rounds, and you had more HP left: ${myEnd}% to ${foeEnd}%.`
        : `Time ran out after ${res.rounds} rounds, and ${foeName} had more HP left: ${foeEnd}% to ${myEnd}%.`,
      outcome === 'win' ? 'again' : 'coach',
    );

  const typeEdge = typeMult(mine.g.type, theirs.g.type) > 1,
    typeWeak = typeMult(theirs.g.type, mine.g.type) > 1;
  const stageGap = snaps[foe].stage - snaps[me].stage;

  if (outcome === 'loss') {
    const s = st[me],
      o = st[foe];
    if (foeLv - myLv >= 2) return say(`${foeName} is Level ${foeLv}, you're Level ${myLv}.`, 'grow');
    const plansHeal = strategyOf(snaps[me]).rules.some((r) => r.do === 'heal');
    if (!plansHeal) return say(`Your plan never heals. Rollback gets back 28% HP, twice a fight.`, 'coach');
    if (s.heals === 0) return say(`Your heal never fired: ${myName} went from ${hpBeforeLastHit}% HP to 0 in one hit.`, 'coach');
    if (s.attacks >= 4 && s.misses >= 3 && s.misses / s.attacks >= 0.3)
      return say(
        `${s.misses} of your ${s.attacks} attacks missed.${strategyOf(snaps[me]).style === 'reckless' ? ' Reckless style misses more.' : ''}`,
        'coach',
      );
    if (o.crits >= 2 && o.critDealt >= 0.3 * o.dealt)
      return say(`${foeName} landed ${o.crits} critical hits for ${pct(o.critDealt, o.dealt)}% of its damage.`, 'again');
    if (typeWeak) return say(`${theirs.g.type} hits ${mine.g.type} 15% harder, and ${foeName} is ${theirs.g.type} type.`, 'again');
    if (stageGap > 0)
      return say(`${foeName} is a ${STAGE_NAMES[snaps[foe].stage]}. ${myName} is still a ${STAGE_NAMES[snaps[me].stage]}.`, 'grow');
    if (foeLv > myLv) return say(`${foeName} is a level ahead: Level ${foeLv} to your ${myLv}.`, 'grow');
    if (foeEnd <= 20) return say(`So close: ${foeName} had only ${foeEnd}% HP left.`, 'again');
    return say(`${foeName} out-damaged you ${o.dealt} to ${s.dealt}.`, 'coach');
  }

  const s = st[me],
    o = st[foe];
  if (myLv - foeLv >= 2) return say(`You're Level ${myLv}, ${foeName} is Level ${foeLv}.`, 'again');
  if (s.heals > 0 && myEnd < 50) return say(`Rollback won it: ${myName} healed ${s.healed} HP and finished on ${myEnd}%.`, 'again');
  if (s.crits >= 2 && s.critDealt >= 0.3 * s.dealt)
    return say(`${s.crits} critical hits did ${pct(s.critDealt, s.dealt)}% of your damage.`, 'again');
  if (typeEdge) return say(`${mine.g.type} hits ${theirs.g.type} 15% harder, and ${myName} is ${mine.g.type} type.`, 'again');
  if (o.attacks >= 4 && o.misses >= 3) return say(`${foeName} missed ${o.misses} of ${o.attacks} attacks.`, 'again');
  if (myEnd >= 70) return say(`A clean win: ${myName} kept ${myEnd}% of its HP.`, 'again');
  return say(`You out-damaged ${foeName} ${s.dealt} to ${o.dealt}.`, 'again');
}

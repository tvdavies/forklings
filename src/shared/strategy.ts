// The one strategy form every battle runs on. Coaching tactics (sliders and
// choices) compile to it, and so will hand-written strategy scripts: both become
// an ordered list of rules whose conditions are a small expression AST.
// The interpreter has a fuel budget per decision and never evaluates code.

export type Action = 'strike' | 'special' | 'guard' | 'heal';
export type Style = 'steady' | 'balanced' | 'reckless';
export type Var = 'hp' | 'foe_hp' | 'turn' | 'heals_left' | 'foe_heals_left' | 'level' | 'foe_level';
export type Val = { num: number } | { var: Var };
export type Expr =
  | { op: 'and' | 'or'; a: Expr; b: Expr }
  | { op: 'not'; a: Expr }
  | { op: '<' | '<=' | '>' | '>=' | '==' | '!='; a: Val; b: Val }
  | { op: 'chance'; p: number }               // consumes one random number from the battle RNG
  | { op: 'ready'; move: 'special' | 'heal' } // the move can be used this turn
  | { op: 'focused' }                          // last action was a guard (next attack is powered up)
  | { op: 'foe_guarding' }
  | { op: 'true' };
export interface Rule { when: Expr; do: Action }
export interface Strategy { v: 1; source: 'tactics' | 'script'; style: Style; rules: Rule[] }

export interface Tactics {
  aggression: number;                    // 0..100: attack rather than guard
  special: 'open' | 'save';              // lead with the signature move, or save it to finish
  healAt: number;                        // 0, 25, 40 or 60: HP percentage that triggers Rollback
  style: Style;
}
export const DEFAULT_TACTICS: Tactics = { aggression: 60, special: 'open', healAt: 25, style: 'balanced' };

export function sanitiseTactics(t: any): Tactics {
  const a = Math.round(Number(t?.aggression));
  return {
    aggression: Number.isFinite(a) ? Math.max(0, Math.min(100, a)) : DEFAULT_TACTICS.aggression,
    special: t?.special === 'save' ? 'save' : 'open',
    healAt: [0, 25, 40, 60].includes(Number(t?.healAt)) ? Number(t.healAt) : DEFAULT_TACTICS.healAt,
    style: ['steady', 'balanced', 'reckless'].includes(t?.style) ? t.style : 'balanced',
  };
}

const lt = (v: Var, n: number): Expr => ({ op: '<', a: { var: v }, b: { num: n } });

/** Compile coaching tactics into rules. Order matters: first matching, usable rule wins. */
export function compileTactics(t: Tactics): Strategy {
  const rules: Rule[] = [];
  if (t.healAt > 0) rules.push({ when: lt('hp', t.healAt), do: 'heal' });
  if (t.special === 'open') rules.push({ when: { op: 'true' }, do: 'special' });
  else rules.push({ when: { op: 'or', a: lt('foe_hp', 35), b: lt('hp', 25) }, do: 'special' });
  rules.push({ when: { op: 'focused' }, do: 'strike' });
  rules.push({ when: { op: 'chance', p: t.aggression }, do: 'strike' });
  rules.push({ when: { op: 'true' }, do: 'guard' });
  return { v: 1, source: 'tactics', style: t.style, rules };
}

export interface Ctx {
  hp: number; foe_hp: number; turn: number; heals_left: number; foe_heals_left: number; level: number; foe_level: number;
  specialReady: boolean; focused: boolean; foeGuarding: boolean; rng: () => number;
}
export const FUEL_PER_DECISION = 256;
export const MAX_RULES = 32;

class OutOfFuel extends Error {}

/** Pick an action. Unusable actions (special on cooldown, no heals left) fall through to the next rule. */
export function decide(s: Strategy, c: Ctx): { action: Action; rule: number } {
  let fuel = FUEL_PER_DECISION;
  const val = (v: Val) => { if (--fuel < 0) throw new OutOfFuel(); return 'num' in v ? v.num : (c as any)[v.var] as number; };
  const ev = (e: Expr): boolean => {
    if (--fuel < 0) throw new OutOfFuel();
    switch (e.op) {
      case 'true': return true;
      case 'and': return ev(e.a) && ev(e.b);
      case 'or': return ev(e.a) || ev(e.b);
      case 'not': return !ev(e.a);
      case '<': return val(e.a) < val(e.b);
      case '<=': return val(e.a) <= val(e.b);
      case '>': return val(e.a) > val(e.b);
      case '>=': return val(e.a) >= val(e.b);
      case '==': return val(e.a) === val(e.b);
      case '!=': return val(e.a) !== val(e.b);
      case 'chance': return c.rng() * 100 < e.p;
      case 'ready': return e.move === 'special' ? c.specialReady : c.heals_left > 0;
      case 'focused': return c.focused;
      case 'foe_guarding': return c.foeGuarding;
      default: return false;
    }
  };
  const usable = (a: Action) => (a === 'special' ? c.specialReady : a === 'heal' ? c.heals_left > 0 : true);
  try {
    const rules = s.rules.slice(0, MAX_RULES);
    for (let i = 0; i < rules.length; i++) if (usable(rules[i].do) && ev(rules[i].when)) return { action: rules[i].do, rule: i };
  } catch (e) { if (!(e instanceof OutOfFuel)) throw e; }
  return { action: 'strike', rule: -1 };
}

/** Validate an untrusted strategy object (from an API client) into a safe one. */
export function sanitiseStrategy(x: any): Strategy | null {
  if (!x || !Array.isArray(x.rules) || x.rules.length > MAX_RULES) return null;
  const VARS = ['hp', 'foe_hp', 'turn', 'heals_left', 'foe_heals_left', 'level', 'foe_level'];
  let nodes = 0;
  const v = (q: any): Val => { if (q && typeof q.num === 'number' && Number.isFinite(q.num)) return { num: q.num }; if (q && VARS.includes(q.var)) return { var: q.var }; throw 0; };
  const e = (q: any, d: number): Expr => {
    if (++nodes > 400 || d > 12 || !q) throw 0;
    switch (q.op) {
      case 'true': case 'focused': case 'foe_guarding': return { op: q.op };
      case 'and': case 'or': return { op: q.op, a: e(q.a, d + 1), b: e(q.b, d + 1) };
      case 'not': return { op: 'not', a: e(q.a, d + 1) };
      case '<': case '<=': case '>': case '>=': case '==': case '!=': return { op: q.op, a: v(q.a), b: v(q.b) };
      case 'chance': { const p = Number(q.p); if (!Number.isFinite(p)) throw 0; return { op: 'chance', p: Math.max(0, Math.min(100, p)) }; }
      case 'ready': if (q.move !== 'special' && q.move !== 'heal') throw 0; return { op: 'ready', move: q.move };
    }
    throw 0;
  };
  try {
    const rules = x.rules.map((r: any) => { if (!['strike', 'special', 'guard', 'heal'].includes(r?.do)) throw 0; return { when: e(r.when, 0), do: r.do }; });
    return { v: 1, source: x.source === 'script' ? 'script' : 'tactics', style: ['steady', 'balanced', 'reckless'].includes(x.style) ? x.style : 'balanced', rules };
  } catch { return null; }
}

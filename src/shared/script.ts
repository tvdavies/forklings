// Forkling strategy scripts: a tiny rule language with a hand-written tokenizer and
// recursive-descent parser. A script compiles to the same Strategy AST that coaching
// tactics compile to, and the same fuel-limited interpreter runs it. Nothing is ever
// evaluated as code.
//
//   # Heal early, finish with the special, otherwise press the attack.
//   style steady
//   when hp < 40 and ready heal: heal
//   when foe_hp < 35: special
//   when focused or foe_guarding: strike
//   when chance 70: strike
//   otherwise: guard
//
// Rules are tried top to bottom. The first rule whose condition holds and whose
// action can be used this turn wins. If none does, the Forkling strikes.
import {
  type Action,
  compileTactics,
  type Expr,
  MAX_RULES,
  type Strategy,
  type Style,
  sanitiseStrategy,
  type Tactics,
  type Val,
  type Var,
} from './strategy';

export const MAX_SCRIPT_CHARS = 4000;
const VARS: readonly Var[] = ['hp', 'foe_hp', 'turn', 'heals_left', 'foe_heals_left', 'level', 'foe_level'];
const ACTIONS: readonly Action[] = ['strike', 'special', 'guard', 'heal'];
const STYLES: readonly Style[] = ['steady', 'balanced', 'reckless'];
const CMPS = ['<', '<=', '>', '>=', '==', '!='] as const;
type Cmp = (typeof CMPS)[number];

export class ScriptError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(`line ${line}, column ${col}: ${message}`);
  }
}

interface Tok {
  t: 'word' | 'num' | 'op' | 'eol';
  v: string;
  line: number;
  col: number;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const lines = src.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const s = lines[ln];
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      const col = i + 1;
      if (ch === ' ' || ch === '\t') {
        i++;
        continue;
      }
      if (ch === '#') break;
      if (/[a-z_]/i.test(ch)) {
        let j = i;
        while (j < s.length && /[a-z0-9_]/i.test(s[j])) j++;
        out.push({ t: 'word', v: s.slice(i, j).toLowerCase(), line: ln + 1, col });
        i = j;
        continue;
      }
      if (/[0-9]/.test(ch)) {
        let j = i;
        while (j < s.length && /[0-9.]/.test(s[j])) j++;
        const v = s.slice(i, j);
        if (!/^\d+(\.\d+)?$/.test(v)) throw new ScriptError(`"${v}" isn't a number`, ln + 1, col);
        out.push({ t: 'num', v, line: ln + 1, col });
        i = j;
        continue;
      }
      const two = s.slice(i, i + 2);
      if (['<=', '>=', '==', '!='].includes(two)) {
        out.push({ t: 'op', v: two, line: ln + 1, col });
        i += 2;
        continue;
      }
      if ('<>():'.includes(ch)) {
        out.push({ t: 'op', v: ch, line: ln + 1, col });
        i++;
        continue;
      }
      throw new ScriptError(`unexpected "${ch}"`, ln + 1, col);
    }
    out.push({ t: 'eol', v: '', line: ln + 1, col: s.length + 1 });
  }
  return out;
}

/** Parse a script into a validated Strategy, or throw a ScriptError that points at the problem. */
export function parseScript(src: string): Strategy {
  if (src.length > MAX_SCRIPT_CHARS) throw new ScriptError(`scripts are limited to ${MAX_SCRIPT_CHARS} characters`, 1, 1);
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const fail = (msg: string, t: Tok = peek()): never => {
    throw new ScriptError(msg, t.line, t.col);
  };
  const isWord = (v: string) => peek().t === 'word' && peek().v === v;
  const expectOp = (v: string) => {
    const t = next();
    if (t.t !== 'op' || t.v !== v) fail(`expected "${v}"`, t);
  };

  const val = (): Val => {
    const t = next();
    if (t.t === 'num') return { num: Number(t.v) };
    if (t.t === 'word' && (VARS as readonly string[]).includes(t.v)) return { var: t.v as Var };
    return fail(`expected a number or one of ${VARS.join(', ')}`, t);
  };
  const atom = (): Expr => {
    const t = peek();
    if (t.t === 'op' && t.v === '(') {
      next();
      if (++depth > 12) fail('too deeply nested', t);
      const e = or();
      depth--;
      expectOp(')');
      return e;
    }
    if (t.t === 'word') {
      switch (t.v) {
        case 'true':
        case 'always':
          next();
          return { op: 'true' };
        case 'focused':
          next();
          return { op: 'focused' };
        case 'foe_guarding':
          next();
          return { op: 'foe_guarding' };
        case 'chance': {
          next();
          const n = next();
          if (n.t !== 'num' || Number(n.v) > 100) fail('chance takes a percentage from 0 to 100', n);
          return { op: 'chance', p: Number(n.v) };
        }
        case 'ready': {
          next();
          const m = next();
          if (m.t !== 'word' || (m.v !== 'special' && m.v !== 'heal')) fail('ready takes "special" or "heal"', m);
          return { op: 'ready', move: m.v as 'special' | 'heal' };
        }
      }
    }
    const a = val();
    const op = next();
    if (op.t !== 'op' || !(CMPS as readonly string[]).includes(op.v)) fail('expected a comparison: < <= > >= == !=', op);
    return { op: op.v as Cmp, a, b: val() };
  };
  const not = (): Expr => {
    if (!isWord('not')) return atom();
    next();
    return { op: 'not', a: not() };
  };
  const and = (): Expr => {
    let e = not();
    while (isWord('and')) {
      next();
      e = { op: 'and', a: e, b: not() };
    }
    return e;
  };
  const or = (): Expr => {
    let e = and();
    while (isWord('or')) {
      next();
      e = { op: 'or', a: e, b: and() };
    }
    return e;
  };

  let style: Style = 'balanced';
  const rules: Strategy['rules'] = [];
  while (p < toks.length) {
    const t = peek();
    if (t.t === 'eol') {
      next();
      continue;
    }
    if (isWord('style')) {
      next();
      const s = next();
      if (s.t !== 'word' || !(STYLES as readonly string[]).includes(s.v)) fail(`style is one of ${STYLES.join(', ')}`, s);
      style = s.v as Style;
    } else if (isWord('when') || isWord('otherwise')) {
      const cond = next().v === 'when' ? or() : ({ op: 'true' } as Expr);
      expectOp(':');
      const a = next();
      if (a.t !== 'word' || !(ACTIONS as readonly string[]).includes(a.v)) fail(`expected an action: ${ACTIONS.join(', ')}`, a);
      rules.push({ when: cond, do: a.v as Action });
      if (rules.length > MAX_RULES) fail(`at most ${MAX_RULES} rules`, t);
    } else fail('a line starts with "when", "otherwise" or "style"');
    if (peek().t !== 'eol') fail('unexpected text at the end of the line');
  }
  if (!rules.length) throw new ScriptError('the script has no rules', 1, 1);
  const s = sanitiseStrategy({ v: 1, source: 'script', style, rules });
  if (!s) throw new ScriptError('the script is too large', 1, 1);
  return s;
}

const valText = (v: Val) => ('num' in v ? String(v.num) : v.var);
function exprText(e: Expr, parent: 'and' | 'or' | 'not' | null = null): string {
  switch (e.op) {
    case 'true':
      return 'always';
    case 'focused':
    case 'foe_guarding':
      return e.op;
    case 'chance':
      return `chance ${e.p}`;
    case 'ready':
      return `ready ${e.move}`;
    case 'not':
      return `not ${exprText(e.a, 'not')}`;
    case 'and':
    case 'or': {
      const s = `${exprText(e.a, e.op)} ${e.op} ${exprText(e.b, e.op)}`;
      return parent && parent !== e.op ? `(${s})` : s;
    }
    default:
      return `${valText(e.a)} ${e.op} ${valText(e.b)}`;
  }
}

/** Render a strategy as script text. parseScript(formatStrategy(s)) gives back the same rules. */
export function formatStrategy(s: Strategy): string {
  const lines = [`style ${s.style}`];
  for (const r of s.rules) lines.push(r.when.op === 'true' ? `otherwise: ${r.do}` : `when ${exprText(r.when)}: ${r.do}`);
  return `${lines.join('\n')}\n`;
}

/** The script equivalent of coaching tactics, as a starting point for editing. */
export function tacticsAsScript(t: Tactics): string {
  return formatStrategy(compileTactics(t));
}

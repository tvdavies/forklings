import { describe, expect, test } from 'bun:test';
import { formatStrategy, MAX_SCRIPT_CHARS, parseScript, ScriptError, tacticsAsScript } from '../../src/shared/script';
import { compileTactics, DEFAULT_TACTICS, decide, MAX_RULES } from '../../src/shared/strategy';

const ctx = (o: Record<string, unknown> = {}) => ({
  hp: 100,
  foe_hp: 100,
  turn: 1,
  heals_left: 2,
  foe_heals_left: 2,
  level: 1,
  foe_level: 1,
  specialReady: true,
  focused: false,
  foeGuarding: false,
  rng: () => 0.5,
  ...o,
});

const SAMPLE = `# Heal early, finish with the special.
style steady
when hp < 40 and ready heal: heal
when foe_hp < 35: special
when focused or foe_guarding: strike
when chance 70: strike   # mostly attack
otherwise: guard
`;

describe('strategy scripts', () => {
  test('parse into rules the interpreter runs', () => {
    const s = parseScript(SAMPLE);
    expect(s.source).toBe('script');
    expect(s.style).toBe('steady');
    expect(s.rules.map((r) => r.do)).toEqual(['heal', 'special', 'strike', 'strike', 'guard']);
    expect(decide(s, ctx({ hp: 30 })).action).toBe('heal');
    expect(decide(s, ctx({ hp: 30, heals_left: 0, foe_hp: 20 })).action).toBe('special');
    expect(decide(s, ctx({ foeGuarding: true })).action).toBe('strike');
    expect(decide(s, ctx({ rng: () => 0.9 })).action).toBe('guard');
  });

  test('precedence: not binds tighter than and, and tighter than or', () => {
    const s = parseScript('when not focused and hp < 50 or turn > 10: guard');
    expect(s.rules[0].when).toEqual({
      op: 'or',
      a: { op: 'and', a: { op: 'not', a: { op: 'focused' } }, b: { op: '<', a: { var: 'hp' }, b: { num: 50 } } },
      b: { op: '>', a: { var: 'turn' }, b: { num: 10 } },
    });
  });

  test('format and parse round-trip', () => {
    for (const src of [SAMPLE, 'when (hp < 50 or foe_hp > 80) and not foe_guarding: special\notherwise: strike']) {
      const s = parseScript(src);
      expect(parseScript(formatStrategy(s))).toEqual(s);
    }
  });

  test('tactics have an equivalent script', () => {
    const t = { ...DEFAULT_TACTICS, special: 'save' as const, healAt: 40 };
    expect(parseScript(tacticsAsScript(t)).rules).toEqual(compileTactics(t).rules);
  });

  test('errors point at the line and column', () => {
    const cases: [string, number, number][] = [
      ['when hp < : heal', 1, 11],
      ['otherwise: dance', 1, 12],
      ['\nwhen hp < 30 heal', 2, 14],
      ['when chance 150: strike', 1, 13],
      ['style chaotic', 1, 7],
      ['attack!', 1, 7],
      ['attack now', 1, 1],
      ['when hp < 3$: heal', 1, 12],
      ['when constructor < 1: heal', 1, 6],
    ];
    for (const [src, line, col] of cases) {
      try {
        parseScript(src);
        throw new Error(`parsed: ${src}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ScriptError);
        expect([(e as ScriptError).line, (e as ScriptError).col]).toEqual([line, col]);
      }
    }
  });

  test('limits: length, rule count, nesting, empty scripts', () => {
    expect(() => parseScript('#'.repeat(MAX_SCRIPT_CHARS + 1))).toThrow(ScriptError);
    expect(() => parseScript('otherwise: strike\n'.repeat(MAX_RULES + 1))).toThrow(/at most/);
    expect(() => parseScript(`when ${'('.repeat(20)}hp < 1${')'.repeat(20)}: heal`)).toThrow(/nested/);
    expect(() => parseScript('# nothing here')).toThrow(/no rules/);
  });

  test('never evaluates input as code', () => {
    for (const src of [
      'when process.exit(1): strike',
      'when hp < 1; globalThis.x = 1: strike',
      'when `x`: strike',
      "when hp < eval('1'): strike",
    ])
      expect(() => parseScript(src)).toThrow(ScriptError);
  });
});

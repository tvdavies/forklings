// Small helpers for reading untrusted JSON (request bodies, MCP arguments, strategies
// from API clients) as `unknown` and narrowing it, instead of reaching for `any`.

/** Any non-null object, arrays included: the values a JSON property read can find something on. */
export const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

/** `x?.[k]` for an untrusted value: the property when `x` is an object, otherwise undefined. */
export const prop = (x: unknown, k: string): unknown => (isRecord(x) ? x[k] : undefined);

/** Whether `v` is one of the allowed values (compared as `Array.prototype.includes` does). */
export const oneOf = <T>(allowed: readonly T[], v: unknown): v is T => (allowed as readonly unknown[]).includes(v);

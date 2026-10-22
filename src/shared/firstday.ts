// The first-day checklist on Home: four things a new player should do, ticked off as
// they happen through any client (web, JSON API or MCP), and a starter item when all
// four are done. The player's Durable Object stores the record; everything here is pure.

export const FIRST_DAY_STEPS = ['feed', 'dress', 'plan', 'win'] as const;
export type FirstDayStep = (typeof FIRST_DAY_STEPS)[number];

/** Given in this order: the first one the player doesn't already own. All cosmetic, so no battle edge. */
export const FIRST_DAY_REWARDS = ['scarf', 'bowtie', 'party'];

/** Stored per player. Times are ms timestamps. */
export interface FirstDay {
  done: Partial<Record<FirstDayStep, number>>;
  /** When the last step was ticked. */
  completedAt?: number;
  /** The item given on completion, or null if the player already owned every reward. */
  reward?: string | null;
  /** The player closed the card before finishing; it stays hidden until they finish. */
  closedAt?: number;
  /** The player closed the finished card; it never shows again. */
  seenAt?: number;
}

/** What the client gets: null when the card shouldn't show. */
export interface FirstDayView {
  steps: Record<FirstDayStep, boolean>;
  complete: boolean;
  reward: string | null;
}

/** What an existing player has already done, for a record created after they hatched. */
export interface FirstDayHistory {
  fed: boolean;
  dressed: boolean;
  planned: boolean;
  won: boolean;
}

export const isComplete = (fd: FirstDay) => FIRST_DAY_STEPS.every((s) => fd.done[s] !== undefined);

/** A new record, with any steps the player's history already covers ticked at `now`. */
export function startFirstDay(h: FirstDayHistory, now: number): FirstDay {
  const done: FirstDay['done'] = {};
  if (h.fed) done.feed = now;
  if (h.dressed) done.dress = now;
  if (h.planned) done.plan = now;
  if (h.won) done.win = now;
  return { done };
}

/** Tick a step. Ticking a step that's already done returns the same record. */
export function tickStep(fd: FirstDay, step: FirstDayStep, now: number): FirstDay {
  if (fd.done[step] !== undefined) return fd;
  return { ...fd, done: { ...fd.done, [step]: now } };
}

/** True once every step is done and the reward hasn't been given yet: the caller gives it, then calls `rewarded`. */
export function needsReward(fd: FirstDay): boolean {
  return isComplete(fd) && fd.reward === undefined;
}

export function rewarded(fd: FirstDay, reward: string | null, now: number): FirstDay {
  return { ...fd, reward, completedAt: fd.completedAt ?? now };
}

export function rewardFor(owned: Iterable<string>): string | null {
  const have = new Set(owned);
  return FIRST_DAY_REWARDS.find((id) => !have.has(id)) ?? null;
}

/** Close the card: before the list is done it hides the list, after it acknowledges the reward. */
export function closeFirstDay(fd: FirstDay, now: number): FirstDay {
  if (isComplete(fd)) return fd.seenAt ? fd : { ...fd, seenAt: now };
  return fd.closedAt ? fd : { ...fd, closedAt: now };
}

export function firstDayView(fd: FirstDay): FirstDayView | null {
  const complete = isComplete(fd);
  if (complete ? fd.seenAt !== undefined : fd.closedAt !== undefined) return null;
  const steps = Object.fromEntries(FIRST_DAY_STEPS.map((s) => [s, fd.done[s] !== undefined])) as Record<FirstDayStep, boolean>;
  return { steps, complete, reward: complete ? (fd.reward ?? null) : null };
}

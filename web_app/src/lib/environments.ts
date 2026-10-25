/**
 * Environments and playstyles, both picked once by the host when creating a game.
 *
 * The environment is a soft anchor for the riddle answer: a common physical item
 * that plausibly exists in that space. The example objects go to the model as
 * flavor only. "Choose from this list" would cap variety and "you are not
 * restricted" invites weird items nobody has in the room (see gemini_riddle.h).
 *
 * A playstyle is a per-turn distribution of proof methods. The method is rolled here
 * in code and sent to the board as an input, so the mix is genuinely random rather
 * than left to the model.
 */

export type EnvironmentId =
  | 'classroom'
  | 'office'
  | 'kitchen'
  | 'living'
  | 'dorm'
  | 'house';

export interface EnvironmentDef {
  id: EnvironmentId;
  name: string;
  /** flavor examples for the model (an anchor, not a whitelist) */
  examples: string;
}

export const ENVIRONMENTS: EnvironmentDef[] = [
  {
    id: 'classroom',
    name: 'Classroom & Lab',
    examples:
      'pens, erasers, notebooks, water bottles, cables, student IDs, highlighters, calculators, glasses',
  },
  {
    id: 'office',
    name: 'Office & Workspace',
    examples:
      'computer mice, sticky notes, staplers, paperclips, USB drives, lanyards, coffee mugs, chargers',
  },
  {
    id: 'kitchen',
    name: 'Kitchen & Dining',
    examples:
      'spoons, forks, cups, paper napkins, apples, small plates, tea bags, dish sponges',
  },
  {
    id: 'living',
    name: 'Living Room',
    examples:
      'TV remotes, books, house keys, coins, coasters, phone cases, small cushions, board game pieces',
  },
  {
    id: 'dorm',
    name: 'Dorm & Bedroom',
    examples:
      'hairbrushes, hats, wallets, slippers, alarm clocks, socks, headphones, chargers',
  },
  {
    id: 'house',
    name: 'Full House',
    examples:
      'spoons, forks, cups, paper napkins, apples, tea bags, dish sponges, TV remotes, books, house keys, coins, coasters, phone cases, board game pieces, hairbrushes, hats, wallets, slippers, alarm clocks, socks, headphones, chargers',
  },
];

export const ENVIRONMENT_MAP: Record<EnvironmentId, EnvironmentDef> =
  Object.fromEntries(ENVIRONMENTS.map((e) => [e.id, e])) as Record<
    EnvironmentId,
    EnvironmentDef
  >;

export type ProofMethodId = 'object' | 'sketch' | 'gesture' | 'cipher';

/** Names exactly as the firmware prompt and the DB expect them. */
export const PROOF_METHOD_NAMES: Record<ProofMethodId, string> = {
  object: 'Object Match',
  sketch: 'Sketch Proof',
  gesture: 'Body Gestures',
  cipher: 'Handwritten Cipher',
};

export interface PlaystyleDef {
  id: string;
  name: string;
  desc: string;
  /** per-turn proof-method distribution; percentages must sum to 100 */
  distribution: Array<{ method: ProofMethodId; pct: number }>;
}

export const PLAYSTYLES: PlaystyleDef[] = [
  {
    id: 'full',
    name: 'Full Experience',
    desc: 'Recommended default — a bit of everything',
    distribution: [
      { method: 'object', pct: 50 },
      { method: 'sketch', pct: 30 },
      { method: 'gesture', pct: 10 },
      { method: 'cipher', pct: 10 },
    ],
  },
  {
    id: 'hunt',
    name: 'Physical Hunt Mode',
    desc: 'High energy — mostly grab-and-show objects',
    distribution: [
      { method: 'object', pct: 80 },
      { method: 'gesture', pct: 20 },
    ],
  },
  {
    id: 'tabletop',
    name: 'Tabletop Brainiac',
    desc: 'Low movement — draw, write and puzzle at the table',
    distribution: [
      { method: 'sketch', pct: 50 },
      { method: 'cipher', pct: 30 },
      { method: 'gesture', pct: 20 },
    ],
  },
];

export const PLAYSTYLE_MAP: Record<string, PlaystyleDef> = Object.fromEntries(
  PLAYSTYLES.map((p) => [p.id, p]),
);

export const DEFAULT_PLAYSTYLE_ID = 'full';

/** Roll one proof method for a turn from the playstyle's distribution. */
export function pickProofMethod(playstyleId?: string | null): ProofMethodId {
  const style = PLAYSTYLE_MAP[playstyleId ?? ''] ?? PLAYSTYLE_MAP[DEFAULT_PLAYSTYLE_ID];
  const roll = Math.random() * 100;
  let acc = 0;
  for (const { method, pct } of style.distribution) {
    acc += pct;
    if (roll < acc) return method;
  }
  return style.distribution[0]?.method ?? 'object';
}

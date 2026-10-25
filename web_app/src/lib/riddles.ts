/**
 * Static riddle bank for demo rooms only (no board, no LLM). Real games get every
 * riddle from the board. Each answer is an object a player can grab and show to
 * the camera within the turn timer.
 */

import type { Difficulty, ProofMethod, Riddle, ThemeDef, ThemeId } from './types';

export const THEMES: ThemeDef[] = [
  { id: 'everyday', name: 'Everyday Objects' },
  { id: 'food', name: 'Food & Kitchen' },
  { id: 'nature', name: 'Nature & Plants' },
  { id: 'clothes', name: 'Clothes & Accessories' },
  { id: 'tech', name: 'Tech & Gadgets' },
  { id: 'hobbies', name: 'Toys & Hobbies' },
  { id: 'tools', name: 'Tools & Stationery' },
  { id: 'furniture', name: 'Furniture & Decor' },
];

export const THEME_MAP: Record<ThemeId, ThemeDef> = Object.fromEntries(
  THEMES.map((t) => [t.id, t]),
) as Record<ThemeId, ThemeDef>;

export const RIDDLE_BANK: Riddle[] = [
  // Everyday Objects
  { id: 'ev-book', theme: 'everyday', difficulty: 'Easy', text: 'I hold a thousand stories but never speak a word.', target_keyword: 'book', proof_method: 'Object Match' },
  { id: 'ev-mirror', theme: 'everyday', difficulty: 'Medium', text: 'I reflect your image but hold no memory of it.', target_keyword: 'mirror', proof_method: 'Object Match' },
  { id: 'ev-candle', theme: 'everyday', difficulty: 'Medium', text: 'I weep wax tears as I slowly disappear.', target_keyword: 'candle', proof_method: 'Object Match' },
  { id: 'ev-umbrella', theme: 'everyday', difficulty: 'Easy', text: 'Open me up when the sky starts to cry.', target_keyword: 'umbrella', proof_method: 'Object Match' },
  { id: 'ev-clock', theme: 'everyday', difficulty: 'Easy', text: 'I have a face and hands but no legs or feet.', target_keyword: 'clock', proof_method: 'Object Match' },
  { id: 'ev-key', theme: 'everyday', difficulty: 'Easy', text: 'I am small and metal, and I open what is closed.', target_keyword: 'key', proof_method: 'Object Match' },
  { id: 'ev-toothbrush', theme: 'everyday', difficulty: 'Easy', text: 'I fight cavities twice a day without leaving your bathroom.', target_keyword: 'toothbrush', proof_method: 'Object Match' },
  { id: 'ev-bottle', theme: 'everyday', difficulty: 'Medium', text: 'I carry a waterfall wherever you wander.', target_keyword: 'water bottle', proof_method: 'Object Match' },

  // Food & Kitchen
  { id: 'fd-egg', theme: 'food', difficulty: 'Easy', text: 'I crack under pressure yet I am breakfast’s best friend.', target_keyword: 'egg', proof_method: 'Object Match' },
  { id: 'fd-banana', theme: 'food', difficulty: 'Easy', text: 'I wear a yellow jacket and monkeys adore me.', target_keyword: 'banana', proof_method: 'Object Match' },
  { id: 'fd-mug', theme: 'food', difficulty: 'Medium', text: 'I turn hot water into liquid courage for Monday mornings.', target_keyword: 'mug', proof_method: 'Object Match' },
  { id: 'fd-toaster', theme: 'food', difficulty: 'Medium', text: 'Bread goes in, and I make it jump for joy.', target_keyword: 'toaster', proof_method: 'Object Match' },
  { id: 'fd-kettle', theme: 'food', difficulty: 'Medium', text: 'I sing a steamy song right before the tea party.', target_keyword: 'kettle', proof_method: 'Object Match' },
  { id: 'fd-salt', theme: 'food', difficulty: 'Easy', text: 'I am white, grainy, and I make dinner taste like magic.', target_keyword: 'salt', proof_method: 'Object Match' },
  { id: 'fd-apple', theme: 'food', difficulty: 'Easy', text: 'One of me a day keeps the doctor away.', target_keyword: 'apple', proof_method: 'Object Match' },
  { id: 'fd-fridge', theme: 'food', difficulty: 'Hard', text: 'I am the coldest library, keeping food on my shelves.', target_keyword: 'refrigerator', proof_method: 'Object Match' },

  // Nature & Plants
  { id: 'nt-plant', theme: 'nature', difficulty: 'Easy', text: 'I drink water through my roots and dress in green.', target_keyword: 'plant', proof_method: 'Object Match' },
  { id: 'nt-flower', theme: 'nature', difficulty: 'Easy', text: 'I wear perfume I cannot smell and petals I cannot feel.', target_keyword: 'flower', proof_method: 'Object Match' },
  { id: 'nt-leaf', theme: 'nature', difficulty: 'Easy', text: 'I am nature’s tiny solar panel, green and veined.', target_keyword: 'leaf', proof_method: 'Object Match' },
  { id: 'nt-pinecone', theme: 'nature', difficulty: 'Medium', text: 'I am a tree’s armored treasure, full of seeds in scales.', target_keyword: 'pinecone', proof_method: 'Object Match' },
  { id: 'nt-stone', theme: 'nature', difficulty: 'Medium', text: 'I am hard as my own history, older than your grandparents.', target_keyword: 'stone', proof_method: 'Object Match' },
  { id: 'nt-shell', theme: 'nature', difficulty: 'Medium', text: 'Once a sea house, now I listen to your ear.', target_keyword: 'seashell', proof_method: 'Object Match' },

  // Clothes & Accessories
  { id: 'cl-shoe', theme: 'clothes', difficulty: 'Easy', text: 'I walk thousands of miles yet never leave your feet.', target_keyword: 'shoe', proof_method: 'Object Match' },
  { id: 'cl-cap', theme: 'clothes', difficulty: 'Easy', text: 'I sit on your head and shield your eyes from the sun.', target_keyword: 'cap', proof_method: 'Object Match' },
  { id: 'cl-scarf', theme: 'clothes', difficulty: 'Easy', text: 'I hug your neck in winter without any arms.', target_keyword: 'scarf', proof_method: 'Object Match' },
  { id: 'cl-sock', theme: 'clothes', difficulty: 'Easy', text: 'I come in pairs but always seem to lose my twin.', target_keyword: 'sock', proof_method: 'Object Match' },
  { id: 'cl-belt', theme: 'clothes', difficulty: 'Medium', text: 'I keep your pants up and have a buckle for a mouth.', target_keyword: 'belt', proof_method: 'Object Match' },
  { id: 'cl-glasses', theme: 'clothes', difficulty: 'Medium', text: 'I bring the world into focus and sit on your nose.', target_keyword: 'glasses', proof_method: 'Object Match' },

  // Tech & Gadgets
  { id: 'tc-phone', theme: 'tech', difficulty: 'Easy', text: 'I know all your secrets and live in your pocket.', target_keyword: 'smartphone', proof_method: 'Object Match' },
  { id: 'tc-remote', theme: 'tech', difficulty: 'Easy', text: 'I control what you watch but hide under the couch.', target_keyword: 'remote control', proof_method: 'Object Match' },
  { id: 'tc-headphones', theme: 'tech', difficulty: 'Easy', text: 'I whisper music into your ears and tangle myself at night.', target_keyword: 'headphones', proof_method: 'Object Match' },
  { id: 'tc-keyboard', theme: 'tech', difficulty: 'Medium', text: 'I have many keys but open no doors.', target_keyword: 'keyboard', proof_method: 'Object Match' },
  { id: 'tc-mouse', theme: 'tech', difficulty: 'Medium', text: 'I have a tail but no fur, and I click without a voice.', target_keyword: 'computer mouse', proof_method: 'Object Match' },
  { id: 'tc-charger', theme: 'tech', difficulty: 'Medium', text: 'I feed your battery with an electric leash.', target_keyword: 'charger', proof_method: 'Object Match' },
  { id: 'tc-laptop', theme: 'tech', difficulty: 'Hard', text: 'I open like a clam and hold an ocean of information.', target_keyword: 'laptop', proof_method: 'Object Match' },

  // Toys & Hobbies
  { id: 'hb-teddy', theme: 'hobbies', difficulty: 'Easy', text: 'I am a bear who never growls, guarding bedtime instead.', target_keyword: 'teddy bear', proof_method: 'Object Match' },
  { id: 'hb-cards', theme: 'hobbies', difficulty: 'Medium', text: 'I am a deck of 52 destinies that fits in your palm.', target_keyword: 'playing cards', proof_method: 'Object Match' },
  { id: 'hb-dice', theme: 'hobbies', difficulty: 'Medium', text: 'Roll me and fate decides — six faces, zero lies.', target_keyword: 'dice', proof_method: 'Object Match' },
  { id: 'hb-ball', theme: 'hobbies', difficulty: 'Easy', text: 'I bounce with joy but cry when I go flat.', target_keyword: 'ball', proof_method: 'Object Match' },
  { id: 'hb-puzzle', theme: 'hobbies', difficulty: 'Medium', text: 'I am a picture broken into a hundred crimes.', target_keyword: 'puzzle piece', proof_method: 'Object Match' },
  { id: 'hb-crayon', theme: 'hobbies', difficulty: 'Easy', text: 'I am a wax soldier that dies coloring your battles.', target_keyword: 'crayon', proof_method: 'Object Match' },

  // Tools & Stationery
  { id: 'tl-scissors', theme: 'tools', difficulty: 'Easy', text: 'We are twins who only work when we disagree.', target_keyword: 'scissors', proof_method: 'Object Match' },
  { id: 'tl-pen', theme: 'tools', difficulty: 'Easy', text: 'I have ink but no mind, and I sign your name.', target_keyword: 'pen', proof_method: 'Object Match' },
  { id: 'tl-tape', theme: 'tools', difficulty: 'Medium', text: 'I hold the world together in one sticky spiral.', target_keyword: 'tape', proof_method: 'Object Match' },
  { id: 'tl-screwdriver', theme: 'tools', difficulty: 'Medium', text: 'I drink screws for breakfast and twist for a living.', target_keyword: 'screwdriver', proof_method: 'Object Match' },
  { id: 'tl-glue', theme: 'tools', difficulty: 'Easy', text: 'I am liquid friendship for broken things.', target_keyword: 'glue', proof_method: 'Object Match' },
  { id: 'tl-stapler', theme: 'tools', difficulty: 'Medium', text: 'I bite metal staples and never get hungry.', target_keyword: 'stapler', proof_method: 'Object Match' },
  { id: 'tl-ruler', theme: 'tools', difficulty: 'Easy', text: 'I judge everyone by inches and never bend the rules.', target_keyword: 'ruler', proof_method: 'Object Match' },

  // Furniture & Decor
  { id: 'fu-chair', theme: 'furniture', difficulty: 'Easy', text: 'I have four legs but I never run anywhere.', target_keyword: 'chair', proof_method: 'Object Match' },
  { id: 'fu-pillow', theme: 'furniture', difficulty: 'Easy', text: 'I catch your dreams and your drool at night.', target_keyword: 'pillow', proof_method: 'Object Match' },
  { id: 'fu-lamp', theme: 'furniture', difficulty: 'Easy', text: 'I swallow darkness and glow with a switch.', target_keyword: 'lamp', proof_method: 'Object Match' },
  { id: 'fu-table', theme: 'furniture', difficulty: 'Easy', text: 'I carry your meals and your laptop, standing all day.', target_keyword: 'table', proof_method: 'Object Match' },
  { id: 'fu-rug', theme: 'furniture', difficulty: 'Medium', text: 'I lie at your door and soften every step.', target_keyword: 'rug', proof_method: 'Object Match' },
  { id: 'fu-vase', theme: 'furniture', difficulty: 'Medium', text: 'I hold water for flowers I will never drink.', target_keyword: 'vase', proof_method: 'Object Match' },
];

export interface PickRiddleOptions {
  difficulty: Difficulty;
  /** Ignored: themes were removed from the game. Kept optional so old callers compile. */
  themes?: ThemeId[];
  excluded: string[];
}

/**
 * Pick a random demo riddle: exact difficulty and not excluded, then any difficulty
 * not excluded, then anything (the host resets the excluded list).
 */
export function pickRiddle(opts: PickRiddleOptions): Riddle | null {
  const { difficulty, excluded } = opts;
  const norm = excluded.map((k) => k.toLowerCase());

  const exact = RIDDLE_BANK.filter(
    (r) => r.difficulty === difficulty && !norm.includes(r.target_keyword.toLowerCase()),
  );
  if (exact.length) return rand(exact);

  const anyDiff = RIDDLE_BANK.filter((r) => !norm.includes(r.target_keyword.toLowerCase()));
  if (anyDiff.length) return rand(anyDiff);

  return rand(RIDDLE_BANK);
}

/** Demo-mode spoken hint: first letter, word count and theme. */
export function makeHint(riddle: {
  target_keyword: string;
  theme: string;
  proof_method: ProofMethod;
}): string {
  const word = riddle.target_keyword;
  const first = word.charAt(0).toUpperCase();
  const words = word.split(/\s+/).length;
  const themeName = THEME_MAP[riddle.theme as ThemeId]?.name ?? riddle.theme ?? 'household items';
  const count = riddle.proof_method === 'Count Match' ? 'How many can you find?' : '';
  return `Hint: the answer starts with the letter ${first}, it is ${words === 1 ? 'one word' : `${words} words`}, and you will find it around ${themeName.toLowerCase()}. ${count}`;
}

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

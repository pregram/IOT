/**
 * Shared TypeScript contracts, mirroring the Firebase Realtime Database schema.
 * The firmware parses the same nodes by convention in cloud_link.h, so a shape
 * change here must land there too.
 */

export type Role = 'host' | 'player';

export type Tier = 'Casual' | 'Standard' | 'Expert';

export type Difficulty = 'Easy' | 'Medium' | 'Hard';

/**
 * Finite State Machine states (stored at rooms/{pin}/state):
 * LOBBY - players joining, waiting for host
 * INTRO - "Get ready" beat (game name splash)
 * ROUND_FLASH - Kahoot-style "ROUND X OF Y" full-screen flash
 * CALLOUT - "MAYA! STEP UP!" player callout
 * ACTIVE_TURN - live camera + riddle + countdown
 * EVALUATING - frozen snapshot + Gemini judging pulse
 * ROUND_RESULTS - verdict, points, leaderboard
 * GAME_OVER - victory podium
 */
export type GameState =
  | 'LOBBY'
  | 'INTRO'
  | 'ROUND_FLASH'
  | 'CALLOUT'
  | 'ACTIVE_TURN'
  | 'EVALUATING'
  | 'ROUND_RESULTS'
  | 'GAME_OVER';

/**
 * Special round kinds:
 *   BONUS - round floor(N/2)+1 (N=2 → round 1): every player who answers
 *     correctly earns an immediate personal bonus riddle (normal points, no
 *     penalty, DDA skipped).
 *   DOUBLE_OR_DOOM - always the LAST round (2× on pass, −2× base on fail).
 * The old DOUBLE_ROUND and the 500-point threshold bonus were retired.
 */
export type SpecialRoundType = 'NONE' | 'BONUS' | 'DOUBLE_OR_DOOM';

export type ThemeId =
  | 'everyday'
  | 'food'
  | 'nature'
  | 'clothes'
  | 'tech'
  | 'hobbies'
  | 'tools'
  | 'furniture';

/** The four playstyle-driven proof methods joined the legacy demo-bank set. */
export type ProofMethod =
  | 'Object Match'
  | 'Color Match'
  | 'Action Match'
  | 'Count Match'
  | 'Sketch Proof'
  | 'Body Gestures'
  | 'Handwritten Cipher';

/** 🎺 Host sound-board hits (played on TV + every phone) */
export type SoundCueId = 'airhorn' | 'drumroll' | 'rimshot' | 'tada';

/** Feed renderer for the host camera panel: demo rooms simulate, real
 *  rooms stream the board. (A UI concept only - camera source is derived
 *  from the room, never configured by hand.) */
export type CameraMode = 'mock' | 'real';

export interface ThemeDef {
  id: ThemeId;
  name: string;
}

export interface Riddle {
  id: string;
  theme: ThemeId;
  difficulty: Difficulty;
  text: string;
  target_keyword: string;
  proof_method: ProofMethod;
}

/**
 * rooms/{pin}/current_riddle
 * Real rooms: written by the ESP32 board (Gemini-generated on demand) -
 * `req_id` echoes the hardware_session/riddle_req the board fulfilled.
 * Demo rooms: written by the host from the local demo bank (no req_id).
 */
export interface CurrentRiddle {
  id: string;
  text: string;
  proof_method: ProofMethod;
  difficulty: Difficulty;
  time_limit_sec: number;
  target_keyword: string;
  /** Holds the ENVIRONMENT name ("Kitchen & Dining"). The field
   *  keeps its legacy `theme` key so old staged riddles and the demo bank
   *  stay readable without a data migration. */
  theme: string;
  /** riddle_req.req_id this riddle answers (board-written only) */
  req_id?: number;
}

/** per-theme mastery counters (key = ThemeId) */
export interface ThemeStat {
  attempts: number;
  solves: number;
}

export interface PlayerStats {
  solves: number;
  fails: number;
  timeouts: number;
  hard_solves: number;
  hints_used: number;
  doom_survives: number;
  best_time_sec: number | null;
  /** solved/attempted per riddle theme - powers the phone "Theme Mastery" panel */
  theme_stats?: Record<string, ThemeStat>;
}

/** Live event ticker entry (rooms/{pin}/feed) */
export interface FeedEvent {
  id: string;
  ts: number;
  text: string;
  tone: 'good' | 'bad' | 'info' | 'gold';
}

/** Phone → TV emoji reaction (rooms/{pin}/reactions, rolling last 12) */
export interface ReactionEvent {
  id: string;
  emoji: string;
  ts: number;
  by: string;
  name: string;
  /** ≥3 same-emoji streak within 8s - triggers a bigger TV burst */
  combo?: number;
}

/** rooms/{pin}/players/{playerId} */
export interface Player {
  name: string;
  score: number;
  tier: Tier;
  /** Theme selection REMOVED from the game (categories are gone,
   *  the host picks one Environment for everyone). Kept optional purely so
   *  legacy player nodes already in Firebase stay type-safe. */
  themes?: ThemeId[];
  hint_tokens: number;
  streak: number;
  fail_streak: number;
  current_difficulty: Difficulty;
  /** DDA 2-round-block counters: solved/total inside the
   *  CURRENT block of main turns; bonus turns never count. 2/2 → step up,
   *  0/2 → ease, 1/2 → hold; the block resets after every resolution and
   *  whenever the difficulty changes. Optional so legacy player nodes in
   *  Firebase stay type-safe (missing = 0). */
  dda_block_solved?: number;
  dda_block_total?: number;
  is_bot: boolean;
  joined_at: number;
  badge: string;
  /** identity color hex (assigned at join) */
  color: string;
  /** epoch ms of the player's last heartbeat (reconnect awareness) */
  last_seen?: number;
  stats: PlayerStats;
}

/**
 * rooms/{pin}/moments - captured proof snapshots (rolling last 12).
 * Photos are small downscaled JPEG data URLs (~10-20 KB each) taken from the
 * host camera at snap time. They power the victory-screen polaroid gallery.
 */
export interface PhotoMoment {
  id: string;
  ts: number;
  player_id: string;
  player_name: string;
  player_color: string;
  /** riddle target keyword, e.g. "book" */
  keyword: string;
  difficulty: Difficulty;
  round: number;
  verdict: 'pass' | 'fail' | 'unclear' | 'timeout';
  points: number;
  /** downscaled JPEG data URL (320×180, quality ~0.55) */
  photo: string;
  /** 💬 one-line caption typed by the player right after an accepted proof */
  caption?: string;
}

/** rooms/{pin}/last_evaluation */
export interface EvaluationResult {
  passed: boolean;
  /** true = image unclear → retake allowed */
  error: boolean;
  feedback: string;
  points_earned: number;
  timed_out: boolean;
  /** What the judge actually SAW ("a hand holding a phone").
   *  Powers the spoken "I see …, but I was looking for …" line. */
  seen?: string | null;
  /** Player state BEFORE a fail/timeout was applied (this
   *  snapshot rides on fail/timeout writes only). The Overrule-AI path
   *  re-scores the turn as a pass and restores streak, fail-streak,
   *  difficulty and the DDA block counters from here. */
  pre_fail?: {
    streak: number;
    fail_streak: number;
    difficulty: Difficulty;
    block_solved: number;
    block_total: number;
  } | null;
}

export interface TurnTimer {
  time_remaining: number;
  is_active: boolean;
}

/** rooms/{pin} - the whole live game document */
export interface Room {
  /** denormalized copy of the 4-digit PIN (the DB key) for display convenience */
  pin: string;
  host_device_id: string;
  game_name: string;
  num_rounds: number;
  current_round: number;
  state: GameState;
  /** true = hardware-free demo room (Fast Demo Launch) - simulated judging,
   *  no ESP32 required; real rooms hard-require the board */
  demo?: boolean | null;
  active_player_id: string | null;
  /** rolling emoji reactions from player phones (last 12) */
  reactions: ReactionEvent[] | null;
  /** stable play order decided at match start */
  turn_order: string[];
  /** index into turn_order for the current turn */
  turn_pos: number;
  special_round_type: SpecialRoundType;
  /** The ONE environment the host picked at game creation
   *  (replaces the old per-player category/theme system entirely). */
  environment?: EnvironmentIdTag | null;
  /** The ONE playstyle the host picked (drives the per-turn
   *  proof-method distribution, decided in code - see lib/environments.ts). */
  playstyle?: string | null;
  /** Countdown Capture length in seconds (host sets in lobby, 1-10). */
  countdown_secs?: number;
  current_riddle: CurrentRiddle | null;
  /** Host "Pivot to Paper" toggle for the CURRENT turn: the judge
   *  accepts a drawing / handwritten word on paper, whiteboard or a phone
   *  screen (English, Hebrew or Arabic). Reset on every turn change. */
  paper_mode?: boolean | null;
  /** Live Countdown Capture request (host or player button, or the
   *  board's double-press echo). The riddle timer pauses while it runs. */
  countdown?: {
    secs: number;
    ts: number;
    origin: 'host' | 'player' | 'esp';
    player_id?: string | null;
  } | null;
  /** board-staged NEXT riddle (published by the board while the
   *  host's prefetch request carries publish:"hold"). Never rendered
   *  anywhere: the host moves it into current_riddle the moment the next
   *  turn actually starts - this is what stops the next riddle from
   *  appearing on TVs/phones before "Continue" is pressed. */
  next_riddle?: CurrentRiddle | null;
  turn_timer: TurnTimer;
  last_evaluation: EvaluationResult | null;
  players: Record<string, Player>;
  excluded_keywords: string[];
  /** written by ESP32 GPIO button - legacy: plain timestamp (host snap);
   *  double press: {ts, countdown} → timed capture instead. */
  capture_request: number | { ts: number; countdown?: number } | null;
  /** written by player phone (or board button) when asking for a hint */
  hint_request: { player_id: string; ts: number } | null;
  /** 💡 board-written Gemini hint (spoken by the board TTS room-wide) */
  hint?: { req_id: number; player_id: string; player_name: string; text: string; ts: number } | null;
  /** turn_started_at of the turn where a hint was used → solve pays 50 % */
  hint_used_turn?: number | null;
  /** 🔍 Host Check: the host is reviewing an UNCLEAR proof photo
   *  (ROUND_RESULTS). Web-only: phones show "host is checking"; the board
   *  never reads it. */
  host_review?: { ts: number } | null;
  /** free hint tokens per player for this match (host sets in lobby, 0-3) */
  hint_tokens_per_player?: number;
  /** 🎁 live bonus mini-turn (BONUS round correct solve) for this player */
  bonus_turn?: { player_id: string; round: number; ts: number } | null;
  /** rolling event ticker (last 8 events, host-written) */
  feed: FeedEvent[] | null;
  /** captured proof snapshots (rolling last 12, host-written) */
  moments?: PhotoMoment[] | null;
  /** host "spotlight" hype highlight on one player (cleared when their turn resolves) */
  spotlight?: { player_id: string; ts: number } | null;
  /** host heartbeat (epoch ms) - stale rooms are reaped automatically */
  hb?: number;
  /** absolute epoch ms when current state began (drives banner timings) */
  phase_started_at: number;
  /** absolute epoch ms when ACTIVE_TURN countdown started */
  turn_started_at: number | null;
  /** ⏸ freeze of the ACTIVE_TURN countdown - timers stop on TV + phones.
   *  reason: "host" (manual pause) · "hint" (auto, hint gen+speech) ·
   *  "countdown" (auto, Countdown Capture window). Auto reasons resume
   *  by themselves; "host" only via the Resume button.
   *  `host_paused` rides alongside as the OWNERSHIP marker so an
   *  auto-pause (hint/countdown) can start inside a manual pause without
   *  either side's resume clearing the other: a manual pause keeps
   *  host_paused=true until the host presses Resume, no matter what the
   *  auto-pauses do to `paused`. */
  paused?: { at: number; reason?: 'host' | 'hint' | 'countdown' } | null;
  host_paused?: boolean | null;
  /** 🎺 latest host sound-board hit - every device plays it on arrival */
  sfx_cue?: { sound: SoundCueId; ts: number } | null;
  /** ESP32 Vision judge verdicts keyed by judge phase (SECONDS - uint32-safe
   *  for the ESP32; the host also accepts any verdict fresher than the phase) */
  judge_result?: Record<string, JudgeResult> | null;
  /** 💬 player → host request to caption their accepted proof photo */
  caption_request?: {
    moment_id: string;
    player_id: string;
    player_name: string;
    text: string;
    ts: number;
  } | null;
  created_at: number;
}

/** hardware_session - global single-camera lock */
export interface HardwareSession {
  active_room: string | null;
  last_heartbeat: number;
  /** host → ESP32 compact game-state mirror (the firmware polls this node) */
  hw?: HwMirror | null;
  /** host → ESP32 latest Voice Master line (firmware speaks it via TTS relay) */
  cmd?: HwSpeakCmd | null;
  /** host → ESP32 camera/voice settings mirror (works even when browser→ESP
   *  HTTP is blocked by HTTPS mixed-content rules) */
  esp_settings?: Record<string, unknown> | null;
  /** ESP32 → everyone heartbeat (firmware writes every ~10 s) */
  esp?: HwEspStatus | null;
  /** host → board: generate a riddle (the board is the only riddle
   *  source; it publishes rooms/{pin}/current_riddle with the same req_id).
   *  themes/excluded arrive comma-joined to keep the ESP parser tiny. */
  riddle_req?: {
    req_id: number;
    reason: 'turn' | 'bonus';
    difficulty: Difficulty;
    /** The room's ONE environment name (replaces themes CSV).
     *  `themes` kept in the type for legacy board compatibility but the
     *  web no longer writes it. */
    environment: string;
    themes?: string;
    /** Proof method this riddle must match (rolled in code). */
    proof?: string;
    excluded: string;
    player_name: string;
    /** "now" publishes rooms/{pin}/current_riddle (live turn);
     *  "hold" stages rooms/{pin}/next_riddle (prefetch, hidden until the
     *  host continues). Re-writing the SAME req_id with the other value
     *  flips the board's publish target without regenerating. */
    publish?: 'now' | 'hold';
    ts: number;
  } | null;
  /** host → board: speak the current riddle's stored hint for the active player */
  hint_req?: { req_id: number; player_name: string; ts: number } | null;
  /** host → board: explicit judge trigger written at EVALUATING entry
   *  (phase = seconds; self-heals the mirror race + powers the retry loop) */
  judge_request?: { phase: number; riddle: string; target: string; ts: number } | null;
  /** ESP32 → host: id of the LAST Voice Master line that FINISHED speaking
   *  (the web holds banner transitions + the turn clock until this ≥ the
   *  cmd id it published - true screen↔speaker sync instead of estimates) */
  tts_done?: { id: number; ts: number } | null;
  /** ESP32 → host: id of the LAST Voice Master line whose audio
   *  actually STARTED playing (first decoded frame). The host anchors its
   *  speech-gate fallbacks here instead of on the moment it queued a line. */
  tts_start?: { id: number; ts: number } | null;
}

/** hardware_session/hw - compact mirror of the live game for the ESP32 node.
 *  Written by the host browser; the firmware polls it and reacts to:
 *  state changes (Voice Master lines ride hardware_session/cmd), fresh
 *  EVALUATING phases (judge_phase → ESP captures + Gemini judges), and
 *  unclear results (single button press = retake). */
export interface HwMirror {
  /** active room PIN, null when idle */
  room: string | null;
  state: GameState | '';
  /** publish timestamp - ESP uses it to detect fresh mirror data */
  seq: number;
  /** EVALUATING phase key in SECONDS (uint32-safe for the ESP32; the
   *  firmware writes judge_result under this exact key) */
  judge_phase: number;
  player_id: string | null;
  player: string | null;
  round: number;
  rounds: number;
  riddle: string;
  target: string;
  difficulty: string;
  theme: string;
  /** The riddle's proof method (judge prompt context) */
  proof?: string;
  /** Host pivoted this turn to paper (drawing/writing proof) */
  allow_paper?: boolean;
  /** Countdown Capture seconds (0 = feature disabled/unknown) */
  countdown?: number;
  time_limit: number;
  /** integer seconds left (refreshed ~1 Hz while the turn runs) */
  time_left: number;
  timer_running: boolean;
  paused: boolean;
  special: string;
  /** ROUND_RESULTS + unclear image → the camera button becomes RETAKE */
  unclear: boolean;
  /** non-empty while the turn's buttons are LOCKED (buttonLock():
   *  'reading' riddle read aloud · 'host_paused' · 'hint' hint being read)
   *  → the board ignores every physical press. */
  lock?: string;
}

/** hardware_session/cmd - newest-wins Voice Master utterance */
export interface HwSpeakCmd {
  /** monotonic epoch ms id - ESP speaks when id > lastSeen */
  id: number;
  say: string;
  /** Priority line (1): barges current speech + offline queue.
   *  Used for time-up / game-over so they never hang behind stale lines. */
  p?: number;
}

/** hardware_session/esp - firmware liveness for the UI (Settings + Host) */
export interface HwEspStatus {
  ip: string;
  fw: string;
  /** WiFi RSSI dBm */
  rssi: number;
  /** free heap bytes */
  heap: number;
  state: string;
  /** heartbeat field - what the board's Core 0 is busy on right now:
   *  "riddle" | "hint" | "judge" | "" (idle). A Gemini attempt can stall the
   *  heartbeat for ~30 s (or a judge for a few minutes), so the UI treats a
   *  busy board as "alive but thinking" instead of flipping to offline. */
  gen?: string;
  /** Board boot epoch (s); changes on every reboot, so the host
   *  camera feed reopens the MJPEG stream a reboot silently cut */
  boot?: number;
  ts: number;
}

/** rooms/{pin}/judge_result/{phase} - written by the ESP32 Vision judge
 *  (key-rotated Gemini call). Host consumes it, scores, then removes it. */
export interface JudgeResult {
  phase: number;
  passed: boolean;
  /** true = image unclear → retake, timer stays frozen */
  unclear: boolean;
  feedback: string;
  /** What the judge actually saw in the photo (short phrase) */
  seen?: string;
  ts: number;
}

/** Local host/voice/camera configuration (never synced, lives in localStorage) */
export interface HardwareSettings {
  esp32_ip: string;
  resolution: 'QVGA' | 'VGA' | 'SVGA' | 'XGA' | 'UXGA';
  /** ESP32 jpeg quality register 10..63 (10 = best quality) */
  quality: number;
  flip_h: boolean;
  flip_v: boolean;
  brightness: number; // -2..2
  contrast: number; // -2..2
  awb: boolean;
  awb_gain: boolean;
  special_fx: number; // 0 none .. 6 sepia
  voice_profile: string;
  voice_speed: number; // 0.5..2
  voice_volume: number; // 0..21
  muted: boolean;
  /** 🔊 route Voice Master lines to the ESP32 room speaker (TTS relay) */
  esp_speaker: boolean;
  /** 🎚 master SFX volume 0..100 (scales every WebAudio effect & jingle) */
  sfx_volume: number;
  theme: 'dark' | 'light';
  /** 🔗 override for the player join-URL base (defaults to
   *  NEXT_PUBLIC_JOIN_URL_BASE, then window.location.origin) */
  join_url_base?: string;
}

export interface LocalSession {
  role: Role;
  hostDeviceId: string;
  playerId: string;
  pin: string;
  name: string;
  tier: Tier;
  /** legacy, no longer collected at join */
  themes?: ThemeId[];
}

/** imported lazily to avoid a circular import at module scope */
type EnvironmentIdTag = import('./environments').EnvironmentId;

export interface Esp32ProbeResult {
  ok: boolean;
  message: string;
}

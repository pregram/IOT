# SnapRiddle user guide

SnapRiddle is a party game for one host screen (a laptop on a TV) and up to 8 player phones. Each turn, one player gets a riddle read out by a small camera box. The answer is something they can prove on camera: an object they grab, a quick sketch, a gesture, or a written answer to a puzzle. The box photographs the proof and an AI judge decides whether it passes.

Setting everything up for the first time is covered in [INSTALLATION.md](INSTALLATION.md). This guide assumes the board is flashed, the voice relay is running and the website is open.

## Before a game

1. Plug in the camera box (USB-C). Once it is on WiFi and has reached Firebase, the speaker says "SnapRiddle hardware online. Ready to play."
2. Start the voice relay on the host PC (`uvicorn tts_relay:app --host 0.0.0.0 --port 5051`) if it is not already running.
3. Open the website on the host laptop and put it on the TV. The fullscreen button in the header helps.

## Hosting a game

1. On the landing page choose **Host**, then pick:
   - the number of rounds (3, 5 or 10),
   - an environment (Classroom & Lab, Office & Workspace, Kitchen & Dining, Living Room, Dorm & Bedroom or Full House), which steers what the riddle answers will be,
   - a playstyle, which sets the mix of proof methods: Full Experience (default), Physical Hunt Mode (mostly objects) or Tabletop Brainiac (drawing, writing and puzzles).
2. The lobby shows a 4-digit room PIN, a join link and a QR code. In the lobby you can also set the free hints per player (0 to 3) and the Countdown Capture length (1 to 10 s), open the rules panel, and remove players.
3. Press **Start Match** once at least one player has joined. The button reads "Waiting for hardware…" until the camera box is sending heartbeats. Demo rooms (Fast Demo Launch) start without hardware and fake the judging.

## Joining as a player

1. Scan the QR code or open the join link on your phone.
2. Enter the room PIN and a nickname (unique in the room, since the Voice Master reads it out) and pick a tier: Casual (Easy to Medium), Standard (Easy to Hard) or Expert (Medium to Hard).
3. Wait in the lobby. When it is your turn your phone shows "YOU'RE UP!" and vibrates.

## How a turn goes

1. The round banner and the player callout play on the TV while the Voice Master announces them.
2. The board writes a riddle for the active player. While it does, the TV shows "Preparing riddle…".
3. The riddle is read aloud and shown on the TV and the player's phone. The clock (60 to 180 s, chosen per riddle) starts only after the riddle has been read.
4. The player finds the answer and shows it to the camera, then takes the photo in one of three ways:
   - the **Snap Photo Proof** button on the phone or the TV,
   - a single press of the physical button,
   - **Countdown Capture** (phone button, TV button, or a double press of the physical button): the clock pauses, a countdown runs, and the photo fires by itself.
5. The board sends the photo to the AI judge. The verdict comes back as ACCEPTED, REJECTED or IMAGE UNCLEAR, and the Voice Master announces it.
6. An unclear photo freezes the clock and allows a retake (single press, or double press for a countdown retake). A rejected or timed-out turn moves on.
7. The host presses Continue to go to the next player.

Faster proofs score more: points are the base for the difficulty (Easy 100, Medium 200, Hard 300) plus up to 50 % for time left. Difficulty adapts per player between rounds. Round floor(N/2)+1 is a Bonus round, where every correct answer unlocks an extra personal riddle. The last round is Double or Doom: a correct proof scores double, a miss costs twice the base points.

### Hints

The active player can ask for one hint per riddle with **Request Hint** on the phone, or by long-pressing the physical button (hold for 1.2 s). The game pauses while the hint is read. Free hints come from the lobby setting; once they are used up, solving after a hint pays half the points.

### Host controls during a turn

| Control | What it does |
| --- | --- |
| Pause / Resume | Freezes the clock on the TV and every phone. |
| Pivot to Paper | For this turn, accept a drawing or a written answer on paper, a whiteboard or a phone screen (English, Hebrew or Arabic). |
| Overrule AI | Reverses a wrong verdict and awards the points. |
| Host Check | Shows the photo, the riddle and the answer so the host can decide an unclear photo. It is highlighted after repeated unclear photos. |
| Judge override (Pass / Fail / Unclear) | Decides the turn by hand, for example when the board does not answer. |
| Spotlight | Puts one player in the spotlight on the TV and their phone. |
| Sound Board | Airhorn, drumroll, rimshot and ta-da, played on the TV and on every phone. |
| End Match | Ends the game and opens the victory screen. |

### The physical button

| Press | Action |
| --- | --- |
| Single press | Take the proof photo, or retake after an unclear verdict |
| Double press | Countdown Capture (also works as a countdown retake) |
| Long press (1.2 s) | Hint for the active player (one per riddle, 8 s lockout between hints) |

The button is ignored while the riddle is still being written or read, while the host has paused the game, and while a hint is being read.

### After the match

The victory screen shows the podium, the full leaderboard, badges and the photo moments of the match, with options to share results, download photos and replay the highlights. Players can add a caption to their accepted photos from their phone.

## Statuses

### In the web app

| Where | What you see | Meaning |
| --- | --- | --- |
| Landing page | "Game in Progress (Hardware Locked)" | Another room holds the camera box. Exit that room, or wait for its host heartbeat to expire. |
| Whole screen | "Can't reach game services" with a Retry button | The browser cannot reach Firebase. Check the internet connection and press Retry. |
| Lobby | Start button says "Waiting for hardware…" | No fresh heartbeat from the board. |
| Settings drawer, Hardware Integration | Green "Firmware online" with IP, signal, free memory and firmware version | The board is connected and heartbeating. |
| Settings drawer | "Board is writing a riddle…", "Board is judging the photo…", "Board is writing a hint…" | The board is busy with an AI call. It counts as online, not stalled. |
| Settings drawer | "Firmware offline - flash the board & join it to your WiFi to see live status." | No heartbeat. |
| TV camera panel | "Waiting for camera…", "ESP32 stream unreachable" | The live stream from the board is not loading. |
| TV riddle card | "Preparing riddle…" | The board is still generating the riddle. |
| TV verdict | ACCEPTED / REJECTED / IMAGE UNCLEAR | Result of the AI judge. |
| Phone | "YOU'RE UP!", "WAIT FOR YOUR TURN", "THE HOST IS SPOTLIGHTING YOU!" | Turn state for that player. |

### On the board (Serial Monitor, 115200 baud)

The board reports a state string in its heartbeat and in the `status` command:

| State | Meaning |
| --- | --- |
| BOOT | Just started, first heartbeat |
| WIFI | Connected to WiFi, starting the camera and cloud link |
| IDLE | Connected, no game running |
| JUDGING | Sending a proof photo to the AI judge |
| GENERATING | Writing a riddle |
| CAM_ERR | The camera failed to start. Judging is disabled; voice and cloud still work. |
| LOBBY, ACTIVE_TURN, EVALUATING, ROUND_RESULTS, ... | The current game state copied from the host |

There is no status LED. The XIAO's on-board LED cannot be seen in party lighting, so status lives in the serial console and the web app.

Useful serial commands: `status` (voice, memory, WiFi, link, state, what the board is busy with), `state` (the live game mirror), `snap` (camera self-test), `judge` (re-judge the current photo), `resend` (show and retry the last failed send), `vol 0..21`, `speed 0.5..2.0`, `voice <name>`, `lang en|he|ar`, `say <text>`, `stop`, `help`. Any other line is spoken.

## Error messages

### In the web app

| Message | Cause | What to do |
| --- | --- | --- |
| Waiting for hardware - power the camera board and keep it on WiFi. | Start was pressed with no board heartbeat. | Power the board, check its WiFi, watch the serial log. |
| Gemini is slow right now - the board is still judging your photo… | The AI provider is slow; the board is still trying. | Wait. The board rotates through models, keys and fallback providers. |
| ESP32 judge still silent - use the Pass / Fail judge override under the camera. | No verdict after about 3 minutes. | Decide the turn with the judge override buttons. |
| Still no riddle - re-asking the camera board… | The riddle did not arrive in time, so the request is sent again. | Usually fixes itself. If it repeats, check the board's serial log. |
| No riddle armed yet - the camera unlocks when the riddle lands. | Capture pressed before the riddle exists. | Wait for the riddle. |
| The Voice Master is still reading the riddle - buttons unlock when the clock starts. | Button pressed during the riddle reading. | Wait for the clock to start. |
| One hint per riddle - already used this turn! | A second hint was requested. | Only one hint per riddle. |
| Invalid Room PIN! Please check the Host TV screen. | Wrong PIN on the join screen. | Use the PIN shown in the lobby. |
| Room is full! This match already has 8 players. | The room hit the player limit. | Start another room. |
| The name "..." is already taken in this room - pick another. | Duplicate nickname. | Pick another nickname. |
| That match already finished - ask the host for a new room. | Joining a finished room. | Ask for the new PIN. |
| Another host device already owns this room. | A second device tried to host the same room. | Host from the original device. |

### On the board (Serial Monitor)

| Line | Cause | What to do |
| --- | --- | --- |
| `[CAM] init failed 0x105` / `0x20001`, `[CAM] WARNING: no PSRAM` | Camera ribbon not seated, or PSRAM not enabled | Reseat the Sense board; set Tools > PSRAM > OPI PSRAM and re-flash. |
| `[TTS] relay connect failed - queued for retry.` | Relay not running, wrong PC IP, or the firewall blocks port 5051 | Start the relay; open `http://<PC_IP>:5051/tts.mp3?text=hi` from another device; check `RELAY_HOST`. |
| `[Q] stale line dropped` | A queued line waited more than 45 s for the relay | Bring the relay back; old lines are not replayed on purpose. |
| `[JUDGE] 429 - quota/billing, cooling the key` | That key's daily quota is used up | Nothing; the next key or provider is tried. Add keys in SECRETS.h for long sessions. |
| `[JUDGE] -1 - local transport failure (not the model)` and `[TLS] ... detail:` lines | The board ran short of memory for a secure connection | Usually recovers on its own. The `[TLS]` line names the resource that ran out. |
| `[GEMINI] RAW 404` | A model id in `GEMINI_MODELS` no longer exists | Check ids at `https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY`. |
| `[BTN] time not synced - event dropped` | Network time has not arrived yet | Wait a few seconds; make sure the router allows NTP (UDP 123). |
| `[DB] blocked: wifi down` / `[WiFi] DISCONNECTED - reason=N` | WiFi dropped | The board re-issues the connection every 15 s. Check the router (2.4 GHz only). |
| `[PEND] judge photo kept for retry` | A photo or verdict could not be sent | It is re-sent every 15 s for up to 2 minutes. |

## Privacy and fair play

The Firebase database runs with open (test mode) rules, so anyone with a room PIN can write to that room. Proof photos are sent to the AI provider for judging, and small thumbnails of accepted photos are stored in the room for the victory screen.

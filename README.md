# Boxes

The school-paper dots-and-boxes game, in the browser. Two players take turns
drawing a line between two neighbouring dots; draw the fourth side of a square
and the box is yours, and you go again. When the page is full, the most boxes
wins.

Designed around the **100-box Classic board** and the **196-box A4 board**, not
around tutorial-sized grids.

* **Vs AI** — School Kid, Casual Player, Competitive Player, Grandmaster.
* **Pass & Play** — one device, two players.
* **Online Multiplayer** — a host creates a game, shares a 4-character code or
  an invite link, and the opponent joins from any browser. No server required:
  the host's browser is the authority and the two peers talk over a WebRTC data
  channel (PeerJS).

## Play it

<https://ben0551.github.io/boxes/>

## Board sizes

| Mode | Dots | Boxes | Expected duration |
|---|---|---|---|
| Quick | 8 × 8 | 49 | 5–10 min |
| **Classic Schoolbook** (default) | 11 × 11 | 100 | 10–15 min |
| A4 Classic | 15 × 15 | 196 | 15–30 min |
| Giant | 21 × 21 | 400 | 30–60 min |
| Custom | 4–50 | up to 2,401 | — |

## How a turn works

1. Draw one line between two adjacent dots.
2. If that line completes a box, the box fills with your colour and initial,
   you score one point, and **you take another turn**.
3. If it completes nothing, play passes to the other player.
4. One line can complete two boxes at once (the shared side of two squares).
5. When every box is claimed, the higher score wins. A tie is a draw.

The whole game is the endgame: chain captures near the end of a 100-box board
can swing dozens of boxes in a single turn.

## Controls

| Action | Mouse | Touch |
|---|---|---|
| Play a line | click the gap between two dots | tap the gap |
| Pan | drag | drag |
| Zoom | mouse wheel | pinch |
| Fit / centre | **Fit board**, **Centre** buttons | same |

## Artificial intelligence

Four levels, all pure logic (`ai.js`, no DOM):

| Level | Behaviour |
|---|---|
| **School Kid** | Picks any legal line at random. |
| **Casual Player** | Takes every box on offer, otherwise plays a safe line, otherwise gives away as little as possible. |
| **Competitive Player** | Depth-limited alpha-beta search with a chain-rule evaluation. |
| **Grandmaster** | The same search much deeper, plus an exact solver once 16 or fewer lines remain. |

### The chain rule

When no safe line remains, the player to move must open a chain. For a chain of
length `L` the taker chooses between taking all `L` boxes (and having to open the
next chain) and double-crossing — taking `L − 2` and leaving two, which forces
the opener to take those two and open the next chain. The evaluation is the
exact recursion over the remaining chain lengths:

```
V(empty) = 0
V(S)     = max over chains i of min( -(L_i + V(S \ i)),  4 - L_i + V(S \ i) )
```

with loops treated as chains of length `L − 4`. While safe lines remain, the
parity of the safe-line count decides who will be forced to open, so the same
value is credited to the player who will *not* have to open.

### Measured ladder

`tools/sim.js` plays AI-vs-AI matches with the seats alternated, so a
first-player advantage cannot masquerade as skill. Win rates are measured, not
guessed.

| Matchup (seats alternated) | Stronger level wins |
|---|---|
| Casual vs School Kid | 100% (8 games) |
| Competitive vs Casual | 90% and 96.7% in two independent 30-game runs (average margins 14.9 and 16.1 boxes) |
| Grandmaster vs Competitive | 75.0% and 81.3% in two independent 16-game runs (average margins 10.5 and 12.6 boxes) |

So the ladder is monotonic and each rung is a real step: the Grandmaster beats
the Competitive player roughly three to four times out of four, and the
Competitive player almost never drops a game to Casual. Sample sizes are modest,
so treat both rows as ranges rather than points.

Run it yourself:

```
node tools/sim.js 20 8 competitive grandmaster auto swap
node tools/probe.js 8      # exact-solve cost by number of free edges
```

The Grandmaster's exact solver costs roughly: 8 free lines ≈ 15 ms, 12 ≈ 140 ms,
16 ≈ 700 ms, 20 ≈ 900 ms, 24 ≈ 4.5 s — which is why the exact threshold is 16.

## Online multiplayer

* The host picks a board size, then gets a code (e.g. `K7Q2`) and an invite link
  (`…?join=K7Q2`).
* The guest opens the link (or types the code) and the game starts.
* Both players see the board, whose turn it is and the live score. Only the
  host runs the engine; the guest sends line choices and renders the state it is
  given.
* `?host=CODE` in the URL lets a host refresh the page and reclaim the same code.

Transport is [PeerJS](https://peerjs.com/) (vendored in `vendor/`, no build
step), which brokers the WebRTC connection from its free cloud server. To
self-host the broker instead, run `npx peerjs --port 9000 --path /` and point
`BROKER` at the top of `online.js` to it.

## Statistics, achievements, saves

* Statistics track games, wins, losses, draws, win rate, largest chain on the
  page, largest single turn, longest and fastest game, biggest comeback, career
  boxes, plus per-board-size and per-player breakdowns.
* Twelve achievements, unlocked at the moment they happen.
* The game autosaves after every line, on tab blur and on close. **Continue** on
  the main menu resumes exactly where you left off.

## Strategic assistance

All off by default, toggled in **Settings**:

* Safe move highlight — green markers on lines that create no three-sided box.
* Heat map — green = safe, amber = creates a three-sided box, blue = takes a box.
* Move preview — a ghost line under the cursor.

Settings also cover four themes (Graph paper, Whiteboard, Chalkboard, Retro
computer) and the box mark (initials, star or blank).

## Performance

Measured by timing `BoardView.render()` in headless Chrome:

| Board | State | ms per frame |
|---|---|---|
| 21×21 dots (400 boxes) | empty | 0.33 |
| 21×21 dots (400 boxes) | completely filled | 5.7 |
| 50×50 dots (2,401 boxes) | completely filled | 30.7 |

The spec's targets — 60 FPS at 100, 196 and 400 boxes — are met with room to
spare; a full custom 50×50 page runs at roughly 33 FPS.

Search budgets are wall-clock capped as well, so a move never takes longer than
the level allows (260 ms Competitive, 950 ms Grandmaster), whatever the board.

## Development

Plain HTML/CSS/vanilla JS. No build step, no dependencies to install.

```
node tests/engine.test.js            # 28 checks: rules, chains, serialisation, AI legality
node tools/sim.js 20 8 competitive casual 60 swap
node tools/probe.js 8
./run_tests.sh
```

| File | Role |
|---|---|
| `index.html` | screens and structure |
| `style.css` | styling and the four themes |
| `engine.js` | pure engine — no DOM, typed arrays, serialisable state |
| `ai.js` | the four computer opponents and the search |
| `ai-worker.js` | runs `ai.js` off the UI thread |
| `online.js` | host/guest WebRTC session |
| `ui.js` | DOM controller, canvas renderer, pan/zoom, stats, saves |
| `vendor/peerjs.min.js` | PeerJS 1.5.4 |

## Design notes

* **Boards are dot grids, not cell grids.** An 11×11-dot board has 10×10 = 100
  boxes, matching the spec's table.
* **Line drawing uses two flat typed arrays** (`h`, `v`) so a 50×50-dot board
  (2,401 boxes, 4,900 lines) still searches and renders comfortably.
* **Edge ownership is reconstructed from the move history**, so the saved game
  stays small and an old save can never disagree with the board.
* **A capture always keeps the turn**, which breaks the usual negamax assumption
  that the side to move alternates every ply; the search negates only when
  possession actually passed.
* **The endgame is solved exactly**, not heuristically, because that is where
  100-box games are decided.

## Not in this build

The v2.0 spec lists rankings, replays and match analysis. Online multiplayer is
here because it was asked for; the other three are not — there is no server to
keep a leaderboard, and a replay would mean storing full move history per game
(the engine keeps it, but nothing persists or renders it yet).

## Licence

MIT — do whatever you like with it.

/* Headless AI-vs-AI harness. Run: node tools/sim.js [games] [dots] [levelA] [levelB] [timeMs]
 *
 * Prints win rates, average margins and per-move cost so the difficulty ladder
 * can be tuned against real numbers rather than intuition.
 */
'use strict';

const B = require('../engine.js');
const AI = require('../ai.js');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function playGame(dots, levelA, levelB, timeMs, nodeCap, seed) {
  const rng = mulberry32(seed);
  const state = B.createGame({ dots: dots, rng: rng });
  // Per-level budgets mirroring the browser, so the reported ladder matches
  // what a player actually faces.
  const LEVEL_BUDGET = {
    competitive: { timeMs: 260, nodeCap: 220000, maxDepth: 8, exactEdges: 0 },
    grandmaster: { timeMs: 950, nodeCap: 900000, maxDepth: 60, exactEdges: 16 },
  };
  const mk = function (level) {
    if (!LEVEL_BUDGET[level]) return {};
    return Object.assign({}, LEVEL_BUDGET[level]);
  };
  const optsA = mk(levelA);
  const optsB = mk(levelB);
  let thinkMs = 0;
  let guard = 0;
  while (state.phase === 'play' && guard++ < 20000) {
    const level = state.current === 0 ? levelA : levelB;
    const opts = state.current === 0 ? optsA : optsB;
    const t0 = Date.now();
    const id = AI.choose(state, level, opts);
    thinkMs += Date.now() - t0;
    if (id === null) break;
    const res = B.play(state, id);
    if (!res.ok) throw new Error('AI played an illegal edge: ' + id);
  }
  return { state: state, thinkMs: thinkMs };
}

function main() {
  const games = Number(process.argv[2] || 20);
  const dots = Number(process.argv[3] || 8);
  const levelA = process.argv[4] || 'competitive';
  const levelB = process.argv[5] || 'casual';
  const timeMs = Number(process.argv[6] || 60);
  // 'swap' alternates which seat each level starts in, so a structural
  // first-player advantage does not masquerade as skill.
  const swap = process.argv[7] === 'swap';

  let aWins = 0;
  let bWins = 0;
  let draws = 0;
  let margin = 0;
  let thinkMs = 0;
  let moves = 0;

  for (let g = 0; g < games; g++) {
    const flip = swap && (g % 2 === 1);
    const la = flip ? levelB : levelA;
    const lb = flip ? levelA : levelB;
    const r = playGame(dots, la, lb, timeMs, 200000, g * 7919 + 13);
    const s = r.state;
    const aIsSeat0 = !flip;
    if (aIsSeat0) {
      if (s.winner === 0) aWins++;
      else if (s.winner === 1) bWins++;
      margin += s.scores[0] - s.scores[1];
    } else {
      if (s.winner === 1) aWins++;
      else if (s.winner === 0) bWins++;
      margin += s.scores[1] - s.scores[0];
    }
    if (s.winner === -1) { draws++; }
    thinkMs += r.thinkMs;
    moves += s.moves;
  }

  console.log(`${levelA} vs ${levelB} on ${dots}x${dots} dots${swap ? ' (seats alternated)' : ''}`);
  console.log(`  games      ${games}`);
  console.log(`  ${levelA} wins ${aWins}  (${(100 * aWins / games).toFixed(1)}%)`);
  console.log(`  ${levelB} wins ${bWins}  (${(100 * bWins / games).toFixed(1)}%)`);
  console.log(`  draws      ${draws}`);
  console.log(`  avg margin ${(margin / games).toFixed(2)} boxes for ${levelA}`);
  console.log(`  avg moves  ${(moves / games).toFixed(1)}`);
  console.log(`  think      ${(thinkMs / Math.max(1, moves)).toFixed(2)} ms/move total ${thinkMs} ms`);
}

main();

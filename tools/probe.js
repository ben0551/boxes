/* Endgame solver cost probe: how long does an exact solve take as a function
 * of the number of free edges left? Run: node tools/probe.js [dots] */
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

const dots = Number(process.argv[2] || 8);

// Build a position with exactly `target` free edges by playing casual moves.
for (const target of [8, 10, 12, 14, 16, 18, 20, 24]) {
  const state = B.createGame({ dots: dots, rng: mulberry32(5) });
  let guard = 0;
  while (B.freeEdges(state).length > target && guard++ < 5000) {
    const id = AI.choose(state, 'casual', {});
    if (id === null) break;
    B.play(state, id);
  }
  const free = B.freeEdges(state).length;
  const t0 = Date.now();
  const info = {};
  const id = AI.searchRoot(state, { timeMs: 60000, nodeCap: 4000000, maxDepth: free }, info);
  const ms = Date.now() - t0;
  console.log(`free ${String(free).padStart(3)}  solve ${String(ms).padStart(6)} ms  depth ${info.depth}  nodes ${info.nodes}  move ${id}`);
}

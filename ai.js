/* Boxes — computer opponents. Pure logic, no DOM.
 *
 * Four levels:
 *   kid          uniform random legal edge
 *   casual       takes what is on offer, otherwise plays safe, otherwise gives
 *                away as little as possible
 *   competitive  depth-limited search with a chain-rule evaluation
 *   grandmaster  the same search, deeper, and exact once the endgame is small
 *
 * The chain-rule evaluation is the classic Berlekamp idea: with only damaging
 * moves left, the player to move must open a chain, and the value of a chain of
 * length L is decided by whether the taker takes all L or double-crosses
 * (leaving 2, worth 4 - L to the opener).
 */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const B = isNode ? require('./engine.js') : root.Boxes;
  const api = factory(B);
  if (isNode) module.exports = api;
  else root.BoxesAI = api;
}(typeof self !== 'undefined' ? self : globalThis, function (B) {
  'use strict';

  const LEVELS = { KID: 'kid', CASUAL: 'casual', COMPETITIVE: 'competitive', GRANDMASTER: 'grandmaster' };

  const DEFAULT_BUDGET = {
    kid: { timeMs: 0, nodeCap: 0, maxDepth: 0 },
    casual: { timeMs: 0, nodeCap: 0, maxDepth: 0 },
    competitive: { timeMs: 260, nodeCap: 220000, maxDepth: 8 },
    grandmaster: { timeMs: 950, nodeCap: 900000, maxDepth: 60 },
  };

  const EXACT_EDGES = 24;   // at or below this many free edges, search to the end

  const CAP = {};           // sentinel thrown when a budget runs out
  let lastInfo = null;      // diagnostics from the most recent choose()

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------- primitives */

  function randomPick(list, rng) {
    return list[Math.floor(rng() * list.length)];
  }

  // The edge that completes the most boxes right now.
  function bestCapture(state, ids, rng) {
    let bestIds = [];
    let bestN = -1;
    for (let i = 0; i < ids.length; i++) {
      const info = B.edgeInfo(state, ids[i]);
      const adj = B.adjacentBoxes(state, info);
      let n = 0;
      for (let k = 0; k < adj.length; k++) if (state.boxSides[adj[k]] === 3) n++;
      if (n > bestN) { bestN = n; bestIds = [ids[i]]; }
      else if (n === bestN) bestIds.push(ids[i]);
    }
    return randomPick(bestIds, rng);
  }

  // Boxes the player to move picks up if they keep taking what is on offer.
  function pendingCaptures(state) {
    const sim = B.cloneLight(state);
    let gained = 0;
    let guard = 0;
    while (guard++ < 4096) {
      const caps = B.classify(sim).capturing;
      if (!caps.length) break;
      const res = B.play(sim, caps[0]);
      if (!res.ok) break;
      gained += res.captured;
      if (res.over) break;
    }
    return gained;
  }

  // Cheapest damaging move by immediate cost: how much the opponent takes next.
  function cheapestDamage(state, ids, rng) {
    let bestIds = [];
    let bestCost = Infinity;
    for (let i = 0; i < ids.length; i++) {
      const sim = B.cloneLight(state);
      B.play(sim, ids[i]);
      const cost = sim.phase === 'over' ? -1000 : pendingCaptures(sim);
      if (cost < bestCost) { bestCost = cost; bestIds = [ids[i]]; }
      else if (cost === bestCost) bestIds.push(ids[i]);
    }
    return randomPick(bestIds, rng);
  }

  /* -------------------------------------------------------------- chain rule */

  // Value (mover's boxes minus opponent's) of a position where every remaining
  // move damages somebody: the mover must open a chain.
  function chainValue(state) {
    const a = B.analyze(state);
    if (a.loose.length) return 0;
    const lens = [];
    for (let i = 0; i < a.chains.length; i++) lens.push(a.chains[i].boxes.length);
    for (let i = 0; i < a.loops.length; i++) lens.push(Math.max(2, a.loops[i].boxes.length - 4));
    if (!lens.length) return 0;

    const memo = new Map();
    let states = 0;
    const CAP_STATES = 60000;

    function V(key) {
      if (key === '') return 0;
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      if (++states > CAP_STATES) {
        // Too many chains for the exact recursion: use the all-double-cross line.
        let sum = 0;
        const parts = key.split(',');
        for (let i = 0; i < parts.length; i++) sum += Number(parts[i]);
        return 4 * parts.length - sum;
      }
      const arr = key.split(',').map(Number);
      let best = -Infinity;
      for (let i = 0; i < arr.length; i++) {
        const L = arr[i];
        const rest = arr.slice(0, i).concat(arr.slice(i + 1)).sort(function (x, y) { return y - x; }).join(',');
        const vr = V(rest);
        const takeAll = -(L + vr);          // opponent takes the lot and opens next
        const doubleCross = 4 - L + vr;     // opponent leaves 2, mover opens next
        const v = Math.min(takeAll, doubleCross);
        if (v > best) best = v;
      }
      memo.set(key, best);
      return best;
    }

    lens.sort(function (x, y) { return y - x; });
    return V(lens.join(','));
  }

  /* ---------------------------------------------------------------- evaluate */

  function evaluate(state) {
    const me = state.current;
    let v = state.scores[me] - state.scores[1 - me];
    const cls = B.classify(state);
    if (cls.capturing.length) {
      v += pendingCaptures(state);
      return v;
    }
    if (!cls.safe.length) return v + chainValue(state);
    // Safe moves remain. Whoever plays the last one forces the other to open
    // the first chain, so the chain-rule value is credited to the player who
    // will NOT have to open: with S safe moves left the mover takes the last
    // one when S is odd, and then the opponent opens.
    const sign = (cls.safe.length % 2 === 0) ? 1 : -1;
    return v + sign * chainValue(state);
  }

  /* ---------------------------------------------------------------- search */

  const zobristCache = new Map();

  function zobristFor(dots) {
    let t = zobristCache.get(dots);
    if (t) return t;
    const total = dots * (dots - 1) * 2;
    const rng = mulberry32(0x9e3779b9 ^ (dots * 2654435761));
    const hi = new Uint32Array(total);
    const lo = new Uint16Array(total);
    for (let i = 0; i < total; i++) {
      hi[i] = (rng() * 4294967296) >>> 0;
      lo[i] = (rng() * 65536) >>> 0;
    }
    t = { hi: hi, lo: lo, turn: (rng() * 4294967296) >>> 0 };
    zobristCache.set(dots, t);
    return t;
  }

  function hashState(state, z) {
    let a = 0;
    let b = 0;
    const h = state.h;
    for (let i = 0; i < h.length; i++) if (h[i]) { a ^= z.hi[i]; b ^= z.lo[i]; }
    const v = state.v;
    const off = h.length;
    for (let i = 0; i < v.length; i++) if (v[i]) { a ^= z.hi[off + i]; b ^= z.lo[off + i]; }
    if (state.current === 1) a ^= z.turn;
    return a * 65536 + b;
  }

  function orderedMoves(state, ttMove) {
    const cls = B.classify(state);
    const out = [];
    const seen = new Set();
    function push(id) {
      if (seen.has(id)) return;
      seen.add(id);
      out.push(id);
    }
    // Captures first, biggest first.
    const caps = cls.capturing.slice();
    caps.sort(function (x, y) {
      const ix = B.edgeInfo(state, x);
      const iy = B.edgeInfo(state, y);
      const ax = B.adjacentBoxes(state, ix);
      const ay = B.adjacentBoxes(state, iy);
      let nx = 0; let ny = 0;
      for (let i = 0; i < ax.length; i++) if (state.boxSides[ax[i]] === 3) nx++;
      for (let i = 0; i < ay.length; i++) if (state.boxSides[ay[i]] === 3) ny++;
      return ny - nx;
    });
    for (let i = 0; i < caps.length; i++) push(caps[i]);
    if (ttMove >= 0 && B.isFree(state, ttMove)) push(ttMove);
    for (let i = 0; i < cls.safe.length; i++) push(cls.safe[i]);
    for (let i = 0; i < cls.damaging.length; i++) push(cls.damaging[i]);
    return out;
  }

  function makeCtx(state, budget) {
    return {
      z: zobristFor(state.dots),
      tt: new Map(),
      nodes: 0,
      nodeCap: budget.nodeCap || 300000,
      endAt: budget.timeMs ? Date.now() + budget.timeMs : 0,
    };
  }

  function terminalScore(state) {
    return state.scores[state.current] - state.scores[1 - state.current];
  }

  function negamax(state, depth, alpha, beta, ctx) {
    ctx.nodes++;
    if ((ctx.nodes & 255) === 0 && ctx.endAt && Date.now() > ctx.endAt) throw CAP;
    if (ctx.nodes > ctx.nodeCap) throw CAP;
    if (state.phase === 'over') return terminalScore(state);
    if (depth <= 0) return evaluate(state);

    const key = hashState(state, ctx.z);
    const ent = ctx.tt.get(key);
    let ttMove = -1;
    if (ent) {
      ttMove = ent.move;
      if (ent.depth >= depth) {
        if (ent.flag === 0) return ent.value;
        if (ent.flag === 1) alpha = Math.max(alpha, ent.value);
        else if (ent.flag === 2) beta = Math.min(beta, ent.value);
        if (alpha >= beta) return ent.value;
      }
    }

    const moves = orderedMoves(state, ttMove);
    if (!moves.length) return terminalScore(state);

    const alpha0 = alpha;
    let best = -Infinity;
    let bestMove = moves[0];
    for (let i = 0; i < moves.length; i++) {
      const sim = B.cloneLight(state);
      B.play(sim, moves[i]);
      // A completed box keeps the turn, so the side to move does NOT always
      // alternate: only negate when possession actually passed.
      const v = sim.current === state.current
        ? negamax(sim, depth - 1, alpha, beta, ctx)
        : -negamax(sim, depth - 1, -beta, -alpha, ctx);
      if (v > best) { best = v; bestMove = moves[i]; }
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    const flag = best <= alpha0 ? 2 : (best >= beta ? 1 : 0);
    ctx.tt.set(key, { depth: depth, value: best, move: bestMove, flag: flag });
    return best;
  }

  function searchRoot(state, budget, info) {
    const ctx = makeCtx(state, budget);
    ctx.depthReached = 0;
    const free = B.freeEdges(state);
    if (!free.length) return null;
    if (free.length === 1) return free[0];

    let rootMoves = orderedMoves(state, -1);
    let bestId = rootMoves[0];
    let bestVal = -Infinity;
    const maxDepth = Math.min(budget.maxDepth || 12, Math.max(free.length, 1));

    for (let depth = 1; depth <= maxDepth; depth++) {
      let iterBest = -Infinity;
      let iterBestId = -1;
      try {
        for (let i = 0; i < rootMoves.length; i++) {
          const sim = B.cloneLight(state);
          B.play(sim, rootMoves[i]);
          const v = sim.current === state.current
            ? negamax(sim, depth - 1, -Infinity, Infinity, ctx)
            : -negamax(sim, depth - 1, -Infinity, Infinity, ctx);
          if (v > iterBest) { iterBest = v; iterBestId = rootMoves[i]; }
          if ((ctx.nodes & 255) === 0 && ctx.endAt && Date.now() > ctx.endAt) throw CAP;
          if (ctx.nodes > ctx.nodeCap) throw CAP;
        }
      } catch (e) {
        if (e !== CAP) throw e;
        break;
      }
      if (iterBestId >= 0) { bestId = iterBestId; bestVal = iterBest; }
      ctx.depthReached = depth;
      // Best move first next iteration.
      const idx = rootMoves.indexOf(bestId);
      if (idx > 0) { rootMoves.splice(idx, 1); rootMoves.unshift(bestId); }
      if (ctx.endAt && Date.now() > ctx.endAt) break;
      if (ctx.nodes > ctx.nodeCap) break;
      if (Math.abs(bestVal) >= 1e6) break;
    }
    if (info) { info.depth = ctx.depthReached; info.nodes = ctx.nodes; }
    return bestId;
  }

  /* ------------------------------------------------------------------ choose */

  function choose(state, level, opts) {
    opts = opts || {};
    const rng = opts.rng || state.rng || Math.random;
    const free = B.freeEdges(state);
    if (!free.length) return null;

    if (level === LEVELS.KID) return randomPick(free, rng);

    if (level === LEVELS.CASUAL) {
      const cls = B.classify(state);
      if (cls.capturing.length) return bestCapture(state, cls.capturing, rng);
      if (cls.safe.length) return randomPick(cls.safe, rng);
      return cheapestDamage(state, cls.damaging, rng);
    }

    const budget = {
      timeMs: opts.timeMs !== undefined ? opts.timeMs : DEFAULT_BUDGET[level].timeMs,
      nodeCap: opts.nodeCap !== undefined ? opts.nodeCap : DEFAULT_BUDGET[level].nodeCap,
      maxDepth: opts.maxDepth !== undefined ? opts.maxDepth : DEFAULT_BUDGET[level].maxDepth,
    };

    // Endgame: solve exactly. Midgame: iterative deepening under the time cap.
    const exactLimit = opts.exactEdges === undefined ? EXACT_EDGES : opts.exactEdges;
    let info = { level: level, free: free.length, depth: 0, nodes: 0, exact: false };
    if (exactLimit > 0 && free.length <= exactLimit) {
      const exact = searchRoot(state, {
        timeMs: Math.min(2500, budget.timeMs * 2),
        nodeCap: Math.max(budget.nodeCap, 900000),
        maxDepth: free.length,
      }, info);
      info.exact = true;
      if (exact !== null) { lastInfo = info; return exact; }
    }
    const id = searchRoot(state, budget, info);
    lastInfo = info;
    return id === null ? randomPick(free, rng) : id;
  }

  return {
    LEVELS: LEVELS,
    DEFAULT_BUDGET: DEFAULT_BUDGET,
    EXACT_EDGES: EXACT_EDGES,
    choose: choose,
    chainValue: chainValue,
    evaluate: evaluate,
    pendingCaptures: pendingCaptures,
    bestCapture: bestCapture,
    cheapestDamage: cheapestDamage,
    searchRoot: searchRoot,
    lastInfo: function () { return lastInfo; },
  };
}));

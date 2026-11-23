/* Boxes — pure game engine. No DOM access, no side effects.
 *
 * A board of `dots x dots` dots has (dots-1) x (dots-1) claimable boxes.
 * Row 0 is the TOP row, column 0 is the LEFT column.
 *
 * Edges are stored in two flat typed arrays:
 *   h[r*(cols-1) + c]   the edge between dot (r,c) and dot (r,c+1)
 *   v[r*cols + c]       the edge between dot (r,c) and dot (r+1,c)
 * Global edge id = index into h for horizontal edges, hCount + index into v
 * for vertical ones, so a move is a single integer.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Boxes = api;
}(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const VER = 1;

  // The spec's board table. `dots` is the dot count per side; boxes = (dots-1)^2.
  const PRESETS = [
    { key: 'quick',   dots: 8,  label: 'Quick',             boxes: 49 },
    { key: 'classic', dots: 11, label: 'Classic Schoolbook', boxes: 100 },
    { key: 'a4',      dots: 15, label: 'A4 Classic',        boxes: 196 },
    { key: 'giant',   dots: 21, label: 'Giant',             boxes: 400 },
  ];
  const MIN_DOTS = 4;
  const MAX_DOTS = 50;

  const DEFAULTS = {
    kid: 'School Kid',
    casual: 'Casual Player',
    competitive: 'Competitive Player',
    grandmaster: 'Grandmaster',
  };

  /* ------------------------------------------------------------- utilities */

  function presetForDots(dots) {
    for (let i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].dots === dots) return PRESETS[i];
    }
    return null;
  }

  function normalizeDots(dots) {
    const n = Math.round(Number(dots));
    if (!isFinite(n)) return 11;
    return Math.min(MAX_DOTS, Math.max(MIN_DOTS, n));
  }

  function boxCountFor(dots) {
    return (dots - 1) * (dots - 1);
  }

  /* ---------------------------------------------------------------- create */

  function createGame(opts) {
    opts = opts || {};
    let dots = normalizeDots(opts.dots !== undefined ? opts.dots : opts.sizeDots);
    if (opts.sizeKey && presetForDots(PRESETS.filter(p => p.key === opts.sizeKey)[0] ? PRESETS.filter(p => p.key === opts.sizeKey)[0].dots : 0)) {
      dots = PRESETS.filter(p => p.key === opts.sizeKey)[0].dots;
    }
    const preset = presetForDots(dots);
    const sizeKey = preset ? preset.key : (opts.sizeKey === 'custom' ? 'custom' : 'custom');
    const names = [
      (opts.names && opts.names[0]) || 'Player 1',
      (opts.names && opts.names[1]) || 'Player 2',
    ];
    const rows = dots;
    const cols = dots;
    const state = {
      ver: VER,
      dots: dots,
      rows: rows,
      cols: cols,
      sizeKey: preset ? preset.key : 'custom',
      sizeLabel: preset ? preset.label : 'Custom',
      names: names,
      h: new Uint8Array(rows * (cols - 1)),
      v: new Uint8Array((rows - 1) * cols),
      box: new Uint8Array((rows - 1) * (cols - 1)),
      boxSides: new Uint8Array((rows - 1) * (cols - 1)),
      scores: [0, 0],
      current: opts.startPlayer === 1 ? 1 : 0,
      phase: 'play',           // 'play' | 'over'
      winner: null,            // 0 | 1 | -1 (draw)
      moves: 0,                // edges drawn
      turns: 1,                // possessions (changes only when no box is taken)
      capturedThisTurn: 0,
      largestTurn: 0,
      lastEdge: null,
      worstDeficit: [0, 0],    // worst score deficit each player has carried
      history: [],
      log: [],
      durationMs: 0,
      startedAt: 0,
      rng: opts.rng || Math.random,
    };
    pushLog(state, state.names[state.current] + ' to open.');
    return state;
  }

  function pushLog(state, message) {
    if (!state.log) return;
    state.log.push(message);
    if (state.log.length > 240) state.log.splice(0, state.log.length - 240);
  }

  /* ------------------------------------------------------------ edge maths */

  function hCount(state) { return state.rows * (state.cols - 1); }
  function vCount(state) { return (state.rows - 1) * state.cols; }
  function edgeTotal(state) { return hCount(state) + vCount(state); }
  function boxesTotal(state) { return (state.rows - 1) * (state.cols - 1); }
  function boxIdx(state, r, c) { return r * (state.cols - 1) + c; }

  // Describe a global edge id.
  function edgeInfo(state, id) {
    const hc = hCount(state);
    if (id < 0 || id >= hc + vCount(state)) return null;
    if (id < hc) {
      const w = state.cols - 1;
      const r = Math.floor(id / w);
      const c = id - r * w;
      return { type: 'h', r: r, c: c, idx: id };
    }
    const j = id - hc;
    const r = Math.floor(j / state.cols);
    const c = j - r * state.cols;
    return { type: 'v', r: r, c: c, idx: j };
  }

  function isFree(state, id) {
    const info = edgeInfo(state, id);
    if (!info) return false;
    return (info.type === 'h' ? state.h : state.v)[info.idx] === 0;
  }

  // Up to two boxes touching an edge, as box indices.
  function adjacentBoxes(state, info) {
    const out = [];
    if (info.type === 'h') {
      // between (r,c) and (r,c+1): box above is (r-1,c), below is (r,c)
      if (info.r > 0) out.push(boxIdx(state, info.r - 1, info.c));
      if (info.r < state.rows - 1) out.push(boxIdx(state, info.r, info.c));
    } else {
      // between (r,c) and (r+1,c): box left is (r,c-1), right is (r,c)
      if (info.c > 0) out.push(boxIdx(state, info.r, info.c - 1));
      if (info.c < state.cols - 1) out.push(boxIdx(state, info.r, info.c));
    }
    return out;
  }

  function freeEdges(state) {
    const out = [];
    const total = edgeTotal(state);
    for (let id = 0; id < total; id++) {
      const info = edgeInfo(state, id);
      if ((info.type === 'h' ? state.h : state.v)[info.idx] === 0) out.push(id);
    }
    return out;
  }

  /* ------------------------------------------------------------------ play */

  // Plays one edge. Completing a box scores it for the current player and
  // grants another turn; otherwise possession passes.
  function play(state, id) {
    if (state.phase !== 'play') return { ok: false, reason: 'over' };
    const info = edgeInfo(state, id);
    if (!info) return { ok: false, reason: 'bad-edge' };
    const arr = info.type === 'h' ? state.h : state.v;
    if (arr[info.idx]) return { ok: false, reason: 'taken' };

    arr[info.idx] = 1;
    state.moves++;
    if (state.history) state.history.push(id);
    state.lastEdge = id;

    const adj = adjacentBoxes(state, info);
    const capturedIds = [];
    for (let i = 0; i < adj.length; i++) {
      const bi = adj[i];
      state.boxSides[bi]++;
      if (state.boxSides[bi] === 4) {
        if (state.box) state.box[bi] = state.current + 1;   // 1 or 2
        state.scores[state.current]++;
        capturedIds.push(bi);
      }
    }

    let continued = false;
    if (capturedIds.length) {
      continued = true;
      state.capturedThisTurn += capturedIds.length;
      if (state.capturedThisTurn > state.largestTurn) state.largestTurn = state.capturedThisTurn;
    } else {
      state.current = 1 - state.current;
      state.turns++;
      state.capturedThisTurn = 0;
    }

    trackDeficit(state);

    if (state.scores[0] + state.scores[1] === boxesTotal(state)) {
      state.phase = 'over';
      state.winner = state.scores[0] === state.scores[1] ? -1
        : (state.scores[0] > state.scores[1] ? 0 : 1);
      pushLog(state, state.winner === -1
        ? 'Draw ' + state.scores[0] + '-' + state.scores[1] + '.'
        : state.names[state.winner] + ' wins ' + Math.max(state.scores[0], state.scores[1])
          + '-' + Math.min(state.scores[0], state.scores[1]) + '.');
    }

    pushLog(state, state.names[continued ? state.current : 1 - state.current]
      + (capturedIds.length
        ? ' takes ' + capturedIds.length + ' box' + (capturedIds.length > 1 ? 'es' : '') + '.'
        : ' draws a line.'));
    return {
      ok: true,
      captured: capturedIds.length,
      capturedIds: capturedIds,
      continued: continued,
      over: state.phase === 'over',
      winner: state.winner,
    };
  }

  function trackDeficit(state) {
    const d = state.scores[0] - state.scores[1];
    if (d < 0) state.worstDeficit[0] = Math.max(state.worstDeficit[0], -d);
    else state.worstDeficit[1] = Math.max(state.worstDeficit[1], d);
  }

  /* -------------------------------------------------------------- classify */

  // Every free edge is exactly one of: captures a box, is safe (creates no
  // three-sided box), or is damaging (hands the opponent a box).
  function classify(state) {
    const capturing = [];
    const safe = [];
    const damaging = [];
    const total = edgeTotal(state);
    for (let id = 0; id < total; id++) {
      const info = edgeInfo(state, id);
      const arr = info.type === 'h' ? state.h : state.v;
      if (arr[info.idx]) continue;
      let hasThree = false;
      let hasTwo = false;
      const adj = adjacentBoxes(state, info);
      for (let i = 0; i < adj.length; i++) {
        const s = state.boxSides[adj[i]];
        if (s === 3) hasThree = true;
        else if (s === 2) hasTwo = true;
      }
      if (hasThree) capturing.push(id);
      else if (hasTwo) damaging.push(id);
      else safe.push(id);
    }
    return { capturing: capturing, safe: safe, damaging: damaging };
  }

  /* ---------------------------------------------------------------- analyse */

  // Chain decomposition. Boxes with two drawn sides are linked when they share
  // an undrawn edge; a component that touches a three-sided box or the outside
  // world is a chain, otherwise it is a loop.
  function analyze(state) {
    const R = state.rows - 1;
    const C = state.cols - 1;
    const N = R * C;
    const parent = new Int32Array(N);
    for (let i = 0; i < N; i++) parent[i] = i;
    function find(x) {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }
    function union(a, b) {
      const ra = find(a); const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }

    const total = edgeTotal(state);
    const hc = hCount(state);
    for (let id = 0; id < total; id++) {
      const info = edgeInfo(state, id);
      const arr = info.type === 'h' ? state.h : state.v;
      if (arr[info.idx]) continue;
      const adj = adjacentBoxes(state, info);
      if (adj.length < 2) continue;
      const a = adj[0]; const b = adj[1];
      if (state.boxSides[a] >= 2 && state.boxSides[b] >= 2) union(a, b);
    }

    const compOf = new Int32Array(N).fill(-1);
    const comps = [];
    for (let bi = 0; bi < N; bi++) {
      const sides = state.boxSides[bi];
      if (sides < 2 || sides > 3) continue;   // ignore untouched and already-owned boxes
      const r = find(bi);
      if (compOf[r] === -1) { compOf[r] = comps.length; comps.push([]); }
      comps[compOf[r]].push(bi);
    }

    const chains = [];
    const loops = [];
    // Component id per box (not per union-find root).
    const boxComp = new Int32Array(N).fill(-1);
    for (let i = 0; i < comps.length; i++) {
      const list = comps[i];
      for (let k = 0; k < list.length; k++) boxComp[list[k]] = i;
    }
    const seenEdge = new Uint8Array(total);
    for (let ci = 0; ci < comps.length; ci++) {
      const boxes = comps[ci];
      let exits = 0;
      let deg3 = 0;
      for (let i = 0; i < boxes.length; i++) {
        const bi = boxes[i];
        if (state.boxSides[bi] === 3) deg3++;
        const r = Math.floor(bi / C);
        const c = bi - r * C;
        // top, bottom, left, right edges of this box (rim edges are flagged as
        // exits by exitEdge, which knows how many neighbours should exist)
        exits += exitEdge(state, seenEdge, ci, boxComp, r, c, 'h', hc);
        exits += exitEdge(state, seenEdge, ci, boxComp, r + 1, c, 'h', hc);
        exits += exitEdge(state, seenEdge, ci, boxComp, r, c, 'v', hc);
        exits += exitEdge(state, seenEdge, ci, boxComp, r, c + 1, 'v', hc);
      }
      const entry = { boxes: boxes, exits: exits, deg3: deg3 };
      if (deg3 > 0 || exits > 0) chains.push(entry);
      else loops.push(entry);
    }

    chains.sort(function (a, b) { return b.boxes.length - a.boxes.length; });
    loops.sort(function (a, b) { return b.boxes.length - a.boxes.length; });

    return { chains: chains, loops: loops, loose: looseBoxes(state) };
  }

  // Count an undrawn edge leaving component `ci` exactly once.
  function exitEdge(state, seenEdge, ci, compOf, er, ec, type, hc) {
    const id = type === 'h' ? er * (state.cols - 1) + ec : hc + er * state.cols + ec;
    if (seenEdge[id]) return 0;
    const info = edgeInfo(state, id);
    const drawn = (info.type === 'h' ? state.h : state.v)[info.idx] === 1;
    if (drawn) return 0;
    seenEdge[id] = 1;
    const adj = adjacentBoxes(state, info);
    // A rim edge has a neighbour that does not exist, so it always leads out.
    const rim = info.type === 'h'
      ? (info.r === 0 || info.r === state.rows - 1)
      : (info.c === 0 || info.c === state.cols - 1);
    if (rim) return 1;
    for (let i = 0; i < adj.length; i++) {
      if (compOf[adj[i]] !== ci) return 1;
    }
    return 0;
  }

  function looseBoxes(state) {
    const out = [];
    const N = boxesTotal(state);
    for (let bi = 0; bi < N; bi++) if (state.boxSides[bi] === 3) out.push(bi);
    return out;
  }

  // How many boxes `player` takes if they keep taking whatever is on offer.
  function captureClosure(state, player) {
    const sim = clone(state);
    let gained = 0;
    let guard = 0;
    while (guard++ < 4096) {
      const caps = classify(sim).capturing;
      if (!caps.length) break;
      // take the edge that completes the most boxes
      let bestId = caps[0];
      let bestN = -1;
      for (let i = 0; i < caps.length; i++) {
        const trial = clone(sim);
        const res = play(trial, caps[i]);
        if (res.ok && res.captured > bestN) { bestN = res.captured; bestId = caps[i]; }
      }
      const res = play(sim, bestId);
      if (!res.ok) break;
      gained += res.captured;
      if (res.over) break;
    }
    return gained;
  }

  /* --------------------------------------------------------------- cloning */

  function clone(state) {
    return {
      ver: state.ver,
      dots: state.dots,
      rows: state.rows,
      cols: state.cols,
      sizeKey: state.sizeKey,
      sizeLabel: state.sizeLabel,
      names: state.names.slice(),
      h: state.h.slice(),
      v: state.v.slice(),
      box: state.box.slice(),
      boxSides: state.boxSides.slice(),
      scores: [state.scores[0], state.scores[1]],
      current: state.current,
      phase: state.phase,
      winner: state.winner,
      moves: state.moves,
      turns: state.turns,
      capturedThisTurn: state.capturedThisTurn,
      largestTurn: state.largestTurn,
      lastEdge: state.lastEdge,
      worstDeficit: [state.worstDeficit[0], state.worstDeficit[1]],
      history: [],
      log: null,
      durationMs: state.durationMs,
      startedAt: state.startedAt,
      rng: state.rng,
    };
  }

  // Search-only clone: no box grid, no history, no log. The AI never reads them.
  function cloneLight(state) {
    return {
      ver: state.ver,
      dots: state.dots,
      rows: state.rows,
      cols: state.cols,
      sizeKey: state.sizeKey,
      sizeLabel: state.sizeLabel,
      names: state.names,
      h: state.h.slice(),
      v: state.v.slice(),
      box: null,
      boxSides: state.boxSides.slice(),
      scores: [state.scores[0], state.scores[1]],
      current: state.current,
      phase: state.phase,
      winner: state.winner,
      moves: state.moves,
      turns: state.turns,
      capturedThisTurn: state.capturedThisTurn,
      largestTurn: state.largestTurn,
      lastEdge: state.lastEdge,
      worstDeficit: [state.worstDeficit[0], state.worstDeficit[1]],
      history: null,
      log: null,
      durationMs: state.durationMs,
      startedAt: state.startedAt,
      rng: state.rng,
    };
  }

  /* -------------------------------------------------------- serialisation */

  function serialize(state) {
    return {
      ver: VER,
      dots: state.dots,
      sizeKey: state.sizeKey,
      sizeLabel: state.sizeLabel,
      names: state.names.slice(),
      h: Array.from(state.h),
      v: Array.from(state.v),
      box: Array.from(state.box),
      scores: state.scores.slice(),
      current: state.current,
      phase: state.phase,
      winner: state.winner,
      moves: state.moves,
      turns: state.turns,
      capturedThisTurn: state.capturedThisTurn,
      largestTurn: state.largestTurn,
      lastEdge: state.lastEdge,
      worstDeficit: state.worstDeficit.slice(),
      history: state.history.slice(),
      log: state.log.slice(-80),
      durationMs: state.durationMs,
      startedAt: state.startedAt,
    };
  }

  function recomputeSides(state) {
    state.boxSides = new Uint8Array(boxesTotal(state));
    const total = edgeTotal(state);
    for (let id = 0; id < total; id++) {
      const info = edgeInfo(state, id);
      const drawn = (info.type === 'h' ? state.h : state.v)[info.idx] === 1;
      if (!drawn) continue;
      const adj = adjacentBoxes(state, info);
      for (let i = 0; i < adj.length; i++) state.boxSides[adj[i]]++;
    }
  }

  function deserialize(data, rng) {
    if (!data || !data.dots) throw new Error('Bad saved game');
    const dots = normalizeDots(data.dots);
    const preset = presetForDots(dots);
    const state = {
      ver: VER,
      dots: dots,
      rows: dots,
      cols: dots,
      sizeKey: data.sizeKey || (preset ? preset.key : 'custom'),
      sizeLabel: data.sizeLabel || (preset ? preset.label : 'Custom'),
      names: (data.names && data.names.length === 2) ? data.names.slice() : ['Player 1', 'Player 2'],
      h: Uint8Array.from(data.h || []),
      v: Uint8Array.from(data.v || []),
      box: Uint8Array.from(data.box || []),
      boxSides: new Uint8Array((dots - 1) * (dots - 1)),
      scores: (data.scores && data.scores.length === 2) ? [data.scores[0] | 0, data.scores[1] | 0] : [0, 0],
      current: data.current === 1 ? 1 : 0,
      phase: data.phase === 'over' ? 'over' : 'play',
      winner: data.winner === undefined ? null : data.winner,
      moves: data.moves | 0,
      turns: data.turns | 0 || 1,
      capturedThisTurn: data.capturedThisTurn | 0,
      largestTurn: data.largestTurn | 0,
      lastEdge: data.lastEdge === undefined ? null : data.lastEdge,
      worstDeficit: (data.worstDeficit && data.worstDeficit.length === 2)
        ? [data.worstDeficit[0] | 0, data.worstDeficit[1] | 0] : [0, 0],
      history: Array.isArray(data.history) ? data.history.slice() : [],
      log: Array.isArray(data.log) ? data.log.slice(-80) : [],
      durationMs: data.durationMs | 0,
      startedAt: data.startedAt | 0,
      rng: rng || Math.random,
    };
    if (state.h.length !== dots * (dots - 1) || state.v.length !== (dots - 1) * dots) {
      throw new Error('Saved game does not match its board size');
    }
    recomputeSides(state);
    return state;
  }

  /* ------------------------------------------------------------- querying */

  function remainingBoxes(state) {
    return boxesTotal(state) - state.scores[0] - state.scores[1];
  }

  function edgeMidpoint(state, id) {
    const info = edgeInfo(state, id);
    if (info.type === 'h') {
      return { x: info.c + 0.5, y: info.r };
    }
    return { x: info.c, y: info.r + 0.5 };
  }

  function nearestEdge(state, x, y, tol) {
    let best = null;
    let bestD = (tol === undefined ? 0.42 : tol) * (tol === undefined ? 0.42 : tol);
    const total = edgeTotal(state);
    for (let id = 0; id < total; id++) {
      const info = edgeInfo(state, id);
      const arr = info.type === 'h' ? state.h : state.v;
      if (arr[info.idx]) continue;
      const mx = info.type === 'h' ? info.c + 0.5 : info.c;
      const my = info.type === 'h' ? info.r : info.r + 0.5;
      const dx = x - mx;
      const dy = y - my;
      const d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = id; }
    }
    return best;
  }

  return {
    VER: VER,
    PRESETS: PRESETS,
    MIN_DOTS: MIN_DOTS,
    MAX_DOTS: MAX_DOTS,
    DIFFICULTY_NAMES: DEFAULTS,
    presetForDots: presetForDots,
    normalizeDots: normalizeDots,
    boxCountFor: boxCountFor,
    createGame: createGame,
    hCount: hCount,
    vCount: vCount,
    edgeTotal: edgeTotal,
    boxesTotal: boxesTotal,
    edgeInfo: edgeInfo,
    isFree: isFree,
    adjacentBoxes: adjacentBoxes,
    freeEdges: freeEdges,
    play: play,
    classify: classify,
    analyze: analyze,
    looseBoxes: looseBoxes,
    captureClosure: captureClosure,
    clone: clone,
    cloneLight: cloneLight,
    serialize: serialize,
    deserialize: deserialize,
    remainingBoxes: remainingBoxes,
    edgeMidpoint: edgeMidpoint,
    nearestEdge: nearestEdge,
  };
}));

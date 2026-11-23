/* Boxes — DOM controller, canvas renderer and turn flow. */
(function () {
  'use strict';

  const B = window.Boxes;
  const AI = window.BoxesAI;
  const ONLINE = window.BoxesOnline;

  const SAVE_KEY = 'boxes.save.v1';
  const STATS_KEY = 'boxes.stats.v1';
  const PREFS_KEY = 'boxes.prefs.v1';

  const SIZE_INFO = {
    quick: { dots: 8, label: 'Quick', boxes: 49, blurb: '8×8 dots = 49 boxes. About 5 to 10 minutes.' },
    classic: { dots: 11, label: 'Classic Schoolbook', boxes: 100, blurb: '11×11 dots = 100 boxes. About 10 to 15 minutes.' },
    a4: { dots: 15, label: 'A4 Classic', boxes: 196, blurb: '15×15 dots = 196 boxes. About 15 to 30 minutes.' },
    giant: { dots: 21, label: 'Giant', boxes: 400, blurb: '21×21 dots = 400 boxes. About 30 to 60 minutes.' },
    custom: { dots: 11, label: 'Custom', boxes: 100, blurb: '' },
  };

  const DIFFICULTY_HELP = {
    kid: 'Plays any legal line at random.',
    casual: 'Takes free boxes and avoids giving you one.',
    competitive: 'Understands chains and looks ahead.',
    grandmaster: 'Chain and parity theory, with an exact endgame solver.',
  };

  /* ------------------------------------------------------------------ state */

  const App = {
    game: null,
    mode: null,            // 'ai' | 'local' | 'online'
    level: 'competitive',
    settings: null,
    session: null,
    onlineSeat: null,
    view: null,
    timers: [],
    worker: null,
    workerSeq: 0,
    workerPending: new Map(),
    thinking: false,
    startedAt: 0,
    customDots: 11,
    prefs: { theme: 'graph', mark: 'initial', assistSafe: false, assistHeat: false, assistPreview: false },
    stats: null,
    pendingHostCode: null,
    toastTimer: null,
  };

  const $ = function (id) { return document.getElementById(id); };

  window.__errors = [];
  window.addEventListener('error', function (e) { window.__errors.push(String(e.message)); });
  window.addEventListener('unhandledrejection', function (e) {
    window.__errors.push('rejection: ' + String(e.reason));
  });

  function schedule(fn, ms) {
    const id = window.setTimeout(function () {
      App.timers = App.timers.filter(function (t) { return t !== id; });
      fn();
    }, ms);
    App.timers.push(id);
    return id;
  }

  function clearTimers() {
    App.timers.forEach(clearTimeout);
    App.timers = [];
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /* --------------------------------------------------------------- storage */

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) Object.assign(App.prefs, JSON.parse(raw));
    } catch (e) { /* ignore */ }
    applyPrefs();
  }

  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(App.prefs)); } catch (e) { /* ignore */ }
    applyPrefs();
  }

  function applyPrefs() {
    document.documentElement.setAttribute('data-theme', App.prefs.theme || 'graph');
    if (App.view) {
      App.view.setMark(App.prefs.mark);
      App.view.setAssist({
        safe: !!App.prefs.assistSafe,
        heat: !!App.prefs.assistHeat,
        preview: !!App.prefs.assistPreview,
      });
    }
  }

  function defaultStats() {
    return {
      games: 0, wins: 0, losses: 0, draws: 0,
      largestChain: 0, largestTurn: 0, longestMs: 0, fastestMs: 0,
      biggestComeback: 0, totalBoxes: 0,
      bySize: {}, record: {}, ach: {},
    };
  }

  function loadStats() {
    try {
      const raw = localStorage.getItem(STATS_KEY);
      App.stats = raw ? Object.assign(defaultStats(), JSON.parse(raw)) : defaultStats();
    } catch (e) { App.stats = defaultStats(); }
  }

  function saveStats() {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(App.stats)); } catch (e) { /* ignore */ }
  }

  function loadSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || data.ver !== 1 || !data.state) return null;
      return data;
    } catch (e) { return null; }
  }

  function clearSave() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  }

  function saveNow() {
    if (!App.game || App.mode === 'online') return;
    if (App.game.phase !== 'play') { clearSave(); return; }
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        ver: 1,
        when: Date.now(),
        mode: App.mode,
        level: App.level,
        settings: App.settings,
        state: B.serialize(App.game),
        startedAt: App.startedAt,
      }));
    } catch (e) { /* ignore */ }
    refreshContinue();
  }

  function saveSoon() { schedule(saveNow, 250); }

  /* ------------------------------------------------------------ achievements */

  const ACHIEVEMENTS = [
    { id: 'first-box', icon: '◻', name: 'First claim', desc: 'Capture your first box.' },
    { id: 'first-win', icon: '★', name: 'First victory', desc: 'Win your first game.' },
    { id: 'chain-5', icon: '⛓', name: 'Chain reaction', desc: 'Take 5 or more boxes in a single turn.' },
    { id: 'chain-10', icon: '⚡', name: 'Double digits', desc: 'Take 10 or more boxes in a single turn.' },
    { id: 'comeback-5', icon: '↺', name: 'Comeback', desc: 'Win after trailing by 5 or more boxes.' },
    { id: 'a4-win', icon: '▤', name: 'A4 campaign', desc: 'Win a game on the 196-box A4 board.' },
    { id: 'giant-win', icon: '▦', name: 'Giant slayer', desc: 'Win a game on the 400-box Giant board.' },
    { id: 'marathon', icon: '≡', name: 'Marathon', desc: 'Play a game of 380 or more lines.' },
    { id: 'century', icon: '100', name: 'Century', desc: 'Score 100 boxes across your career.' },
    { id: 'slayer', icon: '♛', name: 'Grandmaster slayer', desc: 'Beat the Grandmaster.' },
    { id: 'all-rounder', icon: '✦', name: 'All rounder', desc: 'Win on three different board sizes.' },
    { id: 'skin', icon: '◈', name: 'Skin of teeth', desc: 'Win by a single box.' },
  ];

  function unlock(id) {
    if (App.stats.ach[id]) return;
    const def = ACHIEVEMENTS.find(function (a) { return a.id === id; });
    if (!def) return;
    App.stats.ach[id] = Date.now();
    saveStats();
    toast('Achievement unlocked — ' + def.name);
  }

  function checkAchievements() {
    const s = App.game;
    if (!s) return;
    if (s.scores[0] + s.scores[1] >= 1) unlock('first-box');
    if (s.largestTurn >= 5) unlock('chain-5');
    if (s.largestTurn >= 10) unlock('chain-10');
    if (s.moves >= 380) unlock('marathon');
    if (App.stats.totalBoxes + s.scores[0] + s.scores[1] >= 100) unlock('century');

    if (s.phase === 'over' && s.winner !== null && s.winner !== -1) {
      const w = s.winner;
      unlock('first-win');
      if (Math.abs(s.scores[0] - s.scores[1]) === 1) unlock('skin');
      if (s.worstDeficit[w] >= 5) unlock('comeback-5');
      if (s.sizeKey === 'a4') unlock('a4-win');
      if (s.sizeKey === 'giant') unlock('giant-win');
      if (App.mode === 'ai' && w === 0 && App.level === 'grandmaster') unlock('slayer');
      const sizes = new Set();
      Object.keys(App.stats.bySize).forEach(function (k) {
        if (App.stats.bySize[k].wins > 0) sizes.add(k);
      });
      if (sizes.size >= 3) unlock('all-rounder');
    }
  }

  function toast(message) {
    let el = $('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(App.toastTimer);
    App.toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  /* ------------------------------------------------------------- BoardView */

  function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    function g(name) { return (cs.getPropertyValue(name) || '').trim(); }
    return {
      paper: g('--paper'),
      gridMinor: g('--grid-minor'),
      gridMajor: g('--grid-major'),
      dot: g('--dot'),
      ink: g('--ink'),
      inkSoft: g('--ink-soft'),
      panel: g('--panel'),
      line: g('--line'),
      accent: g('--accent'),
      p1: g('--p1'),
      p1Soft: g('--p1-soft'),
      p1Line: g('--p1-line'),
      p2: g('--p2'),
      p2Soft: g('--p2-soft'),
      p2Line: g('--p2-line'),
      good: g('--good'),
      warn: g('--warn'),
    };
  }

  function BoardView(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { s: 40, ox: 0, oy: 0 };
    this.pad = 0.55;
    this.state = null;
    this.owners = { h: null, v: null };
    this.anims = [];
    this.hover = null;
    this.mark = 'initial';
    this.assist = { safe: false, heat: false, preview: false };
    this.colors = themeColors();
    this.dirty = true;
    this._key = '';
    this.pointers = new Map();
    this.drag = null;
    this.pinch = null;
    this._fittedDots = null;
    this._lastPointerDown = 0;
    this._dots = null;
    this._lastEdge = null;
    this._raf = false;
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;
    this._bind();
  }

  BoardView.prototype.setState = function (state) {
    const key = state ? (state.dots + ':' + state.history.length + ':' + state.moves) : '';
    if (this.state && state && this.state.dots === state.dots && this._key === key) {
      this.state = state;
      this.dirty = true;
      return;
    }
    this._key = key;
    const boardChanged = this._dots !== state.dots;
    this._dots = state.dots;
    this.state = state;
    this.rebuildOwners();
    // A new board clears leftover animation; an ordinary move keeps its box
    // fills so they are not cut short by the re-render.
    if (boardChanged) this.anims = [];
    // A newly reported line (an opponent's move online) draws itself in.
    if (state && state.lastEdge !== null && state.lastEdge !== undefined && state.lastEdge !== this._lastEdge) {
      this._lastEdge = state.lastEdge;
      this.anims.push({ kind: 'edge', id: state.lastEdge, dur: 110, t0: performance.now() });
    }
    this.dirty = true;
  };

  BoardView.prototype.rebuildOwners = function () {
    const st = this.state;
    if (!st) { this.owners = { h: null, v: null }; return; }
    const h = new Uint8Array(st.h.length);
    const v = new Uint8Array(st.v.length);
    if (st.history && st.history.length) {
      const sim = B.createGame({ dots: st.dots, names: st.names });
      for (let i = 0; i < st.history.length; i++) {
        const id = st.history[i];
        const info = B.edgeInfo(sim, id);
        const arr = info.type === 'h' ? sim.h : sim.v;
        if (arr[info.idx]) continue;
        if (info.type === 'h') h[info.idx] = sim.current + 1;
        else v[info.idx] = sim.current + 1;
        B.play(sim, id);
      }
    }
    this.owners = { h: h, v: v };
    this.dirty = true;
  };

  BoardView.prototype.setMark = function (m) { this.mark = m; this.dirty = true; };
  BoardView.prototype.setAssist = function (a) { this.assist = a; this.dirty = true; };
  BoardView.prototype.refreshTheme = function () { this.colors = themeColors(); this.dirty = true; };

  BoardView.prototype.resize = function () {
    const wrap = this.canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.dpr = dpr;
    this.cssW = w;
    this.cssH = h;
    // A new board size re-fits; an ordinary window resize keeps the player's
    // pan and zoom.
    if (this.state && this._fittedDots !== this.state.dots) this.fit();
    this.invalidate();
  };

  BoardView.prototype.fitScale = function () {
    const st = this.state;
    if (!st) return 20;
    const bw = st.cols + this.pad * 2;
    const bh = st.rows + this.pad * 2;
    return Math.min(this.cssW / bw, this.cssH / bh) * 0.94;
  };

  BoardView.prototype.fit = function () {
    const st = this.state;
    if (!st) return;
    // The board can be measured before its screen is visible; skip those.
    if (this.cssW < 60 || this.cssH < 60) return;
    const s = this.fitScale();
    this.cam.s = s;
    this.cam.ox = (this.cssW - st.cols * s) / 2;
    this.cam.oy = (this.cssH - st.rows * s) / 2;
    this._fittedDots = st.dots;
    this.dirty = true;
  };

  BoardView.prototype.center = function () {
    const st = this.state;
    if (!st) return;
    this.cam.ox = (this.cssW - st.cols * this.cam.s) / 2;
    this.cam.oy = (this.cssH - st.rows * this.cam.s) / 2;
    this.dirty = true;
  };

  BoardView.prototype.zoomAt = function (sx, sy, factor) {
    const st = this.state;
    if (!st) return;
    const fit = this.fitScale();
    let s = this.cam.s * factor;
    s = Math.max(fit * 0.55, Math.min(fit * 9, s));
    const wx = (sx - this.cam.ox) / this.cam.s;
    const wy = (sy - this.cam.oy) / this.cam.s;
    this.cam.s = s;
    this.cam.ox = sx - wx * s;
    this.cam.oy = sy - wy * s;
    this.dirty = true;
  };

  BoardView.prototype.screenToWorld = function (sx, sy) {
    return { x: (sx - this.cam.ox) / this.cam.s, y: (sy - this.cam.oy) / this.cam.s };
  };

  BoardView.prototype.pickEdge = function (sx, sy) {
    const st = this.state;
    if (!st) return null;
    const w = this.screenToWorld(sx, sy);
    const tol = Math.max(0.1, Math.min(0.45, 14 / this.cam.s));
    return B.nearestEdge(st, w.x, w.y, tol);
  };

  BoardView.prototype.pushAnim = function (entries) {
    const now = performance.now();
    for (let i = 0; i < entries.length; i++) {
      this.anims.push(Object.assign({ t0: now }, entries[i]));
    }
    this.invalidate();
  };

  BoardView.prototype.invalidate = function () {
    this.dirty = true;
    if (!this._raf) this._loop();
  };

  BoardView.prototype._loop = function () {
    const self = this;
    this._raf = true;
    function frame() {
      const now = performance.now();
      let busy = false;
      if (self.anims.length) {
        self.anims = self.anims.filter(function (a) { return now - a.t0 < a.dur; });
        if (self.anims.length) busy = true;
      }
      if (self.dirty || busy) {
        self.render(now);
        self.dirty = false;
      }
      if (busy) {
        window.requestAnimationFrame(frame);
      } else {
        self._raf = false;
        self.render(now);
      }
    }
    window.requestAnimationFrame(frame);
  };

  /* ------------------------------------------------------------- rendering */

  BoardView.prototype.render = function (now) {
    const ctx = this.ctx;
    const st = this.state;
    if (!st || !this.cssW) return;
    const cam = this.cam;
    const dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const C = this.colors;
    const W = this.cssW;
    const H = this.cssH;

    ctx.fillStyle = C.paper;
    ctx.fillRect(0, 0, W, H);

    const s = cam.s;
    const bx = cam.ox;
    const by = cam.oy;
    const bw = st.cols * s;
    const bh = st.rows * s;

    // Paper sheet.
    ctx.fillStyle = C.paper;
    ctx.strokeStyle = C.gridMajor;
    ctx.lineWidth = 1;
    roundRect(ctx, bx - this.pad * s, by - this.pad * s, bw + 2 * this.pad * s, bh + 2 * this.pad * s, 8);
    ctx.fill();

    // Grid.
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx - this.pad * s, by - this.pad * s, bw + 2 * this.pad * s, bh + 2 * this.pad * s);
    ctx.clip();
    if (s > 3) {
      ctx.lineWidth = 1;
      for (let i = 0; i <= st.cols; i++) {
        ctx.strokeStyle = (i % 5 === 0) ? C.gridMajor : C.gridMinor;
        ctx.beginPath();
        ctx.moveTo(bx + i * s, by);
        ctx.lineTo(bx + i * s, by + bh);
        ctx.stroke();
      }
      for (let j = 0; j <= st.rows; j++) {
        ctx.strokeStyle = (j % 5 === 0) ? C.gridMajor : C.gridMinor;
        ctx.beginPath();
        ctx.moveTo(bx, by + j * s);
        ctx.lineTo(bx + bw, by + j * s);
        ctx.stroke();
      }
    }
    ctx.restore();

    // Assist underlay for free edges.
    if (this.assist.heat || this.assist.safe) {
      const cls = B.classify(st);
      const r = Math.max(1.4, Math.min(3.4, s * 0.07));
      const draw = function (ids, color) {
        ctx.fillStyle = color;
        for (let i = 0; i < ids.length; i++) {
          const m = B.edgeMidpoint(st, ids[i]);
          ctx.beginPath();
          ctx.arc(bx + m.x * s, by + m.y * s, r, 0, Math.PI * 2);
          ctx.fill();
        }
      };
      if (this.assist.heat) {
        draw(cls.safe, C.good);
        draw(cls.damaging, C.warn);
        draw(cls.capturing, C.accent);
      } else {
        draw(cls.safe, C.good);
      }
    }

    // Claimed boxes.
    const C1 = st.cols - 1;
    for (let bi = 0; bi < st.box.length; bi++) {
      const p = st.box[bi];
      if (!p) continue;
      const r = Math.floor(bi / C1);
      const c = bi - r * C1;
      const x = bx + c * s;
      const y = by + r * s;
      const col = p === 1 ? C.p1 : C.p2;
      const soft = p === 1 ? C.p1Soft : C.p2Soft;
      let alpha = 1;
      let grow = 1;
      for (let k = 0; k < this.anims.length; k++) {
        const a = this.anims[k];
        if (a.kind === 'box' && a.box === bi) {
          const t = Math.min(1, (now - a.t0) / a.dur);
          alpha = t;
          grow = 0.55 + 0.45 * easeOut(t);
        }
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = soft;
      const inset = s * 0.09 * (2 - grow);
      roundRect(ctx, x + inset, y + inset, s - inset * 2, s - inset * 2, Math.max(1, s * 0.09));
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1, s * 0.045);
      ctx.stroke();
      ctx.globalAlpha = 1;

      if (s >= 13 && this.mark !== 'none') {
        const cx = x + s / 2;
        const cy = y + s / 2;
        ctx.fillStyle = col;
        if (this.mark === 'star') {
          drawStar(ctx, cx, cy, Math.min(s * 0.3, 16));
        } else {
          const name = st.names[p - 1] || ('P' + p);
          const ch = (name.trim().charAt(0) || ('P' + p)).toUpperCase();
          const fs = Math.min(s * 0.5, 30);
          ctx.font = '700 ' + fs + 'px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(ch, cx, cy + fs * 0.04);
        }
      }
    }

    // Drawn edges.
    const lw = Math.max(1.6, Math.min(9, s * 0.11));
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    const totalEdges = st.h.length + st.v.length;
    for (let id = 0; id < totalEdges; id++) {
      const info = B.edgeInfo(st, id);
      const arr = info.type === 'h' ? st.h : st.v;
      if (!arr[info.idx]) continue;
      const own = info.type === 'h' ? this.owners.h[info.idx] : this.owners.v[info.idx];
      const col = own === 2 ? C.p2Line : (own === 1 ? C.p1Line : C.inkSoft);
      const ax = info.c;
      const ay = info.type === 'h' ? info.r : info.r + 0.5;
      const ex0 = info.type === 'h' ? info.c + 1 : info.c;
      const ey0 = info.type === 'h' ? info.r : info.r + 0.5;
      let ex = ex0;
      let ey = ey0;
      for (let k = 0; k < this.anims.length; k++) {
        const a = this.anims[k];
        if (a.kind === 'edge' && a.id === id) {
          const t = easeOut(Math.min(1, (now - a.t0) / a.dur));
          ex = ax + (ex0 - ax) * t;
          ey = ay + (ey0 - ay) * t;
        }
      }
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(bx + ax * s, by + ay * s);
      ctx.lineTo(bx + ex * s, by + ey * s);
      ctx.stroke();
    }

    // Hover ghost.
    if (this.hover !== null && this.assist.preview && B.isFree(st, this.hover)) {
      const info = B.edgeInfo(st, this.hover);
      const ax = info.c;
      const ay = info.type === 'h' ? info.r : info.r + 0.5;
      const ex = info.type === 'h' ? info.c + 1 : info.c;
      const ey = info.type === 'h' ? info.r : info.r + 0.5;
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = st.current === 0 ? C.p1Line : C.p2Line;
      ctx.lineWidth = lw;
      ctx.setLineDash([Math.max(3, s * 0.12), Math.max(3, s * 0.1)]);
      ctx.beginPath();
      ctx.moveTo(bx + ax * s, by + ay * s);
      ctx.lineTo(bx + ex * s, by + ey * s);
      ctx.stroke();
      ctx.restore();
    }

    // Dots.
    const dotR = Math.max(1.6, Math.min(6, s * 0.085));
    ctx.fillStyle = C.dot;
    ctx.beginPath();
    for (let r = 0; r < st.rows; r++) {
      for (let c = 0; c < st.cols; c++) {
        ctx.moveTo(bx + c * s + dotR, by + r * s);
        ctx.arc(bx + c * s, by + r * s, dotR, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  };

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  function drawStar(ctx, cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const ang = -Math.PI / 2 + i * Math.PI / 5;
      const rad = i % 2 === 0 ? r : r * 0.45;
      const x = cx + Math.cos(ang) * rad;
      const y = cy + Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }

  /* ----------------------------------------------------------------- input */

  BoardView.prototype._bind = function () {
    const self = this;
    const cv = this.canvas;

    cv.addEventListener('pointerdown', function (e) {
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      self._lastPointerDown = performance.now();
      const rect = cv.getBoundingClientRect();
      const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      self.pointers.set(e.pointerId, pt);
      if (self.pointers.size === 1) {
        self.drag = { x: pt.x, y: pt.y, ox: self.cam.ox, oy: self.cam.oy, moved: false, t: performance.now() };
        self.pinch = null;
      } else if (self.pointers.size === 2) {
        const pts = Array.from(self.pointers.values());
        self.pinch = {
          d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
          s: self.cam.s,
          cx: (pts[0].x + pts[1].x) / 2,
          cy: (pts[0].y + pts[1].y) / 2,
          ox: self.cam.ox,
          oy: self.cam.oy,
        };
        self.drag = null;
      }
    });

    cv.addEventListener('pointermove', function (e) {
      const rect = cv.getBoundingClientRect();
      const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (self.pointers.has(e.pointerId)) self.pointers.set(e.pointerId, pt);

      if (self.pinch && self.pointers.size >= 2) {
        const pts = Array.from(self.pointers.values());
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const cx = (pts[0].x + pts[1].x) / 2;
        const cy = (pts[0].y + pts[1].y) / 2;
        const fit = self.fitScale();
        let s = self.pinch.s * (d / Math.max(20, self.pinch.d));
        s = Math.max(fit * 0.55, Math.min(fit * 9, s));
        const worldX = (self.pinch.cx - self.pinch.ox) / self.pinch.s;
        const worldY = (self.pinch.cy - self.pinch.oy) / self.pinch.s;
        self.cam.s = s;
        self.cam.ox = cx - worldX * s;
        self.cam.oy = cy - worldY * s;
        self.dirty = true;
        self._clearHover();
        return;
      }

      if (self.drag) {
        const dx = pt.x - self.drag.x;
        const dy = pt.y - self.drag.y;
        if (!self.drag.moved && Math.hypot(dx, dy) > 5) self.drag.moved = true;
        if (self.drag.moved) {
          self.cam.ox = self.drag.ox + dx;
          self.cam.oy = self.drag.oy + dy;
          self.dirty = true;
          self._clearHover();
          return;
        }
      }

      self._updateHover(pt.x, pt.y);
    });

    function endPointer(e) {
      const wasDrag = self.drag;
      self.pointers.delete(e.pointerId);
      if (self.pointers.size < 2) self.pinch = null;
      if (self.pointers.size === 0) {
        self.drag = null;
        if (wasDrag && !wasDrag.moved && performance.now() - wasDrag.t < 600) {
          self._tap(wasDrag.x, wasDrag.y);
        }
      }
    }
    cv.addEventListener('pointerup', endPointer);
    cv.addEventListener('pointercancel', endPointer);

    cv.addEventListener('pointerleave', function () { self._clearHover(); });
    // Fallback for environments that deliver a plain click without pointer
    // events (some assistive tech and test drivers). Ignored when pointer
    // events already handled the same tap.
    cv.addEventListener('click', function (e) {
      if (performance.now() - self._lastPointerDown < 600) return;
      const rect = cv.getBoundingClientRect();
      self._tap(e.clientX - rect.left, e.clientY - rect.top);
    });
    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0016);
      self.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    }, { passive: false });

    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  };

  BoardView.prototype._updateHover = function (sx, sy) {
    const id = this.pickEdge(sx, sy);
    if (id !== this.hover) {
      this.hover = id;
      this.canvas.style.cursor = id === null ? 'crosshair' : 'pointer';
      this.invalidate();
    }
  };

  BoardView.prototype._clearHover = function () {
    if (this.hover !== null) {
      this.hover = null;
      this.canvas.style.cursor = 'crosshair';
      this.invalidate();
    }
  };

  BoardView.prototype._tap = function (sx, sy) {
    const id = this.pickEdge(sx, sy);
    if (id === null) return;
    onBoardTap(id);
  };

  /* --------------------------------------------------------------- screens */

  const SCREENS = ['home', 'setup', 'online', 'game', 'stats', 'achievements', 'settings'];

  function showScreen(name) {
    SCREENS.forEach(function (s) {
      const el = $('screen-' + s);
      if (el) el.hidden = (s !== name);
    });
    window.scrollTo(0, 0);
    if (name === 'game' && App.view) {
      App.view.resize();
      App.view.invalidate();
    }
    if (name === 'stats') renderStats();
    if (name === 'achievements') renderAchievements();
  }

  function gotoHome() {
    clearTimers();
    if (App.session) { App.session.leave(); App.session = null; }
    App.game = null;
    App.mode = null;
    App.thinking = false;
    setConnStatus('');
    refreshContinue();
    showScreen('home');
  }

  function refreshContinue() {
    const save = loadSave();
    $('btn-continue').hidden = !save;
  }

  /* ------------------------------------------------------------- game setup */

  function checkedValue(name) {
    const el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }

  // Keep the mode pills, the difficulty row and the second name box in step.
  function syncModeForm() {
    const mode = App.mode === 'local' ? 'local' : 'ai';
    document.querySelectorAll('input[name="gamemode"]').forEach(function (el) {
      el.checked = el.value === mode;
    });
    $('field-difficulty').style.display = mode === 'ai' ? '' : 'none';
    $('name-2').disabled = mode === 'ai';
    if (mode === 'ai') $('name-2').value = 'AI';
    else if ($('name-2').value === 'AI') $('name-2').value = '';
    $('setup-title').textContent = mode === 'ai' ? 'Play vs AI' : 'Pass & Play';
    $('mode-help').textContent = mode === 'ai'
      ? 'Play against the computer on this device.'
      : 'One device, two players, alternating turns.';
    $('difficulty-help').textContent = DIFFICULTY_HELP[checkedValue('difficulty')];
  }

  function readSetupForm() {
    const mode = App.mode;
    const sizeKey = checkedValue('size') || 'classic';
    const info = SIZE_INFO[sizeKey];
    let dots = info.dots;
    if (sizeKey === 'custom') dots = App.customDots || 11;
    const names = [
      ($('name-1').value || '').trim() || 'Player 1',
      ($('name-2').value || '').trim() || (mode === 'ai' ? 'AI' : 'Player 2'),
    ];
    return {
      mode: mode,
      dots: dots,
      sizeKey: sizeKey,
      names: names,
      level: checkedValue('difficulty') || 'competitive',
    };
  }

  function startGame(settings) {
    App.settings = settings;
    App.mode = settings.mode;
    App.level = settings.level || 'casual';
    App.game = B.createGame({ dots: settings.dots, names: settings.names });
    App.startedAt = Date.now();
    App.thinking = false;
    App.customDots = settings.dots;
    App.view.setState(App.game);
    App.view.fit();
    hideOverlay();
    showScreen('game');
    saveNow();
    afterAction();
  }

  /* -------------------------------------------------------------- rendering */

  function playerLabel(i) {
    if (!App.game) return '';
    return App.game.names[i] || ('Player ' + (i + 1));
  }

  function renderScore() {
    const s = App.game;
    $('name-0').textContent = playerLabel(0);
    $('name-1').textContent = playerLabel(1);
    $('score-val-0').textContent = String(s.scores[0]);
    $('score-val-1').textContent = String(s.scores[1]);
    $('remaining').textContent = String(B.remainingBoxes(s));
    $('score-0').classList.toggle('active', s.current === 0 && s.phase === 'play');
    $('score-1').classList.toggle('active', s.current === 1 && s.phase === 'play');
  }

  function renderBanner() {
    const s = App.game;
    const el = $('turn-banner');
    el.classList.remove('p0', 'p1', 'active');
    if (s.phase === 'over') {
      el.textContent = s.winner === -1 ? 'Draw' : playerLabel(s.winner) + ' wins';
      return;
    }
    const who = playerLabel(s.current);
    if (App.mode === 'ai') {
      el.textContent = s.current === 0 ? 'Your turn' : who + ' is thinking…';
    } else if (App.mode === 'online') {
      el.textContent = s.current === App.onlineSeat ? 'Your turn' : who + '’s turn';
    } else {
      el.textContent = who + '’s turn';
    }
    el.classList.add(s.current === 0 ? 'p0' : 'p1');
    el.classList.add('active');
  }

  function renderLog() {
    const s = App.game;
    const box = $('log');
    const entries = s.log.slice(-50);
    box.innerHTML = entries.map(function (line) {
      const important = /wins|takes \d+ boxes/.test(line);
      return '<div class="log-entry' + (important ? ' important' : '') + '">' + escapeHtml(line) + '</div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  function renderAll() {
    if (!App.game) return;
    renderScore();
    renderBanner();
    renderLog();
    App.view.setState(App.game);
    App.view.invalidate();
    $('btn-rematch').hidden = App.game.phase !== 'over';
  }

  /* -------------------------------------------------------------- overlays */

  function showOverlay(html) {
    $('overlay-card').innerHTML = html;
    $('overlay').hidden = false;
  }

  function hideOverlay() {
    $('overlay').hidden = true;
    $('overlay-card').innerHTML = '';
  }

  function outcomeHeading() {
    const s = App.game;
    const w = s.winner;
    if (w === -1) return 'A draw';
    if (App.mode === 'online') return w === App.onlineSeat ? 'You win!' : 'You lose.';
    if (App.mode === 'ai') return w === 0 ? 'You win!' : 'You lose.';
    return playerLabel(w) + ' wins';
  }

  function gameOverDetail() {
    const s = App.game;
    const a = B.analyze(s);
    const bits = [];
    const longest = Math.max(0,
      a.chains.reduce(function (m, c) { return Math.max(m, c.boxes.length); }, 0),
      a.loops.reduce(function (m, c) { return Math.max(m, c.boxes.length); }, 0));
    if (longest >= 3) bits.push('longest chain on the page: ' + longest + ' boxes');
    if (s.largestTurn >= 2) bits.push('biggest single turn: ' + s.largestTurn + ' boxes');
    return bits.join(' · ');
  }

  function showGameOver() {
    const s = App.game;
    const online = App.mode === 'online';
    const canRematch = !online || App.onlineSeat === 0;
    const detail = gameOverDetail();
    showOverlay(
      '<h2>' + escapeHtml(outcomeHeading()) + '</h2>' +
      '<p class="scoreline">' + s.scores[0] + ' – ' + s.scores[1] + '</p>' +
      '<p class="reason">' + escapeHtml(playerLabel(0) + ' vs ' + playerLabel(1) + ' · ' + s.sizeLabel) + '</p>' +
      (detail ? '<p class="reason">' + escapeHtml(detail) + '</p>' : '') +
      '<div class="form-actions">' +
      '<button class="btn primary" id="btn-overlay-rematch" type="button">' +
        (online && !canRematch ? 'Request rematch' : 'Rematch') + '</button>' +
      '<button class="btn ghost" id="btn-overlay-quit" type="button">Quit to menu</button>' +
      '</div>'
    );
    $('btn-overlay-rematch').addEventListener('click', function () {
      hideOverlay();
      if (online) {
        App.session.rematch();
      } else {
        startGame(App.settings);
      }
    });
    $('btn-overlay-quit').addEventListener('click', gotoHome);
  }

  function showHowTo() {
    showOverlay(
      '<h2>How to play</h2>' +
      '<ul class="rules-list">' +
      '<li>Players take turns drawing one line between two neighbouring dots.</li>' +
      '<li>Draw the <strong>fourth side</strong> of a square and the box is yours: it fills with your colour and initial, and you score one point.</li>' +
      '<li>Completing a box gives you <strong>another turn</strong> right away.</li>' +
      '<li>When the page is full, the player with the most boxes wins.</li>' +
      '<li>A turn can sweep a whole chain &mdash; the endgame is where games are decided.</li>' +
      '<li><strong>Pan:</strong> drag. <strong>Zoom:</strong> mouse wheel or pinch. <strong>Play:</strong> click or tap the gap between two dots.</li>' +
      '</ul>' +
      '<div class="form-actions"><button class="btn primary" id="btn-close-howto" type="button">Got it</button></div>'
    );
    $('btn-close-howto').addEventListener('click', hideOverlay);
  }

  /* -------------------------------------------------------------- game flow */

  function canHumanAct() {
    const s = App.game;
    if (!s || s.phase !== 'play' || App.thinking) return false;
    if (App.mode === 'online') return s.current === App.onlineSeat;
    if (App.mode === 'ai') return s.current === 0;
    return true;
  }

  function onBoardTap(id) {
    if (!canHumanAct()) return;
    const s = App.game;
    if (!B.isFree(s, id)) return;
    if (App.mode === 'online') {
      if (App.onlineSeat === 0) App.session.hostMove(id);
      else App.session.guestMove(id);
      return;
    }
    applyMove(id);
  }

  function applyMove(id) {
    const s = App.game;
    const res = B.play(s, id);
    if (!res.ok) return;
    const anims = [{ kind: 'edge', id: id, dur: 110 }];
    for (let i = 0; i < res.capturedIds.length; i++) {
      anims.push({ kind: 'box', box: res.capturedIds[i], dur: 220 });
    }
    App.view.pushAnim(anims);
    saveSoon();
    afterAction();
  }

  function afterAction() {
    const s = App.game;
    if (!s) return;
    renderAll();
    checkAchievements();
    if (s.phase === 'over') {
      clearSave();
      recordResult();
      saveStats();
      checkAchievements();
      renderAll();
      showGameOver();
      return;
    }
    if (App.mode === 'online') return;
    if (App.mode === 'ai' && s.current === 1) schedule(aiMove, 620);
  }

  /* ------------------------------------------------------------------- AI */

  function ensureWorker() {
    if (App.worker === null) {
      App.worker = false;
      try {
        const w = new Worker('ai-worker.js');
        w.onmessage = function (e) {
          const d = e.data;
          const pending = App.workerPending.get(d.seq);
          if (!pending) return;
          App.workerPending.delete(d.seq);
          if (d.ok) pending.resolve(d.id);
          else pending.reject(new Error(d.error || 'AI failed'));
        };
        w.onerror = function () {
          App.workerPending.forEach(function (p) { p.reject(new Error('AI worker error')); });
          App.workerPending.clear();
        };
        App.worker = w;
      } catch (e) {
        App.worker = false;
      }
    }
    return App.worker || null;
  }

  function aiBudget() {
    if (App.level === 'kid' || App.level === 'casual') {
      return { timeMs: 1, nodeCap: 1, maxDepth: 0 };
    }
    if (App.level === 'grandmaster') {
      return { timeMs: 950, nodeCap: 900000, maxDepth: 60, exactEdges: 16 };
    }
    return { timeMs: 260, nodeCap: 220000, maxDepth: 8, exactEdges: 0 };
  }

  function runAiMove() {
    const s = App.game;
    const level = App.level;
    const budget = aiBudget();
    const snapshot = B.serialize(s);

    const light = level === 'kid' || level === 'casual';
    const w = light ? null : ensureWorker();
    if (w) {
      return new Promise(function (resolve, reject) {
        const seq = ++App.workerSeq;
        App.workerPending.set(seq, { resolve: resolve, reject: reject });
        w.postMessage({ seq: seq, state: snapshot, level: level, budget: budget });
      }).catch(function () {
        return AI.choose(B.deserialize(snapshot), level, budget);
      });
    }
    // Light levels run inline; defer a tick so the "thinking" banner paints.
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve(AI.choose(B.deserialize(snapshot), level, budget));
      }, 30);
    });
  }

  function aiMove() {
    const s = App.game;
    if (App.mode !== 'ai' || !s || s.current !== 1 || s.phase !== 'play') return;
    App.thinking = true;
    renderBanner();
    runAiMove().then(function (id) {
      App.thinking = false;
      if (id === null || id === undefined) { renderBanner(); return; }
      if (!App.game || App.game.phase !== 'play' || App.game.current !== 1) { renderBanner(); return; }
      applyMove(id);
    }).catch(function () {
      App.thinking = false;
      const free = B.freeEdges(App.game);
      if (free.length) applyMove(free[0]);
    });
  }

  /* ----------------------------------------------------------------- stats */

  function recordResult() {
    const s = App.game;
    const st = App.stats;
    const ms = App.startedAt ? (Date.now() - App.startedAt) : 0;
    st.games++;
    if (s.winner === -1) st.draws++;
    else if (s.winner === 0) st.wins++;
    else st.losses++;

    st.largestTurn = Math.max(st.largestTurn, s.largestTurn);
    const a = B.analyze(s);
    const longest = Math.max(0,
      a.chains.reduce(function (m, c) { return Math.max(m, c.boxes.length); }, 0),
      a.loops.reduce(function (m, c) { return Math.max(m, c.boxes.length); }, 0));
    st.largestChain = Math.max(st.largestChain, longest);
    if (s.winner !== null && s.winner !== -1) {
      st.biggestComeback = Math.max(st.biggestComeback, s.worstDeficit[s.winner]);
    }
    if (st.fastestMs === 0 || ms < st.fastestMs) st.fastestMs = ms;
    st.longestMs = Math.max(st.longestMs, ms);
    st.totalBoxes += s.scores[0] + s.scores[1];

    const key = String(s.dots);
    if (!st.bySize[key]) st.bySize[key] = { games: 0, p1: 0, p2: 0, draws: 0, points: 0, moves: 0, wins: 0 };
    const row = st.bySize[key];
    row.games++;
    row.points += s.scores[0] + s.scores[1];
    row.moves += s.moves;
    if (s.winner === 0) row.p1++;
    else if (s.winner === 1) row.p2++;
    else row.draws++;
    if (s.winner === 0 || s.winner === 1) row.wins++;

    [0, 1].forEach(function (i) {
      const name = s.names[i] || ('Player ' + (i + 1));
      if (!st.record[name]) st.record[name] = { w: 0, l: 0, d: 0 };
      if (s.winner === -1) st.record[name].d++;
      else if (s.winner === i) st.record[name].w++;
      else st.record[name].l++;
    });
  }

  function fmtMs(ms) {
    if (!ms) return '—';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return sec + 's';
    return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
  }

  function renderStats() {
    const st = App.stats;
    const winRate = st.games ? Math.round((100 * st.wins) / st.games) : 0;
    let html = '';
    html += '<h3 class="section-title">General</h3>';
    html += '<table class="stats-table"><tbody>';
    const rows = [
      ['Games played', st.games],
      ['Wins', st.wins],
      ['Losses', st.losses],
      ['Draws', st.draws],
      ['Win rate', winRate + '%'],
      ['Largest chain on the page', st.largestChain],
      ['Largest single turn', st.largestTurn],
      ['Longest game', fmtMs(st.longestMs)],
      ['Fastest victory', fmtMs(st.fastestMs)],
      ['Biggest comeback', st.biggestComeback ? st.biggestComeback + ' boxes' : '—'],
      ['Career boxes', st.totalBoxes],
    ];
    rows.forEach(function (r) {
      html += '<tr><td>' + r[0] + '</td><td class="num">' + r[1] + '</td></tr>';
    });
    html += '</tbody></table>';

    const sizes = Object.keys(st.bySize).sort(function (a, b) { return Number(a) - Number(b); });
    if (sizes.length) {
      html += '<h3 class="section-title">By board size</h3><table class="stats-table"><thead><tr>' +
        '<th>Dots</th><th>Games</th><th>Player 1</th><th>Player 2</th><th>Draws</th>' +
        '<th>Avg score</th><th>Avg lines</th></tr></thead><tbody>';
      sizes.forEach(function (k) {
        const r = st.bySize[k];
        html += '<tr><td class="num">' + k + '</td><td class="num">' + r.games + '</td>' +
          '<td class="num">' + r.p1 + '</td><td class="num">' + r.p2 + '</td>' +
          '<td class="num">' + r.draws + '</td><td class="num">' + (r.points / r.games).toFixed(1) + '</td>' +
          '<td class="num">' + (r.moves / r.games).toFixed(0) + '</td></tr>';
      });
      html += '</tbody></table>';
    }

    const names = Object.keys(st.record);
    if (names.length) {
      html += '<h3 class="section-title">By player</h3><table class="stats-table"><thead><tr>' +
        '<th>Player</th><th>Won</th><th>Lost</th><th>Drawn</th><th>Win rate</th></tr></thead><tbody>';
      names.sort().forEach(function (n) {
        const r = st.record[n];
        const total = r.w + r.l + r.d;
        html += '<tr><td>' + escapeHtml(n) + '</td><td class="num">' + r.w + '</td>' +
          '<td class="num">' + r.l + '</td><td class="num">' + r.d + '</td>' +
          '<td class="num">' + (total ? Math.round(100 * r.w / total) : 0) + '%</td></tr>';
      });
      html += '</tbody></table>';
    }

    $('stats-body').innerHTML = html;
  }

  function renderAchievements() {
    $('ach-body').innerHTML = ACHIEVEMENTS.map(function (a) {
      const un = !!App.stats.ach[a.id];
      return '<div class="ach' + (un ? ' unlocked' : '') + '">' +
        '<div class="ach-icon">' + a.icon + '</div>' +
        '<div><div class="ach-name">' + a.name + '</div>' +
        '<div class="ach-desc">' + a.desc + '</div></div></div>';
    }).join('');
  }

  /* ---------------------------------------------------------------- online */

  function setConnStatus(text, online) {
    const el = $('conn-status');
    el.textContent = text;
    el.classList.toggle('online', !!online);
  }

  function showLobby() {
    $('lobby').hidden = false;
    $('lobby-error').hidden = true;
    $('btn-create').disabled = true;
    $('btn-join').disabled = true;
  }

  function hideLobby() {
    $('lobby').hidden = true;
    $('btn-create').disabled = false;
    $('btn-join').disabled = false;
  }

  function createOnline() {
    const name = ($('host-name').value || '').trim() || 'Host';
    const sizeKey = $('host-size').value || 'classic';
    const settings = {
      mode: 'online',
      dots: SIZE_INFO[sizeKey].dots,
      sizeKey: sizeKey,
      names: [name, 'Player 2'],
    };
    App.settings = settings;
    App.mode = 'online';
    App.onlineSeat = 0;
    App.game = null;
    App.startedAt = Date.now();
    App.session = new ONLINE.OnlineGame({
      role: 'host',
      name: name,
      settings: settings,
      onState: onOnlineState,
      onEvent: onOnlineEvent,
    });
    App.session.create(App.pendingHostCode);
    App.pendingHostCode = null;
    showLobby();
    $('lobby-status').textContent = 'Waiting for your opponent…';
  }

  function joinOnline() {
    const name = ($('join-name').value || '').trim() || 'Guest';
    const code = ONLINE.normalizeCode($('join-code').value);
    if (!code) {
      $('lobby-error').textContent = 'Enter the game code.';
      $('lobby-error').hidden = false;
      return;
    }
    App.settings = { mode: 'online' };
    App.mode = 'online';
    App.onlineSeat = 1;
    App.game = null;
    App.startedAt = Date.now();
    App.session = new ONLINE.OnlineGame({
      role: 'guest',
      name: name,
      code: code,
      onState: onOnlineState,
      onEvent: onOnlineEvent,
    });
    showLobby();
    $('lobby-status').textContent = 'Connecting to ' + code + '…';
    App.session.join(code);
  }

  function onOnlineState(state) {
    App.game = state;
    hideOverlay();
    if (!$('screen-game').hidden) {
      renderAll();
    } else {
      hideLobby();
      showScreen('game');
      App.view.setState(state);
      App.view.fit();
      renderAll();
    }
    saveSoon();
  }

  function onOnlineEvent(evt) {
    if (evt.type === 'created') {
      $('lobby-code').textContent = evt.code;
      $('lobby-link').value = evt.link;
      $('lobby-status').textContent = 'Waiting for your opponent…';
      setConnStatus('Online', true);
      try { window.history.replaceState({}, '', '?host=' + evt.code); } catch (e) { /* ignore */ }
      return;
    }
    if (evt.type === 'start') {
      setConnStatus('Online vs ' + evt.partner, true);
      return;
    }
    if (evt.type === 'joined') {
      $('lobby-status').textContent = 'Connected — waiting for the host…';
      setConnStatus('Online', true);
      return;
    }
    if (evt.type === 'peer-left') {
      setConnStatus('Opponent left', false);
      showOverlay(
        '<h2>Connection closed</h2>' +
        '<p>Your opponent left the game.</p>' +
        '<div class="form-actions"><button class="btn primary" id="btn-peer-left" type="button">Back to menu</button></div>'
      );
      $('btn-peer-left').addEventListener('click', gotoHome);
      return;
    }
    if (evt.type === 'error') {
      setConnStatus('Offline', false);
      $('lobby-error').textContent = evt.message;
      $('lobby-error').hidden = false;
    }
  }

  function copyInviteLink() {
    const input = $('lobby-link');
    const text = input.value;
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        $('btn-copy-link').textContent = 'Copied';
        schedule(function () { $('btn-copy-link').textContent = 'Copy invite link'; }, 1500);
      }, function () { input.select(); });
    } else {
      input.select();
      document.execCommand('copy');
    }
  }

  /* ------------------------------------------------------------------ init */

  function init() {
    App.view = new BoardView($('board'));
    App.view.resize();
    window.addEventListener('resize', function () { App.view.resize(); });
    if (window.ResizeObserver) {
      new ResizeObserver(function () { App.view.resize(); }).observe($('board-wrap'));
    }
    App.view.refreshTheme();

    loadPrefs();
    loadStats();
    refreshContinue();

    // Home menu.
    document.querySelectorAll('[data-goto]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const target = btn.getAttribute('data-goto');
        if (target === 'setup') {
          App.mode = 'ai';
          $('setup-title').textContent = 'New game';
          syncModeForm();
          showScreen('setup');
          return;
        }
        if (target === 'continue') {
          const save = loadSave();
          if (!save) return;
          try {
            App.game = B.deserialize(save.state);
            App.mode = save.mode === 'ai' ? 'ai' : 'local';
            App.level = save.level || 'casual';
            App.settings = save.settings;
            App.startedAt = save.startedAt || Date.now();
            App.customDots = App.game.dots;
            hideOverlay();
            showScreen('game');
            App.view.setState(App.game);
            App.view.fit();
            renderAll();
            afterAction();
          } catch (e) {
            clearSave();
            refreshContinue();
            toast('That saved game could not be loaded.');
          }
          return;
        }
        showScreen(target);
      });
    });

    document.querySelectorAll('input[name="gamemode"]').forEach(function (el) {
      el.addEventListener('change', function () {
        App.mode = checkedValue('gamemode') === 'local' ? 'local' : 'ai';
        syncModeForm();
      });
    });

    document.querySelectorAll('input[name="difficulty"]').forEach(function (el) {
      el.addEventListener('change', function () {
        $('difficulty-help').textContent = DIFFICULTY_HELP[checkedValue('difficulty')];
      });
    });

    // Board size help text.
    const sizeHelp = function () {
      const key = checkedValue('size') || 'classic';
      const info = SIZE_INFO[key];
      $('size-help').textContent = info.blurb || '';
      $('field-custom').hidden = key !== 'custom';
      if (key === 'custom') {
        $('custom-value').textContent = String(App.customDots || 11);
        $('custom-boxes').textContent = String(B.boxCountFor(App.customDots || 11));
      }
    };
    document.querySelectorAll('input[name="size"]').forEach(function (el) {
      el.addEventListener('change', sizeHelp);
    });
    $('custom-minus').addEventListener('click', function () {
      App.customDots = Math.max(B.MIN_DOTS, (App.customDots || 11) - 1);
      sizeHelp();
    });
    $('custom-plus').addEventListener('click', function () {
      App.customDots = Math.min(B.MAX_DOTS, (App.customDots || 11) + 1);
      sizeHelp();
    });
    sizeHelp();

    $('setup-form').addEventListener('submit', function (e) {
      e.preventDefault();
      startGame(readSetupForm());
    });

    $('settings-form').addEventListener('submit', function (e) {
      e.preventDefault();
      App.prefs.theme = checkedValue('theme') || 'graph';
      App.prefs.mark = checkedValue('mark') || 'initial';
      App.prefs.assistSafe = $('assist-safe').checked;
      App.prefs.assistHeat = $('assist-heat').checked;
      App.prefs.assistPreview = $('assist-preview').checked;
      savePrefs();
      toast('Settings saved.');
    });

    // Reflect stored prefs in the settings form.
    document.querySelectorAll('input[name="theme"]').forEach(function (el) {
      el.checked = el.value === App.prefs.theme;
    });
    document.querySelectorAll('input[name="mark"]').forEach(function (el) {
      el.checked = el.value === App.prefs.mark;
    });
    $('assist-safe').checked = !!App.prefs.assistSafe;
    $('assist-heat').checked = !!App.prefs.assistHeat;
    $('assist-preview').checked = !!App.prefs.assistPreview;

    $('btn-howto').addEventListener('click', showHowTo);
    $('btn-quit').addEventListener('click', gotoHome);
    $('btn-rematch').addEventListener('click', function () {
      if (App.mode === 'online') { App.session.rematch(); return; }
      startGame(App.settings);
    });
    $('btn-zoom-in').addEventListener('click', function () {
      App.view.zoomAt(App.view.cssW / 2, App.view.cssH / 2, 1.25);
    });
    $('btn-zoom-out').addEventListener('click', function () {
      App.view.zoomAt(App.view.cssW / 2, App.view.cssH / 2, 0.8);
    });
    $('btn-fit').addEventListener('click', function () { App.view.fit(); });
    $('btn-centre').addEventListener('click', function () { App.view.center(); });

    $('btn-create').addEventListener('click', createOnline);
    $('btn-join').addEventListener('click', joinOnline);
    $('btn-copy-link').addEventListener('click', copyInviteLink);
    $('btn-cancel-lobby').addEventListener('click', function () {
      if (App.session) { App.session.leave(); App.session = null; }
      hideLobby();
      setConnStatus('', false);
    });

    $('btn-reset-stats').addEventListener('click', function () {
      showOverlay(
        '<h2>Reset statistics?</h2>' +
        '<p>This clears every statistic and achievement on this device.</p>' +
        '<div class="form-actions">' +
        '<button class="btn danger" id="btn-confirm-reset" type="button">Reset everything</button>' +
        '<button class="btn ghost" id="btn-cancel-reset" type="button">Cancel</button>' +
        '</div>'
      );
      $('btn-confirm-reset').addEventListener('click', function () {
        App.stats = defaultStats();
        saveStats();
        hideOverlay();
        renderStats();
        toast('Statistics cleared.');
      });
      $('btn-cancel-reset').addEventListener('click', hideOverlay);
    });

    $('overlay').addEventListener('click', function (e) {
      if (e.target === $('overlay') && !App.game) hideOverlay();
    });

    // Deep links.
    const params = new URLSearchParams(window.location.search);
    const join = ONLINE.normalizeCode(params.get('join'));
    const host = ONLINE.normalizeCode(params.get('host'));
    if (join) {
      $('join-code').value = join;
      App.mode = 'online';
      showScreen('online');
    } else if (host) {
      App.pendingHostCode = host;
      App.mode = 'online';
      showScreen('online');
    }

    window.addEventListener('pagehide', saveNow);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') saveNow();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.__APP = App;
  // Test hook: play a line by edge id without synthesising pointer input.
  App.debugPlay = onBoardTap;
}());

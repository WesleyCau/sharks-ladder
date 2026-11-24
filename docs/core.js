/* Southern Sharks ladder core: rating engine, scheduler and league rules.
   Runs in the browser (window.Ladder) and in Node (module.exports) so it can be tested.
   Mirrors ladder/engine.py, scheduler.py and store.py. Ratings are integers in thousandths. */
(function (L) {
  "use strict";

  /* ---------------- seeded random ---------------- */
  function rng(seed) {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rand) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  }

  /* ---------------- rating engine ---------------- */
  const K_ELO = 100, K_PROB = 8.988, MAX_EXACT_ROUNDS = 9, SAMPLE_ORDERS = 20000;
  const BONUS_BASE = 11, TARGETS = [11, 15, 21];      // the club's formula is for games to 11; pools can also play to 15 or 21
  const rnd = x => Math.floor(x + 0.5);
  const cache = new Map();

  /* start: {pid: rating}. rounds: [[{gid, win:[a,b], lose:[c,d], ws, ls}]].
     Replays the rounds in every order and averages. Returns {ends: {pid: mean}, games: {gid: [prob, dw, dl]}}. */
  function allOrders(start, rounds) {
    const players = [...new Set(rounds.flat().flatMap(g => g.win.concat(g.lose)))].sort();
    const key = JSON.stringify([players.map(p => start[p]), rounds]);
    if (cache.has(key)) return cache.get(key);
    const idx = new Map(players.map((p, i) => [p, i]));
    const base = players.map(p => start[p]);
    const rds = rounds.map(rd => rd.map(g => [idx.get(g.win[0]), idx.get(g.win[1]), idx.get(g.lose[0]), idx.get(g.lose[1]), g.ws, g.ls]));
    const sums = rounds.map(rd => rd.map(() => [0, 0, 0]));
    const total = new Array(players.length).fill(0);
    const n = rounds.length, r = new Array(players.length);
    let count = 0;
    const play = order => {
      for (let j = 0; j < base.length; j++) r[j] = base[j];
      for (let o = 0; o < n; o++) {
        const i = order[o], games = rds[i], acc = sums[i];
        for (let k = 0; k < games.length; k++) {
          const g = games[k];
          const prob = 1 / (1 + Math.exp(-K_PROB * (r[g[0]] + r[g[1]] - r[g[2]] - r[g[3]]) / 2000));
          /* the club's rounding: the win chance is taken to 0.01%, the winners' share rounds half up and the losers' half down,
             so on an exact half-thousandth the winners gain 0.001 more than the losers lose */
          const e = 10000 - Math.floor(prob * 10000 + 0.5);
          const dw = Math.floor((e + 50) / 100) + g[4] - g[5], dl = g[5] - Math.floor((e + 49) / 100);
          r[g[0]] += dw; r[g[1]] += dw; r[g[2]] += dl; r[g[3]] += dl;
          const s = acc[k]; s[0] += prob; s[1] += dw; s[2] += dl;
        }
      }
      for (let j = 0; j < base.length; j++) total[j] += r[j];
      count++;
    };
    const order = Array.from({ length: n }, (_, i) => i);
    if (n <= MAX_EXACT_ROUNDS) {
      /* Every order once, walked as a tree: orders that begin with the same rounds share the work of those rounds.
         A game played at a node counts once for each order below it (weight), so the sums are the same as playing
         every order in full, for about a third of the arithmetic. Ratings and changes are whole numbers, so exact. */
      const fact = [1];
      for (let i = 1; i <= n; i++) fact.push(fact[i - 1] * i);
      const used = new Array(n).fill(false), m = base.length, levels = Array.from({ length: n + 1 }, () => new Array(m));
      for (let j = 0; j < m; j++) levels[0][j] = base[j];
      const walk = depth => {
        const cur = levels[depth];
        if (depth === n) { for (let j = 0; j < m; j++) total[j] += cur[j]; return; }
        const next = levels[depth + 1], weight = fact[n - depth - 1];
        for (let i = 0; i < n; i++) {
          if (used[i]) continue;
          used[i] = true;
          for (let j = 0; j < m; j++) next[j] = cur[j];
          const games = rds[i], acc = sums[i];
          for (let k = 0; k < games.length; k++) {
            const g = games[k];
            const prob = 1 / (1 + Math.exp(-K_PROB * (next[g[0]] + next[g[1]] - next[g[2]] - next[g[3]]) / 2000));
            const e = 10000 - Math.floor(prob * 10000 + 0.5);
            const dw = Math.floor((e + 50) / 100) + g[4] - g[5], dl = g[5] - Math.floor((e + 49) / 100);
            next[g[0]] += dw; next[g[1]] += dw; next[g[2]] += dl; next[g[3]] += dl;
            const sm = acc[k]; sm[0] += prob * weight; sm[1] += dw * weight; sm[2] += dl * weight;
          }
          walk(depth + 1);
          used[i] = false;
        }
      };
      walk(0);
      count = fact[n];
    } else {
      const rand = rng("orders-" + n);
      for (let s = 0; s < SAMPLE_ORDERS; s++) play(shuffle(order, rand));
    }
    const out = { ends: {}, games: {} };
    players.forEach((p, i) => { out.ends[p] = total[i] / count; });
    rounds.forEach((rd, i) => rd.forEach((g, k) => { out.games[g.gid] = sums[i][k].map(v => v / count); }));
    if (cache.size > 400) cache.clear();
    cache.set(key, out);
    return out;
  }

  function compute(state) {
    const rating = {}, totals = {};
    for (const pid in state.players) { rating[pid] = state.players[pid].seed; totals[pid] = { w: 0, l: 0, pf: 0, pa: 0 }; }
    const bySession = {}, gameOut = {};
    const closed = state.sessions.filter(s => s.status === "closed").sort((a, b) => (a.date + "|" + a.id < b.date + "|" + b.id ? -1 : 1));
    for (const sess of closed) {
      const rec = {}, start = Object.assign({}, rating);
      for (const pool of sess.pools) {
        const rounds = [];
        for (const rd of pool.rounds || []) {
          const games = [];
          for (const gid of rd) {
            const g = sess.games[gid];
            if (!g || g.status !== "done" || g.s1 === g.s2) continue;
            games.push(g.s1 > g.s2 ? { gid, win: g.t1, lose: g.t2, ws: g.s1, ls: g.s2 } : { gid, win: g.t2, lose: g.t1, ws: g.s2, ls: g.s1 });
          }
          if (games.length) rounds.push(games);
        }
        if (!rounds.length) continue;
        /* The score bonus is written for a game to 11. A longer game is scaled back to that, so it is worth the same. */
        const T = pool.target || sess.pointsToWin || BONUS_BASE, scale = v => (T === BONUS_BASE ? v : Math.floor((2 * BONUS_BASE * v + T) / (2 * T)));
        const rated = rounds.map(rd => rd.map(g => { const bl = scale(g.ls), bw = scale(g.ws - g.ls); return { gid: g.gid, win: g.win, lose: g.lose, ws: bw + bl, ls: bl }; }));
        const res = allOrders(start, rated);
        for (const pid in res.ends) {
          rating[pid] = rnd(res.ends[pid]);
          rec[pid] = { pool: pool.id, start: start[pid], end: rating[pid], w: 0, l: 0, pf: 0, pa: 0 };
        }
        for (const rd of rounds) for (const g of rd) {
          const [prob, dw, dl] = res.games[g.gid], t1Won = sess.games[g.gid].s1 > sess.games[g.gid].s2;
          gameOut[g.gid] = { p1: +(t1Won ? prob : 1 - prob).toFixed(4), d1: +(t1Won ? dw : dl).toFixed(2), d2: +(t1Won ? dl : dw).toFixed(2) };
          for (const pid of g.win) for (const d of [rec[pid], totals[pid]]) { d.w++; d.pf += g.ws; d.pa += g.ls; }
          for (const pid of g.lose) for (const d of [rec[pid], totals[pid]]) { d.l++; d.pf += g.ls; d.pa += g.ws; }
        }
      }
      bySession[sess.id] = rec;
    }
    return { current: rating, sessions: bySession, games: gameOut, totals };
  }

  /* ---------------- scheduler ---------------- */
  const TARGET_GAMES = 7, MIN_POOL = 4, MAX_POOL = 12;

  function roundCount(n) {
    const perRound = 4 * Math.floor(n / 4);
    let best = null;
    for (let rounds = 1; rounds < 60; rounds++) {
      if ((perRound * rounds) % n) continue;
      const each = perRound * rounds / n, key = [Math.abs(each - TARGET_GAMES), -each];
      if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) best = { key, rounds };
    }
    return best.rounds;
  }
  function counts(n, rounds) {
    const partner = Array.from({ length: n }, () => new Array(n).fill(0)), oppose = Array.from({ length: n }, () => new Array(n).fill(0));
    for (const rd of rounds) for (const [[a, b], [c, d]] of rd) {
      partner[a][b]++; partner[b][a]++; partner[c][d]++; partner[d][c]++;
      for (const x of [a, b]) for (const y of [c, d]) { oppose[x][y]++; oppose[y][x]++; }
    }
    return { partner, oppose };
  }
  function permutations(items) {
    if (items.length <= 1) return [items];
    const out = [];
    items.forEach((x, i) => permutations(items.slice(0, i).concat(items.slice(i + 1))).forEach(p => out.push([x].concat(p))));
    return out;
  }
  let whistCache = null;
  function whist8() {
    if (whistCache) return whistCache;
    const INF = 7;
    for (const p of permutations([1, 2, 3, 4, 5, 6])) {
      const starter = [[[INF, 0], [p[0], p[1]]], [[p[2], p[3]], [p[4], p[5]]]];
      const rounds = [];
      for (let k = 0; k < 7; k++) {
        const sh = x => (x === INF ? x : (x + k) % 7);
        rounds.push(starter.map(([[a, b], [c, d]]) => [[sh(a), sh(b)], [sh(c), sh(d)]]));
      }
      const { partner, oppose } = counts(8, rounds);
      let ok = true;
      for (let i = 0; i < 8 && ok; i++) for (let j = 0; j < 8; j++) if (i !== j && (partner[i][j] !== 1 || oppose[i][j] !== 2)) { ok = false; break; }
      if (ok) return (whistCache = rounds);
    }
    return null;
  }
  /* Nine players: the whist design on a 3 x 3 grid. One starter round with player 0 sitting out, moved on by each of the
     nine steps of the grid. Everyone partners everyone once, opposes everyone twice and sits out once. */
  let whist9Cache = null;
  function whist9() {
    if (whist9Cache) return whist9Cache;
    const add = (x, k) => 3 * ((Math.floor(x / 3) + Math.floor(k / 3)) % 3) + (x + k) % 3;
    const starter = [[[1, 2], [3, 6]], [[4, 8], [5, 7]]];
    return (whist9Cache = Array.from({ length: 9 }, (_, k) => starter.map(([[a, b], [c, d]]) => [[add(a, k), add(b, k)], [add(c, k), add(d, k)]])));
  }
  function balanced(n, nRounds, rand) {
    const perRound = Math.floor(n / 4);
    let best = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const partner = Array.from({ length: n }, () => new Array(n).fill(0)), oppose = Array.from({ length: n }, () => new Array(n).fill(0));
      const played = new Array(n).fill(0), rounds = [];
      for (let r = 0; r < nRounds; r++) {
        const tie = Array.from({ length: n }, () => rand());
        const playing = Array.from({ length: n }, (_, i) => i).sort((a, b) => played[a] - played[b] || tie[a] - tie[b]).slice(0, 4 * perRound);
        let pick = null;
        for (let t = 0; t < 150; t++) {
          shuffle(playing, rand);
          let cost = 0;
          for (let k = 0; k < perRound; k++) {
            const a = playing[4 * k], b = playing[4 * k + 1], c = playing[4 * k + 2], d = playing[4 * k + 3];
            cost += 12 * (partner[a][b] + partner[c][d]) + oppose[a][c] + oppose[a][d] + oppose[b][c] + oppose[b][d];
          }
          if (!pick || cost < pick.cost) pick = { cost, order: playing.slice() };
        }
        const rd = [];
        for (let k = 0; k < perRound; k++) {
          const [a, b, c, d] = pick.order.slice(4 * k, 4 * k + 4);
          rd.push([[a, b], [c, d]]);
          partner[a][b]++; partner[b][a]++; partner[c][d]++; partner[d][c]++;
          for (const x of [a, b]) for (const y of [c, d]) { oppose[x][y]++; oppose[y][x]++; }
          for (const x of [a, b, c, d]) played[x]++;
        }
        rounds.push(rd);
      }
      let score = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) score += 12 * partner[i][j] ** 2 + oppose[i][j] ** 2;
      if (!best || score < best.score) best = { score, rounds };
    }
    return best.rounds;
  }
  /* players: ids. Returns rounds: [[[pair, pair], ...], ...] using those ids. Same seed, same schedule. */
  function generate(players, seed) {
    const n = players.length;
    if (n < MIN_POOL || n > MAX_POOL) throw new Error(`a pool needs ${MIN_POOL} to ${MAX_POOL} players, got ${n}`);
    const rand = rng(String(seed) + "-" + n);
    const design = (n === 8 && whist8()) || (n === 9 && whist9()) || balanced(n, roundCount(n), rand);
    const slots = shuffle(players.slice(), rand), order = shuffle(design.slice(), rand);
    return order.map(rd => rd.map(([[a, b], [c, d]]) => [[slots[a], slots[b]], [slots[c], slots[d]]]));
  }
  function summary(players, rounds) {
    const index = new Map(players.map((p, i) => [p, i])), n = players.length;
    const asIdx = rounds.map(rd => rd.map(([[a, b], [c, d]]) => [[index.get(a), index.get(b)], [index.get(c), index.get(d)]]));
    const { partner, oppose } = counts(n, asIdx);
    const games = players.map((_, i) => asIdx.flat().filter(([t1, t2]) => t1.concat(t2).includes(i)).length);
    const pv = [], ov = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { pv.push(partner[i][j]); ov.push(oppose[i][j]); }
    return { rounds: rounds.length, games: rounds.flat().length, eachMin: Math.min(...games), eachMax: Math.max(...games),
      partnerMin: Math.min(...pv), partnerMax: Math.max(...pv), opposeMin: Math.min(...ov), opposeMax: Math.max(...ov) };
  }

  /* ---------------- league rules (actions on the state document) ---------------- */
  const DEFAULT_SEEDS = [3500, 3000, 2500];
  const OPEN_ACTIONS = new Set(["game.score", "game.clear", "round.confirm", "avail.set"]);   // anyone: scores during a live session, and a player's own in or out

  function ActionError(code, message, extra) { this.code = code; this.message = message; this.extra = extra || {}; }
  const fail = (code, message, extra) => { throw new ActionError(code, message, extra); };

  function emptyState(name) {
    return { version: 1, seq: { p: 0, s: 0, g: 0 }, league: { name: name || "Southern Sharks PC Ladder League", seeds: DEFAULT_SEEDS.slice(), poolSize: 8, pointsToWin: 11, nameStyle: "short" },
      players: {}, sessions: [], availability: {}, ratings: { current: {}, sessions: {}, games: {}, totals: {} } };
  }
  const toArray = x => (Array.isArray(x) ? x.filter(v => v != null) : x && typeof x === "object" ? Object.keys(x).sort((a, b) => a - b).map(k => x[k]) : []);
  const idNum = id => parseInt(String(id).slice(1), 10) || 0;
  /* Fill in anything a database dropped (empty lists, nulls) and accept sessions keyed by id. */
  function normalize(raw) {
    const st = Object.assign(emptyState(), raw || {});
    st.seq = Object.assign({ p: 0, s: 0, g: 0 }, st.seq);
    st.league = Object.assign(emptyState().league, st.league);
    st.league.seeds = toArray(st.league.seeds);
    st.players = st.players || {};
    st.availability = st.availability || {};
    if (st.league.season) st.league.season = Object.assign({}, st.league.season, { dates: toArray(st.league.season.dates) });
    st.sessions = toArray(st.sessions).sort((a, b) => idNum(a.id) - idNum(b.id)).map(s => {
      const games = {};
      for (const gid in s.games || {}) {
        const g = s.games[gid];
        games[gid] = Object.assign({}, g, { t1: toArray(g.t1), t2: toArray(g.t2), s1: g.s1 == null ? null : g.s1, s2: g.s2 == null ? null : g.s2 });
      }
      return Object.assign({}, s, { attending: toArray(s.attending), games,
        pools: toArray(s.pools).map(p => Object.assign({}, p, { confirmed: p.confirmed || 0, players: toArray(p.players), rounds: toArray(p.rounds).map(toArray) })) });
    });
    const r = st.ratings || {};
    st.ratings = { current: r.current || {}, sessions: r.sessions || {}, games: r.games || {}, totals: r.totals || {} };
    return st;
  }

  const H = {};   // action handlers: (state, args, org) => result
  const nextId = (st, kind) => kind + (++st.seq[kind]);
  const ratingOf = (st, pid) => (st.ratings.current[pid] != null ? st.ratings.current[pid] : st.players[pid].seed);
  const byRating = st => (a, b) => ratingOf(st, b) - ratingOf(st, a) || st.players[a].name.toLowerCase().localeCompare(st.players[b].name.toLowerCase());
  const openSession = st => st.sessions.find(s => s.status !== "closed");
  const doneGames = s => Object.values(s.games).filter(g => g.status === "done");
  const recompute = st => { st.ratings = compute(st); };
  function getSession(st, sid, ...statuses) {
    const s = st.sessions.find(x => x.id === sid);
    if (!s) fail("missing", "Session not found.");
    if (statuses.length && !statuses.includes(s.status)) fail("status", `This session is ${s.status}, so that is not possible.`);
    return s;
  }
  const getPlayer = (st, pid) => st.players[pid] || fail("missing", "Player not found.");
  const clearSchedule = s => { s.games = {}; s.pools.forEach(p => { p.rounds = []; }); };
  const hasPlayed = (st, pid) => st.sessions.some(s => doneGames(s).some(g => g.t1.concat(g.t2).includes(pid)));
  function checkName(st, name, skip) {
    name = String(name || "").trim().split(/\s+/).join(" ").slice(0, 60);
    if (!name) fail("invalid", "Enter the player's name.");
    for (const pid in st.players) if (pid !== skip && st.players[pid].name.toLowerCase() === name.toLowerCase()) fail("duplicate", `${st.players[pid].name} is already in the league.`);
    return name;
  }
  function seedOf(value) {
    const seed = Math.round(parseFloat(value) * 1000);
    if (!Number.isFinite(seed)) fail("invalid", "Starting rating must be a number, for example 3.3.");
    if (seed < 1500 || seed > 6000) fail("invalid", "Starting rating must be between 1.5 and 6.0.");
    return seed;
  }
  function removeFromSession(s, pid) {
    s.attending = s.attending.filter(p => p !== pid);
    for (const pool of s.pools) if (pool.players.includes(pid)) { pool.players = pool.players.filter(p => p !== pid); clearSchedule(s); }
    autoCourts(s);
  }

  H["league.update"] = (st, a) => {
    if ("name" in a) { const name = String(a.name).trim(); if (!name) fail("invalid", "League name cannot be empty."); st.league.name = name.slice(0, 80); }
    if ("nameStyle" in a) { if (a.nameStyle !== "short" && a.nameStyle !== "full") fail("invalid", "Choose short or full names."); st.league.nameStyle = a.nameStyle; }
    if ("pointsToWin" in a) {
      const raw = String(a.pointsToWin).trim(), pts = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
      if (!(pts >= 5 && pts <= 21)) fail("invalid", "Points to win must be a whole number from 5 to 21.");
      st.league.pointsToWin = pts;
    }
  };
  H["player.add"] = (st, a) => {
    const name = checkName(st, a.name), seed = seedOf(a.seed != null ? a.seed : st.league.seeds[st.league.seeds.length - 1] / 1000);
    const pid = nextId(st, "p");
    st.players[pid] = { id: pid, name, active: true, seed };
    st.ratings.current[pid] = seed;
    st.ratings.totals[pid] = { w: 0, l: 0, pf: 0, pa: 0 };
    if (a.sid) getSession(st, a.sid, "setup").attending.push(pid);
    return { id: pid };
  };
  H["player.update"] = (st, a) => {
    const p = getPlayer(st, a.id);
    if ("name" in a) p.name = checkName(st, a.name, p.id);
    if ("active" in a) {
      p.active = !!a.active;
      const s = openSession(st);
      if (!p.active && s && s.status === "setup" && s.attending.includes(p.id)) removeFromSession(s, p.id);
    }
    if ("seed" in a) {
      if (hasPlayed(st, p.id)) fail("locked", `${p.name} has played games, so the starting rating is fixed.`);
      p.seed = seedOf(a.seed);
      recompute(st);
    }
  };
  /* ---------------- the season's nights, and who has said they are playing ---------------- */
  const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + "T00:00").getTime());
  /* The league's calendar. Answers close `days` days before a night at `time`; names: whether players see who is in. */
  const seasonOf = st => { const x = st.league.season || {}; return { dates: toArray(x.dates), days: x.days == null ? 1 : x.days, time: x.time || "18:00", names: x.names !== false }; };
  /* In, out and no answer for one night, among the players still in the league. */
  function availCount(st, date) {
    const said = (st.availability || {})[date] || {}, out = { in: [], out: [], none: [] };
    for (const pid in st.players) if (st.players[pid].active) out[said[pid] && said[pid].v === "in" ? "in" : said[pid] && said[pid].v === "out" ? "out" : "none"].push(pid);
    return out;
  }
  /* One answer, checked. Shared with the hosted database, which writes each answer on its own so 40 phones never collide. */
  function availCheck(st, a) {
    const date = String(a.date || ""), p = st.players[a.pid];
    if (!seasonOf(st).dates.includes(date)) fail("date", "That night is not in the league calendar.");
    if (!p) fail("missing", "Player not found.");
    if (!p.active) fail("inactive", `${p.name} is marked as dropped out. Ask the organiser.`);
    if (a.v !== "in" && a.v !== "out" && a.v != null && a.v !== "") fail("invalid", "Choose in or out.");
    return { date, pid: a.pid, v: a.v === "in" || a.v === "out" ? a.v : null };
  }
  H["avail.set"] = (st, a) => {
    const { date, pid, v } = availCheck(st, a);
    st.availability = st.availability || {};
    const night = st.availability[date] = st.availability[date] || {};
    if (v) night[pid] = { v, at: Date.now() }; else delete night[pid];
  };
  H["season.set"] = (st, a) => {
    const cur = seasonOf(st), dates = "dates" in a ? [...new Set(toArray(a.dates).map(String))].sort() : cur.dates;
    if (dates.some(d => !isDate(d))) fail("invalid", "One of those is not a date.");
    if (dates.length > 60) fail("invalid", "A season can have at most 60 nights.");
    const days = "days" in a ? parseInt(a.days, 10) : cur.days, time = "time" in a ? String(a.time) : cur.time;
    if (!(days >= 0 && days <= 6)) fail("invalid", "Answers can close on the day or up to 6 days before.");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail("invalid", "Enter the closing time as hours and minutes, for example 18:00.");
    st.league.season = { dates, days, time, names: "names" in a ? !!a.names : cur.names };
    for (const d in st.availability || {}) if (!dates.includes(d)) delete st.availability[d];      // answers for a night taken off the calendar go with it
  };
  /* Setup only: make the session's attendance what players have said for that night. Pools keep everyone who is still in. */
  H["session.useAvail"] = (st, a) => {
    const s = getSession(st, a.sid, "setup"), want = availCount(st, s.date).in, keep = new Set(want);
    let added = 0, removed = 0;
    for (const pid of s.attending.slice()) if (!keep.has(pid)) { removeFromSession(s, pid); removed++; }
    for (const pid of want) if (!s.attending.includes(pid)) { s.attending.push(pid); added++; }
    return { added, removed };
  };

  H["session.create"] = (st, a) => {
    if (openSession(st)) fail("open", "Finish the current session before creating another.");
    const date = String(a.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + "T00:00").getTime())) fail("invalid", "Pick a date for the session.");
    const closed = st.sessions.filter(s => s.status === "closed").sort((x, y) => (x.date + "|" + x.id < y.date + "|" + y.id ? -1 : 1));
    /* a session dated before the last finished one would slot in ahead of it and re-rate every later week */
    if (closed.length && date < closed[closed.length - 1].date) fail("date", `That date is before the last finished session (${closed[closed.length - 1].date}). Pick that day or later.`);
    const active = Object.keys(st.players).filter(pid => st.players[pid].active);
    const last = closed.length ? new Set(closed[closed.length - 1].attending) : new Set(active);
    /* once anyone has answered for that night, the session starts with the players who said they are in */
    const said = (st.availability || {})[date] || {}, answered = Object.keys(said).length > 0;
    const s = { id: nextId(st, "s"), date, status: "setup", attending: active.filter(p => (answered ? said[p] && said[p].v === "in" : last.has(p))), pools: [], games: {} };
    st.sessions.push(s);
    return { id: s.id, from: answered ? "availability" : "last" };
  };
  H["session.attend"] = (st, a) => {
    const s = getSession(st, a.sid, "setup"), p = getPlayer(st, a.pid);
    if (a.on) {
      if (!p.active) fail("inactive", `${p.name} is marked as dropped out. Restore them first.`);
      if (!s.attending.includes(p.id)) s.attending.push(p.id);
    } else removeFromSession(s, p.id);
  };
  H["session.attendAll"] = (st, a) => {
    const s = getSession(st, a.sid, "setup");
    if (a.last) {
      /* exactly the players who were at the last finished session (and are still in the league); pools keep whoever stays */
      const closed = st.sessions.filter(x => x.status === "closed").sort((x, y) => (x.date + "|" + x.id < y.date + "|" + y.id ? -1 : 1));
      if (!closed.length) fail("none", "There is no finished session to copy from yet.");
      const want = closed[closed.length - 1].attending.filter(pid => st.players[pid] && st.players[pid].active);
      s.attending.filter(pid => !want.includes(pid)).forEach(pid => removeFromSession(s, pid));
      want.forEach(pid => { if (!s.attending.includes(pid)) s.attending.push(pid); });
      return { players: s.attending.length };
    }
    if (a.on) { for (const pid in st.players) if (st.players[pid].active && !s.attending.includes(pid)) s.attending.push(pid); }
    else { s.attending = []; s.pools = []; s.games = {}; }
  };
  /* How many pools for n players. Pools of eight or nine are the aim (two courts, 7 or 9 rounds):
     as few pools as keep every pool at nine or under; if that leaves a pool under eight, one pool fewer (tens and elevens,
     and for 23 players an eleven and a twelve). A pool under eight plays one game at a time and takes twice as long,
     so it is only used when there is no other way: 13, 14 or 15 players. */
  function poolCount(n) {
    let k = Math.max(1, Math.ceil(n / 9));
    if (k > 1 && Math.floor(n / k) < 8 && Math.ceil(n / (k - 1)) <= MAX_POOL) k--;
    return k;
  }
  /* Game targets a pool can play to: 11, 15 and 21, never shorter than the league's own setting. */
  const targetChoices = base => [...new Set(TARGETS.concat(base))].filter(t => t >= base).sort((a, b) => a - b);
  /* The target that brings a pool of n home at about the same time as the others. A night is as long as its longest pool
     playing to the league's setting (rounds x points); a pool with fewer rounds plays longer games to fill that time,
     to within 10%. Eights and nines together: the nines play 9 rounds to 11 (99), the eights 7 rounds to 15 (105).
     A pool under eight plays one game at a time over many rounds: it runs long whatever anyone else does, so it does not
     set the pace (otherwise one pool of seven would send every eight to 21). */
  function autoTarget(sizes, n, base) {
    const ok = k => k >= MIN_POOL && k <= MAX_POOL;
    if (!ok(n)) return base;
    const full = sizes.filter(k => ok(k) && k >= 8), pace = full.length ? full : sizes.filter(ok);
    const budget = Math.max(...pace.map(roundCount)) * base * 1.1;
    return targetChoices(base).filter(t => roundCount(n) * t <= budget).pop() || base;
  }
  /* What a pool plays to: the organiser's choice, else (before the start) the automatic one, else what the session started with.
     A session that recorded neither (an imported season) was played to 11, which is also what its ratings assume:
     changing the league setting later must not change what an old game could have finished on. */
  const poolTarget = (st, s, pool) => pool.target || (s.status === "setup" ? autoTarget(s.pools.map(p => p.players.length), pool.players.length, st.league.pointsToWin) : s.pointsToWin || BONUS_BASE);
  const gameTarget = (st, s, gid) => { const g = s.games && s.games[gid], pool = g && s.pools.find(p => p.id === g.pool); return (pool && pool.target) || s.pointsToWin || BONUS_BASE; };
  /* Courts a pool of this size plays on: two games a round from eight players up, three for twelve. */
  const courtsFor = count => (count >= 12 ? 3 : count >= 8 ? 2 : 1);
  const autoCourts = s => s.pools.forEach(p => { if (!p.courtsHand) p.courts = courtsFor(p.players.length); });
  H["session.assign"] = (st, a) => {
    const s = getSession(st, a.sid, "setup"), ranked = s.attending.slice().sort(byRating(st)), n = ranked.length;
    if (n < MIN_POOL) fail("few", `At least ${MIN_POOL} players are needed.`);
    let k = a.pools ? parseInt(a.pools, 10) : poolCount(n);
    k = Math.max(1, Math.min(k, Math.floor(n / MIN_POOL), 12));
    while (Math.ceil(n / k) > MAX_POOL) k++;
    const base = Math.floor(n / k), extra = n % k, pools = [];
    let at = 0;
    for (let i = 0; i < k; i++) {
      const count = base + (i >= k - extra ? 1 : 0), id = String.fromCharCode(65 + i);      // the odd extra players go to the lower pools
      pools.push({ id, name: "Pool " + id, courts: courtsFor(count), confirmed: 0, players: ranked.slice(at, at + count), rounds: [] });
      at += count;
    }
    s.pools = pools; s.games = {};
  };
  H["session.move"] = (st, a) => {
    const s = getSession(st, a.sid, "setup");
    if (!s.attending.includes(a.pid)) fail("missing", "That player is not marked as attending.");
    let target = null;
    if (a.to && a.to !== "none") target = s.pools.find(p => p.id === a.to) || fail("missing", "Pool not found.");
    s.pools.forEach(p => { p.players = p.players.filter(x => x !== a.pid); });
    if (target) { target.players.push(a.pid); target.players.sort(byRating(st)); }
    autoCourts(s);
    clearSchedule(s);
  };
  H["session.pool"] = (st, a) => {
    const s = getSession(st, a.sid, "setup", "live");
    if (a.add) { const s2 = getSession(st, a.sid, "setup"), id = String.fromCharCode(65 + s2.pools.length); s2.pools.push({ id, name: "Pool " + id, courts: 1, confirmed: 0, players: [], rounds: [] }); return; }
    const pool = s.pools.find(p => p.id === a.pool) || fail("missing", "Pool not found.");
    if (a.remove) {
      const s2 = getSession(st, a.sid, "setup");
      if (pool.players.length || pool !== s2.pools[s2.pools.length - 1]) fail("invalid", "Only the last pool can be removed, and only when it is empty.");
      s2.pools.pop(); return;
    }
    if ("courts" in a) { const c = parseInt(a.courts, 10); if (!(c >= 1 && c <= 3)) fail("invalid", "A pool can use 1 to 3 courts."); pool.courts = c; if (c === courtsFor(pool.players.length)) delete pool.courtsHand; else pool.courtsHand = true; }
    if ("target" in a) {
      getSession(st, a.sid, "setup");                                   // the target is fixed once the session has started
      if (a.target === "auto" || a.target === null) { delete pool.target; delete pool.autoTarget; return; }
      const t = parseInt(a.target, 10), choices = targetChoices(st.league.pointsToWin);
      if (!choices.includes(t)) fail("invalid", `A pool can play first to ${choices.join(", ").replace(/, ([^,]*)$/, " or $1")}.`);
      pool.target = t; delete pool.autoTarget;
    }
  };
  H["session.schedule"] = (st, a) => {
    const s = getSession(st, a.sid, "setup");
    if (!s.pools.length) fail("pools", "Assign pools first.");
    const placed = new Set(s.pools.flatMap(p => p.players)), loose = s.attending.filter(p => !placed.has(p)).map(p => st.players[p].name);
    if (loose.length) fail("unassigned", `Not in a pool yet: ${loose.join(", ")}.`);
    for (const pool of s.pools) { const n = pool.players.length; if (n < MIN_POOL || n > MAX_POOL) fail("size", `${pool.name} has ${n} players. A pool needs ${MIN_POOL} to ${MAX_POOL}.`); }
    s.games = {};
    for (const pool of s.pools) {
      pool.confirmed = 0;
      pool.rounds = generate(pool.players, s.id + pool.id).map((rd, ri) => rd.map(([t1, t2]) => {
        const gid = nextId(st, "g");
        s.games[gid] = { id: gid, pool: pool.id, round: ri, t1, t2, s1: null, s2: null, status: "pending" };
        return gid;
      }));
    }
  };
  H["session.start"] = (st, a, org) => {
    const s = getSession(st, a.sid, "setup");
    if (!Object.keys(s.games).length) H["session.schedule"](st, a, org);
    /* every pool keeps the target it starts with, whatever the league setting or the pool sizes do later */
    const sizes = s.pools.map(p => p.players.length);
    s.pools.forEach(p => { if (!p.target) { p.target = autoTarget(sizes, p.players.length, st.league.pointsToWin); p.autoTarget = true; } });
    s.status = "live";
    s.pointsToWin = st.league.pointsToWin;
  };
  H["session.unstart"] = (st, a) => { const s = getSession(st, a.sid, "live"); if (doneGames(s).length) fail("scores", "Scores have been entered, so the session cannot go back to setup."); s.status = "setup"; s.pools.forEach(p => { p.confirmed = 0; if (p.autoTarget) { delete p.target; delete p.autoTarget; } }); };
  /* Back to a fresh start for the same draw: no scores, every pool on round 1. */
  H["session.reset"] = (st, a) => {
    const s = getSession(st, a.sid, "live");
    if (s.wasClosed) fail("reopened", "This session was finished once and then reopened, so it cannot be reset. Correct its scores, or delete it.");
    for (const g of Object.values(s.games)) { g.s1 = null; g.s2 = null; g.status = "pending"; delete g.at; delete g.auto; }
    s.pools.forEach(p => { p.confirmed = 0; });
    return { games: Object.keys(s.games).length };
  };
  /* Deleting a session that has scores takes an explicit yes (force), because the scores go with it. */
  H["session.delete"] = (st, a) => {
    const s = getSession(st, a.sid, "setup", "live");
    if (doneGames(s).length && !a.force) fail("scores", "Scores have been entered. Deleting the session deletes them too.");
    st.sessions = st.sessions.filter(x => x !== s);
  };

  function getGame(st, a, org) {
    const s = getSession(st, a.sid);
    if (s.status === "setup") fail("status", "The session has not started.");
    if (s.status === "closed" && !org) fail("pin", "This session is finished. Only the organiser can change it.");
    /* a score screen left open on a phone must not write into a night that has since been finished */
    if (s.status === "closed" && !a.history) fail("closed", "This session has been finished. Its scores can only be changed from Organiser, History.");
    return { s, g: s.games[a.gid] || fail("missing", "Game not found.") };
  }
  function checkScore(a) {
    const s1 = parseInt(a.s1, 10), s2 = parseInt(a.s2, 10);
    if (!Number.isInteger(s1) || !Number.isInteger(s2)) fail("invalid", "Enter both scores.");
    if (s1 < 0 || s1 > 60 || s2 < 0 || s2 > 60 || s1 === s2) fail("invalid", "Scores must be different whole numbers.");
    return { s1, s2 };
  }
  /* The rule for one game, shared with the database transaction used when many phones score at once. */
  function scoreGame(g, a, org, target) {
    const { s1, s2 } = checkScore(a);
    if (target && Math.max(s1, s2) > target) fail("invalid", `Games are first to ${target}, so the winning score cannot be more than ${target}.`);
    if (g.status === "skipped" && !org) fail("skipped", "This game was marked as not played.");
    if (g.status === "done" && (g.s1 !== s1 || g.s2 !== s2)) {
      /* replace needs the caller to have seen the score it is replacing: a.was is what its screen showed */
      const stale = a.was && (a.was.s1 !== g.s1 || a.was.s2 !== g.s2);
      if (!a.replace || stale) fail("exists", `Already entered as ${g.s1}-${g.s2}.`, { s1: g.s1, s2: g.s2 });
    }
    const out = Object.assign({}, g, { s1, s2, status: "done", at: Math.floor(Date.now() / 1000) });
    delete out.auto;
    return out;
  }
  H["game.score"] = (st, a, org) => { const { s, g } = getGame(st, a, org); s.games[g.id] = scoreGame(g, a, org, gameTarget(st, s, g.id)); if (s.status === "closed") recompute(st); };
  H["game.clear"] = (st, a, org) => {
    const { s, g } = getGame(st, a, org);
    g.s1 = null; g.s2 = null; g.status = s.status === "closed" ? "skipped" : "pending"; delete g.at; delete g.auto;
    if (s.status === "closed") recompute(st);
  };
  H["game.skip"] = (st, a, org) => { const { g } = getGame(st, a, org); if (g.status === "done") fail("scores", "Clear the score first."); g.status = a.skip === false ? "pending" : "skipped"; delete g.auto; };
  /* A round is ready to confirm when none of its games is still waiting for a score. */
  const roundReady = (s, pool, round) => (pool.rounds[round] || []).length > 0 && pool.rounds[round].every(id => s.games[id] && s.games[id].status !== "pending");
  H["round.confirm"] = (st, a) => {
    const s = getSession(st, a.sid, "live"), pool = s.pools.find(p => p.id === a.pool) || fail("missing", "Pool not found.");
    const round = parseInt(a.round, 10), at = pool.confirmed || 0;
    if (round < at) return { round: at };                       // another device already moved this pool on
    if (round > at || round >= pool.rounds.length) fail("order", "That round is not being played yet.");
    if (!roundReady(s, pool, round)) fail("scores", "Enter every score in this round first.");
    pool.confirmed = round + 1;
    return { round: pool.confirmed };
  };
  /* Organiser only: undo a confirm made too early. Scores are untouched. */
  H["round.back"] = (st, a) => {
    const s = getSession(st, a.sid, "live"), pool = s.pools.find(p => p.id === a.pool) || fail("missing", "Pool not found.");
    if (!(pool.confirmed > 0)) fail("order", "This pool is already on its first round.");
    pool.confirmed -= 1;
    return { round: pool.confirmed };
  };
  H["session.substitute"] = (st, a) => {
    const s = getSession(st, a.sid, "setup", "live"), out = a.out, neu = a.in, pNew = getPlayer(st, neu);
    if (!pNew.active) fail("inactive", `${pNew.name} is marked as dropped out.`);
    const pool = s.pools.find(p => p.players.includes(out)) || fail("missing", "The player to replace is not in a pool.");
    if (s.pools.some(p => p.players.includes(neu))) fail("duplicate", `${pNew.name} is already playing in this session.`);
    let changed = 0;
    for (const g of Object.values(s.games)) if (g.pool === pool.id && g.status !== "done") for (const t of ["t1", "t2"]) if (g[t].includes(out)) { g[t] = g[t].map(p => (p === out ? neu : p)); changed++; }
    /* the replacement takes the leaver's place in the pool; someone who already played stays on the attendance list for the record */
    pool.players[pool.players.indexOf(out)] = neu;
    if (!doneGames(s).some(g => g.t1.concat(g.t2).includes(out))) s.attending = s.attending.filter(p => p !== out);
    if (!s.attending.includes(neu)) s.attending.push(neu);
    return { games: changed };
  };
  /* Finish one session object in place. Shared with the database transaction, so it copes with a raw database record. */
  function closeSession(s) {
    if (s.status !== "live") fail("status", `This session is ${s.status}, so that is not possible.`);
    const games = Object.values(s.games || {});
    if (!games.some(g => g.status === "done")) fail("scores", "No scores have been entered. Delete the session instead of finishing it.");
    games.forEach(g => { if (g.status === "pending") { g.status = "skipped"; g.auto = true; } });   // auto: skipped by Finish, not by a person
    s.status = "closed";
    s.wasClosed = true;
    return s;
  }
  H["session.close"] = (st, a) => { closeSession(getSession(st, a.sid, "live")); recompute(st); };
  H["session.reopen"] = (st, a) => {
    const s = getSession(st, a.sid, "closed");
    if (openSession(st)) fail("open", "Another session is already open.");
    const closed = st.sessions.filter(x => x.status === "closed").sort((x, y) => (x.date + "|" + x.id < y.date + "|" + y.id ? -1 : 1));
    if (closed[closed.length - 1] !== s) fail("order", "Only the most recent session can be reopened.");
    s.status = "live";
    s.wasClosed = true;                                                  // an imported session never passed through Finish here
    Object.values(s.games).forEach(g => { if (g.status === "skipped" && g.auto) { g.status = "pending"; delete g.auto; } });   // games marked not played by hand stay that way
    recompute(st);
  };

  /* Apply one action to a state document (mutates it). Throws ActionError. */
  function apply(state, kind, args, org) {
    const handler = H[kind];
    if (!handler) fail("unknown", `Unknown action ${kind}.`);
    if (!OPEN_ACTIONS.has(kind) && !org) fail("pin", "Organiser access needed.");
    const result = handler(state, args || {}, !!org) || {};
    state.version = (state.version || 0) + 1;
    return result;
  }

  Object.assign(L, { seasonOf, availCount, availCheck, rng, allOrders, compute, roundCount, poolCount, courtsFor, targetChoices, autoTarget, poolTarget, gameTarget, BONUS_BASE, generate, summary, emptyState, normalize, apply, scoreGame, checkScore, roundReady, closeSession,
    ActionError, OPEN_ACTIONS, MIN_POOL, MAX_POOL });
})(typeof module !== "undefined" && module.exports ? module.exports : (window.Ladder = {}));

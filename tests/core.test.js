/* Run from the Ladder App folder:  node tests/core.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const L = require("../docs/core.js");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + (e && e.message)); process.exitCode = 1; }
}
const throwsCode = (fn, code) => { try { fn(); } catch (e) { assert.strictEqual(e.code, code); return e; } assert.fail("expected " + code); };

test("8 players get the full whist design", () => {
  const players = Array.from({ length: 8 }, (_, i) => "p" + i), s = L.summary(players, L.generate(players, "x"));
  assert.deepStrictEqual([s.rounds, s.games, s.partnerMin, s.partnerMax, s.opposeMin, s.opposeMax, s.eachMin, s.eachMax], [7, 14, 1, 1, 2, 2, 7, 7]);
});

test("9 players get the whist design for nine: partners once, opponents twice, one sit-out each", () => {
  const players = Array.from({ length: 9 }, (_, i) => "p" + i);
  for (const seed of ["x", "s8A", "s7C"]) {
    const rounds = L.generate(players, seed), s = L.summary(players, rounds);
    assert.deepStrictEqual([s.rounds, s.games, s.partnerMin, s.partnerMax, s.opposeMin, s.opposeMax, s.eachMin, s.eachMax], [9, 18, 1, 1, 2, 2, 8, 8]);
    const sat = rounds.map(rd => players.filter(p => !rd.flat(2).includes(p)));
    assert.ok(sat.every(x => x.length === 1));
    assert.strictEqual(new Set(sat.flat()).size, 9);
  }
});

test("pools of 4 to 12 are valid and even", () => {
  for (let n = 4; n <= 12; n++) {
    const players = Array.from({ length: n }, (_, i) => "p" + i), rounds = L.generate(players, "y");
    for (const rd of rounds) {
      const used = rd.flat(2);
      assert.strictEqual(new Set(used).size, used.length, "player twice in a round, n=" + n);
      assert.strictEqual(rd.length, Math.floor(n / 4));
    }
    const s = L.summary(players, rounds);
    assert.strictEqual(s.eachMin, s.eachMax, "uneven games, n=" + n);
    assert.ok(Math.abs(s.eachMin - 7) <= 1, "n=" + n);
    assert.ok(s.partnerMax - s.partnerMin <= 2, "n=" + n);
  }
  const nine = Array.from({ length: 9 }, (_, i) => "p" + i);
  assert.deepStrictEqual(L.generate(nine, "s1A"), L.generate(nine, "s1A"));
});

test("ratings match the Python engine on the local league data (skipped if absent)", () => {
  const file = path.join(__dirname, "..", "data", "league.json");
  if (!fs.existsSync(file)) { console.log("     no data/league.json here, nothing to compare"); return; }
  const saved = JSON.parse(fs.readFileSync(file, "utf8")), st = L.normalize(JSON.parse(JSON.stringify(saved)));
  const got = L.compute(st);
  assert.ok(Object.keys(got.current).length >= 30);
  assert.deepStrictEqual(got.current, saved.ratings.current);
  assert.deepStrictEqual(got.totals, saved.ratings.totals);
  for (const sid in saved.ratings.sessions) for (const pid in saved.ratings.sessions[sid]) assert.deepStrictEqual(got.sessions[sid][pid], saved.ratings.sessions[sid][pid]);
});

function league(n) {
  const st = L.emptyState("Test League");
  for (let i = 0; i < n; i++) L.apply(st, "player.add", { name: "Player " + String(i + 1).padStart(2, "0"), seed: [3.7, 3.5, 3.3, 3.1][Math.floor(i / 8) % 4] }, true);
  return st;
}

test("full session flow: pools, new player, scores, clash, close, correction", () => {
  const st = league(32);
  throwsCode(() => L.apply(st, "session.create", { date: "2026-11-23" }, false), "pin");
  const sid = L.apply(st, "session.create", { date: "2026-11-23" }, true).id, sess = st.sessions[0];
  assert.strictEqual(sess.attending.length, 32);
  L.apply(st, "session.assign", { sid }, true);
  assert.deepStrictEqual(sess.pools.map(p => p.players.length), [8, 8, 8, 8]);
  assert.ok(sess.pools[0].players.every(p => st.players[p].seed === 3700));

  const neu = L.apply(st, "player.add", { name: "New Person", seed: 3.3, sid }, true).id;
  throwsCode(() => L.apply(st, "session.schedule", { sid }, true), "unassigned");
  L.apply(st, "session.move", { sid, pid: neu, to: "C" }, true);
  assert.strictEqual(sess.pools[2].players.length, 9);
  L.apply(st, "session.start", { sid }, true);
  assert.strictEqual(sess.status, "live");
  assert.strictEqual(sess.pools[0].rounds.flat().length, 14);

  const gid = sess.pools[0].rounds[0][0];
  L.apply(st, "game.score", { sid, gid, s1: 11, s2: 6 }, false);
  const clash = throwsCode(() => L.apply(st, "game.score", { sid, gid, s1: 11, s2: 4 }, false), "exists");
  assert.deepStrictEqual(clash.extra, { s1: 11, s2: 6 });
  L.apply(st, "game.score", { sid, gid, s1: 11, s2: 4, replace: true }, false);
  throwsCode(() => L.apply(st, "game.score", { sid, gid, s1: 7, s2: 7, replace: true }, false), "invalid");

  // rounds: scores stay on screen until someone confirms, then the pool moves on
  const poolA = sess.pools[0];
  assert.strictEqual(poolA.confirmed, 0);
  throwsCode(() => L.apply(st, "round.confirm", { sid, pool: "A", round: 0 }, false), "scores");
  L.apply(st, "game.score", { sid, gid: poolA.rounds[0][1], s1: 9, s2: 11 }, false);
  throwsCode(() => L.apply(st, "round.confirm", { sid, pool: "A", round: 1 }, false), "order");
  assert.strictEqual(L.apply(st, "round.confirm", { sid, pool: "A", round: 0 }, false).round, 1);
  assert.strictEqual(L.apply(st, "round.confirm", { sid, pool: "A", round: 0 }, false).round, 1);   // second device, same button
  assert.strictEqual(poolA.confirmed, 1);
  throwsCode(() => L.apply(st, "round.back", { sid, pool: "A" }, false), "pin");                     // organiser only
  assert.strictEqual(L.apply(st, "round.back", { sid, pool: "A" }, true).round, 0);
  throwsCode(() => L.apply(st, "round.back", { sid, pool: "A" }, true), "order");
  assert.strictEqual(sess.games[poolA.rounds[0][1]].status, "done");                                 // scores untouched
  L.apply(st, "round.confirm", { sid, pool: "A", round: 0 }, false);

  const before = Object.assign({}, st.ratings.current);
  let i = 0;
  for (const g of Object.values(sess.games)) if (g.pool === "A" && g.status === "pending") {
    const ls = (i * 3) % 10, t1Wins = i++ % 3 !== 0;
    L.apply(st, "game.score", { sid, gid: g.id, s1: t1Wins ? 15 : ls, s2: t1Wins ? ls : 15 }, false);
  }
  throwsCode(() => L.apply(st, "session.close", { sid }, false), "pin");
  L.apply(st, "session.close", { sid }, true);
  assert.strictEqual(sess.status, "closed");
  assert.ok(sess.pools[0].players.every(p => st.ratings.current[p] !== before[p]));
  assert.strictEqual(st.ratings.current[sess.pools[1].players[0]], before[sess.pools[1].players[0]]);
  const rec = st.ratings.sessions[sid][sess.pools[0].players[0]];
  assert.strictEqual(rec.w + rec.l, 7);
  /* Pool A is an eight on a night with a nine, so it played to 15: the bonus is scaled back to a game to 11.
     Each game adds twice (winners' bonus + losers' bonus) across its four players, plus 0.002 on an exact half-thousandth. */
  assert.deepStrictEqual(sess.pools.map(p => p.target), [15, 15, 11, 15]);
  const sc = v => Math.floor((22 * v + 15) / 30);
  const want = Object.values(sess.games).filter(g => g.pool === "A" && g.status === "done").reduce((t, g) => { const w = Math.max(g.s1, g.s2), l = Math.min(g.s1, g.s2); return t + 2 * (sc(w - l) + sc(l)); }, 0);
  const sum = Object.values(st.ratings.sessions[sid]).reduce((t, r) => t + r.end - r.start, 0);
  assert.ok(want > 14 * 18 && want < 14 * 26, "a game to 15 is worth about what a game to 11 is, got " + want);
  assert.ok(sum - want >= -8 && sum - want <= 8, "ratings moved by the scaled bonus, got " + sum + " against " + want);

  throwsCode(() => L.apply(st, "game.score", { sid, gid, s1: 11, s2: 9, replace: true }, false), "pin");
  const after = JSON.stringify(st.ratings.current);
  throwsCode(() => L.apply(st, "game.score", { sid, gid, s1: 4, s2: 11, replace: true }, true), "closed");   // a stray score screen cannot touch a finished night
  L.apply(st, "game.score", { sid, gid, s1: 4, s2: 11, replace: true, history: true }, true);
  assert.notStrictEqual(JSON.stringify(st.ratings.current), after);
});

test("substitute, dropout, uneven attendance, database round trip", () => {
  const st = league(34);
  const sid = L.apply(st, "session.create", { date: "2026-11-23" }, true).id, sess = st.sessions[0];
  ["p33", "p34"].forEach(pid => L.apply(st, "session.attend", { sid, pid, on: false }, true));
  ["p1", "p2", "p3"].forEach(pid => L.apply(st, "session.attend", { sid, pid, on: false }, true));
  L.apply(st, "session.assign", { sid }, true);
  assert.deepStrictEqual(sess.pools.map(p => p.players.length), [9, 10, 10]);      // 29: no pools of seven, the extras go to the lower pools
  assert.deepStrictEqual(sess.pools.map(p => p.courts), [2, 2, 2]);
  L.apply(st, "session.start", { sid }, true);
  assert.strictEqual(sess.pools[1].rounds.flat().length, 20);
  const out = sess.pools[2].players[0];
  const res = L.apply(st, "session.substitute", { sid, out, in: "p33" }, true);
  assert.strictEqual(res.games, 8);
  assert.ok(!Object.values(sess.games).some(g => g.t1.concat(g.t2).includes(out)));

  // what a database does to the document: drops nulls and empty lists, keys sessions by id
  const db = JSON.parse(JSON.stringify(st, (k, v) => (v === null || (Array.isArray(v) && !v.length) ? undefined : v)));
  db.sessions = { [sess.id]: db.sessions[0] };
  const back = L.normalize(db);
  assert.deepStrictEqual(back.sessions[0].games, sess.games);
  assert.deepStrictEqual(back.sessions[0].pools, sess.pools);

  L.apply(st, "player.update", { id: out, active: false }, true);
  L.apply(st, "session.delete", { sid }, true);
  L.apply(st, "session.create", { date: "2026-11-30" }, true);
  assert.ok(!st.sessions[0].attending.includes(out));
});

test("reset: scores and rounds cleared, draw kept, organiser only", () => {
  const st = league(8);
  const sid = L.apply(st, "session.create", { date: "2026-11-30" }, true).id, sess = st.sessions[0];
  L.apply(st, "session.assign", { sid }, true);
  L.apply(st, "session.start", { sid }, true);
  const pool = sess.pools[0], draw = JSON.stringify(pool.rounds), teams = JSON.stringify(Object.values(sess.games).map(g => [g.t1, g.t2]));
  pool.rounds[0].forEach(gid => L.apply(st, "game.score", { sid, gid, s1: 11, s2: 5 }, false));
  L.apply(st, "round.confirm", { sid, pool: pool.id, round: 0 }, false);
  L.apply(st, "game.skip", { sid, gid: pool.rounds[1][0] }, true);
  throwsCode(() => L.apply(st, "session.reset", { sid }, false), "pin");
  assert.strictEqual(L.apply(st, "session.reset", { sid }, true).games, 14);
  assert.ok(Object.values(sess.games).every(g => g.status === "pending" && g.s1 === null && g.s2 === null && !("at" in g)));
  assert.strictEqual(pool.confirmed, 0);
  assert.strictEqual(JSON.stringify(pool.rounds), draw);
  assert.strictEqual(JSON.stringify(Object.values(sess.games).map(g => [g.t1, g.t2])), teams);
  assert.strictEqual(sess.status, "live");
});

test("sessions: no back-dating, no finishing an empty session", () => {
  const st = league(8);
  const sid = L.apply(st, "session.create", { date: "2026-11-23" }, true).id, sess = st.sessions[0];
  L.apply(st, "session.assign", { sid }, true);
  L.apply(st, "session.start", { sid }, true);
  throwsCode(() => L.apply(st, "session.close", { sid }, true), "scores");
  assert.strictEqual(sess.status, "live");
  L.apply(st, "game.score", { sid, gid: sess.pools[0].rounds[0][0], s1: 11, s2: 3 }, false);
  L.apply(st, "session.close", { sid }, true);
  throwsCode(() => L.apply(st, "session.create", { date: "2026-11-16" }, true), "date");
  assert.strictEqual(st.sessions.length, 1);
  L.apply(st, "session.create", { date: "2026-11-23" }, true);                  // same day is allowed
  assert.strictEqual(st.sessions.length, 2);
});

test("score safety: stale edits, score cap, session keeps its target", () => {
  const st = league(8);
  const sid = L.apply(st, "session.create", { date: "2026-11-23" }, true).id, sess = st.sessions[0];
  L.apply(st, "session.assign", { sid }, true);
  L.apply(st, "session.start", { sid }, true);
  assert.strictEqual(sess.pointsToWin, 11);
  throwsCode(() => L.apply(st, "league.update", { pointsToWin: "15.5" }, true), "invalid");
  throwsCode(() => L.apply(st, "league.update", { pointsToWin: "" }, true), "invalid");
  L.apply(st, "league.update", { pointsToWin: 15 }, true);
  const gid = sess.pools[0].rounds[0][0];
  throwsCode(() => L.apply(st, "game.score", { sid, gid, s1: 15, s2: 9 }, false), "invalid");    // this session is still first to 11
  L.apply(st, "game.score", { sid, gid, s1: 8, s2: 6 }, false);                                  // a game stopped early
  L.apply(st, "game.score", { sid, gid, s1: 11, s2: 7, replace: true, was: { s1: 8, s2: 6 } }, false);
  L.apply(st, "game.score", { sid, gid, s1: 9, s2: 11, replace: true }, false);                 // another device changes it
  const e = throwsCode(() => L.apply(st, "game.score", { sid, gid, s1: 11, s2: 2, replace: true, was: { s1: 11, s2: 7 } }, false), "exists");
  assert.deepStrictEqual(e.extra, { s1: 9, s2: 11 });
  assert.deepStrictEqual([sess.games[gid].s1, sess.games[gid].s2], [9, 11]);
});

test("reopen keeps hand-marked not-played games; substitute; delete needs a yes", () => {
  const st = league(9);
  const sid = L.apply(st, "session.create", { date: "2026-11-23" }, true).id, sess = st.sessions[0];
  L.apply(st, "session.attend", { sid, pid: "p9", on: false }, true);
  L.apply(st, "session.assign", { sid }, true);
  L.apply(st, "session.start", { sid }, true);
  const pool = sess.pools[0], [g1, g2] = pool.rounds[0], byHand = pool.rounds[1][0];
  L.apply(st, "game.score", { sid, gid: g1, s1: 11, s2: 5 }, false);
  L.apply(st, "game.skip", { sid, gid: byHand }, true);
  const out = sess.games[g1].t1[0];
  assert.strictEqual(L.apply(st, "session.substitute", { sid, out, in: "p9" }, true).games, 6);
  assert.strictEqual(pool.players.length, 8);
  assert.ok(pool.players.includes("p9") && !pool.players.includes(out));
  assert.ok(sess.attending.includes(out));                      // they played, so they stay on the record
  throwsCode(() => L.apply(st, "session.substitute", { sid, out, in: "p9" }, true), "missing");
  L.apply(st, "session.close", { sid }, true);
  assert.strictEqual(sess.games[g2].status, "skipped");
  L.apply(st, "session.reopen", { sid }, true);
  assert.strictEqual(sess.games[g2].status, "pending");          // skipped by Finish: back to play
  assert.strictEqual(sess.games[byHand].status, "skipped");      // skipped by hand: stays
  throwsCode(() => L.apply(st, "session.delete", { sid }, true), "scores");
  L.apply(st, "session.delete", { sid, force: true }, true);
  assert.strictEqual(st.sessions.length, 0);
});

test("the sampled order average is the published one (same numbers as the Python engine)", () => {
  /* a pool of 7 plays 14 rounds, which is past the exact limit, so this goes through the seeded sampler */
  const start = {}, rounds = [];
  for (let i = 0; i < 7; i++) start["p" + i] = 3100 + 100 * i;
  for (let r = 0; r < 14; r++) rounds.push([{ gid: "g" + r, win: ["p" + (r % 7), "p" + ((r + 1) % 7)], lose: ["p" + ((r + 3) % 7), "p" + ((r + 5) % 7)], ws: 11, ls: (r * 3) % 10 }]);
  const res = L.allOrders(start, rounds), got = Object.keys(start).map(p => Math.floor(res.ends[p] * 1000 + 0.5));
  const file = path.join(__dirname, "parity.json");
  if (process.env.WRITE_PARITY) fs.writeFileSync(file, JSON.stringify({ ends: got }) + "\n");
  assert.deepStrictEqual(got, JSON.parse(fs.readFileSync(file, "utf8")).ends);
});

test("pool count: eights and nines where they fit, tens to twelves before sevens", () => {
  const want = { 8: 1, 9: 1, 11: 1, 12: 1, 13: 2, 15: 2, 16: 2, 18: 2, 20: 2, 22: 2, 23: 2, 24: 3, 25: 3, 27: 3, 28: 3, 31: 3, 32: 4, 33: 4, 34: 4, 36: 4, 37: 4, 39: 4, 40: 5, 45: 5, 48: 6 };
  for (const n in want) assert.strictEqual(L.poolCount(+n), want[n], "n=" + n);
  const sizes = n => { const st = league(n), sid = L.apply(st, "session.create", { date: "2026-11-27" }, true).id; L.apply(st, "session.assign", { sid }, true); return st.sessions[0].pools.map(p => p.players.length).join(","); };
  assert.strictEqual(sizes(36), "9,9,9,9");
  assert.strictEqual(sizes(34), "8,8,9,9");
  assert.strictEqual(sizes(25), "8,8,9");
  assert.strictEqual(sizes(33), "8,8,8,9");
  assert.strictEqual(sizes(23), "11,12");            // not 7, 8, 8: a seven plays one game at a time and takes twice as long
  assert.strictEqual(sizes(28), "9,9,10");
});

test("game target per pool: automatic by pool size, set by hand, fixed at the start, score cap", () => {
  assert.deepStrictEqual(L.targetChoices(11), [11, 15, 21]);
  assert.deepStrictEqual(L.targetChoices(15), [15, 21]);
  assert.strictEqual(L.autoTarget([8, 8, 8, 8], 8, 11), 11);        // all the same size: the league setting
  assert.strictEqual(L.autoTarget([8, 8, 9, 9], 8, 11), 15);        // 7 rounds to 15 (105) beside 9 rounds to 11 (99)
  assert.strictEqual(L.autoTarget([8, 8, 9, 9], 9, 11), 11);
  assert.strictEqual(L.autoTarget([10, 9, 9], 9, 11), 11);
  assert.strictEqual(L.autoTarget([8, 9], 8, 15), 21);              // a longer night: 147 beside 135
  assert.strictEqual(L.autoTarget([8, 9], 9, 15), 15);
  /* a pool under eight (one game at a time, many rounds) does not set the pace: one seven must not send the eights to 21 */
  assert.deepStrictEqual([7, 8].map(n => L.autoTarget([7, 8, 8], n, 11)), [11, 11]);
  assert.deepStrictEqual([7, 8, 9].map(n => L.autoTarget([7, 8, 9, 9], n, 11)), [11, 15, 11]);
  assert.deepStrictEqual([6, 7].map(n => L.autoTarget([6, 7], n, 11)), [11, 11]);
  assert.strictEqual(L.autoTarget([4, 9, 9], 4, 11), 15);           // a four plays 7 rounds like an eight
  assert.deepStrictEqual([11, 12].map(n => L.autoTarget([11, 12], n, 11)), [11, 15]);
  const st = league(34), sid = L.apply(st, "session.create", { date: "2026-11-27" }, true).id, sess = st.sessions[0];
  L.apply(st, "session.assign", { sid }, true);
  assert.deepStrictEqual(sess.pools.map(p => p.players.length), [8, 8, 9, 9]);
  assert.deepStrictEqual(sess.pools.map(p => L.poolTarget(st, sess, p)), [15, 15, 11, 11]);
  assert.ok(sess.pools.every(p => p.target === undefined));         // automatic until the start
  throwsCode(() => L.apply(st, "session.pool", { sid, pool: "A", target: 13 }, true), "invalid");
  throwsCode(() => L.apply(st, "session.pool", { sid, pool: "A", target: 21 }, false), "pin");
  L.apply(st, "session.pool", { sid, pool: "D", target: 21 }, true);
  L.apply(st, "session.pool", { sid, pool: "A", target: 11 }, true);
  L.apply(st, "session.pool", { sid, pool: "A", target: "auto" }, true);
  assert.deepStrictEqual(sess.pools.map(p => L.poolTarget(st, sess, p)), [15, 15, 11, 21]);
  L.apply(st, "session.start", { sid }, true);
  assert.deepStrictEqual(sess.pools.map(p => p.target), [15, 15, 11, 21]);
  throwsCode(() => L.apply(st, "session.pool", { sid, pool: "B", target: 11 }, true), "status");
  L.apply(st, "session.unstart", { sid }, true);
  assert.deepStrictEqual(sess.pools.map(p => p.target), [undefined, undefined, undefined, 21]);      // hand-set stays, automatic is worked out again
  L.apply(st, "session.start", { sid }, true);
  const a = sess.pools[0].rounds[0][0], c = sess.pools[2].rounds[0][0], d = sess.pools[3].rounds[0][0];
  throwsCode(() => L.apply(st, "game.score", { sid, gid: c, s1: 15, s2: 9 }, false), "invalid");      // the nines play to 11
  L.apply(st, "game.score", { sid, gid: c, s1: 11, s2: 9 }, false);
  L.apply(st, "game.score", { sid, gid: a, s1: 15, s2: 9 }, false);
  throwsCode(() => L.apply(st, "game.score", { sid, gid: d, s1: 22, s2: 20 }, false), "invalid");
  L.apply(st, "game.score", { sid, gid: d, s1: 21, s2: 20 }, false);
  assert.strictEqual(L.gameTarget(st, sess, a), 15);
  L.apply(st, "session.close", { sid }, true);
  /* one game in the pool, so its change is the formula on the seeds: a 21-20 game adds no more bonus than an 11-10 one */
  const top = sess.games[d], seed = id => st.players[id].seed, r = st.ratings.sessions[sid];
  const prob = 1 / (1 + Math.exp(-8.988 * (seed(top.t1[0]) + seed(top.t1[1]) - seed(top.t2[0]) - seed(top.t2[1])) / 2000)), e = 10000 - Math.floor(prob * 10000 + 0.5);
  assert.strictEqual(r[top.t1[0]].end - r[top.t1[0]].start, Math.floor((e + 50) / 100) + 1);       // winners: round(1 x 11/21) = 1
  assert.strictEqual(r[top.t2[0]].end - r[top.t2[0]].start, 10 - Math.floor((e + 49) / 100));      // losers: round(20 x 11/21) = 10
});

test("same as last week: attendance copied from the last finished session", () => {
  const st = league(12);
  throwsCode(() => { const sid0 = L.apply(st, "session.create", { date: "2026-11-16" }, true).id; L.apply(st, "session.attendAll", { sid: sid0, last: true }, true); }, "none");
  const sid = st.sessions[0].id, first = st.sessions[0];
  ["p9", "p10", "p11", "p12"].forEach(pid => L.apply(st, "session.attend", { sid, pid, on: false }, true));
  L.apply(st, "session.assign", { sid }, true);
  L.apply(st, "session.start", { sid }, true);
  L.apply(st, "game.score", { sid, gid: first.pools[0].rounds[0][0], s1: 11, s2: 3 }, false);
  L.apply(st, "session.close", { sid }, true);
  L.apply(st, "player.update", { id: "p8", active: false }, true);              // dropped out since
  const sid2 = L.apply(st, "session.create", { date: "2026-11-23" }, true).id, next = st.sessions[1];
  L.apply(st, "session.attendAll", { sid: sid2, on: true }, true);
  assert.strictEqual(next.attending.length, 11);
  L.apply(st, "session.assign", { sid: sid2 }, true);
  assert.strictEqual(L.apply(st, "session.attendAll", { sid: sid2, last: true }, true).players, 7);
  assert.deepStrictEqual(next.attending.slice().sort(), ["p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
  assert.ok(next.pools.every(p => p.players.every(pid => next.attending.includes(pid))));       // nobody left in a pool who is not playing
  throwsCode(() => L.apply(st, "session.attendAll", { sid: sid2, last: true }, false), "pin");
});

test("old sessions keep their cap; a reopened session cannot be reset; courts follow the pool's size", () => {
  const st = league(17), sid = L.apply(st, "session.create", { date: "2026-11-27" }, true).id, sess = st.sessions[0];
  L.apply(st, "session.assign", { sid }, true);
  assert.deepStrictEqual(sess.pools.map(p => [p.players.length, p.courts]), [[8, 2], [9, 2]]);
  const mover = sess.pools[0].players[7];
  L.apply(st, "session.move", { sid, pid: mover, to: "none" }, true);
  assert.deepStrictEqual(sess.pools.map(p => [p.players.length, p.courts]), [[7, 1], [9, 2]]);      // a seven plays one game at a time
  L.apply(st, "session.move", { sid, pid: mover, to: "A" }, true);
  assert.strictEqual(sess.pools[0].courts, 2);
  L.apply(st, "session.pool", { sid, pool: "A", courts: 1 }, true);                                // set by hand: it stays
  L.apply(st, "session.move", { sid, pid: mover, to: "none" }, true);
  L.apply(st, "session.move", { sid, pid: mover, to: "A" }, true);
  assert.deepStrictEqual([sess.pools[0].courts, sess.pools[0].courtsHand], [1, true]);
  L.apply(st, "session.pool", { sid, pool: "A", courts: 2 }, true);                                // back to what the size gives
  assert.strictEqual(sess.pools[0].courtsHand, undefined);
  L.apply(st, "session.start", { sid }, true);
  const gid = sess.pools[1].rounds[0][0];
  L.apply(st, "game.score", { sid, gid, s1: 11, s2: 6 }, false);
  L.apply(st, "session.close", { sid }, true);
  /* as an imported season is stored: no target recorded anywhere. It was played to 11, and stays that way */
  delete sess.pointsToWin; delete sess.wasClosed; sess.pools.forEach(p => { delete p.target; delete p.autoTarget; });
  L.apply(st, "league.update", { pointsToWin: 15 }, true);
  assert.strictEqual(L.gameTarget(st, sess, gid), 11);
  assert.strictEqual(L.poolTarget(st, sess, sess.pools[1]), 11);
  throwsCode(() => L.apply(st, "game.score", { sid, gid, s1: 15, s2: 4, history: true, replace: true }, true), "invalid");
  L.apply(st, "session.reopen", { sid }, true);
  assert.strictEqual(sess.wasClosed, true);
  throwsCode(() => L.apply(st, "session.reset", { sid }, true), "reopened");
  assert.strictEqual(sess.games[gid].s1, 11);
});

test("availability: the season's nights, in and out, and a session that starts from the answers", () => {
  const st = league(10), ids = Object.keys(st.players), night = "2026-11-27";
  throwsCode(() => L.apply(st, "season.set", { dates: [night] }, false), "pin");
  L.apply(st, "season.set", { dates: ["2026-12-04", night, night] }, true);
  assert.deepStrictEqual(L.seasonOf(st), { dates: [night, "2026-12-04"], days: 1, time: "18:00", names: true });
  ids.slice(0, 6).forEach(pid => L.apply(st, "avail.set", { date: night, pid, v: "in" }, false));      // players answer for themselves: no organiser needed
  L.apply(st, "avail.set", { date: night, pid: ids[6], v: "out" }, false);
  throwsCode(() => L.apply(st, "avail.set", { date: "2026-11-20", pid: ids[0], v: "in" }, false), "date");
  throwsCode(() => L.apply(st, "avail.set", { date: night, pid: "nobody", v: "in" }, false), "missing");
  throwsCode(() => L.apply(st, "avail.set", { date: night, pid: ids[0], v: "maybe" }, false), "invalid");
  let c = L.availCount(st, night);
  assert.deepStrictEqual([c.in.length, c.out.length, c.none.length], [6, 1, 3]);
  L.apply(st, "avail.set", { date: night, pid: ids[0], v: null }, false);                             // an answer taken back
  L.apply(st, "player.update", { id: ids[1], active: false }, true);                                  // dropped out of the league: not counted
  throwsCode(() => L.apply(st, "avail.set", { date: night, pid: ids[1], v: "in" }, false), "inactive");
  c = L.availCount(st, night);
  assert.deepStrictEqual([c.in.length, c.out.length, c.none.length], [4, 1, 4]);

  const made = L.apply(st, "session.create", { date: night }, true), sid = made.id, sess = st.sessions[0];
  assert.strictEqual(made.from, "availability");
  assert.deepStrictEqual(sess.attending, ids.slice(2, 6));
  L.apply(st, "session.assign", { sid }, true);
  L.apply(st, "avail.set", { date: night, pid: ids[7], v: "in" }, false);                             // a late yes and a late no
  L.apply(st, "avail.set", { date: night, pid: ids[2], v: "out" }, false);
  assert.deepStrictEqual(L.apply(st, "session.useAvail", { sid }, true), { added: 1, removed: 1 });
  assert.deepStrictEqual(sess.attending.slice().sort(), [ids[3], ids[4], ids[5], ids[7]].sort());
  assert.ok(!sess.pools.some(p => p.players.includes(ids[2])));

  /* the organiser's tick is the player's answer too */
  L.apply(st, "session.attend", { sid, pid: ids[8], on: true }, true);                                // turned up without answering
  L.apply(st, "session.attend", { sid, pid: ids[3], on: false }, true);                               // rang to say they are out
  assert.deepStrictEqual([st.availability[night][ids[8]].v, st.availability[night][ids[3]].v, st.availability[night][ids[3]].by], ["in", "out", "org"]);
  assert.deepStrictEqual(L.availCount(st, night).in.slice().sort(), sess.attending.slice().sort());

  L.apply(st, "season.set", { dates: ["2026-12-04"], days: 0, time: "12:30", names: false }, true);
  assert.strictEqual(st.availability[night], undefined);                                              // answers go with a night taken off the calendar
  assert.deepStrictEqual(L.seasonOf(st), { dates: ["2026-12-04"], days: 0, time: "12:30", names: false });
  throwsCode(() => L.apply(st, "season.set", { time: "6pm" }, true), "invalid");
  assert.deepStrictEqual(L.seasonOf(L.normalize(JSON.parse(JSON.stringify(st)))).dates, ["2026-12-04"]);
  /* a night nobody has answered for starts from last week, as before */
  const plain = league(8);
  assert.strictEqual(L.apply(plain, "session.create", { date: night }, true).from, "last");
  assert.strictEqual(plain.sessions[0].attending.length, 8);
});

test("eights and nines play pickleballranker's rounds, slots in pool order", () => {
  const eight = Array.from({ length: 8 }, (_, i) => String(i + 1)), nine = Array.from({ length: 9 }, (_, i) => String(i + 1));
  const show = rounds => rounds.map(rd => rd.map(([a, b]) => a.join("") + "v" + b.join("")).join(" ")).join("|");
  const r8 = L.generate(eight, "any", "ranker"), r9 = L.generate(nine, "other", "ranker");
  assert.strictEqual(show(r8), "18v26 34v57|16v45 28v37|14v38 27v56|13v67 25v48|17v24 36v58|12v35 47v68|15v78 23v46");
  assert.strictEqual(show(r9), "23v47 59v68|13v58 49v67|12v69 48v57|17v56 29v38|19v37 28v46|18v27 39v45|14v89 26v35|16v34 25v79|15v24 36v78");
  assert.deepStrictEqual(L.generate(eight, "a different night", "ranker"), r8);                       // the same every night
  let s = L.summary(eight, r8);
  assert.deepStrictEqual([s.rounds, s.partnerMin, s.partnerMax, s.opposeMin, s.opposeMax], [7, 1, 1, 2, 2]);
  s = L.summary(nine, r9);
  assert.deepStrictEqual([s.rounds, s.partnerMin, s.partnerMax, s.opposeMin, s.opposeMax], [9, 1, 1, 2, 2]);
  assert.deepStrictEqual(r9.map(rd => nine.find(p => !rd.flat(2).includes(p))), nine);                // slot 1 sits out round 1, slot 9 the last
  assert.notDeepStrictEqual(L.generate(eight, "any", "mixed"), r8);
  /* "closest": the same games, the closest round last */
  const c8 = L.generate(eight, "any", "closest"), c9 = L.generate(nine, "any", "closest");
  assert.deepStrictEqual(c8, [1, 3, 5, 4, 6, 7, 2].map(k => r8[k - 1]));
  assert.deepStrictEqual(c9, [9, 3, 1, 2, 4, 7, 6, 8, 5].map(k => r9[k - 1]));
  assert.strictEqual(show([c8[6]]), "16v45 28v37");
  assert.deepStrictEqual(c9.map(rd => nine.find(p => !rd.flat(2).includes(p))), ["9", "3", "1", "2", "4", "7", "6", "8", "5"]);
  assert.strictEqual(L.generate(Array.from({ length: 10 }, (_, i) => "p" + i), "x", "ranker").length, L.roundCount(10));   // other sizes as before

  /* through a session: the pool's order is the slot order, and the organiser can swap two slots */
  const st = league(8);
  assert.strictEqual(st.league.schedule, "ranker");
  const sid = L.apply(st, "session.create", { date: "2026-11-27" }, true).id, sess = st.sessions[0];
  L.apply(st, "session.assign", { sid }, true);
  const before = sess.pools[0].players.slice();
  throwsCode(() => L.apply(st, "session.swap", { sid, a: before[0], b: before[7] }, false), "pin");
  assert.deepStrictEqual(L.apply(st, "session.swap", { sid, a: before[4], b: before[5] }, true).slots, [5, 6]);
  throwsCode(() => L.apply(st, "session.swap", { sid, a: before[0], b: before[0] }, true), "invalid");
  const order = sess.pools[0].players.slice();
  assert.deepStrictEqual([order[4], order[5]], [before[5], before[4]]);
  L.apply(st, "session.start", { sid }, true);
  const first = sess.pools[0].rounds[0].map(gid => sess.games[gid]), slot = id => order.indexOf(id) + 1;
  assert.strictEqual(first.map(g => g.t1.map(slot).join("") + "v" + g.t2.map(slot).join("")).join(" "), "18v26 34v57");
  L.apply(st, "session.unstart", { sid }, true);
  L.apply(st, "league.update", { schedule: "closest" }, true);
  L.apply(st, "session.start", { sid }, true);
  assert.strictEqual(sess.pools[0].rounds[6].map(gid => sess.games[gid]).map(g => g.t1.map(slot).join("") + "v" + g.t2.map(slot).join("")).join(" "), "16v45 28v37");
  L.apply(st, "session.unstart", { sid }, true);
  L.apply(st, "league.update", { schedule: "mixed" }, true);
  throwsCode(() => L.apply(st, "league.update", { schedule: "random" }, true), "invalid");
});

console.log(`${passed} passed`);

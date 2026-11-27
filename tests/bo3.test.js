/* Best of 3 for a pool of four: three matches, the third game passed over when a match is won 2-0. Run: node tests/bo3.test.js */
const L = require("../docs/core.js");
const assert = require("assert");
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok   " + name); };
const code = fn => { try { fn(); } catch (e) { return e.code; } return null; };

function night() {
  const st = L.emptyState("Test");
  for (let i = 0; i < 13; i++) L.apply(st, "player.add", { name: "Player " + String(i + 1).padStart(2, "0"), seed: i < 9 ? 3.5 : 2.5 }, true);
  const sid = L.apply(st, "session.create", { date: "2026-11-27" }, true).id, s = st.sessions[0];
  Object.keys(st.players).forEach(pid => { if (!s.attending.includes(pid)) L.apply(st, "session.attend", { sid, pid, on: true }, true); });
  L.apply(st, "session.assign", { sid }, true);
  while (s.pools[0].players.length < 9) L.apply(st, "session.move", { sid, pid: s.pools[1].players[0], to: "A" }, true);
  return { st, sid, s };
}

test("only a pool of four can play best of 3, and only before the start", () => {
  const { st, sid, s } = night();
  assert.deepStrictEqual(s.pools.map(p => p.players.length), [9, 4]);
  assert.strictEqual(code(() => L.apply(st, "session.pool", { sid, pool: "A", bestOf: 3 }, true)), "invalid");
  L.apply(st, "session.pool", { sid, pool: "B", bestOf: 3 }, true);
  assert.strictEqual(s.pools[1].bestOf, 3);
  L.apply(st, "session.pool", { sid, pool: "B", bestOf: 1 }, true);
  assert.strictEqual(s.pools[1].bestOf, undefined);
  L.apply(st, "session.pool", { sid, pool: "B", bestOf: 3 }, true);
  L.apply(st, "session.start", { sid }, true);
  assert.strictEqual(code(() => L.apply(st, "session.pool", { sid, pool: "B", bestOf: 1 }, true)), "status");
});

test("nine rounds: each pairing three times running, same sides; the nine is untouched", () => {
  const { st, sid, s } = night();
  L.apply(st, "session.pool", { sid, pool: "B", bestOf: 3 }, true);
  L.apply(st, "session.start", { sid }, true);
  const [a, b] = s.pools, p = b.players, g = r => s.games[b.rounds[r][0]];
  assert.strictEqual(a.rounds.length, 9); assert.strictEqual(a.rounds[0].length, 2);
  assert.strictEqual(b.rounds.length, 9);
  assert.ok(b.rounds.every(rd => rd.length === 1));
  [[0, [p[0], p[3]], [p[1], p[2]]], [3, [p[0], p[2]], [p[1], p[3]]], [6, [p[0], p[1]], [p[2], p[3]]]].forEach(([r, t1, t2]) => {
    for (let k = 0; k < 3; k++) { assert.deepStrictEqual(g(r + k).t1, t1); assert.deepStrictEqual(g(r + k).t2, t2); }
  });
  assert.strictEqual(b.target, 15);
});

test("2-0 passes over the third game; 1-1 plays it; Finish records the unplayed third game as not played", () => {
  const { st, sid, s } = night();
  L.apply(st, "session.pool", { sid, pool: "B", bestOf: 3 }, true);
  L.apply(st, "session.start", { sid }, true);
  const b = s.pools[1], gid = r => b.rounds[r][0];
  const score = (r, s1, s2) => L.apply(st, "game.score", { sid, gid: gid(r), s1, s2 }, false);
  const confirm = r => L.apply(st, "round.confirm", { sid, pool: "B", round: r }, false).round;
  assert.strictEqual(code(() => score(0, 16, 14)), "invalid");                 // first to 15, win by 1
  score(0, 15, 14);
  assert.strictEqual(confirm(0), 1);
  assert.strictEqual(L.deadRound(s, b, 2), false);
  score(1, 15, 9);
  assert.strictEqual(L.deadRound(s, b, 2), true);
  assert.strictEqual(L.deadGame(s, s.games[gid(2)]), true);
  assert.strictEqual(confirm(1), 3);                                          // straight to the second match
  score(3, 15, 10); assert.strictEqual(confirm(3), 4);
  score(4, 7, 15);
  assert.strictEqual(L.deadRound(s, b, 5), false);
  assert.strictEqual(confirm(4), 5);                                          // 1-1: the decider is played
  assert.strictEqual(code(() => confirm(5)), "scores");
  score(5, 15, 13); assert.strictEqual(confirm(5), 6);
  score(6, 3, 15); assert.strictEqual(confirm(6), 7);
  score(7, 11, 15);
  assert.strictEqual(confirm(7), 9);                                          // 2-0 in the last match: the pool is finished
  /* a correction that makes the first match 1-1 brings its third game back */
  L.apply(st, "game.score", { sid, gid: gid(1), s1: 9, s2: 15, replace: true, was: { s1: 15, s2: 9 } }, false);
  assert.strictEqual(L.deadRound(s, b, 2), false);
  L.apply(st, "game.score", { sid, gid: gid(1), s1: 15, s2: 9, replace: true, was: { s1: 9, s2: 15 } }, false);
  assert.strictEqual(L.deadRound(s, b, 2), true);
  L.apply(st, "session.close", { sid }, true);
  assert.strictEqual(s.status, "closed");
  assert.strictEqual(s.games[gid(2)].status, "skipped");
  assert.strictEqual(s.games[gid(8)].status, "skipped");
  assert.strictEqual(Object.values(s.games).filter(g => g.pool === "B" && g.status === "done").length, 7);
  const tot = st.ratings.totals, p = b.players;
  assert.strictEqual(p.reduce((n, id) => n + tot[id].w + tot[id].l, 0), 28);  // 7 games, 4 players each
});

console.log(passed + " passed");

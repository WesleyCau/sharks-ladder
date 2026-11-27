/* Swapping two players once a session has started: the draw stays, the two exchange names in every game of their pool. Run: node tests/swap.test.js */
const L = require("../docs/core.js");
const assert = require("assert");
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok   " + name); };
const code = fn => { try { fn(); } catch (e) { return e.code; } return null; };

/* 17 players: a pool of nine and a pool of eight. wrong: the nine starts with slots 1 and 9 the other way round. */
function night(wrong) {
  const st = L.emptyState("Test");
  for (let i = 0; i < 17; i++) L.apply(st, "player.add", { name: "Player " + String(i + 1).padStart(2, "0"), seed: 4 - i / 10 }, true);
  const sid = L.apply(st, "session.create", { date: "2026-11-27" }, true).id, s = st.sessions[0];
  Object.keys(st.players).forEach(pid => { if (!s.attending.includes(pid)) L.apply(st, "session.attend", { sid, pid, on: true }, true); });
  L.apply(st, "session.assign", { sid }, true);
  while (s.pools[0].players.length < 9) L.apply(st, "session.move", { sid, pid: s.pools[1].players[0], to: "A" }, true);
  const p = s.pools[0].players.slice();
  if (wrong) L.apply(st, "session.swap", { sid, a: p[0], b: p[8] }, true);
  L.apply(st, "session.start", { sid }, true);
  return { st, sid, s, first: p[0], last: p[8] };
}
const draw = (s, pool) => pool.rounds.map(rd => rd.map(gid => [s.games[gid].t1, s.games[gid].t2]));

test("a live swap gives the draw the right order would have given, and each score stays with its place on the sheet", () => {
  const right = night(false), { st, sid, s, first, last } = night(true), pool = s.pools[0];
  assert.notDeepStrictEqual(draw(s, pool), draw(right.s, right.s.pools[0]));
  const scored = pool.rounds[0].concat(pool.rounds[1]);
  scored.forEach((gid, k) => L.apply(st, "game.score", { sid, gid, s1: 11, s2: k + 1 }, false));
  L.apply(st, "round.confirm", { sid, pool: "A", round: 0 }, false);
  const other = draw(s, s.pools[1]);
  const res = L.apply(st, "session.swap", { sid, a: first, b: last }, true);
  assert.deepStrictEqual(res.slots, [9, 1]);
  assert.strictEqual(res.games, 13);                                           // 8 games each, 3 of them together
  assert.strictEqual(s.status, "live");
  assert.deepStrictEqual(pool.players, right.s.pools[0].players);
  assert.deepStrictEqual(draw(s, pool), draw(right.s, right.s.pools[0]));
  scored.forEach((gid, k) => assert.deepStrictEqual([s.games[gid].status, s.games[gid].s1, s.games[gid].s2], ["done", 11, k + 1]));
  assert.strictEqual(pool.confirmed, 1);
  assert.deepStrictEqual(draw(s, s.pools[1]), other);                          // the other pool is untouched
  L.apply(st, "session.swap", { sid, a: first, b: last }, true);               // swapping again undoes it
  assert.notDeepStrictEqual(draw(s, pool), draw(right.s, right.s.pools[0]));
});

test("organiser only, same pool only, and not once the session is finished", () => {
  const { st, sid, s, first, last } = night(true);
  assert.strictEqual(code(() => L.apply(st, "session.swap", { sid, a: first, b: last }, false)), "pin");
  assert.strictEqual(code(() => L.apply(st, "session.swap", { sid, a: first, b: s.pools[1].players[0] }, true)), "invalid");
  assert.strictEqual(code(() => L.apply(st, "session.swap", { sid, a: first, b: first }, true)), "invalid");
  L.apply(st, "game.score", { sid, gid: s.pools[0].rounds[0][0], s1: 11, s2: 4 }, false);
  L.apply(st, "session.close", { sid }, true);
  assert.strictEqual(code(() => L.apply(st, "session.swap", { sid, a: first, b: last }, true)), "status");
});

console.log(passed + " passed");

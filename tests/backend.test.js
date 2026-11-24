/* Run from the Ladder App folder:  node tests/backend.test.js
   Drives the website's database backend (docs/backend.js) against an in-memory stand-in for Firebase,
   including a "second device" that writes without this one having seen it yet. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

global.Ladder = require("../docs/core.js");
global.window = { LADDER_CONFIG: { openOrganiser: true } };
const Backends = new Function(fs.readFileSync(path.join(__dirname, "..", "docs", "backend.js"), "utf8") + "\nreturn Backends;")();

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n     ") : e)); process.exitCode = 1; }
}

(async () => {
  let state = null, online = null;
  const be = await Backends.firebase({ databaseURL: "stand-in", sdkBase: pathToFileURL(path.join(__dirname, "fake-firebase")).href + "/" }, j => { state = j.state; }, on => { online = on; });
  const db = global.__fakeDb;
  be.start();
  const ok = async (type, args) => { const j = await be.send(type, args); assert.ok(j.ok, `${type}: ${j.code} ${j.message}`); return j.result; };
  let sid, sess, pool;

  await test("new ids are reserved in the database, so a second organiser device cannot collide", async () => {
    assert.strictEqual(be.kind, "firebase");
    assert.ok(be.isOrg());
    for (let i = 1; i <= 8; i++) await ok("player.add", { name: "Player " + i, seed: 3.5 });
    assert.strictEqual(Object.keys(db.read("players")).length, 8);
    assert.strictEqual(db.read("seq/p"), 8);
    /* another device adds two players; this device has not heard yet */
    db.write("players/p9", { id: "p9", name: "Other Device A", active: true, seed: 3300 }, true);
    db.write("players/p10", { id: "p10", name: "Other Device B", active: true, seed: 3300 }, true);
    db.write("seq/p", 10, true);
    const id = (await ok("player.add", { name: "Late Joiner", seed: 3.1 })).id;
    assert.strictEqual(id, "p11");
    assert.strictEqual(db.read("players/p9/name"), "Other Device A");
    assert.strictEqual(db.read("players/p11/name"), "Late Joiner");
    assert.strictEqual(db.read("seq/p"), 11);
    db.flush();
    for (const pid of ["p9", "p10", "p11"]) await ok("player.update", { id: pid, active: false });
  });

  await test("availability: each answer is a write of its own, and the league code is filed out of sight", async () => {
    await ok("season.set", { dates: ["2026-11-30", "2026-12-07"] });
    assert.deepStrictEqual(db.read("league/season/dates"), ["2026-11-30", "2026-12-07"]);
    db.write("availability/2026-11-30/p2", { v: "out", at: 1 }, true);       // another phone answers; this device has not heard
    await ok("avail.set", { date: "2026-11-30", pid: "p1", v: "in" });
    assert.strictEqual(db.read("availability/2026-11-30/p2/v"), "out");      // not written over
    assert.strictEqual(db.read("availability/2026-11-30/p1/v"), "in");
    assert.strictEqual((await be.send("avail.set", { date: "2026-11-23", pid: "p1", v: "in" })).code, "date");
    await ok("avail.set", { date: "2026-11-30", pid: "p1", v: null });
    assert.strictEqual(db.read("availability/2026-11-30/p1"), null);
    for (let i = 1; i <= 8; i++) await ok("avail.set", { date: "2026-11-30", pid: "p" + i, v: "in" });
    assert.strictEqual(Ladder.availCount(state, "2026-11-30").in.length, 8);
    assert.strictEqual(be.joined(), false);
    assert.ok((await be.join("the-code")).ok);
    assert.strictEqual(be.joined(), true);
    assert.strictEqual(db.read("members/anon1/k"), "the-code");
    assert.strictEqual(state.members, undefined);                            // never part of what phones are sent
    assert.strictEqual((await be.join("  ")).code, "code");
  });

  await test("session set-up, scoring and a stale edit", async () => {
    sid = (await ok("session.create", { date: "2026-11-30" })).id;
    /* the organiser unticks a player: that player's answer becomes out, and nobody else's answer is touched */
    db.write("availability/2026-11-30/p2", { v: "out", at: 9 }, true);        // a phone changed its answer; this device has not heard
    await ok("session.attend", { sid, pid: "p1", on: false });
    assert.deepStrictEqual([db.read("availability/2026-11-30/p1/v"), db.read("availability/2026-11-30/p1/by")], ["out", "org"]);
    assert.deepStrictEqual([db.read("availability/2026-11-30/p2/v"), db.read("availability/2026-11-30/p2/at")], ["out", 9]);
    await ok("session.attend", { sid, pid: "p1", on: true });
    await ok("avail.set", { date: "2026-11-30", pid: "p2", v: "in" });
    assert.strictEqual(db.read(`sessions/${sid}/attending`).length, 8);
    await ok("session.assign", { sid });
    await ok("session.start", { sid });
    sess = state.sessions.find(s => s.id === sid); pool = sess.pools[0];
    assert.strictEqual(db.read(`sessions/${sid}/status`), "live");
    assert.strictEqual(Object.keys(db.read(`sessions/${sid}/games`)).length, 14);
    assert.strictEqual(db.read(`sessions/${sid}/pointsToWin`), 11);
    const gid = pool.rounds[0][0];
    await ok("game.score", { sid, gid, s1: 11, s2: 7 });
    assert.strictEqual(db.read(`sessions/${sid}/games/${gid}/status`), "done");
    let j = await be.send("game.score", { sid, gid, s1: 12, s2: 10, replace: true });
    assert.strictEqual(j.code, "invalid");                                   // first to 11
    /* another phone changes the score; this one still shows 11-7 and tries to edit it */
    db.write(`sessions/${sid}/games/${gid}/s1`, 9, true); db.write(`sessions/${sid}/games/${gid}/s2`, 11, true);
    j = await be.send("game.score", { sid, gid, s1: 11, s2: 2, replace: true, was: { s1: 11, s2: 7 } });
    assert.strictEqual(j.code, "exists");
    assert.deepStrictEqual([j.s1, j.s2], [9, 11]);
    assert.strictEqual(db.read(`sessions/${sid}/games/${gid}/s1`), 9);
  });

  await test("an organiser change to one pool does not undo a round a phone has just confirmed", async () => {
    db.write(`sessions/${sid}/pools/0/confirmed`, 1, true);                  // a phone confirmed round 1; not seen here yet
    await ok("session.pool", { sid, pool: "A", courts: 2 });
    assert.strictEqual(db.read(`sessions/${sid}/pools/0/courts`), 2);
    assert.strictEqual(db.read(`sessions/${sid}/pools/0/confirmed`), 1);
  });

  await test("not played is refused on a game a phone has just scored", async () => {
    const hit = pool.rounds[5][0], free = pool.rounds[5][1];
    db.write(`sessions/${sid}/games/${hit}`, Object.assign({}, db.read(`sessions/${sid}/games/${hit}`), { s1: 11, s2: 6, status: "done", at: 1 }), true);
    assert.strictEqual(state.sessions.find(s => s.id === sid).games[hit].status, "pending");      // this device has not seen it
    const j = await be.send("game.skip", { sid, gid: hit });
    assert.strictEqual(j.code, "scores");
    assert.deepStrictEqual([db.read(`sessions/${sid}/games/${hit}/status`), db.read(`sessions/${sid}/games/${hit}/s1`), db.read(`sessions/${sid}/games/${hit}/s2`)], ["done", 11, 6]);
    await ok("game.skip", { sid, gid: free });
    assert.strictEqual(db.read(`sessions/${sid}/games/${free}/status`), "skipped");
    await ok("game.skip", { sid, gid: free, skip: false });
    assert.strictEqual(db.read(`sessions/${sid}/games/${free}/status`), "pending");
    assert.strictEqual(db.read(`sessions/${sid}/pools/0/confirmed`), 1);                           // the rest of the session is as it was
    assert.strictEqual(Object.keys(db.read(`sessions/${sid}/games`)).length, 14);
  });

  await test("a substitute leaves a game a phone has just scored with the players who played it", async () => {
    const sub = (await ok("player.add", { name: "Stand In", seed: 3.3 })).id;
    const games = db.read(`sessions/${sid}/games`), out = games[pool.rounds[6][0]].t1[0];
    const just = pool.rounds[6][0], later = Object.values(games).find(g => g.status === "pending" && g.id !== just && g.round !== 1 && g.round !== 2 && g.t1.concat(g.t2).includes(out)).id;
    db.write(`sessions/${sid}/games/${just}`, Object.assign({}, games[just], { s1: 4, s2: 11, status: "done", at: 2 }), true);
    assert.strictEqual(state.sessions.find(s => s.id === sid).games[just].status, "pending");     // this device has not seen it
    await ok("session.substitute", { sid, out, in: sub });
    const after = db.read(`sessions/${sid}`);
    assert.ok(after.games[just].t1.includes(out) && !after.games[just].t1.concat(after.games[just].t2).includes(sub), "the scored game keeps who played it");
    assert.deepStrictEqual([after.games[just].status, after.games[just].s1, after.games[just].s2], ["done", 4, 11]);
    assert.ok(after.games[later].t1.concat(after.games[later].t2).includes(sub) && !after.games[later].t1.concat(after.games[later].t2).includes(out), "games still to play go to the substitute");
    assert.ok(after.pools[0].players.includes(sub) && !after.pools[0].players.includes(out));
    assert.ok(after.attending.includes(out) && after.attending.includes(sub), "the player who left has a result tonight, so stays on the list");
  });

  await test("loading a league over a live session needs an explicit yes", async () => {
    db.flush();
    const copy = JSON.parse(JSON.stringify(state)), scored = Object.values(db.read(`sessions/${sid}/games`)).filter(g => g.status === "done").length;
    copy.sessions = copy.sessions.filter(s => s.id !== sid);                 // a file from before tonight
    const j = await be.replaceAll(copy);
    assert.strictEqual(j.code, "live");
    assert.ok(j.message.includes(scored + " score"));
    assert.strictEqual(db.read(`sessions/${sid}/status`), "live");
    assert.strictEqual(Object.values(db.read(`sessions/${sid}/games`)).filter(g => g.status === "done").length, scored);
    const now = JSON.parse(JSON.stringify(state));
    assert.ok((await be.replaceAll(now, { overLive: true })).ok);            // said yes: it goes through (here, with the league as it is)
    assert.strictEqual(db.read(`sessions/${sid}/status`), "live");
  });

  await test("finishing keeps a score that arrives at the same moment, and rates it", async () => {
    const late = pool.rounds[1][0], untouched = pool.rounds[2][0];
    db.write(`sessions/${sid}/games/${late}`, Object.assign({}, db.read(`sessions/${sid}/games/${late}`), { s1: 11, s2: 4, status: "done", at: 1 }), true);
    assert.strictEqual(state.sessions.find(s => s.id === sid).games[late].status, "pending");     // this device has not seen it
    await ok("session.close", { sid });
    assert.strictEqual(db.read(`sessions/${sid}/status`), "closed");
    assert.strictEqual(db.read(`sessions/${sid}/games/${late}/status`), "done");
    assert.strictEqual(db.read(`sessions/${sid}/games/${late}/s1`), 11);
    assert.strictEqual(db.read(`sessions/${sid}/games/${untouched}/status`), "skipped");
    assert.strictEqual(db.read(`sessions/${sid}/games/${untouched}/auto`), true);
    assert.ok(db.read(`ratings/games/${late}`), "the late score is in the ratings");
    assert.ok(db.read(`ratings/sessions/${sid}`));
    const j = await be.send("game.score", { sid, gid: untouched, s1: 11, s2: 1 });
    assert.strictEqual(j.code, "closed");                                    // a score screen left open cannot write into a finished night
  });

  await test("each Finish saves the league in the database, to go back to", async () => {
    const list = await be.copies();
    assert.deepStrictEqual(list.map(x => [x.sid, x.date, x.players]), [[sid, "2026-11-30", Object.keys(db.read("players")).length]]);
    const copy = await be.copy(sid);
    assert.strictEqual(copy.sessions.find(s => s.id === sid).status, "closed");
    assert.ok(copy.ratings.sessions[sid]);
    assert.strictEqual("availability" in copy, false);                       // a restore leaves players' answers alone
    assert.strictEqual(state.copies, undefined);
    assert.strictEqual(await be.copy("s999"), null);
  });

  await test("offline is reported at once; reopen and delete clean up", async () => {
    db.setConnected(false);
    assert.strictEqual(online, false);
    const j = await be.send("session.reopen", { sid });
    assert.strictEqual(j.code, "offline");
    assert.strictEqual(db.read(`sessions/${sid}/status`), "closed");
    db.setConnected(true);
    await ok("session.reopen", { sid });
    assert.strictEqual(db.read(`sessions/${sid}/status`), "live");
    assert.strictEqual((await be.send("session.delete", { sid })).code, "scores");
    await ok("session.delete", { sid, force: true });
    assert.strictEqual(db.read(`sessions/${sid}`), null);
    assert.strictEqual(db.read("ratings/sessions"), null);
  });

  console.log(`${passed} passed`);
  process.exit(process.exitCode || 0);
})();

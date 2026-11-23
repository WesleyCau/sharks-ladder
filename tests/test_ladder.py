"""Run from the Sharks App folder:  python -m unittest -v"""
import csv
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ladder import importer, scheduler  # noqa: E402
from ladder.store import ActionError, Store  # noqa: E402


HAVE_DATA = os.path.exists(os.path.join(importer.SOURCE, "ratings.csv"))
NEEDS_DATA = unittest.skipUnless(HAVE_DATA, "league CSVs are not in this checkout")


@NEEDS_DATA
class EngineTest(unittest.TestCase):
    def test_reproduces_published_ratings(self):
        """Played in the order on the night, the engine must give every 4DR pickleballranker.com published for the season."""
        from ladder import engine
        state = importer.build()
        ids = {p["name"]: pid for pid, p in state["players"].items()}
        by_date = {s["date"]: s["id"] for s in state["sessions"]}
        nights = engine.play_order(state)
        with open(os.path.join(importer.SOURCE, "weekly.csv"), encoding="utf-8") as f:
            weekly = list(csv.DictReader(f))
        self.assertGreaterEqual(len(weekly), 188)
        wrong = [(w["date"], w["player"]) for w in weekly if nights[by_date[w["date"]]][ids[w["player"]]] != int(round(float(w["end"]) * 1000))]
        self.assertEqual(wrong, [])
        # the site's own figures are rounded per game; the order-neutral ratings stay close to them
        with open(os.path.join(importer.SOURCE, "ratings.csv"), encoding="utf-8") as f:
            published = {r["Player"]: int(round(float(r["4DR"]) * 1000)) for r in csv.DictReader(f)}
        current = state["ratings"]["current"]
        self.assertEqual(len(current), len(published))
        self.assertLess(max(abs(current[ids[n]] - v) for n, v in published.items()), 60)
        totals = state["ratings"]["totals"]
        self.assertEqual(sum(t["w"] for t in totals.values()), sum(t["l"] for t in totals.values()))
        with open(os.path.join(importer.SOURCE, "games.csv"), encoding="utf-8") as f:
            games = sum(1 for _ in csv.DictReader(f))
        self.assertEqual(sum(t["w"] for t in totals.values()), games * 2)


class ParityTest(unittest.TestCase):
    def test_sampled_average_matches_the_website(self):
        """Same input as tests/core.test.js; the expected numbers in parity.json were written by the JavaScript engine."""
        from ladder import engine
        start = {"p%d" % i: 3100 + 100 * i for i in range(7)}
        rounds = [[("g%d" % r, ("p%d" % (r % 7), "p%d" % ((r + 1) % 7)), ("p%d" % ((r + 3) % 7), "p%d" % ((r + 5) % 7)), 11, (r * 3) % 10)] for r in range(14)]
        ends, _ = engine.all_orders(start, rounds)
        with open(os.path.join(os.path.dirname(__file__), "parity.json"), encoding="utf-8") as f:
            expected = json.load(f)["ends"]
        self.assertEqual([int(ends[p] * 1000 + 0.5) for p in sorted(start)], expected)


class SchedulerTest(unittest.TestCase):
    def test_eight_is_full_whist(self):
        players = ["p%d" % i for i in range(8)]
        s = scheduler.summary(players, scheduler.generate(players, seed="x"))
        self.assertEqual((s["rounds"], s["games"]), (7, 14))
        self.assertEqual((s["partner_min"], s["partner_max"]), (1, 1))
        self.assertEqual((s["oppose_min"], s["oppose_max"]), (2, 2))
        self.assertEqual((s["each_min"], s["each_max"]), (7, 7))

    def test_other_sizes_are_valid_and_even(self):
        for n in range(4, 13):
            players = ["p%d" % i for i in range(n)]
            rounds = scheduler.generate(players, seed="y")
            for rd in rounds:
                used = [p for t1, t2 in rd for p in t1 + t2]
                self.assertEqual(len(used), len(set(used)), "player twice in a round, n=%d" % n)
                self.assertEqual(len(rd), n // 4)
            s = scheduler.summary(players, rounds)
            self.assertEqual(s["each_min"], s["each_max"], "uneven games, n=%d" % n)
            self.assertLessEqual(abs(s["each_min"] - 7), 1, "n=%d" % n)
            self.assertLessEqual(s["partner_max"] - s["partner_min"], 2, "n=%d" % n)

    def test_same_seed_same_schedule(self):
        players = ["p%d" % i for i in range(9)]
        self.assertEqual(scheduler.generate(players, seed="s1A"), scheduler.generate(players, seed="s1A"))


@NEEDS_DATA
class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        with open(os.path.join(self.tmp.name, "league.json"), "w", encoding="utf-8") as f:
            json.dump(importer.build(), f)
        self.store = Store(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def name(self, pid):
        return self.store.state["players"][pid]["name"]

    def test_full_session_flow(self):
        st = self.store
        with self.assertRaises(ActionError) as cm:
            st.apply("session.create", dict(date="2026-11-23"), org=False)
        self.assertEqual(cm.exception.code, "pin")

        sid = st.apply("session.create", dict(date="2026-11-23"), org=True)["id"]
        sess = st.state["sessions"][-1]
        self.assertEqual(len(sess["attending"]), 27)          # the 27 who played the last night
        st.apply("session.assign", dict(sid=sid), org=True)
        self.assertEqual([len(p["players"]) for p in sess["pools"]], [9, 9, 9])
        self.assertEqual([p["courts"] for p in sess["pools"]], [2, 2, 2])
        ranked = sorted(sess["attending"], key=lambda p: -st.state["ratings"]["current"][p])
        self.assertEqual(set(sess["pools"][0]["players"]), set(ranked[:9]))       # Pool A is the top nine by rating
        self.assertEqual(set(sess["pools"][2]["players"]), set(ranked[18:]))

        # a new player joins and is placed by hand
        new = st.apply("player.add", dict(name="Test Newcomer", seed=3.0, sid=sid), org=True)["id"]
        with self.assertRaises(ActionError) as cm:
            st.apply("session.schedule", dict(sid=sid), org=True)
        self.assertEqual(cm.exception.code, "unassigned")
        st.apply("session.move", dict(sid=sid, pid=new, to="C"), org=True)
        self.assertEqual(len(sess["pools"][2]["players"]), 10)

        st.apply("session.start", dict(sid=sid), org=True)
        self.assertEqual(sess["status"], "live")
        pool_a = sess["pools"][0]
        self.assertEqual(sum(len(r) for r in pool_a["rounds"]), 18)

        # players enter scores without a PIN; a second, different entry is refused
        gid = pool_a["rounds"][0][0]
        st.apply("game.score", dict(sid=sid, gid=gid, s1=11, s2=6), org=False)
        with self.assertRaises(ActionError) as cm:
            st.apply("game.score", dict(sid=sid, gid=gid, s1=11, s2=4), org=False)
        self.assertEqual((cm.exception.code, cm.exception.extra), ("exists", dict(s1=11, s2=6)))
        st.apply("game.score", dict(sid=sid, gid=gid, s1=11, s2=4, replace=True), org=False)
        with self.assertRaises(ActionError):
            st.apply("game.score", dict(sid=sid, gid=gid, s1=7, s2=7, replace=True), org=False)

        # rounds: scores stay on screen until someone confirms, then the pool moves on
        self.assertEqual(pool_a["confirmed"], 0)
        with self.assertRaises(ActionError) as cm:
            st.apply("round.confirm", dict(sid=sid, pool="A", round=0), org=False)
        self.assertEqual(cm.exception.code, "scores")
        st.apply("game.score", dict(sid=sid, gid=pool_a["rounds"][0][1], s1=9, s2=11), org=False)
        with self.assertRaises(ActionError) as cm:
            st.apply("round.confirm", dict(sid=sid, pool="A", round=1), org=False)
        self.assertEqual(cm.exception.code, "order")
        self.assertEqual(st.apply("round.confirm", dict(sid=sid, pool="A", round=0), org=False)["round"], 1)
        self.assertEqual(st.apply("round.confirm", dict(sid=sid, pool="A", round=0), org=False)["round"], 1)
        self.assertEqual(pool_a["confirmed"], 1)
        with self.assertRaises(ActionError) as cm:
            st.apply("round.back", dict(sid=sid, pool="A"), org=False)       # organiser only
        self.assertEqual(cm.exception.code, "pin")
        self.assertEqual(st.apply("round.back", dict(sid=sid, pool="A"), org=True)["round"], 0)
        with self.assertRaises(ActionError) as cm:
            st.apply("round.back", dict(sid=sid, pool="A"), org=True)
        self.assertEqual(cm.exception.code, "order")
        self.assertEqual(sess["games"][pool_a["rounds"][0][1]]["status"], "done")   # scores untouched
        st.apply("round.confirm", dict(sid=sid, pool="A", round=0), org=False)

        before = dict(st.state["ratings"]["current"])
        for g in sess["games"].values():
            if g["pool"] == "A" and g["status"] == "pending":
                st.apply("game.score", dict(sid=sid, gid=g["id"], s1=11, s2=5), org=False)
        with self.assertRaises(ActionError):
            st.apply("session.close", dict(sid=sid), org=False)
        st.apply("session.close", dict(sid=sid), org=True)
        after = st.state["ratings"]["current"]
        self.assertEqual(sess["status"], "closed")
        self.assertTrue(all(after[p] != before[p] for p in pool_a["players"]))
        self.assertEqual(after[sess["pools"][1]["players"][0]], before[sess["pools"][1]["players"][0]])  # no games, no change
        self.assertEqual(st.state["ratings"]["sessions"][sid][pool_a["players"][0]]["w"]
                         + st.state["ratings"]["sessions"][sid][pool_a["players"][0]]["l"], 8)

        # closed session: players are locked out, the organiser can correct
        with self.assertRaises(ActionError) as cm:
            st.apply("game.score", dict(sid=sid, gid=gid, s1=11, s2=9, replace=True), org=False)
        self.assertEqual(cm.exception.code, "pin")
        with self.assertRaises(ActionError) as cm:
            st.apply("game.score", dict(sid=sid, gid=gid, s1=4, s2=11, replace=True), org=True)
        self.assertEqual(cm.exception.code, "closed")
        st.apply("game.score", dict(sid=sid, gid=gid, s1=4, s2=11, replace=True, history=True), org=True)
        self.assertNotEqual(st.state["ratings"]["current"], after)

        # state survives a restart
        again = Store(self.tmp.name)
        self.assertEqual(again.state["ratings"]["current"], st.state["ratings"]["current"])

    def test_session_dates_and_empty_finish(self):
        st = self.store
        sid = st.apply("session.create", dict(date="2026-11-23"), org=True)["id"]
        sess = st.state["sessions"][-1]
        st.apply("session.assign", dict(sid=sid), org=True)
        st.apply("session.start", dict(sid=sid), org=True)
        with self.assertRaises(ActionError) as cm:
            st.apply("session.close", dict(sid=sid), org=True)
        self.assertEqual(cm.exception.code, "scores")
        self.assertEqual(sess["status"], "live")
        st.apply("game.score", dict(sid=sid, gid=sess["pools"][0]["rounds"][0][0], s1=11, s2=3), org=False)
        st.apply("session.close", dict(sid=sid), org=True)
        with self.assertRaises(ActionError) as cm:
            st.apply("session.create", dict(date="2026-11-16"), org=True)
        self.assertEqual(cm.exception.code, "date")
        st.apply("session.create", dict(date="2026-11-23"), org=True)

    def test_failed_action_leaves_nothing_behind(self):
        st = self.store
        name, version = st.state["league"]["name"], st.state["version"]
        with self.assertRaises(ActionError):
            st.apply("league.update", dict(name="Half Applied", pointsToWin="abc"), org=True)
        self.assertEqual(st.state["league"]["name"], name)
        self.assertEqual(st.state["version"], version)
        for bad in ("", "15.5", "99"):
            with self.assertRaises(ActionError) as cm:
                st.apply("league.update", dict(pointsToWin=bad), org=True)
            self.assertEqual(cm.exception.code, "invalid")

    def test_score_safety_and_reopen(self):
        st = self.store
        sid = st.apply("session.create", dict(date="2026-11-23"), org=True)["id"]
        sess = st.state["sessions"][-1]
        st.apply("session.assign", dict(sid=sid), org=True)
        st.apply("session.start", dict(sid=sid), org=True)
        self.assertEqual(sess["pointsToWin"], 11)
        pool = sess["pools"][0]
        gid, g2, by_hand = pool["rounds"][0][0], pool["rounds"][0][1], pool["rounds"][1][0]
        with self.assertRaises(ActionError) as cm:
            st.apply("game.score", dict(sid=sid, gid=gid, s1=12, s2=10), org=False)
        self.assertEqual(cm.exception.code, "invalid")
        st.apply("game.score", dict(sid=sid, gid=gid, s1=11, s2=7), org=False)
        st.apply("game.score", dict(sid=sid, gid=gid, s1=9, s2=11, replace=True), org=False)
        with self.assertRaises(ActionError) as cm:
            st.apply("game.score", dict(sid=sid, gid=gid, s1=11, s2=2, replace=True, was=dict(s1=11, s2=7)), org=False)
        self.assertEqual(cm.exception.code, "exists")
        self.assertEqual((sess["games"][gid]["s1"], sess["games"][gid]["s2"]), (9, 11))
        st.apply("game.skip", dict(sid=sid, gid=by_hand), org=True)
        st.apply("session.close", dict(sid=sid), org=True)
        st.apply("session.reopen", dict(sid=sid), org=True)
        self.assertEqual(sess["games"][g2]["status"], "pending")
        self.assertEqual(sess["games"][by_hand]["status"], "skipped")
        with self.assertRaises(ActionError) as cm:
            st.apply("session.delete", dict(sid=sid), org=True)
        self.assertEqual(cm.exception.code, "scores")
        st.apply("session.delete", dict(sid=sid, force=True), org=True)

    def test_same_as_last_week(self):
        st = self.store
        last = max((s for s in st.state["sessions"] if s["status"] == "closed"), key=lambda s: (s["date"], s["id"]))
        want = sorted(pid for pid in last["attending"] if st.state["players"][pid]["active"])
        sid = st.apply("session.create", dict(date=last["date"]), org=True)["id"]
        sess = st.state["sessions"][-1]
        st.apply("session.attendAll", dict(sid=sid, on=True), org=True)
        st.apply("session.assign", dict(sid=sid), org=True)
        st.apply("session.attendAll", dict(sid=sid, last=True), org=True)
        self.assertEqual(sorted(sess["attending"]), want)
        self.assertTrue(all(pid in sess["attending"] for pool in sess["pools"] for pid in pool["players"]))

    def test_reset_session(self):
        st = self.store
        sid = st.apply("session.create", dict(date="2026-11-23"), org=True)["id"]
        sess = st.state["sessions"][-1]
        st.apply("session.assign", dict(sid=sid), org=True)
        st.apply("session.start", dict(sid=sid), org=True)
        pool = sess["pools"][0]
        draw = json.dumps(pool["rounds"])
        for gid in pool["rounds"][0]:
            st.apply("game.score", dict(sid=sid, gid=gid, s1=11, s2=5), org=False)
        st.apply("round.confirm", dict(sid=sid, pool=pool["id"], round=0), org=False)
        with self.assertRaises(ActionError) as cm:
            st.apply("session.reset", dict(sid=sid), org=False)
        self.assertEqual(cm.exception.code, "pin")
        st.apply("session.reset", dict(sid=sid), org=True)
        self.assertTrue(all(g["status"] == "pending" and g["s1"] is None and "at" not in g for g in sess["games"].values()))
        self.assertEqual([p["confirmed"] for p in sess["pools"]], [0] * len(sess["pools"]))
        self.assertEqual(json.dumps(pool["rounds"]), draw)
        self.assertEqual(sess["status"], "live")

    def test_substitute_and_dropout(self):
        st = self.store
        sid = st.apply("session.create", dict(date="2026-11-23"), org=True)["id"]
        sess = st.state["sessions"][-1]
        st.apply("session.assign", dict(sid=sid), org=True)
        st.apply("session.start", dict(sid=sid), org=True)
        out = sess["pools"][2]["players"][0]
        sub = next(pid for pid, p in st.state["players"].items() if pid not in sess["attending"])
        res = st.apply("session.substitute", {"sid": sid, "out": out, "in": sub}, org=True)
        self.assertEqual(res["games"], 8)
        self.assertFalse(any(out in g["t1"] + g["t2"] for g in sess["games"].values()))
        self.assertIn(sub, sess["pools"][2]["players"])

        st.apply("player.update", dict(id=out, active=False), org=True)
        st.apply("session.delete", dict(sid=sid), org=True)
        sid2 = st.apply("session.create", dict(date="2026-11-30"), org=True)["id"]
        self.assertNotIn(out, st.state["sessions"][-1]["attending"])
        self.assertTrue(sid2)

    def test_uneven_attendance(self):
        st = self.store
        sid = st.apply("session.create", dict(date="2026-11-23"), org=True)["id"]
        sess = st.state["sessions"][-1]
        for pid in sess["attending"][:3]:
            st.apply("session.attend", dict(sid=sid, pid=pid, on=False), org=True)
        st.apply("session.assign", dict(sid=sid), org=True)
        self.assertEqual([len(p["players"]) for p in sess["pools"]], [8, 8, 8])
        st.apply("session.schedule", dict(sid=sid), org=True)
        self.assertEqual(sum(len(r) for r in sess["pools"][1]["rounds"]), 14)
        for pid in sess["attending"][:2]:
            st.apply("session.attend", dict(sid=sid, pid=pid, on=False), org=True)
        st.apply("session.assign", dict(sid=sid), org=True)
        self.assertEqual([len(p["players"]) for p in sess["pools"]], [11, 11])       # 22: two elevens, not 8, 7, 7

    def test_pool_targets(self):
        from ladder.store import auto_target, target_choices
        from ladder import engine
        self.assertEqual(target_choices(11), [11, 15, 21])
        self.assertEqual([auto_target([8, 8, 9, 9], n, 11) for n in (8, 9)], [15, 11])
        self.assertEqual(auto_target([8, 8, 8], 8, 11), 11)
        self.assertEqual([auto_target([8, 9], n, 15) for n in (8, 9)], [21, 15])
        self.assertEqual(engine.scaled(11, 7, 11), (11, 7))
        self.assertEqual(engine.scaled(21, 20, 21), (11, 10))       # winners +1, losers +10: the same as 11-10
        self.assertEqual(engine.scaled(15, 0, 15), (11, 0))
        st = self.store
        sid = st.apply("session.create", dict(date="2026-11-27"), org=True)["id"]
        sess = st.state["sessions"][-1]
        st.apply("session.attend", dict(sid=sid, pid=sess["attending"][0], on=False), org=True)
        st.apply("session.attend", dict(sid=sid, pid=sess["attending"][0], on=False), org=True)
        st.apply("session.assign", dict(sid=sid), org=True)
        self.assertEqual([len(p["players"]) for p in sess["pools"]], [8, 8, 9])
        with self.assertRaises(ActionError) as cm:
            st.apply("session.pool", dict(sid=sid, pool="A", target=13), org=True)
        self.assertEqual(cm.exception.code, "invalid")
        st.apply("session.pool", dict(sid=sid, pool="C", target=21), org=True)
        st.apply("session.start", dict(sid=sid), org=True)
        self.assertEqual([p["target"] for p in sess["pools"]], [15, 15, 21])
        with self.assertRaises(ActionError):
            st.apply("session.pool", dict(sid=sid, pool="A", target=11), org=True)
        gid = sess["pools"][0]["rounds"][0][0]
        with self.assertRaises(ActionError) as cm:
            st.apply("game.score", dict(sid=sid, gid=gid, s1=16, s2=14), org=False)
        self.assertEqual(cm.exception.code, "invalid")
        st.apply("game.score", dict(sid=sid, gid=gid, s1=15, s2=14), org=False)
        st.apply("session.close", dict(sid=sid), org=True)
        g = sess["games"][gid]
        rec = st.state["ratings"]["sessions"][sid]
        gain = [rec[p]["end"] - rec[p]["start"] for p in g["t1"] + g["t2"]]
        self.assertEqual(gain[0], gain[1])
        self.assertEqual(gain[2], gain[3])
        self.assertIn(gain[0] + gain[2], (11, 12))       # winners' 1 + losers' 10, the result itself cancels (or 0.001 on a half)

    def test_pool_count(self):
        from ladder.store import pool_count
        want = {8: 1, 9: 1, 16: 2, 18: 2, 20: 2, 23: 3, 24: 3, 25: 3, 27: 3, 28: 3, 31: 3, 32: 4, 33: 4, 34: 4, 36: 4, 37: 4, 39: 4, 40: 5, 45: 5, 48: 6}
        self.assertEqual({n: pool_count(n) for n in want}, want)


if __name__ == "__main__":
    unittest.main()

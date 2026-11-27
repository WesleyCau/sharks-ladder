"""League state: one JSON document, changed only through validated actions."""
import copy
import json
import os
import shutil
import threading
import time

from . import engine, scheduler

DEFAULT_SEEDS = [3500, 3000, 2500]


class ActionError(Exception):
    def __init__(self, code, message, **extra):
        super().__init__(message)
        self.code, self.message, self.extra = code, message, extra


def pool_count(n):
    """Pools of eight or nine are the aim: as few pools as keep every pool at nine or under;
    if that leaves a pool under eight, one pool fewer (tens and elevens, and for 23 an eleven and a twelve).
    Mirrors poolCount in docs/core.js."""
    k = max(1, -(-n // 9))
    if k > 1 and n // k < 8 and -(-n // (k - 1)) <= scheduler.MAX_POOL:
        k -= 1
    return k


TARGETS = [11, 15, 21]


def target_choices(base):
    """Game targets a pool can play to: 11, 15 and 21, never shorter than the league's own setting."""
    return sorted(t for t in set(TARGETS + [base]) if t >= base)


def auto_target(sizes, n, base):
    """The target that brings a pool of n home at about the same time as the others. Mirrors autoTarget in docs/core.js."""
    ok = lambda k: scheduler.MIN_POOL <= k <= scheduler.MAX_POOL      # noqa: E731
    if not ok(n):
        return base
    full = [k for k in sizes if ok(k) and k >= 8]      # a pool under eight plays one game at a time: it does not set the pace
    budget = max(scheduler.round_count(k) for k in (full or [k for k in sizes if ok(k)])) * base * 1.1
    fits = [t for t in target_choices(base) if scheduler.round_count(n) * t <= budget]
    return fits[-1] if fits else base


def courts_for(count):
    return 3 if count >= 12 else 2 if count >= 8 else 1


def empty_state(name="Southern Sharks PC Ladder League"):
    return dict(version=1, seq=dict(p=0, s=0, g=0),
                league=dict(name=name, seeds=DEFAULT_SEEDS[:], poolSize=8, pointsToWin=11, rating="average"),
                players={}, sessions=[], ratings=dict(current={}, sessions={}, games={}, totals={}))


def _restore(cur, old):
    """Put cur back to old in place, keeping the same dict and list objects wherever they still exist."""
    if isinstance(cur, dict):
        for k in [k for k in cur if k not in old]:
            del cur[k]
        for k, v in old.items():
            if k in cur and type(cur[k]) is type(v) and isinstance(v, (dict, list)):
                _restore(cur[k], v)
            else:
                cur[k] = v
    elif len(cur) == len(old) and all(type(c) is type(o) and isinstance(o, (dict, list)) for c, o in zip(cur, old)):
        for c, o in zip(cur, old):
            _restore(c, o)
    else:
        cur[:] = old


class _Slow(Exception):
    """Raised inside an action when the ratings have to be worked out again: apply() then does it away from the lock."""


class Store:
    def __init__(self, data_dir):
        self.dir = data_dir
        self.path = os.path.join(data_dir, "league.json")
        self.lock = threading.RLock()      # guards self.state; held only for moments
        self.slow = threading.Lock()       # one ratings recompute at a time
        self._defer = False                # True while apply() is trying an action under the lock
        self._backup_after = False         # the action wants a backup of the league as it is once saved
        os.makedirs(os.path.join(data_dir, "backups"), exist_ok=True)
        if os.path.exists(self.path):
            with open(self.path, encoding="utf-8") as f:
                self.state = json.load(f)
        else:
            self.state = empty_state()
        engine.use_disk_cache(os.path.join(data_dir, "ratings-cache.json"))
        self.recompute()

    # ---- persistence -------------------------------------------------------
    def save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.state, f, ensure_ascii=False)
        os.replace(tmp, self.path)

    def backup(self):
        if os.path.exists(self.path):
            shutil.copy2(self.path, os.path.join(self.dir, "backups", "league-%s.json" % time.strftime("%Y%m%d-%H%M%S")))

    def recompute(self):
        if self._defer:
            raise _Slow()
        self.state["ratings"] = engine.compute(self.state)

    # ---- helpers -----------------------------------------------------------
    def _id(self, kind):
        self.state["seq"][kind] += 1
        return "%s%d" % (kind, self.state["seq"][kind])

    def _session(self, sid, *statuses):
        for s in self.state["sessions"]:
            if s["id"] == sid:
                if statuses and s["status"] not in statuses:
                    raise ActionError("status", "This session is %s, so that is not possible." % s["status"])
                return s
        raise ActionError("missing", "Session not found.")

    def _player(self, pid):
        if pid not in self.state["players"]:
            raise ActionError("missing", "Player not found.")
        return self.state["players"][pid]

    def _rating(self, pid):
        return self.state["ratings"]["current"].get(pid, self.state["players"][pid]["seed"])

    def _sort_pool(self, pool):
        pool["players"].sort(key=lambda p: (-self._rating(p), self.state["players"][p]["name"].lower()))

    def _open_session(self):
        return next((s for s in self.state["sessions"] if s["status"] != "closed"), None)

    @staticmethod
    def _clear_schedule(sess):
        sess["games"] = {}
        for pool in sess["pools"]:
            pool["rounds"] = []

    @staticmethod
    def _done(sess):
        return [g for g in sess["games"].values() if g["status"] == "done"]

    def _has_played(self, pid):
        return any(pid in g["t1"] + g["t2"] for s in self.state["sessions"] for g in self._done(s))

    # ---- dispatch ----------------------------------------------------------
    def apply(self, kind, args, org=False):
        name = "do_" + kind.replace(".", "_")
        if getattr(self, name, None) is None:
            raise ActionError("unknown", "Unknown action %s." % kind)
        with self.lock:
            if kind not in OPEN_ACTIONS and not org:
                raise ActionError("pin", "Organiser PIN needed.")
            before = copy.deepcopy(self.state)      # a rejected action must leave nothing behind
            self._defer, self._backup_after = True, False
            try:
                result = getattr(self, name)(args or {}, org)
            except _Slow:
                _restore(self.state, before)
            except Exception:
                _restore(self.state, before)
                raise
            else:
                return self._commit(result)
            finally:
                self._defer = False
        return self._apply_slow(name, args or {}, org)

    def _commit(self, result):
        self.state["version"] += 1
        self.save()
        if self._backup_after:
            self.backup()
        return result or {}

    def _apply_slow(self, name, args, org):
        """An action that changes the ratings (finishing a session, correcting an old score). Working them out takes
        seconds, because a pool of nine has 362,880 orders, so it is done on a copy with the lock released: phones keep
        reading and scoring meanwhile. If anything else landed in that time the action is done again on top of it, so a
        score entered a moment after Finish was tapped is counted rather than turned away."""
        with self.slow:
            for _ in range(4):
                with self.lock:
                    version = self.state["version"]
                    twin = copy.copy(self)
                    twin.state = copy.deepcopy(self.state)
                twin._defer, twin._backup_after = False, False
                result = getattr(twin, name)(args, org)      # an ActionError goes straight to the caller: nothing was changed
                with self.lock:
                    if self.state["version"] == version:
                        _restore(self.state, twin.state)
                        self._backup_after = twin._backup_after
                        return self._commit(result)
            with self.lock:      # the league would not hold still: do it the plain way
                before = copy.deepcopy(self.state)
                self._backup_after = False
                try:
                    result = getattr(self, name)(args, org)
                except Exception:
                    _restore(self.state, before)
                    raise
                return self._commit(result)

    # ---- league and players ------------------------------------------------
    def do_league_update(self, a, org):
        lg = self.state["league"]
        if "name" in a:
            name = str(a["name"]).strip()
            if not name:
                raise ActionError("invalid", "League name cannot be empty.")
            lg["name"] = name[:80]
        if "nameStyle" in a:
            if a["nameStyle"] not in ("short", "full"):
                raise ActionError("invalid", "Choose short or full names.")
            lg["nameStyle"] = a["nameStyle"]
        if "schedule" in a:
            if a["schedule"] not in ("ranker", "closest", "mixed"):
                raise ActionError("invalid", "Choose a schedule.")
            sess = self._open_session()
            if a["schedule"] != lg.get("schedule", "ranker") and sess and sess["status"] == "setup":
                self._clear_schedule(sess)      # drawn again under the new choice
            lg["schedule"] = a["schedule"]
        if "rating" in a:
            if a["rating"] not in ("average", "played"):
                raise ActionError("invalid", "Choose how ratings are worked out.")
            was = lg.get("rating", "average")
            lg["rating"] = a["rating"]
            if a["rating"] != was:
                self.recompute()      # the whole season again, under the other method
        if "pointsToWin" in a:
            raw = str(a["pointsToWin"]).strip()
            pts = int(raw) if raw.isdigit() else 0
            if not 5 <= pts <= 21:
                raise ActionError("invalid", "Points to win must be a whole number from 5 to 21.")
            lg["pointsToWin"] = pts

    def _check_name(self, name, skip=None):
        name = " ".join(str(name).split())[:60]
        if not name:
            raise ActionError("invalid", "Enter the player's name.")
        for pid, p in self.state["players"].items():
            if pid != skip and p["name"].lower() == name.lower():
                raise ActionError("duplicate", "%s is already in the league." % p["name"])
        return name

    @staticmethod
    def _seed(value):
        try:
            seed = int(round(float(value) * 1000))
        except (TypeError, ValueError):
            raise ActionError("invalid", "Starting rating must be a number, for example 3.3.")
        if not 1500 <= seed <= 6000:
            raise ActionError("invalid", "Starting rating must be between 1.5 and 6.0.")
        return seed

    def do_player_add(self, a, org):
        name = self._check_name(a.get("name", ""))
        seed = self._seed(a.get("seed", self.state["league"]["seeds"][-1] / 1000))
        pid = self._id("p")
        self.state["players"][pid] = dict(id=pid, name=name, active=True, seed=seed)
        self.state["ratings"]["current"][pid] = seed
        self.state["ratings"]["totals"][pid] = dict(w=0, l=0, pf=0, pa=0)
        if a.get("sid"):
            sess = self._session(a["sid"], "setup")
            sess["attending"].append(pid)
        return dict(id=pid)

    def do_player_update(self, a, org):
        p = self._player(a.get("id"))
        if "name" in a:
            p["name"] = self._check_name(a["name"], skip=p["id"])
        if "active" in a:
            p["active"] = bool(a["active"])
            sess = self._open_session()
            if not p["active"] and sess and sess["status"] == "setup" and p["id"] in sess["attending"]:
                self._remove_from_session(sess, p["id"])
        if "seed" in a:
            if self._has_played(p["id"]):
                raise ActionError("locked", "%s has played games, so the starting rating is fixed." % p["name"])
            p["seed"] = self._seed(a["seed"])
            self.recompute()

    # ---- session setup -----------------------------------------------------
    def do_session_create(self, a, org):
        if self._open_session():
            raise ActionError("open", "Finish the current session before creating another.")
        date = str(a.get("date", ""))
        try:
            time.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise ActionError("invalid", "Pick a date for the session.")
        closed = sorted((s for s in self.state["sessions"] if s["status"] == "closed"), key=lambda s: (s["date"], s["id"]))
        if closed and date < closed[-1]["date"]:
            raise ActionError("date", "That date is before the last finished session (%s). Pick that day or later." % closed[-1]["date"])
        active = [pid for pid, p in self.state["players"].items() if p["active"]]
        last = set(closed[-1]["attending"]) if closed else set(active)
        sess = dict(id=self._id("s"), date=date, status="setup", attending=[p for p in active if p in last], pools=[], games={})
        self.state["sessions"].append(sess)
        return dict(id=sess["id"])

    def _remove_from_session(self, sess, pid):
        sess["attending"] = [p for p in sess["attending"] if p != pid]
        for pool in sess["pools"]:
            if pid in pool["players"]:
                pool["players"].remove(pid)
                self._clear_schedule(sess)
        self._auto_courts(sess)

    @staticmethod
    def _auto_courts(sess):
        """Courts follow a pool's size until the organiser sets them by hand."""
        for pool in sess["pools"]:
            if not pool.get("courtsHand"):
                pool["courts"] = courts_for(len(pool["players"]))

    def do_session_attend(self, a, org):
        sess = self._session(a.get("sid"), "setup")
        p = self._player(a.get("pid"))
        if a.get("on"):
            if not p["active"]:
                raise ActionError("inactive", "%s is marked as dropped out. Restore them first." % p["name"])
            if p["id"] not in sess["attending"]:
                sess["attending"].append(p["id"])
        else:
            self._remove_from_session(sess, p["id"])

    def do_session_attendAll(self, a, org):
        sess = self._session(a.get("sid"), "setup")
        if a.get("last"):
            closed = sorted((s for s in self.state["sessions"] if s["status"] == "closed"), key=lambda s: (s["date"], s["id"]))
            if not closed:
                raise ActionError("none", "There is no finished session to copy from yet.")
            players = self.state["players"]
            want = [pid for pid in closed[-1]["attending"] if pid in players and players[pid]["active"]]
            for pid in [p for p in sess["attending"] if p not in want]:
                self._remove_from_session(sess, pid)
            for pid in want:
                if pid not in sess["attending"]:
                    sess["attending"].append(pid)
            return dict(players=len(sess["attending"]))
        if a.get("on"):
            for pid, p in self.state["players"].items():
                if p["active"] and pid not in sess["attending"]:
                    sess["attending"].append(pid)
        else:
            sess["attending"] = []
            sess["pools"] = []
            sess["games"] = {}

    def do_session_assign(self, a, org):
        sess = self._session(a.get("sid"), "setup")
        ranked = sorted(sess["attending"], key=lambda p: (-self._rating(p), self.state["players"][p]["name"].lower()))
        n = len(ranked)
        if n < scheduler.MIN_POOL:
            raise ActionError("few", "At least %d players are needed." % scheduler.MIN_POOL)
        k = int(a["pools"]) if a.get("pools") else pool_count(n)
        k = max(1, min(k, n // scheduler.MIN_POOL, 12))
        while -(-n // k) > scheduler.MAX_POOL:
            k += 1
        base, extra = divmod(n, k)
        pools, at = [], 0
        for i in range(k):
            count = base + (1 if i >= k - extra else 0)      # the odd extra players go to the lower pools
            pid = chr(65 + i)
            pools.append(dict(id=pid, name="Pool " + pid, courts=courts_for(count), confirmed=0, players=ranked[at:at + count], rounds=[]))
            at += count
        sess["pools"] = pools
        sess["games"] = {}

    def do_session_move(self, a, org):
        sess = self._session(a.get("sid"), "setup")
        pid = a.get("pid")
        if pid not in sess["attending"]:
            raise ActionError("missing", "That player is not marked as attending.")
        target = None
        if a.get("to") not in (None, "", "none"):
            target = next((p for p in sess["pools"] if p["id"] == a["to"]), None)
            if target is None:
                raise ActionError("missing", "Pool not found.")
        for pool in sess["pools"]:
            if pid in pool["players"]:
                pool["players"].remove(pid)
        if target is not None:
            target["players"].append(pid)
            self._sort_pool(target)
        self._auto_courts(sess)
        self._clear_schedule(sess)

    def do_session_swap(self, a, org):
        """Two players in the same pool change places in its order (the schedule slot under pickleballranker's rounds)."""
        sess = self._session(a.get("sid"), "setup")
        pool = next((p for p in sess["pools"] if a.get("a") in p["players"]), None)
        if pool is None:
            raise ActionError("missing", "That player is not in a pool.")
        if a.get("b") not in pool["players"]:
            raise ActionError("invalid", "Both players must be in the same pool.")
        i, j = pool["players"].index(a["a"]), pool["players"].index(a["b"])
        if i == j:
            raise ActionError("invalid", "Choose two different players.")
        pool["players"][i], pool["players"][j] = a["b"], a["a"]
        self._clear_schedule(sess)
        return dict(pool=pool["id"], slots=[i + 1, j + 1])

    def do_session_pool(self, a, org):
        sess = self._session(a.get("sid"), "setup", "live")
        if a.get("add"):
            sess = self._session(a.get("sid"), "setup")
            pid = chr(65 + len(sess["pools"]))
            sess["pools"].append(dict(id=pid, name="Pool " + pid, courts=1, confirmed=0, players=[], rounds=[]))
            return
        pool = next((p for p in sess["pools"] if p["id"] == a.get("pool")), None)
        if pool is None:
            raise ActionError("missing", "Pool not found.")
        if a.get("remove"):
            sess = self._session(a.get("sid"), "setup")
            if pool["players"] or pool is not sess["pools"][-1]:
                raise ActionError("invalid", "Only the last pool can be removed, and only when it is empty.")
            sess["pools"].remove(pool)
            return
        if "courts" in a:
            courts = int(a["courts"])
            if not 1 <= courts <= 3:
                raise ActionError("invalid", "A pool can use 1 to 3 courts.")
            pool["courts"] = courts
            if courts == courts_for(len(pool["players"])):
                pool.pop("courtsHand", None)
            else:
                pool["courtsHand"] = True
        if "target" in a:
            self._session(a.get("sid"), "setup")      # the target is fixed once the session has started
            if a["target"] in ("auto", None):
                pool.pop("target", None)
                pool.pop("autoTarget", None)
                return
            choices = target_choices(self.state["league"]["pointsToWin"])
            try:
                t = int(a["target"])
            except (TypeError, ValueError):
                t = None
            if t not in choices:
                raise ActionError("invalid", "A pool can play first to %s." % " or ".join([", ".join(map(str, choices[:-1])), str(choices[-1])] if len(choices) > 1 else [str(choices[0])]))
            pool["target"] = t
            pool.pop("autoTarget", None)
        if "bestOf" in a:
            sess = self._session(a.get("sid"), "setup")      # the format is fixed once the session has started
            if str(a["bestOf"]) == "3":
                if len(pool["players"]) != 4:
                    raise ActionError("invalid", "Best of 3 is for a pool of four.")
                pool["bestOf"] = 3
            else:
                pool.pop("bestOf", None)
            sess["games"] = {}
            for p in sess["pools"]:
                p["rounds"] = []

    def do_session_schedule(self, a, org):
        sess = self._session(a.get("sid"), "setup")
        if not sess["pools"]:
            raise ActionError("pools", "Assign pools first.")
        placed = {p for pool in sess["pools"] for p in pool["players"]}
        loose = [self.state["players"][p]["name"] for p in sess["attending"] if p not in placed]
        if loose:
            raise ActionError("unassigned", "Not in a pool yet: %s." % ", ".join(loose))
        for pool in sess["pools"]:
            n = len(pool["players"])
            if not scheduler.MIN_POOL <= n <= scheduler.MAX_POOL:
                raise ActionError("size", "%s has %d players. A pool needs %d to %d." % (pool["name"], n, scheduler.MIN_POOL, scheduler.MAX_POOL))
        sess["games"] = {}
        for pool in sess["pools"]:
            pool["rounds"] = []
            pool["confirmed"] = 0
            if pool.get("bestOf") and len(pool["players"]) != 4:
                pool.pop("bestOf")
            for ri, rd in enumerate(scheduler.generate(pool["players"], seed=sess["id"] + pool["id"], mode=self.state["league"].get("schedule", "ranker"), best_of=pool.get("bestOf"))):
                ids = []
                for t1, t2 in rd:
                    gid = self._id("g")
                    sess["games"][gid] = dict(id=gid, pool=pool["id"], round=ri, t1=list(t1), t2=list(t2), s1=None, s2=None, status="pending")
                    ids.append(gid)
                pool["rounds"].append(ids)

    def do_session_start(self, a, org):
        sess = self._session(a.get("sid"), "setup")
        if not sess["games"]:
            self.do_session_schedule(a, org)
        base = self.state["league"]["pointsToWin"]
        sizes = [len(p["players"]) for p in sess["pools"]]
        for p in sess["pools"]:
            if not p.get("target"):
                p["target"] = auto_target(sizes, len(p["players"]), base)
                p["autoTarget"] = True
        sess["status"] = "live"
        sess["pointsToWin"] = base

    def do_session_unstart(self, a, org):
        sess = self._session(a.get("sid"), "live")
        if self._done(sess):
            raise ActionError("scores", "Scores have been entered, so the session cannot go back to setup.")
        sess["status"] = "setup"
        for pool in sess["pools"]:
            pool["confirmed"] = 0
            if pool.pop("autoTarget", None):
                pool.pop("target", None)

    def do_session_reset(self, a, org):
        """Back to a fresh start for the same draw: no scores, every pool on round 1."""
        sess = self._session(a.get("sid"), "live")
        if sess.get("wasClosed"):
            raise ActionError("reopened", "This session was finished once and then reopened, so it cannot be reset. Correct its scores, or delete it.")
        self.backup()
        for g in sess["games"].values():
            g.update(s1=None, s2=None, status="pending")
            g.pop("at", None)
            g.pop("auto", None)
        for pool in sess["pools"]:
            pool["confirmed"] = 0
        return dict(games=len(sess["games"]))

    def do_session_delete(self, a, org):
        sess = self._session(a.get("sid"), "setup", "live")
        if self._done(sess):
            if not a.get("force"):
                raise ActionError("scores", "Scores have been entered. Deleting the session deletes them too.")
            self.backup()
        self.state["sessions"].remove(sess)

    # ---- live session ------------------------------------------------------
    def _game(self, a, org):
        sess = self._session(a.get("sid"))
        if sess["status"] == "setup":
            raise ActionError("status", "The session has not started.")
        if sess["status"] == "closed" and not org:
            raise ActionError("pin", "This session is finished. Only the organiser can change it.")
        if sess["status"] == "closed" and not a.get("history"):
            raise ActionError("closed", "This session has been finished. Its scores can only be changed from Organiser, History.")
        g = sess["games"].get(a.get("gid"))
        if g is None:
            raise ActionError("missing", "Game not found.")
        return sess, g

    def do_game_score(self, a, org):
        sess, g = self._game(a, org)
        try:
            s1, s2 = int(a["s1"]), int(a["s2"])
        except (KeyError, TypeError, ValueError):
            raise ActionError("invalid", "Enter both scores.")
        if not (0 <= s1 <= 60 and 0 <= s2 <= 60) or s1 == s2:
            raise ActionError("invalid", "Scores must be different whole numbers.")
        pool = next((p for p in sess["pools"] if p["id"] == g.get("pool")), None)
        target = engine.target_of(sess, pool or {})      # what the ratings assume too: an old session with nothing recorded was to 11
        if max(s1, s2) > target:
            raise ActionError("invalid", "Games are first to %d, so the winning score cannot be more than %d." % (target, target))
        if g["status"] == "skipped" and not org:
            raise ActionError("skipped", "This game was marked as not played.")
        if g["status"] == "done" and (g["s1"], g["s2"]) != (s1, s2):
            was = a.get("was")
            stale = isinstance(was, dict) and (was.get("s1"), was.get("s2")) != (g["s1"], g["s2"])
            if not a.get("replace") or stale:
                raise ActionError("exists", "Already entered as %d-%d." % (g["s1"], g["s2"]), s1=g["s1"], s2=g["s2"])
        g.update(s1=s1, s2=s2, status="done", at=int(time.time()))
        g.pop("auto", None)
        if sess["status"] == "closed":
            self.recompute()

    def do_game_clear(self, a, org):
        sess, g = self._game(a, org)
        g.update(s1=None, s2=None, status="pending")
        g.pop("at", None)
        g.pop("auto", None)
        if sess["status"] == "closed":
            g["status"] = "skipped"
            self.recompute()

    def do_game_skip(self, a, org):
        sess, g = self._game(a, org)
        if g["status"] == "done":
            raise ActionError("scores", "Clear the score first.")
        g["status"] = "skipped" if a.get("skip", True) else "pending"
        g.pop("auto", None)

    def do_round_confirm(self, a, org):
        """Move a pool on to its next round once every game in the current one has a score."""
        sess = self._session(a.get("sid"), "live")
        pool = next((p for p in sess["pools"] if p["id"] == a.get("pool")), None)
        if pool is None:
            raise ActionError("missing", "Pool not found.")
        rnd_no, at = int(a.get("round", -1)), pool.get("confirmed", 0)
        if rnd_no < at:
            return dict(round=at)
        if rnd_no > at or rnd_no >= len(pool["rounds"]):
            raise ActionError("order", "That round is not being played yet.")
        if any(sess["games"][gid]["status"] == "pending" for gid in pool["rounds"][rnd_no]) and not dead_round(sess, pool, rnd_no):
            raise ActionError("scores", "Enter every score in this round first.")
        nxt = rnd_no + 1
        while nxt < len(pool["rounds"]) and dead_round(sess, pool, nxt):
            nxt += 1
        pool["confirmed"] = nxt
        return dict(round=pool["confirmed"])

    def do_round_back(self, a, org):
        """Organiser only: undo a confirm made too early. Scores are untouched."""
        sess = self._session(a.get("sid"), "live")
        pool = next((p for p in sess["pools"] if p["id"] == a.get("pool")), None)
        if pool is None:
            raise ActionError("missing", "Pool not found.")
        if pool.get("confirmed", 0) <= 0:
            raise ActionError("order", "This pool is already on its first round.")
        pool["confirmed"] -= 1
        return dict(round=pool["confirmed"])

    def do_session_substitute(self, a, org):
        sess = self._session(a.get("sid"), "setup", "live")
        out, new = a.get("out"), a.get("in")
        p_new = self._player(new)
        if not p_new["active"]:
            raise ActionError("inactive", "%s is marked as dropped out." % p_new["name"])
        pool = next((p for p in sess["pools"] if out in p["players"]), None)
        if pool is None:
            raise ActionError("missing", "The player to replace is not in a pool.")
        if any(new in p["players"] for p in sess["pools"]):
            raise ActionError("duplicate", "%s is already playing in this session." % p_new["name"])
        changed = 0
        for g in sess["games"].values():
            if g["pool"] == pool["id"] and g["status"] != "done":
                for team in ("t1", "t2"):
                    if out in g[team]:
                        g[team] = [new if p == out else p for p in g[team]]
                        changed += 1
        pool["players"][pool["players"].index(out)] = new
        if not any(out in g["t1"] + g["t2"] for g in self._done(sess)):
            sess["attending"] = [p for p in sess["attending"] if p != out]
        if new not in sess["attending"]:
            sess["attending"].append(new)
        return dict(games=changed)

    def do_session_close(self, a, org):
        sess = self._session(a.get("sid"), "live")
        if not self._done(sess):
            raise ActionError("scores", "No scores have been entered. Delete the session instead of finishing it.")
        for g in sess["games"].values():
            if g["status"] == "pending":
                g["status"] = "skipped"
                g["auto"] = True
        sess["status"] = "closed"
        sess["wasClosed"] = True
        self.recompute()
        self._backup_after = True      # a copy of the league with the night finished

    def do_session_reopen(self, a, org):
        sess = self._session(a.get("sid"), "closed")
        if self._open_session():
            raise ActionError("open", "Another session is already open.")
        latest = max((s for s in self.state["sessions"] if s["status"] == "closed"), key=lambda s: (s["date"], s["id"]))
        if latest is not sess:
            raise ActionError("order", "Only the most recent session can be reopened.")
        self.backup()
        sess["status"] = "live"
        sess["wasClosed"] = True      # an imported session never passed through Finish here
        for g in sess["games"].values():
            if g["status"] == "skipped" and g.get("auto"):
                g["status"] = "pending"
                g.pop("auto", None)
        self.recompute()


# Actions anyone on the network may send during a live session. Everything else needs the organiser PIN.
def dead_round(sess, pool, rnd_no):
    """Best of 3 (a pool of four): the third game of a match that one pair has already won 2-0. Same rule as deadRound in docs/core.js."""
    rounds = pool.get("rounds") or []
    if pool.get("bestOf") != 3 or len(pool["players"]) != 4 or len(rounds) != 9 or rnd_no % 3 != 2 or rnd_no >= len(rounds):
        return False
    a, b, c = (sess["games"].get(rounds[k][0]) for k in (rnd_no - 2, rnd_no - 1, rnd_no))
    return bool(a and b and c and c["status"] == "pending" and a["status"] == "done" and b["status"] == "done"
                and (a["s1"] > a["s2"]) == (b["s1"] > b["s2"]))


OPEN_ACTIONS = {"game.score", "game.clear", "round.confirm"}

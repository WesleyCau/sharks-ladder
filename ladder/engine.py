"""Rating engine: Sharks per-game formula, averaged over every order of a session's rounds.

All ratings are integers in thousandths (3700 = 3.700).

Per game:
  win prob = 1 / (1 + e^(-K_PROB * (winners' avg - losers' avg)))
  Elo term = 0.100 * (1 - win prob), with the win prob taken to 0.01%      winners gain it, losers lose it
  bonus    = winners +(W - L)/1000, losers +L/1000
  Each player's new 4DR is rounded half up to 0.001, so on an exact half-thousandth the winners gain 0.001 more
  than the losers lose. Replayed in play order this reproduces every figure on pickleballranker.com for Season 7.
Per session, per pool: replay the rounds in every possible order and average the end ratings,
so a result is worth the same whenever in the night it was played.
"""
import hashlib
import json
import math
import os

K_ELO = 100
K_PROB = 8.988
MAX_EXACT_ROUNDS = 9      # 9! = 362,880 orders; beyond that, sample. Must match docs/core.js
SAMPLE_ORDERS = 20000
BONUS_BASE = 11            # the club's formula is for games to 11; a longer game's score bonus is scaled back to that
_ENGINE = "sharks-1"      # change this if the formula changes: it retires the results kept on disk

_cache = {}
_disk, _disk_path = {}, None      # results of the slow pool-nights (nine rounds), kept between runs by use_disk_cache


def use_disk_cache(path):
    """Keep slow all-orders results in this file. The key covers everything a result depends on, so it never goes stale."""
    global _disk, _disk_path
    _disk_path = path
    try:
        with open(path, encoding="utf-8") as f:
            saved = json.load(f)
        _disk = saved.get("results", {}) if saved.get("engine") == _ENGINE else {}
    except (OSError, ValueError):
        _disk = {}


def _digest(key):
    return hashlib.sha1(repr(key).encode("utf-8")).hexdigest()


def _save_disk():
    try:
        tmp = _disk_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(dict(engine=_ENGINE, results=_disk), f)
        os.replace(tmp, _disk_path)
    except OSError:
        pass


def rnd(x):
    return math.floor(x + 0.5)


_M = 0xFFFFFFFF


def _rng(seed):
    """The website's seeded generator (rng in docs/core.js), bit for bit, so both engines sample the same orders."""
    h = (1779033703 ^ len(seed)) & _M
    for ch in seed:
        h = ((h ^ ord(ch)) * 3432918353) & _M
        h = ((h << 13) | (h >> 19)) & _M
    state = [h]

    def rand():
        a = state[0] = (state[0] + 0x6D2B79F5) & _M
        t = ((a ^ (a >> 15)) * (1 | a)) & _M
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & _M)) & _M) ^ t
        return ((t ^ (t >> 14)) & _M) / 4294967296
    return rand


def _sampled_orders(n):
    rand, order = _rng("orders-%d" % n), list(range(n))
    for _ in range(SAMPLE_ORDERS):
        for i in range(n - 1, 0, -1):          # the same shuffle, carried on from the previous order
            j = int(rand() * (i + 1))
            order[i], order[j] = order[j], order[i]
        yield order


def all_orders(start, rounds):
    """start: {pid: rating}. rounds: [[(gid, win_pair, lose_pair, ws, ls), ...], ...].

    Returns ({pid: mean end rating}, {gid: (mean winners' prob, mean winners' change, mean losers' change)})."""
    players = sorted({p for rd in rounds for g in rd for p in g[1] + g[2]})
    key = (tuple((p, start[p]) for p in players), tuple(tuple(rd) for rd in rounds))
    if key in _cache:
        return _cache[key]
    saved = _disk.get(_digest(key))
    if saved:
        _cache[key] = ({p: v for p, v in saved[0]}, {g: tuple(v) for g, v in saved[1]})
        return _cache[key]
    idx = {p: i for i, p in enumerate(players)}
    base = [start[p] for p in players]
    rds = [[(k, idx[g[1][0]], idx[g[1][1]], idx[g[2][0]], idx[g[2][1]], g[3], g[4]) for k, g in enumerate(rd)] for rd in rounds]
    sums = [[[0.0, 0.0, 0.0] for _ in rd] for rd in rounds]
    total = [0.0] * len(players)
    exp, floor, nr = math.exp, math.floor, len(rounds)
    if nr <= MAX_EXACT_ROUNDS:
        # Every order once, walked as a tree: orders that begin with the same rounds share the work of those rounds.
        # A game played at a node counts once for each order below it (weight). Same sums as docs/core.js.
        fact = [math.factorial(i) for i in range(nr + 1)]
        used = [False] * nr

        def walk(depth, cur):
            if depth == nr:
                for j, v in enumerate(cur):
                    total[j] += v
                return
            weight = fact[nr - depth - 1]
            for i in range(nr):
                if used[i]:
                    continue
                used[i] = True
                r = cur[:]
                acc = sums[i]
                for k, a, b, c, d, ws, ls in rds[i]:
                    prob = 1 / (1 + exp(-K_PROB * (r[a] + r[b] - r[c] - r[d]) / 2000))
                    e = 10000 - floor(prob * 10000 + 0.5)      # the club's rounding, see the note at the top
                    dw, dl = (e + 50) // 100 + ws - ls, ls - (e + 49) // 100
                    r[a] += dw
                    r[b] += dw
                    r[c] += dl
                    r[d] += dl
                    s = acc[k]
                    s[0] += prob * weight
                    s[1] += dw * weight
                    s[2] += dl * weight
                walk(depth + 1, r)
                used[i] = False
        walk(0, base)
        n = fact[nr]
    else:
        n = 0
        for order in _sampled_orders(nr):
            r = base[:]
            for i in order:
                acc = sums[i]
                for k, a, b, c, d, ws, ls in rds[i]:
                    prob = 1 / (1 + exp(-K_PROB * (r[a] + r[b] - r[c] - r[d]) / 2000))
                    e = 10000 - floor(prob * 10000 + 0.5)
                    dw, dl = (e + 50) // 100 + ws - ls, ls - (e + 49) // 100
                    r[a] += dw
                    r[b] += dw
                    r[c] += dl
                    r[d] += dl
                    s = acc[k]
                    s[0] += prob
                    s[1] += dw
                    s[2] += dl
            for j, v in enumerate(r):
                total[j] += v
            n += 1
    ends = {p: total[idx[p]] / n for p in players}
    games = {g[0]: tuple(v / n for v in sums[i][k]) for i, rd in enumerate(rounds) for k, g in enumerate(rd)}
    if len(_cache) > 400:
        _cache.clear()
    _cache[key] = (ends, games)
    if _disk_path and nr >= 8:      # slow ones are kept on disk, so a restart or a later correction does not redo them
        _disk[_digest(key)] = [sorted(ends.items()), sorted(games.items())]
        _save_disk()
    return ends, games


def target_of(sess, pool):
    return pool.get("target") or sess.get("pointsToWin") or BONUS_BASE


def scaled(win_score, lose_score, target):
    """(ws, ls) as the engine wants them, with the bonus scaled to a game to 11. Unchanged when the game was to 11."""
    if target == BONUS_BASE:
        return win_score, lose_score
    bl = (2 * BONUS_BASE * lose_score + target) // (2 * target)
    bw = (2 * BONUS_BASE * (win_score - lose_score) + target) // (2 * target)
    return bw + bl, bl


def step(prob, ws, ls):
    """One game's change for the winners and the losers, in thousandths, from the winners' win probability."""
    e = 10000 - math.floor(prob * 10000 + 0.5)
    return (e + 50) // 100 + ws - ls, ls - (e + 49) // 100


def play_order(state):
    """Ratings from playing every closed session's rounds in the order they are stored: the club's published method.
    Returns {session id: {player id: rating after that session}} for the players who played it."""
    rating = {pid: p["seed"] for pid, p in state["players"].items()}
    out = {}
    for sess in sorted((s for s in state["sessions"] if s["status"] == "closed"), key=lambda s: (s["date"], s["id"])):
        played = set()
        for pool in sess["pools"]:
            for rd in pool.get("rounds", []):
                for gid in rd:
                    g = sess["games"][gid]
                    if g["status"] != "done" or g["s1"] == g["s2"]:
                        continue
                    win, lose, ws, ls = (g["t1"], g["t2"], g["s1"], g["s2"]) if g["s1"] > g["s2"] else (g["t2"], g["t1"], g["s2"], g["s1"])
                    prob = 1 / (1 + math.exp(-K_PROB * (rating[win[0]] + rating[win[1]] - rating[lose[0]] - rating[lose[1]]) / 2000))
                    dw, dl = step(prob, *scaled(ws, ls, target_of(sess, pool)))
                    for pid in win:
                        rating[pid] += dw
                    for pid in lose:
                        rating[pid] += dl
                    played.update(win + lose)
        out[sess["id"]] = {pid: rating[pid] for pid in played}
    return out


def compute(state):
    """Recompute every rating from the closed sessions, oldest first."""
    players = state["players"]
    rating = {pid: p["seed"] for pid, p in players.items()}
    totals = {pid: dict(w=0, l=0, pf=0, pa=0) for pid in players}
    by_session, game_out = {}, {}
    closed = sorted((s for s in state["sessions"] if s["status"] == "closed"), key=lambda s: (s["date"], s["id"]))
    for sess in closed:
        rec = {}
        start = dict(rating)
        for pool in sess["pools"]:
            rounds = []
            for rd in pool.get("rounds", []):
                games = []
                for gid in rd:
                    g = sess["games"][gid]
                    if g["status"] != "done" or g["s1"] == g["s2"]:
                        continue
                    t1, t2 = tuple(g["t1"]), tuple(g["t2"])
                    if g["s1"] > g["s2"]:
                        games.append((gid, t1, t2, g["s1"], g["s2"]))
                    else:
                        games.append((gid, t2, t1, g["s2"], g["s1"]))
                if games:
                    rounds.append(games)
            if not rounds:
                continue
            target = target_of(sess, pool)
            ends, gmean = all_orders(start, [[(gid, win, lose) + scaled(ws, ls, target) for gid, win, lose, ws, ls in rd] for rd in rounds])
            for pid, v in ends.items():
                rating[pid] = rnd(v)
                rec[pid] = dict(pool=pool["id"], start=start[pid], end=rating[pid], w=0, l=0, pf=0, pa=0)
            for rd in rounds:
                for gid, win, lose, ws, ls in rd:
                    prob, dw, dl = gmean[gid]
                    t1_won = sess["games"][gid]["s1"] > sess["games"][gid]["s2"]
                    game_out[gid] = dict(p1=round(prob if t1_won else 1 - prob, 4),
                                         d1=round(dw if t1_won else dl, 2), d2=round(dl if t1_won else dw, 2))
                    for pid in win:
                        for d in (rec[pid], totals[pid]):
                            d["w"] += 1
                            d["pf"] += ws
                            d["pa"] += ls
                    for pid in lose:
                        for d in (rec[pid], totals[pid]):
                            d["l"] += 1
                            d["pf"] += ls
                            d["pa"] += ws
        by_session[sess["id"]] = rec
    return dict(current=rating, sessions=by_session, games=game_out, totals=totals)

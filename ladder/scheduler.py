"""Round-robin doubles schedules for one pool.

8 players: the whist design. 7 rounds of 2 games; everyone partners everyone once and
opposes everyone twice. 9 players: the whist design for nine, 9 rounds of 2 games with one
player sitting out each round. Other sizes (4 to 12): a balanced schedule with even sit-outs,
sized so each player gets as close to 7 games as an equal share allows.
"""
import itertools
import random

TARGET_GAMES = 7
MIN_POOL, MAX_POOL = 4, 12


def round_count(n, target=TARGET_GAMES):
    """Rounds so every player plays the same number of games, as near to target as possible."""
    per_round = 4 * (n // 4)
    best = None
    for rounds in range(1, 60):
        if (per_round * rounds) % n:
            continue
        each = per_round * rounds // n
        key = (abs(each - target), -each)
        if best is None or key < best[0]:
            best = (key, rounds)
    return best[1]


def _counts(n, rounds):
    partner = [[0] * n for _ in range(n)]
    oppose = [[0] * n for _ in range(n)]
    for rd in rounds:
        for (a, b), (c, d) in rd:
            partner[a][b] += 1
            partner[b][a] += 1
            partner[c][d] += 1
            partner[d][c] += 1
            for x in (a, b):
                for y in (c, d):
                    oppose[x][y] += 1
                    oppose[y][x] += 1
    return partner, oppose


def _whist8():
    """Cyclic whist design for 8: develop a starter round mod 7 with one fixed player."""
    inf = 7
    for perm in itertools.permutations(range(1, 7)):
        starter = [((inf, 0), (perm[0], perm[1])), ((perm[2], perm[3]), (perm[4], perm[5]))]
        rounds = []
        for k in range(7):
            shift = lambda x: x if x == inf else (x + k) % 7
            rounds.append([((shift(a), shift(b)), (shift(c), shift(d))) for (a, b), (c, d) in starter])
        partner, oppose = _counts(8, rounds)
        if all(partner[i][j] == 1 and oppose[i][j] == 2 for i in range(8) for j in range(8) if i != j):
            return rounds
    return None


def _whist9():
    """Whist design for 9 on a 3 x 3 grid: a starter round with player 0 sitting out, moved on by each step of the grid.
    Everyone partners everyone once, opposes everyone twice and sits out once. Same design as whist9 in docs/core.js."""
    add = lambda x, k: 3 * ((x // 3 + k // 3) % 3) + (x + k) % 3      # noqa: E731
    starter = [((1, 2), (3, 6)), ((4, 8), (5, 7))]
    return [[((add(a, k), add(b, k)), (add(c, k), add(d, k))) for (a, b), (c, d) in starter] for k in range(9)]


def _balanced(n, n_rounds, rng):
    per_round = n // 4
    best = None
    for _ in range(30):
        partner = [[0] * n for _ in range(n)]
        oppose = [[0] * n for _ in range(n)]
        played = [0] * n
        rounds = []
        for _r in range(n_rounds):
            order = sorted(range(n), key=lambda i: (played[i], rng.random()))
            playing = order[:4 * per_round]
            pick = None
            for _try in range(150):
                rng.shuffle(playing)
                cost = 0
                for k in range(per_round):
                    a, b, c, d = playing[4 * k:4 * k + 4]
                    cost += 12 * (partner[a][b] + partner[c][d])
                    cost += oppose[a][c] + oppose[a][d] + oppose[b][c] + oppose[b][d]
                if pick is None or cost < pick[0]:
                    pick = (cost, playing[:])
            rd = []
            for k in range(per_round):
                a, b, c, d = pick[1][4 * k:4 * k + 4]
                rd.append(((a, b), (c, d)))
                partner[a][b] += 1
                partner[b][a] += 1
                partner[c][d] += 1
                partner[d][c] += 1
                for x in (a, b):
                    for y in (c, d):
                        oppose[x][y] += 1
                        oppose[y][x] += 1
                for x in (a, b, c, d):
                    played[x] += 1
            rounds.append(rd)
        score = sum(12 * partner[i][j] ** 2 + oppose[i][j] ** 2 for i in range(n) for j in range(i + 1, n))
        if best is None or score < best[0]:
            best = (score, rounds)
    return best[1]


# The schedules pickleballranker has used for this league: one fixed set of rounds for eight and for nine, by slot
# (1 = highest 4DR in the pool). The same text as RANKER in docs/core.js.
RANKER = {
    8: "18v26 34v57|16v45 28v37|14v38 27v56|13v67 25v48|17v24 36v58|12v35 47v68|15v78 23v46",
    9: "23v47 59v68|13v58 49v67|12v69 48v57|17v56 29v38|19v37 28v46|18v27 39v45|14v89 26v35|16v34 25v79|15v24 36v78",
}


# The same games with the rounds reordered (pickleballranker's round numbers): closest round last. As CLOSEST in docs/core.js.
CLOSEST = {8: [1, 3, 5, 4, 6, 7, 2], 9: [9, 3, 1, 2, 4, 7, 6, 8, 5]}


def _ranker(n):
    if n not in RANKER:
        return None
    return [[tuple((int(side[0]) - 1, int(side[1]) - 1) for side in m.split("v")) for m in rd.split(" ")] for rd in RANKER[n].split("|")]


def generate(players, seed=0, mode=None):
    """players: list of ids. Returns rounds: [[(pair, pair), ...], ...] using those ids.
    mode "ranker": eights and nines get pickleballranker's fixed rounds, players taken in the order given.
    mode "closest": the same games, rounds in the CLOSEST order."""
    n = len(players)
    if not MIN_POOL <= n <= MAX_POOL:
        raise ValueError("a pool needs %d to %d players, got %d" % (MIN_POOL, MAX_POOL, n))
    fixed = _ranker(n) if mode in ("ranker", "closest") else None
    if fixed and mode == "closest":
        fixed = [fixed[k - 1] for k in CLOSEST[n]]
    if fixed:
        return [[((players[a], players[b]), (players[c], players[d])) for (a, b), (c, d) in rd] for rd in fixed]
    rng = random.Random("%s-%d" % (seed, n))
    design = _whist8() if n == 8 else _whist9() if n == 9 else None
    if design is None:
        design = _balanced(n, round_count(n), rng)
    slots = list(players)
    rng.shuffle(slots)
    design = list(design)
    rng.shuffle(design)
    return [[((slots[a], slots[b]), (slots[c], slots[d])) for (a, b), (c, d) in rd] for rd in design]


def summary(players, rounds):
    """Balance check used by tests and the organiser view."""
    index = {p: i for i, p in enumerate(players)}
    as_idx = [[((index[a], index[b]), (index[c], index[d])) for (a, b), (c, d) in rd] for rd in rounds]
    partner, oppose = _counts(len(players), as_idx)
    games = [sum(1 for rd in as_idx for t1, t2 in rd if i in t1 + t2) for i in range(len(players))]
    n = len(players)
    pairs = [(i, j) for i in range(n) for j in range(i + 1, n)]
    return dict(rounds=len(rounds), games=sum(len(rd) for rd in rounds), each_min=min(games), each_max=max(games),
                partner_min=min(partner[i][j] for i, j in pairs), partner_max=max(partner[i][j] for i, j in pairs),
                oppose_min=min(oppose[i][j] for i, j in pairs), oppose_max=max(oppose[i][j] for i, j in pairs))

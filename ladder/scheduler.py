"""Round-robin doubles schedules for one pool.

8 players: the whist design. 7 rounds of 2 games; everyone partners everyone once and
opposes everyone twice. Other sizes (4 to 12): a balanced schedule with even sit-outs,
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


def generate(players, seed=0):
    """players: list of ids. Returns rounds: [[(pair, pair), ...], ...] using those ids."""
    n = len(players)
    if not MIN_POOL <= n <= MAX_POOL:
        raise ValueError("a pool needs %d to %d players, got %d" % (MIN_POOL, MAX_POOL, n))
    rng = random.Random("%s-%d" % (seed, n))
    design = _whist8() if n == 8 else None
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

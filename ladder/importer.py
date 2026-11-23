"""One-time import of the weeks already played, from the Sharks League CSVs (written by Sharks League/sharks_s7.py).

Run:  python -m ladder.importer            (from the Ladder App folder)
Reads ../Sharks League/{ratings,weekly,games}.csv and writes data/league.json.
"""
import csv
import os
import sys

from . import engine
from .store import empty_state

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.normpath(os.path.join(HERE, "..", "..", "Sharks League"))


def _rows(folder, name):
    with open(os.path.join(folder, name), encoding="utf-8") as f:
        return list(csv.DictReader(f))


def build(source=SOURCE, name="Southern Sharks PC Season 7"):
    ratings, weekly, games = _rows(source, "ratings.csv"), _rows(source, "weekly.csv"), _rows(source, "games.csv")
    state = empty_state(name)
    ids = {}
    for r in ratings:
        state["seq"]["p"] += 1
        pid = "p%d" % state["seq"]["p"]
        ids[r["Player"]] = pid
        state["players"][pid] = dict(id=pid, name=r["Player"], active=r.get("Active", "yes") != "no", seed=int(round(float(r["Seed"]) * 1000)))
    for date in sorted({w["date"] for w in weekly}):
        wk = [w for w in weekly if w["date"] == date]
        starts = {}
        for w in wk:
            starts.setdefault(w["court"], []).append(float(w["start"]))
        courts = sorted(starts, key=lambda c: -sum(starts[c]) / len(starts[c]))
        state["seq"]["s"] += 1
        sess = dict(id="s%d" % state["seq"]["s"], date=date, status="closed", attending=[ids[w["player"]] for w in wk], pools=[], games={})
        for i, court in enumerate(courts):
            members = sorted((w for w in wk if w["court"] == court), key=lambda w: -float(w["start"]))
            pool = dict(id=chr(65 + i), name="Pool " + chr(65 + i), courts=2, players=[ids[w["player"]] for w in members], rounds=[])
            by_round = {}
            for g in games:
                if g["date"] == date and g["court"] == court:
                    by_round.setdefault(int(g["round"]), []).append(g)
            for ri, rnd_no in enumerate(sorted(by_round)):
                gids = []
                for g in by_round[rnd_no]:
                    state["seq"]["g"] += 1
                    gid = "g%d" % state["seq"]["g"]
                    sess["games"][gid] = dict(id=gid, pool=pool["id"], round=ri, t1=[ids[g["winner1"]], ids[g["winner2"]]],
                                              t2=[ids[g["loser1"]], ids[g["loser2"]]], s1=int(g["win_score"]), s2=int(g["lose_score"]), status="done")
                    gids.append(gid)
                pool["rounds"].append(gids)
            sess["pools"].append(pool)
        state["sessions"].append(sess)
    state["ratings"] = engine.compute(state)
    return state


def main():
    import json
    data = os.path.normpath(os.path.join(HERE, "..", "data"))
    os.makedirs(data, exist_ok=True)
    path = os.path.join(data, "league.json")
    if os.path.exists(path) and "--force" not in sys.argv:
        sys.exit("data/league.json already exists. Use --force to replace it.")
    state = build()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    print("imported %d players, %d sessions, %d games" % (len(state["players"]), len(state["sessions"]), sum(len(s["games"]) for s in state["sessions"])))


if __name__ == "__main__":
    main()

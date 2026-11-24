# Southern Sharks ladder manager

A prototype for running the Southern Sharks PC doubles ladder next season: roster, weekly pools set by 4DR, courtside score entry with large buttons, standings and a page for every player. It is loaded with Season 7's results so it can be judged on a real league.

It is a separate site from the Adelaide ladder manager it grew out of: its own code, its own data, its own colours.

- **Pools:** players attending are ranked by 4DR and split into pools of eight or nine, two courts each. 36 players is four pools of nine; 34 is 8, 8, 9, 9; 28 to 31 use tens and elevens, and 23 is an eleven and a twelve, so that nobody lands in a pool of seven (a seven plays one game at a time and takes twice as long; only 13, 14 or 15 players force one). The organiser can move anyone, and a pool's courts follow its size unless set by hand.
- **Schedule:** a pool of eight plays 7 rounds, partnering everyone once and opposing everyone twice. A pool of nine plays 9 rounds, also partnering everyone once and opposing everyone twice, with each player sitting out one round. Other sizes from 4 to 12 get a balanced schedule with even sit-outs.
- **Game length:** each pool plays first to 11, 15 or 21. Left on automatic, a pool with fewer rounds plays longer games so the pools finish together: on a night of eights and nines the nines play 9 rounds to 11 (99 points) and the eights 7 rounds to 15 (105). A pool under eight does not set the pace for the others. The organiser can set any pool by hand before the start, and is warned when a pool will run more than a quarter longer than the rest. The score bonus is scaled to a game to 11, so a longer game is worth the same. A session with no target recorded (the imported Season 7) is treated as first to 11 whatever the league setting is changed to later.
- **Scores:** tap the winning pair, tap the losing score, save. Any phone or tablet can enter a score while a session is live.
- **4DR:** the club's per-game formula. Win chance from the gap between the two pairs' average 4DR, up to 0.100 for the result, plus the score bonus (winners +(W-L)/1000, losers +L/1000).

## How the ratings differ from pickleballranker

The formula is the club's, including its rounding: replayed in the order the games were played, the engine reproduces every one of the 188 end-of-night 4DR figures published for Season 7 (`tests/test_ladder.py`).

The site then goes one step further. Each night is averaged over every order its rounds could have been played in, so a result is worth the same whether it came in round 1 or round 9. Over Season 7 that moves a player's 4DR by 0.016 on average and 0.037 at most, and 17 of 46 players change rank, none by more than 3 places.

## Three ways to run it

| Mode | Where the data lives | Use it for |
|---|---|---|
| Hosted (GitHub Pages + Firebase) | A Firebase Realtime Database, live on every device | Running the league |
| Local server (`python server.py`) | `data/league.json` on the laptop | A venue with no internet: devices join over the laptop's Wi-Fi or hotspot |
| Single device | That browser's storage | Trying it out |

The site in `docs/` picks the mode itself: Firebase if `docs/config.js` has the details, else the local server if it is being served by one, else single device.

## Hosted setup (about 10 minutes, once)

1. Go to <https://console.firebase.google.com>, create a project (Analytics not needed).
2. **Build > Realtime Database > Create database.** Start in locked mode.
3. In the database's **Rules** tab, replace everything with the contents of `database.rules.json` and publish.
4. **Project settings > Your apps > Web app (`</>`)**, register it, and copy the `firebaseConfig` values into `docs/config.js`. Commit and push.
5. Open the site, go to **Organiser > Settings > Load a league file**, and load the league (for Season 7: the `data/league.json` written by `python -m ladder.importer`).

**Organiser login is switched off for now.** `openOrganiser: true` in `docs/config.js` plus the open rules in `database.rules.json` mean anyone with the link can use the organiser tools, so save a copy (Organiser > Settings) before each session.

To switch the login on: enable **Authentication > Email/Password** in Firebase, set `openOrganiser: false`, publish `database.rules.login.json` in the Rules tab, and create the organiser account on the Organiser tab (the first account created becomes the organiser). With those rules anyone can read the league and enter scores during a live session, and only the organiser account can change players, pools, sessions or finished scores. The Firebase config values are not secret; the database rules are what protect the data.

## Availability and the league code

Players say in or out for each league night on the **Availability** page (hosted site and single-device mode; not on the laptop version). The organiser sets the season's nights and when answers close under Organiser, Settings. A new session starts with the players who said in, and the setup screen shows any difference between the list and the answers.

Each time a session is finished, the hosted site saves the whole league in the database (`copies/`), listed under Organiser, Settings, so any week can be rolled back. A restore does not touch players' answers.

**The league code** keeps strangers and scanners from changing anything. It is switched on in Firebase, once:

1. **Authentication > Sign-in method:** enable **Anonymous**. A device needs an id of its own to be filed as a member. No names or passwords are involved.
2. **Realtime Database > Rules:** paste `database.rules.code.json`, replace `PUT-THE-LEAGUE-CODE-HERE` (it appears twice) with a code of your choice, and publish. Do not commit the real code to this repository.
3. Under Organiser, Settings, type the same code to build the players' link, and send that link to the league. The code stays in the address, so a bookmark or home-screen icon keeps working.

With those rules: anyone can read the ladder; a change is only accepted from a device that has opened the link (or typed the code once); scores and round confirms are also accepted from any device while a session is live, so nobody is blocked at the courts. To change the code for a new season, edit it in the Rules tab and send the new link. Until the rules are published the site behaves as before and the code is not checked.

## Local server

```
python server.py
```

Needs Python 3.10 or later and nothing else. It prints the address for other devices (port 8082) and creates `data/config.json` on first run. The organiser PIN in that file is not asked for unless you add `"open": false` to it. The first start after loading a season takes about 20 seconds while it works through the pools of nine; the results are kept in `data/ratings-cache.json`, so later starts are immediate. Finishing a session or correcting an old score works the ratings out with the league unlocked (about 10 seconds for four pools of nine), so other devices keep reading and scoring meanwhile, and a score that lands in that time is counted.

## Season 7 data

`../Sharks League/sharks_s7.py` reads the season from pickleballranker.com and writes `games.csv`, `weekly.csv` and `ratings.csv`. `python -m ladder.importer` turns those into `data/league.json`. None of that data is in this repository.

## Tests

```
node tests/core.test.js
node tests/backend.test.js
python -m unittest discover -s tests
```

`backend.test.js` drives the website's database code against an in-memory stand-in for Firebase (`tests/fake-firebase`), including a second device writing at the same moment. `tests/parity.json` holds numbers written by the JavaScript rating engine that the Python engine must reproduce.

The Python tests that replay Season 7 need the league CSVs, which are not in this repository, and skip themselves without them.

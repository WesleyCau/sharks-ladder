"use strict";
/* Ladder League Manager front end. One state document from the server, re-rendered on every change. */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = v => (v / 1000).toFixed(3);
const sgn = v => (v < 0 ? "−" : "+") + (Math.abs(v) / 1000).toFixed(3);

const app = {
  st: null, urls: [], online: true,
  be: null,          // the backend: firebase, server or local (see backend.js)
  importDoc: null,   // league file chosen for import, waiting for confirmation
  short: {},         // player id -> "First L", rebuilt whenever the roster changes
  flow: null,        // score entry overlay
  sel: null,         // player picked up for a move (organiser)
  confirm: null,     // key of the action waiting for a second tap
  edit: null,        // player id being renamed
  form: {},          // values of inputs with an id, kept across re-renders
  err: {},           // message per area
  tab: "ratings",
  hs: null,          // history chart: { start, now, on: [{ id, slot }] } (pool filters and the players switched on)
  dialog: null,      // confirmation screen: { sid, busy, err }
  chart: null,       // geometry of the chart on screen, for hover and tap
};

/* ---------- backend ---------- */
async function send(type, args = {}) {
  if (!app.be) return { ok: false, code: "offline", message: "Still loading. Try again in a moment." };
  return app.be.send(type, args);
}
const isOrg = () => !!app.be && app.be.isOrg();
function accept(j) { app.st = j.state; app.urls = j.urls || []; app.short = shortNames(j.state.players); render(); }
/* "Sam Carter" -> "Sam C". Two players who would collide get more of the surname: "Alex Gi", "Alex Gr". */
function shortNames(players) {
  const cap = w => (w ? w[0].toUpperCase() + w.slice(1) : w), rows = Object.values(players).map(p => {
    const parts = p.name.trim().split(/\s+/);
    return { id: p.id, first: cap(parts[0]), last: parts.length > 1 ? cap(parts[parts.length - 1]) : "" };
  });
  const out = {};
  for (const r of rows) {
    const same = rows.filter(o => o !== r && o.first.toLowerCase() === r.first.toLowerCase());
    let k = 1;
    while (k < r.last.length && same.some(o => o.last.slice(0, k).toLowerCase() === r.last.slice(0, k).toLowerCase())) k++;
    out[r.id] = r.last ? `${r.first} ${r.last.slice(0, k)}` : r.first;
  }
  return out;
}
function setOnline(on) { if (app.online !== on) { app.online = on; render(); } }
async function boot() {
  app.be = await Backends.pick(accept, setOnline);
  app.be.start();
}
function toast(msg, ms) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("show"), ms || 2200);
}
const inFlight = new Set();
async function act(area, type, args, okMsg) {
  const key = type + JSON.stringify(args);
  if (inFlight.has(key)) return { ok: false, code: "busy", message: app.err[area] || "" };     // a double tap: the first one is still on its way
  inFlight.add(key);
  let j;
  try { j = await send(type, args); } finally { inFlight.delete(key); }
  app.err[area] = j.ok ? "" : j.message;
  if (j.ok && okMsg) toast(okMsg);
  render();
  return j;
}

/* A second tap while the first is still being dealt with does nothing (and does not store a second backup). */
const running = new Set();
async function once(key, fn) {
  if (running.has(key)) return { ok: false, code: "busy" };
  running.add(key);
  try { return await fn(); } finally { running.delete(key); }
}

/* ---------- backups on this device ---------- */
const BACKUPS = "sharks-backups", WHY = { "session.close": "before finishing a session", "session.reopen": "before reopening a session", "session.reset": "before resetting a session", "session.delete": "before deleting a session", correction: "before correcting a finished session", import: "before loading a league file", restore: "before restoring a backup" };
function backups() { try { return JSON.parse(localStorage.getItem(BACKUPS) || "[]"); } catch (e) { return []; } }
function backupLocal(why) {
  try { localStorage.setItem(BACKUPS, JSON.stringify([{ at: Date.now(), why, state: app.st }].concat(backups()).slice(0, 5))); } catch (e) { /* storage full or blocked: carry on */ }
}

/* ---------- selectors ---------- */
const P = id => app.st.players[id] || { name: "?", seed: 0, active: false };
const nm = id => P(id).name;
const sn = id => (app.st.league.nameStyle === "full" ? nm(id) : app.short[id] || nm(id));   // name as shown on match screens
const rating = id => app.st.ratings.current[id] ?? P(id).seed;
const openSess = () => app.st.sessions.find(s => s.status !== "closed");
const closedSess = () => app.st.sessions.filter(s => s.status === "closed").sort((a, b) => (a.date + a.id < b.date + b.id ? -1 : 1));
const sessById = id => app.st.sessions.find(s => s.id === id);
const poolGames = (s, pool) => (pool.rounds || []).flat().map(id => s.games[id]);
const team = ids => ids.map(id => `<span>${esc(sn(id))}</span>`).join("");
const teamLine = ids => ids.map(sn).map(esc).join(" / ");
const niceDate = d => new Date(d + "T00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const dayMonth = d => new Date(d + "T00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/* The one session every Standings tab talks about: the live one, else the last finished. A session still in setup does not count: its pools are provisional. */
function standSession() {
  const s = openSess();
  return s && s.status === "live" ? s : closedSess().pop() || null;
}
/* "tonight" only when it really is tonight, otherwise the date. */
const sessWhen = s => (s.status === "live" && s.date === todayIso() ? "tonight" : "on " + dayMonth(s.date));
/* A finished session's label: its day, numbered when two sessions share one. */
function sessLabels() {
  const seen = {}, out = {};
  closedSess().forEach(s => { const d = dayMonth(s.date), k = seen[d] = (seen[d] || 0) + 1; out[s.id] = k > 1 ? `${d} (${k})` : d; });
  return out;
}
const shortDate = d => new Date(d + "T00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/* Where a pool is up to: the round on court, the one after, and whether the scores are all in. */
function roundInfo(s, pool) {
  const total = pool.rounds.length, at = Math.min(pool.confirmed || 0, total);
  const all = poolGames(s, pool), games = at < total ? pool.rounds[at].map(id => s.games[id]) : [];
  const next = at + 1 < total ? pool.rounds[at + 1].map(id => s.games[id]) : [];
  const off = list => { const on = new Set(list.flatMap(g => [...g.t1, ...g.t2])); return list.length ? pool.players.filter(p => !on.has(p)) : []; };
  return { total, at, finished: at >= total, games, next, sitting: off(games), sittingNext: off(next),
    ready: games.length > 0 && games.every(g => g.status !== "pending"), waiting: games.filter(g => g.status === "pending").length,
    done: all.filter(g => g.status === "done").length, playable: all.filter(g => g.status !== "skipped").length,
    missed: all.filter(g => g.status === "pending" && g.round < at).length };
}
const pct = r => (r.playable ? Math.round(100 * r.done / r.playable) : 0);
function poolTable(s, pool) {
  const rows = new Map(pool.players.map(p => [p, { p, w: 0, l: 0, pf: 0, pa: 0 }]));
  for (const g of poolGames(s, pool)) {
    if (g.status !== "done") continue;
    const add = (ids, mine, theirs) => ids.forEach(p => {
      const r = rows.get(p) || rows.set(p, { p, w: 0, l: 0, pf: 0, pa: 0 }).get(p);
      r.pf += mine; r.pa += theirs; mine > theirs ? r.w++ : r.l++;
    });
    add(g.t1, g.s1, g.s2); add(g.t2, g.s2, g.s1);
  }
  return [...rows.values()].sort((a, b) => b.w - a.w || (b.pf - b.pa) - (a.pf - a.pa) || nm(a.p).localeCompare(nm(b.p)));
}

/* ---------- full screen (All courts on the tablet) ---------- */
const fsOn = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const isHomeScreenApp = () => navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
/* No button on iPads and iPhones: Safari's full screen there interrupts score entry with a warning about typing, puts its own
   close button over the page and stops responding after a scroll. Opened from a Home Screen icon the app already fills the screen. */
const fsCan = () => { const d = document.documentElement; return !isIOS() && !isHomeScreenApp() && d.clientWidth >= 700 && !!(d.requestFullscreen || d.webkitRequestFullscreen); };
function fsEnter() {
  const d = document.documentElement;
  try { const p = (d.requestFullscreen || d.webkitRequestFullscreen).call(d); if (p && p.catch) p.catch(() => {}); } catch (e) { /* the browser said no: stay as we are */ }
}
function fsExit() {
  try { const p = (document.exitFullscreen || document.webkitExitFullscreen).call(document); if (p && p.catch) p.catch(() => {}); } catch (e) { /* already out */ }
}
const fsToggle = () => (fsOn() ? fsExit() : fsEnter());
/* All courts fills the height of the screen: whatever is spare below the lowest pool is shared out as space around the names. */
function fillBoard() {
  const board = $(".board");
  if (!board) return;
  board.style.setProperty("--grow", "0px"); board.style.setProperty("--bz", "1"); board.style.zoom = ""; board.style.width = "";
  if (document.documentElement.clientWidth < 900) return;
  const stacks = [...board.children].filter(e => e.classList.contains("stack"));
  const cards = Math.max(0, ...stacks.map(e => e.querySelectorAll(".bmatch").length));
  if (!cards) return;
  /* measured against the page, not the part of it on screen, so a scrolled or zoomed tablet gets the same answer */
  const off = window.scrollY + $("#app").scrollTop, screen = document.documentElement.clientHeight;
  const lowest = () => Math.max(...stacks.map(e => e.getBoundingClientRect().bottom + off));
  let bottom = lowest();
  const spare = screen - bottom - 22;      // 22: the page's own bottom margin
  if (spare > 4) board.style.setProperty("--grow", Math.min(60, Math.floor(spare / (4 * cards) * 10) / 10) + "px");
  else if (spare < -4) {
    /* Too tall for this screen (a laptop is wide but short): scale the whole board down so the next round stays in view.
       The band holding Confirm and Edit, and the sitting-out line, are sized back up by the same factor (--bz in the
       stylesheet) so they stay comfortable to tap and read. That makes the board a little taller again, hence the passes:
       each one measures the board unscaled with the last factor applied. */
    const top = board.getBoundingClientRect().top + off, room = screen - top - 22;
    let scale = Math.max(0.6, room / (bottom - top));
    for (let pass = 0; pass < 3; pass++) {
      board.style.setProperty("--bz", scale.toFixed(3));
      bottom = lowest();
      scale = Math.max(0.6, Math.min(1, room / (bottom - top)));
    }
    board.style.zoom = scale;      // the board still fills the width: only what is inside it shrinks
  }
}

/* ---------- the page behind the league name: the club's front page ---------- */
/* The players' photo and the club's Ladder League logo, last season's champion, then who is winning now.
   The pictures and the words (headline, kicker, champion) come from club in config.js. */
function viewPickleball() {
  const st = app.st, club = (window.LADDER_CONFIG || {}).club || {}, tot = st.ratings.totals || {}, out = st.ratings.games || {};
  const games = id => (tot[id] ? tot[id].w + tot[id].l : 0);
  const ranked = Object.keys(st.players).filter(id => st.players[id].active && games(id) > 0).sort((a, b) => rating(b) - rating(a) || nm(a).localeCompare(nm(b)));
  const closed = closedSess(), last = closed[closed.length - 1];
  const day = d => new Date(d + "T00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const played = closed.flatMap(s => Object.values(s.games).filter(g => g.status === "done" && g.s1 !== g.s2).map(g => ({ s, g })));
  const close = played.filter(x => Math.abs(x.g.s1 - x.g.s2) <= 2).length;
  /* the least likely win of the season: the winners' chance going in */
  const upset = played.map(x => { const o = out[x.g.id], w1 = x.g.s1 > x.g.s2; return o ? { s: x.s, g: x.g, p: w1 ? o.p1 : 1 - o.p1, win: w1 ? x.g.t1 : x.g.t2, lose: w1 ? x.g.t2 : x.g.t1 } : null; })
    .filter(Boolean).sort((a, b) => a.p - b.p)[0];
  const pair = ids => ids.map(id => `<a class="plink" href="#/player/${id}">${esc(sn(id))}</a>`).join(" and ");
  const head = (club.headline || ["Climb.", "Defend.", "Repeat."]).map((x, i, all) => `<span${i === all.length - 1 ? ' class="hot"' : ""}>${esc(x)}</span>`).join("");
  const top = ranked[0], seed = id => st.players[id].seed;
  const winners = last ? last.pools.map(p => ({ p, r: poolTable(last, p)[0] })).filter(x => x.r && x.r.w + x.r.l > 0) : [];
  const champ = club.champion, same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  const champId = champ && (st.players[champ.id] ? champ.id : Object.keys(st.players).find(id => same(nm(id), champ.name)));
  const go = `<div class="row s-go"><a class="btn primary" href="#/">Tonight's draw</a><a class="btn ghost" href="#/standings">The ladder</a></div>`;
  return `
  <div class="sell">
    <section class="s-hero">
      ${club.photo ? `<a class="s-photo" href="${esc(club.photo.src)}" target="_blank" rel="noopener" title="Open the photo"><img src="${esc(club.photo.src)}" alt="${esc(club.photo.alt || "")}" width="${club.photo.w || 1324}" height="${club.photo.h || 540}"></a>` : ""}
      <div class="s-in${club.photo ? " over" : ""}">
        ${club.logo ? `<img class="s-logo" src="${esc(club.logo.src)}" alt="${esc(club.logo.alt || "")}">` : ""}
        <div class="s-words">
          <span class="s-kick">${esc(club.kicker || st.league.name)}</span>
          <h1>${head}</h1>
          <p class="s-lede">${esc(club.pitch || "A competitive pickleball league.")}${ranked.length ? ` <b>${ranked.length} players. ${played.length} games so far. One ladder.</b>` : ""}</p>
          ${go}
        </div>
      </div>
    </section>

    ${champ ? `<a class="s-champ gold" ${champId ? `href="#/player/${champId}"` : ""}>
      <span class="s-lab">${esc(champ.label || "Reigning champion")}</span><b class="s-name">${esc(champ.name)}</b>${champ.note ? `<span class="s-sub">${esc(champ.note)}</span>` : ""}
      ${champ.rating ? `<span class="s-num num">${esc(champ.rating)}</span>` : ""}</a>` : ""}
    ${top ? `<a class="s-champ" href="#/player/${top}">
      <span class="s-lab">Top of the ladder now</span>
      <b class="s-name">${esc(nm(top))}</b>
      <span class="s-sub">${tot[top].w} wins from ${games(top)} games${rating(top) !== seed(top) ? ` · ${sgn(rating(top) - seed(top))} since the season started` : ""}</span>
      <span class="s-num num">${fmt(rating(top))}</span>
    </a>
    ${ranked.length > 1 ? `<div class="s-pack"><span class="s-lab">The chasing pack</span>${ranked.slice(1, 6).map((id, i) => `<a href="#/player/${id}"><i>${i + 2}</i><b>${esc(nm(id))}</b><span class="num">${fmt(rating(id))}</span></a>`).join("")}</div>` : ""}` : ""}

    ${winners.length ? `<section class="s-block">
      <h2>Last ${esc(new Date(last.date + "T00:00").toLocaleDateString(undefined, { weekday: "long" }))}'s winners <small>${esc(day(last.date))}</small></h2>
      <div class="s-wins">${winners.map(({ p, r }) => `<a class="s-win" href="#/player/${r.p}"><i class="s-badge">${esc(p.id)}</i><span class="s-lab">${esc(p.name)}</span><b>${esc(nm(r.p))}</b><span class="s-sub num">${r.w}-${r.l} · ${r.pf - r.pa >= 0 ? "+" : "−"}${Math.abs(r.pf - r.pa)} points</span></a>`).join("")}</div>
    </section>` : ""}

    ${played.length ? `<section class="s-block">
      <h2>The season so far</h2>
      <div class="s-stats">
        <div><b class="num">${played.length}</b><span>games played over ${closed.length} night${closed.length > 1 ? "s" : ""}</span></div>
        <div><b class="num">${close}</b><span>decided by two points or fewer</span></div>
        ${upset ? `<div><b class="num">${Math.round(upset.p * 100)}%</b><span>the chance ${pair(upset.win)} had against ${pair(upset.lose)} on ${esc(day(upset.s.date))}. They won ${Math.max(upset.g.s1, upset.g.s2)}-${Math.min(upset.g.s1, upset.g.s2)}.</span></div>` : ""}
      </div>
    </section>` : ""}

    <section class="s-end"><b>See you on court.</b>${go}</section>
  </div>`;
}

/* ---------- shared pieces ---------- */
function shell(body) {
  const s = openSess(), route = location.hash.split("/")[1] || "";
  const link = (href, key, ico, label) => `<a href="${href}" ${route === key || (key === "standings" && route === "player") ? 'aria-current="page"' : ""}><span class="ico" aria-hidden="true">${ico}</span>${label}</a>`;
  return `
  <header class="top"><div class="top-in">
    <div class="top-l"><a class="brand" href="#/pickleball" title="About the league">${esc(app.st.league.name)}</a>${s && s.status === "live" ? '<span class="live-dot">Live</span>' : ""}</div>
    <div class="top-c">${route === "board" && fsCan() ? `<button class="fsbtn" data-act="fullscreen">${fsOn() ? "Exit full screen" : "Full screen"}</button>` : ""}</div>
    <nav class="nav" aria-label="Main">
      ${link("#/", "", "●", "Tonight")}${link("#/board", "board", "▦", "All courts")}${link("#/standings", "standings", "≡", "Standings")}${link("#/org", "org", "⚙", "Organiser")}
    </nav>
  </div></header>
  ${app.online ? "" : '<div class="offline">No connection. Scores will not save until it is back.</div>'}
  ${app.be.kind === "local" ? '<div class="demo">Single-device mode: everything is saved in this browser only.</div>' : ""}
  <main class="${route === "board" ? "wide" : route === "pickleball" ? "bleed" : ""}">${body}</main>`;
}
const errLine = area => (app.err[area] ? `<p class="err" role="alert">${esc(app.err[area])}</p>` : "");
/* One game as a scoreboard: a row per pair, names on the left, score on the right. */
function matchCard(s, g, opts = {}) {
  const done = g.status === "done", skipped = g.status === "skipped";
  const side = (ids, pts, won) => `<div class="side ${done ? (won ? "won" : "lost") : ""}"><div class="names">${team(ids)}</div>${opts.preview ? "" : `<div class="pts">${done ? pts : ""}</div>`}</div>`;
  const tag = opts.label ? `<span class="ct">${opts.label}</span>` : "";
  const button = opts.preview ? "" : skipped ? `<p class="muted np">${tag}Not played</p>`
    : `<button class="btn huge ${done ? "quiet" : "primary"}" data-act="flow" data-sid="${s.id}" data-gid="${g.id}">${tag}<span>${done ? (Math.max(g.s1, g.s2) < Ladder.gameTarget(app.st, s, g.id) ? "Stopped early · Edit score" : "Edit score") : "Enter score"}</span></button>`;
  return `<div class="match ${done ? "is-done" : skipped ? "is-skipped" : opts.preview ? "is-preview" : "is-live"}">
    ${side(g.t1, g.s1, g.s1 > g.s2)}${side(g.t2, g.s2, g.s2 > g.s1)}${button}</div>`;
}
/* All courts card. Names on the left, "vs Court 1" on the bar between the pairs, the score column on the right.
   Until there is a score that column is the Enter score button; afterwards it shows the two scores with Edit between them. */
function boardCard(s, g, label, confirm) {
  const done = g.status === "done", skipped = g.status === "skipped", w1 = done && g.s1 > g.s2, w2 = done && g.s2 > g.s1;
  const go = `data-act="flow" data-sid="${s.id}" data-gid="${g.id}"`, where = label ? label + ": " : "";
  const names = (ids, won, row) => `<div class="names r${row}${done ? (won ? " won" : " lost") : ""}">${team(ids)}</div>`;
  const right = done ? `<div class="pts r1 ${w1 ? "won" : "lost"}">${g.s1}</div><button class="editbtn" ${go} aria-label="${where}edit score">Edit</button><div class="pts r3 ${w2 ? "won" : "lost"}">${g.s2}</div>`
    : skipped ? `<div class="enter off"><b>Not<br>played</b></div>`
    : `<button class="enter" ${go} aria-label="${where}enter score"><b>Enter<br>score</b></button>`;
  return `<div class="bmatch ${done ? "is-done" : skipped ? "is-skipped" : "is-live"}">${names(g.t1, w1, 1)}
    ${confirm ? `<div class="mid go"><button class="confirmbtn" data-act="confirmRound" data-sid="${s.id}" data-pool="${confirm.pool}" data-round="${confirm.round}">Confirm round ${confirm.round + 1}<i aria-hidden="true">›</i></button></div>`
      : `<div class="mid"><span class="vsl"><i>vs</i>${label ? `<b>${label}</b>` : ""}</span></div>`}${names(g.t2, w2, 3)}${right}</div>`;
}
/* Width of the widest name as the board draws it, in ems, measured in the page so it follows the stylesheet. */
function boardNameEm(names) {
  const key = "bn" + names.join("|");
  if (!emCache.has(key)) {
    const host = document.createElement("div");
    host.className = "board";
    host.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;width:4000px";
    host.innerHTML = `<div class="bmatch"><div class="names" style="font-size:100px;display:block;white-space:nowrap">${names.map(n => `<span style="display:inline-block">${esc(n)}</span>`).join("<br>")}</div></div>`;
    document.body.appendChild(host);
    emCache.set(key, Math.max(...[...host.querySelectorAll("span")].map(e => e.getBoundingClientRect().width)) / 100);
    host.remove();
  }
  return emCache.get(key);
}
function roundCards(s, pool, r, board) {
  let waiting = 0;
  return r.games.map((g, i) => {
    const label = pool.courts > 1 ? (i < pool.courts ? `Court ${i + 1}` : "Next court") : g.status !== "pending" ? "" : waiting++ === 0 ? "Now" : "Next";
    return board ? boardCard(s, g, label, r.ready && !r.finished ? { pool: pool.id, round: r.at } : null) : matchCard(s, g, { label });
  }).join("");
}
/* Type sizes for the wide screens (board and draw) that keep every name and every pair on one line, whatever the names are. */
const emCache = new Map();
function emWidth(text, weight) {
  const key = weight + text;
  if (!emCache.has(key)) {
    emWidth.ctx = emWidth.ctx || document.createElement("canvas").getContext("2d");
    emWidth.ctx.font = `${weight} 100px ${getComputedStyle(document.body).fontFamily}`;
    emCache.set(key, emWidth.ctx.measureText(text).width / 100);
  }
  return emCache.get(key);
}
function fit(s) {
  const vw = document.documentElement.clientWidth, n = s.pools.length;
  if (vw < 900 || !n) return "";
  const col = (Math.min(1400, vw) - 24 - 10 * (n - 1)) / n, cap = (lo, v, hi) => Math.max(lo, Math.min(hi, Math.floor(v * 10) / 10));
  const names = [...new Set(s.pools.flatMap(p => p.players).concat(Object.values(s.games).flatMap(g => g.t1.concat(g.t2))))].map(sn), pairs = Object.values(s.games).flatMap(g => [g.t1, g.t2]).map(t => t.map(sn).join(" / "));
  const name = boardNameEm(names), pair = Math.max(...pairs.map(x => emWidth(x, 700)));
  const pts = Math.min(76, Math.max(54, vw * 0.055));      // the score column, the same clamp as --ptsw in the stylesheet
  const colB = (Math.min(1800, vw) - 12 - 6 * (n - 1)) / n;      // the board runs closer to the screen edge, with tighter gaps
  return `--n:${n};--colw:${Math.floor(colB)}px;--fit-name:${cap(16, (colB - 28 - pts) / name, 56)}px;--fit-pair:${cap(13, (colB - 36) / pair, 24)}px;--fit-draw:${cap(12, (col - 68) / pair, 18)}px`;
}
/* Tonight: one pool's whole draw. Every round, both courts, scores as they come in. */
function drawPool(s, p) {
  const r = roundInfo(s, p);
  return `<section class="dpool">
    <a class="dp-head" href="#/court/${p.id}"><h2>${esc(p.name)}</h2><span class="round">${r.finished ? "Finished" : `Round ${r.at + 1} of ${r.total}`}${targetTag(s, p)}</span></a>
    ${p.rounds.map((ids, i) => {
      const games = ids.map(id => s.games[id]), on = new Set(games.flatMap(g => [...g.t1, ...g.t2])), sit = p.players.filter(x => !on.has(x));
      return `<div class="drd ${i < r.at ? "past" : i === r.at ? "now" : ""}"><span class="drd-n" aria-label="Round ${i + 1}"><small>R</small>${i + 1}</span><div class="drd-g">
        ${games.map((g, k) => {
          const done = g.status === "done", w1 = done && g.s1 > g.s2, w2 = done && g.s2 > g.s1;
          const court = `<span class="dc">${p.courts > 1 ? (k < p.courts ? "C" + (k + 1) : "+") : k + 1}</span>`;      // "+": more games than courts, on the next one free
          return `<div class="dg${g.status === "skipped" ? " skip" : ""}">
            <span class="dpair${w1 ? " w" : ""}">${teamLine(g.t1)}</span>${done ? `<span class="ds${w1 ? " w" : ""}">${g.s1}</span>` : court}
            <span class="dpair${w2 ? " w" : ""}">${teamLine(g.t2)}</span>${done ? `<span class="ds${w2 ? " w" : ""}">${g.s2}</span>` : ""}</div>`;
        }).join("")}
        ${sit.length ? `<p class="dsit">Sitting out: ${namesList(sit)}</p>` : ""}</div></div>`;
    }).join("")}</section>`;
}
/* One slot under a round's games: either how many scores are missing, or the confirm button. Same size either way. */
function confirmBlock(s, pool, r, brief) {
  if (r.finished) return "";
  const label = r.at + 1 < r.total ? `Confirm and start ${brief ? "R" : "round "}${r.at + 2}` : "Confirm and finish";
  return r.ready ? `<button class="slot go" data-act="confirmRound" data-sid="${s.id}" data-pool="${pool.id}" data-round="${r.at}">${label}</button>`
    : `<div class="slot wait">${r.waiting === 1 ? "1 score to go" : `${r.waiting} scores to go`}</div>`;
}
/* The round after this one, in one box: who plays whom, in order, and who sits out. */
function nextBox(pool, r, compact) {
  if (!r.next.length) return "";
  return `<section class="nextbox ${compact ? "compact" : ""}">
    <h2><span>Next round</span>${compact ? "" : `<span class="num">Round ${r.at + 2} of ${r.total}</span>`}</h2>
    ${r.next.map((g, i) => compact
      ? `<div class="nx side-tag"><span class="nx-tag">${i + 1}</span><div class="nx-lines"><b>${teamLine(g.t1)}</b><b>${teamLine(g.t2)}</b></div></div>`
      : `<div class="nx"><span class="nx-tag">${pool.courts > 1 ? (i < pool.courts ? "Court " + (i + 1) : "Then") : i === 0 ? "First on court" : "Then"}</span>
        <div class="nx-teams"><div class="names">${team(g.t1)}</div><span class="v">v</span><div class="names r">${team(g.t2)}</div></div></div>`).join("")}
    ${r.sittingNext.length ? `<p class="sit"><b>Sitting out</b> ${namesList(r.sittingNext)}</p>` : ""}</section>`;
}
/* Organiser only: step a pool back a round after a confirm made too early. */
function backBlock(s, pool, r) {
  if (!isOrg() || r.at === 0) return "";
  const key = "back-" + pool.id;
  return app.confirm === key
    ? `<div class="row orgrow"><span class="muted">Go back to round ${r.at}? Scores are kept.</span><button class="btn small" data-act="backRound" data-sid="${s.id}" data-pool="${pool.id}">Yes, go back</button><button class="btn small" data-act="cancel">No</button></div>`
    : `<div class="row orgrow"><button class="btn small quiet" data-act="ask" data-key="${key}">‹ Back to round ${r.at}</button></div>`;
}
const namesList = ids => ids.map(sn).map(esc).join(", ");
function standingsTable(s, pool) {
  const rows = poolTable(s, pool);
  return `<div class="scroll"><table>
    <thead><tr><th>#</th><th>Player</th><th class="r">W</th><th class="r">L</th><th class="r">PF</th><th class="r">PA</th><th class="r">+/-</th></tr></thead>
    <tbody>${rows.map((r, i) => `<tr><td>${i + 1}</td><td><a class="plink" href="#/player/${r.p}">${esc(sn(r.p))}</a></td><td class="r">${r.w}</td><td class="r">${r.l}</td><td class="r">${r.pf}</td><td class="r">${r.pa}</td><td class="r">${r.pf - r.pa > 0 ? "+" : ""}${r.pf - r.pa}</td></tr>`).join("")}</tbody>
  </table></div>`;
}
function resultRows(s, pool, canEdit, upto) {
  const rows = poolGames(s, pool).filter(g => (g.status !== "pending" || canEdit === "all" || (canEdit && upto != null)) && (upto == null || g.round < upto));
  if (!rows.length) return '<p class="muted">No results yet.</p>';
  return `<div class="results">${rows.map(g => {
    const w1 = g.status === "done" && g.s1 > g.s2, w2 = g.status === "done" && g.s2 > g.s1;
    const mark = g.status === "done" ? null : g.status === "skipped" ? "not played" : upto != null ? "no score yet" : "to play";
    const early = g.status === "done" && Math.max(g.s1, g.s2) < Ladder.gameTarget(app.st, s, g.id);
    const line = (ids, pts, won) => `<span class="ln ${won ? "w" : ""}"><span>${teamLine(ids)}</span><span class="sc">${mark ? "" : pts}</span></span>`;
    const btn = canEdit ? `<button class="btn small${g.status === "pending" && upto != null ? " primary" : ""}" data-act="flow" data-sid="${s.id}" data-gid="${g.id}">${g.status === "done" ? "Change" : "Enter"}</button>` : "";
    return `<div class="res"><span class="rd">R${g.round + 1}</span>
      <span class="who lines">${line(g.t1, g.s1, w1)}${line(g.t2, g.s2, w2)}${mark ? `<span class="muted">${mark}</span>` : early ? '<span class="muted">stopped early</span>' : ""}</span>${btn}</div>`;
  }).join("")}</div>`;
}

/* ---------- Tonight ---------- */
function viewHome() {
  const s = openSess(), last = closedSess().pop();
  const join = app.be.kind === "server" ? (app.urls.length ? `<p class="note">Players on this Wi-Fi open <b>${esc(app.urls[0])}</b> on their phone.</p>` : "")
    : app.be.kind === "firebase" ? `<p class="note">Players open <b>${esc(location.origin + location.pathname)}</b> on their phone.</p>` : "";
  if (!s) {
    return `<div class="head"><h1>No session running</h1><p class="muted">${last ? "Last session: " + niceDate(last.date) + "." : "No sessions played yet."}</p></div>
      <div class="row"><a class="btn primary" href="#/standings">See standings</a><a class="btn" href="#/org">Organiser: set up a session</a></div>${join}`;
  }
  if (s.status === "setup") {
    const pools = s.pools.filter(p => p.players.length);
    return `<div class="head"><h1>${niceDate(s.date)}</h1><p class="muted">The organiser is setting up this session. ${s.attending.length} players so far.</p></div>
      ${pools.length ? `<div class="pools">${pools.map(p => `<div class="pool"><h2>${esc(p.name)}</h2><ol>${p.players.map((id, i) => `<li class="pl"><span class="rk">${i + 1}</span><span class="nm">${fitName(id)}</span><span class="rt">${fmt(rating(id))}</span></li>`).join("")}</ol></div>`).join("")}</div>` : ""}
      ${join}`;
  }
  return `<div class="dhead"><h1>${niceDate(s.date)}</h1><p class="muted">The full draw. Tap a pool to enter scores.</p></div>
    <div class="draw" style="${fit(s)}">${s.pools.map(p => drawPool(s, p)).join("")}</div>${join}`;
}

/* ---------- Court ---------- */
function viewCourt(pid) {
  const s = openSess(), pool = s && s.pools.find(p => p.id === pid);
  if (!s || s.status !== "live" || !pool) return `<a class="back" href="#/">‹ All pools</a><div class="head"><h1>No live games here</h1><p class="muted">This pool is not playing right now.</p></div>`;
  const r = roundInfo(s, pool);
  return `<div class="court"><a class="back" href="#/">‹ All pools</a>
    <div class="head"><div class="row spread"><h1>${esc(pool.name)}</h1><span class="round">${r.finished ? "Finished" : `Round ${r.at + 1} of ${r.total}`}${targetTag(s, pool)}</span></div>
      <span class="bar on-surface"><i style="width:${pct(r)}%"></i></span></div>
    ${r.finished ? '<div class="note"><b>All rounds finished.</b> Thanks for playing. Final standings are below.</div>' + backBlock(s, pool, r) : `
      <section class="stack">${roundCards(s, pool, r)}
        ${r.sitting.length ? `<p class="sit"><b>Sitting out</b> ${namesList(r.sitting)}</p>` : ""}
        ${errLine("court")}${confirmBlock(s, pool, r)}${backBlock(s, pool, r)}</section>`}
    ${r.missed ? `<p class="note warn">⚠ ${r.missed === 1 ? "1 earlier game has" : r.missed + " earlier games have"} no score. Enter ${r.missed === 1 ? "it" : "them"} under Earlier rounds below.</p>` : ""}
    ${nextBox(pool, r)}
    ${r.at > 0 ? `<div class="card"><h2>Earlier rounds</h2>${resultRows(s, pool, true, r.at)}</div>` : ""}
    <div class="card"><h2>${esc(pool.name)} standings</h2>${standingsTable(s, pool)}</div></div>`;
}

/* ---------- Board ---------- */
function viewBoard() {
  const s = openSess();
  if (!s || s.status !== "live") return `<div class="head"><h1>All courts</h1><p class="muted">No session is live. Current games appear here once the organiser starts one.</p></div>`;
  return `${errLine("court")}
    <div class="board" style="${fit(s)}">${s.pools.map(p => {
      const r = roundInfo(s, p);
      return `<div class="stack">
        <div class="row spread bhead"><h2><a href="#/court/${p.id}">${esc(p.name)}</a></h2><span class="round">${r.finished ? "Finished" : `Round ${r.at + 1} of ${r.total}`}${targetTag(s, p)}</span></div>
        ${r.finished ? '<div class="note">All rounds finished.</div>' : roundCards(s, p, r, true) + (r.sitting.length ? `<p class="sit now"><b>Sitting out now</b> ${namesList(r.sitting)}</p>` : "")}
        ${r.missed ? `<a class="note warn" href="#/court/${p.id}">⚠ ${r.missed === 1 ? "1 earlier game has" : r.missed + " earlier games have"} no score. Tap to enter.</a>` : ""}
        ${nextBox(p, r, true)}${backBlock(s, p, r)}
      </div>`;
    }).join("")}</div>`;
}

/* ---------- Standings ---------- */
function viewStandings() {
  const closed = closedSess(), last = closed[closed.length - 1], shown = standSession(), live = shown && shown.status === "live" ? shown : null;
  const hist = ratingHistory(), hasHist = hist.labels.length > 1 && hist.series.length > 0;
  const tab = app.tab === "session" && shown ? "session" : app.tab === "history" && hasHist ? "history" : "ratings";
  const session = shown ? `<p class="muted">${niceDate(shown.date)}${live ? ", live" : ""}</p>
    <div class="pools">${shown.pools.map(p => `<div class="card"><h2>${esc(p.name)}</h2>${standingsTable(shown, p)}</div>`).join("")}</div>` : "";
  return `<div class="head"><h1>Standings</h1></div>
    <div class="seg" role="group" aria-label="View">
      <button data-act="tab" data-tab="ratings" aria-pressed="${tab === "ratings"}">Ratings</button>
      ${hasHist ? `<button data-act="tab" data-tab="history" aria-pressed="${tab === "history"}">History</button>` : ""}
      ${shown ? `<button data-act="tab" data-tab="session" aria-pressed="${tab === "session"}">${live ? (live.date === todayIso() ? "Tonight" : "Live: " + dayMonth(live.date)) : "Last session"}</button>` : ""}
    </div>
    ${tab === "ratings" ? ratingBoard(last, hist) : tab === "history" ? historyView(hist) : session}`;
}

/* ---------- Rating board ---------- */
/* Which starting level a player was seeded at: 0 is the top pool's seed. */
function seedLevel(id) {
  const seeds = app.st.league.seeds, v = P(id).seed;
  let k = 0;
  seeds.forEach((x, i) => { if (Math.abs(x - v) < Math.abs(seeds[k] - v)) k = i; });
  return k;
}
const levelName = k => "Level " + (k + 1);
/* Every player on one scale: a tick where they were seeded, a dot where they are now. */
function ratingBoard(last, hist) {
  const ids = Object.keys(app.st.players).sort((a, b) => rating(b) - rating(a) || nm(a).localeCompare(nm(b)));
  if (!ids.length) return '<p class="muted">No players yet.</p>';
  const seeds = app.st.league.seeds, lastRec = last ? app.st.ratings.sessions[last.id] || {} : {}, charted = new Set(hist.series.map(x => x.id));
  const vals = ids.flatMap(id => [rating(id), P(id).seed]);
  const lo = Math.floor((Math.min(...vals) - 40) / 100) * 100, hi = Math.ceil((Math.max(...vals) + 40) / 100) * 100;
  const pos = v => ((v - lo) / (hi - lo) * 100).toFixed(2) + "%", ticks = [];
  for (let t = lo + 100; t < hi; t += 100) if ((t - seeds[0]) % 200 === 0) ticks.push(t);
  const grid = ticks.map(t => `<i class="gl" style="left:${pos(t)}"></i>`).join("");
  const games = closedSess().reduce((n, x) => n + Object.values(x.games).filter(g => g.status === "done").length, 0);
  const find = (app.form.rq || "").trim().toLowerCase(), shownIds = find ? ids.filter(id => nm(id).toLowerCase().includes(find)) : ids;
  const poolOf = id => { const p = last && last.pools.find(q => q.players.includes(id)); return p ? p.name : ""; };
  const lastDay = last ? sessLabels()[last.id] : "";
  return `<p class="muted">All ${ids.length} players after ${games} games. The tick marks where a player was seeded and the dot is their 4DR now, so the line between them is how far they have moved. Tap a player for their full record.</p>
    <p class="muted small">4DR here uses the club's per-game formula, with each night averaged over every order its rounds could have been played in, so a result counts the same whenever it happened. It can differ by a few hundredths from the play-order figure on pickleballranker. This site is a prototype for next season, loaded with Season 7's results.</p>
    <input id="rq" type="search" placeholder="Find a player" value="${esc(app.form.rq || "")}" aria-label="Find a player">
    ${find && !shownIds.length ? '<p class="muted">No player matches.</p>' : ""}
    <div class="card"><div class="blegend">${seeds.map((x, i) => `<span class="lv${Math.min(3, i)}"><i class="psw"></i>${levelName(i)} start (${(x / 1000).toFixed(1)})</span>`).join("")}<span><i class="tk"></i>Seed</span></div>
    <ol class="lboard">
      <li class="lrow head" aria-hidden="true"><span class="l-rk">#</span><span class="l-nm">Player</span><span class="trk ax">${ticks.map(t => `<span style="left:${pos(t)}">${(t / 1000).toFixed(1)}</span>`).join("")}</span><span class="l-rt">4DR</span><span class="l-ch">${last ? esc(lastDay) : "Change"}</span></li>
      ${shownIds.map(id => {
        const i = ids.indexOf(id), pl = P(id), r = rating(id), a = Math.min(pl.seed, r), b = Math.max(pl.seed, r), t = app.st.ratings.totals[id] || { w: 0, l: 0 }, rec = lastRec[id], ch = rec ? rec.end - rec.start : null;
        const where = !pl.active ? "dropped out" : rec ? `${esc(poolOf(id) || "played")}, ${lastDay}` : last ? (t.w + t.l ? `missed ${lastDay}` : "yet to play") : "yet to play";
        return `<li class="lrow lv${Math.min(3, seedLevel(id))}${pl.active ? "" : " off"} pickable" data-act="player" data-pid="${id}">
          <span class="l-rk">${i + 1}</span>
          <span class="l-nm"><b><a class="rowlink" href="#/player/${id}">${esc(nm(id))}</a></b><small><i class="psw"></i>${t.w}-${t.l} · ${where}</small></span>
          <span class="trk">${grid}<i class="cn" style="left:${pos(a)};width:${((b - a) / (hi - lo) * 100).toFixed(2)}%"></i><i class="sd" style="left:${pos(pl.seed)}"></i><i class="dt" style="left:${pos(r)}"></i></span>
          <span class="l-rt">${fmt(r)}</span>
          <span class="l-ch">${ch === null ? "" : `<span class="${ch < 0 ? "dn" : "up"}">${sgn(ch)}</span>`}</span></li>`;
      }).join("")}
    </ol></div>
    <p class="muted">Ratings update when the organiser finishes a session. Every game in a session counts the same, whatever order it was played in.</p>`;
}

/* A box on the player page was tapped: go to the part it is about and flash it. The scroll is immediate, and render() repeats
   it if the page redraws in the next couple of seconds: a score arriving redraws everything, and that used to cut an animated
   scroll short, leaving a target near the bottom of the page out of sight. */
function jumpTo(id, again) {
  const el = id === "p-games" ? document.querySelector('[id^="p-s-"]') : document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block: el.tagName === "TR" ? "center" : "start" });
  if (!again) { el.classList.remove("flash"); void el.offsetWidth; }
  el.classList.add("flash");
}

/* ---------- One player ---------- */
/* Everything the league knows about one player: where they stand, how they got there, who they play well with, every game. */
function viewPlayer(pid) {
  const p = app.st.players[pid], back = '<a class="back" href="#/standings">‹ Standings</a>';
  if (!p) return `${back}<div class="head"><h1>Player not found</h1></div>`;
  const closed = closedSess(), recs = app.st.ratings.sessions, labels = sessLabels(), rated = app.st.ratings.games || {};
  const order = Object.keys(app.st.players).sort((a, b) => rating(b) - rating(a) || nm(a).localeCompare(nm(b)));
  const t = app.st.ratings.totals[pid] || { w: 0, l: 0, pf: 0, pa: 0 }, played = t.w + t.l, now = rating(pid), moved = now - p.seed;
  const hist = ratingHistory(), me = hist.series.find(x => x.id === pid), cur = currentPools(), cs = currentSession();
  const live = openSess() && openSess().status === "live" ? openSess() : null;
  /* every game with a score, oldest first; tonight's count for the lists but not for the rated totals */
  const games = [], partners = {}, rivals = {};
  const tally = (map, id, won) => { const o = map[id] || (map[id] = { w: 0, l: 0 }); if (won) o.w++; else o.l++; };
  for (const s of closed.concat(live ? [live] : [])) for (const pool of s.pools) for (const gid of (pool.rounds || []).flat()) {
    const g = s.games[gid];
    if (!g || g.status !== "done" || !(g.t1.includes(pid) || g.t2.includes(pid))) continue;
    const first = g.t1.includes(pid), mine = first ? g.t1 : g.t2, theirs = first ? g.t2 : g.t1, sf = first ? g.s1 : g.s2, sa = first ? g.s2 : g.s1, r = rated[gid];
    const row = { s, g, pool, partner: mine.find(x => x !== pid), theirs, sf, sa, won: sf > sa, prob: r ? (first ? r.p1 : 1 - r.p1) : null, change: r ? (first ? r.d1 : r.d2) : null };
    games.push(row);
    if (s.status !== "closed") continue;                 // a session in progress is listed, but every number above the lists is rated games only
    if (row.partner) tally(partners, row.partner, row.won);
    theirs.forEach(o => tally(rivals, o, row.won));
  }
  const done = games.filter(x => x.s.status === "closed");
  const nights = closed.map(c => ({ c, r: (recs[c.id] || {})[pid] })).filter(x => x.r);
  const gain = x => x.r.end - x.r.start, bestNight = nights.reduce((m, x) => (!m || gain(x) > gain(m) ? x : m), null), worstNight = nights.reduce((m, x) => (!m || gain(x) < gain(m) ? x : m), null);
  const upset = done.filter(x => x.won && x.prob !== null && x.prob <= 0.4).reduce((m, x) => (!m || x.prob < m.prob ? x : m), null);
  const plink = id => `<a class="plink" href="#/player/${id}">${esc(nm(id))}</a>`, pct = v => Math.round(v * 100) + "%";
  /* a box: go = { to: element id } scrolls to that part of this page; { kind, other } opens the list of exactly the games
     the box is about (with or against a person, the one-point games, a streak). Names inside a box are links to that
     person, so the box and the name are two different taps. */
  const tile = (k, v, d, n, go) => {
    const inner = `<span class="k">${k}</span><b class="v num">${v}</b><span class="d">${d}</span>${n ? `<span class="n">${n}</span>` : ""}`;
    const act = !go ? "" : go.kind ? `data-act="h2h" data-other="${go.other || ""}" data-kind="${go.kind}"` : `data-act="jump" data-to="${go.to}"`;
    return go ? `<div class="kpi tap" role="button" tabindex="0" ${act}>${inner}</div>` : `<div class="kpi">${inner}</div>`;
  };
  const names = ids => ids.map(id => `<a class="plink" href="#/player/${id}">${esc(sn(id))}</a>`).join(" / "), when = x => labels[x.s.id];
  const rec = o => `${o.w}-${o.l}`, rate = o => o.w / (o.w + o.l);
  const pick = (map, score, skip) => Object.keys(map).filter(id => id !== skip && score(map[id]) !== null).sort((a, b) => score(map[b]) - score(map[a]) || nm(a).localeCompare(nm(b)))[0];
  /* scores weigh the count first, then the rate, so 3-0 beats 1-0 and 0-3 is worse than 0-1 */
  const dream = pick(partners, o => (o.w ? o.w * 10 + rate(o) : null)), jinx = pick(partners, o => (o.l ? o.l * 10 - rate(o) : null), dream);
  const customer = pick(rivals, o => (o.w ? o.w * 10 + rate(o) : null)), nemesis = pick(rivals, o => (o.l ? o.l * 10 - rate(o) : null), customer);
  const most = (list, score) => list.reduce((m, x) => (!m || score(x) > score(m) ? x : m), null);
  const rout = most(done.filter(x => x.won), x => x.sf - x.sa), ouch = most(done.filter(x => !x.won), x => x.sa - x.sf);
  const banana = most(done.filter(x => !x.won && x.prob !== null && x.prob >= 0.6), x => x.prob);      // a real favourite, not a coin flip
  const tight = done.filter(x => Math.abs(x.sf - x.sa) === 1), tightW = tight.filter(x => x.won).length;
  let hot = [], cold = [], runNow = [];                  // the games of the longest winning and losing runs, in the order played
  done.forEach(x => {
    if (runNow.length && runNow[0].won !== x.won) runNow = [];
    runNow.push(x);
    if (x.won && runNow.length > hot.length) hot = runNow.slice();
    if (!x.won && runNow.length > cold.length) cold = runNow.slice();
  });
  const people = (map, title, note, kind) => {
    const rows = Object.keys(map).sort((a, b) => (map[b].w + map[b].l) - (map[a].w + map[a].l) || map[b].w - map[a].w || nm(a).localeCompare(nm(b)));
    return `<div class="card"><h2>${title}</h2><p class="muted small">${note}</p>${rows.length ? `<div class="scroll"><table><thead><tr><th>Player</th><th class="r">Games</th><th class="r">Won</th><th class="r">Lost</th><th class="r">Win rate</th></tr></thead><tbody>
      ${rows.map(id => `<tr><td>${plink(id)}</td><td class="r" data-v="${map[id].w + map[id].l}"><button class="linkbtn" data-act="h2h" data-other="${id}" data-kind="${kind}" aria-label="Show these games">${map[id].w + map[id].l}</button></td><td class="r">${map[id].w}</td><td class="r">${map[id].l}</td><td class="r">${pct(map[id].w / (map[id].w + map[id].l))}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">No games yet.</p>'}</div>`;
  };
  /* a name in a game list: the full name where there is room, first name and initial on a phone */
  const pl2 = id => `<a class="plink" href="#/player/${id}"><span class="nf">${esc(nm(id))}</span><span class="ns">${esc(sn(id))}</span></a>`;
  const gameTable = (rows, withSession, withIds) => `<table class="pg"><thead><tr>${withSession ? "<th>Session</th>" : ""}<th>Rd</th><th>Result</th><th>Partner</th><th>Opponents</th><th class="r">Win chance</th><th class="r">4DR</th></tr></thead><tbody>
    ${rows.map(x => `<tr${withIds ? ` id="p-g-${x.g.id}"` : ""}>${withSession ? `<td data-v="${closed.indexOf(x.s)}">${x.s.status === "closed" ? esc(labels[x.s.id]) : "in progress"}</td>` : ""}<td>${x.g.round + 1}</td>
      <td data-v="${x.sf - x.sa}"><b class="${x.won ? "wn" : "ls"}">${x.won ? "Won" : "Lost"}</b> ${x.sf}-${x.sa}</td><td>${x.partner ? pl2(x.partner) : ""}</td><td>${x.theirs.map(pl2).join(" / ")}</td>
      <td class="r">${x.prob === null ? "" : pct(x.prob)}</td><td class="r">${x.change === null ? "" : `<span class="${x.change < 0 ? "dn" : "up"}">${sgn(x.change)}</span>`}</td></tr>`).join("")}</tbody></table>`;
  /* the list a box opens: exactly the games that box is about */
  const listCard = () => {
    const h = app.h2h && app.h2h.owner === pid ? app.h2h : null, person = h && (h.kind === "with" || h.kind === "against");
    if (!h || (person && !app.st.players[h.other])) return "";
    const rows = h.kind === "with" ? done.filter(x => x.partner === h.other) : h.kind === "against" ? done.filter(x => x.theirs.includes(h.other)) : h.kind === "tight" ? tight : h.kind === "hot" ? hot : h.kind === "cold" ? cold : [];
    if (!rows.length) return "";
    const won = rows.filter(x => x.won).length;
    const title = h.kind === "with" ? `Games with ${plink(h.other)}` : h.kind === "against" ? `Games against ${plink(h.other)}` : h.kind === "tight" ? "Games decided by one point" : h.kind === "hot" ? `Hot streak: ${hot.length} wins in a row` : `Cold snap: ${cold.length} losses in a row`;
    const note = h.kind === "with" ? `Every rated game ${esc(sn(pid))} and ${esc(sn(h.other))} have played as partners.` : h.kind === "against" ? `Every rated game ${esc(sn(pid))} has played against ${esc(sn(h.other))}.`
      : h.kind === "tight" ? "Every rated game that finished one point apart." : "The longest run so far, in the order the games were played.";
    return `<div class="card" id="p-h2h"><div class="row spread"><h2>${title} <span class="muted num">${won}-${rows.length - won}</span></h2><button class="btn small" data-act="h2h" data-other="${h.other || ""}" data-kind="${h.kind}">Close ✕</button></div>
      <p class="muted small">${note}</p><div class="scroll">${gameTable(rows, true, false)}</div></div>`;
  };
  const bySession = [];
  games.forEach(x => { const last = bySession[bySession.length - 1]; if (last && last.s === x.s) last.rows.push(x); else bySession.push({ s: x.s, rows: [x] }); });
  return `${back}
    <div class="head"><h1>${esc(p.name)}</h1>
      <p class="muted">${p.active ? "" : "Dropped out · "}Ranked ${order.indexOf(pid) + 1} of ${order.length} · started at ${fmt(p.seed)}${cs && cur[pid] != null ? ` · ${cs.status === "live" ? "in" : "last in"} ${esc(cs.pools[cur[pid]].name)}` : ""}</p></div>
    <div class="kpis">
      ${tile("4DR", fmt(now), `rank ${order.indexOf(pid) + 1} of ${order.length}`, "", me && hist.labels.length > 1 ? { to: "p-chart" } : null)}
      ${tile("Since seeding", sgn(moved), `seeded ${fmt(p.seed)}`, "", nights.length ? { to: "p-sessions" } : null)}
      ${tile("Record", `${t.w}-${t.l}`, played ? `${pct(t.w / played)} of ${played} games won` : "no rated games yet", "", nights.length ? { to: "p-sessions" } : null)}
      ${tile("Points", `${t.pf}-${t.pa}`, `${t.pf - t.pa >= 0 ? "+" : "−"}${Math.abs(t.pf - t.pa)} difference`, "", nights.length ? { to: "p-sessions" } : null)}
      ${bestNight ? tile("Best night", sgn(gain(bestNight)), labels[bestNight.c.id], `${bestNight.r.w}-${bestNight.r.l}`, { to: "p-s-" + bestNight.c.id }) : ""}
      ${worstNight && nights.length > 1 ? tile("Toughest night", sgn(gain(worstNight)), labels[worstNight.c.id], `${worstNight.r.w}-${worstNight.r.l}`, { to: "p-s-" + worstNight.c.id }) : ""}
    </div>
    ${done.length ? `<h2 class="sub">Bragging rights and excuses</h2>
    <div class="kpis">
      ${dream ? tile("Dream team", rec(partners[dream]), `with ${plink(dream)}`, "most wins as partners", { other: dream, kind: "with" }) : ""}
      ${jinx ? tile("It's complicated", rec(partners[jinx]), `with ${plink(jinx)}`, "most losses as partners. Blame the wind.", { other: jinx, kind: "with" }) : ""}
      ${customer ? tile("Favourite customer", rec(rivals[customer]), `against ${plink(customer)}`, "beaten more than anyone else", { other: customer, kind: "against" }) : ""}
      ${nemesis ? tile("Nemesis", rec(rivals[nemesis]), `against ${plink(nemesis)}`, "lost to them more than to anyone else", { other: nemesis, kind: "against" }) : ""}
      ${upset ? tile("Giant killing", pct(upset.prob), `chance of beating ${names(upset.theirs)}`, `won ${upset.sf}-${upset.sa}${upset.partner ? " with " + names([upset.partner]) : ""}, ${when(upset)}`, { to: "p-g-" + upset.g.id }) : ""}
      ${banana ? tile("Banana skin", pct(banana.prob), `chance of beating ${names(banana.theirs)}`, `lost ${banana.sf}-${banana.sa} anyway, ${when(banana)}`, { to: "p-g-" + banana.g.id }) : ""}
      ${rout ? tile(rout.sa === 0 ? "Bagel served" : "Demolition job", `${rout.sf}-${rout.sa}`, `against ${names(rout.theirs)}`, `biggest win, ${when(rout)}`, { to: "p-g-" + rout.g.id }) : ""}
      ${ouch ? tile(ouch.sf === 0 ? "Bagel eaten" : "Ouch", `${ouch.sf}-${ouch.sa}`, `against ${names(ouch.theirs)}`, `heaviest defeat, ${when(ouch)}. We do not talk about it.`, { to: "p-g-" + ouch.g.id }) : ""}
      ${tight.length ? tile("Nail-biters", `${tightW}-${tight.length - tightW}`, "in games decided by one point", tightW * 2 > tight.length ? "ice in the veins" : tightW * 2 < tight.length ? "so close, so often" : "could go either way", { kind: "tight" }) : ""}
      ${hot.length > 1 ? tile("Hot streak", hot.length, "wins in a row", "the longest run so far", { kind: "hot" }) : ""}
      ${cold.length > 1 ? tile("Cold snap", cold.length, "losses in a row", "it was probably the balls", { kind: "cold" }) : ""}
    </div>` : ""}
    ${listCard()}
    ${me && hist.labels.length > 1 ? `<div class="card chartcard" id="p-chart"><h2>4DR after each session</h2>${ratingChart(hist, [{ id: pid, slot: 1 }])}
      <p class="muted small">A coloured line is a session played. A grey dotted line is a week missed, where the rating carries over.</p></div>` : ""}
    ${nights.length ? `<div class="card" id="p-sessions"><h2>Session by session</h2><div class="scroll"><table><thead><tr><th>Session</th><th>Pool</th><th class="r">W-L</th><th class="r">Points</th><th class="r">Change</th><th class="r">4DR</th></tr></thead><tbody>
      <tr class="off"><td>Start</td><td colspan="4">seeded</td><td class="r">${fmt(p.seed)}</td></tr>
      ${closed.map(c => { const r = (recs[c.id] || {})[pid], pool = r && c.pools.find(q => q.id === r.pool);
        return r ? `<tr><td data-v="${closed.indexOf(c)}">${esc(labels[c.id])}</td><td>${esc(pool ? pool.name : "")}</td><td class="r">${r.w}-${r.l}</td><td class="r">${r.pf}-${r.pa}</td><td class="r"><span class="${r.end < r.start ? "dn" : "up"}">${sgn(r.end - r.start)}</span></td><td class="r"><b>${fmt(r.end)}</b></td></tr>`
          : `<tr class="off"><td>${esc(labels[c.id])}</td><td colspan="5">did not play</td></tr>`; }).join("")}</tbody></table></div></div>` : ""}
    <div class="pools">${people(partners, "Partners", "How this player has done with each partner. Tap a name for that player, or the games count for the games.", "with")}${people(rivals, "Opponents", "How this player has done against each opponent. Tap a name for that player, or the games count for the games.", "against")}</div>
    ${bySession.length ? bySession.slice().reverse().map(({ s, rows }) => { const r = (recs[s.id] || {})[pid], won = rows.filter(x => x.won).length;
      return `<div class="card" id="p-s-${s.id}"><div class="row spread"><h2>${s.status === "closed" ? esc(labels[s.id]) : niceDate(s.date) + " (in progress)"} <span class="muted num">${esc(rows[0].pool.name)} · ${won}-${rows.length - won}</span></h2>
          ${r ? `<span class="num"><span class="${r.end < r.start ? "dn" : "up"}">${sgn(r.end - r.start)}</span> to <b>${fmt(r.end)}</b></span>` : '<span class="muted small">not rated or counted above until the session is finished</span>'}</div>
        <div class="scroll">${gameTable(rows, false, true)}</div></div>`; }).join("")
      : '<p class="muted">No games played yet.</p>'}
    ${done.some(x => x.prob !== null) ? '<p class="muted small">Win chance is what the ratings gave this pair going into the game, and Rating is what the game was worth, both averaged over every order the night\'s rounds could have been played in.</p>' : ""}`;
}

/* ---------- Rating history ---------- *//* ---------- Rating history ---------- */
/* Rating after each finished session, per player. A missed week carries the rating forward. */
function ratingHistory() {
  const closed = closedSess(), recs = app.st.ratings.sessions;
  const names = sessLabels(), labels = ["Start"].concat(closed.map(s => names[s.id]));   // two sessions on one day stay apart
  const series = Object.keys(app.st.players).map(id => {
    let v = P(id).seed, any = false;
    const vals = [v], played = [false];
    closed.forEach(s => { const r = (recs[s.id] || {})[id]; if (r) { v = r.end; any = true; } vals.push(v); played.push(!!r); });
    return { id, vals, played, any, from: Math.max(0, played.indexOf(true) - 1) };      // from: the point their line starts at
  }).filter(x => x.any);
  return { labels, series };
}
/* The pools as they stand now: the live session's, else the last finished session's. 0 is Pool A.
   A player who was not in that session has no current pool. */
const currentSession = standSession;
function currentPools() {
  const out = {}, s = currentSession();
  if (s) s.pools.forEach((p, k) => p.players.forEach(id => { out[id] = k; }));
  return out;
}
/* Sixteen identities: eight hues, solid then dashed. Anyone past that is drawn plain grey. */
const MAX_COLOURS = 16;
const slotColour = k => (k ? `var(--c${(k - 1) % 8 + 1})` : "var(--line-2)");
const swatch = h => `<i class="lsw${h && h.slot > 8 ? " dash" : ""}" ${h ? `style="--k:${slotColour(h.slot)}"` : ""}></i>`;
/* Players matching both pool filters, best rating first. An empty filter means any pool.
   Players who were already on keep their colour; newcomers take the free ones. */
function selFor(hist, starts, nows, prev) {
  const cur = currentPools(), keep = Object.fromEntries((prev || []).map(h => [h.id, h.slot]));
  const ids = hist.series.filter(x => (!starts.length || starts.includes(seedLevel(x.id))) && (!nows.length || nows.includes(cur[x.id])))
    .sort((a, b) => rating(b.id) - rating(a.id)).map(x => x.id);
  const used = new Set(ids.map(id => keep[id]).filter(Boolean));
  const next = () => { for (let k = 1; k <= MAX_COLOURS; k++) if (!used.has(k)) { used.add(k); return k; } return 0; };
  return ids.map(id => ({ id, slot: keep[id] || 0 })).map(h => (h.slot ? h : { id: h.id, slot: next() }));
}
/* The players switched on. Until someone chooses, whoever is in Pool A now.
   When a session is added, finished, reopened or deleted, or its pools change, the pool filters are applied again
   so "Pool A" always means the Pool A on screen. A hand-picked set (one player from the Ratings tab, or All off) is left alone. */
function selection(hist) {
  const cs = currentSession(), cur = currentPools();
  const sig = [cs ? cs.id + cs.status : "", cs ? cs.pools.map(p => p.players.join(",")).join("|") : "", hist.labels.length, hist.series.length].join("#");
  if (!app.hs) app.hs = { start: [], now: hist.series.some(x => cur[x.id] === 0) ? [0] : [], custom: false, on: null };
  if (app.hs.sig !== sig) {
    if (app.hs.sig !== undefined && !app.hs.custom) {
      const starts = new Set(hist.series.map(x => seedLevel(x.id))), nows = new Set(hist.series.map(x => cur[x.id]));
      app.hs.start = app.hs.start.filter(k => starts.has(k)); app.hs.now = app.hs.now.filter(k => nows.has(k));
      if (!app.hs.start.length && !app.hs.now.length && nows.has(0)) app.hs.now = [0];      // the filter fell away with the session: back to Pool A
      app.hs.prev = app.hs.on; app.hs.on = null;
    }
    app.hs.sig = sig;
  }
  if (!app.hs.on) { app.hs.on = selFor(hist, app.hs.start, app.hs.now, app.hs.prev); app.hs.prev = null; }
  const ok = new Set(hist.series.map(x => x.id));
  return app.hs.on.filter(h => ok.has(h.id));
}
/* Switch one player on or off. Everyone else keeps their colour. */
function togglePlayer(pid, onlyOn) {
  const on = (app.hs && app.hs.on) || [], at = on.findIndex(h => h.id === pid);
  const free = () => { const used = new Set(on.map(h => h.slot)); for (let k = 1; k <= MAX_COLOURS; k++) if (!used.has(k)) return k; return 0; };
  if (at < 0) on.push({ id: pid, slot: free() });
  else if (!onlyOn) { on.splice(at, 1); const grey = on.find(h => !h.slot); if (grey) grey.slot = free(); }
  app.hs = Object.assign(app.hs || { start: [], now: [], custom: true }, { on });
  render();
}
function historyView(hist) {
  const n = hist.labels.length, closed = closedSess(), recs = app.st.ratings.sessions;
  const on = selection(hist), byId = Object.fromEntries(hist.series.map(x => [x.id, x])), slotOf = Object.fromEntries(on.map(h => [h.id, h]));
  const best = fn => hist.series.reduce((m, x) => (m === null || fn(x) > fn(m) ? x : m), null);
  const total = x => x.vals[n - 1] - x.vals[0], lastMove = x => (x.played[n - 1] ? x.vals[n - 1] - x.vals[n - 2] : -1e9);
  const tile = (k, x, v, note) => (x ? `<button class="kpi" data-act="hon" data-pid="${x.id}"><span class="k">${k}</span><b class="v num">${v}</b><span class="d">${esc(nm(x.id))}</span><span class="n">${note}</span></button>` : "");
  const top = best(x => x.vals[n - 1]), climb = best(total), fall = best(x => -total(x)), week = best(lastMove), weekDown = best(x => (x.played[n - 1] ? x.vals[n - 2] - x.vals[n - 1] : -1e9));
  const cur = currentPools(), letter = k => (k == null ? "–" : String.fromCharCode(65 + k)), cs = currentSession();
  const when = cs ? sessWhen(cs) : "", nowLabel = cs ? (when === "tonight" ? "Pool tonight" : "Pool " + when) : "Pool now";
  const starts = [...new Set(hist.series.map(x => seedLevel(x.id)))].sort(), nows = [...new Set(hist.series.map(x => cur[x.id]).filter(k => k != null))].sort();
  const seg = (kind, label, opts, vals) => `<span class="row fl"><span class="muted small">${label}</span><span class="seg slim multi" role="group" aria-label="${label}">
    <button data-act="hfilter" data-kind="${kind}" data-v="all" aria-pressed="${!app.hs.custom && !vals.length}">Any</button>${opts.map(k => `<button data-act="hfilter" data-kind="${kind}" data-v="${k}" aria-pressed="${!app.hs.custom && vals.includes(k)}">${letter(k)}</button>`).join("")}</span></span>`;
  const ranked = hist.series.slice().sort((a, b) => rating(b.id) - rating(a.id) || nm(a.id).localeCompare(nm(b.id)));
  const shown = on.slice().sort((a, b) => rating(b.id) - rating(a.id)), greys = on.filter(h => !h.slot).length;
  return `<div class="kpis">
      ${tile("Top rating", top, fmt(top.vals[n - 1]), "now")}
      ${tile("Biggest climb", climb, sgn(total(climb)), "since seeding")}
      ${tile("Biggest fall", fall, sgn(total(fall)), "since seeding")}
      ${hist.series.some(x => x.played[n - 1]) ? tile("Best night", week, sgn(week.vals[n - 1] - week.vals[n - 2]), esc(hist.labels[n - 1])) + tile("Toughest night", weekDown, sgn(weekDown.vals[n - 1] - weekDown.vals[n - 2]), esc(hist.labels[n - 1])) : ""}
    </div>
    <div class="card chartcard"><div class="row spread"><h2>4DR after each session</h2>
        <span class="row filters">${seg("start", "Started in pool", starts, app.hs.start)}${seg("now", nowLabel, nows, app.hs.now)}</span></div>
      ${ratingChart(hist, shown)}
      <p class="muted small">A coloured line is a session played. A grey dotted line is a week missed, where the rating carries over. Switch on any mix of pools in each filter: a player shows when they match both.${greys ? ` Only ${MAX_COLOURS} players can have a colour: the other ${greys} are plain grey.` : ""}</p>
      <div class="row spread"><h3>Players <span class="muted num">${on.length} of ${hist.series.length} shown</span></h3>
        <span class="row"><button class="btn small" data-act="hall" data-on="1">All on</button><button class="btn small" data-act="hall" data-on="">All off</button></span></div>
      <p class="muted small">Tap a player to switch their line on or off. B › A means started in Pool B and ${cs && cs.status === "live" ? "is" : "played"} in Pool A ${when}. A dash means they were not there.</p>
      <div class="plist">${ranked.map(x => `<button class="pchip" data-act="hl" data-pid="${x.id}" aria-pressed="${!!slotOf[x.id]}">${swatch(slotOf[x.id])}<span class="pn">${esc(nm(x.id))}</span><small>${letter(seedLevel(x.id))} › ${letter(cur[x.id])}</small><b class="num">${fmt(x.vals[n - 1])}</b></button>`).join("")}</div></div>
    ${shown.length ? `<div class="card"><h2>Week by week</h2>
      <div class="scroll"><table class="wk"><thead><tr><th>Player</th><th class="r">Start</th>${closed.map((c, i) => `<th class="r">${esc(hist.labels[i + 1])}</th>`).join("")}<th class="r">Since start</th></tr></thead><tbody>
        ${shown.map(h => {
          const x = byId[h.id];
          return `<tr><td>${swatch(h)}<a class="plink" href="#/player/${h.id}">${esc(nm(h.id))}</a></td><td class="r">${fmt(x.vals[0])}</td>${closed.map(c => {
            const r = (recs[c.id] || {})[h.id], pool = r && c.pools.find(q => q.id === r.pool);
            return r ? `<td class="r"><b>${fmt(r.end)}</b><small><span class="${r.end < r.start ? "dn" : "up"}">${sgn(r.end - r.start)}</span> · ${r.w}-${r.l}${pool ? " · " + esc(pool.name.replace(/^Pool /, "")) : ""}</small></td>` : '<td class="r muted">did not play</td>';
          }).join("")}<td class="r"><span class="${total(x) < 0 ? "dn" : "up"}">${sgn(total(x))}</span></td></tr>`;
        }).join("")}</tbody></table></div>
      <p class="muted small">Under each rating: change on the night, wins and losses, pool played in.</p></div>` : ""}`;
}
function ratingChart(hist, shown) {
  const n = hist.labels.length, byId = Object.fromEntries(hist.series.map(x => [x.id, x]));
  if (!shown.length) { app.chart = null; return '<div class="chartbox empty"><p class="muted">No players switched on. Choose a pool above or tap players below.</p></div>'; }
  const W = Math.max(280, Math.min(1400, document.documentElement.clientWidth) - 54), narrow = W < 560, H = narrow ? 340 : 460;
  const m = { l: 40, r: narrow ? 126 : 136, t: 12, b: 28 };
  const all = shown.flatMap(h => byId[h.id].vals), lo = Math.floor((Math.min(...all) - 15) / 100) * 100, hi = Math.ceil((Math.max(...all) + 15) / 100) * 100;
  const X = i => m.l + (W - m.l - m.r) * i / (n - 1), Y = v => m.t + (H - m.t - m.b) * (hi - v) / (hi - lo), f = v => v.toFixed(1);
  const step = hi - lo > 900 ? 200 : 100, ticks = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);
  /* one path for the sessions played, one for the weeks missed, and a dot wherever a played stretch starts or ends */
  const parts = h => {
    const x = byId[h.id], dots = new Set();
    let live = "", idle = "";
    for (let i = x.from + 1; i < n; i++) {
      const d = `M${f(X(i - 1))} ${f(Y(x.vals[i - 1]))}L${f(X(i))} ${f(Y(x.vals[i]))}`;
      if (x.played[i]) { live += d; dots.add(i - 1); dots.add(i); } else idle += d;
    }
    return { h, x, live, idle, dots: [...dots] };
  };
  const drawn = shown.map(parts), gap = shown.length > 8 ? 16 : 19, labelled = shown.length * gap <= H - m.t - m.b;
  /* direct labels at the line ends, pushed apart so they never overlap */
  const ends = labelled ? drawn.map(d => ({ d, y: Y(d.x.vals[n - 1]) })).sort((a, b) => a.y - b.y) : [];
  ends.forEach((e, i) => { e.ly = i ? Math.max(e.y, ends[i - 1].ly + gap) : Math.max(e.y, m.t + 4); });
  for (let i = ends.length - 1; i >= 0; i--) { const cap = i === ends.length - 1 ? H - m.b : ends[i + 1].ly - gap; if (ends[i].ly > cap) ends[i].ly = cap; }
  app.chart = { xs: hist.labels.map((_, i) => X(i)), lo, hi, top: m.t, bottom: H - m.b, hist: { labels: hist.labels, series: drawn.map(d => d.x) }, slots: Object.fromEntries(shown.map(h => [h.id, h])) };
  return `<div class="chartbox"><svg class="rchart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart of the chosen players' ratings after each session. The same numbers are in the week by week table below.">
      ${ticks.map(v => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${f(Y(v))}" y2="${f(Y(v))}"/><text class="ax" x="${m.l - 8}" y="${f(Y(v) + 4)}" text-anchor="end">${(v / 1000).toFixed(1)}</text>`).join("")}
      ${hist.labels.map((l, i) => `<text class="ax" x="${f(X(i))}" y="${H - 8}" text-anchor="${i === 0 ? "start" : "middle"}">${esc(l)}</text>`).join("")}
      <line class="xh" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
      ${drawn.map(d => (d.idle ? `<path class="ln idle" d="${d.idle}"/>` : "")).join("")}
      ${drawn.filter(d => !d.h.slot && d.live).map(d => `<path class="ln rest" d="${d.live}"/>`).join("")}
      ${drawn.filter(d => d.h.slot).reverse().map(d => `${d.live ? `<path class="ln on${d.h.slot > 8 ? " dash" : ""}" style="stroke:${slotColour(d.h.slot)}" d="${d.live}"/>` : ""}${d.dots.map(i => `<circle class="pt" style="fill:${slotColour(d.h.slot)}" cx="${f(X(i))}" cy="${f(Y(d.x.vals[i]))}" r="${shown.length > 8 ? 3.5 : 4.5}"/>`).join("")}`).join("")}
      ${ends.map(e => `${Math.abs(e.ly - e.y) > 3 ? `<line class="lead" style="stroke:${slotColour(e.d.h.slot)}" x1="${f(X(n - 1) + 6)}" y1="${f(e.y)}" x2="${f(X(n - 1) + 12)}" y2="${f(e.ly)}"/>` : ""}<text class="el${gap < 19 || narrow ? " sm" : ""}" x="${f(X(n - 1) + 15)}" y="${f(e.ly + 4.5)}">${esc(sn(e.d.h.id))} <tspan class="ev">${fmt(e.d.x.vals[n - 1])}</tspan></text>`).join("")}
    </svg><div class="tip" hidden></div></div>`;
}
/* Hover and tap on the chart: a crosshair at the nearest session and the ratings there, the line under the pointer in bold. */
function chartProbe(e) {
  const svg = e.target.closest ? e.target.closest(".rchart") : null, c = app.chart;
  if (!svg || !c) return null;
  const box = svg.getBoundingClientRect(), px = e.clientX - box.left, py = e.clientY - box.top, xs = c.xs, last = xs.length - 1;
  if (px < xs[0] - 24 || px > xs[last] + 24 || py < c.top - 10 || py > c.bottom + 10) return null;
  let i = 0;
  xs.forEach((x, k) => { if (Math.abs(x - px) < Math.abs(xs[i] - px)) i = k; });
  const k = Math.max(0, Math.min(last - 1, xs.findIndex((x, j) => j < last && px <= xs[j + 1]))), t = Math.max(0, Math.min(1, (px - xs[k]) / (xs[k + 1] - xs[k])));
  const Y = v => c.top + (c.bottom - c.top) * (c.hi - v) / (c.hi - c.lo);
  let near = null, best = 14;
  for (const x of c.hist.series) { if (k < (x.from || 0)) continue; const d = Math.abs(Y(x.vals[k] + (x.vals[k + 1] - x.vals[k]) * t) - py); if (d < best) { best = d; near = x.id; } }
  return { svg, i, near, px, py, width: box.width, yOf: v => Y(v) };
}
function chartTip(e) {
  const p = chartProbe(e), old = $(".chartbox .tip");
  if (!p) { if (old && !old.hidden) { old.hidden = true; $(".rchart .xh").setAttribute("visibility", "hidden"); } return; }
  const c = app.chart, tip = $(".tip", p.svg.parentNode), xh = $(".xh", p.svg), LIMIT = 12;
  /* with a crowd on screen, list the lines closest to the pointer */
  let rows = c.hist.series.slice().sort((a, b) => Math.abs(p.yOf(a.vals[p.i]) - p.py) - Math.abs(p.yOf(b.vals[p.i]) - p.py));
  const more = Math.max(0, rows.length - LIMIT);
  rows = rows.slice(0, LIMIT).sort((a, b) => b.vals[p.i] - a.vals[p.i]);
  const row = x => {
    const v = x.vals[p.i], ch = p.i < (x.from || 0) ? "not playing yet" : p.i ? (x.played[p.i] ? sgn(v - x.vals[p.i - 1]) : "did not play") : "seed";
    return `<span class="tr${x.id === p.near ? " near" : ""}">${swatch(c.slots[x.id])}<span>${esc(sn(x.id))}</span><b>${fmt(v)}</b><em>${ch}</em></span>`;
  };
  tip.innerHTML = `<strong>${p.i ? "After " : ""}${esc(c.hist.labels[p.i])}</strong>${rows.map(row).join("")}${more ? `<span class="muted">and ${more} more</span>` : ""}`;
  tip.hidden = false;
  xh.setAttribute("x1", c.xs[p.i]); xh.setAttribute("x2", c.xs[p.i]); xh.setAttribute("visibility", "visible");
  const left = p.px > p.width / 2;
  tip.style.left = left ? "" : `${p.px + 14}px`; tip.style.right = left ? `${p.width - p.px + 14}px` : "";
  tip.style.top = `${Math.max(0, Math.min(p.py - 20, c.bottom - tip.offsetHeight))}px`;
}

/* ---------- Organiser ---------- */
function viewOrg(sub, arg) {
  if (!isOrg()) return orgGate();
  const tabs = [["", "Session"], ["players", "Players"], ["history", "History"], ["settings", "Settings"]];
  const head = `<div class="row spread"><h1>Organiser</h1>${app.be.orgMode === "open" ? "" : `<button class="btn small" data-act="lock">${app.be.orgMode === "pin" ? "Lock" : "Sign out"}</button>`}</div>
    ${app.be.orgMode === "open" && app.be.kind !== "local" ? '<p class="note"><b>No login for now.</b> Anyone with the link can use the organiser tools on this page. An organiser login can be added later.</p>' : ""}
    <div class="tabs">${tabs.map(([k, l]) => `<a class="btn small ${(sub || "") === k ? "primary" : ""}" href="#/org${k ? "/" + k : ""}">${l}</a>`).join("")}</div>`;
  const body = sub === "players" ? orgPlayers() : sub === "history" ? orgHistory(arg) : sub === "settings" ? orgSettings() : orgSession();
  return head + body;
}

function orgGate() {
  const be = app.be;
  if (be.orgMode === "pin") {
    return `<div class="head"><h1>Organiser</h1><p class="muted">Enter the organiser PIN to manage players, pools and sessions.</p></div>
      <form class="card" data-form="pin" style="max-width:420px">
        <label class="field">PIN<input id="pin" type="password" inputmode="numeric" autocomplete="off" value="${esc(app.form.pin || "")}"></label>
        ${errLine("pin")}
        <button class="btn primary" type="submit">Unlock</button>
      </form>`;
  }
  if (be.signedInNotOrganiser()) {
    return `<div class="head"><h1>Organiser</h1><p class="muted">This account is not the organiser of this league.</p></div><div class="row"><button class="btn" data-act="lock">Sign out</button></div>`;
  }
  const create = !be.hasOrganiser();
  return `<div class="head"><h1>Organiser</h1><p class="muted">${create ? "Create the organiser account for this league. Only this account can manage players, pools and sessions." : "Sign in to manage players, pools and sessions."}</p></div>
    <form class="card" data-form="${create ? "createorg" : "signin"}" style="max-width:420px">
      <label class="field">Email<input id="email" type="email" autocomplete="username" value="${esc(app.form.email || "")}"></label>
      <label class="field">Password<input id="password" type="password" autocomplete="${create ? "new-password" : "current-password"}" value="${esc(app.form.password || "")}"></label>
      ${errLine("pin")}
      <button class="btn primary" type="submit">${create ? "Create organiser account" : "Sign in"}</button>
    </form>`;
}

function seedOptions(id) {
  const seeds = app.st.league.seeds, cur = app.form[id] ?? String(seeds[seeds.length - 1] / 1000);
  return `<select id="${id}">${seeds.map((v, i) => `<option value="${v / 1000}" ${String(v / 1000) === cur ? "selected" : ""}>${(v / 1000).toFixed(1)}</option>`).join("")}</select>`;
}

function orgSession() {
  const s = openSess();
  if (!s) {
    const last = closedSess().pop();
    let def = todayIso();                         // a week after the last session, but never a day already gone
    if (last) { const d = new Date(last.date + "T00:00"); d.setDate(d.getDate() + 7); const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; if (next > def) def = next; }
    def = app.form.newdate || def;
    const clash = closedSess().some(x => x.date === def);
    const far = (new Date(def + "T00:00") - new Date(todayIso() + "T00:00")) / 864e5 > 60;
    return `<form class="card" data-form="create"><h2>New session</h2>
      <p class="muted">Starts with the players who came last time. You can change who is playing next.</p>
      <div class="row"><label class="field">Date<input id="newdate" type="date" value="${esc(def)}" ${last ? `min="${last.date}"` : ""}></label></div>
      ${clash ? `<p class="note warn">⚠ There is already a finished session on ${dayMonth(def)}. A second one will be listed as ${dayMonth(def)} (2).</p>` : ""}
      ${far ? `<p class="note warn">⚠ ${dayMonth(def)} ${def.slice(0, 4)} is more than two months away. Check the month and year.</p>` : ""}
      ${errLine("session")}<button class="btn primary" type="submit">Create session</button></form>`;
  }
  return s.status === "setup" ? orgSetup(s) : orgLive(s);
}

/* Players who break the rating order between pools: the fewest who would have to move for every pool to outrank the one below it. */
function outOfOrder(s) {
  const seq = s.pools.flatMap((p, k) => p.players.slice().sort((a, b) => rating(b) - rating(a)).map(id => ({ id, k, r: rating(id) })));
  const n = seq.length, len = new Array(n).fill(1), prev = new Array(n).fill(-1);
  let best = -1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) if (seq[j].r >= seq[i].r && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    if (best < 0 || len[i] > len[best]) best = i;
  }
  const keep = new Set();
  for (let i = best; i >= 0; i = prev[i]) keep.add(seq[i].id);
  /* high: someone in a lower pool is rated above them, so they sit higher than their rating says */
  return seq.filter(x => !keep.has(x.id)).map(x => ({ id: x.id, pool: s.pools[x.k], high: seq.some(y => y.k > x.k && y.r > x.r) }));
}

/* What a pool of n players will play: rounds, games a round, games each. */
function poolPlan(n, courts) {
  if (n < Ladder.MIN_POOL || n > Ladder.MAX_POOL) return null;
  const per = Math.floor(n / 4), rounds = Ladder.roundCount(n), each = Math.round(rounds * per * 4 / n);
  const warn = per > (courts || 1) && per > 2 ? "Three games a round: give this pool 3 courts, or it will run long."
    : rounds > 9 ? `${rounds} rounds${per < 2 ? ", one game at a time" : ""}. A pool of eight plays 7 and a pool of nine plays 9, so this pool will finish later.` : "";
  return { per, rounds, each, warn, text: `${rounds} rounds of ${per} game${per > 1 ? "s" : ""}, ${each} games each` };
}
/* Everything worth a warning about one pool before the start: its rounds and courts, and a night much longer than the other pools'. */
function poolWarn(s, p) {
  const plan = poolPlan(p.players.length, p.courts);
  if (!plan) return "";
  const play = q => Ladder.roundCount(q.players.length) * targetFor(s, q);
  const others = s.pools.filter(q => q !== p && q.players.length >= 8 && q.players.length <= Ladder.MAX_POOL).map(play);
  const ref = others.length ? Math.max(...others) : 0, mine = play(p);
  const long = ref && mine > ref * 1.25 ? `${mine} points of play against ${ref} in the longest of the other pools: about ${Math.round(mine / ref * 100 - 100)}% longer${p.target ? ", because its target was set by hand" : ""}.` : "";
  return [plan.warn, long].filter(Boolean).join(" ");
}
/* What a pool plays to, and whether that was chosen by hand. */
const targetFor = (s, p) => Ladder.poolTarget(app.st, s, p);
/* " · to 15", shown beside the round wherever pools on the night play to different targets or not to the league's own */
function targetTag(s, p) {
  const all = s.pools.map(q => targetFor(s, q));
  return all.some(t => t !== all[0]) || all[0] !== app.st.league.pointsToWin ? ` · to ${targetFor(s, p)}` : "";
}

function orgSetup(s) {
  const q = (app.form.q || "").toLowerCase();
  const active = Object.values(app.st.players).filter(p => p.active).sort((a, b) => a.name.localeCompare(b.name));
  const inSet = new Set(s.attending), placed = new Set(s.pools.flatMap(p => p.players));
  const loose = s.attending.filter(p => !placed.has(p));
  const sel = app.sel && inSet.has(app.sel) ? app.sel : null;
  const games = n => (n >= 4 && n <= 12 ? null : "needs 4 to 12 players");
  const sizes = s.pools.map(p => p.players.length), att = s.attending.length, minP = Math.max(1, Math.ceil(att / Ladder.MAX_POOL)), maxP = Math.max(1, Math.floor(att / Ladder.MIN_POOL));
  const odd = Object.fromEntries(outOfOrder(s).map(o => [o.id, o])), oddN = Object.keys(odd).length;
  /* pools no longer look like a fresh assignment: players moved, or a target or a court count set by hand (re-assigning drops those too) */
  const hand = s.pools.length > 0 && (oddN > 0 || Math.max(...sizes) - Math.min(...sizes) > 1 || s.pools.some(p => p.target || p.courtsHand));
  const pl = (id, i) => `<li><button class="pl${odd[id] ? " out" : ""}" data-drag data-act="pick" data-pid="${id}" aria-pressed="${sel === id}"><span class="rk">${i === null ? "" : i + 1}</span><span class="nm">${fitName(id)}${odd[id] ? `<small>⚠ ${odd[id].high ? "higher" : "lower"} than their rating</small>` : ""}</span><span class="rt">${fmt(rating(id))}</span><span class="grip" data-grip aria-hidden="true">⠿</span></button></li>`;
  return `
  <div class="row spread"><h2>${niceDate(s.date)}</h2>
    ${app.confirm === "delete" ? `<span class="row"><button class="btn small danger" data-act="delete" data-sid="${s.id}">Yes, delete it</button><button class="btn small" data-act="cancel">Keep</button></span>` : `<button class="btn small" data-act="ask" data-key="delete">Delete session</button>`}</div>

  <div class="card"><div class="row spread"><h2>1. Who is playing <span class="muted num">(${s.attending.length})</span></h2>
      <span class="row">${closedSess().length ? `<button class="btn small" data-act="attendAll" data-sid="${s.id}" data-last="1">Same as last week</button>` : ""}<button class="btn small" data-act="attendAll" data-sid="${s.id}" data-on="1">Everyone</button><button class="btn small" data-act="attendAll" data-sid="${s.id}" data-on="">No one</button></span></div>
    <input id="q" type="search" placeholder="Find a player" value="${esc(app.form.q || "")}" aria-label="Find a player">
    <div class="chips">${active.filter(p => !q || p.name.toLowerCase().includes(q)).map(p => `<button class="chip" data-act="attend" data-sid="${s.id}" data-pid="${p.id}" aria-pressed="${inSet.has(p.id)}"><i>✓</i><span>${esc(p.name)}</span></button>`).join("") || '<p class="muted">No player matches.</p>'}</div>
    <form class="row" data-form="addplayer" data-sid="${s.id}" style="align-items:flex-end">
      <label class="field">New player's name<input id="newname" type="text" autocomplete="off" value="${esc(app.form.newname || "")}"></label>
      <label class="field">Starting level${seedOptions("newseed")}</label>
      <button class="btn" type="submit">Add player</button>
    </form>${errLine("attend")}</div>

  <div class="card"><div class="row spread"><h2>2. Pools</h2>
      <span class="row">${s.pools.length ? `<button class="btn small" data-act="${hand ? "ask" : "assign"}" data-key="assign:${s.pools.length - 1}" data-sid="${s.id}" data-pools="${s.pools.length - 1}" aria-label="One pool fewer" ${s.pools.length - 1 < minP ? `disabled title="A pool can have at most ${Ladder.MAX_POOL} players"` : ""}>−</button><span class="num">${s.pools.length} pools</span><button class="btn small" data-act="${hand ? "ask" : "assign"}" data-key="assign:${s.pools.length + 1}" data-sid="${s.id}" data-pools="${s.pools.length + 1}" aria-label="One pool more" ${s.pools.length + 1 > maxP ? `disabled title="A pool needs at least ${Ladder.MIN_POOL} players"` : ""}>+</button>` : ""}
      <button class="btn ${s.pools.length ? "small" : "primary"}" data-act="${hand ? "ask" : "assign"}" data-key="assign:" data-sid="${s.id}">${s.pools.length ? "Re-assign by rating" : "Assign pools by rating"}</button></span></div>
    ${(app.confirm || "").startsWith("assign:") ? `<div class="note warn"><b>Re-assigning puts everyone back in rating order</b> and drops the changes made by hand, including game targets and court counts.
      <div class="row" style="margin-top:8px"><button class="btn small primary" data-act="assign" data-sid="${s.id}" data-pools="${esc(app.confirm.slice(7))}">Yes, re-assign</button><button class="btn small" data-act="cancel">Keep my changes</button></div></div>` : ""}
    <p class="muted">${s.pools.length ? "Drag a player to another pool. On a touch screen, drag by the ⠿ handle on the right of their row. Or tap a player and choose where to move them." : "Players are ranked by 4DR and split into pools of eight or nine, two courts each. You can move anyone afterwards."}</p>
    ${s.pools.length ? `<p class="muted small">Games are first to ${Ladder.targetChoices(app.st.league.pointsToWin).join(", ").replace(/, ([^,]*)$/, " or $1")}. Left on automatic, a pool with fewer rounds plays longer games so that every pool finishes at about the same time: "points of play" is rounds times the target. The score bonus in the 4DR is scaled, so a game to 15 or 21 is worth the same as a game to 11.</p>` : ""}
    ${oddN ? `<p class="note warn">⚠ <b>${oddN === 1 ? "1 player is" : oddN + " players are"} out of rating order</b>, shown in yellow. You can still start: you will be asked to confirm.</p>` : ""}
    ${loose.length ? `<div class="pool warn" data-drop="none"><h3>Not in a pool yet (${loose.length})</h3><ol>${loose.map(id => pl(id, null)).join("")}</ol></div>` : ""}
    <div class="pools dz">${s.pools.map(p => {
      const n = p.players.length, bad = games(n), plan = poolPlan(n, p.courts), warn = poolWarn(s, p);
      return `<div class="pool ${bad ? "warn" : ""}" data-drop="${p.id}">
        <div class="row spread"><h3>${esc(p.name)} <span class="muted num">(${n})</span></h3>
          <span class="seg" role="group" aria-label="${esc(p.name)} courts">${(n >= 12 || p.courts === 3 ? [1, 2, 3] : [1, 2]).map(k => `<button data-act="courts" data-sid="${s.id}" data-pool="${p.id}" data-courts="${k}" aria-pressed="${p.courts === k}">${k} court${k > 1 ? "s" : ""}</button>`).join("")}</span></div>
        ${bad ? `<p class="err">${bad}</p>` : ""}
        ${plan ? `<div class="row spread tgt"><span class="seg" role="group" aria-label="${esc(p.name)} games are first to">${Ladder.targetChoices(app.st.league.pointsToWin).map(t => `<button data-act="ptarget" data-sid="${s.id}" data-pool="${p.id}" data-target="${t}" aria-pressed="${targetFor(s, p) === t}">to ${t}</button>`).join("")}</span>
          ${p.target ? `<button class="linkbtn" data-act="ptarget" data-sid="${s.id}" data-pool="${p.id}" data-target="auto">Back to automatic</button>` : '<span class="muted small">automatic</span>'}</div>` : ""}
        ${plan ? `<p class="plan">${plan.text}, first to ${targetFor(s, p)} <b class="num">(${plan.rounds * targetFor(s, p)} points of play)</b>${warn ? `<span>⚠ ${warn}</span>` : ""}</p>` : ""}
        <ol>${p.players.map((id, i) => pl(id, i)).join("")}</ol></div>`;
    }).join("")}</div>
    ${errLine("pools")}</div>

  ${sel ? `<div class="movebar" role="group" aria-label="Move player"><b>Move ${esc(nm(sel))} to</b>
    <div class="row">${s.pools.map(p => `<button class="btn" data-act="move" data-sid="${s.id}" data-pid="${sel}" data-to="${p.id}" ${p.players.includes(sel) ? "disabled" : ""}>${esc(p.name)}</button>`).join("")}
      <button class="btn" data-act="attend" data-sid="${s.id}" data-pid="${sel}" data-off="1">Not playing</button><button class="btn" data-act="cancel">Cancel</button></div></div>` : ""}

  <div class="card"><h2>3. Start</h2>
    <p class="muted">Starting creates each pool's schedule. A pool of eight plays 7 rounds: everyone partners everyone once. A pool of nine plays 9 rounds, with one player sitting out each round.</p>
    ${errLine("start")}
    <button class="btn huge primary" data-act="start" data-sid="${s.id}" ${s.pools.length ? "" : "disabled"}>Start session</button>
    <p class="muted">You will see a summary to confirm first.</p></div>`;
}

function orgLive(s) {
  const pend = Object.values(s.games).filter(g => g.status === "pending").length;
  const open = Object.values(s.games).filter(g => g.status !== "done"), marked = open.filter(g => g.status === "skipped").length;
  const done = Object.values(s.games).filter(g => g.status === "done").length;
  const inPools = s.pools.flatMap(p => p.players);
  const bench = Object.values(app.st.players).filter(p => p.active && !inPools.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  const opt = (id, cur) => `<option value="${id}" ${cur === id ? "selected" : ""}>${esc(nm(id))}</option>`;
  return `<div class="row spread"><h2>${niceDate(s.date)} <span class="live-dot">Live</span></h2><a class="btn small" href="#/board">Open all courts</a></div>
  <div class="card"><h2>Progress</h2>
    ${s.pools.map(p => { const r = roundInfo(s, p);
      return `<div class="row spread"><a href="#/court/${p.id}" class="back" style="min-height:0">${esc(p.name)}</a><span class="num muted">${r.finished ? "Finished" : `Round ${r.at + 1} of ${r.total}`} · ${r.done} of ${r.playable} games</span></div><span class="bar on-surface"><i style="width:${pct(r)}%"></i></span>`; }).join("")}</div>

  <div class="card"><h2>Finish the session</h2>
    <p class="muted">Finishing locks the scores and updates every rating. ${!done ? "<b>No scores have been entered yet</b>, so there is nothing to finish. Go back to setup or delete the session instead." : pend ? `<b>${pend} games have no score</b> and will be recorded as not played.` : "All games have a score."}</p>
    ${errLine("live")}
    ${!done ? "" : app.closing ? `<p class="note" role="status"><b>Finishing…</b> Working out every rating, which can take a few seconds with pools of nine. The scores are safe.</p><div class="row"><button class="btn primary" disabled>Finishing…</button></div>`
      : app.confirm === "close" ? `<div class="row"><button class="btn primary" data-act="close" data-sid="${s.id}">Yes, finish and update ratings</button><button class="btn" data-act="cancel">Not yet</button></div>` : `<button class="btn ${pend ? "" : "primary"}" data-act="ask" data-key="close">Finish session</button>`}
    ${done ? "" : `<button class="btn" data-act="unstart" data-sid="${s.id}">Back to setup</button>`}</div>

  <div class="card"><h2>${s.wasClosed ? "Delete the session" : "Reset or delete the session"}</h2>
    <p class="muted">${s.wasClosed ? "This session was finished once and then reopened, so Reset is switched off. Deleting removes it and its scores for good."
      : "For trying the app out. Reset clears every score and puts each pool back to round 1, keeping the players, pools and draw. Delete removes the session altogether."} Both ask you to confirm, and a backup is kept on this device first.</p>
    <div class="row">${s.wasClosed ? "" : `<button class="btn danger" data-act="askReset" data-sid="${s.id}">Reset session</button>`}<button class="btn danger" data-act="askDelete" data-sid="${s.id}">Delete session</button></div></div>

  <form class="card" data-form="sub" data-sid="${s.id}"><h2>Substitute a player</h2>
    <p class="muted">The replacement takes over every game the first player has not played yet.</p>
    <div class="row" style="align-items:flex-end">
      <label class="field">Player leaving<select id="subout"><option value="">Choose</option>${inPools.slice().sort((a, b) => nm(a).localeCompare(nm(b))).map(id => opt(id, app.form.subout)).join("")}</select></label>
      <label class="field">Replacement<select id="subin"><option value="">Choose</option>${bench.map(p => opt(p.id, app.form.subin)).join("")}</select></label>
      <button class="btn" type="submit">Substitute</button></div>
    <p class="muted">Replacement not listed? Add them under Players first.</p>${errLine("sub")}</form>

  <div class="card"><div class="row spread"><h2>Games not played</h2>
      ${open.length ? `<button class="btn small${app.showSkip ? "" : " primary"}" data-act="toggleSkip">${app.showSkip ? "Hide the list" : "Choose games"}</button>` : ""}</div>
    <p class="muted">Mark a game as not played if it will not happen in this session. ${!open.length ? "Every game has a score." : `${open.length === 1 ? "1 game has" : open.length + " games have"} no score${marked ? `, ${marked} marked not played` : ""}.`}</p>
    ${!app.showSkip || !open.length ? "" : s.pools.map(p => { const gs = poolGames(s, p).filter(g => g.status !== "done");
      return gs.length ? `<h3>${esc(p.name)}</h3><div class="results">${gs.map(g => `<div class="res"><span class="rd">R${g.round + 1}</span><span class="who">${teamLine(g.t1)} v ${teamLine(g.t2)}${g.status === "skipped" ? ' <span class="sc muted">not played</span>' : ""}</span>
        <button class="btn small" data-act="skip" data-sid="${s.id}" data-gid="${g.id}" data-skip="${g.status === "skipped" ? "" : "1"}">${g.status === "skipped" ? "Restore" : "Not played"}</button></div>`).join("")}</div>` : ""; }).join("")}</div>`;
}

function orgPlayers() {
  const list = Object.values(app.st.players).sort((a, b) => a.name.localeCompare(b.name));
  return `<form class="card" data-form="addplayer"><h2>Add a player</h2>
      <div class="row" style="align-items:flex-end"><label class="field">Name<input id="newname" type="text" autocomplete="off" value="${esc(app.form.newname || "")}"></label>
      <label class="field">Starting level${seedOptions("newseed")}</label><button class="btn primary" type="submit">Add player</button></div>${errLine("attend")}</form>
    <div class="card"><h2>Players <span class="muted num">(${list.filter(p => p.active).length} active)</span></h2>${errLine("players")}
      <div class="results">${list.map(p => {
        const t = app.st.ratings.totals[p.id] || { w: 0, l: 0 };
        if (app.edit === p.id) return `<form class="res" data-form="rename" data-pid="${p.id}" style="grid-template-columns:1fr auto auto"><input id="rename" type="text" value="${esc(app.form.rename ?? p.name)}" aria-label="Name"><button class="btn small primary" type="submit">Save</button><button class="btn small" type="button" data-act="cancel">Cancel</button></form>`;
        return `<div class="res" style="grid-template-columns:1fr auto"><span class="who"><b>${esc(p.name)}</b> <span class="muted num">${fmt(rating(p.id))} · ${t.w}-${t.l}${p.active ? "" : " · dropped out"}</span></span>
          <span class="row"><button class="btn small" data-act="edit" data-pid="${p.id}">Rename</button><button class="btn small ${p.active ? "" : "primary"}" data-act="active" data-pid="${p.id}" data-on="${p.active ? "" : "1"}">${p.active ? "Dropped out" : "Restore"}</button></span></div>`;
      }).join("")}</div></div>`;
}

function orgHistory(sid) {
  const closed = closedSess(), names = sessLabels();
  const s = sid && sessById(sid);
  if (s && s.status === "closed") {
    const latest = closed[closed.length - 1] === s;
    return `<a class="back" href="#/org/history">‹ All sessions</a><div class="row spread"><h2>${niceDate(s.date)}</h2>
      ${latest && !openSess() ? (app.confirm === "reopen" ? `<span class="row"><button class="btn small primary" data-act="reopen" data-sid="${s.id}">Yes, reopen</button><button class="btn small" data-act="cancel">Cancel</button></span>` : `<button class="btn small" data-act="ask" data-key="reopen">Reopen session</button>`) : ""}</div>
      <p class="muted">Changing a score here re-runs the ratings for this and every later session.</p>${errLine("history")}
      ${s.pools.map(p => `<div class="card"><h2>${esc(p.name)}</h2>${resultRows(s, p, "all")}</div>`).join("")}`;
  }
  return `<div class="card"><h2>Finished sessions</h2>${closed.length ? `<div class="results">${closed.slice().reverse().map(x => {
    const n = Object.values(x.games).filter(g => g.status === "done").length;
    return `<div class="res" style="grid-template-columns:1fr auto"><span class="who"><b>${shortDate(x.date)}${names[x.id].endsWith(")") ? " " + names[x.id].slice(names[x.id].lastIndexOf("(")) : ""}</b> <span class="muted">${x.attending.length} players · ${n} games</span></span><a class="btn small" href="#/org/history/${x.id}">Open</a></div>`;
  }).join("")}</div>` : '<p class="muted">No finished sessions yet.</p>'}</div>`;
}

function orgSettings() {
  const lg = app.st.league;
  return `<form class="card" data-form="league"><h2>League</h2>
      <div class="row" style="align-items:flex-end"><label class="field">League name<input id="lname" type="text" value="${esc(app.form.lname ?? lg.name)}"></label>
      <label class="field">Points to win a game<input id="lpts" type="number" min="5" max="21" value="${esc(app.form.lpts ?? lg.pointsToWin)}"></label>
      <button class="btn primary" type="submit">Save</button></div>${errLine("league")}
      <div class="row spread"><span><b>Names on match screens</b><br><span class="muted">The ratings list, player pages and the roster always show full names.</span></span>
        <span class="seg" role="group" aria-label="Names on match screens">${[["short", "First name + initial"], ["full", "Full names"]].map(([k, l]) => `<button type="button" data-act="nameStyle" data-style="${k}" aria-pressed="${(lg.nameStyle || "short") === k}">${l}</button>`).join("")}</span></div></form>
    <div class="card"><h2>Connecting</h2>
      ${app.be.kind === "firebase" ? `<p>Everyone opens <b>${esc(location.origin + location.pathname)}</b>. Scores sync live between all phones and tablets.</p>
          ${app.be.orgMode === "open" ? '<p class="muted">Organiser login is switched off, so save a copy below before each session. The login can be switched back on later.</p>' : ""}`
        : app.be.kind === "server" ? `<p>${app.urls.length ? `Phones and tablets on the same Wi-Fi or hotspot open <b>${esc(app.urls[0])}</b>.` : "This computer has no network address right now. Connect it to Wi-Fi or a phone hotspot so other devices can join."}</p>
          <p class="muted">${app.be.orgMode === "open" ? 'The organiser PIN is switched off. To require it again, set "open" to false in data/config.json on the computer running the league.' : "The organiser PIN is stored in the file data/config.json on the computer running the league."}</p>`
        : `<p>Single-device mode. Everything is saved in this browser only, so other phones cannot see it. Add the Firebase details to config.js to share it live.</p>`}
      <p class="muted">Starting seeds are ${lg.seeds.map(v => (v / 1000).toFixed(1)).join(", ")}.</p></div>
    <div class="card"><h2>League data</h2>
      <p class="muted">${app.be.replaceAll ? "Save a copy of everything, or load a league file. Loading replaces all players, sessions and scores." : "Save a copy of everything to this device."}</p>
      <div class="row"><button class="btn" data-act="export">Save a copy</button>
        ${app.be.replaceAll ? `<label class="btn">Load a league file<input id="importfile" type="file" accept="application/json,.json" style="position:absolute;opacity:0;width:1px;height:1px"></label>` : ""}</div>
      ${app.importDoc ? `<div class="note"><b>${esc(app.importDoc.name)}</b>: ${app.importDoc.players} players, ${app.importDoc.sessions} sessions. This replaces everything in the league now.
        <div class="row" style="margin-top:10px"><button class="btn primary" data-act="import">Replace the league with this file</button><button class="btn" data-act="cancel">Cancel</button></div></div>` : ""}
      ${errLine("data")}</div>
    <div class="card"><h2>Backups on this device</h2>
      <p class="muted">A copy is kept here before a session is finished, reopened, reset or deleted, and before a league file is loaded. The last five are kept, on this device only.${app.be.kind === "server" ? " The laptop also saves files in its data/backups folder, and restoring on the laptop version is done from those files." : ""}</p>
      ${backups().length ? `<div class="results">${backups().map((x, i) => `<div class="res" style="grid-template-columns:1fr auto"><span class="who"><b>${new Date(x.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</b> <span class="muted">${WHY[x.why] || ""} · ${Object.keys(x.state.sessions || {}).length} sessions</span></span>
        ${!app.be.replaceAll ? "" : app.confirm === "restore:" + i ? `<span class="row"><button class="btn small danger" data-act="restore" data-i="${i}">Yes, replace the league with this</button><button class="btn small" data-act="cancel">Cancel</button></span>` : `<button class="btn small" data-act="ask" data-key="restore:${i}">Restore</button>`}</div>`).join("")}</div>` : '<p class="muted">No backups on this device yet.</p>'}
      ${errLine("restore")}</div>`;
}

/* ---------- score entry ---------- */
function openFlow(sid, gid) {
  const s = sessById(sid), g = s && s.games[gid];
  if (!g) return;
  app.flow = { sid, gid, step: "win", win: null, pts: Ladder.gameTarget(app.st, s, gid), ws: 0, ls: null, err: "", clash: null, busy: false, sure: false,
    was: g.status === "done" ? { s1: g.s1, s2: g.s2 } : null,      // the score this screen set out to change, so a change made on another device is caught
    hist: s.status === "closed" };                                   // opened on a finished session, from Organiser, History
  render();
}
function viewFlow() {
  const f = app.flow, s = sessById(f.sid), g = s && s.games[f.gid];
  if (!g || (s.status !== "live" && !f.hist)) {                      // the session was finished or removed while this screen was open
    app.flow = null;
    if (g) setTimeout(() => toast("That session has been finished. The score was not changed."), 0);
    return "";
  }
  const pool = s.pools.find(p => p.id === g.pool), pts = f.pts;
  const winners = f.win === 1 ? g.t1 : g.t2, losers = f.win === 1 ? g.t2 : g.t1;
  const slot = pool && pool.courts > 1 && pool.rounds[g.round] ? pool.rounds[g.round].indexOf(g.id) + 1 : 0, court = slot <= (pool ? pool.courts : 0) ? slot : 0;
  const where = `${esc(pool ? pool.name : "")} · round ${g.round + 1}${court ? " · court " + court : ""}`;
  let body = "";
  if (f.step === "win") {
    body = `<h2>Who won?</h2>
      ${g.status === "done" ? `<p class="note">Currently entered as <b>${teamLine(g.t1)} ${g.s1} – ${g.s2} ${teamLine(g.t2)}</b>.</p>` : ""}
      <div class="picks"><button class="pick" data-act="fwin" data-win="1">${team(g.t1)}</button>
      <button class="pick" data-act="fwin" data-win="2">${team(g.t2)}</button></div>
      ${g.status !== "done" ? "" : f.sure ? `<div class="row"><button class="btn danger solid" data-act="fclear">Yes, clear ${g.s1} – ${g.s2}</button><button class="btn" data-act="fkeep">Keep the score</button></div>`
        : `<button class="btn danger" data-act="fclear">Clear this score</button>`}`;
  } else if (f.step === "score") {
    body = `<h2>Tap the <span class="hl">losing</span> score</h2>
      <div class="match is-done slim"><div class="side won"><div class="names"><em>Won</em>${team(winners)}</div><div class="pts">${pts}</div></div>
        <div class="side lost"><div class="names"><em>Lost</em>${team(losers)}</div><div class="pts ask">?</div></div></div>
      <p class="lead">First to ${pts}, win by 1. What did <b>${teamLine(losers)}</b> finish on?</p>
      <div class="keys${pts > 15 ? " k21" : pts > 12 ? " k15" : ""}">${Array.from({ length: pts }, (_, i) => `<button class="key" data-act="fscore" data-ls="${i}">${i}</button>`).join("")}
        <button class="key other" data-act="fother">Stopped early</button></div>`;
  } else if (f.step === "other") {
    /* a game that ended before anyone reached the target: tap what the pair ahead was on, then what the other pair was on */
    const ahead = f.ws == null, from = ahead ? 1 : 0, count = ahead ? pts - 1 : f.ws;
    body = `<h2>Game stopped early</h2>
      <div class="match is-done slim"><div class="side won"><div class="names"><em>Ahead</em>${team(winners)}</div><div class="pts${ahead ? " ask" : ""}">${ahead ? "?" : f.ws}</div></div>
        <div class="side lost"><div class="names"><em>Behind</em>${team(losers)}</div><div class="pts${ahead ? "" : " ask"}">${ahead ? "" : "?"}</div></div></div>
      <p class="lead">${ahead ? `For a game that ended before anyone reached ${pts}. What were <b>${teamLine(winners)}</b> on when it stopped?` : `And what were <b>${teamLine(losers)}</b> on?`}</p>
      <div class="keys${count > 15 ? " k21" : count > 12 ? " k15" : ""}">${Array.from({ length: count }, (_, i) => `<button class="key" data-act="fearly" data-v="${i + from}">${i + from}</button>`).join("")}</div>`;
  } else {
    const flip = f.clash && (f.clash.s1 > f.clash.s2) !== (f.win === 1);      // the score already there has the other pair winning
    body = `<h2>Save this score?</h2><p class="where2">${where}</p>
      <div class="match is-done"><div class="side won"><div class="names"><em>Won</em>${team(winners)}</div><div class="pts">${f.ws}</div></div>
        <div class="side lost"><div class="names"><em>Lost</em>${team(losers)}</div><div class="pts">${f.ls}</div></div></div>
      ${f.ws < pts ? `<p class="note">Stopped early: recorded as ${f.ws} – ${f.ls}, short of ${pts}.</p>` : ""}
      ${f.clash ? `<p class="err" role="alert">${f.was && !f.fresh ? "This score was changed on another device while this screen was open. It is now" : "This game was already entered as"} ${teamLine(g.t1)} ${f.clash.s1} – ${f.clash.s2} ${teamLine(g.t2)}.${flip ? " <b>That has the other pair winning.</b> Check with both pairs before replacing it." : " Replace it?"}</p>
        ${flip ? `<button class="btn huge primary" data-act="fclose">Keep ${f.clash.s1} – ${f.clash.s2}</button><button class="btn danger" data-act="fsave" data-replace="1" ${f.busy ? "disabled" : ""}>Replace it with ${f.win === 1 ? f.ws : f.ls} – ${f.win === 1 ? f.ls : f.ws}</button>`
          : `<button class="btn huge primary" data-act="fsave" data-replace="1" ${f.busy ? "disabled" : ""}>Replace the score</button><button class="btn" data-act="fclose">Keep ${f.clash.s1} – ${f.clash.s2}</button>`}`
        : `<button class="btn huge primary" data-act="fsave" ${f.busy ? "disabled" : ""}>${f.busy ? "Saving…" : "Save score"}</button>`}`;
  }
  const back = f.step === "win" ? "" : `<button class="btn" data-act="fback">‹ Back</button>`;
  return `<div class="flow" role="dialog" aria-modal="true" aria-label="Enter score">
    <div class="flow-top">${back || "<span></span>"}<span class="where">${where}</span><button class="xbtn" data-act="fclose" aria-label="Close">✕</button></div>
    <div class="flow-body">${body}${f.err ? `<p class="err" role="alert">${esc(f.err)}</p>` : ""}</div></div>`;
}

/* ---------- confirmation screens ---------- */
function viewDialog() {
  const d = app.dialog, s = sessById(d.sid);
  const frame = (label, body) => `<div class="flow" role="dialog" aria-modal="true" aria-label="${label}">
    <div class="flow-top"><span></span><span class="where">${s ? niceDate(s.date) : ""}</span><button class="xbtn" data-act="cancel" aria-label="Close">✕</button></div>
    <div class="flow-body">${body}</div></div>`;
  const err = d.err ? `<p class="err" role="alert">${esc(d.err)}</p>` : "";
  if (!s) { app.dialog = null; return ""; }
  const done = Object.values(s.games).filter(g => g.status === "done").length, scores = done === 1 ? "1 score" : done + " scores";
  if (d.kind === "start") {
    if (s.status !== "setup") { app.dialog = null; return ""; }
    const odd = outOfOrder(s), plans = s.pools.map(p => ({ p, plan: poolPlan(p.players.length, p.courts), warn: poolWarn(s, p) })), slow = plans.filter(x => x.warn);
    const placed = new Set(s.pools.flatMap(p => p.players)), loose = s.attending.filter(id => !placed.has(id));
    const stop = (s.pools.length ? [] : ["No pools have been made yet."])
      .concat(plans.filter(x => !x.plan).map(x => `${x.p.name} has ${x.p.players.length} player${x.p.players.length === 1 ? "" : "s"}. A pool needs ${Ladder.MIN_POOL} to ${Ladder.MAX_POOL}.`))
      .concat(loose.length ? [`Not in a pool yet: ${loose.map(nm).join(", ")}.`] : []);
    return frame("Start session", `<h2>${stop.length ? "Not ready to start" : "Start the session?"}</h2>
      ${stop.length ? `<p class="err" role="alert">${stop.map(esc).join("<br>")}</p>` : ""}
      <div class="oddlist">${plans.map(({ p, plan }) => `<div class="odd"><b>${esc(p.name)}</b><span class="num">${p.players.length} players</span><span>${plan ? `${plan.text}, first to ${targetFor(s, p)}, ${p.courts} court${p.courts > 1 ? "s" : ""}` : "needs 4 to 12 players"}</span></div>`).join("")}</div>
      ${slow.length ? `<p class="note warn">⚠ ${slow.map(x => `<b>${esc(x.p.name)}</b>: ${x.warn}`).join("<br>")}</p>` : ""}
      ${odd.length ? `<p class="lead"><b>${odd.length === 1 ? "1 player is" : odd.length + " players are"} out of rating order</b> because the pools were changed by hand:</p>
        <div class="oddlist">${odd.map(o => `<div class="odd"><b>${esc(nm(o.id))}</b><span class="num">${fmt(rating(o.id))}</span><span>${esc(o.pool.name)}, ${o.high ? "higher" : "lower"} than their rating</span></div>`).join("")}</div>` : ""}
      ${err}<button class="btn huge primary" data-act="start" data-sid="${s.id}" data-force="1" ${d.busy || stop.length ? "disabled" : ""}>${d.busy ? "Starting…" : "Yes, start the session"}</button>
      <button class="btn huge" data-act="cancel">Go back to the pools</button>`);
  }
  if (s.status !== "live") { app.dialog = null; return ""; }
  if (d.kind === "delete") {
    return frame("Delete session", `<h2>Delete this session?</h2>
      <p class="lead">This removes the session${done ? ` and its <b>${scores}</b>` : ""} for good.${s.wasClosed ? " It was finished once and then reopened, so its results will also leave the ratings." : ""}</p>
      <p class="lead">Players and earlier sessions are not touched. A backup is kept on this device first (Organiser, Settings).</p>
      ${err}<button class="btn huge danger solid" data-act="delete" data-sid="${s.id}" data-force="1" ${d.busy ? "disabled" : ""}>${d.busy ? "Deleting…" : "Yes, delete the session"}</button>
      <button class="btn huge" data-act="cancel">No, keep it</button>`);
  }
  const moved = s.pools.filter(p => p.confirmed > 0).length;
  return frame("Reset session", `<h2>Reset this session?</h2>
    <p class="lead">This clears <b>${scores}</b> and every not-played mark, and puts ${moved ? `<b>${moved === 1 ? "1 pool" : moved + " pools"}</b>` : "every pool"} back to <b>round 1</b>.</p>
    <p class="lead">Players, pools and the draw stay as they are. Ratings and finished sessions are not touched. A backup is kept on this device first (Organiser, Settings).</p>
    ${err}<button class="btn huge danger solid" data-act="reset" data-sid="${s.id}" ${d.busy ? "disabled" : ""}>${d.busy ? "Resetting…" : "Yes, reset the session"}</button>
    <button class="btn huge" data-act="cancel">No, keep the scores</button>`);
}
/* Run the action a confirmation screen was asking about. */
async function dialogRun(type, args, okMsg, backup) {
  const g = app.dialog;
  if (!g || g.busy) return { ok: false };
  g.busy = true; g.err = ""; render();
  if (backup) backupLocal(type);
  const j = await send(type, args);
  if (j.ok) { app.dialog = null; toast(okMsg); } else { g.busy = false; g.err = j.message; }
  render();
  return j;
}

/* ---------- render ---------- */
/* ---------- names that fit their box ---------- */
/* In the pool lists a name stays on one line: the full name if it fits, otherwise without middle names, otherwise first name
   and initial. The full name is always there as the tooltip. fitNames() picks the first form that fits after each redraw. */
function fitName(id) {
  const full = nm(id), parts = full.trim().split(/\s+/), forms = [full];
  if (parts.length > 2) forms.push(parts[0] + " " + parts[parts.length - 1]);
  if (app.short[id] && !forms.includes(app.short[id])) forms.push(app.short[id]);
  return `<span class="fitname" title="${esc(full)}" data-forms="${esc(JSON.stringify(forms))}">${esc(full)}</span>`;
}
function fitNames() {
  document.querySelectorAll("#app .fitname").forEach(el => {
    let forms = [];
    try { forms = JSON.parse(el.dataset.forms); } catch (e) { return; }
    for (const form of forms) { el.textContent = form; if (el.scrollWidth <= el.clientWidth + 1) break; }
  });
}

/* ---------- sortable tables: tap a column heading ---------- */
/* First tap sorts (numbers highest first, names A to Z), second tap reverses, third puts the table back as it was.
   The choice is remembered per page and table, and re-applied whenever the page redraws. */
const sortState = {};
function cellValue(td) {
  const raw = td.dataset.v != null ? td.dataset.v : td.textContent.trim();
  const n = parseFloat(raw.replace(/−/g, "-").replace(/[▲▼+%\s]/g, ""));
  return /^[▲▼\s]*[-−+]?\d/.test(raw) && !isNaN(n) ? n : raw.toLowerCase();
}
function sortTables() {
  document.querySelectorAll("#app table").forEach((table, k) => {
    const key = location.hash + "|" + app.tab + "|" + k, st = sortState[key], heads = [...table.querySelectorAll("thead th")], body = table.tBodies[0];
    if (!heads.length || !body) return;
    table.dataset.sortKey = key;
    heads.forEach((th, i) => { th.classList.add("sortable"); th.tabIndex = 0; th.setAttribute("aria-sort", st && st.col === i ? (st.dir > 0 ? "ascending" : "descending") : "none"); });
    if (!st) return;
    const rows = [...body.rows], whole = rows.filter(r => r.cells.length === heads.length), partial = rows.filter(r => r.cells.length !== heads.length);
    whole.map((r, i) => ({ r, i, v: cellValue(r.cells[st.col]) })).sort((a, b) => {
      const x = a.v, y = b.v, nx = typeof x === "number", ny = typeof y === "number";
      if (nx !== ny) return nx ? -1 : 1;                                   // numbers first, text (such as "did not play") after
      return (nx ? x - y : x.localeCompare(y, undefined, { numeric: true })) * st.dir || a.i - b.i;
    }).forEach(o => body.appendChild(o.r));
    partial.forEach(r => body.appendChild(r));                              // rows that span columns (did not play) go last
  });
}
function sortBy(th) {
  const table = th.closest("table"), key = table.dataset.sortKey, col = [...th.parentNode.children].indexOf(th), st = sortState[key];
  const first = [...table.tBodies[0].rows].find(r => r.cells.length === th.parentNode.children.length);
  const natural = first && typeof cellValue(first.cells[col]) === "number" ? -1 : 1;
  if (!st || st.col !== col) sortState[key] = { col, dir: natural };
  else if (st.dir === natural) st.dir = -natural;
  else delete sortState[key];
  render();
}

let overlayUp = false;      // the score screen and the confirmation screens take one step of browser history, so Back closes them
let overlayLeaving = false; // that step is being taken back; anything that changes page next waits for it
const afterOverlay = [];
function whenSettled(fn) { if (overlayLeaving) afterOverlay.push(fn); else fn(); }
/* ---------- render ---------- */
function render() {
  if (!app.st) return;
  const [, route, a, b] = location.hash.split("/");
  const view = route === "court" ? viewCourt((a || "").toUpperCase()) : route === "board" ? viewBoard() : route === "standings" ? viewStandings() : route === "player" ? viewPlayer(a) : route === "org" ? viewOrg(a, b) : route === "pickleball" ? viewPickleball() : viewHome();
  const focused = document.activeElement && document.activeElement.id, selStart = focused && document.activeElement.selectionStart;
  const html = shell(view);
  /* the front page: leave it alone when nothing in it changed, so the photo is not redrawn on every update */
  if (!(route === "pickleball" && app.pbHtml === html && $("#app .sell"))) $("#app").innerHTML = html;
  app.pbHtml = route === "pickleball" ? html : null;
  document.body.classList.toggle("on-sell", route === "pickleball");      // that page is dark from edge to edge
  $("#overlay").innerHTML = app.flow ? viewFlow() : app.dialog ? viewDialog() : "";
  const up = !!(app.flow || app.dialog);
  document.body.style.overflow = up ? "hidden" : "";
  if (up && !overlayUp && !(history.state && history.state.overlay)) history.pushState({ overlay: true }, "");
  if (!up && overlayUp && history.state && history.state.overlay) { overlayLeaving = true; history.back(); }
  overlayUp = up;
  document.title = app.st.league.name;
  fillBoard();
  sortTables();
  fitNames();
  if (app.jump && Date.now() < app.jump.until && route === "player") jumpTo(app.jump.id, true); else app.jump = null;
  if (focused && !app.flow) {
    const el = document.getElementById(focused);
    if (el) { el.focus(); try { if (selStart != null) el.setSelectionRange(selStart, selStart); } catch (e) { /* not a text input */ } }
  }
}

/* ---------- actions ---------- */
const A = {
  flow: d => openFlow(d.sid, d.gid),
  fclose: () => { app.flow = null; render(); },
  fwin: d => { const f = app.flow; f.win = +d.win; f.ws = f.pts; f.ls = null; f.sure = false; f.step = "score"; render(); },
  fscore: d => { const f = app.flow; f.ls = +d.ls; f.ws = f.pts; f.step = "confirm"; render(); },
  fother: () => { const f = app.flow; f.ws = null; f.ls = null; f.step = "other"; render(); },
  fearly: d => { const f = app.flow; if (f.ws == null) f.ws = +d.v; else { f.ls = +d.v; f.step = "confirm"; } render(); },
  fback: () => {
    const f = app.flow; f.err = ""; f.clash = null;
    if (f.step === "confirm") { if (f.ws === f.pts) f.step = "score"; else { f.step = "other"; f.ls = null; } }      // back to the behind pair's score
    else if (f.step === "other" && f.ws != null) f.ws = null;                                                           // back to the pair ahead
    else f.step = f.step === "other" ? "score" : "win";
    render();
  },
  fkeep: () => { app.flow.sure = false; render(); },
  fsave: async d => {
    const f = app.flow; if (f.busy) return;
    f.busy = true; f.err = ""; render();
    const s1 = f.win === 1 ? f.ws : f.ls, s2 = f.win === 1 ? f.ls : f.ws, args = { sid: f.sid, gid: f.gid, s1, s2, replace: !!d.replace || !!f.was };
    if (f.was) args.was = f.was;
    if (f.hist) args.history = true;
    if (f.hist) backupLocal("correction");
    const j = await send("game.score", args);
    if (app.flow !== f) return;
    f.busy = false;
    if (j.ok) { app.flow = null; toast("Score saved"); }
    else if (j.code === "exists") { f.fresh = !f.was; f.clash = { s1: j.s1, s2: j.s2 }; f.was = { s1: j.s1, s2: j.s2 }; }      // replacing now means replacing what is really there
    else f.err = j.message;
    render();
  },
  fclear: async () => {
    const f = app.flow;
    if (!f.sure) { f.sure = true; return render(); }
    const args = { sid: f.sid, gid: f.gid };
    if (f.hist) args.history = true;
    const j = await send("game.clear", args);
    if (j.ok) { app.flow = null; toast("Score cleared"); } else f.err = j.message;
    render();
  },
  confirmRound: d => act("court", "round.confirm", { sid: d.sid, pool: d.pool, round: +d.round }, "Round confirmed"),
  backRound: d => { app.confirm = null; return act("court", "round.back", { sid: d.sid, pool: d.pool }, "Back one round"); },
  nameStyle: d => act("league", "league.update", { nameStyle: d.style }),
  fullscreen: () => fsToggle(),
  toggleSkip: () => { app.showSkip = !app.showSkip; render(); },
  tab: d => { app.tab = d.tab; render(); },
  hl: d => togglePlayer(d.pid),
  hon: d => { location.hash = "#/player/" + d.pid; },
  player: d => { location.hash = "#/player/" + d.pid; },
  jump: d => { app.jump = { id: d.to, until: Date.now() + 2500 }; jumpTo(d.to); },
  /* a box's games: open the list under the boxes and go there; the same tap again closes it */
  h2h: d => {
    const owner = location.hash.split("/")[2], other = d.other || "", cur = app.h2h;
    app.h2h = cur && cur.owner === owner && cur.other === other && cur.kind === d.kind ? null : { owner, other, kind: d.kind };
    app.jump = app.h2h ? { id: "p-h2h", until: Date.now() + 2500 } : null;
    render();
  },
  hfilter: d => {
    const hs = app.hs; if (!hs) return;
    if (hs.custom) { hs.start = []; hs.now = []; hs.custom = false; }
    if (d.v === "all") hs[d.kind] = [];
    else { const k = +d.v, at = hs[d.kind].indexOf(k); if (at >= 0) hs[d.kind].splice(at, 1); else hs[d.kind].push(k); }
    hs.prev = hs.on; hs.on = null; render();
  },
  hall: d => { const hs = app.hs; if (!hs) return; hs.start = []; hs.now = []; hs.custom = !d.on; hs.prev = d.on ? hs.on : null; hs.on = d.on ? null : []; render(); },
  askReset: d => { app.dialog = { sid: d.sid, busy: false, err: "" }; render(); },
  askDelete: d => { app.dialog = { kind: "delete", sid: d.sid, busy: false, err: "" }; render(); },
  reset: d => dialogRun("session.reset", { sid: d.sid }, "Session reset", true),
  restore: async d => {
    const pick = backups()[+d.i]; app.confirm = null;
    if (!pick || !app.be.replaceAll) return render();
    backupLocal("restore");
    const j = await app.be.replaceAll(pick.state);
    app.err.restore = j.ok ? "" : j.message;
    if (j.ok) toast("Backup restored");
    render();
  },
  lock: async () => { await app.be.signOut(); app.form.password = ""; render(); },
  export: () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(app.st)], { type: "application/json" }));
    a.download = "league-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  import: async () => {
    const doc = app.importDoc; app.importDoc = null;
    backupLocal("import");
    const j = await app.be.replaceAll(doc.data);
    app.err.data = j.ok ? "" : j.message;
    if (j.ok) toast("League loaded");
    render();
  },
  ask: d => { app.confirm = d.key; render(); },
  cancel: () => { app.confirm = null; app.sel = null; app.edit = null; app.importDoc = null; app.dialog = null; render(); },
  attend: d => { if (d.off) app.sel = null; const s = sessById(d.sid); return act("attend", "session.attend", { sid: d.sid, pid: d.pid, on: d.off ? false : !(s && s.attending.includes(d.pid)) }); },
  attendAll: d => { app.sel = null; return act("attend", "session.attendAll", d.last ? { sid: d.sid, last: true } : { sid: d.sid, on: !!d.on }, d.last ? "Same players as last week" : ""); },
  assign: d => { app.sel = null; app.confirm = null; return act("pools", "session.assign", d.pools ? { sid: d.sid, pools: +d.pools } : { sid: d.sid }); },
  pick: d => { app.sel = app.sel === d.pid ? null : d.pid; render(); },
  move: d => { app.sel = null; return act("pools", "session.move", { sid: d.sid, pid: d.pid, to: d.to }); },
  courts: d => act("pools", "session.pool", { sid: d.sid, pool: d.pool, courts: +d.courts }),
  ptarget: d => act("pools", "session.pool", { sid: d.sid, pool: d.pool, target: d.target === "auto" ? "auto" : +d.target }),
  start: async d => {
    if (!d.force) { app.dialog = { kind: "start", sid: d.sid, busy: false, err: "" }; return render(); }     // always a summary first
    const j = await dialogRun("session.start", { sid: d.sid }, "Session started");
    if (j.ok) whenSettled(() => { location.hash = "#/board"; });
  },
  unstart: d => act("live", "session.unstart", { sid: d.sid }),
  delete: d => { app.confirm = null; return d.force ? dialogRun("session.delete", { sid: d.sid, force: true }, "Session deleted", true) : act("session", "session.delete", { sid: d.sid }, "Session deleted"); },
  close: d => once("close", async () => {
    app.closing = true; app.confirm = null; render();
    await new Promise(r => setTimeout(r, 40));      // let "Finishing…" reach the screen: on the hosted site this device works the ratings out itself
    backupLocal("session.close");
    let j = { ok: false };
    try { j = await act("live", "session.close", { sid: d.sid }, "Session finished. Ratings updated."); } finally { app.closing = false; }
    if (j.ok) { app.tab = "ratings"; location.hash = "#/standings"; }
    render();
  }),
  reopen: d => once("reopen", async () => { app.confirm = null; backupLocal("session.reopen"); const j = await act("history", "session.reopen", { sid: d.sid }, "Session reopened"); if (j.ok) location.hash = "#/org"; }),
  skip: d => act("live", "game.skip", { sid: d.sid, gid: d.gid, skip: !!d.skip }),
  edit: d => { app.edit = d.pid; app.form.rename = nm(d.pid); render(); },
  active: d => act("players", "player.update", { id: d.pid, active: !!d.on }),
};

async function account(method) {
  const j = await app.be[method]({ email: (app.form.email || "").trim(), password: app.form.password || "" });
  app.err.pin = j.ok ? "" : j.message;
  if (j.ok) app.form.password = "";
  render();
}

const FORMS = {
  pin: async () => {
    const j = await app.be.signIn({ pin: (app.form.pin || "").trim() });
    app.err.pin = j.ok ? "" : j.message;
    if (j.ok) app.form.pin = "";
    render();
  },
  signin: () => account("signIn"),
  createorg: () => account("createOrganiser"),
  create: () => act("session", "session.create", { date: app.form.newdate || $("#newdate").value }),
  addplayer: async form => {
    const j = await act("attend", "player.add", { name: app.form.newname || "", seed: app.form.newseed || $("#newseed").value, sid: form.dataset.sid || undefined }, "Player added");
    if (j.ok) { app.form.newname = ""; render(); }
  },
  rename: async form => { const j = await act("players", "player.update", { id: form.dataset.pid, name: app.form.rename }); if (j.ok) { app.edit = null; render(); } },
  sub: async form => {
    if (!app.form.subout || !app.form.subin) { app.err.sub = "Choose both players."; return render(); }
    const j = await act("sub", "session.substitute", { sid: form.dataset.sid, out: app.form.subout, in: app.form.subin });
    if (j.ok) { toast(`Substituted into ${j.result.games} games`); app.form.subout = app.form.subin = ""; render(); }
  },
  league: () => act("league", "league.update", { name: app.form.lname ?? app.st.league.name, pointsToWin: app.form.lpts ?? app.st.league.pointsToWin }, "Saved"),
};

document.addEventListener("pointermove", chartTip);
document.addEventListener("click", e => {
  if (drag.suppress) { e.preventDefault(); return; }
  const th = e.target.closest ? e.target.closest("th.sortable") : null;
  if (th) return sortBy(th);
  const p = chartProbe(e);
  chartTip(e);
  if (p) return;
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const inside = e.target.closest("a[href]");
  if (inside && inside !== el && el.contains(inside)) return;      // a name inside a box: let the link open that person
  const fn = A[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});
document.addEventListener("submit", e => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  FORMS[form.dataset.form]?.(form);
});
document.addEventListener("input", e => {
  if (!e.target.id) return;
  app.form[e.target.id] = e.target.value;
  if (e.target.id === "q" || e.target.id === "newdate" || e.target.id === "rq") render();
});
document.addEventListener("change", async e => {
  if (e.target.id === "importfile") {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data.players !== "object" || !data.sessions) throw new Error("not a league file");
      app.importDoc = { name: file.name, data, players: Object.keys(data.players).length, sessions: Object.keys(data.sessions).length };
      app.err.data = "";
    } catch (err) { app.importDoc = null; app.err.data = "That file is not a league file saved from this app."; }
    return render();
  }
  if (e.target.id) app.form[e.target.id] = e.target.value;
});
document.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches('[role="button"][data-act], th.sortable')) { e.preventDefault(); e.target.click(); } });
document.addEventListener("keydown", e => { if (e.key === "Escape" && (app.flow || app.dialog)) { app.flow = null; app.dialog = null; render(); } });
/* ---------- drag a player between pools: mouse straight away, touch after a press and hold ---------- */
const drag = { pid: null, x: 0, y: 0, active: false, touch: false, timer: 0, ghost: null, zone: null, suppress: false };
function dragBegin() {
  drag.active = true;
  drag.ghost = document.createElement("div");
  drag.ghost.className = "dragghost";
  drag.ghost.textContent = nm(drag.pid);
  document.body.appendChild(drag.ghost);
  document.body.classList.add("dragging");
  drag.scroll = setInterval(() => {
    const dy = !drag.active ? 0 : drag.y < 70 ? -14 : drag.y > window.innerHeight - 70 ? 14 : 0;
    if (!dy) return;
    if (fsOn()) $("#app").scrollTop += dy; else window.scrollBy(0, dy);
    dragTo(drag.x, drag.y);
  }, 16);
  dragTo(drag.x, drag.y);
}
function dragTo(x, y) {
  drag.x = x; drag.y = y;
  drag.ghost.style.transform = `translate(${x + 14}px, ${y - 22}px)`;
  const el = document.elementFromPoint(x, y), zone = el && el.closest("[data-drop]");
  document.querySelectorAll(".pool.drop").forEach(z => { if (z !== zone) z.classList.remove("drop"); });
  if (zone) zone.classList.add("drop");
  drag.zone = zone ? zone.dataset.drop : null;
}
function dragStop(drop) {
  clearTimeout(drag.timer); clearInterval(drag.scroll);
  if (drag.active) {
    drag.ghost.remove(); drag.ghost = null;
    document.body.classList.remove("dragging");
    document.querySelectorAll(".pool.drop").forEach(z => z.classList.remove("drop"));
    const s = openSess();
    const from = s && s.pools.find(p => p.players.includes(drag.pid)), here = from ? from.id : "none";
    if (drop && drag.zone !== null && drag.zone !== here && s && s.status === "setup") { app.sel = null; act("pools", "session.move", { sid: s.id, pid: drag.pid, to: drag.zone }); }
    drag.suppress = true; setTimeout(() => { drag.suppress = false; }, 80);       // the click that follows a drop is not a tap
  }
  drag.pid = null; drag.active = false;
}
document.addEventListener("pointerdown", e => {
  const el = e.target.closest ? e.target.closest(".pl[data-drag]") : null;
  if (!el || e.button > 0 || drag.pid) return;
  drag.pid = el.dataset.pid; drag.x = e.clientX; drag.y = e.clientY; drag.touch = e.pointerType !== "mouse";
  if (!drag.touch) return;
  /* a finger on the handle drags at once: the handle is the one part of the row the tablet never treats as a scroll */
  if (e.target.closest("[data-grip]")) { e.preventDefault(); dragBegin(); }
  else drag.timer = setTimeout(dragBegin, 350);
});
document.addEventListener("pointermove", e => {
  if (!drag.pid) return;
  if (!drag.active) {
    const far = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (drag.touch) { if (far > 10) dragStop(false); return; }                   // a moving finger is a scroll, not a drag
    if (far < 6) return;
    dragBegin();
  }
  dragTo(e.clientX, e.clientY);
});
document.addEventListener("pointerup", () => { if (drag.pid) dragStop(true); });
document.addEventListener("pointercancel", () => { if (drag.pid) dragStop(false); });
document.addEventListener("touchmove", e => { if (drag.active) e.preventDefault(); }, { passive: false });
document.addEventListener("contextmenu", e => { if (drag.pid && drag.touch) e.preventDefault(); });
let resizeTimer = 0;
window.addEventListener("resize", () => { fitNames(); clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!app.flow) render(); }, 150); });      // names re-fitted at once, the rest once the size settles
/* The stylesheet is added by a script (index.html), so the first draw can come before it has arrived. Anything measured
   then (which form of a name fits, how the board fills the screen) is wrong, so draw again once it is in. */
{ const sheet = document.querySelector('link[rel="stylesheet"]'); if (sheet && !sheet.sheet) sheet.addEventListener("load", () => { if (app.st && !app.flow) render(); }); }
/* Going into or out of full screen: back to the top and back to normal size. On an iPad a page that was zoomed even
   slightly (a double tap does it) stays zoomed in full screen, which pushes the top bar and both edges off the screen. */
const VIEWPORT = "width=device-width, initial-scale=1, viewport-fit=cover";
/* In full screen the page itself never scrolls (on an iPad a scrolled full screen page stops responding): the app scrolls inside it. */
function toTop() { window.scrollTo(0, 0); const a = $("#app"); if (a) a.scrollTop = 0; }
function fsChanged() {
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta) meta.setAttribute("content", VIEWPORT + (fsOn() ? ", minimum-scale=1, maximum-scale=1, user-scalable=no" : ""));
  toTop();
  render();
  setTimeout(() => { toTop(); render(); }, 350);       // again once the screen has finished resizing
}
document.addEventListener("fullscreenchange", fsChanged);
document.addEventListener("webkitfullscreenchange", fsChanged);
window.addEventListener("popstate", () => {
  overlayLeaving = false;
  if (app.flow || app.dialog) { app.flow = null; app.dialog = null; render(); }      // Back pressed with a screen open: close it
  afterOverlay.splice(0).forEach(fn => fn());
});
window.addEventListener("hashchange", () => { app.jump = null; app.showSkip = false; app.flow = null; app.err = {}; app.dialog = null; app.confirm = null; app.sel = null; app.edit = null; toTop(); render(); });

boot();

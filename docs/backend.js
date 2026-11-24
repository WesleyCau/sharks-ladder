"use strict";
/* Where the league lives. Three interchangeable backends with the same interface:
     firebase  shared live database (the hosted site, once config.js has the Firebase details)
     server    the Python server in this repo (laptop on the venue Wi-Fi)
     local     this browser only (demo and single-device use)
   Interface: { kind, orgMode, isOrg(), start(), send(type, args), signIn(), signOut(), replaceAll(doc) } */
const Backends = (() => {
  const clone = x => JSON.parse(JSON.stringify(x));
  function failure(e) {
    if (e instanceof Ladder.ActionError) return Object.assign({ ok: false, code: e.code, message: e.message }, e.extra);
    const text = String((e && (e.code || e.message)) || e);
    if (/permission/i.test(text)) return { ok: false, code: "pin", message: "The database refused that change. Organiser access is not switched on there." };
    console.error(e);
    return { ok: false, code: "error", message: "Something went wrong. Check the connection and try again." };
  }

  /* ---------------- this browser only ---------------- */
  function local(onState) {
    const KEY = "sharks-ladder-state";
    const load = () => { try { return Ladder.normalize(JSON.parse(localStorage.getItem(KEY) || "null")); } catch (e) { return Ladder.emptyState(); } };
    let state = load();
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable: keep going in memory */ } };
    const emit = () => onState({ state, urls: [] });
    window.addEventListener("storage", e => { if (e.key === KEY) { state = load(); emit(); } });
    return {
      kind: "local", orgMode: "open", isOrg: () => true, start: emit, signOut() {},
      async send(type, args) {
        const next = clone(state);
        try { const result = Ladder.apply(next, type, args, true); state = next; save(); emit(); return { ok: true, result }; } catch (e) { return failure(e); }
      },
      async replaceAll(doc) { state = Ladder.normalize(doc); state.ratings = Ladder.compute(state); save(); emit(); return { ok: true }; },
    };
  }

  /* ---------------- the Python server ---------------- */
  function server(onState, onOnline, first) {
    let version = null, pin = sessionStorage.getItem("sharks-pin") || "";
    const open = !!(window.LADDER_CONFIG || {}).openOrganiser;
    const take = j => { version = j.version; onState({ state: j.state, urls: j.urls || [] }); };
    async function post(type, args, withPin) {
      try {
        const r = await fetch("api/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, args, pin: withPin == null ? pin : withPin }) });
        return await r.json();
      } catch (e) { return { ok: false, code: "offline", message: "Could not reach the server. Check the connection and try again." }; }
    }
    async function poll() {
      try {
        const r = await fetch("api/state?v=" + (version == null ? "" : version));
        if (r.status === 200) take(await r.json());
        onOnline(true);
      } catch (e) { onOnline(false); }
      setTimeout(poll, 2000);
    }
    const lock = () => { pin = ""; sessionStorage.removeItem("sharks-pin"); };
    return {
      kind: "server", orgMode: open ? "open" : "pin", isOrg: () => open || !!pin, signOut: lock,
      start() { take(first); setTimeout(poll, 2000); },
      async send(type, args) {
        const j = await post(type, args);
        if (!j.ok && j.code === "pin") lock();
        if (j.state) take(j);
        return j;
      },
      async signIn({ pin: p }) {
        const j = await post("auth.check", {}, p);
        if (j.ok) { pin = p; sessionStorage.setItem("sharks-pin", p); }
        return j.ok ? j : { ok: false, code: "pin", message: j.message || "That PIN is not right." };
      },
    };
  }

  /* ---------------- Firebase Realtime Database ---------------- */
  async function firebase(cfg, onState, onOnline) {
    const base = cfg.sdkBase || "https://www.gstatic.com/firebasejs/10.12.2/";      // sdkBase: the tests swap in a stand-in database
    const [{ initializeApp }, db, au] = await Promise.all([import(base + "firebase-app.js"), import(base + "firebase-database.js"), import(base + "firebase-auth.js")]);
    const fbApp = initializeApp(cfg), database = db.getDatabase(fbApp), auth = au.getAuth(fbApp);
    let state = Ladder.emptyState(), admins = {}, user = null, loaded = false, connected = true;
    const OFFLINE = { ok: false, code: "offline", message: "No connection, so that has not been saved. Try again when the connection is back." };
    const SLOW = { ok: false, code: "offline", message: "No reply from the database yet. Check the connection, then check the score before entering it again." };
    const timed = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(Object.assign({}, SLOW)), ms))]);
    const open = !!(window.LADDER_CONFIG || {}).openOrganiser;      // no login: the database rules must allow it too
    const isOrg = () => open || !!(user && admins[user.uid]);
    const emit = () => { if (loaded) onState({ state, urls: [] }); };
    const isObj = x => x !== null && typeof x === "object" && !Array.isArray(x);
    /* The database keys sessions by id so one game can be written on its own. */
    const toDb = st => { const o = clone(st), sessions = {}; o.sessions.forEach(s => { sessions[s.id] = s; }); o.sessions = sessions; return o; };
    /* Smallest set of path writes that turns a into b. Lists are written whole. */
    function diff(a, b, path, out) {
      if (isObj(a) && isObj(b)) { for (const k of new Set(Object.keys(a).concat(Object.keys(b)))) diff(a[k], b[k], path ? path + "/" + k : k, out); }
      /* a list of records of the same length (the pools) is compared record by record, so changing one pool's courts
         never rewrites another pool's round counter that a phone has just moved on */
      else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.length && a.every(isObj) && b.every(isObj)) a.forEach((x, i) => diff(x, b[i], path + "/" + i, out));
      else if (JSON.stringify(a) !== JSON.stringify(b)) out[path] = b === undefined ? null : b;
    }
    const authMessage = e => ({
      "auth/invalid-credential": "Email or password is not right.", "auth/wrong-password": "Email or password is not right.",
      "auth/user-not-found": "Email or password is not right.", "auth/invalid-email": "Enter a valid email address.",
      "auth/weak-password": "Use a password of at least 6 characters.", "auth/email-already-in-use": "That email already has an account. Sign in instead.",
      "auth/operation-not-allowed": "Email sign-in is not switched on in Firebase yet.", "auth/network-request-failed": "No connection. Try again.",
      "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
    }[e && e.code] || "Could not sign in. Try again.");

    async function scoreLive(type, args, sess) {
      const target = sess ? Ladder.gameTarget(state, sess, args.gid) : state.league.pointsToWin;
      let stop = null;
      try {
        if (type === "game.score") Ladder.checkScore(args);
        const res = await db.runTransaction(db.ref(database, `sessions/${args.sid}/games/${args.gid}`), cur => {
          stop = null;
          if (cur === null) return cur;                       // not loaded yet: the database retries with the real value
          try {
            if (type === "game.clear") { const rest = Object.assign({}, cur); delete rest.s1; delete rest.s2; delete rest.at; delete rest.auto; rest.status = "pending"; return rest; }
            return Ladder.scoreGame(Object.assign({ s1: null, s2: null }, cur), args, isOrg(), target);
          } catch (e) { stop = e; return undefined; }         // abort: nothing is written
        });
        if (stop) return failure(stop);
        if (!res.committed || !res.snapshot.exists()) return { ok: false, code: "missing", message: "Game not found." };
        return { ok: true, result: {} };
      } catch (e) { return failure(e); }
    }

    async function confirmLive(sess, args) {
      const idx = sess.pools.findIndex(p => p.id === args.pool), round = parseInt(args.round, 10);
      if (idx < 0) return { ok: false, code: "missing", message: "Pool not found." };
      if (!Ladder.roundReady(sess, sess.pools[idx], round)) return { ok: false, code: "scores", message: "Enter every score in this round first." };
      try {
        await db.runTransaction(db.ref(database, `sessions/${args.sid}/pools/${idx}/confirmed`), cur => ((cur || 0) === round ? round + 1 : undefined));
        return { ok: true, result: {} };
      } catch (e) { return failure(e); }
    }

    return {
      kind: "firebase", orgMode: open ? "open" : "account", isOrg,
      hasOrganiser: () => Object.keys(admins).length > 0,
      signedInNotOrganiser: () => !!user && !admins[user.uid],
      start() {
        db.onValue(db.ref(database, "/"), snap => {
          const raw = snap.val() || {};
          admins = raw.admins || {};
          const doc = Object.assign({}, raw); delete doc.admins;
          state = Ladder.normalize(doc);
          if (!Object.keys(state.ratings.current).length && Object.keys(state.players).length) state.ratings = Ladder.compute(state);
          loaded = true; emit();
        }, () => onOnline(false));
        db.onValue(db.ref(database, ".info/connected"), s => { connected = !!s.val(); if (loaded) onOnline(connected); });
        au.onAuthStateChanged(auth, u => { user = u; emit(); });
      },
      /* Offline, a database write would sit waiting for ever: say so at once, and give up waiting after 12 seconds.
         Anything that re-rates the league (finishing, reopening, correcting an old score) gets 90: this device works the
         ratings out itself, and on a phone that alone can pass 12 seconds, which would report a failure that was not one. */
      send(type, args) {
        const heavy = type === "session.close" || type === "session.reopen" || !!(args && args.history);
        return connected ? timed(this.sendNow(type, args), heavy ? 90000 : 12000) : Promise.resolve(Object.assign({}, OFFLINE));
      },
      async sendNow(type, args) {
        if (type === "game.score" || type === "game.clear" || type === "round.confirm") {
          const sess = state.sessions.find(s => s.id === args.sid);
          if (sess && sess.status === "live") return type === "round.confirm" ? confirmLive(sess, args) : scoreLive(type, args, sess);
        }
        if (!isOrg()) return { ok: false, code: "pin", message: "That needs the organiser to be signed in." };
        if (type === "round.back") {       // write just that pool's round, so other pools' confirms are never overwritten
          const sess = state.sessions.find(s => s.id === args.sid), idx = sess ? sess.pools.findIndex(p => p.id === args.pool) : -1;
          if (sess && sess.status === "live" && idx >= 0 && sess.pools[idx].confirmed > 0) {
            try {
              await db.runTransaction(db.ref(database, `sessions/${args.sid}/pools/${idx}/confirmed`), cur => (cur > 0 ? cur - 1 : undefined));
              return { ok: true, result: {} };
            } catch (e) { return failure(e); }
          }
        }
        if (type === "session.close") {
          /* Finish inside one database transaction on the session, so a score that lands at the same moment is either
             in before the session closes or refused after: never marked "not played". Ratings are then worked out
             from what the database actually holds. */
          let stop = null;
          try {
            const res = await db.runTransaction(db.ref(database, `sessions/${args.sid}`), cur => {
              stop = null;
              if (cur === null) return cur;
              try { return Ladder.closeSession(cur); } catch (e) { stop = e; return undefined; }
            });
            if (stop) return failure(stop);
            if (!res.committed || !res.snapshot.exists()) return { ok: false, code: "missing", message: "Session not found." };
            const doc = toDb(state);
            doc.sessions[args.sid] = res.snapshot.val();
            await db.update(db.ref(database), { ratings: Ladder.compute(Ladder.normalize(doc)), version: (state.version || 0) + 1 });
            return { ok: true, result: {} };
          } catch (e) { return failure(e); }
        }
        try {
          let base = state, next = clone(state), result = Ladder.apply(next, type, args, true);
          const zero = { p: 0, s: 0, g: 0 }, mine = Object.assign({}, zero, state.seq), need = {};
          for (const k in next.seq) if (next.seq[k] !== mine[k]) need[k] = next.seq[k] - (mine[k] || 0);
          if (Object.keys(need).length) {
            /* new ids (players, sessions, games) are reserved in the database first, so two organiser devices cannot mint the same one */
            let seen = null;
            const res = await db.runTransaction(db.ref(database, "seq"), cur => {
              seen = Object.assign({}, zero, cur || {});
              const o = Object.assign({}, seen);
              for (const k in need) o[k] = (o[k] || 0) + need[k];
              return o;
            });
            if (!res.committed) return { ok: false, code: "error", message: "Something went wrong. Check the connection and try again." };
            if (JSON.stringify(seen) !== JSON.stringify(mine)) {        // another device used ids since this copy: redo on its numbers
              base = clone(state); base.seq = seen;
              next = clone(base); result = Ladder.apply(next, type, args, true);
            }
          }
          const out = {};
          diff(toDb(base), toDb(next), "", out);
          if (Object.keys(out).length) await db.update(db.ref(database), out);
          return { ok: true, result };
        } catch (e) { return failure(e); }
      },
      async signIn({ email, password }) {
        try { await au.signInWithEmailAndPassword(auth, email, password); return { ok: true }; } catch (e) { return { ok: false, code: "auth", message: authMessage(e) }; }
      },
      async createOrganiser({ email, password }) {
        try {
          const cred = await au.createUserWithEmailAndPassword(auth, email, password);
          await db.set(db.ref(database, "admins/" + cred.user.uid), true);
          return { ok: true };
        } catch (e) { return { ok: false, code: "auth", message: /permission/i.test(String(e && (e.code || e.message))) ? "This league already has an organiser." : authMessage(e) }; }
      },
      signOut: () => au.signOut(auth),
      async replaceAll(doc) {
        if (!isOrg()) return { ok: false, code: "pin", message: "That needs the organiser to be signed in." };
        try {
          const st = Ladder.normalize(doc);
          st.ratings = Ladder.compute(st);
          const d = toDb(st);
          await db.update(db.ref(database), { league: d.league, players: d.players, seq: d.seq, sessions: d.sessions, ratings: d.ratings, version: d.version });
          return { ok: true };
        } catch (e) { return failure(e); }
      },
    };
  }

  async function pick(onState, onOnline) {
    const cfg = window.LADDER_CONFIG || {};
    if (cfg.firebase && cfg.firebase.databaseURL) {
      try { return await firebase(cfg.firebase, onState, onOnline); } catch (e) { console.error("Firebase could not start, falling back", e); }
    }
    try {
      const r = await fetch("api/state?v=", { cache: "no-store" });
      if (r.ok && (r.headers.get("content-type") || "").includes("json")) return server(onState, onOnline, await r.json());
    } catch (e) { /* no server here */ }
    return local(onState);
  }
  return { pick, firebase };
})();

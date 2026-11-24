/* A stand-in for the Firebase Realtime Database SDK, in memory, for tests/backend.test.js.
   It keeps one JSON tree, drops nulls and empty branches the way the real database does, and
   lets a test write "behind the app's back" (quiet) to play a second device. */
const fake = { data: {}, subs: [], connected: true, infoSubs: [] };
globalThis.__fakeDb = fake;

const parts = p => String(p || "").split("/").filter(Boolean);
const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
function clean(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  const out = Array.isArray(v) ? [] : {};
  let n = 0;
  for (const k of Object.keys(v)) { const c = clean(v[k]); if (c !== null) { out[k] = c; n++; } }
  return n ? out : null;
}
function valueAt(path) {
  let v = fake.data;
  for (const k of parts(path)) { if (v === null || typeof v !== "object" || !(k in v)) return null; v = v[k]; }
  return v === undefined ? null : v;
}
function setAt(path, value) {
  const ks = parts(path);
  if (!ks.length) { fake.data = value || {}; return; }
  let v = fake.data;
  ks.slice(0, -1).forEach(k => { if (v[k] === null || typeof v[k] !== "object") v[k] = {}; v = v[k]; });
  if (value === null || value === undefined) delete v[ks[ks.length - 1]]; else v[ks[ks.length - 1]] = clone(value);
}
const snap = path => { const v = clone(clean(valueAt(path))); return { val: () => v, exists: () => v !== null }; };
function settle(quiet) {
  fake.data = clean(fake.data) || {};
  if (!quiet) fake.subs.forEach(s => s.cb(snap(s.path)));
}
/* test helpers */
fake.write = (path, value, quiet) => { setAt(path, value); settle(quiet); };
fake.read = path => clone(clean(valueAt(path)));
fake.setConnected = on => { fake.connected = on; fake.infoSubs.forEach(cb => cb({ val: () => on })); };
fake.flush = () => settle(false);

export const getDatabase = () => ({});
export const ref = (db, path) => ({ path: path === undefined || path === "/" ? "" : path });
export function onValue(r, cb) {
  if (r.path === ".info/connected") { fake.infoSubs.push(cb); cb({ val: () => fake.connected }); return; }
  fake.subs.push({ path: r.path, cb });
  cb(snap(r.path));
}
export async function update(r, changes) {
  for (const k of Object.keys(changes)) setAt(r.path ? r.path + "/" + k : k, changes[k]);
  settle(false);
}
export async function set(r, value) { setAt(r.path, value); settle(false); }
export async function get(r) { return snap(r.path); }
export async function runTransaction(r, fn) {
  const next = fn(clone(clean(valueAt(r.path))));
  if (next === undefined) return { committed: false, snapshot: snap(r.path) };
  setAt(r.path, next);
  settle(false);
  return { committed: true, snapshot: snap(r.path) };
}

export const getAuth = () => ({ currentUser: null });
export const signInAnonymously = async auth => { auth.currentUser = { uid: "anon1", isAnonymous: true }; return { user: auth.currentUser }; };
export const onAuthStateChanged = (auth, cb) => cb(null);
export const signInWithEmailAndPassword = async () => { throw { code: "auth/invalid-credential" }; };
export const createUserWithEmailAndPassword = async () => { throw { code: "auth/operation-not-allowed" }; };
export const signOut = async () => {};

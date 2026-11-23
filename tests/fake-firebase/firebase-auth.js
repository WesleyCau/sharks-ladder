export const getAuth = () => ({});
export const onAuthStateChanged = (auth, cb) => cb(null);
export const signInWithEmailAndPassword = async () => { throw { code: "auth/invalid-credential" }; };
export const createUserWithEmailAndPassword = async () => { throw { code: "auth/operation-not-allowed" }; };
export const signOut = async () => {};

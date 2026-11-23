/* Firebase web app config: turns on shared live data.
   Set firebase to null and the site runs in single-device mode (data stays in this browser).
   These values are not secret: access is controlled by the database rules in database.rules.json. */
window.LADDER_CONFIG = {
  /* true: the Organiser tab needs no login (anyone with the link can manage the league).
     To bring the login back: set this to false and publish database.rules.login.json in Firebase. */
  openOrganiser: true,
  firebase: {
    apiKey: "AIzaSyBg_CHvrM8SJk94b6c5gVinSz58ck1fVZU",
    authDomain: "sharks-ladder.firebaseapp.com",
    databaseURL: "https://sharks-ladder-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "sharks-ladder",
    storageBucket: "sharks-ladder.firebasestorage.app",
    messagingSenderId: "436925978343",
    appId: "1:436925978343:web:dd5dbb3d7cde1a81ec3442",
  },
};

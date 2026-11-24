/* Firebase web app config: turns on shared live data.
   Set firebase to null and the site runs in single-device mode (data stays in this browser).
   These values are not secret: access is controlled by the database rules in database.rules.json. */
window.LADDER_CONFIG = {
  /* true: the Organiser tab needs no login (anyone with the link can manage the league).
     To bring the login back: set this to false and publish database.rules.login.json in Firebase. */
  openOrganiser: true,
  /* The front page behind the league name. photo and logo are files in docs/img. champion: last season's winner. */
  club: {
    kicker: "Southern Sharks Pickleball Club · Seaford Recreation Centre",
    headline: ["Climb.", "Defend.", "Repeat."],
    pitch: "The Ladder League: a competitive pickleball league.",
    photo: { src: "img/players.webp", alt: "Ladder League players lined up on court at the end of a night, paddles in hand", w: 1324, h: 540 },
    logo: { src: "img/ladder-league.png", alt: "Southern Sharks Pickleball Club Ladder League, a competitive pickleball league, Seaford Recreation Centre" },
    champion: { label: "Season 6 champion", name: "Josh Penny", rating: "4.377", note: "Top of the Season 6 ladder, ahead of Jack Burden (4.357) and Matthew Gioffre (4.166)" },
  },
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

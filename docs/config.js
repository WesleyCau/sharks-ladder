/* Firebase web app config: turns on shared live data.
   Set firebase to null and the site runs in single-device mode (data stays in this browser).
   These values are not secret: access is controlled by the database rules in database.rules.json. */
window.LADDER_CONFIG = {
  /* true: the Organiser tab needs no login (anyone with the link can manage the league).
     To bring the login back: set this to false and publish database.rules.login.json in Firebase. */
  openOrganiser: true,
  firebase: null,
};

const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const { findOrCreateUser } = require('../controllers/authController');
const { decodeState } = require('../utils/oauthState');

/**
 * To add another provider (Microsoft, Okta, etc.):
 *   1. `npm install passport-<provider>`
 *   2. Register a new `passport.use(new Strategy(...))` block below,
 *      following the same shape: pull tenantId out of req via `passReqToCallback`,
 *      map the provider's profile onto {providerId, email, displayName, avatarUrl},
 *      and call findOrCreateUser().
 *   3. Add matching routes in src/routes/auth.js (init + callback).
 */
function configurePassport() {
  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(
      'google',
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
          passReqToCallback: true
        },
        (req, accessToken, refreshToken, profile, done) => {
          try {
            const { tenantId } = decodeState(req.query.state);
            const email = profile.emails && profile.emails[0] && profile.emails[0].value;
            const user = findOrCreateUser({
              tenantId,
              provider: 'google',
              providerId: profile.id,
              email,
              displayName: profile.displayName,
              avatarUrl: profile.photos && profile.photos[0] && profile.photos[0].value
            });
            done(null, user);
          } catch (err) {
            done(err);
          }
        }
      )
    );
  }

  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    passport.use(
      'github',
      new GitHubStrategy(
        {
          clientID: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
          callbackURL: process.env.GITHUB_CALLBACK_URL || '/auth/github/callback',
          passReqToCallback: true
        },
        (req, accessToken, refreshToken, profile, done) => {
          try {
            const { tenantId } = decodeState(req.query.state);
            const email = profile.emails && profile.emails[0] && profile.emails[0].value;
            const user = findOrCreateUser({
              tenantId,
              provider: 'github',
              providerId: profile.id,
              email: email || `${profile.username}@users.noreply.github.com`,
              displayName: profile.displayName || profile.username,
              avatarUrl: profile.photos && profile.photos[0] && profile.photos[0].value
            });
            done(null, user);
          } catch (err) {
            done(err);
          }
        }
      )
    );
  }

  return passport;
}

module.exports = configurePassport;

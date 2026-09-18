const ConsoleSmsProvider = require('./providers/ConsoleSmsProvider');
const TelnyxProvider = require('./providers/TelnyxProvider');
const PlivoProvider = require('./providers/PlivoProvider');
const TwilioProvider = require('./providers/TwilioProvider');
const BirdProvider = require('./providers/BirdProvider');
const AwsSnsProvider = require('./providers/AwsSnsProvider');

/**
 * The one place in this app that reads SMS_PROVIDER and decides which
 * adapter to hand back. Every route/controller calls getSmsProvider()
 * and only ever talks to the SmsProvider interface -- switching providers
 * is changing this env var (and the matching credential env vars), not
 * touching a single line of application code.
 *
 * Builders are lazy and cached (one instance per process) so credentials
 * are only read/validated once, and so ConsoleSmsProvider's in-memory
 * sentMessages list is stable across a request lifecycle (useful in
 * tests -- see resetSmsProvider()).
 */
const BUILDERS = {
  console: () => new ConsoleSmsProvider(),
  telnyx: () =>
    new TelnyxProvider({
      apiKey: process.env.TELNYX_API_KEY,
      messagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID,
      publicKey: process.env.TELNYX_PUBLIC_KEY
    }),
  plivo: () => new PlivoProvider({ authId: process.env.PLIVO_AUTH_ID, authToken: process.env.PLIVO_AUTH_TOKEN }),
  twilio: () => new TwilioProvider({ accountSid: process.env.TWILIO_ACCOUNT_SID, authToken: process.env.TWILIO_AUTH_TOKEN }),
  bird: () => new BirdProvider({ accessKey: process.env.BIRD_ACCESS_KEY, signingKey: process.env.BIRD_SIGNING_KEY }),
  aws_sns: () => new AwsSnsProvider({ region: process.env.AWS_REGION })
};

let cachedProvider = null;
let cachedProviderName = null;

/**
 * Returns the active SmsProvider instance, per SMS_PROVIDER (defaults to
 * 'console' -- safe for local dev, never touches a real network).
 * Re-reads SMS_PROVIDER if it's changed since the last call (mainly for
 * tests that swap providers mid-suite); otherwise returns the cached
 * instance.
 */
function getSmsProvider() {
  const providerName = (process.env.SMS_PROVIDER || 'console').toLowerCase();

  if (cachedProvider && cachedProviderName === providerName) return cachedProvider;

  const builder = BUILDERS[providerName];
  if (!builder) {
    throw new Error(`Unknown SMS_PROVIDER "${providerName}". Valid options: ${Object.keys(BUILDERS).join(', ')}`);
  }

  cachedProvider = builder();
  cachedProviderName = providerName;
  return cachedProvider;
}

/** Test-only: clears the cached provider instance so the next getSmsProvider() call rebuilds it (e.g. after changing SMS_PROVIDER or credential env vars mid-test-run). */
function resetSmsProvider() {
  cachedProvider = null;
  cachedProviderName = null;
}

/**
 * Returns a fresh instance of a SPECIFICALLY NAMED provider, regardless of
 * which one is currently active via SMS_PROVIDER. Used by the inbound/
 * status webhook routes, whose URL already names the provider
 * (`/webhooks/sms/:provider/...`) -- this matters during a provider
 * migration, where you might still be receiving webhooks from an old
 * provider for a while after SMS_PROVIDER has already switched to a new
 * one for outbound sends.
 */
function getSmsProviderByName(providerName) {
  const builder = BUILDERS[(providerName || '').toLowerCase()];
  if (!builder) {
    throw new Error(`Unknown SMS provider "${providerName}". Valid options: ${Object.keys(BUILDERS).join(', ')}`);
  }
  return builder();
}

module.exports = { getSmsProvider, getSmsProviderByName, resetSmsProvider, PROVIDER_NAMES: Object.keys(BUILDERS) };

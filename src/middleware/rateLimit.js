/**
 * Minimal in-memory fixed-window rate limiter -- no Redis or other
 * external dependency needed for this app's scale, consistent with
 * everything else in this codebase being in-memory for now.
 *
 * Each call to createRateLimiter() returns an independent middleware
 * instance with its own hit-counter map, so different routes (or the same
 * route with different limits) don't share state. The returned middleware
 * also exposes a `.reset()` method that clears its counters -- tests use
 * this to start from a clean slate rather than the limiter's behavior
 * silently changing based on NODE_ENV, which would make "does this pass in
 * production" and "does this pass in tests" two different questions.
 *
 * Memory grows with the number of distinct keys seen (e.g. distinct IPs)
 * since the process started -- fine at this app's scale, but a real
 * deployment under sustained traffic from many distinct clients should
 * move this to Redis (or any store with native TTLs) rather than rely on
 * this ever being swept, the same caveat already noted for
 * TokenBlocklist/refreshTokens in README.
 */
function createRateLimiter({ windowMs, max, keyFn = (req) => req.ip, message = 'Too many requests -- please try again later.' }) {
  let hits = new Map();

  function middleware(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  }

  middleware.reset = () => {
    hits = new Map();
  };

  return middleware;
}

module.exports = createRateLimiter;

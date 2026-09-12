const createRateLimiter = require('../../src/middleware/rateLimit');

function mockReqRes(ip = '1.2.3.4') {
  const req = { ip };
  const res = {
    headers: {},
    set(key, value) {
      this.headers[key] = value;
      return this;
    },
    status(code) {
      this._status = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    }
  };
  return { req, res };
}

describe('rateLimit', () => {
  test('allows up to max requests, then 429s within the same window', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 3 });
    let allowed = 0;

    for (let i = 0; i < 3; i += 1) {
      const { req, res } = mockReqRes();
      limiter(req, res, () => {
        allowed += 1;
      });
      expect(res._status).toBeUndefined();
    }

    const { req, res } = mockReqRes();
    limiter(req, res, () => {
      allowed += 1;
    });

    expect(allowed).toBe(3);
    expect(res._status).toBe(429);
    expect(res.headers['Retry-After']).toBeDefined();
  });

  test('tracks separate buckets per key (e.g. per IP)', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 1 });

    const first = mockReqRes('1.1.1.1');
    limiter(first.req, first.res, () => {});
    const second = mockReqRes('2.2.2.2');
    let secondAllowed = false;
    limiter(second.req, second.res, () => {
      secondAllowed = true;
    });

    expect(secondAllowed).toBe(true);
  });

  test('reset() clears all counters immediately', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 1 });
    const first = mockReqRes();
    limiter(first.req, first.res, () => {});

    const blocked = mockReqRes();
    limiter(blocked.req, blocked.res, () => {});
    expect(blocked.res._status).toBe(429);

    limiter.reset();

    const afterReset = mockReqRes();
    let allowed = false;
    limiter(afterReset.req, afterReset.res, () => {
      allowed = true;
    });
    expect(allowed).toBe(true);
  });

  test('allows requests again once the window has elapsed', (done) => {
    const limiter = createRateLimiter({ windowMs: 30, max: 1 });
    const first = mockReqRes();
    limiter(first.req, first.res, () => {});

    setTimeout(() => {
      const second = mockReqRes();
      let allowed = false;
      limiter(second.req, second.res, () => {
        allowed = true;
      });
      expect(allowed).toBe(true);
      done();
    }, 60);
  });

  test('uses a custom keyFn when provided', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 1, keyFn: (req) => req.tokenParam });
    const first = { req: { tokenParam: 'token-a' }, res: mockReqRes().res };
    limiter(first.req, first.res, () => {});

    const secondSameToken = { req: { tokenParam: 'token-a' }, res: mockReqRes().res };
    limiter(secondSameToken.req, secondSameToken.res, () => {});
    expect(secondSameToken.res._status).toBe(429);

    const differentToken = { req: { tokenParam: 'token-b' }, res: mockReqRes().res };
    let allowed = false;
    limiter(differentToken.req, differentToken.res, () => {
      allowed = true;
    });
    expect(allowed).toBe(true);
  });
});

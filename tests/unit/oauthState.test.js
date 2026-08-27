const { encodeState, decodeState } = require('../../src/utils/oauthState');

describe('oauthState utils', () => {
  test('round-trips arbitrary data', () => {
    const state = encodeState({ tenantId: 'abc-123', extra: 'value' });
    const decoded = decodeState(state);

    expect(decoded).toEqual({ tenantId: 'abc-123', extra: 'value' });
  });

  test('throws when state is missing', () => {
    expect(() => decodeState(undefined)).toThrow(/Missing OAuth state/);
  });

  test('throws when state is not valid base64/JSON', () => {
    expect(() => decodeState('!!!not-valid!!!')).toThrow(/Invalid OAuth state/);
  });

  test('throws when decoded state has no tenantId', () => {
    const state = encodeState({ foo: 'bar' });
    expect(() => decodeState(state)).toThrow(/missing tenantId/);
  });
});

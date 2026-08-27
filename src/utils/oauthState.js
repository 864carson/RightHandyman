/**
 * OAuth "state" param helper.
 *
 * When a login flow starts, we need to remember which tenant initiated it
 * so the callback (which only gets provider data back) can create/find the
 * user in the right tenant. We encode that context into the `state` param
 * that providers echo back unchanged.
 */

function encodeState(data) {
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
}

function decodeState(state) {
  if (!state) {
    throw new Error('Missing OAuth state parameter');
  }

  try {
    const json = Buffer.from(state, 'base64url').toString('utf8');
    const data = JSON.parse(json);
    if (!data || !data.tenantId) {
      throw new Error('OAuth state is missing tenantId');
    }
    return data;
  } catch (err) {
    throw new Error(`Invalid OAuth state parameter: ${err.message}`);
  }
}

module.exports = { encodeState, decodeState };

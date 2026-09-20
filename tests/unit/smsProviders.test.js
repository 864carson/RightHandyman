const SmsProvider = require('../../src/services/sms/SmsProvider');
const ConsoleSmsProvider = require('../../src/services/sms/providers/ConsoleSmsProvider');
const TelnyxProvider = require('../../src/services/sms/providers/TelnyxProvider');
const PlivoProvider = require('../../src/services/sms/providers/PlivoProvider');
const TwilioProvider = require('../../src/services/sms/providers/TwilioProvider');
const BirdProvider = require('../../src/services/sms/providers/BirdProvider');
const AwsSnsProvider = require('../../src/services/sms/providers/AwsSnsProvider');

describe('SmsProvider base class', () => {
  test('every unimplemented method throws clearly rather than doing nothing', async () => {
    const provider = new SmsProvider();
    expect(() => provider.name).toThrow(/must implement/);
    await expect(provider.send({})).rejects.toThrow(/must implement/);
    expect(() => provider.parseInboundWebhook({})).toThrow(/must implement/);
    expect(() => provider.parseStatusWebhook({})).toThrow(/must implement/);
  });

  test('verifyWebhookSignature defaults to unverified rather than throwing (so callers can decide policy)', () => {
    const provider = new SmsProvider();
    const result = provider.verifyWebhookSignature('{}', {});
    expect(result.verified).toBe(false);
  });
});

describe('ConsoleSmsProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new ConsoleSmsProvider();
  });

  test('send() records the message and returns a normalized result, no network involved', async () => {
    const result = await provider.send({ to: '+15551234567', from: '+15559998888', text: 'hello' });
    expect(result.status).toBe('sent');
    expect(result.providerMessageId).toBeDefined();
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].text).toBe('hello');
  });

  test('parseInboundWebhook / parseStatusWebhook round-trip its own simple format', () => {
    const inbound = provider.parseInboundWebhook({ from: '+1555', to: '+1556', text: 'hi', messageId: 'm1' });
    expect(inbound).toEqual({ fromNumber: '+1555', toNumber: '+1556', text: 'hi', providerMessageId: 'm1', receivedAt: expect.any(String) });

    const status = provider.parseStatusWebhook({ messageId: 'm1', status: 'delivered' });
    expect(status.providerMessageId).toBe('m1');
    expect(status.status).toBe('delivered');
  });

  test('verifyWebhookSignature is always true (no real security needed for a dev-only provider)', () => {
    expect(provider.verifyWebhookSignature().verified).toBe(true);
  });

  test('reset() clears sentMessages', async () => {
    await provider.send({ to: '+1555', from: '+1556', text: 'x' });
    provider.reset();
    expect(provider.sentMessages).toHaveLength(0);
  });
});

describe('TelnyxProvider', () => {
  test('name is "telnyx"', () => {
    expect(new TelnyxProvider({ apiKey: 'x' }).name).toBe('telnyx');
  });

  test('send() throws a clear install message when the "telnyx" package is not installed', async () => {
    const provider = new TelnyxProvider({ apiKey: 'x' });
    await expect(provider.send({ to: '+1', from: '+1', text: 'hi' })).rejects.toThrow(/npm install telnyx/);
  });

  test('send() throws clearly when no API key is configured (before ever touching the SDK)', async () => {
    const provider = new TelnyxProvider({});
    await expect(provider.send({ to: '+1', from: '+1', text: 'hi' })).rejects.toThrow(/TELNYX_API_KEY/);
  });

  test('send() works when the SDK is mocked (proves the adapter\'s own request/response handling is correct)', async () => {
    jest.resetModules();
    jest.doMock(
      'telnyx',
      () => ({
        Telnyx: jest.fn().mockImplementation(() => ({
          messages: { create: jest.fn().mockResolvedValue({ data: { id: 'telnyx-msg-123' } }) }
        }))
      }),
      { virtual: true }
    );
    const FreshTelnyxProvider = require('../../src/services/sms/providers/TelnyxProvider');
    const provider = new FreshTelnyxProvider({ apiKey: 'test-key', messagingProfileId: 'profile-1' });

    const result = await provider.send({ to: '+15551234567', from: '+15559998888', text: 'hello' });
    expect(result.providerMessageId).toBe('telnyx-msg-123');
    expect(result.status).toBe('queued');

    jest.dontMock('telnyx');
    jest.resetModules();
  });

  test('parseInboundWebhook extracts from/to/text from Telnyx\'s nested payload shape', () => {
    const provider = new TelnyxProvider({ apiKey: 'x' });
    const result = provider.parseInboundWebhook({
      data: { payload: { from: { phone_number: '+15551234567' }, to: [{ phone_number: '+15559998888' }], text: 'hi', id: 'msg_1' } }
    });
    expect(result).toEqual({ fromNumber: '+15551234567', toNumber: '+15559998888', text: 'hi', providerMessageId: 'msg_1', receivedAt: expect.any(String) });
  });

  test('parseStatusWebhook maps Telnyx statuses to this app\'s normalized set', () => {
    const provider = new TelnyxProvider({ apiKey: 'x' });
    const delivered = provider.parseStatusWebhook({ data: { payload: { id: 'msg_1', to: [{ status: 'delivered' }] } } });
    expect(delivered.status).toBe('delivered');
    const failed = provider.parseStatusWebhook({ data: { payload: { id: 'msg_1', to: [{ status: 'delivery_failed' }], errors: [{ detail: 'bad number' }] } } });
    expect(failed.status).toBe('failed');
    expect(failed.errorMessage).toMatch(/bad number/);
  });

  test('verifyWebhookSignature: unconfigured, missing headers, and a real ed25519 keypair round-trip', () => {
    const { generateKeyPairSync, sign } = require('crypto');
    const unconfigured = new TelnyxProvider({ apiKey: 'x' });
    expect(unconfigured.verifyWebhookSignature('{}', {}).verified).toBe(false);

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const provider = new TelnyxProvider({ apiKey: 'x', publicKey: publicKeyDer });

    expect(provider.verifyWebhookSignature('{}', {}).verified).toBe(false); // missing signature headers

    const rawBody = JSON.stringify({ data: { event_type: 'message.received' } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(`${timestamp}|${rawBody}`), privateKey).toString('base64');

    const validResult = provider.verifyWebhookSignature(rawBody, { 'telnyx-signature-ed25519': signature, 'telnyx-timestamp': timestamp });
    expect(validResult.verified).toBe(true);

    const tamperedResult = provider.verifyWebhookSignature(rawBody + 'tampered', {
      'telnyx-signature-ed25519': signature,
      'telnyx-timestamp': timestamp
    });
    expect(tamperedResult.verified).toBe(false);
  });
});

describe('PlivoProvider', () => {
  test('send() throws a clear install message when "plivo" is not installed', async () => {
    const provider = new PlivoProvider({ authId: 'x', authToken: 'y' });
    await expect(provider.send({ to: '+1', from: '+1', text: 'hi' })).rejects.toThrow(/npm install plivo/);
  });

  test('send() throws clearly when credentials are missing', async () => {
    const provider = new PlivoProvider({});
    await expect(provider.send({ to: '+1', from: '+1', text: 'hi' })).rejects.toThrow(/PLIVO_AUTH_ID/);
  });

  test('parseInboundWebhook / parseStatusWebhook use Plivo\'s PascalCase field names', () => {
    const provider = new PlivoProvider({ authId: 'x', authToken: 'y' });
    const inbound = provider.parseInboundWebhook({ From: '+15551234567', To: '+15559998888', Text: 'hi', MessageUUID: 'uuid-1' });
    expect(inbound.fromNumber).toBe('+15551234567');
    expect(inbound.providerMessageId).toBe('uuid-1');

    const status = provider.parseStatusWebhook({ MessageUUID: 'uuid-1', Status: 'delivered' });
    expect(status.status).toBe('delivered');
  });

  test('verifyWebhookSignature: real HMAC round-trip, tamper detection, and missing-fullUrl handling', () => {
    const { createHmac } = require('crypto');
    const provider = new PlivoProvider({ authId: 'x', authToken: 'secret-token' });
    const fullUrl = 'https://myapp.com/webhooks/sms/plivo/status';
    const nonce = 'nonce-1';
    const validSig = createHmac('sha256', 'secret-token').update(fullUrl + nonce).digest('base64');

    expect(
      provider.verifyWebhookSignature('{}', { 'x-plivo-signature-v2': validSig, 'x-plivo-signature-v2-nonce': nonce }, fullUrl).verified
    ).toBe(true);
    expect(
      provider.verifyWebhookSignature('{}', { 'x-plivo-signature-v2': 'wrong', 'x-plivo-signature-v2-nonce': nonce }, fullUrl).verified
    ).toBe(false);
    expect(provider.verifyWebhookSignature('{}', { 'x-plivo-signature-v2': validSig, 'x-plivo-signature-v2-nonce': nonce }).verified).toBe(
      false
    ); // no fullUrl
  });
});

describe('TwilioProvider', () => {
  test('send() throws a clear install message when "twilio" is not installed', async () => {
    const provider = new TwilioProvider({ accountSid: 'AC1', authToken: 'y' });
    await expect(provider.send({ to: '+1', from: '+1', text: 'hi' })).rejects.toThrow(/npm install twilio/);
  });

  test('send() works when the SDK is mocked', async () => {
    jest.resetModules();
    const mockClient = { messages: { create: jest.fn().mockResolvedValue({ sid: 'SM123' }) } };
    const mockTwilioFactory = jest.fn().mockReturnValue(mockClient);
    mockTwilioFactory.validateRequest = jest.fn().mockReturnValue(true);
    jest.doMock('twilio', () => mockTwilioFactory, { virtual: true });

    const FreshTwilioProvider = require('../../src/services/sms/providers/TwilioProvider');
    const provider = new FreshTwilioProvider({ accountSid: 'AC1', authToken: 'secret' });

    const result = await provider.send({ to: '+15551234567', from: '+15559998888', text: 'hello' });
    expect(result.providerMessageId).toBe('SM123');
    expect(mockClient.messages.create).toHaveBeenCalledWith({ to: '+15551234567', from: '+15559998888', body: 'hello' });

    // signature verification delegates to the SDK's own helper
    const sigResult = provider.verifyWebhookSignature({ Body: 'hi' }, { 'x-twilio-signature': 'sig' }, 'https://myapp.com/webhooks/sms/twilio/inbound');
    expect(sigResult.verified).toBe(true);
    expect(mockTwilioFactory.validateRequest).toHaveBeenCalled();

    jest.dontMock('twilio');
    jest.resetModules();
  });

  test('parseInboundWebhook / parseStatusWebhook use Twilio\'s PascalCase field names', () => {
    const provider = new TwilioProvider({ accountSid: 'AC1', authToken: 'y' });
    const inbound = provider.parseInboundWebhook({ From: '+15551234567', To: '+15559998888', Body: 'hi there', MessageSid: 'SM123' });
    expect(inbound.text).toBe('hi there');
    expect(inbound.providerMessageId).toBe('SM123');

    const status = provider.parseStatusWebhook({ MessageSid: 'SM123', MessageStatus: 'delivered' });
    expect(status.status).toBe('delivered');
    const failedStatus = provider.parseStatusWebhook({ MessageSid: 'SM123', MessageStatus: 'undelivered', ErrorCode: '30003' });
    expect(failedStatus.status).toBe('failed');
    expect(failedStatus.errorMessage).toMatch(/30003/);
  });

  test('verifyWebhookSignature requires a signature header and a fullUrl', () => {
    const provider = new TwilioProvider({ accountSid: 'AC1', authToken: 'y' });
    expect(provider.verifyWebhookSignature({}, {}).verified).toBe(false);
  });
});

describe('BirdProvider', () => {
  test('send() throws a clear install message when "messagebird" is not installed', async () => {
    const provider = new BirdProvider({ accessKey: 'x' });
    expect(() =>
      provider.send({ to: '+1', from: '+1', text: 'hi' })
    ).toThrow(
      'The "messagebird" package is not installed. Run: npm install messagebird'
    );
  });

  test('parseInboundWebhook / parseStatusWebhook use Bird\'s field names', () => {
    const provider = new BirdProvider({ accessKey: 'x' });
    const inbound = provider.parseInboundWebhook({ originator: '+15551234567', recipient: '+15559998888', body: 'hey', id: 'msg1' });
    expect(inbound.fromNumber).toBe('+15551234567');
    expect(inbound.text).toBe('hey');

    const status = provider.parseStatusWebhook({ id: 'msg1', status: 'delivered' });
    expect(status.status).toBe('delivered');
  });

  test('verifyWebhookSignature: real HMAC round-trip and tamper detection', () => {
    const { createHmac } = require('crypto');
    const provider = new BirdProvider({ accessKey: 'x', signingKey: 'sk' });
    const rawBody = JSON.stringify({ id: 'msg1', originator: '+1555', recipient: '+1556', body: 'hey' });
    const validSig = createHmac('sha256', 'sk').update(rawBody).digest('hex');

    expect(provider.verifyWebhookSignature(rawBody, { 'bird-signature': validSig }).verified).toBe(true);
    expect(provider.verifyWebhookSignature(rawBody, { 'bird-signature': 'a'.repeat(validSig.length) }).verified).toBe(false);
  });

  test('verifyWebhookSignature is unverified without a configured signing key', () => {
    const provider = new BirdProvider({ accessKey: 'x' });
    expect(provider.verifyWebhookSignature('{}', { 'bird-signature': 'anything' }).verified).toBe(false);
  });
});

describe('AwsSnsProvider', () => {
  test('name is "aws_sns"', () => {
    expect(new AwsSnsProvider({ region: 'us-east-1' }).name).toBe('aws_sns');
  });

  test('send() throws a clear install message when "@aws-sdk/client-sns" is not installed', async () => {
    const provider = new AwsSnsProvider({ region: 'us-east-1' });
    expect(() => provider.send({ to: '+1', from: '+1', text: 'hi' })).rejects.toThrow(/npm install @aws-sdk\/client-sns/);
  });

  test('send() throws clearly when AWS_REGION is missing', async () => {
    const provider = new AwsSnsProvider({});
    await expect(provider.send({ to: '+1', text: 'hi' })).rejects.toThrow(/AWS_REGION/);
  });

  test('parseInboundWebhook and parseStatusWebhook throw explaining the architectural gap, rather than pretending to support something SNS plain SMS doesn\'t', () => {
    const provider = new AwsSnsProvider({ region: 'us-east-1' });
    expect(() => provider.parseInboundWebhook()).toThrow(/End User Messaging/);
    expect(() => provider.parseStatusWebhook()).toThrow(/CloudWatch/);
  });

  test('verifyWebhookSignature is always unverified (no webhooks exist for this provider)', () => {
    const provider = new AwsSnsProvider({ region: 'us-east-1' });
    expect(provider.verifyWebhookSignature().verified).toBe(false);
  });
});

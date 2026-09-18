const SmsProvider = require('../SmsProvider');

/**
 * AWS SNS adapter. Requires `@aws-sdk/client-sns`
 * (`npm install @aws-sdk/client-sns`), lazily required -- see
 * TelnyxProvider.js for why. Send-only: AWS SNS's plain SMS API has no
 * webhook for inbound replies or delivery status the way every other
 * provider here does -- receiving inbound texts on AWS requires a
 * different, heavier setup (AWS End User Messaging / Pinpoint with a
 * dedicated origination number and its own event stream), which is out
 * of scope for this adapter. `parseInboundWebhook`/`parseStatusWebhook`
 * intentionally throw rather than pretend to support something SNS
 * doesn't actually do this way -- if you need two-way texting, this is
 * the one provider on this list that isn't a drop-in fit for it (see the
 * linked research issue's own notes on this).
 *
 * Config (env vars, see .env.example):
 *   AWS_REGION (required)
 *   Standard AWS credential resolution otherwise (env vars, shared
 *   credentials file, IAM role, etc.) -- this adapter does not read a
 *   custom credentials env var, it lets the AWS SDK's normal credential
 *   chain handle it, which is the standard AWS practice.
 */
class AwsSnsProvider extends SmsProvider {
  constructor({ region } = {}) {
    super();
    this.region = region;
    this._client = null;
  }

  get name() {
    return 'aws_sns';
  }

  _getClient() {
    if (this._client) return this._client;
    if (!this.region) throw new Error('AWS_REGION is not set');

    let SNSClient;
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      ({ SNSClient } = require('@aws-sdk/client-sns'));
    } catch (err) {
      throw new Error('The "@aws-sdk/client-sns" package is not installed. Run: npm install @aws-sdk/client-sns');
    }
    this._client = new SNSClient({ region: this.region });
    return this._client;
  }

  async send({ to, text }) {
    // eslint-disable-next-line global-require
    const { PublishCommand } = require('@aws-sdk/client-sns');
    const client = this._getClient();
    const response = await client.send(new PublishCommand({ PhoneNumber: to, Message: text }));
    return { providerMessageId: response.MessageId, status: 'sent', raw: response };
  }

  parseInboundWebhook() {
    throw new Error(
      'AWS SNS plain SMS has no inbound-message webhook -- receiving replies requires AWS End User Messaging/Pinpoint, a different setup entirely. See this adapter\'s file comment.'
    );
  }

  parseStatusWebhook() {
    throw new Error(
      'AWS SNS plain SMS delivery status requires subscribing to a delivery-status SNS topic and CloudWatch, not a simple webhook -- not implemented by this adapter.'
    );
  }

  verifyWebhookSignature() {
    return { verified: false, reason: 'AWS SNS plain SMS does not send webhooks to verify -- see parseInboundWebhook/parseStatusWebhook' };
  }
}

module.exports = AwsSnsProvider;

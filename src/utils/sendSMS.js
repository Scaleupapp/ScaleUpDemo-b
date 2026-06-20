'use strict';

async function sendSMS(to, body) {
  const client = module.exports._client || require('../config/twilio');
  return client.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to, body });
}

sendSMS._client = null; // tests reassign; null → lazy real client

module.exports = sendSMS;

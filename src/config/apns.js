const http2 = require('http2');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

// APNs configuration
const APNS_KEY_ID = process.env.APNS_KEY_ID || '26S38JMTT4';
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || 'NK5P69WG2H';
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.scaleupapp.ios';
const APNS_PRODUCTION = process.env.APNS_PRODUCTION !== 'false';

const APNS_HOST = APNS_PRODUCTION
  ? 'api.push.apple.com'
  : 'api.sandbox.push.apple.com';

let apnsKey = null;

// Load the .p8 key
function loadKey() {
  if (apnsKey) return apnsKey;

  const keyPaths = [
    process.env.APNS_KEY_PATH,
    path.join(__dirname, `../../AuthKey_${APNS_KEY_ID}.p8`),
    path.join(__dirname, `../../../AuthKey_${APNS_KEY_ID}.p8`),
  ].filter(Boolean);

  for (const p of keyPaths) {
    try {
      apnsKey = fs.readFileSync(p, 'utf8');
      console.log(`APNs key loaded from: ${p}`);
      return apnsKey;
    } catch (_) {
      // Try next path
    }
  }

  console.warn('APNs key not found. Push notifications via APNs will not work.');
  return null;
}

// Generate JWT token for APNs
let cachedToken = null;
let tokenTimestamp = 0;

function getToken() {
  const now = Math.floor(Date.now() / 1000);

  // Refresh token every 50 minutes (APNs tokens expire after 60 min)
  if (cachedToken && (now - tokenTimestamp) < 3000) {
    return cachedToken;
  }

  const key = loadKey();
  if (!key) return null;

  cachedToken = jwt.sign({ iss: APNS_TEAM_ID, iat: now }, key, {
    algorithm: 'ES256',
    header: {
      alg: 'ES256',
      kid: APNS_KEY_ID,
    },
  });

  tokenTimestamp = now;
  return cachedToken;
}

// Send push notification via APNs HTTP/2
async function send(deviceToken, { title, body, data = {} }) {
  const token = getToken();
  if (!token) {
    console.warn('APNs: No auth token available, skipping push');
    return null;
  }

  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${APNS_HOST}`);

    const payload = JSON.stringify({
      aps: {
        alert: { title, body },
        sound: 'default',
        badge: 1,
      },
      ...data,
    });

    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${token}`,
      'apns-topic': APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': '0',
    };

    const req = client.request(headers);

    let responseData = '';
    let statusCode = 0;

    req.on('response', (headers) => {
      statusCode = headers[':status'];
    });

    req.on('data', (chunk) => {
      responseData += chunk;
    });

    req.on('end', () => {
      client.close();
      if (statusCode === 200) {
        console.log(`APNs push sent successfully to ${deviceToken.substring(0, 10)}...`);
        resolve({ success: true });
      } else {
        console.error(`APNs push failed (${statusCode}):`, responseData);
        reject(new Error(`APNs error ${statusCode}: ${responseData}`));
      }
    });

    req.on('error', (err) => {
      client.close();
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

module.exports = { send };

// pump-controller/bridge/bridge.js
// Bridges HiveMQ Cloud <-> Firebase Realtime DB for 2 pumps

const mqtt  = require('mqtt');
const admin = require('firebase-admin');

// ─── Firebase init ────────────────────────────────────────────────────────────
// On Railway: set FIREBASE_SERVICE_ACCOUNT env var to the full JSON content
//             of serviceAccountKey.json (paste the whole file as one line).
// Locally:    set the same env var, or fall back to serviceAccountKey.json file.
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL || 'https://pump-controller-4398d-default-rtdb.firebaseio.com'
});
const db = admin.database();

// ─── broker.emqx.io connection (anonymous public TLS) ────────────────────────
const BROKER_URL = 'mqtts://broker.emqx.io:8883';

const mqttClient = mqtt.connect(BROKER_URL, {
  clientId:          'bridge_node_' + Math.random().toString(16).slice(2, 8),
  rejectUnauthorized: false,
  keepalive:         60,
  reconnectPeriod:   3000
});

// ─── Topics ───────────────────────────────────────────────────────────────────
const PUMPS = ['pump01', 'pump02'];

const TOPICS_SUB = [
  'pump/01/status', 'pump/01/alerts',
  'pump/02/status', 'pump/02/alerts'
];

// pump/01/status  ->  { pumpId: 'pump01', type: 'status' }
function topicToFirebase(topic) {
  const parts = topic.split('/');
  return { pumpId: 'pump' + parts[1], type: parts[2] };
}

// ─── MQTT events ──────────────────────────────────────────────────────────────
mqttClient.on('connect', () => {
  console.log('[MQTT] Connected to broker.emqx.io');
  mqttClient.subscribe(TOPICS_SUB, { qos: 1 }, (err) => {
    if (err) console.error('[MQTT] Subscribe error:', err);
    else     console.log('[MQTT] Subscribed to:', TOPICS_SUB);
  });
});

mqttClient.on('reconnect', () => console.log('[MQTT] Reconnecting...'));
mqttClient.on('error',     (err) => console.error('[MQTT] Error:', err.message));

// ─── EC200U publishes status/alerts → write to Firebase ──────────────────────
const lastSeen = { pump01: 0, pump02: 0 };

mqttClient.on('message', (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    const { pumpId, type } = topicToFirebase(topic);
    payload.ts = Date.now();

    db.ref(`pumps/${pumpId}/${type}`).set(payload)
      .then(()  => console.log(`[FB] Written pumps/${pumpId}/${type}`))
      .catch(err => console.error('[FB] Write error:', err.message));

    if (type === 'status') {
      lastSeen[pumpId] = Date.now();
    }
  } catch (e) {
    console.error('[MQTT] Parse error:', e.message, '| raw:', message.toString());
  }
});

// ─── Firebase → MQTT relay commands ──────────────────────────────────────────
// initialized flag prevents re-sending the last stored command when the
// bridge starts (or restarts) and the Firebase listener fires its initial read.
PUMPS.forEach((pumpId) => {
  const mqttNum  = pumpId.replace('pump', ''); // pump01 -> 01
  const cmdTopic = `pump/${mqttNum}/cmd`;
  const fbPath   = `pumps/${pumpId}/cmd`;
  let initialized = false;

  db.ref(fbPath).on('value', (snapshot) => {
    if (!initialized) {
      initialized = true;
      return; // skip initial read on startup — only forward new writes
    }

    const cmd = snapshot.val();
    if (!cmd) return;

    const payload = JSON.stringify({
      relay1: cmd.relay1 ?? 0,
      relay2: cmd.relay2 ?? 0
    });

    mqttClient.publish(cmdTopic, payload, { qos: 1 }, (err) => {
      if (err) console.error(`[MQTT] Publish error on ${cmdTopic}:`, err.message);
      else     console.log(`[MQTT] Command sent → ${cmdTopic}:`, payload);
    });
  });

  console.log(`[FB] Listening for commands on ${fbPath}`);
});

// ─── Offline detection — mark pump offline if no status for 30 s ─────────────
setInterval(() => {
  const now = Date.now();
  PUMPS.forEach((pumpId) => {
    if (lastSeen[pumpId] && now - lastSeen[pumpId] > 30000) {
      db.ref(`pumps/${pumpId}/status/online`).set(false)
        .catch(() => {});
    }
  });
}, 15000);

console.log('[Bridge] Running. Waiting for MQTT connection...');

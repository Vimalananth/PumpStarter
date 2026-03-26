// pump-controller/bridge/bridge.js
// Bridges HiveMQ Cloud <-> Firebase Realtime DB for 2 pumps

const mqtt  = require('mqtt');
const admin = require('firebase-admin');

// ─── Firebase init ────────────────────────────────────────────────────────────
// On Railway: set FIREBASE_SERVICE_ACCOUNT env var to the full JSON content
//             of serviceAccountKey.json (paste the whole file as one line).
// Locally:    set the same env var, or fall back to serviceAccountKey.json file.
console.log('[Init] FIREBASE_SERVICE_ACCOUNT set:', !!process.env.FIREBASE_SERVICE_ACCOUNT);
console.log('[Init] FIREBASE_DB_URL:', process.env.FIREBASE_DB_URL || '(using default)');

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  throw new Error('FIREBASE_SERVICE_ACCOUNT env var is not set. Set it in Railway Variables tab.');
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
  'pump/01/status', 'pump/01/alerts', 'pump/01/ota/status',
  'pump/02/status', 'pump/02/alerts', 'pump/02/ota/status'
];

// pump/01/status        ->  { pumpId: 'pump01', type: 'status' }
// pump/01/ota/status    ->  { pumpId: 'pump01', type: 'ota/status' }
function topicToFirebase(topic) {
  const parts = topic.split('/');
  return { pumpId: 'pump' + parts[1], type: parts.slice(2).join('/') };
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

    if (type === 'ota/status') {
      // OTA progress/result — write to pumps/pump01/ota_status
      db.ref(`pumps/${pumpId}/ota_status`).set(payload)
        .then(()  => console.log(`[FB] Written pumps/${pumpId}/ota_status`))
        .catch(err => console.error('[FB] Write error:', err.message));
      // Clear retained OTA message so board doesn't re-trigger OTA on every reconnect
      const mqttNum = pumpId.replace('pump', '');
      const otaTopic = `pump/${mqttNum}/ota`;
      mqttClient.publish(otaTopic, '', { qos: 1, retain: true },
        () => console.log(`[MQTT] Cleared retained OTA on ${otaTopic}`));
      return;
    }

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

  // Firebase → MQTT OTA trigger
  // Flutter app writes {url: "https://..."} to pumps/pump01/ota
  // bridge forwards it as MQTT to pump/01/ota so the STM32 starts the download
  const otaFbPath   = `pumps/${pumpId}/ota`;
  const otaMqttTopic = `pump/${mqttNum}/ota`;
  let otaInitialized = false;

  db.ref(otaFbPath).on('value', (snapshot) => {
    if (!otaInitialized) {
      otaInitialized = true;
      return; // skip initial read — only forward new writes
    }
    const cmd = snapshot.val();
    if (!cmd || !cmd.url) {
      // OTA node deleted — clear retained MQTT message so board doesn't re-trigger on reconnect
      mqttClient.publish(otaMqttTopic, '', { qos: 1, retain: true },
        () => console.log(`[OTA] Cleared retained on ${otaMqttTopic}`));
      return;
    }

    const payload = JSON.stringify({ url: cmd.url });
    mqttClient.publish(otaMqttTopic, payload, { qos: 1, retain: true }, (err) => {
      if (err) console.error(`[MQTT] OTA publish error on ${otaMqttTopic}:`, err.message);
      else     console.log(`[FB→MQTT] OTA URL forwarded → ${otaMqttTopic}:`, cmd.url);
    });
  });

  console.log(`[FB] Listening for OTA commands on ${otaFbPath}`);
});

// ─── Rotation schedule — alternate pumps every N minutes ─────────────────────
let rotationSchedule = null;
db.ref('rotation_schedule').on('value', (snapshot) => {
  rotationSchedule = snapshot.val();
});

setInterval(() => {
  const rs = rotationSchedule;
  if (!rs || !rs.enabled) return;

  const now        = Date.now();
  const intervalMs = (rs.interval_minutes || 240) * 60 * 1000;
  const startedAt  = rs.started_at || 0;

  if (startedAt === 0) {
    // First run — start Pump 1 now
    mqttClient.publish('pump/01/cmd', JSON.stringify({ relay1: 1, relay2: 0 }), { qos: 1 });
    db.ref('rotation_schedule').update({ current_pump: 'pump01', started_at: now });
    console.log('[Rotation] Started — pump01 ON');
    return;
  }

  if (now - startedAt >= intervalMs) {
    const current = rs.current_pump || 'pump01';
    const next    = current === 'pump01' ? 'pump02' : 'pump01';
    const curNum  = current.replace('pump', '');
    const nxtNum  = next.replace('pump', '');

    // Turn current off, then turn next on after 2 s
    mqttClient.publish(`pump/${curNum}/cmd`, JSON.stringify({ relay1: 0, relay2: 0 }), { qos: 1 });
    setTimeout(() => {
      mqttClient.publish(`pump/${nxtNum}/cmd`, JSON.stringify({ relay1: 1, relay2: 0 }), { qos: 1 });
    }, 2000);

    db.ref('rotation_schedule').update({ current_pump: next, started_at: now });
    console.log(`[Rotation] ${current} → ${next}`);
  }
}, 60000);

// ─── Schedule execution — check every minute, publish ON/OFF commands ────────
const schedules = {};
PUMPS.forEach((pumpId) => {
  db.ref(`pumps/${pumpId}/schedule`).on('value', (snapshot) => {
    schedules[pumpId] = snapshot.val();
  });
});

setInterval(() => {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  PUMPS.forEach((pumpId) => {
    const s = schedules[pumpId];
    if (!s || !s.enabled) return;
    const mqttNum = pumpId.replace('pump', '');
    const cmdTopic = `pump/${mqttNum}/cmd`;
    if (h === s.on_hour && m === s.on_min) {
      mqttClient.publish(cmdTopic, JSON.stringify({ relay1: 1, relay2: 0 }), { qos: 1 });
      console.log(`[Schedule] ${pumpId} → ON (${h}:${String(m).padStart(2,'0')})`);
    } else if (h === s.off_hour && m === s.off_min) {
      mqttClient.publish(cmdTopic, JSON.stringify({ relay1: 0, relay2: 0 }), { qos: 1 });
      console.log(`[Schedule] ${pumpId} → OFF (${h}:${String(m).padStart(2,'0')})`);
    }
  });
}, 60000); // fires every minute

// ─── OTA retry — re-publish every 30 s while pending and no ota_status ──────
// Root cause: the retained MQTT message is delivered right when the board enters
// blink_n(3) blocking at subscription time and gets discarded by the flush block.
// Solution: once the board is in CONNECTED state (no blocking), continuously
// re-publish as a non-retained message until the board acknowledges.
const pendingOtaUrl = {};

PUMPS.forEach((pumpId) => {
  db.ref(`pumps/${pumpId}/ota`).on('value', (snapshot) => {
    const d = snapshot.val();
    console.log(`[OTA] ota listener: ${pumpId} =`, JSON.stringify(d));
    if (d && d.url) pendingOtaUrl[pumpId] = d.url;
    else            delete pendingOtaUrl[pumpId];
  });
  db.ref(`pumps/${pumpId}/ota_status`).on('value', (snapshot) => {
    console.log(`[OTA] ota_status listener: ${pumpId} exists=${snapshot.exists()}`);
    if (snapshot.exists()) delete pendingOtaUrl[pumpId]; // board acknowledged
  });
});

setInterval(() => {
  console.log('[OTA] Retry tick, pending:', JSON.stringify(pendingOtaUrl));
  Object.entries(pendingOtaUrl).forEach(([pumpId, url]) => {
    const mqttNum = pumpId.replace('pump', '');
    const topic   = `pump/${mqttNum}/ota`;
    mqttClient.publish(topic, JSON.stringify({ url }), { qos: 1, retain: false }, (err) => {
      if (err) console.error(`[OTA] Retry error on ${topic}:`, err.message);
      else     console.log(`[OTA] Retry publish -> ${topic}:`, url);
    });
  });
}, 30000);

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

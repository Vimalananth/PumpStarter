// pump-controller/bridge/bridge.js
// Bridges HiveMQ Cloud <-> Firebase Realtime DB for 2 pumps

const mqtt  = require('mqtt');
const admin = require('firebase-admin');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

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
const PUMPS = ['pump01', 'pump02', 'pump03', 'pump04'];

const TOPICS_SUB = [
  'pump/01/status', 'pump/01/alerts', 'pump/01/ota/status', 'pump/01/log',
  'pump/02/status', 'pump/02/alerts', 'pump/02/ota/status', 'pump/02/log',
  'pump/03/status', 'pump/03/alerts', 'pump/03/ota/status', 'pump/03/log',
  'pump/04/status', 'pump/04/alerts', 'pump/04/ota/status', 'pump/04/log'
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

// ─── FCM helpers ─────────────────────────────────────────────────────────────
function pumpLabel(pumpId) {
  return `Pump ${parseInt(pumpId.replace('pump', ''), 10)}`;
}

function fmtRunTime(s) {
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

async function sendFCM(topic, title, body) {
  try {
    await admin.messaging().send({
      topic,
      notification: { title, body },
      android: { priority: 'high', notification: { channelId: 'pump_alerts' } },
    });
    console.log(`[FCM] → ${topic}: ${title}`);
  } catch (e) {
    console.error('[FCM] Error:', e.message);
  }
}

// ─── EC200U publishes status/alerts → write to Firebase ──────────────────────
const lastSeen        = { pump01: Date.now(), pump02: Date.now(), pump03: Date.now(), pump04: Date.now() };
const offlineNotified = { pump01: false, pump02: false, pump03: false, pump04: false };

// ─── Voltage / current sampler — one entry per 15 min, kept for 5 days ───────
const VOLTAGE_LOG_INTERVAL_MS = 15 * 60 * 1000;          // 15 minutes
const VOLTAGE_LOG_RETAIN_MS   = 5 * 24 * 60 * 60 * 1000; // 5 days
const lastVoltageLog = { pump01: 0, pump02: 0, pump03: 0, pump04: 0 };

function maybeLogVoltage(pumpId, payload) {
  const now = Date.now();
  if (now - lastVoltageLog[pumpId] < VOLTAGE_LOG_INTERVAL_MS) return;
  lastVoltageLog[pumpId] = now;

  const v1 = payload.v1, v2 = payload.v2, v3 = payload.v3;
  const current = payload.current;
  const kw      = payload.kw ?? 0;
  if (!v1 && !v2 && !v3) return; // skip if no real sensor data

  db.ref(`pumps/${pumpId}/voltage_log`).push({ ts: now, v1, v2, v3, current, kw })
    .then(() => console.log(`[VLog] ${pumpId} v1=${v1} v2=${v2} v3=${v3} i=${current}A kw=${kw}kW`))
    .catch(err => console.error('[VLog] Write error:', err.message));

  // Purge entries older than 5 days
  db.ref(`pumps/${pumpId}/voltage_log`).orderByChild('ts')
    .endAt(now - VOLTAGE_LOG_RETAIN_MS)
    .once('value', snap => snap.forEach(child => child.ref.remove()));
}

mqttClient.on('message', (topic, message) => {
  try {    const payload = JSON.parse(message.toString());
    const { pumpId, type } = topicToFirebase(topic);
    if (!payload.ts) payload.ts = Date.now(); /* use device ts if present, else stamp here */

    if (type === 'ota/status') {
      // OTA progress/result — write to pumps/pump01/ota_status
      db.ref(`pumps/${pumpId}/ota_status`).set(payload)
        .then(()  => console.log(`[FB] Written pumps/${pumpId}/ota_status`))
        .catch(err => console.error('[FB] Write error:', err.message));
      // Treat OTA status as liveness too: after reboot the board may publish
      // ota/status before the next regular status heartbeat.
      lastSeen[pumpId] = Date.now();
      db.ref(`pumps/${pumpId}/status/online`).set(true).catch(() => {});
      // Clear retained OTA message so board doesn't re-trigger OTA on every reconnect
      const mqttNum = pumpId.replace('pump', '');
      const otaTopic = `pump/${mqttNum}/ota`;
      mqttClient.publish(otaTopic, '', { qos: 1, retain: true },
        () => console.log(`[MQTT] Cleared retained OTA on ${otaTopic}`));
      return;
    }

    if (type === 'log') {
      // Use push() so each log entry gets a unique time-sorted key
      db.ref(`pumps/${pumpId}/logs`).push(payload)
        .then(()  => console.log(`[FB] Log pushed pumps/${pumpId}/logs: ${payload.event}/${payload.reason}`))
        .catch(err => console.error('[FB] Log push error:', err.message));
      // Notify ON / OFF events
      const label = pumpLabel(pumpId);
      if (payload.event === 'on') {
        const src = payload.reason || 'manual';
        sendFCM(pumpId, `${label} Started`, `Turned ON (${src})`);
      } else if (payload.event === 'off') {
        const src     = payload.reason || 'manual';
        const runStr  = payload.run_s ? ` — ran ${fmtRunTime(payload.run_s)}` : '';
        sendFCM(pumpId, `${label} Stopped`, `Turned OFF (${src})${runStr}`);
      }
      return;
    }

    db.ref(`pumps/${pumpId}/${type}`).set(payload)
      .then(()  => console.log(`[FB] Written pumps/${pumpId}/${type}`))
      .catch(err => console.error('[FB] Write error:', err.message));

    if (type === 'status') {
      lastSeen[pumpId] = Date.now();
      if (offlineNotified[pumpId]) {
        // Device just came back — send recovery notification
        offlineNotified[pumpId] = false;
        sendFCM(pumpId, `${pumpLabel(pumpId)} — Back Online`, 'Device has reconnected and is sending heartbeats');
      }
      maybeLogVoltage(pumpId, payload);
    }

    if (type === 'alerts') {
      const label = pumpLabel(pumpId);
      if (payload.dry_run_trip) sendFCM(pumpId, `${label} — Dry Run Trip`,  'Pump tripped: no water detected');
      if (payload.overvoltage)  sendFCM(pumpId, `${label} — Overvoltage`,   'Pump tripped: voltage too high');
      if (payload.undervoltage) sendFCM(pumpId, `${label} — Undervoltage`,  'Pump tripped: voltage too low');
      if (payload.phase_loss)   sendFCM(pumpId, `${label} — Phase Loss`,    'Pump tripped: phase loss detected');
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

    // Only forward fields that are present — missing fields must NOT default to 0
    // (would pulse the wrong coil on a latching relay).
    // pump03/04: relay1/relay2 are remapped to relay3/relay4 so the device
    // forwards them via LoRa to the Blue Pill slave (test setup).
    const out = {};
    if (pumpId === 'pump03' || pumpId === 'pump04') {
      if (cmd.relay1 !== undefined) out.relay3 = cmd.relay1;
      if (cmd.relay2 !== undefined) out.relay4 = cmd.relay2;
    } else {
      if (cmd.relay1 !== undefined) out.relay1 = cmd.relay1;
      if (cmd.relay2 !== undefined) out.relay2 = cmd.relay2;
    }
    if (cmd.relay3 !== undefined) out.relay3 = cmd.relay3;
    if (cmd.relay4 !== undefined) out.relay4 = cmd.relay4;
    if (Object.keys(out).length === 0) return;
    const payload = JSON.stringify(out);

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

  // Firebase → MQTT protection settings
  // Flutter writes {ov,uv,pl,dry_i,dry_t} to pumps/pump01/settings
  // Bridge publishes as retained MQTT so device receives settings on every reconnect
  const settingsFbPath   = `pumps/${pumpId}/settings`;
  const settingsMqttTopic = `pump/${mqttNum}/settings`;

  db.ref(settingsFbPath).on('value', (snapshot) => {
    const s = snapshot.val();
    if (!s) return;
    // Validate threshold ordering: OV must be > UV must be > PL
    if (s.ov !== undefined && s.uv !== undefined && s.pl !== undefined) {
      if (s.ov <= s.uv || s.uv <= s.pl) {
        console.error(`[CFG:${pumpId}] Invalid settings rejected — ov(${s.ov}) must be > uv(${s.uv}) must be > pl(${s.pl})`);
        return;
      }
    }
    const out = {
      ov:     s.ov     ?? 480,
      uv:     s.uv     ?? 340,
      pl:     s.pl     ?? 200,
      dry_i:  s.dry_i  ?? 1.5,
      dry_t:  s.dry_t  ?? 8,
      dry_en: s.dry_en ?? 1,
    };
    if (s.hp != null) out.hp = s.hp;
    const payload = JSON.stringify(out);
    mqttClient.publish(settingsMqttTopic, payload, { qos: 1, retain: true }, (err) => {
      if (err) console.error(`[MQTT] Settings publish error on ${settingsMqttTopic}:`, err.message);
      else     console.log(`[FB→MQTT] Settings → ${settingsMqttTopic}:`, payload);
    });
  });

  console.log(`[FB] Listening for settings on ${settingsFbPath}`);
});

// ─── Rotation schedule — per-site, alternate pumps every N minutes ────────────
const SITE_CONFIGS = [
  { id: 'site01', pumps: ['pump01', 'pump02'] },
  { id: 'site02', pumps: ['pump03', 'pump04'] },
];

const rotationSchedules = {};
SITE_CONFIGS.forEach(({ id }) => {
  db.ref(`sites/${id}/rotation_schedule`).on('value', (snap) => {
    rotationSchedules[id] = snap.val();
  });
  console.log(`[FB] Listening for rotation on sites/${id}/rotation_schedule`);
});

setInterval(() => {
  SITE_CONFIGS.forEach(({ id, pumps }) => {
    const rs = rotationSchedules[id];
    if (!rs || !rs.enabled) return;

    const now        = Date.now();
    const intervalMs = (rs.interval_minutes || 240) * 60 * 1000;
    const startedAt  = rs.started_at || 0;
    const pump1 = pumps[0];
    const pump2 = pumps[1];

    if (startedAt === 0) {
      const p1Num = pump1.replace('pump', '');
      mqttClient.publish(`pump/${p1Num}/cmd`, JSON.stringify({ relay1: 1, src: 'rot' }), { qos: 1 });
      db.ref(`sites/${id}/rotation_schedule`).update({ current_pump: pump1, started_at: now });
      console.log(`[Rotation:${id}] Started — ${pump1} ON`);
      return;
    }

    if (now - startedAt >= intervalMs) {
      const current = rs.current_pump || pump1;
      const next    = current === pump1 ? pump2 : pump1;
      const curNum  = current.replace('pump', '');
      const nxtNum  = next.replace('pump', '');

      // Turn current off, then turn next on after 2 s
      mqttClient.publish(`pump/${curNum}/cmd`, JSON.stringify({ relay1: 0, src: 'rot' }), { qos: 1 });
      setTimeout(() => {
        mqttClient.publish(`pump/${nxtNum}/cmd`, JSON.stringify({ relay1: 1, src: 'rot' }), { qos: 1 });
      }, 2000);

      db.ref(`sites/${id}/rotation_schedule`).update({ current_pump: next, started_at: now });
      console.log(`[Rotation:${id}] ${current} → ${next}`);
    }
  });
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
      mqttClient.publish(cmdTopic, JSON.stringify({ relay1: 1, src: 'sched' }), { qos: 1 });
      console.log(`[Schedule] ${pumpId} → ON (${h}:${String(m).padStart(2,'0')})`);
    } else if (h === s.off_hour && m === s.off_min) {
      mqttClient.publish(cmdTopic, JSON.stringify({ relay1: 0, src: 'sched' }), { qos: 1 });
      console.log(`[Schedule] ${pumpId} → OFF (${h}:${String(m).padStart(2,'0')})`);
    }
  });
}, 60000); // fires every minute


// ─── Offline detection — mark pump offline if no status for 90 s ─────────────
// pump02 heartbeat fires every 60 s (firmware); 90 s gives a safe margin.
// Once firmware is updated via OTA to publish status2 every 10 s, this can
// be tightened back to 30 s.
setInterval(() => {
  const now = Date.now();
  PUMPS.forEach((pumpId) => {
    if (lastSeen[pumpId] && now - lastSeen[pumpId] > 90000) {
      db.ref(`pumps/${pumpId}/status/online`).set(false).catch(() => {});
      if (!offlineNotified[pumpId]) {
        offlineNotified[pumpId] = true;
        sendFCM(pumpId, `${pumpLabel(pumpId)} — Offline`, 'Device has stopped sending heartbeats');
      }
    }
  });
}, 15000);

// ─── Firmware file server — serves firmware.bin with no redirect ─────────────
// Railway injects PORT; EC200U downloads from https://<railway-host>/firmware.bin
// Place firmware.bin in the same folder as bridge.js, then redeploy.
const PORT          = process.env.PORT || 3000;
const FIRMWARE_FILE      = path.join(__dirname, 'firmware.bin');
const FIRMWARE_TEST_FILE = path.join(__dirname, 'firmware_test.bin');

function serveFirmware(req, res, filePath, fileName) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(503); res.end(`${fileName} not present`); return;
  }
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type':        'application/octet-stream',
    'Content-Length':      stat.size,
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Connection':          'close',
    'Cache-Control':       'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, no-transform',
    'Pragma':              'no-cache',
    'Expires':             '0',
    'Accept-Ranges':       'none'
  });
  req.socket.setNoDelay(true);
  fs.createReadStream(filePath).pipe(res);
  console.log(`[HTTP] Served ${fileName} (${stat.size} bytes)`);
}

const fileServer = http.createServer((req, res) => {
  const reqPath = (req.url || '').split('?')[0];
  if (reqPath === '/firmware.bin') {
    serveFirmware(req, res, FIRMWARE_FILE, 'firmware.bin');
  } else if (reqPath === '/firmware_test.bin') {
    serveFirmware(req, res, FIRMWARE_TEST_FILE, 'firmware_test.bin');
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

fileServer.listen(PORT, () =>
  console.log(`[HTTP] Firmware server on port ${PORT} — firmware.bin ${fs.existsSync(FIRMWARE_FILE) ? 'ready' : 'MISSING'}`));

console.log('[Bridge] Running. Waiting for MQTT connection...');

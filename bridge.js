// pump-controller/bridge/bridge.js
// Bridges HiveMQ Cloud <-> Firebase Realtime DB
// New structure: sites/{siteId}/lines/{lineId}/pumps/{pumpId}/

const mqtt  = require('mqtt');
const admin = require('firebase-admin');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ─── Firebase init ────────────────────────────────────────────────────────────
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

// ─── MQTT broker ─────────────────────────────────────────────────────────────
const BROKER_URL = 'mqtts://broker.emqx.io:8883';

const mqttClient = mqtt.connect(BROKER_URL, {
  clientId:           'bridge_node_' + Math.random().toString(16).slice(2, 8),
  rejectUnauthorized: false,
  keepalive:          60,
  reconnectPeriod:    3000
});

// ─── MQTT → Firebase topic map ────────────────────────────────────────────────
// method: 'set'  → db.ref(fbPath).set(payload)       (overwrites, latest state)
// method: 'push' → db.ref(fbPath).push(payload)      (appends, time-series log)
const TOPIC_MAP = {
  // ── site01: line01/pump01 (relay1) ──
  'pump/01/status':     { fbPath: 'sites/site01/line01/pump01/status',    method: 'set',  mqttId: '01' },
  'pump/01/alerts':     { fbPath: 'sites/site01/line01/pump01/alerts',    method: 'push', mqttId: '01' },
  'pump/01/log':        { fbPath: 'sites/site01/line01/pump01/alerts',    method: 'push', mqttId: '01' },
  'pump/01/vlog':       { fbPath: 'sites/site01/line01/pump01/logs',      method: 'push', mqttId: '01' },
  'pump/01/ota/status': { fbPath: 'sites/site01/line01/pump01/ota_status',method: 'set',  mqttId: '01', isOta: true },

  // ── site01: line01/pump02 (relay2) ──
  'pump/02/status':     { fbPath: 'sites/site01/line01/pump02/status',    method: 'set',  mqttId: '02' },
  'pump/02/alerts':     { fbPath: 'sites/site01/line01/pump02/alerts',    method: 'push', mqttId: '02' },
  'pump/02/log':        { fbPath: 'sites/site01/line01/pump02/alerts',    method: 'push', mqttId: '02' },
  'pump/02/vlog':       { fbPath: 'sites/site01/line01/pump02/logs',      method: 'push', mqttId: '02' },
  'pump/02/ota/status': { fbPath: 'sites/site01/line01/pump02/ota_status',method: 'set',  mqttId: '02', isOta: true },

  // ── site02: line01/pump01 (relay1) ──
  'pump/03/status':     { fbPath: 'sites/site02/line01/pump01/status',    method: 'set',  mqttId: '03' },
  'pump/03/alerts':     { fbPath: 'sites/site02/line01/pump01/alerts',    method: 'push', mqttId: '03' },
  'pump/03/log':        { fbPath: 'sites/site02/line01/pump01/alerts',    method: 'push', mqttId: '03' },
  'pump/03/vlog':       { fbPath: 'sites/site02/line01/pump01/logs',      method: 'push', mqttId: '03' },
  'pump/03/ota/status': { fbPath: 'sites/site02/line01/pump01/ota_status',method: 'set',  mqttId: '03', isOta: true },

  // ── site02: line01/pump02 (relay2) ──
  'pump/04/status':     { fbPath: 'sites/site02/line01/pump02/status',    method: 'set',  mqttId: '04' },
  'pump/04/alerts':     { fbPath: 'sites/site02/line01/pump02/alerts',    method: 'push', mqttId: '04' },
  'pump/04/log':        { fbPath: 'sites/site02/line01/pump02/alerts',    method: 'push', mqttId: '04' },
  'pump/04/vlog':       { fbPath: 'sites/site02/line01/pump02/logs',      method: 'push', mqttId: '04' },
  'pump/04/ota/status': { fbPath: 'sites/site02/line01/pump02/ota_status',method: 'set',  mqttId: '04', isOta: true },

  // ── site01: line02/pump01 (Blue Pill slave via LoRa) ──
  'pump/01/slave_status': { fbPath: 'sites/site01/line02/pump01/status', method: 'set',  mqttId: '01' },
  'pump/01/slave_vlog':   { fbPath: 'sites/site01/line02/pump01/logs',   method: 'push', mqttId: '01' },
  'pump/01/slave_alerts': { fbPath: 'sites/site01/line02/pump01/alerts', method: 'push', mqttId: '01' },

  // ── site02: line02/pump01 (Blue Pill slave via LoRa) ──
  'pump/03/slave_status': { fbPath: 'sites/site02/line02/pump01/status', method: 'set',  mqttId: '03' },
  'pump/03/slave_vlog':   { fbPath: 'sites/site02/line02/pump01/logs',   method: 'push', mqttId: '03' },
  'pump/03/slave_alerts': { fbPath: 'sites/site02/line02/pump01/alerts', method: 'push', mqttId: '03' },
};

// ─── Firebase → MQTT pump configs ────────────────────────────────────────────
// Each entry defines one Firebase pump path and how to route its commands/settings to MQTT.
// cmdRelayMap: maps incoming Firebase relay field → outgoing MQTT relay field.
const PUMP_CONFIGS = [
  {
    fbBase:      'sites/site01/line01/pump01',
    mqttNum:     '01',
    cmdRelayMap: { relay1: 'relay1', relay2: 'relay2' },
    label:       'Site01 Line01 Pump01',
  },
  {
    fbBase:      'sites/site01/line01/pump02',
    mqttNum:     '02',
    cmdRelayMap: { relay1: 'relay1', relay2: 'relay2' },
    label:       'Site01 Line01 Pump02',
  },
  {
    fbBase:      'sites/site02/line01/pump01',
    mqttNum:     '03',
    cmdRelayMap: { relay1: 'relay1', relay2: 'relay2' },
    label:       'Site02 Line01 Pump01',
  },
  {
    fbBase:      'sites/site02/line01/pump02',
    mqttNum:     '04',
    cmdRelayMap: { relay1: 'relay1', relay2: 'relay2' },
    label:       'Site02 Line01 Pump02',
  },
  {
    fbBase:      'sites/site01/line02/pump01',
    mqttNum:     '01',                                   /* same device as line01/pump01 */
    cmdRelayMap: { relay1: 'relay3', relay2: 'relay4' }, /* relay1 from app → relay3 to LoRa slave */
    label:       'Site01 Line02 Pump01 (Blue Pill)',
  },
  {
    fbBase:      'sites/site02/line02/pump01',
    mqttNum:     '03',                                   /* same device as line01/pump01 */
    cmdRelayMap: { relay1: 'relay3', relay2: 'relay4' }, /* relay1 from app → relay3 to LoRa slave */
    label:       'Site02 Line02 Pump01 (Blue Pill)',
  },
];

// ─── FCM helpers ─────────────────────────────────────────────────────────────
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

// FCM topic derived from Firebase path (e.g. sites/site02/line01/pump01 → site02_line01_pump01)
function fcmTopic(fbBase) {
  return fbBase.replace('sites/', '').replace(/\//g, '_');
}

// ─── Online detection ─────────────────────────────────────────────────────────
// Track last status received per Firebase status path.
// Device considered offline if no status for 15 min (keepalive is 10 min).
const OFFLINE_TIMEOUT_MS = 15 * 60 * 1000;
const lastSeen        = {};
const offlineNotified = {};

// ─── Log retention ────────────────────────────────────────────────────────────
const LOG_RETAIN_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

function purgeOldLogs(fbPath, cutoff) {
  db.ref(fbPath).orderByChild('ts').endAt(cutoff)
    .once('value', snap => snap.forEach(child => child.ref.remove()));
}

// ─── MQTT events ──────────────────────────────────────────────────────────────
const TOPICS_SUB = Object.keys(TOPIC_MAP);

mqttClient.on('connect', () => {
  console.log('[MQTT] Connected to broker.emqx.io');
  mqttClient.subscribe(TOPICS_SUB, { qos: 1 }, (err) => {
    if (err) console.error('[MQTT] Subscribe error:', err);
    else     console.log('[MQTT] Subscribed to', TOPICS_SUB.length, 'topics');
  });
  // Re-publish cached settings so device gets them after broker restart
  Object.values(latestSettingsPayload).forEach(({ topic, payload }) => {
    mqttClient.publish(topic, payload, { qos: 1, retain: true },
      () => console.log(`[CFG] Re-published settings → ${topic}`));
  });
});

mqttClient.on('reconnect', () => console.log('[MQTT] Reconnecting...'));
mqttClient.on('error',     (err) => console.error('[MQTT] Error:', err.message));

mqttClient.on('message', (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    const mapping = TOPIC_MAP[topic];
    if (!mapping) return;

    if (payload.ts > 0 && payload.ts < 1e12) payload.ts = payload.ts * 1000; // seconds → ms
    if (!payload.ts) payload.ts = Date.now();

    // ── OTA status: clear retained OTA trigger after reboot ──────────────────
    if (mapping.isOta) {
      db.ref(mapping.fbPath).set(payload)
        .then(() => console.log(`[FB] OTA status → ${mapping.fbPath}`))
        .catch(err => console.error('[FB] OTA status error:', err.message));
      // Clear retained OTA message so board doesn't re-trigger on reconnect
      const otaTopic = `pump/${mapping.mqttId}/ota`;
      mqttClient.publish(otaTopic, '', { qos: 1, retain: true },
        () => console.log(`[MQTT] Cleared retained OTA on ${otaTopic}`));
      // Mark device as seen
      const statusPath = mapping.fbPath.replace('/ota_status', '/status');
      lastSeen[statusPath] = Date.now();
      db.ref(statusPath + '/online').set(true).catch(() => {});
      return;
    }

    // ── Write to Firebase ─────────────────────────────────────────────────────
    if (mapping.method === 'set') {
      db.ref(mapping.fbPath).set(payload)
        .then(() => console.log(`[FB] set → ${mapping.fbPath}`))
        .catch(err => console.error('[FB] set error:', err.message));

      // Track online status for status topics
      if (topic.endsWith('/status') || topic.endsWith('/slave_status')) {
        lastSeen[mapping.fbPath] = Date.now();
        const topic_fcm = fcmTopic(mapping.fbPath.replace('/status', ''));
        if (offlineNotified[mapping.fbPath]) {
          offlineNotified[mapping.fbPath] = false;
          sendFCM(topic_fcm, `${mapping.label || topic} — Back Online`, 'Device reconnected');
        }
      }

    } else {
      // push() — append log entry with auto-purge
      db.ref(mapping.fbPath).push(payload)
        .then(() => console.log(`[FB] push → ${mapping.fbPath}`))
        .catch(err => console.error('[FB] push error:', err.message));

      purgeOldLogs(mapping.fbPath, Date.now() - LOG_RETAIN_MS);

      // FCM for relay on/off events in alerts
      if (topic.endsWith('/log')) {
        const label = mapping.label || topic;
        const topic_fcm = fcmTopic(mapping.fbPath.replace('/alerts', ''));
        if (payload.event === 'on') {
          sendFCM(topic_fcm, `${label} Started`, `Turned ON (${payload.reason || 'manual'})`);
        } else if (payload.event === 'off') {
          const runStr = payload.run_s ? ` — ran ${fmtRunTime(payload.run_s)}` : '';
          sendFCM(topic_fcm, `${label} Stopped`, `Turned OFF (${payload.reason || 'manual'})${runStr}`);
        }
      }

      // FCM for protection alerts
      if (topic.endsWith('/alerts')) {
        const label = mapping.label || topic;
        const topic_fcm = fcmTopic(mapping.fbPath.replace('/alerts', ''));
        if (payload.dry_run_trip) sendFCM(topic_fcm, `${label} — Dry Run Trip`,  'Pump tripped: no water detected');
        if (payload.overvoltage)  sendFCM(topic_fcm, `${label} — Overvoltage`,   'Pump tripped: voltage too high');
        if (payload.undervoltage) sendFCM(topic_fcm, `${label} — Undervoltage`,  'Pump tripped: voltage too low');
        if (payload.phase_loss)   sendFCM(topic_fcm, `${label} — Phase Loss`,    'Pump tripped: phase loss detected');
      }

      // FCM for slave online/offline alerts
      if (topic.endsWith('/slave_alerts')) {
        const topic_fcm = fcmTopic(mapping.fbPath.replace('/alerts', ''));
        if (payload.event === 'slave_offline') sendFCM(topic_fcm, 'Slave Offline', 'Blue Pill not responding via LoRa');
        if (payload.event === 'slave_online')  sendFCM(topic_fcm, 'Slave Online',  'Blue Pill reconnected via LoRa');
      }
    }

  } catch (e) {
    console.error('[MQTT] Parse error:', e.message, '| raw:', message.toString());
  }
});

// ─── Offline detection — mark pump offline if no status for 15 min ────────────
setInterval(() => {
  const now = Date.now();
  Object.keys(lastSeen).forEach((statusPath) => {
    if (now - lastSeen[statusPath] > OFFLINE_TIMEOUT_MS) {
      db.ref(statusPath + '/online').set(false).catch(() => {});
      if (!offlineNotified[statusPath]) {
        offlineNotified[statusPath] = true;
        const topic_fcm = fcmTopic(statusPath.replace('/status', ''));
        sendFCM(topic_fcm, 'Device Offline', 'No heartbeat received');
      }
    }
  });
}, 60000);

// ─── Firebase → MQTT: commands, settings, OTA ────────────────────────────────
const latestSettingsPayload = {};

PUMP_CONFIGS.forEach((cfg) => {
  const cmdTopic      = `pump/${cfg.mqttNum}/cmd`;
  const settingsTopic = `pump/${cfg.mqttNum}/settings`;
  const otaTopic      = `pump/${cfg.mqttNum}/ota`;

  // ── Commands ──
  let cmdInitialized = false;
  db.ref(`${cfg.fbBase}/cmd`).on('value', (snapshot) => {
    if (!cmdInitialized) { cmdInitialized = true; return; }
    const cmd = snapshot.val();
    if (!cmd) return;

    if (cmd.reset === 1) {
      mqttClient.publish(cmdTopic, 'RESET', { qos: 1 }, (err) => {
        if (err) console.error(`[MQTT] Reset error on ${cmdTopic}:`, err.message);
        else     console.log(`[MQTT] Reset → ${cmdTopic}`);
      });
      return;
    }
    const out = {};
    Object.entries(cfg.cmdRelayMap).forEach(([fbField, mqttField]) => {
      if (cmd[fbField] !== undefined) out[mqttField] = cmd[fbField];
    });
    if (Object.keys(out).length === 0) return;

    mqttClient.publish(cmdTopic, JSON.stringify(out), { qos: 1 }, (err) => {
      if (err) console.error(`[MQTT] Cmd error on ${cmdTopic}:`, err.message);
      else     console.log(`[MQTT] Cmd → ${cmdTopic}:`, JSON.stringify(out));
    });
  });
  console.log(`[FB] Listening commands: ${cfg.fbBase}/cmd`);

  // ── Settings ──
  db.ref(`${cfg.fbBase}/settings`).on('value', (snapshot) => {
    const s = snapshot.val();
    if (!s) return;
    if (s.ov !== undefined && s.uv !== undefined && s.pl !== undefined) {
      if (s.ov <= s.uv || s.uv <= s.pl) {
        console.error(`[CFG:${cfg.label}] Invalid settings rejected — ov(${s.ov}) > uv(${s.uv}) > pl(${s.pl}) required`);
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
      uv_rst: s.uv_rst ?? 300,
    };
    if (s.hp != null) out.hp = s.hp;
    const payloadStr = JSON.stringify(out);
    latestSettingsPayload[`${cfg.fbBase}/settings`] = { topic: settingsTopic, payload: payloadStr };
    mqttClient.publish(settingsTopic, payloadStr, { qos: 1, retain: true }, (err) => {
      if (err) console.error(`[MQTT] Settings error on ${settingsTopic}:`, err.message);
      else     console.log(`[FB→MQTT] Settings → ${settingsTopic}:`, payloadStr);
    });
  });
  console.log(`[FB] Listening settings: ${cfg.fbBase}/settings`);

  // ── OTA firmware trigger ──
  let otaInitialized = false;
  db.ref(`${cfg.fbBase}/ota`).on('value', (snapshot) => {
    if (!otaInitialized) { otaInitialized = true; return; }
    const cmd = snapshot.val();
    if (!cmd || !cmd.url) {
      mqttClient.publish(otaTopic, '', { qos: 1, retain: true },
        () => console.log(`[OTA] Cleared retained on ${otaTopic}`));
      return;
    }
    const payloadObj = { url: cmd.url };
    for (const [fname, crc] of Object.entries(firmwareCrcs)) {
      if (cmd.url.endsWith('/' + fname)) { payloadObj.crc32 = crc; break; }
    }
    mqttClient.publish(otaTopic, JSON.stringify(payloadObj), { qos: 1, retain: true }, (err) => {
      if (err) console.error(`[MQTT] OTA error on ${otaTopic}:`, err.message);
      else     console.log(`[FB→MQTT] OTA → ${otaTopic}:`, cmd.url);
    });
  });
  console.log(`[FB] Listening OTA: ${cfg.fbBase}/ota`);
});

// ── LoRa OTA trigger (site02/line1/pump1 only — pump/03/lora_ota) ──────────────
{
  const loraOtaFbPath    = 'sites/site02/line01/pump01/lora_ota_cmd';
  const loraOtaMqttTopic = 'pump/03/lora_ota';
  let loraOtaInit = false;
  db.ref(loraOtaFbPath).on('value', (snapshot) => {
    if (!loraOtaInit) { loraOtaInit = true; return; }
    const cmd = snapshot.val();
    if (!cmd || !cmd.url) return;
    mqttClient.publish(loraOtaMqttTopic, JSON.stringify({ url: cmd.url }), { qos: 1 }, (err) => {
      if (err) console.error(`[MQTT] LoRa OTA error on ${loraOtaMqttTopic}:`, err.message);
      else     console.log(`[FB→MQTT] LoRa OTA → ${loraOtaMqttTopic}:`, cmd.url);
    });
  });
  console.log(`[FB] Listening LoRa OTA: ${loraOtaFbPath}`);
}

// ─── Rotation schedule executor ───────────────────────────────────────────────
// Bridge watches Firebase rotation_schedule docs and performs pump switching.
// Every minute: if enabled and interval elapsed → turn off current pump,
// wait 2 s, turn on next pump, update current_pump + started_at in Firebase.
const ROTATION_CONFIGS = [
  {
    fbPath: 'sites/site01/line01/rotation_schedule',
    label:  'Site01',
    pumps: [
      { id: 'pump01', fbBase: 'sites/site01/line01/pump01' },
      { id: 'pump02', fbBase: 'sites/site01/line01/pump02' },
    ],
  },
  {
    fbPath: 'sites/site02/line01/rotation_schedule',
    label:  'Site02',
    pumps: [
      { id: 'pump03', fbBase: 'sites/site02/line01/pump01' },
      { id: 'pump04', fbBase: 'sites/site02/line01/pump02' },
    ],
  },
];

const rotationState = {};

ROTATION_CONFIGS.forEach((rc) => {
  rotationState[rc.fbPath] = { pumps: rc.pumps, label: rc.label };
  db.ref(rc.fbPath).on('value', (snapshot) => {
    const data = snapshot.val() || {};
    rotationState[rc.fbPath] = { ...data, pumps: rc.pumps, label: rc.label };
  });
  console.log(`[ROT] Watching: ${rc.fbPath}`);
});

setInterval(async () => {
  const now = Date.now();
  for (const [fbPath, state] of Object.entries(rotationState)) {
    const { pumps, label, enabled, interval_minutes, current_pump, started_at } = state;
    if (!enabled || !pumps) continue;

    // Initialize started_at when first enabled (Flutter writes started_at:0 on save)
    if (!started_at) {
      const initPump = current_pump ?? pumps[0].id;
      await db.ref(fbPath).update({ current_pump: initPump, started_at: now })
        .catch(e => console.error(`[ROT] ${label}: init error:`, e.message));
      console.log(`[ROT] ${label}: initialized, current=${initPump}`);
      continue;
    }

    const elapsed  = now - started_at;
    const interval = (interval_minutes ?? 240) * 60 * 1000;
    if (elapsed < interval) continue;

    // Interval elapsed — switch to next pump
    const currentIdx  = pumps.findIndex(p => p.id === (current_pump ?? pumps[0].id));
    const safeIdx     = currentIdx < 0 ? 0 : currentIdx;
    const nextIdx     = (safeIdx + 1) % pumps.length;
    const currentPump = pumps[safeIdx];
    const nextPump    = pumps[nextIdx];

    console.log(`[ROT] ${label}: switching ${currentPump.id} → ${nextPump.id}`);
    try {
      await db.ref(`${currentPump.fbBase}/cmd`).set({ relay1: 0 });
      await new Promise(r => setTimeout(r, 2000));
      await db.ref(`${nextPump.fbBase}/cmd`).set({ relay1: 1 });
      await db.ref(fbPath).update({ current_pump: nextPump.id, started_at: now });
      console.log(`[ROT] ${label}: done → ${nextPump.id}, next in ${interval_minutes}m`);
    } catch (e) {
      console.error(`[ROT] ${label}: switch error:`, e.message);
    }
  }
}, 60000);

// ─── Schedule — per pump ──────────────────────────────────────────────────────
const schedules = {};
PUMP_CONFIGS.forEach((cfg) => {
  db.ref(`${cfg.fbBase}/schedule`).on('value', (snapshot) => {
    schedules[cfg.fbBase] = snapshot.val();
  });
});

setInterval(() => {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  PUMP_CONFIGS.forEach((cfg) => {
    const s = schedules[cfg.fbBase];
    if (!s || !s.enabled) return;
    const cmdTopic = `pump/${cfg.mqttNum}/cmd`;
    const relay    = Object.keys(cfg.cmdRelayMap)[0]; // first relay field
    if (h === s.on_hour  && m === s.on_min)
      mqttClient.publish(cmdTopic, JSON.stringify({ [relay]: 1, src: 'sched' }), { qos: 1 });
    if (h === s.off_hour && m === s.off_min)
      mqttClient.publish(cmdTopic, JSON.stringify({ [relay]: 0, src: 'sched' }), { qos: 1 });
  });
}, 60000);

// ─── Firmware file server ─────────────────────────────────────────────────────
const PORT               = process.env.PORT || 3000;
const FIRMWARE_FILE      = path.join(__dirname, 'firmware.bin');
const FIRMWARE_TEST_FILE = path.join(__dirname, 'firmware_test.bin');

function computeCrc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
  }
  return ((crc ^ 0xFFFFFFFF) >>> 0);
}

const firmwareCrcs = {};
[['firmware.bin', FIRMWARE_FILE], ['firmware_test.bin', FIRMWARE_TEST_FILE]].forEach(([name, fpath]) => {
  if (fs.existsSync(fpath)) {
    const crc = computeCrc32(fs.readFileSync(fpath));
    firmwareCrcs[name] = crc.toString(16).toUpperCase().padStart(8, '0');
    console.log(`[CRC] ${name}: 0x${firmwareCrcs[name]}`);
  }
});

function serveFirmware(req, res, filePath, fileName) {
  if (!fs.existsSync(filePath)) { res.writeHead(503); res.end(`${fileName} not present`); return; }
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
  if      (reqPath === '/firmware.bin')      serveFirmware(req, res, FIRMWARE_FILE,      'firmware.bin');
  else if (reqPath === '/firmware_test.bin') serveFirmware(req, res, FIRMWARE_TEST_FILE, 'firmware_test.bin');
  else { res.writeHead(404); res.end('Not found'); }
});

fileServer.listen(PORT, () =>
  console.log(`[HTTP] Firmware server on port ${PORT} — firmware.bin ${fs.existsSync(FIRMWARE_FILE) ? 'ready' : 'MISSING'}`));

console.log('[Bridge] Running. Waiting for MQTT connection...');

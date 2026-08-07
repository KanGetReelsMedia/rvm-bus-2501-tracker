const net = require('net');
const express = require('express');
const admin = require('firebase-admin');

// ---- Firebase init ----
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      databaseURL: process.env.FIREBASE_RTDB_URL || "https://rvm-software-manifest-default-rtdb.firebaseio.com"
    });
  } else {
    // For local test with GOOGLE_APPLICATION_CREDENTIALS
    admin.initializeApp({
      databaseURL: process.env.FIREBASE_RTDB_URL || "https://rvm-software-manifest-default-rtdb.firebaseio.com"
    });
  }
}
const db = admin.firestore();
const rtdb = admin.database();

// ---- Tianqin parser for ST-915L ----
function parseTianqin(data) {
  const str = data.toString().trim();
  console.log('RAW:', str);
  // *HQ,7026265708,V1,123456,A,4107.1234,N,08753.1234,W,0.5,0,070826,FFFFFBFF
  const m = str.match(/\*HQ,(\d+),[^,]*,\d+,[AV],(\d+\.\d+),([NS]),(\d+\.\d+),([EW])/);
  if (m) {
    const imei = m[1];
    const latRaw = parseFloat(m[2]);
    const latDir = m[3];
    const lngRaw = parseFloat(m[4]);
    const lngDir = m[5];
    const latDeg = Math.floor(latRaw/100) + (latRaw%100)/60;
    const lngDeg = Math.floor(lngRaw/100) + (lngRaw%100)/60;
    const lat = latDir === 'S' ? -latDeg : latDeg;
    const lng = lngDir === 'W' ? -lngDeg : lngDeg;
    if (lat !== 0 && lng !== 0) return { imei, lat, lng };
  }
  // fallback simple lat,lng
  const simple = str.match(/(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)/);
  if (simple) {
    const imeiMatch = str.match(/(7026265708)/);
    return { imei: imeiMatch ? imeiMatch[1] : '7026265708', lat: parseFloat(simple[1]), lng: parseFloat(simple[2]) };
  }
  return null;
}

async function updateBus(parsed) {
  const imei = parsed.imei;
  let busId = 'bus-2501'; // default to your bus
  // Try to map IMEI to busId from Firestore
  try {
    const snap = await db.collection('buses').where('imei','==', imei).limit(1).get();
    if (!snap.empty) busId = snap.docs[0].id;
  } catch(e) {}

  const ref = db.collection('buses').doc(busId);
  const doc = await ref.get();
  const prev = doc.exists ? doc.data() : {};
  
  // Don't overwrite showToCustomers if dispatcher turned it off
  const showToCustomers = prev.hasOwnProperty('showToCustomers') ? prev.showToCustomers : true;

  const update = {
    lat: parsed.lat,
    lng: parsed.lng,
    lastLat: parsed.lat,
    lastLng: parsed.lng,
    lastUpdate: Date.now(),
    lastLive: Date.now(),
    linkStatus: 'Online',
    imei: imei,
    // Keep existing showToCustomers value - dispatcher controls it
    showToCustomers: showToCustomers
  };

  await ref.set(update, { merge: true });
  await rtdb.ref(`buses/${busId}`).set({ ...prev, ...update });
  console.log(`✅ ${busId} (${imei}) -> ${parsed.lat}, ${parsed.lng} | Customer visible: ${showToCustomers}`);
}

// ---- TCP server for tracker ----
const TCP_PORT = 8090;
const tcpServer = net.createServer((socket) => {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`Tracker connected: ${remote}`);
  socket.on('data', async (data) => {
    const parsed = parseTianqin(data);
    if (parsed) {
      await updateBus(parsed);
    }
    socket.write('OK\r\n');
  });
  socket.on('error', (e) => console.log('socket error', remote, e.message));
});

tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
  console.log(`TCP listener for ST-915L running on 0.0.0.0:${TCP_PORT}`);
});

// ---- HTTP health check for Fly.io / Cloud Run ----
const app = express();
app.get('/', (req,res) => res.send('RVM Bus 2501 Tracker Listener - TCP 8090 - Online'));
app.get('/health', (req,res) => res.json({ status: 'ok', tcp: TCP_PORT, time: new Date().toISOString() }));
const HTTP_PORT = process.env.PORT || 8080;
app.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`HTTP health on 0.0.0.0:${HTTP_PORT}`);
});
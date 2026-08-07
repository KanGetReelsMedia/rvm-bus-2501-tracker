const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();

// --- Firebase ---
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(sa),
        databaseURL: process.env.FIREBASE_RTDB_URL || "https://rvm-software-manifest-default-rtdb.firebaseio.com"
      });
    } else {
      admin.initializeApp({
        databaseURL: process.env.FIREBASE_RTDB_URL
      });
    }
  } catch(e) {
    console.error('Firebase init error', e.message);
  }
}
const db = admin.firestore();
const rtdb = admin.database();

let lastLocation = null;
let lastError = null;
let loginToken = null;
let pollCount = 0;

async function sinoLogin() {
  // Try multiple known SinoTrackPro API endpoints
  const endpoints = [
    { url: 'https://www.sinotrackpro.com/api/user/login', data: { username: '7026265708', password: '123456' } },
    { url: 'https://www.sinotrackpro.com/api/login', data: { account: '7026265708', password: '123456' } },
    { url: 'https://www.sinotrackpro.com/api/login', data: { username: '7026265708', password: '123456' } },
    { url: 'https://app.sinotrackpro.com/api/user/login', data: { username: '7026265708', password: '123456' } }
  ];
  
  for (let ep of endpoints) {
    try {
      console.log(`Trying login ${ep.url}`);
      const res = await axios.post(ep.url, ep.data, { timeout: 10000 });
      console.log(`Login response ${ep.url}:`, JSON.stringify(res.data).substring(0,500));
      if (res.data && (res.data.token || res.data.data?.token || res.data.result?.token)) {
        loginToken = res.data.token || res.data.data?.token || res.data.result?.token;
        return loginToken;
      }
      if (res.data && res.data.code === 0) {
        loginToken = res.data.token || 'ok';
        return loginToken;
      }
    } catch(e) {
      console.log(`Login failed ${ep.url}: ${e.message}`);
    }
  }
  return null;
}

async function fetchLocation() {
  pollCount++;
  try {
    // Method 1: Try direct device API with token
    if (!loginToken) await sinoLogin();
    
    // Try to get device list / location
    const urls = [
      `https://www.sinotrackpro.com/api/device/list`,
      `https://www.sinotrackpro.com/api/device/7026265708/realTime`,
      `https://www.sinotrackpro.com/api/device/7026265708/location`,
      `https://app.sinotrackpro.com/api/device/list`
    ];
    
    for (let url of urls) {
      try {
        const res = await axios.get(url, {
          headers: loginToken ? { Authorization: `Bearer ${loginToken}`, token: loginToken } : {},
          params: { account: '7026265708' },
          timeout: 10000
        });
        const txt = JSON.stringify(res.data);
        console.log(`Poll ${url}: ${txt.substring(0,800)}`);
        
        // Try to extract lat/lng from response
        let lat, lng;
        // Look for common patterns
        const data = res.data.data || res.data.result || res.data.devices || res.data;
        if (Array.isArray(data)) {
          const dev = data.find(d => (d.imei||d.deviceId||d.id||'').toString().includes('7026265708')) || data[0];
          if (dev) {
            lat = dev.lat || dev.latitude || dev.latitud || dev.y;
            lng = dev.lng || dev.lon || dev.longitude || dev.longitud || dev.x;
          }
        } else if (data.lat) {
          lat = data.lat; lng = data.lng || data.lon;
        } else if (data.latitude) {
          lat = data.latitude; lng = data.longitude;
        }
        
        if (lat && lng) {
          lat = parseFloat(lat); lng = parseFloat(lng);
          if (!isNaN(lat) && !isNaN(lng) && lat !== 0) {
            await saveToFirebase(lat, lng);
            return;
          }
        }
      } catch(e) {
        console.log(`Fetch ${url} error: ${e.message}`);
      }
    }
    
    // Method 2: If API fails, try scraping the web page (fallback - uses session)
    // For now, if all fails, we keep last known and log
    lastError = `Poll ${pollCount}: Could not parse location from API - check logs for format`;
    console.log(lastError);
    
  } catch(e) {
    lastError = e.message;
    console.error('Poll error', e.message);
  }
}

async function saveToFirebase(lat, lng) {
  lastLocation = { lat, lng, time: new Date().toISOString() };
  lastError = null;
  console.log(`✅ REAL TRACKER 7026265708 -> ${lat}, ${lng}`);
  
  try {
    const ref = db.collection('buses').doc('bus-2501');
    const snap = await ref.get();
    const prev = snap.exists ? snap.data() : {};
    
    const update = {
      lat: lat,
      lng: lng,
      lastLat: lat,
      lastLng: lng,
      lastUpdate: Date.now(),
      lastLive: Date.now(),
      linkStatus: 'Online',
      imei: '7026265708',
      showToCustomers: prev.hasOwnProperty('showToCustomers') ? prev.showToCustomers : true
    };
    
    await ref.set(update, { merge: true });
    await rtdb.ref('buses/bus-2501').set(update);
    console.log('Wrote to Firebase buses/bus-2501');
  } catch(e) {
    console.error('Firebase write error', e.message);
    lastError = e.message;
  }
}

// Poll every 30 seconds
setInterval(fetchLocation, 30000);
fetchLocation(); // first run immediate

// Manual trigger endpoint for testing
app.get('/force-poll', async (req,res) => {
  await fetchLocation();
  res.json({ lastLocation, lastError, pollCount });
});

app.get('/set-location', async (req,res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).send('need ?lat=41.xxx&lng=-87.xxx');
  await saveToFirebase(parseFloat(lat), parseFloat(lng));
  res.json({ ok: true, lat, lng });
});

app.get('/', (req,res) => {
  res.send(`
    <h1>RVM Bus 2501 - Real Tracker Bridge</h1>
    <p>Status: Running on Render</p>
    <p>Last Location: ${JSON.stringify(lastLocation)}</p>
    <p>Last Error: ${lastError || 'none'}</p>
    <p>Polls: ${pollCount}</p>
    <p>IMEI: 7026265708 | SIM: 815-278-4768</p>
    <p><a href="/force-poll">Force Poll Now</a></p>
    <p>Test: /set-location?lat=41.1201&lng=-87.8845</p>
  `);
});

app.get('/health', (req,res) => res.json({ ok: true, lastLocation, lastError }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`HTTP server on ${PORT}`));    const lat = latDir === 'S' ? -latDeg : latDeg;
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

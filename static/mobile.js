/**
 * NanoNavs Driver — Mobile Edge Sensor Rig & Rewards Engine
 * 
 * Exclusively tailored for smartphones:
 * - Driver Authentication (Signup / Login with 100 welcome points)
 * - Raw Hardware Telemetry streaming to Central Server
 * - Dedicated Web Worker & Silent Audio Keepalive
 * - North-aligned forward-bearing vehicle chevron
 * - Rewards Store & Coupon Redemption Wallet
 * - Graceful HTTP polling fallback for Vercel serverless deployment
 */

// ── Mobile App State ─────────────────────────────────────────────────────────

const mobileState = {
  user: null,
  token: localStorage.getItem('nanonavs_token') || null,
  tripActive: false,
  tripId: null,
  startTime: null,
  
  // Real-time metrics
  currentSpeed: 0,
  peakG: 1.0,
  roadQualityScore: 100,
  packetsStreamed: 0,
  anomaliesDetected: 0,
  detectedAnomaliesList: [],
  lastHeading: 0,
  
  // Hardware buffers
  lastMotion: { x: 0, y: 0, z: 1.0 },
  lastGyro: { x: 0, y: 0, z: 0 },
  lastGps: { lat: 12.9716, lon: 77.5946, speed: 0, alt: 920 },
  lastFrameSendTime: 0,
  
  // Sensors & Background
  geoWatchId: null,
  wakeLock: null,
  sensorWorker: null,
  audioContext: null,
  micAnalyser: null,
  oscCanvas: null,
  oscCtx: null,
  vibrationHistory: new Array(60).fill(1.0),
  
  // Simulation fallback
  simTimer: null,
  simIndex: 0,
  
  // Maps
  miniMap: null,
  fullMap: null,
  miniMarker: null,
  fullMarker: null,
  anomalyMarkersGroup: null
};

// ── Initialization ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initMobileAuth();
  initNavigationTabs();
  initMobileMaps();
  initMobileOscilloscope();
  initWorker();
  initActionListeners();
  registerServiceWorker();
  fetchUniversalHazards();
  
  if (window.lucide) window.lucide.createIcons();
});

// ── Authentication & Security ────────────────────────────────────────────────

async function initMobileAuth() {
  if (mobileState.token) {
    try {
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${mobileState.token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setAuthenticatedUser(data.user);
        return;
      }
    } catch (e) {
      console.warn('Session verification fallback:', e);
    }
  }

  // Not logged in: set default guest or show auth prompt
  setGuestUser();
}

function setAuthenticatedUser(user) {
  mobileState.user = user;
  updateUserUI();
  document.getElementById('auth-modal').classList.remove('open');
  loadRewardsMarketplace();
}

function setGuestUser() {
  mobileState.user = {
    user_id: 'guest_driver',
    username: 'guest',
    full_name: 'Guest Driver',
    role: 'driver',
    points_balance: 100,
    km_driven: 0.0,
    anomalies_reported: 0
  };
  updateUserUI();
  loadRewardsMarketplace();
}

function updateUserUI() {
  const u = mobileState.user;
  if (!u) return;
  document.getElementById('header-points-val').innerText = `${u.points_balance} pts`;
  document.getElementById('rewards-balance-val').innerText = u.points_balance;
  document.getElementById('profile-name-val').innerText = u.full_name || u.username;
  document.getElementById('profile-email-val').innerText = u.email || 'guest@nanonavs.com';
  document.getElementById('profile-km-val').innerText = (u.km_driven || 0).toFixed(1);
  document.getElementById('profile-anom-val').innerText = u.anomalies_reported || 0;
  document.getElementById('profile-points-val').innerText = u.points_balance;
  document.getElementById('profile-role-badge').innerText = u.role === 'admin' ? 'Civic Officer' : 'Verified Driver';
}

// ── Tabbed Viewport Navigation ───────────────────────────────────────────────

function initNavigationTabs() {
  const navItems = document.querySelectorAll('.mobile-bottom-nav .nav-item');
  navItems.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-tab');
      
      navItems.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('.tab-view').forEach((tab) => {
        tab.classList.remove('active');
      });

      const activeTab = document.getElementById(targetId);
      if (activeTab) {
        activeTab.classList.add('active');
        if (targetId === 'tab-map' && mobileState.fullMap) {
          setTimeout(() => mobileState.fullMap.invalidateSize(), 150);
        } else if (targetId === 'tab-cockpit' && mobileState.miniMap) {
          setTimeout(() => mobileState.miniMap.invalidateSize(), 150);
        } else if (targetId === 'tab-rewards') {
          loadRewardsMarketplace();
          loadMyRedeemedVouchers();
        }
      }
    });
  });

  // Points pill in header opens rewards tab
  document.getElementById('driver-points-pill').addEventListener('click', () => {
    document.querySelector('.nav-item[data-tab="tab-rewards"]').click();
  });

  // Profile icon in header opens profile tab
  document.getElementById('btn-auth-profile').addEventListener('click', () => {
    if (mobileState.user && mobileState.user.user_id !== 'guest_driver') {
      document.querySelector('.nav-item[data-tab="tab-profile"]').click();
    } else {
      document.getElementById('auth-modal').classList.add('open');
    }
  });
}

// ── Leaflet Maps Setup (ArcGIS Dark Gray Canvas - 100% Free) ─────────────────

function initMobileMaps() {
  const esriDarkUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
  const esriRefUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}';

  // 1. Cockpit Mini-Map
  mobileState.miniMap = L.map('mobile-mini-map', {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    touchZoom: false,
    scrollWheelZoom: false,
    doubleClickZoom: false
  }).setView([12.9716, 77.5946], 15);

  L.tileLayer(esriDarkUrl, { maxZoom: 19 }).addTo(mobileState.miniMap);
  L.tileLayer(esriRefUrl, { maxZoom: 19 }).addTo(mobileState.miniMap);

  // 2. Full Universal Map Tab
  mobileState.fullMap = L.map('mobile-full-map', {
    zoomControl: false,
    attributionControl: false
  }).setView([12.9716, 77.5946], 14);

  L.tileLayer(esriDarkUrl, { maxZoom: 19 }).addTo(mobileState.fullMap);
  L.tileLayer(esriRefUrl, { maxZoom: 19 }).addTo(mobileState.fullMap);

  mobileState.anomalyMarkersGroup = L.layerGroup().addTo(mobileState.fullMap);

  // Acquire current GPS position immediately
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        mobileState.lastGps.lat = latitude;
        mobileState.lastGps.lon = longitude;
        updateMobileVehicleMarker(latitude, longitude, 0);
        mobileState.miniMap.setView([latitude, longitude], 16);
        mobileState.fullMap.setView([latitude, longitude], 15);
        document.getElementById('gps-accuracy-label').innerText = `GPS: ±${Math.round(pos.coords.accuracy || 5)}m`;
      },
      () => {
        updateMobileVehicleMarker(12.9716, 77.5946, 0);
      },
      { timeout: 6000, enableHighAccuracy: true }
    );
  } else {
    updateMobileVehicleMarker(12.9716, 77.5946, 0);
  }
}

// ── Great-Circle Forward Bearing & Vehicle Marker ───────────────────────────

function calculateBearing(lat1, lon1, lat2, lon2) {
  if (lat1 === lat2 && lon1 === lon2) return 0;
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const phi1 = lat1 * toRad;
  const phi2 = lat2 * toRad;
  const deltaLambda = (lon2 - lon1) * toRad;
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const theta = Math.atan2(y, x);
  return (theta * toDeg + 360) % 360;
}

function updateMobileVehicleMarker(lat, lon, heading) {
  const normHeading = Math.round(heading || 0);

  // Chevron Vector SVG pointing North (12, 2)
  const chevronHTML = `
    <div class="nav-vehicle-pointer" style="transform: rotate(${normHeading}deg);">
      <svg viewBox="0 0 24 24" width="28" height="28" style="display:block; overflow:visible;">
        <polygon points="12,2 22,20 12,16 2,20" fill="#06b6d4" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
      </svg>
    </div>
  `;

  const chevronIcon = L.divIcon({
    html: chevronHTML,
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 14]
  });

  // Update Mini Map Marker
  if (!mobileState.miniMarker) {
    mobileState.miniMarker = L.marker([lat, lon], { icon: chevronIcon }).addTo(mobileState.miniMap);
  } else {
    mobileState.miniMarker.setLatLng([lat, lon]);
    const el = mobileState.miniMarker.getElement();
    if (el) {
      const ptr = el.querySelector('.nav-vehicle-pointer');
      if (ptr) ptr.style.transform = `rotate(${normHeading}deg)`;
    }
  }
  mobileState.miniMap.panTo([lat, lon], { animate: true });

  // Update Full Map Marker
  if (!mobileState.fullMarker) {
    mobileState.fullMarker = L.marker([lat, lon], { icon: chevronIcon }).addTo(mobileState.fullMap);
  } else {
    mobileState.fullMarker.setLatLng([lat, lon]);
    const el = mobileState.fullMarker.getElement();
    if (el) {
      const ptr = el.querySelector('.nav-vehicle-pointer');
      if (ptr) ptr.style.transform = `rotate(${normHeading}deg)`;
    }
  }
}

// ── Trip Lifecycle & Edge Streaming ─────────────────────────────────────────

async function toggleTrip() {
  if (!mobileState.tripActive) {
    startTrip();
  } else {
    stopTrip();
  }
}

async function startTrip() {
  mobileState.tripActive = true;
  mobileState.tripId = `TRIP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  mobileState.startTime = Date.now();
  mobileState.packetsStreamed = 0;
  mobileState.anomaliesDetected = 0;
  mobileState.detectedAnomaliesList = [];
  mobileState.roadQualityScore = 100;

  // UI Updates
  const btn = document.getElementById('btn-mobile-toggle-trip');
  btn.classList.add('active');
  document.getElementById('btn-trip-text').innerText = 'END TRIP';
  document.getElementById('btn-trip-icon').setAttribute('data-lucide', 'square');
  document.getElementById('btn-mobile-flag').disabled = false;
  document.getElementById('cockpit-mode-label').innerText = 'Active Telemetry Stream';
  if (window.lucide) window.lucide.createIcons();

  // Background keepalive & wake-lock
  acquireWakeLock();
  if (window.keepAliveEngine) window.keepAliveEngine.start();

  // Start hardware sensors
  startHardwareSensors();

  // Notify backend
  try {
    await fetch('/api/trip/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trip_id: mobileState.tripId,
        user_id: mobileState.user ? mobileState.user.user_id : 'guest_driver',
        route_name: 'Mobile Smartphone Telemetry',
        start_lat: mobileState.lastGps.lat,
        start_lon: mobileState.lastGps.lon,
        end_lat: mobileState.lastGps.lat,
        end_lon: mobileState.lastGps.lon
      })
    });
  } catch (e) {
    console.warn('Trip start notice:', e);
  }
}

async function stopTrip() {
  if (!mobileState.tripActive) return;
  mobileState.tripActive = false;

  // UI updates
  const btn = document.getElementById('btn-mobile-toggle-trip');
  btn.classList.remove('active');
  document.getElementById('btn-trip-text').innerText = 'START TRIP';
  document.getElementById('btn-trip-icon').setAttribute('data-lucide', 'play');
  document.getElementById('btn-mobile-flag').disabled = true;
  document.getElementById('cockpit-mode-label').innerText = 'Trip Finished • Syncing';
  if (window.lucide) window.lucide.createIcons();

  // Stop sensors & release locks
  stopHardwareSensors();
  releaseWakeLock();
  if (window.keepAliveEngine) window.keepAliveEngine.stop();

  // Finalize trip on server
  const durationSec = (Date.now() - mobileState.startTime) / 1000;
  const distanceKm = Math.max(0.2, (mobileState.currentSpeed * (durationSec / 3600)));

  try {
    const res = await fetch('/api/trip/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trip_id: mobileState.tripId,
        user_id: mobileState.user ? mobileState.user.user_id : 'guest_driver',
        route_name: 'Mobile Vehicle Telemetry',
        start_lat: mobileState.lastGps.lat,
        start_lon: mobileState.lastGps.lon,
        end_lat: mobileState.lastGps.lat,
        end_lon: mobileState.lastGps.lon,
        distance_km: distanceKm,
        duration_sec: durationSec,
        detected_anomalies: mobileState.detectedAnomaliesList
      })
    });

    const data = await res.json();
    openTripReport(data, distanceKm);
  } catch (err) {
    openTripReport({
      points_earned: Math.max(10, Math.round(distanceKm * 10)),
      report: { road_quality_score: mobileState.roadQualityScore, anomaly_count: mobileState.anomaliesDetected }
    }, distanceKm);
  }
}

function openTripReport(data, distanceKm) {
  const pts = data.points_earned || 25;
  document.getElementById('report-earned-pts').innerText = pts;
  
  if (mobileState.user) {
    mobileState.user.points_balance = (mobileState.user.points_balance || 0) + pts;
    mobileState.user.km_driven = (mobileState.user.km_driven || 0) + distanceKm;
    updateUserUI();
  }

  document.getElementById('report-new-balance').innerText = `New Balance: ${mobileState.user ? mobileState.user.points_balance : 125} pts`;
  document.getElementById('rep-dist-val').innerText = `${distanceKm.toFixed(1)} km`;
  document.getElementById('rep-score-val').innerText = mobileState.roadQualityScore;
  document.getElementById('rep-anom-val').innerText = mobileState.anomaliesDetected;

  document.getElementById('mobile-report-modal').classList.add('open');
  if (window.lucide) window.lucide.createIcons();
}

// ── Physical Smartphone Hardware Sensors ─────────────────────────────────────

function startHardwareSensors() {
  // Motion permissions on iOS 13+
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission().catch(console.warn);
  }
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().catch(console.warn);
  }

  window.addEventListener('devicemotion', onDeviceMotion);
  window.addEventListener('deviceorientation', onDeviceOrientation);

  if (navigator.geolocation) {
    mobileState.geoWatchId = navigator.geolocation.watchPosition(
      onGeolocationUpdate,
      (err) => console.warn('GPS watch error:', err),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 }
    );
  }

  startAcousticMicrophone();
}

function stopHardwareSensors() {
  window.removeEventListener('devicemotion', onDeviceMotion);
  window.removeEventListener('deviceorientation', onDeviceOrientation);
  if (mobileState.geoWatchId !== null) {
    navigator.geolocation.clearWatch(mobileState.geoWatchId);
    mobileState.geoWatchId = null;
  }
  stopAcousticMicrophone();
  stopSimDrive();
}

function onDeviceMotion(e) {
  if (!mobileState.tripActive) return;
  const a = e.accelerationIncludingGravity || e.acceleration;
  if (!a) return;

  const zG = a.z ? a.z / 9.80665 : 1.0;
  const xG = a.x ? a.x / 9.80665 : 0.0;
  const yG = a.y ? a.y / 9.80665 : 0.0;

  mobileState.lastMotion = { x: xG, y: yG, z: zG };
  updateOscilloscope(zG);
  dispatchSensorPacket(xG, yG, zG);
}

function onDeviceOrientation(e) {
  if (!mobileState.tripActive) return;
  mobileState.lastGyro = {
    x: ((e.beta || 0) * Math.PI) / 180,
    y: ((e.gamma || 0) * Math.PI) / 180,
    z: ((e.alpha || 0) * Math.PI) / 180
  };

  const gyroMag = Math.sqrt(
    mobileState.lastGyro.x ** 2 + mobileState.lastGyro.y ** 2 + mobileState.lastGyro.z ** 2
  );
  document.getElementById('mobile-hud-gyro').innerText = gyroMag.toFixed(2);

  // Phone-Handling Guard indicator
  const banner = document.getElementById('mobile-guard-alert');
  if (gyroMag >= 2.5) {
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

function onGeolocationUpdate(pos) {
  if (!mobileState.tripActive) return;
  const { latitude, longitude, speed, altitude, heading, accuracy } = pos.coords;
  const speedKmh = speed ? Math.round(speed * 3.6) : mobileState.currentSpeed;

  let activeHeading = heading;
  if (activeHeading === null || activeHeading === undefined || isNaN(activeHeading) || activeHeading === 0) {
    if (mobileState.lastGps.lat !== latitude || mobileState.lastGps.lon !== longitude) {
      activeHeading = calculateBearing(mobileState.lastGps.lat, mobileState.lastGps.lon, latitude, longitude);
    } else {
      activeHeading = mobileState.lastHeading || 0;
    }
  }
  mobileState.lastHeading = activeHeading;

  mobileState.lastGps = {
    lat: latitude,
    lon: longitude,
    speed: speedKmh,
    alt: altitude || 920,
    heading: activeHeading
  };

  mobileState.currentSpeed = speedKmh;
  document.getElementById('mobile-hud-speed').innerText = speedKmh;
  document.getElementById('gps-accuracy-label').innerText = `GPS: ±${Math.round(accuracy || 4)}m`;

  updateMobileVehicleMarker(latitude, longitude, activeHeading);
}

// ── Sensor Packet Dispatcher (Edge Streamer) ────────────────────────────────

function dispatchSensorPacket(xG, yG, zG) {
  const timestamp = Date.now() / 1000;
  const acoustic = getAcousticReading();

  const frame = {
    trip_id: mobileState.tripId,
    timestamp: timestamp,
    latitude: mobileState.lastGps.lat,
    longitude: mobileState.lastGps.lon,
    altitude_m: mobileState.lastGps.alt,
    accel_x: xG,
    accel_y: yG,
    accel_z: zG,
    gyro_x: mobileState.lastGyro.x,
    gyro_y: mobileState.lastGyro.y,
    gyro_z: mobileState.lastGyro.z,
    speed_kmh: mobileState.currentSpeed,
    decibel_level: acoustic ? acoustic.decibel_level : 0,
    dominant_frequency_hz: acoustic ? acoustic.dominant_frequency_hz : 0
  };

  // Pass to Web Worker
  if (mobileState.sensorWorker) {
    mobileState.sensorWorker.postMessage({ type: 'PROCESS_FRAME', payload: frame });
  }

  // Update HUD
  const impactDev = Math.abs(zG - 1.0);
  document.getElementById('mobile-hud-g').innerText = `${zG.toFixed(2)}g`;

  // Stream packet to server throttled to ~150ms (conserve bandwidth)
  const now = Date.now();
  if (!mobileState.lastFrameSendTime || (now - mobileState.lastFrameSendTime) >= 150) {
    mobileState.lastFrameSendTime = now;
    mobileState.packetsStreamed++;
    document.getElementById('mobile-packets-label').innerText = `${mobileState.packetsStreamed} pkts streamed`;
    
    streamPacketToServer(frame);
  }
}

async function streamPacketToServer(frame) {
  try {
    const res = await fetch('/api/trip/frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(frame)
    });
    const data = await res.json();
    if (data.detected && data.anomaly) {
      handleServerAnomaly(data.anomaly);
    }
  } catch (err) {
    // Resilient to jitter
  }
}

function handleServerAnomaly(anomaly) {
  mobileState.anomaliesDetected++;
  mobileState.detectedAnomaliesList.push(anomaly);

  // Update Road Quality Score
  mobileState.roadQualityScore = Math.max(15, mobileState.roadQualityScore - 6);
  const scoreEl = document.getElementById('mobile-hud-score');
  scoreEl.innerText = mobileState.roadQualityScore;
  if (mobileState.roadQualityScore >= 80) scoreEl.className = 'hw-value quality-good';
  else if (mobileState.roadQualityScore >= 50) scoreEl.className = 'hw-value quality-fair';
  else scoreEl.className = 'hw-value quality-poor';

  // Haptic & chime alert
  if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
}

// ── Acoustic Microphone Measurement ──────────────────────────────────────────

async function startAcousticMicrophone() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    mobileState.audioContext = new AudioCtx();
    const source = mobileState.audioContext.createMediaStreamSource(stream);
    mobileState.micAnalyser = mobileState.audioContext.createAnalyser();
    mobileState.micAnalyser.fftSize = 256;
    source.connect(mobileState.micAnalyser);
  } catch (e) {
    console.warn('Microphone not available for acoustic telemetry:', e);
  }
}

function stopAcousticMicrophone() {
  if (mobileState.audioContext && mobileState.audioContext.state !== 'closed') {
    mobileState.audioContext.close();
  }
}

function getAcousticReading() {
  if (!mobileState.micAnalyser) return null;
  const dataArray = new Uint8Array(mobileState.micAnalyser.frequencyBinCount);
  mobileState.micAnalyser.getByteFrequencyData(dataArray);

  let sum = 0, maxVal = 0, maxIdx = 0;
  for (let i = 0; i < dataArray.length; i++) {
    sum += dataArray[i];
    if (dataArray[i] > maxVal) { maxVal = dataArray[i]; maxIdx = i; }
  }
  const avg = sum / dataArray.length;
  const db = 32 + (avg / 255) * 60;
  const freq = maxIdx * (mobileState.audioContext.sampleRate / mobileState.micAnalyser.fftSize);

  document.getElementById('mobile-hud-db').innerText = `${Math.round(db)} dB`;
  return { decibel_level: Math.round(db * 10) / 10, dominant_frequency_hz: Math.round(freq) };
}

// ── Oscilloscope Canvas ──────────────────────────────────────────────────────

function initMobileOscilloscope() {
  mobileState.oscCanvas = document.getElementById('mobileOscilloscope');
  if (mobileState.oscCanvas) {
    mobileState.oscCtx = mobileState.oscCanvas.getContext('2d');
    mobileState.oscCanvas.width = mobileState.oscCanvas.parentElement.clientWidth - 24;
    mobileState.oscCanvas.height = 55;
  }
}

function updateOscilloscope(val) {
  mobileState.vibrationHistory.push(val);
  mobileState.vibrationHistory.shift();

  const ctx = mobileState.oscCtx;
  const canvas = mobileState.oscCanvas;
  if (!ctx || !canvas) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Baseline
  ctx.strokeStyle = '#27272a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  // Waveform
  ctx.strokeStyle = '#06b6d4';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const step = w / (mobileState.vibrationHistory.length - 1);
  for (let i = 0; i < mobileState.vibrationHistory.length; i++) {
    const dev = mobileState.vibrationHistory[i] - 1.0;
    const y = (h / 2) - (dev * 35);
    const clampedY = Math.max(2, Math.min(h - 2, y));
    if (i === 0) ctx.moveTo(0, clampedY);
    else ctx.lineTo(i * step, clampedY);
  }
  ctx.stroke();
}

// ── Rewards Store & Coupons Engine ──────────────────────────────────────────

async function loadRewardsMarketplace() {
  const container = document.getElementById('rewards-store-view');
  try {
    const res = await fetch('/api/rewards/coupons');
    const data = await res.json();
    const coupons = data.coupons || [];

    if (coupons.length === 0) {
      container.innerHTML = '<div class="loading-state">No coupons currently available in catalog.</div>';
      return;
    }

    const userPts = mobileState.user ? mobileState.user.points_balance : 0;

    container.innerHTML = coupons.map((c) => {
      const canAfford = userPts >= c.points_cost;
      return `
        <div class="coupon-card">
          <div class="coupon-top">
            <span class="coupon-brand-badge">${c.brand}</span>
            <span class="coupon-cost-pill">${c.points_cost} PTS</span>
          </div>
          <div class="coupon-title">${c.title}</div>
          <div class="coupon-desc">${c.description}</div>
          <div class="coupon-action-row">
            <span class="coupon-expiry">Valid for ${c.expiry_days} days</span>
            <button class="btn-redeem-coupon" ${!canAfford ? 'disabled' : ''} onclick="redeemCouponAction('${c.coupon_id}')">
              ${canAfford ? 'Redeem Voucher' : 'Need More Points'}
            </button>
          </div>
        </div>
      `;
    }).join('');
    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    container.innerHTML = '<div class="loading-state" style="color:var(--status-rose);">Failed to load coupons.</div>';
  }
}

async function redeemCouponAction(couponId) {
  if (!mobileState.token) {
    document.getElementById('auth-modal').classList.add('open');
    return;
  }

  try {
    const res = await fetch('/api/rewards/redeem', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${mobileState.token}`
      },
      body: JSON.stringify({ coupon_id: couponId })
    });

    const data = await res.json();
    if (res.ok && data.status === 'success') {
      const r = data.redemption;
      if (mobileState.user) {
        mobileState.user.points_balance = r.new_points_balance;
        updateUserUI();
      }
      alert(`Voucher Claimed!\nPromo Code: ${r.promo_code}\nPresent at ${r.brand} to claim discount.`);
      
      // Switch to My Vouchers tab
      document.getElementById('seg-vouchers-btn').click();
    } else {
      alert(data.detail || 'Redemption failed.');
    }
  } catch (e) {
    console.error('Redeem error:', e);
  }
}

async function loadMyRedeemedVouchers() {
  const container = document.getElementById('rewards-vouchers-view');
  if (!mobileState.token) {
    container.innerHTML = '<div class="loading-state">Sign in to view your redeemed wallet vouchers.</div>';
    return;
  }

  try {
    const res = await fetch('/api/rewards/my-coupons', {
      headers: { 'Authorization': `Bearer ${mobileState.token}` }
    });
    const data = await res.json();
    const list = data.coupons || [];
    document.getElementById('my-vouchers-count').innerText = list.length;

    if (list.length === 0) {
      container.innerHTML = '<div class="loading-state">You have no active vouchers yet. Earn points by driving to claim coupons!</div>';
      return;
    }

    container.innerHTML = list.map((v) => `
      <div class="voucher-card">
        <div class="coupon-top">
          <span class="coupon-brand-badge">${v.brand}</span>
          <span class="role-badge" style="background:rgba(16,185,129,0.15); color:#34d399;">${v.status}</span>
        </div>
        <div class="coupon-title" style="margin-top:6px;">${v.title}</div>
        
        <div class="voucher-code-box">
          <span class="voucher-code">${v.promo_code}</span>
          <button class="btn-copy-code" onclick="copyPromoCode('${v.promo_code}', this)">Copy</button>
        </div>
        
        <div style="font-size:0.7rem; color:var(--foreground-dim);">
          Expires on: ${new Date(v.expires_at).toLocaleDateString()}
        </div>
      </div>
    `).join('');
    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    container.innerHTML = '<div class="loading-state" style="color:var(--status-rose);">Failed to load vouchers.</div>';
  }
}

window.copyPromoCode = function(code, btn) {
  navigator.clipboard.writeText(code).then(() => {
    const orig = btn.innerText;
    btn.innerText = 'Copied!';
    setTimeout(() => btn.innerText = orig, 1800);
  });
};

// ── Action Listeners & Event Handlers ────────────────────────────────────────

function initActionListeners() {
  // Toggle Trip Button
  document.getElementById('btn-mobile-toggle-trip').addEventListener('click', toggleTrip);

  // Flag Hazard Button
  document.getElementById('btn-mobile-flag').addEventListener('click', async () => {
    try {
      await fetch('/api/anomalies/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          anomaly_type: 'pothole',
          severity: 'high',
          latitude: mobileState.lastGps.lat,
          longitude: mobileState.lastGps.lon,
          description: 'Citizen driver flagged road hazard'
        })
      });
      alert('Hazard logged! +25 Points awarded on server verification.');
      if (mobileState.user) {
        mobileState.user.points_balance += 25;
        updateUserUI();
      }
    } catch (e) {
      console.warn('Flag error:', e);
    }
  });

  // Segmented Store vs Vouchers
  document.getElementById('seg-store-btn').addEventListener('click', () => {
    document.getElementById('seg-store-btn').classList.add('active');
    document.getElementById('seg-vouchers-btn').classList.remove('active');
    document.getElementById('rewards-store-view').style.display = 'flex';
    document.getElementById('rewards-vouchers-view').style.display = 'none';
    loadRewardsMarketplace();
  });

  document.getElementById('seg-vouchers-btn').addEventListener('click', () => {
    document.getElementById('seg-vouchers-btn').classList.add('active');
    document.getElementById('seg-store-btn').classList.remove('active');
    document.getElementById('rewards-vouchers-view').style.display = 'flex';
    document.getElementById('rewards-store-view').style.display = 'none';
    loadMyRedeemedVouchers();
  });

  // Re-center Map button
  document.getElementById('btn-map-recenter').addEventListener('click', () => {
    if (mobileState.fullMap) {
      mobileState.fullMap.setView([mobileState.lastGps.lat, mobileState.lastGps.lon], 16, { animate: true });
    }
  });

  // Refresh Hazards
  document.getElementById('btn-map-refresh').addEventListener('click', fetchUniversalHazards);

  // Switch to Desktop
  document.getElementById('btn-desktop-switch').addEventListener('click', () => {
    window.location.href = '/';
  });

  // Logout
  document.getElementById('btn-mobile-logout').addEventListener('click', () => {
    localStorage.removeItem('nanonavs_token');
    mobileState.token = null;
    setGuestUser();
    alert('Logged out successfully.');
  });

  // Close report modal
  document.getElementById('btn-close-report').addEventListener('click', () => {
    document.getElementById('mobile-report-modal').classList.remove('open');
  });

  // Auth Modal Controls
  let isSignupMode = false;
  const tabLogin = document.getElementById('tab-login-btn');
  const tabSignup = document.getElementById('tab-signup-btn');
  const nameField = document.getElementById('auth-name-field');
  const emailField = document.getElementById('auth-email-field');
  const idLbl = document.getElementById('auth-identity-lbl');
  const submitBtn = document.getElementById('btn-auth-submit');

  tabLogin.addEventListener('click', (e) => {
    e.preventDefault();
    isSignupMode = false;
    tabLogin.classList.add('active');
    tabSignup.classList.remove('active');
    nameField.style.display = 'none';
    emailField.style.display = 'none';
    idLbl.innerText = 'Username or Email';
    submitBtn.innerText = 'Sign In';
    document.getElementById('auth-title').innerText = 'Driver Sign In';
  });

  tabSignup.addEventListener('click', (e) => {
    e.preventDefault();
    isSignupMode = true;
    tabSignup.classList.add('active');
    tabLogin.classList.remove('active');
    nameField.style.display = 'flex';
    emailField.style.display = 'flex';
    idLbl.innerText = 'Choose Username';
    submitBtn.innerText = 'Create Account (+100 pts)';
    document.getElementById('auth-title').innerText = 'Driver Registration';
  });

  document.getElementById('btn-auth-guest').addEventListener('click', () => {
    document.getElementById('auth-modal').classList.remove('open');
    setGuestUser();
  });

  // Auth Form Submit
  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('auth-error-msg');
    errBox.style.display = 'none';

    const identity = document.getElementById('auth-identity-input').value.trim();
    const password = document.getElementById('auth-password-input').value;

    try {
      if (isSignupMode) {
        const fullName = document.getElementById('auth-fullname-input').value.trim();
        const email = document.getElementById('auth-email-input').value.trim();
        const res = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: identity,
            email: email,
            password: password,
            full_name: fullName || identity,
            role: 'driver'
          })
        });
        const data = await res.json();
        if (res.ok && data.token) {
          localStorage.setItem('nanonavs_token', data.token);
          mobileState.token = data.token;
          setAuthenticatedUser(data.user);
        } else {
          errBox.innerText = data.detail || 'Sign up failed.';
          errBox.style.display = 'block';
        }
      } else {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username_or_email: identity,
            password: password
          })
        });
        const data = await res.json();
        if (res.ok && data.token) {
          localStorage.setItem('nanonavs_token', data.token);
          mobileState.token = data.token;
          setAuthenticatedUser(data.user);
        } else {
          errBox.innerText = data.detail || 'Invalid credentials.';
          errBox.style.display = 'block';
        }
      }
    } catch (err) {
      errBox.innerText = 'Network error communicating with server.';
      errBox.style.display = 'block';
    }
  });
}

// ── Screen Wake-Lock ────────────────────────────────────────────────────────

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      mobileState.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (err) {
    console.warn('WakeLock error:', err);
  }
}

function releaseWakeLock() {
  if (mobileState.wakeLock) {
    mobileState.wakeLock.release().catch(() => {});
    mobileState.wakeLock = null;
  }
}

// ── Background Web Worker ───────────────────────────────────────────────────

function initWorker() {
  try {
    mobileState.sensorWorker = new Worker('/static/sensor-worker.js');
    mobileState.sensorWorker.onmessage = (e) => {
      if (e.data && e.data.type === 'ANOMALY_TRIGGER') {
        handleServerAnomaly(e.data.payload);
      }
    };
  } catch (e) {
    console.warn('Dedicated Web Worker initialized in fallback mode:', e);
  }
}

// ── Universal Hazards on Map ────────────────────────────────────────────────

async function fetchUniversalHazards() {
  if (!mobileState.anomalyMarkersGroup) return;
  try {
    const res = await fetch('/api/anomalies?limit=500');
    const data = await res.json();
    mobileState.anomalyMarkersGroup.clearLayers();

    const colorMap = {
      pothole: '#ef4444',
      speed_bump: '#f59e0b',
      crack: '#3b82f6',
      surface_depression: '#8b5cf6',
      debris: '#ec4899'
    };

    (data.anomalies || []).forEach((a) => {
      const color = colorMap[a.anomaly_type] || '#ef4444';
      const marker = L.circleMarker([a.latitude, a.longitude], {
        radius: 6,
        color: color,
        fillColor: color,
        fillOpacity: 0.8,
        weight: 1.5
      });
      marker.bindPopup(`<strong>${a.anomaly_type.toUpperCase()}</strong><br>Impact: ${a.peak_vertical_g.toFixed(2)}g<br>Speed: ${Math.round(a.vehicle_speed_kmh || 0)} km/h<br>Verified: ${a.verified_count} vehicles`);
      marker.addTo(mobileState.anomalyMarkersGroup);
    });
  } catch (e) {
    console.warn('Hazards fetch error:', e);
  }
}

// ── Service Worker Registration ─────────────────────────────────────────────

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

function stopSimDrive() {
  if (mobileState.simTimer) {
    clearInterval(mobileState.simTimer);
    mobileState.simTimer = null;
  }
}

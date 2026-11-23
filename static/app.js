
/**
 * NanoNavs Road Intelligence — Universal Mobile & Web Client Engine
 *
 * Provides:
 * - Real-time universal map with worldwide Leaflet & OpenStreetMap routing
 * - Free-form Start/End selection anywhere on Earth or live smartphone GPS
 * - Hardware sensor acquisition (Accelerometer, Gyroscope, Microphone, GPS)
 * - Dedicated background Web Worker and Mobile Audio Keep-Alive
 * - WebSocket real-time synchronization visible to all users
 * - Driver HUD with live speedometer, vibration oscilloscope, and road quality gauge
 * - Simulation driving mode for testing on any device
 */

// ── State Variables ──────────────────────────────────────────────────────────

const state = {
  clientId: 'client_' + Math.random().toString(36).substring(2, 9),
  tripActive: false,
  tripId: null,
  mode: 'sim', // 'phone' or 'sim' - default to simulation on desktop PC
  simSpeedKmh: 45,
  startCoord: null, // [lat, lon]
  endCoord: null,   // [lat, lon]
  routePolyline: null,
  routeWaypoints: [],
  routeDistanceKm: 0,
  pickMode: null,   // 'start' or 'dest'
  
  // Real-time metrics
  currentSpeed: 0,
  peakG: 1.0,
  roadQualityScore: 100,
  anomalyHits: 0,
  detectedAnomalies: [],
  
  // Sensors & Background
  geoWatchId: null,
  wakeLock: null,
  sensorWorker: null,
  audioContext: null,
  micAnalyser: null,
  oscillatorCanvas: null,
  oscillatorCtx: null,
  vibrationHistory: new Array(100).fill(1.0),
  
  // Simulation state
  simTimer: null,
  simIndex: 0,
  
  // Presets
  presets: {
    bmsce: { name: 'BMS College of Engineering', coords: [12.9412, 77.5658] },
    'silk-board': { name: 'Silk Board Junction', coords: [12.9173, 77.6230] },
    koramangala: { name: 'Koramangala 4th Block', coords: [12.9352, 77.6245] },
    ecity: { name: 'Electronic City Phase 1', coords: [12.8399, 77.6770] },
    airport: { name: 'KIA Bengaluru Airport', coords: [13.1986, 77.7066] }
  }
};

// Map & WebSocket references
let map = null;
let ws = null;
let startMarker = null;
let destMarker = null;
let driverMarker = null;
let anomalyMarkersGroup = null;
let peerDriversGroup = null;
let routeLineLayer = null;

// Audio synthesizer for detection alerts
let alertAudioCtx = null;

// ── Initialization ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initWebSocket();
  initWorker();
  initUIEventListeners();
  initOscilloscope();
  fetchUniversalAnomalies();
  fetchServerConfig();
  registerServiceWorker();
  if (window.lucide) window.lucide.createIcons();

  // Pre-load default mission path (BMSCE -> Silk Board)
  setTimeout(() => {
    const pStart = state.presets['bmsce'];
    const pEnd = state.presets['silk-board'];
    if (pStart && pEnd) {
      setStartLocation(pStart.coords[0], pStart.coords[1], pStart.name);
      setDestination(pEnd.coords[0], pEnd.coords[1], pEnd.name);
    }
  }, 350);
});

// ── Leaflet Universal Map Setup ──────────────────────────────────────────────

function initMap() {
  // Default centered on Bengaluru (can navigate anywhere on Earth)
  map = L.map('map', {
    zoomControl: false,
    attributionControl: false
  }).setView([12.9716, 77.5946], 13);

  // High-performance ArcGIS World Dark Gray Canvas (100% Free, NO API KEY REQUIRED, Dark Zinc / Tesla HUD aesthetic)
  const esriDarkBase = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri'
  });
  const esriDarkLabels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: ''
  });

  esriDarkBase.addTo(map);
  esriDarkLabels.addTo(map);

  anomalyMarkersGroup = L.layerGroup().addTo(map);
  peerDriversGroup = L.layerGroup().addTo(map);

  // Map click handler for selecting Start or Destination
  map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    if (state.pickMode === 'start') {
      setStartLocation(lat, lng, `Start: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
      state.pickMode = null;
      document.getElementById('btn-pick-start').classList.remove('active');
    } else if (state.pickMode === 'dest') {
      setDestination(lat, lng, `Dest: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
      state.pickMode = null;
      document.getElementById('btn-pick-dest').classList.remove('active');
    } else if (!state.startCoord) {
      setStartLocation(lat, lng, `Start: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    } else if (!state.endCoord) {
      setDestination(lat, lng, `Dest: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    }
  });

  // Try to locate user immediately on open
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        map.setView([latitude, longitude], 14);
      },
      () => {},
      { timeout: 5000, enableHighAccuracy: true }
    );
  }
}

// ── WebSocket Real-Time Universal Hub & Serverless Polling Fallback ──────────

let pollingFallbackTimer = null;

function startPollingFallback() {
  if (pollingFallbackTimer) return;
  const badge = document.getElementById('connection-badge');
  const txt = document.getElementById('connection-text');
  if (badge) badge.className = 'status-pill';
  if (txt) txt.innerText = 'Cloud Sync';

  pollingFallbackTimer = setInterval(async () => {
    try {
      // 1. Fetch active fleet drivers (Vercel / Cloud serverless mode)
      const resDrivers = await fetch('/api/drivers');
      if (resDrivers.ok) {
        const dataDrivers = await resDrivers.json();
        updateActiveDriversBadge(dataDrivers.count || 0);
        if (dataDrivers.drivers) {
          dataDrivers.drivers.forEach(d => {
            if (d.user_id !== state.clientId) renderPeerDriver(d);
          });
        }
      }

      // 2. Refresh stats
      const resStats = await fetch('/api/stats');
      if (resStats.ok) {
        const stats = await resStats.json();
        if (stats.active_drivers !== undefined) {
          updateActiveDriversBadge(stats.active_drivers);
        }
      }
    } catch (e) {
      // Resilient to jitter
    }
  }, 3500);
}

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/${state.clientId}`;
  let wsConnected = false;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      wsConnected = true;
      const b = document.getElementById('connection-badge');
      const t = document.getElementById('connection-text');
      if (b) b.className = 'status-pill live';
      if (t) t.innerText = 'Live Hub';
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
      } catch (err) {
        console.error('WS Parse Error:', err);
      }
    };

    ws.onclose = () => {
      if (!wsConnected) {
        startPollingFallback();
      } else {
        setTimeout(initWebSocket, 4000);
      }
    };

    ws.onerror = () => {
      startPollingFallback();
    };
  } catch (e) {
    startPollingFallback();
  }

  // Gracefully fallback to polling on serverless cloud platforms (e.g. Vercel)
  setTimeout(() => {
    if (!wsConnected) startPollingFallback();
  }, 2500);
}

function handleWebSocketMessage(msg) {
  switch (msg.type) {
    case 'CONNECTION_ESTABLISHED':
      updateActiveDriversBadge(msg.active_drivers_count || 0);
      break;

    case 'ANOMALY_ALERT':
      // Instant alert: someone anywhere on Earth just detected or reported an anomaly!
      onUniversalAnomalyAlert(msg.anomaly, msg.action);
      break;

    case 'ANOMALY_VERIFIED':
      // Update verification badge on map
      updateAnomalyMarkerVerification(msg.anomaly_id, msg.verified_count);
      break;

    case 'DRIVER_MOVED':
      // Render peer vehicle on universal map
      if (msg.driver && msg.driver.user_id !== state.clientId) {
        renderPeerDriver(msg.driver);
      }
      updateActiveDriversBadge(msg.active_drivers_count || 0);
      break;

    case 'DRIVER_DISCONNECTED':
      removePeerDriver(msg.user_id);
      updateActiveDriversBadge(msg.active_drivers_count || 0);
      break;

    case 'TRIP_STARTED':
      console.log('Driver started trip:', msg.route_name);
      break;

    case 'TRIP_ENDED':
      console.log('Driver completed trip. Road Score:', msg.road_quality_score);
      break;
  }
}

function updateActiveDriversBadge(count) {
  document.getElementById('active-drivers-badge').innerText = `${count} Active`;
}

// ── Dedicated Background Sensor Web Worker ───────────────────────────────────

function initWorker() {
  if (window.Worker) {
    state.sensorWorker = new Worker('/static/sensor-worker.js');
    state.sensorWorker.onmessage = (e) => {
      const { type, payload } = e.data;
      if (type === 'ANOMALY_DETECTED') {
        handleLocalAnomalyHit(payload);
      } else if (type === 'PHONE_HANDLING_DETECTED') {
        showHandlingGuardAlert();
      }
    };
  }
}

function showHandlingGuardAlert() {
  const banner = document.getElementById('guard-banner');
  banner.style.display = 'flex';
  clearTimeout(banner._timer);
  banner._timer = setTimeout(() => {
    banner.style.display = 'none';
  }, 2500);
}

// ── Universal Anomaly Markers ────────────────────────────────────────────────

async function fetchUniversalAnomalies() {
  try {
    const res = await fetch('/api/anomalies?limit=500');
    const data = await res.json();
    if (data.anomalies) {
      data.anomalies.forEach((a) => addAnomalyMarkerToMap(a));
    }
  } catch (e) {
    console.warn('Failed to load initial anomalies:', e);
  }
}

function addAnomalyMarkerToMap(anomaly) {
  if (!anomaly.latitude || !anomaly.longitude) return;

  const typeSVGs = {
    pothole: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    speed_bump: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M2 18c3-6 5-6 8 0s5 6 8 0 4-4 4-4"/></svg>',
    crack: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    surface_depression: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="m16 12-4-4-4 4"/></svg>',
    debris: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/></svg>',
    unknown: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/></svg>'
  };

  const iconSvg = typeSVGs[anomaly.anomaly_type] || typeSVGs.pothole;
  const severityClass = anomaly.severity ? `severity-${anomaly.severity}` : 'severity-moderate';

  const customHtml = `
    <div class="vector-pin ${severityClass}">
      ${iconSvg}
    </div>
  `;

  const markerIcon = L.divIcon({
    html: customHtml,
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 14]
  });

  const marker = L.marker([anomaly.latitude, anomaly.longitude], {
    icon: markerIcon
  });

  marker.anomalyData = anomaly;
  marker.on('click', () => openAnomalySheet(anomaly));
  marker.addTo(anomalyMarkersGroup);
  return marker;
}

function onUniversalAnomalyAlert(anomaly, action) {
  const marker = addAnomalyMarkerToMap(anomaly);
  if (marker) {
    const el = marker.getElement();
    if (el) {
      el.classList.add('pulse-marker');
      setTimeout(() => el.classList.remove('pulse-marker'), 5000);
    }
  }

  // Play audible road alert chime
  playAlertSound();

  // Vibrate mobile device
  if (navigator.vibrate) {
    navigator.vibrate([200, 100, 200]);
  }
}

function updateAnomalyMarkerVerification(anomalyId, count) {
  anomalyMarkersGroup.eachLayer((layer) => {
    if (layer.anomalyData && layer.anomalyData.anomaly_id === anomalyId) {
      layer.anomalyData.verified_count = count;
      layer.anomalyData.status = 'verified';
    }
  });
}

function openAnomalySheet(anomaly) {
  const sheet = document.getElementById('anomaly-sheet');
  const typeSVGs = {
    pothole: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    speed_bump: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M2 18c3-6 5-6 8 0s5 6 8 0 4-4 4-4"/></svg>',
    crack: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    surface_depression: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="m16 12-4-4-4 4"/></svg>',
    debris: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/></svg>'
  };

  document.getElementById('sheet-type-icon').innerHTML = typeSVGs[anomaly.anomaly_type] || typeSVGs.pothole;
  document.getElementById('sheet-type-text').innerText = `${anomaly.anomaly_type.replace('_', ' ').toUpperCase()} DEFECT`;
  
  document.getElementById('sheet-address').innerText = anomaly.address || `${anomaly.latitude.toFixed(5)}, ${anomaly.longitude.toFixed(5)}`;
  document.getElementById('sheet-peak-g').innerText = `${anomaly.peak_vertical_g.toFixed(2)} g (Avg)`;
  document.getElementById('sheet-speed').innerText = `${Math.round(anomaly.vehicle_speed_kmh || 0)} km/h (Avg)`;
  document.getElementById('sheet-conf').innerText = `${Math.round(anomaly.confidence * 100)}%`;
  document.getElementById('sheet-verified').innerText = `${anomaly.verified_count || 1} units confirmed`;

  sheet.currentAnomalyId = anomaly.anomaly_id;
  sheet.classList.add('open');
  if (window.lucide) window.lucide.createIcons();
}

// ── Peer Drivers on Universal Map ───────────────────────────────────────────

const peerMarkers = {};

function renderPeerDriver(driver) {
  const { user_id, latitude, longitude, speed_kmh, heading, name } = driver;
  if (!latitude || !longitude) return;
  const normHeading = Math.round(heading || 0);

  if (!peerMarkers[user_id]) {
    const icon = L.divIcon({
      html: `<div class="nav-vehicle-pointer" style="transform: rotate(${normHeading}deg);">
        <svg class="nav-vehicle-svg" viewBox="0 0 24 24" width="26" height="26">
          <polygon points="12,2 22,20 12,16 2,20" fill="#22d3ee" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
        </svg>
      </div>`,
      className: '',
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
    const marker = L.marker([latitude, longitude], { icon }).addTo(peerDriversGroup);
    marker.bindPopup(`<strong>${name}</strong><br>Speed: ${Math.round(speed_kmh)} km/h`);
    peerMarkers[user_id] = marker;
  } else {
    peerMarkers[user_id].setLatLng([latitude, longitude]);
    const el = peerMarkers[user_id].getElement();
    if (el) {
      const ptr = el.querySelector('.nav-vehicle-pointer');
      if (ptr) ptr.style.transform = `rotate(${normHeading}deg)`;
    }
  }
}

function removePeerDriver(userId) {
  if (peerMarkers[userId]) {
    peerDriversGroup.removeLayer(peerMarkers[userId]);
    delete peerMarkers[userId];
  }
}

// ── Route & Location Selection (Global / Anywhere on Earth) ──────────────────

function setStartLocation(lat, lon, label) {
  state.startCoord = [lat, lon];
  document.getElementById('start-input').value = label || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

  if (startMarker) map.removeLayer(startMarker);
  const startIcon = L.divIcon({
    html: '<div style="width: 14px; height: 14px; border-radius: 50%; background: #10b981; border: 2.5px solid #fff; box-shadow: 0 0 12px rgba(16, 185, 129, 0.9);"></div>',
    className: '',
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });
  startMarker = L.marker([lat, lon], { icon: startIcon }).addTo(map);

  if (state.endCoord) calculateRoute();
  else map.panTo([lat, lon]);
}

function setDestination(lat, lon, label) {
  state.endCoord = [lat, lon];
  document.getElementById('dest-input').value = label || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

  if (destMarker) map.removeLayer(destMarker);
  const destIcon = L.divIcon({
    html: '<div style="width: 14px; height: 14px; border-radius: 50%; background: #06b6d4; border: 2.5px solid #fff; box-shadow: 0 0 12px rgba(6, 182, 212, 0.9);"></div>',
    className: '',
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });
  destMarker = L.marker([lat, lon], { icon: destIcon }).addTo(map);

  if (state.startCoord) calculateRoute();
  else map.panTo([lat, lon]);
}

async function calculateRoute() {
  if (!state.startCoord || !state.endCoord) return;

  const [sLat, sLon] = state.startCoord;
  const [eLat, eLon] = state.endCoord;

  document.getElementById('route-source-val').innerText = 'Routing...';

  try {
    const res = await fetch(`/api/route?start_lat=${sLat}&start_lon=${sLon}&end_lat=${eLat}&end_lon=${eLon}`);
    const data = await res.json();

    if (data.status === 'ok' && data.coordinates) {
      state.routeWaypoints = data.coordinates;
      state.routeDistanceKm = data.distance_km;

      document.getElementById('route-dist-val').innerText = `${data.distance_km} km`;
      document.getElementById('route-time-val').innerText = `${Math.round(data.duration_min)} min`;
      document.getElementById('route-source-val').innerText = data.source === 'osrm' ? 'OSRM Driving' : 'Direct Path';

      // Render polyline
      if (routeLineLayer) map.removeLayer(routeLineLayer);
      routeLineLayer = L.polyline(data.coordinates, {
        color: '#06b6d4',
        weight: 4.5,
        opacity: 0.9,
        lineJoin: 'round'
      }).addTo(map);

      map.fitBounds(routeLineLayer.getBounds(), { padding: [50, 50] });
    }
  } catch (err) {
    console.error('Route calculation failed:', err);
    document.getElementById('route-source-val').innerText = 'Fallback';
  }
}

// ── Trip Lifecycle & Background Execution ────────────────────────────────────

async function startTrip() {
  if (!state.startCoord || !state.endCoord) {
    alert('Please select both a Start location and Destination on the map first.');
    return;
  }

  state.tripId = 'TRIP-' + Math.random().toString(36).substring(2, 9).toUpperCase();
  state.tripActive = true;
  state.anomalyHits = 0;
  state.roadQualityScore = 100;
  state.detectedAnomalies = [];
  state.startTime = Date.now();

  // 1. Notify Backend Server
  try {
    await fetch('/api/trip/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trip_id: state.tripId,
        user_id: state.clientId,
        route_name: `${document.getElementById('start-input').value} → ${document.getElementById('dest-input').value}`,
        start_lat: state.startCoord[0],
        start_lon: state.startCoord[1],
        end_lat: state.endCoord[0],
        end_lon: state.endCoord[1]
      })
    });
  } catch (e) {
    console.warn('Backend start trip notification failed:', e);
  }

  // 2. Request Mobile Screen Wake Lock (keeps screen on during trip)
  acquireWakeLock();

  // 3. Start Background Audio Keep-Alive
  if (window.keepAliveEngine) {
    window.keepAliveEngine.start();
  }

  // 4. Configure Worker
  if (state.sensorWorker) {
    state.sensorWorker.postMessage({
      type: 'CONFIG',
      payload: { reset: true, windowSize: 5, enableHandlingGuard: true }
    });
  }

  // 5. Update UI
  document.getElementById('route-card').classList.add('collapsed');
  const chevStart = document.getElementById('toggle-chevron');
  if (chevStart) {
    chevStart.setAttribute('data-lucide', 'chevron-down');
    if (window.lucide) window.lucide.createIcons();
  }
  document.getElementById('driver-hud').style.display = 'flex';

  // 6. Launch Sensors or Simulator
  if (state.mode === 'phone') {
    startHardwareSensors();
  } else {
    startDrivingSimulator();
  }
}

async function stopTrip() {
  if (!state.tripActive) return;
  state.tripActive = false;

  // Stop sensors
  stopHardwareSensors();
  stopDrivingSimulator();

  // Release wake lock & stop keep-alive
  releaseWakeLock();
  if (window.keepAliveEngine) {
    window.keepAliveEngine.stop();
  }

  // Finalize trip on backend
  const durationSec = (Date.now() - state.startTime) / 1000;
  try {
    const res = await fetch('/api/trip/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trip_id: state.tripId,
        user_id: state.clientId,
        route_name: `${document.getElementById('start-input').value} → ${document.getElementById('dest-input').value}`,
        start_lat: state.startCoord[0],
        start_lon: state.startCoord[1],
        end_lat: state.endCoord[0],
        end_lon: state.endCoord[1],
        distance_km: state.routeDistanceKm,
        duration_sec: durationSec,
        detected_anomalies: state.detectedAnomalies
      })
    });

    const data = await res.json();
    openTripReportModal(data);
  } catch (err) {
    console.error('Trip finalization error:', err);
    // Display local summary
    openTripReportModal({
      report: {
        road_quality_score: state.roadQualityScore,
        total_distance_km: state.routeDistanceKm,
        anomaly_count: state.anomalyHits,
        summary: `Trip completed with ${state.anomalyHits} anomalies detected. Road Quality Score: ${state.roadQualityScore}/100.`
      }
    });
  }

  // Reset UI
  document.getElementById('driver-hud').style.display = 'none';
  document.getElementById('route-card').classList.remove('collapsed');
  const chevStop = document.getElementById('toggle-chevron');
  if (chevStop) {
    chevStop.setAttribute('data-lucide', 'chevron-up');
    if (window.lucide) window.lucide.createIcons();
  }
}

// ── Physical Smartphone Hardware Sensors ─────────────────────────────────────

let lastMotionData = { x: 0, y: 0, z: 1.0 };
let lastGyroData = { x: 0, y: 0, z: 0 };
let lastGpsData = { lat: 0, lon: 0, speed: 0, alt: 0 };

function startHardwareSensors() {
  // Request motion permissions if required (iOS 13+)
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission().catch(console.warn);
  }
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().catch(console.warn);
  }

  // 1. Accelerometer
  window.addEventListener('devicemotion', onDeviceMotion);

  // 2. Gyroscope (for Phone-Handling Guard)
  window.addEventListener('deviceorientation', onDeviceOrientation);

  // 3. Geolocation Watch
  if (navigator.geolocation) {
    state.geoWatchId = navigator.geolocation.watchPosition(
      onGeolocationUpdate,
      (err) => console.warn('Geo watch error:', err),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 }
    );
  }

  // 4. Acoustic road microphone
  startAcousticMicrophone();
}

function stopHardwareSensors() {
  window.removeEventListener('devicemotion', onDeviceMotion);
  window.removeEventListener('deviceorientation', onDeviceOrientation);
  if (state.geoWatchId !== null) {
    navigator.geolocation.clearWatch(state.geoWatchId);
    state.geoWatchId = null;
  }
  stopAcousticMicrophone();
}

function onDeviceMotion(e) {
  if (!state.tripActive) return;

  // Accel with gravity or fallback
  const a = e.accelerationIncludingGravity || e.acceleration;
  if (!a) return;

  // Convert m/s^2 to g (1g = 9.80665 m/s^2)
  const zG = a.z ? a.z / 9.80665 : 1.0;
  const xG = a.x ? a.x / 9.80665 : 0.0;
  const yG = a.y ? a.y / 9.80665 : 0.0;

  lastMotionData = { x: xG, y: yG, z: zG };
  updateOscilloscope(zG);

  // Ingest frame
  dispatchSensorFrame(xG, yG, zG);
}

function onDeviceOrientation(e) {
  if (!state.tripActive) return;
  // Convert deg/s rate or orientation
  lastGyroData = {
    x: ((e.beta || 0) * Math.PI) / 180,
    y: ((e.gamma || 0) * Math.PI) / 180,
    z: ((e.alpha || 0) * Math.PI) / 180
  };
}

function onGeolocationUpdate(pos) {
  if (!state.tripActive) return;

  const { latitude, longitude, speed, altitude, heading } = pos.coords;
  const speedKmh = speed ? speed * 3.6 : state.currentSpeed;

  let activeHeading = heading;
  if (activeHeading === null || activeHeading === undefined || isNaN(activeHeading) || activeHeading === 0) {
    if (lastGpsData.lat && lastGpsData.lon && (lastGpsData.lat !== latitude || lastGpsData.lon !== longitude)) {
      activeHeading = calculateBearing(lastGpsData.lat, lastGpsData.lon, latitude, longitude);
    } else {
      activeHeading = state.lastHeading || 0;
    }
  }
  state.lastHeading = activeHeading;

  lastGpsData = {
    lat: latitude,
    lon: longitude,
    speed: speedKmh,
    alt: altitude || 0,
    heading: activeHeading
  };

  state.currentSpeed = Math.round(speedKmh);
  document.getElementById('hud-speed').innerText = state.currentSpeed;

  // Update vehicle driver marker on map with dynamic bearing
  updateVehicleMarker(latitude, longitude, activeHeading);

  // Broadcast driver position via WebSocket to everyone on universal map
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'DRIVER_LOCATION',
      name: 'Mobile Driver',
      latitude: latitude,
      longitude: longitude,
      speed_kmh: speedKmh,
      heading: Math.round(activeHeading)
    }));
  }
}

// ── Acoustic Microphone Measurement ──────────────────────────────────────────

async function startAcousticMicrophone() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioCtx();
    const source = state.audioContext.createMediaStreamSource(stream);
    state.micAnalyser = state.audioContext.createAnalyser();
    state.micAnalyser.fftSize = 256;
    source.connect(state.micAnalyser);
  } catch (e) {
    console.warn('Microphone access for acoustic fusion not granted or unavailable:', e);
  }
}

function stopAcousticMicrophone() {
  if (state.audioContext && state.audioContext.state !== 'closed') {
    state.audioContext.close();
  }
}

function getAcousticReading() {
  if (!state.micAnalyser) return null;
  const dataArray = new Uint8Array(state.micAnalyser.frequencyBinCount);
  state.micAnalyser.getByteFrequencyData(dataArray);

  // Calculate approximate dB SPL
  let sum = 0;
  let maxVal = 0;
  let maxIdx = 0;
  for (let i = 0; i < dataArray.length; i++) {
    sum += dataArray[i];
    if (dataArray[i] > maxVal) {
      maxVal = dataArray[i];
      maxIdx = i;
    }
  }
  const avg = sum / dataArray.length;
  const db = 30 + (avg / 255) * 65; // Scale 30-95 dB
  const freq = maxIdx * (state.audioContext.sampleRate / state.micAnalyser.fftSize);

  return { decibel_level: Math.round(db * 10) / 10, dominant_frequency_hz: Math.round(freq) };
}

// ── Edge Sensor Telemetry Dispatcher ─────────────────────────────────────────

function dispatchSensorFrame(xG, yG, zG) {
  const timestamp = Date.now() / 1000;
  const acoustic = getAcousticReading();

  const frame = {
    trip_id: state.tripId,
    timestamp: timestamp,
    gps: {
      latitude: lastGpsData.lat || (state.startCoord ? state.startCoord[0] : 0),
      longitude: lastGpsData.lon || (state.startCoord ? state.startCoord[1] : 0),
      altitude_m: lastGpsData.alt
    },
    accelerometer: { x: xG, y: yG, z: zG },
    gyroscope: lastGyroData,
    acoustic: acoustic,
    speed_kmh: state.currentSpeed
  };

  // 1. Send to background Web Worker for local thread-safe processing & filtering
  if (state.sensorWorker) {
    state.sensorWorker.postMessage({
      type: 'PROCESS_FRAME',
      payload: frame
    });
  }

  // 2. Stream raw telemetry packet to central cloud engine (Edge Sensor Streamer)
  state.packetsStreamed = (state.packetsStreamed || 0) + 1;
  const pktElem = document.getElementById('edge-packet-count');
  if (pktElem) pktElem.innerText = `${state.packetsStreamed} pkts streamed`;

  // Throttle server telemetry upload to ~5-10Hz (150ms) to conserve mobile bandwidth
  const now = Date.now();
  if (!state.lastFrameSendTime || (now - state.lastFrameSendTime) >= 150) {
    state.lastFrameSendTime = now;
    streamTelemetryPacketToServer(frame);
  }

  // Update HUD
  const impactDev = Math.abs(zG - 1.0);
  document.getElementById('hud-impact-g').innerText = `${impactDev.toFixed(2)}g`;
}

async function streamTelemetryPacketToServer(frame) {
  if (!state.tripActive || !state.tripId) return;
  try {
    const res = await fetch('/api/trip/frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trip_id: state.tripId,
        timestamp: frame.timestamp,
        latitude: frame.gps.latitude,
        longitude: frame.gps.longitude,
        altitude_m: frame.gps.altitude_m,
        accel_x: frame.accelerometer.x,
        accel_y: frame.accelerometer.y,
        accel_z: frame.accelerometer.z,
        gyro_x: frame.gyroscope ? frame.gyroscope.x : 0,
        gyro_y: frame.gyroscope ? frame.gyroscope.y : 0,
        gyro_z: frame.gyroscope ? frame.gyroscope.z : 0,
        speed_kmh: frame.speed_kmh,
        decibel_level: frame.acoustic ? frame.acoustic.decibel_level : 0,
        dominant_frequency_hz: frame.acoustic ? frame.acoustic.dominant_frequency_hz : 0
      })
    });
    const data = await res.json();
    if (data.detected && data.anomaly) {
      onServerDetectedAnomaly(data.anomaly, data.is_new);
    }
  } catch (err) {
    // Resilient to intermittent connectivity
  }
}

function onServerDetectedAnomaly(anomaly, isNew) {
  if (state.detectedAnomalies.some(a => a.anomaly_id === anomaly.anomaly_id)) return;

  state.anomalyHits++;
  state.detectedAnomalies.push(anomaly);
  document.getElementById('hud-anomaly-count').innerText = state.anomalyHits;

  // Deduct from Road Quality Score
  const penalties = { critical: 15, high: 8, moderate: 4, low: 2 };
  state.roadQualityScore = Math.max(10, state.roadQualityScore - (penalties[anomaly.severity] || 4));
  const scoreElem = document.getElementById('hud-road-score');
  if (scoreElem) {
    scoreElem.innerText = state.roadQualityScore;
    if (state.roadQualityScore >= 80) scoreElem.className = 'metric-cell-val quality-optimum';
    else if (state.roadQualityScore >= 50) scoreElem.className = 'metric-cell-val quality-degraded';
    else scoreElem.className = 'metric-cell-val quality-critical';
  }

  // Play alert and vibrate
  playAlertSound();
  if (navigator.vibrate) navigator.vibrate([250, 100, 250]);
}

function handleLocalAnomalyHit(anomaly) {
  onServerDetectedAnomaly(anomaly, true);
}

// ── Great-Circle Forward Bearing (Vehicle Orientation) ───────────────────────

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

// ── Virtual Driving Simulator (Anywhere on Earth) ────────────────────────────

function startDrivingSimulator() {
  if (!state.routeWaypoints || state.routeWaypoints.length < 2) {
    alert('Please wait for the route to load before starting the simulator.');
    stopTrip();
    return;
  }

  state.simIndex = 0;
  state.currentSpeed = state.simSpeedKmh;
  document.getElementById('hud-speed').innerText = state.currentSpeed;

  const totalPoints = state.routeWaypoints.length;
  // Step every 200ms
  state.simTimer = setInterval(() => {
    if (state.simIndex >= totalPoints) {
      // Reached destination!
      stopTrip();
      return;
    }

    const currentPt = state.routeWaypoints[state.simIndex];
    const [lat, lon] = currentPt;

    // Calculate dynamic road bearing towards next waypoint
    let heading = state.lastHeading || 0;
    if (state.simIndex < totalPoints - 1) {
      const nextPt = state.routeWaypoints[state.simIndex + 1];
      heading = calculateBearing(lat, lon, nextPt[0], nextPt[1]);
      state.lastHeading = heading;
    }

    // Move vehicle
    lastGpsData.lat = lat;
    lastGpsData.lon = lon;
    lastGpsData.speed = state.simSpeedKmh;
    lastGpsData.heading = heading;
    updateVehicleMarker(lat, lon, heading);

    // Broadcast driver location to universal map
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'DRIVER_LOCATION',
        name: 'Simulated Vehicle',
        latitude: lat,
        longitude: lon,
        speed_kmh: state.simSpeedKmh,
        heading: Math.round(heading)
      }));
    }

    // Synthesize accelerometer signal: baseline road vibration + random road anomalies
    let zG = 1.0 + (Math.random() - 0.5) * 0.08;
    const isAnomaly = Math.random() < 0.04; // 4% chance of anomaly per step

    if (isAnomaly) {
      const severityRoll = Math.random();
      if (severityRoll > 0.8) zG = 1.8 + Math.random() * 0.8; // Critical pothole
      else if (severityRoll > 0.5) zG = 1.45 + Math.random() * 0.2; // Speed bump
      else zG = 1.25 + Math.random() * 0.15; // Crack
    }

    lastMotionData.z = zG;
    updateOscilloscope(zG);
    dispatchSensorFrame(0.01, 0.01, zG);

    state.simIndex++;
  }, 200);
}

function stopDrivingSimulator() {
  if (state.simTimer) {
    clearInterval(state.simTimer);
    state.simTimer = null;
  }
}

// ── Vehicle Map Marker ───────────────────────────────────────────────────────

function updateVehicleMarker(lat, lon, heading) {
  const normHeading = Math.round(heading || 0);
  if (!driverMarker) {
    const icon = L.divIcon({
      html: `<div class="nav-vehicle-pointer" style="transform: rotate(${normHeading}deg);">
        <svg class="nav-vehicle-svg" viewBox="0 0 24 24" width="28" height="28" style="display:block; overflow:visible;">
          <polygon points="12,2 22,20 12,16 2,20" fill="#06b6d4" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
        </svg>
      </div>`,
      className: '',
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });
    driverMarker = L.marker([lat, lon], { icon }).addTo(map);
  } else {
    driverMarker.setLatLng([lat, lon]);
    const el = driverMarker.getElement();
    if (el) {
      const ptr = el.querySelector('.nav-vehicle-pointer');
      if (ptr) ptr.style.transform = `rotate(${normHeading}deg)`;
    }
  }

  // Smoothly center map on vehicle during active trip
  map.panTo([lat, lon], { animate: true, duration: 0.5 });
}

// ── Screen Wake Lock (Background Persistence) ────────────────────────────────

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => {
        console.log('Screen WakeLock was released');
      });
      console.log('💡 Screen WakeLock acquired (keeps phone active)');
    }
  } catch (err) {
    console.warn('Wake Lock error:', err);
  }
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}

// Re-acquire wake lock if user switches back to app
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.tripActive) {
    acquireWakeLock();
  }
});

// Auto-finalize trip on window unload/exit to prevent data loss
window.addEventListener('beforeunload', () => {
  if (state.tripActive && navigator.sendBeacon) {
    const payload = JSON.stringify({
      trip_id: state.tripId,
      user_id: state.clientId,
      detected_anomalies: state.detectedAnomalies,
      distance_km: state.routeDistanceKm
    });
    navigator.sendBeacon('/api/trip/end', payload);
  }
});

// ── Real-Time Vibration Oscilloscope ─────────────────────────────────────────

function initOscilloscope() {
  state.oscillatorCanvas = document.getElementById('vibrationCanvas');
  if (state.oscillatorCanvas) {
    state.oscillatorCtx = state.oscillatorCanvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    drawOscilloscope();
  }
}

function resizeCanvas() {
  if (!state.oscillatorCanvas) return;
  state.oscillatorCanvas.width = state.oscillatorCanvas.clientWidth;
  state.oscillatorCanvas.height = state.oscillatorCanvas.clientHeight;
}

function updateOscilloscope(zG) {
  state.vibrationHistory.push(zG);
  if (state.vibrationHistory.length > 100) {
    state.vibrationHistory.shift();
  }
}

function drawOscilloscope() {
  requestAnimationFrame(drawOscilloscope);
  if (!state.oscillatorCtx || !state.oscillatorCanvas) return;

  const ctx = state.oscillatorCtx;
  const w = state.oscillatorCanvas.width;
  const h = state.oscillatorCanvas.height;

  ctx.clearRect(0, 0, w, h);

  // Subtle cybernetic grid lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  const gridStep = 16;
  for (let x = 0; x < w; x += gridStep) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += gridStep) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Baseline 1.0g center line
  const midY = h / 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(w, midY);
  ctx.stroke();
  ctx.setLineDash([]);

  // High-precision laser glow waveform
  ctx.strokeStyle = '#06b6d4';
  ctx.lineWidth = 1.8;
  ctx.shadowBlur = 6;
  ctx.shadowColor = '#06b6d4';
  ctx.beginPath();

  const step = w / (state.vibrationHistory.length - 1);
  for (let i = 0; i < state.vibrationHistory.length; i++) {
    const val = state.vibrationHistory[i];
    const y = midY - (val - 1.0) * (h / 1.6);
    if (i === 0) ctx.moveTo(0, y);
    else ctx.lineTo(i * step, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0; // Reset
}

// ── Sound Synthesizer for Detection Alerts ───────────────────────────────────

function playAlertSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!alertAudioCtx) alertAudioCtx = new AudioCtx();

    const osc = alertAudioCtx.createOscillator();
    const gain = alertAudioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, alertAudioCtx.currentTime); // A5 note
    osc.frequency.exponentialRampToValueAtTime(440, alertAudioCtx.currentTime + 0.18);

    gain.gain.setValueAtTime(0.2, alertAudioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, alertAudioCtx.currentTime + 0.18);

    osc.connect(gain);
    gain.connect(alertAudioCtx.destination);

    osc.start();
    osc.stop(alertAudioCtx.currentTime + 0.2);
  } catch (e) {}
}

// ── UI Event Listeners ───────────────────────────────────────────────────────

function initUIEventListeners() {
  // Collapse / Expand Route Card
  document.getElementById('toggle-card-btn').addEventListener('click', () => {
    const card = document.getElementById('route-card');
    card.classList.toggle('collapsed');
    const chev = document.getElementById('toggle-chevron');
    if (chev) {
      chev.setAttribute('data-lucide', card.classList.contains('collapsed') ? 'chevron-down' : 'chevron-up');
      if (window.lucide) window.lucide.createIcons();
    }
  });

  // Start Trip Button
  document.getElementById('btn-start-trip').addEventListener('click', startTrip);

  // Stop Trip Button
  document.getElementById('btn-stop-trip').addEventListener('click', stopTrip);

  // Quick Report Pothole Button (for mobile passengers/drivers)
  document.getElementById('btn-quick-report').addEventListener('click', () => {
    const lat = lastGpsData.lat || (state.startCoord ? state.startCoord[0] : 0);
    const lon = lastGpsData.lon || (state.startCoord ? state.startCoord[1] : 0);
    if (lat && lon && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'MANUAL_ALERT',
        latitude: lat,
        longitude: lon
      }));
      playAlertSound();
    }
  });

  // Pick on Map buttons
  document.getElementById('btn-pick-start').addEventListener('click', (e) => {
    state.pickMode = 'start';
    document.getElementById('btn-pick-start').classList.add('active');
  });

  document.getElementById('btn-pick-dest').addEventListener('click', (e) => {
    state.pickMode = 'dest';
    document.getElementById('btn-pick-dest').classList.add('active');
  });

  // Use GPS for Start Location
  document.getElementById('btn-gps-start').addEventListener('click', () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          setStartLocation(latitude, longitude, `GPS: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
        },
        (err) => console.warn('GPS error:', err),
        { enableHighAccuracy: true }
      );
    }
  });

  // Swap Route
  document.getElementById('btn-swap-route').addEventListener('click', () => {
    if (state.startCoord && state.endCoord) {
      const s = state.startCoord;
      const sName = document.getElementById('start-input').value;
      const e = state.endCoord;
      const eName = document.getElementById('dest-input').value;
      setStartLocation(e[0], e[1], eName);
      setDestination(s[0], s[1], sName);
    }
  });

  // Mode Radios
  document.getElementById('mode-phone').addEventListener('click', () => {
    state.mode = 'phone';
    document.getElementById('mode-phone').classList.add('active');
    document.getElementById('mode-sim').classList.remove('active');
    document.getElementById('sim-controls').style.display = 'none';
  });

  document.getElementById('mode-sim').addEventListener('click', () => {
    state.mode = 'sim';
    document.getElementById('mode-sim').classList.add('active');
    document.getElementById('mode-phone').classList.remove('active');
    document.getElementById('sim-controls').style.display = 'block';
  });

  document.getElementById('sim-speed-slider').addEventListener('input', (e) => {
    state.simSpeedKmh = parseInt(e.target.value);
    document.getElementById('sim-speed-val').innerText = `${state.simSpeedKmh} km/h`;
  });

  // Preset location chips
  document.querySelectorAll('.chip-item[data-preset], .chip[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const presetKey = btn.getAttribute('data-preset');
      const p = state.presets[presetKey];
      if (p) {
        if (!state.startCoord) {
          setStartLocation(p.coords[0], p.coords[1], p.name);
        } else {
          setDestination(p.coords[0], p.coords[1], p.name);
        }
      }
    });
  });

  // Search auto-complete
  setupSearchInput('start-input', 'start-dropdown', (item) => {
    setStartLocation(item.latitude, item.longitude, item.name);
  });
  setupSearchInput('dest-input', 'dest-dropdown', (item) => {
    setDestination(item.latitude, item.longitude, item.name);
  });

  // Map Controls
  document.getElementById('ctrl-center-btn').addEventListener('click', () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((pos) => {
        map.setView([pos.coords.latitude, pos.coords.longitude], 15);
      });
    }
  });

  document.getElementById('ctrl-refresh-btn').addEventListener('click', () => {
    anomalyMarkersGroup.clearLayers();
    fetchUniversalAnomalies();
  });

  document.getElementById('ctrl-clear-btn').addEventListener('click', () => {
    if (startMarker) map.removeLayer(startMarker);
    if (destMarker) map.removeLayer(destMarker);
    if (routeLineLayer) map.removeLayer(routeLineLayer);
    startMarker = null;
    destMarker = null;
    routeLineLayer = null;
    state.startCoord = null;
    state.endCoord = null;
    document.getElementById('start-input').value = '';
    document.getElementById('dest-input').value = '';
    document.getElementById('route-dist-val').innerText = '-- km';
    document.getElementById('route-time-val').innerText = '-- min';
  });

  // Anomaly Filter Pills
  document.querySelectorAll('.filter-dock-pill[data-filter], .filter-pill[data-filter]').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-dock-pill, .filter-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      const filter = pill.getAttribute('data-filter');
      anomalyMarkersGroup.clearLayers();
      fetch(`/api/anomalies?type=${filter}&limit=500`)
        .then((r) => r.json())
        .then((d) => {
          if (d.anomalies) d.anomalies.forEach((a) => addAnomalyMarkerToMap(a));
        });
    });
  });

  // Close Bottom Sheet
  document.getElementById('close-sheet-btn').addEventListener('click', () => {
    document.getElementById('anomaly-sheet').classList.remove('open');
  });

  // Verify Anomaly
  document.getElementById('btn-verify-anomaly').addEventListener('click', async () => {
    const aid = document.getElementById('anomaly-sheet').currentAnomalyId;
    if (aid) {
      await fetch(`/api/anomalies/${aid}/verify`, { method: 'POST' });
      document.getElementById('anomaly-sheet').classList.remove('open');
    }
  });

  // Resolve Anomaly
  document.getElementById('btn-resolve-anomaly').addEventListener('click', async () => {
    const aid = document.getElementById('anomaly-sheet').currentAnomalyId;
    if (aid) {
      await fetch(`/api/anomalies/${aid}/resolve`, { method: 'POST' });
      document.getElementById('anomaly-sheet').classList.remove('open');
      anomalyMarkersGroup.clearLayers();
      fetchUniversalAnomalies();
    }
  });

  // File Municipal Complaint Button
  const fileCompBtn = document.getElementById('btn-file-complaint');
  if (fileCompBtn) {
    fileCompBtn.addEventListener('click', async () => {
      const aid = document.getElementById('anomaly-sheet').currentAnomalyId;
      if (aid) fileMunicipalComplaint(aid);
    });
  }

  // Open Municipal Complaints Modal
  const compModalBtn = document.getElementById('complaints-modal-btn');
  if (compModalBtn) {
    compModalBtn.addEventListener('click', () => openComplaintsModal('all'));
  }

  // Close Complaints Modal
  const closeCompBtn = document.getElementById('close-complaints-btn');
  if (closeCompBtn) {
    closeCompBtn.addEventListener('click', () => {
      document.getElementById('complaints-modal').classList.remove('open');
    });
  }

  // Complaint Filter Pills
  document.querySelectorAll('.filter-dock-pill[data-complaint-filter]').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-dock-pill[data-complaint-filter]').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      const filter = pill.getAttribute('data-complaint-filter');
      openComplaintsModal(filter);
    });
  });

  // QR Code Modal
  document.getElementById('qr-modal-btn').addEventListener('click', () => {
    document.getElementById('qr-modal').classList.add('open');
    if (window.lucide) window.lucide.createIcons();
  });
  document.getElementById('close-qr-btn').addEventListener('click', () => {
    document.getElementById('qr-modal').classList.remove('open');
  });
  document.getElementById('btn-copy-url').addEventListener('click', () => {
    const url = document.getElementById('mobile-url-input').value;
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('btn-copy-url');
      btn.innerText = 'Copied!';
      setTimeout(() => btn.innerText = 'Copy', 2000);
    });
  });

  // PC Civic Auth Modal
  const pcAuthBtn = document.getElementById('auth-pc-btn');
  if (pcAuthBtn) {
    pcAuthBtn.addEventListener('click', () => {
      document.getElementById('pc-auth-modal').classList.add('open');
      if (window.lucide) window.lucide.createIcons();
    });
  }

  const closePcAuth = document.getElementById('close-pc-auth-btn');
  if (closePcAuth) {
    closePcAuth.addEventListener('click', () => {
      document.getElementById('pc-auth-modal').classList.remove('open');
    });
  }

  const pcAuthForm = document.getElementById('pc-auth-form');
  if (pcAuthForm) {
    pcAuthForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('pc-auth-err');
      errEl.style.display = 'none';
      const u = document.getElementById('pc-auth-user').value.trim();
      const p = document.getElementById('pc-auth-pass').value;

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username_or_email: u, password: p })
        });
        const data = await res.json();
        if (res.ok && data.token) {
          localStorage.setItem('nanonavs_pc_token', data.token);
          alert(`Authenticated as ${data.user.full_name} (${data.user.role.toUpperCase()})`);
          document.getElementById('pc-auth-modal').classList.remove('open');
        } else {
          errEl.innerText = data.detail || 'Login failed';
          errEl.style.display = 'block';
        }
      } catch (err) {
        errEl.innerText = 'Network error contacting server.';
        errEl.style.display = 'block';
      }
    });
  }

  // Report Modal
  document.getElementById('close-report-btn').addEventListener('click', () => {
    document.getElementById('report-modal').classList.remove('open');
  });
  document.getElementById('btn-close-modal').addEventListener('click', () => {
    document.getElementById('report-modal').classList.remove('open');
  });
}

function setupSearchInput(inputId, dropdownId, onSelect) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  let debounceTimer = null;

  input.addEventListener('input', () => {
    const val = input.value.trim();
    clearTimeout(debounceTimer);
    if (val.length < 2) {
      dropdown.style.display = 'none';
      return;
    }

    debounceTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(val)}`);
        const data = await res.json();
        dropdown.innerHTML = '';
        if (data.results && data.results.length > 0) {
          data.results.forEach((item) => {
            const div = document.createElement('div');
            div.className = 'search-item';
            div.innerText = item.display_name || item.name;
            div.addEventListener('click', () => {
              input.value = item.name;
              dropdown.style.display = 'none';
              onSelect(item);
            });
            dropdown.appendChild(div);
          });
          dropdown.style.display = 'block';
        } else {
          dropdown.style.display = 'none';
        }
      } catch (e) {
        dropdown.style.display = 'none';
      }
    }, 350);
  });

  // Hide dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  });
}

// ── Modals & Server Config ───────────────────────────────────────────────────

async function fetchServerConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    const mobileUrl = data.mobile_url;
    document.getElementById('mobile-url-input').value = mobileUrl;
    document.getElementById('qr-img').src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(mobileUrl)}`;
  } catch (e) {
    console.warn('Config fetch error:', e);
  }
}

function openTripReportModal(data) {
  const modal = document.getElementById('report-modal');
  const rep = data.report || {};

  document.getElementById('report-score-val').innerText = Math.round(rep.road_quality_score || state.roadQualityScore);
  document.getElementById('report-dist-val').innerText = `${(rep.total_distance_km || state.routeDistanceKm || 0).toFixed(1)} km`;
  document.getElementById('report-anomaly-val').innerText = rep.anomaly_count || state.anomalyHits;

  const durationMin = Math.round((rep.total_frames_analysed ? rep.total_frames_analysed * 0.1 : 60) / 60);
  document.getElementById('report-duration-val').innerText = `${durationMin || 1} min`;

  document.getElementById('report-summary-text').innerText = rep.summary || 'Trip completed cleanly.';

  const aiSection = document.getElementById('ai-narrative-section');
  if (rep.ai_narrative) {
    document.getElementById('report-ai-text').innerText = rep.ai_narrative;
    aiSection.style.display = 'block';
  } else {
    aiSection.style.display = 'none';
  }

  document.getElementById('btn-download-json').onclick = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `NanoNavs_Report_${Date.now()}.json`;
    a.click();
  };

  modal.classList.add('open');
  if (window.lucide) window.lucide.createIcons();
}

// ── Service Worker Registration ─────────────────────────────────────────────

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.log('ServiceWorker registration skipped:', err);
    });
  }
}

// ── Municipal Civic Complaints & Work Orders (Central Server) ────────────────

async function fileMunicipalComplaint(anomalyId) {
  if (!anomalyId) return;
  try {
    const res = await fetch('/api/complaints/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anomaly_id: anomalyId })
    });
    const data = await res.json();
    if (data.status === 'created' || data.complaint || data.ticket_number) {
      const c = data.complaint || data;
      alert(`Civic Work Order Generated:\n${c.ticket_number}\nAssigned: ${c.department}\nPriority: ${(c.priority || 'HIGH').toUpperCase()}`);
      document.getElementById('anomaly-sheet').classList.remove('open');
      openComplaintsModal('all');
    }
  } catch (e) {
    console.error('Complaint generation error:', e);
  }
}

async function openComplaintsModal(statusFilter = 'all') {
  const modal = document.getElementById('complaints-modal');
  modal.classList.add('open');
  const container = document.getElementById('tickets-container');
  container.innerHTML = '<div style="text-align:center; color: var(--foreground-dim); padding: 30px;">Loading civic work orders...</div>';

  try {
    const res = await fetch(`/api/complaints?status=${statusFilter}&limit=100`);
    const data = await res.json();
    const complaints = data.complaints || [];

    if (complaints.length === 0) {
      container.innerHTML = '<div style="text-align:center; color: var(--foreground-dim); padding: 40px;">No civic work orders filed yet. Select an anomaly on the map to file a municipal ticket.</div>';
      return;
    }

    container.innerHTML = complaints.map(c => `
      <div class="ticket-card" id="ticket-${c.complaint_id}">
        <div class="ticket-header">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="ticket-num">${c.ticket_number}</span>
            <span class="ticket-badge badge-${c.status.toLowerCase().replace(' ', '_')}">${c.status}</span>
          </div>
          <span style="font-size: 0.75rem; color: var(--foreground-dim); font-family: var(--font-mono);">${c.priority.toUpperCase()}</span>
        </div>
        <div class="ticket-details">
          <span style="font-weight: 500; color: var(--foreground);">${c.defect_type.replace('_', ' ').toUpperCase()}</span>
          <span>•</span>
          <span>${c.address || 'Bengaluru Roadway'}</span>
        </div>
        <div style="font-size: 0.75rem; color: var(--foreground-muted); line-height: 1.4;">${c.description}</div>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 4px;">
          <span class="ticket-meta">${c.department}</span>
          <div style="display: flex; gap: 6px;">
            ${c.status !== 'Resolved' ? `
              <button class="btn-ghost-icon" style="padding: 4px 8px; font-size: 0.72rem; border: 1px solid var(--border); border-radius: 4px;" onclick="updateTicketStatus('${c.complaint_id}', 'Resolved')">
                Mark Fixed
              </button>
            ` : ''}
          </div>
        </div>
      </div>
    `).join('');
    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    container.innerHTML = '<div style="color: var(--status-rose); text-align: center; padding: 20px;">Failed to load complaints.</div>';
  }
}

window.updateTicketStatus = async function(complaintId, newStatus) {
  try {
    await fetch(`/api/complaints/${complaintId}?status=${encodeURIComponent(newStatus)}`, { method: 'PATCH' });
    openComplaintsModal('all');
  } catch (e) {
    console.error(e);
  }
};

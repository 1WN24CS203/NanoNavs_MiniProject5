/**
 * NanoNavs Civic Command Center & Municipal Road Data Manager
 * 
 * Strict Civic Data Management Workstation:
 * - Pure observation, management, verification, and municipal triage
 * - Zero driving simulation or client data generation on PC
 * - Strict Officer Authentication Gate (Authenticate before entering)
 * - Live Fleet Radar for crowdsourced citizen driver telemetry
 * - Review 2 Slide 13 Mathematical Verification & Audit Suite
 * - BBMP Civic Work Order Management & Export (CSV / GeoJSON)
 */

// ── Application State ────────────────────────────────────────────────────────

const civicState = {
  officerToken: localStorage.getItem('nanonavs_officer_token') || null,
  officerUser: null,
  
  // Leaflet map & layers
  map: null,
  anomalyMarkersGroup: null,
  peerDriversGroup: null,
  peerMarkers: {},
  
  // Data caches
  anomalies: [],
  filteredAnomalies: [],
  activeFilter: 'all',
  searchQuery: '',
  drivers: [],
  complaints: [],
  stats: {},
  
  // WebSocket & Polling
  ws: null,
  wsConnected: false,
  pollTimer: null,
  
  // Active selected anomaly
  selectedAnomalyId: null
};

// ── Application Entry Point ──────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initOfficerAuth();
});

// ── 1. Officer Authentication Gate (Strict Gatekeeping) ──────────────────────

async function initOfficerAuth() {
  const gateEl = document.getElementById('officer-auth-gate');
  const rootEl = document.getElementById('root');

  // Verify existing token
  if (civicState.officerToken) {
    try {
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${civicState.officerToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.user && data.user.role === 'admin') {
          setOfficerSession(data.user);
          return;
        }
      }
    } catch (e) {
      console.warn('Session verification fallback:', e);
    }
  }

  // Not logged in: show gate, hide dashboard
  gateEl.style.display = 'flex';
  rootEl.style.display = 'none';
  setupGateEventListeners();
}

function setOfficerSession(user) {
  civicState.officerUser = user;
  document.getElementById('officer-display-name').innerText = `Officer: ${user.full_name || user.username} (BBMP Road Safety)`;
  
  // Reveal dashboard
  document.getElementById('officer-auth-gate').style.display = 'none';
  document.getElementById('root').style.display = 'block';

  // Initialize Map & Data Workstation
  initCivicMap();
  initWebSocket();
  initDockControls();
  fetchMunicipalStats();
  fetchUniversalDefects();
  fetchActiveFleetDrivers();
  fetchCivicWorkOrders();
  
  if (window.lucide) window.lucide.createIcons();
}

function setupGateEventListeners() {
  let isSignup = false;
  const loginTab = document.getElementById('gate-login-tab');
  const signupTab = document.getElementById('gate-signup-tab');
  const nameWrap = document.getElementById('gate-name-wrap');
  const submitBtn = document.getElementById('btn-gate-submit');
  const errBox = document.getElementById('gate-error');

  loginTab.addEventListener('click', (e) => {
    e.preventDefault();
    isSignup = false;
    loginTab.classList.add('active');
    signupTab.classList.remove('active');
    nameWrap.style.display = 'none';
    submitBtn.innerText = 'Authenticate & Enter Command Center';
  });

  signupTab.addEventListener('click', (e) => {
    e.preventDefault();
    isSignup = true;
    signupTab.classList.add('active');
    loginTab.classList.remove('active');
    nameWrap.style.display = 'block';
    submitBtn.innerText = 'Register Civic Officer';
  });

  // Demo Officer Fill
  document.getElementById('btn-demo-officer').addEventListener('click', () => {
    document.getElementById('gate-identity').value = 'admin';
    document.getElementById('gate-password').value = 'admin123';
    document.getElementById('officer-auth-form').dispatchEvent(new Event('submit'));
  });

  // Form submit
  document.getElementById('officer-auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.style.display = 'none';

    const identity = document.getElementById('gate-identity').value.trim();
    const password = document.getElementById('gate-password').value;

    try {
      if (isSignup) {
        const fullName = document.getElementById('gate-fullname').value.trim();
        const res = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: identity,
            email: `${identity}@bbmp.gov.in`,
            password: password,
            full_name: fullName || 'Municipal Road Inspector',
            role: 'admin'
          })
        });
        const data = await res.json();
        if (res.ok && data.token) {
          localStorage.setItem('nanonavs_officer_token', data.token);
          civicState.officerToken = data.token;
          setOfficerSession(data.user);
        } else {
          errBox.innerText = data.detail || 'Officer registration failed.';
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
          localStorage.setItem('nanonavs_officer_token', data.token);
          civicState.officerToken = data.token;
          setOfficerSession(data.user);
        } else {
          errBox.innerText = data.detail || 'Invalid officer credentials. Check username/password.';
          errBox.style.display = 'block';
        }
      }
    } catch (err) {
      errBox.innerText = 'Network error communicating with central server.';
      errBox.style.display = 'block';
    }
  });

  // Sign out in navbar
  document.getElementById('btn-officer-logout').addEventListener('click', () => {
    localStorage.removeItem('nanonavs_officer_token');
    civicState.officerToken = null;
    civicState.officerUser = null;
    window.location.reload();
  });
}

// ── 2. Leaflet Universal Map Setup (ArcGIS Dark Gray Canvas) ─────────────────

function initCivicMap() {
  if (civicState.map) return;

  civicState.map = L.map('map', {
    zoomControl: false,
    attributionControl: false
  }).setView([12.9716, 77.5946], 13);

  // 100% Free ArcGIS Dark Gray Canvas (Base + Labels) - No API Key Required
  const esriDarkBase = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19
  });
  const esriDarkLabels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19
  });

  esriDarkBase.addTo(civicState.map);
  esriDarkLabels.addTo(civicState.map);

  civicState.anomalyMarkersGroup = L.layerGroup().addTo(civicState.map);
  civicState.peerDriversGroup = L.layerGroup().addTo(civicState.map);
}

// ── 3. Municipal Data Manager & KPIs ─────────────────────────────────────────

async function fetchMunicipalStats() {
  try {
    const res = await fetch('/api/stats');
    const d = await res.json();
    civicState.stats = d;

    document.getElementById('kpi-km').innerText = `${(d.total_distance_km || 0).toFixed(1)} km`;
    document.getElementById('kpi-defects').innerText = d.total_anomalies || 0;
    
    // Calibrated Pavement Condition Index
    const pci = d.avg_road_quality ? Math.round(d.avg_road_quality) : 78;
    document.getElementById('kpi-pci').innerText = `${pci} / 100`;

    document.getElementById('kpi-orders').innerText = d.open_complaints_count || 0;
  } catch (err) {
    console.warn('Municipal stats error:', err);
  }
}

async function fetchUniversalDefects() {
  try {
    const res = await fetch('/api/anomalies?limit=500');
    const data = await res.json();
    civicState.anomalies = data.anomalies || [];
    filterAndRenderDefects();
    renderDefectsOnMap();
  } catch (err) {
    console.warn('Defects fetch error:', err);
  }
}

function filterAndRenderDefects() {
  const q = civicState.searchQuery.toLowerCase();
  const f = civicState.activeFilter;

  civicState.filteredAnomalies = civicState.anomalies.filter((a) => {
    // Type filter
    if (f !== 'all' && a.anomaly_type !== f) return false;
    // Search query filter
    if (q) {
      const matchId = (a.anomaly_id || '').toLowerCase().includes(q);
      const matchAddr = (a.address || '').toLowerCase().includes(q);
      const matchCoords = `${a.latitude},${a.longitude}`.includes(q);
      return matchId || matchAddr || matchCoords;
    }
    return true;
  });

  renderDockDefectList();
}

function renderDockDefectList() {
  const container = document.getElementById('dock-defect-list');
  const list = civicState.filteredAnomalies;

  if (list.length === 0) {
    container.innerHTML = '<div class="loading-state">No matching verified defects found.</div>';
    return;
  }

  container.innerHTML = list.map((a) => {
    const typeLabel = (a.anomaly_type || 'pothole').replace('_', ' ').toUpperCase();
    const sev = a.severity || 'moderate';
    const passes = a.verified_count || 1;
    const conf = Math.round((a.confidence || 0.8) * 100);
    const avgG = (a.peak_vertical_g || 1.6).toFixed(2);
    const avgSpeed = Math.round(a.vehicle_speed_kmh || 40);
    const address = a.address || `${a.latitude.toFixed(5)}, ${a.longitude.toFixed(5)}`;

    return `
      <div class="dock-defect-item ${civicState.selectedAnomalyId === a.anomaly_id ? 'selected' : ''}" onclick="selectDefectFromDock('${a.anomaly_id}')">
        <div class="dock-defect-top">
          <span class="severity-badge ${sev}">${sev.toUpperCase()}</span>
          <span class="dock-defect-type">${typeLabel}</span>
          <span class="dock-passes-badge">${passes} PASSES</span>
        </div>
        
        <div class="dock-defect-addr">${address}</div>

        <div class="dock-defect-meta">
          <span>Avg: <strong>${avgG}g</strong></span>
          <span>Speed: <strong>${avgSpeed} km/h</strong></span>
          <span style="color:var(--accent-cyan); font-weight:600;">C: ${conf}%</span>
        </div>
      </div>
    `;
  }).join('');
}

window.selectDefectFromDock = function(anomalyId) {
  civicState.selectedAnomalyId = anomalyId;
  renderDockDefectList();

  const anom = civicState.anomalies.find((a) => a.anomaly_id === anomalyId);
  if (anom && civicState.map) {
    civicState.map.setView([anom.latitude, anom.longitude], 16, { animate: true });
    openAnomalySheet(anom);
  }
};

function renderDefectsOnMap() {
  if (!civicState.anomalyMarkersGroup) return;
  civicState.anomalyMarkersGroup.clearLayers();

  const typeSVGs = {
    pothole: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    speed_bump: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M2 18c3-6 5-6 8 0s5 6 8 0 4-4 4-4"/></svg>',
    crack: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    surface_depression: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="m16 12-4-4-4 4"/></svg>'
  };

  civicState.anomalies.forEach((a) => {
    if (!a.latitude || !a.longitude) return;

    const iconSvg = typeSVGs[a.anomaly_type] || typeSVGs.pothole;
    const sevClass = a.severity ? `severity-${a.severity}` : 'severity-moderate';

    const customHtml = `
      <div class="vector-pin ${sevClass}">
        ${iconSvg}
      </div>
    `;

    const markerIcon = L.divIcon({
      html: customHtml,
      className: '',
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });

    const marker = L.marker([a.latitude, a.longitude], { icon: markerIcon });
    marker.anomalyData = a;
    marker.on('click', () => {
      selectDefectFromDock(a.anomaly_id);
    });
    marker.addTo(civicState.anomalyMarkersGroup);
  });
}

function openAnomalySheet(anomaly) {
  const sheet = document.getElementById('anomaly-sheet');
  const typeSVGs = {
    pothole: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    speed_bump: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M2 18c3-6 5-6 8 0s5 6 8 0 4-4 4-4"/></svg>',
    crack: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    surface_depression: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="m16 12-4-4-4 4"/></svg>'
  };

  document.getElementById('sheet-type-icon').innerHTML = typeSVGs[anomaly.anomaly_type] || typeSVGs.pothole;
  document.getElementById('sheet-type-text').innerText = `${anomaly.anomaly_type.replace('_', ' ').toUpperCase()} DEFECT`;
  document.getElementById('sheet-address').innerText = anomaly.address || `${anomaly.latitude.toFixed(5)}, ${anomaly.longitude.toFixed(5)}`;
  
  // Statistical running averages & Slide 13 metrics
  document.getElementById('sheet-peak-g').innerText = `${(anomaly.peak_vertical_g || 1.6).toFixed(2)} g (Avg)`;
  document.getElementById('sheet-speed').innerText = `${Math.round(anomaly.vehicle_speed_kmh || 40)} km/h (Avg)`;
  document.getElementById('sheet-conf').innerText = `${Math.round((anomaly.confidence || 0.8) * 100)}%`;
  document.getElementById('sheet-verified').innerText = `${anomaly.verified_count || 1} passes`;

  sheet.currentAnomalyId = anomaly.anomaly_id;
  sheet.classList.add('open');
  if (window.lucide) window.lucide.createIcons();
}

// ── 4. Active Fleet Radar ────────────────────────────────────────────────────

async function fetchActiveFleetDrivers() {
  try {
    const res = await fetch('/api/drivers');
    const data = await res.json();
    civicState.drivers = data.drivers || [];
    
    document.getElementById('active-drivers-badge').innerText = `${civicState.drivers.length} Fleet Units Online`;
    document.getElementById('fleet-count-tab').innerText = civicState.drivers.length;

    renderFleetRadarList();
    renderFleetMarkersOnMap();
  } catch (e) {
    console.warn('Fleet radar error:', e);
  }
}

function renderFleetRadarList() {
  const container = document.getElementById('dock-fleet-list');
  const drivers = civicState.drivers;

  if (drivers.length === 0) {
    container.innerHTML = '<div class="loading-state">No driver sensor rigs currently streaming. Open the Driver App (/mobile) on a phone to stream live telemetry!</div>';
    return;
  }

  container.innerHTML = drivers.map((d) => `
    <div class="dock-fleet-item">
      <div style="display:flex; align-items:center; justify-content:space-between;">
        <span style="font-weight:600; color:#fff; font-size:0.8rem;">${d.name || d.user_id}</span>
        <span class="role-badge" style="background:rgba(16,185,129,0.15); color:#34d399;">STREAMING</span>
      </div>
      <div style="font-size:0.72rem; color:var(--foreground-muted); margin-top:4px;">
        Speed: <strong>${Math.round(d.speed_kmh || 0)} km/h</strong> • Heading: ${Math.round(d.heading || 0)}°
      </div>
      <div style="font-size:0.68rem; font-family:var(--font-mono); color:var(--foreground-dim); margin-top:2px;">
        GPS: ${d.latitude ? d.latitude.toFixed(5) : '--'}, ${d.longitude ? d.longitude.toFixed(5) : '--'}
      </div>
    </div>
  `).join('');
}

function renderFleetMarkersOnMap() {
  if (!civicState.peerDriversGroup) return;

  civicState.drivers.forEach((driver) => {
    const { user_id, latitude, longitude, speed_kmh, heading, name } = driver;
    if (!latitude || !longitude) return;
    const normHeading = Math.round(heading || 0);

    if (!civicState.peerMarkers[user_id]) {
      const icon = L.divIcon({
        html: `<div class="nav-vehicle-pointer" style="transform: rotate(${normHeading}deg);">
          <svg viewBox="0 0 24 24" width="28" height="28">
            <polygon points="12,2 22,20 12,16 2,20" fill="#06b6d4" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
          </svg>
        </div>`,
        className: '',
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });
      const marker = L.marker([latitude, longitude], { icon }).addTo(civicState.peerDriversGroup);
      marker.bindPopup(`<strong>${name}</strong><br>Speed: ${Math.round(speed_kmh)} km/h`);
      civicState.peerMarkers[user_id] = marker;
    } else {
      civicState.peerMarkers[user_id].setLatLng([latitude, longitude]);
      const el = civicState.peerMarkers[user_id].getElement();
      if (el) {
        const ptr = el.querySelector('.nav-vehicle-pointer');
        if (ptr) ptr.style.transform = `rotate(${normHeading}deg)`;
      }
    }
  });
}

// ── 5. Review 2 Slide 13 Verification Audit Suite ───────────────────────────

async function runVerificationAudit() {
  const container = document.getElementById('audit-results-container');
  const summaryText = document.getElementById('audit-summary-text');
  const checksList = document.getElementById('audit-checks-list');

  container.style.display = 'block';
  summaryText.innerText = 'RUNNING MATHEMATICAL AUDIT...';
  checksList.innerHTML = '<div class="loading-state">Testing Slide 13 Hard Gates, Multi-Pass Centroids, and ASTM Scoring...</div>';

  try {
    const res = await fetch('/api/admin/run-tests', { method: 'POST' });
    const data = await res.json();

    if (data.all_passed) {
      summaryText.innerText = 'ALL SYSTEM VERIFICATIONS PASSED (100% OPERATIONAL)';
    } else {
      summaryText.innerText = 'AUDIT WARNING: SOME CHECKS REQUIRE ATTENTION';
    }

    checksList.innerHTML = (data.audit_checks || []).map((c) => `
      <div style="background:var(--card); border:1px solid var(--border); border-radius:6px; padding:8px 10px;">
        <div style="display:flex; align-items:center; justify-content:space-between;">
          <span style="font-size:0.75rem; font-weight:600; color:#fff;">${c.check}</span>
          <span class="role-badge" style="background:${c.status === 'PASSED' ? 'rgba(16,185,129,0.15)' : 'rgba(244,63,94,0.15)'}; color:${c.status === 'PASSED' ? '#34d399' : '#fb7185'}; font-size:0.65rem;">
            ${c.status}
          </span>
        </div>
        <p style="font-size:0.7rem; color:var(--foreground-muted); margin-top:3px;">${c.detail}</p>
      </div>
    `).join('');

    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    summaryText.innerText = 'AUDIT FAILED TO COMMUNICATE WITH SERVER';
    checksList.innerHTML = `<div style="color:var(--status-rose); font-size:0.75rem;">Error: ${err.message}</div>`;
  }
}

// ── 6. BBMP Civic Work Order Tickets ─────────────────────────────────────────

async function fetchCivicWorkOrders() {
  try {
    const res = await fetch('/api/complaints');
    const data = await res.json();
    civicState.complaints = data.complaints || [];
    renderWorkOrdersList('all');
  } catch (err) {
    console.warn('Complaints error:', err);
  }
}

function renderWorkOrdersList(filter) {
  const container = document.getElementById('tickets-container');
  const filtered = civicState.complaints.filter((c) => {
    if (filter === 'all') return true;
    return c.status === filter;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--foreground-dim);">No work orders in this category.</div>';
    return;
  }

  container.innerHTML = filtered.map((c) => `
    <div class="ticket-row" style="background:var(--card); border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-family:var(--font-mono); font-size:0.75rem; color:var(--accent-cyan);">${c.complaint_id}</span>
        <span class="role-badge ${c.status === 'Resolved' ? 'emerald' : (c.status === 'In Progress' ? 'amber' : 'rose')}">${c.status}</span>
      </div>
      <div style="font-size:0.82rem; font-weight:600; color:#fff; margin-top:4px;">${c.title}</div>
      <div style="font-size:0.72rem; color:var(--foreground-muted); margin-top:2px;">Location: ${c.location_address || 'Bengaluru Road'}</div>
      <div style="margin-top:8px; display:flex; gap:6px;">
        <button class="btn-ghost-action" style="font-size:0.7rem; padding:4px 8px;" onclick="updateTicketStatus('${c.complaint_id}', 'In Progress')">Mark Active</button>
        <button class="btn-ghost-action" style="font-size:0.7rem; padding:4px 8px;" onclick="updateTicketStatus('${c.complaint_id}', 'Resolved')">Mark Resolved</button>
      </div>
    </div>
  `).join('');
}

window.updateTicketStatus = async function(ticketId, status) {
  try {
    await fetch(`/api/complaints/${ticketId}?status=${encodeURIComponent(status)}`, { method: 'PATCH' });
    fetchCivicWorkOrders();
  } catch (e) {
    console.warn('Update ticket error:', e);
  }
};

// ── 7. Dock Controls & Event Listeners ───────────────────────────────────────

function initDockControls() {
  // Dock Segmented Tabs
  document.querySelectorAll('.dock-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dock-tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const target = btn.getAttribute('data-dock-tab');
      document.querySelectorAll('.dock-tab-content').forEach((c) => c.classList.remove('active'));
      document.getElementById(`dock-tab-${target}`).classList.add('active');

      if (target === 'fleet') fetchActiveFleetDrivers();
      if (target === 'hazards') filterAndRenderDefects();
    });
  });

  // Search input
  document.getElementById('hazard-search-input').addEventListener('input', (e) => {
    civicState.searchQuery = e.target.value.trim();
    filterAndRenderDefects();
  });

  // Filter Pills
  document.querySelectorAll('.filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      civicState.activeFilter = pill.getAttribute('data-filter');
      filterAndRenderDefects();
    });
  });

  // Dock Collapse / Expand
  const dock = document.getElementById('civic-data-dock');
  const dockChevron = document.getElementById('dock-chevron-icon');
  document.getElementById('btn-toggle-dock').addEventListener('click', () => {
    dock.classList.toggle('collapsed');
    if (dock.classList.contains('collapsed')) {
      dockChevron.setAttribute('data-lucide', 'chevron-right');
    } else {
      dockChevron.setAttribute('data-lucide', 'chevron-left');
    }
    if (window.lucide) window.lucide.createIcons();
    setTimeout(() => civicState.map.invalidateSize(), 200);
  });

  // Map Tools
  document.getElementById('ctrl-center-btn').addEventListener('click', () => {
    if (civicState.map) civicState.map.setView([12.9716, 77.5946], 13);
  });
  document.getElementById('ctrl-refresh-btn').addEventListener('click', () => {
    fetchUniversalDefects();
    fetchActiveFleetDrivers();
    fetchMunicipalStats();
  });

  // Close Anomaly Sheet
  document.getElementById('close-sheet-btn').addEventListener('click', () => {
    document.getElementById('anomaly-sheet').classList.remove('open');
    civicState.selectedAnomalyId = null;
    renderDockDefectList();
  });

  // Dispatch BBMP Work Order from sheet
  document.getElementById('btn-dispatch-bbmp').addEventListener('click', async () => {
    const anomId = document.getElementById('anomaly-sheet').currentAnomalyId;
    if (!anomId) return;
    try {
      const res = await fetch('/api/complaints/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          anomaly_id: anomId,
          department: 'BBMP Municipal Public Works Division'
        })
      });
      if (res.ok) {
        alert('BBMP Work Order generated and dispatched to municipal repair queue!');
        fetchCivicWorkOrders();
        fetchMunicipalStats();
      }
    } catch (e) {
      alert('Failed to dispatch work order.');
    }
  });

  // Mark Verified
  document.getElementById('btn-mark-verified').addEventListener('click', async () => {
    const anomId = document.getElementById('anomaly-sheet').currentAnomalyId;
    if (!anomId) return;
    try {
      await fetch(`/api/anomalies/${anomId}/verify`, { method: 'POST' });
      alert('Anomaly marked verified by Civic Officer.');
      fetchUniversalDefects();
    } catch (e) {}
  });

  // Mark Resolved
  document.getElementById('btn-mark-resolved').addEventListener('click', async () => {
    const anomId = document.getElementById('anomaly-sheet').currentAnomalyId;
    if (!anomId) return;
    try {
      await fetch(`/api/anomalies/${anomId}/resolve`, { method: 'POST' });
      alert('Defect marked repaired & resolved.');
      document.getElementById('anomaly-sheet').classList.remove('open');
      fetchUniversalDefects();
    } catch (e) {}
  });

  // Trigger Audit from Tab & Navbar
  document.getElementById('btn-run-audit').addEventListener('click', () => {
    document.querySelector('.dock-tab-btn[data-dock-tab="audit"]').click();
    runVerificationAudit();
  });
  document.getElementById('btn-trigger-audit-tab').addEventListener('click', runVerificationAudit);

  // Complaints Modal
  const modal = document.getElementById('complaints-modal');
  document.getElementById('complaints-modal-btn').addEventListener('click', () => {
    modal.classList.add('open');
    fetchCivicWorkOrders();
  });
  document.getElementById('close-complaints-btn').addEventListener('click', () => {
    modal.classList.remove('open');
  });

  // Complaint filters
  document.querySelectorAll('.filter-dock-pill[data-complaint-filter]').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-dock-pill[data-complaint-filter]').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      renderWorkOrdersList(pill.getAttribute('data-complaint-filter'));
    });
  });
}

// ── 8. WebSocket & Polling Fallback ──────────────────────────────────────────

function initWebSocket() {
  const loc = window.location;
  const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProto}//${loc.host}/ws?client_id=officer_${Math.random().toString(36).substring(2, 7)}&role=admin`;

  try {
    civicState.ws = new WebSocket(wsUrl);
    
    civicState.ws.onopen = () => {
      civicState.wsConnected = true;
      document.getElementById('connection-badge').className = 'status-pill active';
      document.getElementById('connection-text').innerText = 'Live Engine Sync';
    };

    civicState.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleLiveEvent(msg);
      } catch (err) {}
    };

    civicState.ws.onclose = () => {
      civicState.wsConnected = false;
      document.getElementById('connection-badge').className = 'status-pill';
      document.getElementById('connection-text').innerText = 'HTTP Polling Sync';
      startPollingFallback();
    };

    civicState.ws.onerror = () => {
      civicState.wsConnected = false;
      startPollingFallback();
    };
  } catch (e) {
    startPollingFallback();
  }
}

function handleLiveEvent(msg) {
  if (msg.type === 'ANOMALY_ALERT') {
    fetchUniversalDefects();
    fetchMunicipalStats();
  } else if (msg.type === 'DRIVER_MOVED' || msg.type === 'DRIVER_DISCONNECTED') {
    fetchActiveFleetDrivers();
  } else if (msg.type === 'COMPLAINT_FILED') {
    fetchCivicWorkOrders();
    fetchMunicipalStats();
  }
}

function startPollingFallback() {
  if (civicState.pollTimer) return;
  civicState.pollTimer = setInterval(() => {
    fetchUniversalDefects();
    fetchActiveFleetDrivers();
    fetchMunicipalStats();
  }, 4000);
}
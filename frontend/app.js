/**
 * Kızılay Canlı Trafik Simülasyonu — Frontend Uygulama Mantığı
 * Leaflet.js harita + FastAPI polling + Dashboard güncellemeleri
 */

const API_BASE = 'http://localhost:8000';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const STANDALONE_OVERPASS_QUERY = `
[out:json][timeout:30];
(
  way["highway"]["highway"!~"footway|cycleway|path|steps|pedestrian|construction"]
    (around:1500,39.9211,32.8540);
);
out body;
>;
out skel qt;
`;
const SPEED_LIMITS = {
  motorway: 90,
  motorway_link: 70,
  trunk: 80,
  trunk_link: 60,
  primary: 70,
  primary_link: 50,
  secondary: 50,
  secondary_link: 40,
  tertiary: 40,
  tertiary_link: 30,
  residential: 30,
  living_street: 20,
  unclassified: 30,
  service: 20,
};
const DENSITY_COLORS = {
  free: '#22c55e',
  moderate: '#f97316',
  heavy: '#ef4444',
  jam: '#7f1d1d',
};
const DENSITY_LABELS = {
  free: 'Akıcı',
  moderate: 'Yoğun',
  heavy: 'Çok Yoğun',
  jam: 'Kilit',
};
const SIM_SPEED = 2.0;
const SIM_START_VIRTUAL = new Date(2026, 7, 19, 7, 30, 0);

// Polling aralıkları (ms)
const TRAFFIC_POLL_MS = 5000;
const STATS_POLL_MS   = 1000;
const EXCLUDED_HIGHWAY_TYPES = new Set(['footway', 'cycleway', 'path', 'steps', 'pedestrian', 'construction']);

// Yol tipi → Leaflet polyline kalınlığı
const ROAD_WEIGHT = {
  motorway:    8,
  trunk:       7,
  primary:     6,
  secondary:   5,
  tertiary:    4,
  residential: 3,
  default:     3,
};

// ─────────────────────────────────────────────────────────────
// Harita başlatma
// ─────────────────────────────────────────────────────────────
const map = L.map('map', {
  center: [39.9211, 32.8540],
  zoom: 15,
  zoomControl: true,
  preferCanvas: true,
});

// OpenStreetMap tile (keyless) + dark mode filter in CSS tile pane
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> katkıcıları',
  maxZoom: 19,
}).addTo(map);

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
const polylines = {};        // road_id → Leaflet.Polyline
const roadsMetadata = {};    // road_id → {name, highway, speed_limit}
let roadsCache = [];
let standaloneTraffic = {};
let standaloneMode = window.location.protocol === 'file:';
const simStartRealMs = Date.now();
let lastStandaloneUpdateMs = 0;

// ─────────────────────────────────────────────────────────────
// Yükleme ekranı yardımcıları
// ─────────────────────────────────────────────────────────────
function setLoadingStatus(msg) {
  const el = document.getElementById('loading-status');
  if (el) el.textContent = msg;
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.classList.add('hidden');
}

// ─────────────────────────────────────────────────────────────
// Popup HTML oluşturma
// ─────────────────────────────────────────────────────────────
function buildPopupHTML(roadId, trafficData) {
  const meta    = roadsMetadata[roadId] || {};
  const traffic = trafficData[roadId]   || {};

  const name        = meta.name        || 'Bilinmeyen Yol';
  const highway     = meta.highway     || '—';
  const speedLimit  = meta.speed_limit || '—';
  const curSpeed    = traffic.current_speed != null
    ? traffic.current_speed.toFixed(0) + ' km/h'
    : '—';
  const density     = traffic.density_level || 'free';
  const label       = traffic.label         || 'Akıcı';
  const congestion  = traffic.congestion_percent != null
    ? traffic.congestion_percent.toFixed(0) + '%'
    : '—';

  const highwayLabels = {
    motorway: 'Otoyol', trunk: 'Ekspres', primary: 'Ana Artер',
    secondary: 'İkincil Yol', tertiary: 'Üçüncül Yol',
    residential: 'Konut Sokak', unclassified: 'Sınıflandırılmamış',
  };

  return `
    <div class="popup-container">
      <div class="popup-road-name">🛣 ${name}</div>
      <div class="popup-row">
        <span class="popup-key">Yol Tipi</span>
        <span class="popup-val">${highwayLabels[highway] || highway}</span>
      </div>
      <div class="popup-row">
        <span class="popup-key">Hız Sınırı</span>
        <span class="popup-val">${speedLimit} km/h</span>
      </div>
      <div class="popup-row">
        <span class="popup-key">Anlık Hız</span>
        <span class="popup-val">${curSpeed}</span>
      </div>
      <div class="popup-row">
        <span class="popup-key">Tıkanıklık</span>
        <span class="popup-val">${congestion}</span>
      </div>
      <div class="popup-row">
        <span class="popup-key">Durum</span>
        <span class="popup-status-badge badge-${density}">${label}</span>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// API: Yol verisi çek ve polyline'ları oluştur
// ─────────────────────────────────────────────────────────────
async function loadRoads() {
  setLoadingStatus('Yol geometrisi yükleniyor…');

  const roads = await fetchRoadsData();

  setLoadingStatus(`${roads.length} yol segmenti haritaya çiziliyor…`);

  roads.forEach(road => {
    roadsMetadata[road.id] = {
      name:        road.name,
      highway:     road.highway,
      speed_limit: road.speed_limit,
    };

    const weight = ROAD_WEIGHT[road.highway] || ROAD_WEIGHT.default;

    const poly = L.polyline(road.coordinates, {
      color:   '#6366f1',  // başlangıç rengi (accent)
      weight:  weight,
      opacity: 0.85,
      lineJoin: 'round',
      lineCap:  'round',
    }).addTo(map);

    // Hover efekti
    poly.on('mouseover', function () {
      this.setStyle({ weight: weight + 3, opacity: 1 });
    });
    poly.on('mouseout', function () {
      this.setStyle({ weight: weight, opacity: 0.85 });
    });

    // Click → popup (trafik verisi ile birlikte)
    poly.on('click', async function (e) {
      try {
        const tr = await fetchTrafficData();
        const html = buildPopupHTML(road.id, tr);
        L.popup({ maxWidth: 280 })
          .setLatLng(e.latlng)
          .setContent(html)
          .openOn(map);
      } catch {
        L.popup()
          .setLatLng(e.latlng)
          .setContent(`<b>${road.name}</b>`)
          .openOn(map);
      }
    });

    polylines[road.id] = poly;
  });

  return roads.length;
}

// ─────────────────────────────────────────────────────────────
// API: Trafik verisi
// ─────────────────────────────────────────────────────────────
let cachedTraffic = {};

async function fetchTrafficData() {
  if (standaloneMode) {
    updateStandaloneTraffic(false);
    cachedTraffic = standaloneTraffic;
    return cachedTraffic;
  }

  const resp = await fetch(`${API_BASE}/api/traffic`);
  if (!resp.ok) throw new Error(`/api/traffic HTTP ${resp.status}`);
  const body = await resp.json();
  cachedTraffic = body.data || {};
  return cachedTraffic;
}

function applyTrafficColors(trafficData) {
  Object.entries(trafficData).forEach(([roadId, status]) => {
    const poly = polylines[roadId];
    if (!poly) return;
    poly.setStyle({ color: status.color });
  });
}

// ─────────────────────────────────────────────────────────────
// API: Şehir istatistikleri → Dashboard güncelle
// ─────────────────────────────────────────────────────────────
async function updateStats() {
  try {
    const stats = await fetchStatsData();
    if (!stats) return;
    renderDashboard(stats);
  } catch { /* sessizce geç */ }
}

function renderDashboard(stats) {
  // Saat & tarih
  setText('sim-time', stats.simulated_time);
  setText('sim-date', stats.simulated_date);

  // Genel durum
  setText('overall-value', stats.overall_density);

  // Durum sınıfı (renk değiştirme)
  const statusEl = document.getElementById('overall-status');
  if (statusEl) {
    statusEl.className = 'overall-status';
    const d = stats.overall_density || '';
    if (d.includes('Kilit'))       statusEl.classList.add('jam');
    else if (d.includes('Çok'))    statusEl.classList.add('heavy');
    else if (d.includes('Yoğun'))  statusEl.classList.add('moderate');
    else                            statusEl.classList.add('free');
  }

  // Ortalama hız
  setText('avg-speed', stats.avg_speed);

  // Yol dağılımı çubukları
  const total = stats.total_roads || 1;
  updateBar('free',     stats.free_roads,     total);
  updateBar('moderate', stats.moderate_roads, total);
  updateBar('heavy',    stats.heavy_roads,    total);
  updateBar('jam',      stats.jam_roads,      total);

  // Yol sayısı
  setText('road-count-num', stats.total_roads);
}

function updateBar(key, count, total) {
  const pct = Math.round((count / total) * 100);
  const bar = document.getElementById(`bar-${key}`);
  const cnt = document.getElementById(`cnt-${key}`);
  if (bar) bar.style.width = `${pct}%`;
  if (cnt) cnt.textContent = count;
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '—';
}

function getSimDateTime() {
  const elapsedRealSeconds = (Date.now() - simStartRealMs) / 1000;
  const elapsedVirtualSeconds = elapsedRealSeconds * SIM_SPEED * 60;
  return new Date(SIM_START_VIRTUAL.getTime() + elapsedVirtualSeconds * 1000);
}

function gaussian(x, mu, sigma) {
  return Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
}

function getPeakFactor(simHour) {
  const morningPeak = gaussian(simHour, 8.5, 0.8);
  const eveningPeak = gaussian(simHour, 18.25, 1.0);
  const lunchPeak = gaussian(simHour, 12.5, 0.5) * 0.5;
  const nightFactor = 1.0 - gaussian(simHour, 3.0, 2.0) * 0.3;
  const raw = Math.max(morningPeak, eveningPeak, lunchPeak) * nightFactor;
  return Math.min(Math.max(raw * 0.9, 0.0), 1.0);
}

function determineDensity(speedRatio) {
  if (speedRatio >= 0.75) return 'free';
  if (speedRatio >= 0.45) return 'moderate';
  if (speedRatio >= 0.20) return 'heavy';
  return 'jam';
}

function initializeStandaloneTraffic(roads) {
  standaloneTraffic = {};
  roads.forEach((road) => {
    const speedLimit = road.speed_limit || 50;
    const currentSpeed = speedLimit * (0.6 + Math.random() * 0.35);
    const ratio = currentSpeed / speedLimit;
    const density = determineDensity(ratio);
    standaloneTraffic[road.id] = {
      road_id: road.id,
      density_level: density,
      current_speed: Math.round(currentSpeed * 10) / 10,
      color: DENSITY_COLORS[density],
      congestion_percent: Math.round((1 - ratio) * 1000) / 10,
      label: DENSITY_LABELS[density],
    };
  });
  lastStandaloneUpdateMs = 0;
}

function updateStandaloneTraffic(forceUpdate) {
  const now = Date.now();
  if (!forceUpdate && now - lastStandaloneUpdateMs < TRAFFIC_POLL_MS) return;
  lastStandaloneUpdateMs = now;

  const simDt = getSimDateTime();
  const simHour = simDt.getHours() + simDt.getMinutes() / 60.0;
  const peakFactor = getPeakFactor(simHour);

  roadsCache.forEach((road) => {
    const speedLimit = road.speed_limit || 50;
    const prev = standaloneTraffic[road.id] || {};
    const prevSpeed = prev.current_speed || speedLimit * 0.8;
    const noise = randomGaussian(0, 0.05);
    const targetRatio = Math.max(0.05, 1.0 - peakFactor * 0.85 + noise);

    const smoothing = 0.3;
    const prevRatio = prevSpeed / speedLimit;
    let newRatio = prevRatio * (1 - smoothing) + targetRatio * smoothing;
    newRatio += randomGaussian(0, 0.03);
    newRatio = Math.max(0.05, Math.min(1.05, newRatio));

    const density = determineDensity(newRatio);
    standaloneTraffic[road.id] = {
      road_id: road.id,
      density_level: density,
      current_speed: Math.round(speedLimit * newRatio * 10) / 10,
      color: DENSITY_COLORS[density],
      congestion_percent: Math.round((1 - newRatio) * 1000) / 10,
      label: DENSITY_LABELS[density],
    };
  });
}

function randomGaussian(mu, sigma) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return z * sigma + mu;
}

function getStandaloneStats() {
  const simDt = getSimDateTime();
  const counts = { free: 0, moderate: 0, heavy: 0, jam: 0 };
  let totalSpeed = 0;

  Object.values(standaloneTraffic).forEach((status) => {
    counts[status.density_level] = (counts[status.density_level] || 0) + 1;
    totalSpeed += status.current_speed || 0;
  });

  const total = Math.max(Object.keys(standaloneTraffic).length, 1);
  const avgSpeed = totalSpeed / total;
  let overall = 'Akıcı 🟢';
  if ((counts.jam || 0) / total > 0.3) overall = 'Kilit 🔴';
  else if ((counts.heavy || 0) / total > 0.3) overall = 'Çok Yoğun 🟠';
  else if ((counts.moderate || 0) / total > 0.4) overall = 'Yoğun 🟡';

  const monthsTr = ['', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  return {
    simulated_time: `${String(simDt.getHours()).padStart(2, '0')}:${String(simDt.getMinutes()).padStart(2, '0')}`,
    simulated_date: `${simDt.getDate()} ${monthsTr[simDt.getMonth() + 1]} ${simDt.getFullYear()}`,
    overall_density: overall,
    avg_speed: Math.round(avgSpeed * 10) / 10,
    free_roads: counts.free || 0,
    moderate_roads: counts.moderate || 0,
    heavy_roads: counts.heavy || 0,
    jam_roads: counts.jam || 0,
    total_roads: total,
  };
}

function buildRoadSegments(elements) {
  const nodes = {};
  const ways = [];
  elements.forEach((el) => {
    if (el.type === 'node') {
      nodes[el.id] = { lat: el.lat, lon: el.lon };
    } else if (el.type === 'way') {
      ways.push(el);
    }
  });

  const roads = [];
  const seenIds = new Set();
  ways.forEach((way) => {
    const tags = way.tags || {};
    const highway = tags.highway || 'unclassified';
    if (EXCLUDED_HIGHWAY_TYPES.has(highway)) return;

    const coords = [];
    (way.nodes || []).forEach((nodeId) => {
      const node = nodes[nodeId];
      if (node) coords.push([node.lat, node.lon]);
    });
    if (coords.length < 2) return;

    const roadId = String(way.id);
    if (seenIds.has(roadId)) return;
    seenIds.add(roadId);

    let speed = SPEED_LIMITS[highway] || 30;
    if (tags.maxspeed != null) {
      const parsedSpeed = parseInt(tags.maxspeed, 10);
      if (!Number.isNaN(parsedSpeed)) speed = parsedSpeed;
    }

    roads.push({
      id: roadId,
      name: tags.name || tags['name:tr'] || tags.ref || `${highway.charAt(0).toUpperCase()}${highway.slice(1)} Sokak`,
      highway,
      speed_limit: speed,
      coordinates: coords,
    });
  });

  return roads;
}

async function fetchStandaloneRoads() {
  try {
    const resp = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ data: STANDALONE_OVERPASS_QUERY }).toString(),
    });
    if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);
    const data = await resp.json();
    const roads = buildRoadSegments(data.elements || []);
    if (roads.length > 0) return roads;
  } catch (err) {
    console.warn('Overpass alınamadı, fallback kullanılacak:', err);
  }
  return getFallbackRoads();
}

async function fetchRoadsData() {
  if (!standaloneMode) {
    try {
      const resp = await fetch(`${API_BASE}/api/roads`);
      if (resp.ok) return await resp.json();
      throw new Error(`/api/roads HTTP ${resp.status}`);
    } catch (err) {
      standaloneMode = true;
      setLoadingStatus(`Backend erişilemedi (${err.message}). HTML modu başlatılıyor…`);
    }
  }

  roadsCache = await fetchStandaloneRoads();
  initializeStandaloneTraffic(roadsCache);
  return roadsCache;
}

async function fetchStatsData() {
  if (standaloneMode) {
    updateStandaloneTraffic(false);
    return getStandaloneStats();
  }
  const resp = await fetch(`${API_BASE}/api/stats`);
  if (!resp.ok) return null;
  return resp.json();
}

function getFallbackRoads() {
  return [
    { id: 'f001', name: 'Atatürk Bulvarı', highway: 'primary', speed_limit: 70, coordinates: [[39.9270, 32.8545], [39.9250, 32.8543], [39.9230, 32.8541], [39.9211, 32.8540], [39.9190, 32.8538], [39.9170, 32.8536], [39.9150, 32.8534]] },
    { id: 'f002', name: 'Gazi Mustafa Kemal Bulvarı', highway: 'primary', speed_limit: 70, coordinates: [[39.9211, 32.8540], [39.9210, 32.8510], [39.9209, 32.8480], [39.9208, 32.8450], [39.9207, 32.8420]] },
    { id: 'f003', name: 'Ziya Gökalp Caddesi', highway: 'secondary', speed_limit: 50, coordinates: [[39.9230, 32.8590], [39.9225, 32.8570], [39.9220, 32.8550], [39.9215, 32.8530], [39.9211, 32.8510]] },
    { id: 'f004', name: 'Mithatpaşa Caddesi', highway: 'secondary', speed_limit: 50, coordinates: [[39.9180, 32.8480], [39.9185, 32.8500], [39.9190, 32.8520], [39.9195, 32.8540], [39.9200, 32.8560], [39.9205, 32.8580]] },
    { id: 'f005', name: 'İzmir Caddesi', highway: 'secondary', speed_limit: 50, coordinates: [[39.9211, 32.8540], [39.9215, 32.8560], [39.9218, 32.8580], [39.9220, 32.8600], [39.9222, 32.8620]] },
    { id: 'f006', name: 'Necatibey Caddesi', highway: 'secondary', speed_limit: 50, coordinates: [[39.9240, 32.8480], [39.9238, 32.8500], [39.9235, 32.8520], [39.9232, 32.8540], [39.9230, 32.8560], [39.9228, 32.8580]] },
    { id: 'f007', name: 'Meşrutiyet Caddesi', highway: 'tertiary', speed_limit: 40, coordinates: [[39.9200, 32.8540], [39.9202, 32.8560], [39.9204, 32.8580], [39.9206, 32.8600]] },
    { id: 'f008', name: 'Olgunlar Sokak', highway: 'residential', speed_limit: 30, coordinates: [[39.9195, 32.8545], [39.9197, 32.8555], [39.9199, 32.8565]] },
    { id: 'f009', name: 'Selanik Caddesi', highway: 'secondary', speed_limit: 50, coordinates: [[39.9250, 32.8490], [39.9248, 32.8510], [39.9245, 32.8530], [39.9242, 32.8550], [39.9240, 32.8570]] },
    { id: 'f010', name: 'Kumrular Sokak', highway: 'residential', speed_limit: 30, coordinates: [[39.9220, 32.8510], [39.9222, 32.8520], [39.9224, 32.8530], [39.9226, 32.8540]] },
    { id: 'f011', name: 'Atatürk Bulvarı (Güney)', highway: 'primary', speed_limit: 70, coordinates: [[39.9150, 32.8534], [39.9130, 32.8532], [39.9110, 32.8530], [39.9090, 32.8528]] },
    { id: 'f012', name: 'Beştepe Yolu', highway: 'tertiary', speed_limit: 40, coordinates: [[39.9207, 32.8420], [39.9205, 32.8400], [39.9203, 32.8380], [39.9201, 32.8360]] },
    { id: 'f013', name: 'Kızılay Meydanı Çevresi', highway: 'secondary', speed_limit: 50, coordinates: [[39.9220, 32.8545], [39.9215, 32.8550], [39.9210, 32.8548], [39.9205, 32.8545], [39.9203, 32.8540], [39.9205, 32.8535], [39.9210, 32.8532], [39.9215, 32.8535], [39.9220, 32.8545]] },
    { id: 'f014', name: 'Anafartalar Caddesi', highway: 'secondary', speed_limit: 50, coordinates: [[39.9250, 32.8560], [39.9245, 32.8558], [39.9240, 32.8556], [39.9235, 32.8554], [39.9230, 32.8552], [39.9225, 32.8550]] },
    { id: 'f015', name: 'Bayındır Sokak', highway: 'residential', speed_limit: 30, coordinates: [[39.9225, 32.8560], [39.9222, 32.8565], [39.9218, 32.8568], [39.9215, 32.8570]] },
  ];
}

// ─────────────────────────────────────────────────────────────
// Polling döngüleri
// ─────────────────────────────────────────────────────────────
async function startTrafficPolling() {
  async function tick() {
    try {
      const data = await fetchTrafficData();
      applyTrafficColors(data);
    } catch (e) {
      console.warn('Trafik verisi alınamadı:', e);
    }
    setTimeout(tick, TRAFFIC_POLL_MS);
  }
  tick();
}

function startStatsPolling() {
  updateStats();
  setInterval(updateStats, STATS_POLL_MS);
}

// ─────────────────────────────────────────────────────────────
// Ana başlatma
// ─────────────────────────────────────────────────────────────
async function init() {
  try {
    if (standaloneMode) {
      setLoadingStatus('HTML modu başlatılıyor…');
    } else {
      setLoadingStatus('Backend bağlantısı kontrol ediliyor…');
      try {
        const health = await fetch(`${API_BASE}/`);
        if (!health.ok) throw new Error(`HTTP ${health.status}`);
      } catch (err) {
        standaloneMode = true;
        setLoadingStatus(`Backend erişilemedi (${err.message}). HTML modu başlatılıyor…`);
      }
    }

    const count = await loadRoads();

    setLoadingStatus('Trafik verisi alınıyor…');
    const traffic = await fetchTrafficData();
    applyTrafficColors(traffic);

    setLoadingStatus(`${count} yol yüklendi. Başlatılıyor…`);
    await updateStats();

    // Polling başlat
    setTimeout(startTrafficPolling, TRAFFIC_POLL_MS);
    startStatsPolling();

    // Yükleme ekranını kaldır
    setTimeout(hideLoadingOverlay, 800);

    console.log(`✅ Kızılay Trafik Simülasyonu başlatıldı. ${count} yol segmenti izleniyor.`);
  } catch (err) {
    console.error('Başlatma hatası:', err);
    setLoadingStatus(`❌ Bağlantı hatası: ${err.message}. Backend çalışıyor mu?`);
  }
}

// DOM hazır olduğunda başlat
document.addEventListener('DOMContentLoaded', init);

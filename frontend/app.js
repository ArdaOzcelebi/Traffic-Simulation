/**
 * Kızılay Canlı Trafik Simülasyonu — Frontend Uygulama Mantığı
 * Leaflet.js harita + FastAPI polling + Dashboard güncellemeleri
 */

const API_BASE = 'http://localhost:8000';

// Polling aralıkları (ms)
const TRAFFIC_POLL_MS = 5000;
const STATS_POLL_MS   = 1000;

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

// CartoDB Dark Matter tile
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> katkıcıları &copy; <a href="https://carto.com/">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 20,
}).addTo(map);

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
const polylines = {};        // road_id → Leaflet.Polyline
const roadsMetadata = {};    // road_id → {name, highway, speed_limit}

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
    ? traffic.current_speed.toFixed(0) + ' km/s'
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
        <span class="popup-val">${speedLimit} km/s</span>
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

  const resp = await fetch(`${API_BASE}/api/roads`);
  if (!resp.ok) throw new Error(`/api/roads HTTP ${resp.status}`);
  const roads = await resp.json();

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
    const resp = await fetch(`${API_BASE}/api/stats`);
    if (!resp.ok) return;
    const stats = await resp.json();
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
    setLoadingStatus('Backend bağlantısı kontrol ediliyor…');
    // Backend hazır mı?
    await fetch(`${API_BASE}/`);

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

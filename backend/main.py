"""
FastAPI ana uygulama — Kızılay Canlı Trafik Simülasyonu Backend
Çalıştırma: uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
"""

import logging
from contextlib import asynccontextmanager
from typing import List, Dict, Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from backend.osm_fetcher import fetch_roads_from_osm
from backend.traffic_engine import TrafficEngine
from backend.models import RoadSegment, TrafficStatus, CityStats

# ---------------------------------------------------------------------------
# Logging yapılandırması
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
roads_data: List[Dict] = []
engine = TrafficEngine()


# ---------------------------------------------------------------------------
# Lifespan (startup / shutdown)
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    global roads_data

    logger.info("=" * 60)
    logger.info("  Kızılay Trafik Simülasyonu başlatılıyor...")
    logger.info("=" * 60)

    # OSM'den yol verisi çek
    roads_data = fetch_roads_from_osm()
    logger.info(f"Toplam {len(roads_data)} yol segmenti yüklendi.")

    # Trafik motorunu başlat
    engine.load_roads(roads_data)
    engine.start()
    logger.info("Trafik motoru başlatıldı. API hazır.")

    yield

    # Uygulama kapanırken motoru durdur
    engine.stop()
    logger.info("Trafik motoru durduruldu.")


# ---------------------------------------------------------------------------
# FastAPI uygulaması
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Kızılay Canlı Trafik API",
    description="Ankara Kızılay bölgesi gerçek zamanlı trafik simülasyonu",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS: frontend localhost'tan erişebilsin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Endpoint'ler
# ---------------------------------------------------------------------------

@app.get("/", tags=["Info"])
async def root():
    return {
        "service": "Kızılay Canlı Trafik Simülasyonu",
        "version": "1.0.0",
        "endpoints": ["/api/roads", "/api/traffic", "/api/stats"],
    }


@app.get("/api/roads", tags=["Yol Verisi"])
async def get_roads() -> List[Dict]:
    """
    Kızılay bölgesindeki tüm yol segmentlerini döndürür.
    Her segmentte: id, name, highway, speed_limit, coordinates bilgileri bulunur.
    """
    if not roads_data:
        raise HTTPException(status_code=503, detail="Yol verisi henüz yüklenmedi.")
    return roads_data


@app.get("/api/traffic", tags=["Trafik Durumu"])
async def get_traffic() -> Dict[str, Any]:
    """
    Tüm yolların anlık trafik durumunu döndürür.
    Her yol için: density_level, current_speed, color, congestion_percent.
    """
    traffic = engine.get_traffic()
    return {
        "count": len(traffic),
        "data": traffic,
    }


@app.get("/api/stats", tags=["İstatistikler"])
async def get_stats() -> Dict:
    """
    Şehir geneli anlık trafik özeti.
    Simüle edilmiş saat, genel durum, ortalama hız ve yol dağılımı.
    """
    return engine.get_city_stats()


@app.get("/api/roads/{road_id}", tags=["Yol Verisi"])
async def get_road(road_id: str) -> Dict:
    """Belirli bir yol segmentinin bilgilerini döndürür."""
    for road in roads_data:
        if road["id"] == road_id:
            traffic = engine.get_traffic()
            return {
                **road,
                "traffic": traffic.get(road_id, {}),
            }
    raise HTTPException(status_code=404, detail=f"Yol bulunamadı: {road_id}")

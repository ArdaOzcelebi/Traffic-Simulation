"""
OSM Overpass API'den Kızılay bölgesi yol verisi çekme modülü.
Veri çekilemezse fallback (hardcoded) Kızılay yolları kullanılır.
"""

import requests
import json
import logging
from typing import List, Dict, Any

logger = logging.getLogger(__name__)

# Kızılay merkez koordinatı
KIZILAY_LAT = 39.9211
KIZILAY_LON = 32.8540
RADIUS_M = 1500  # metre

# OSM yol tipi → hız sınırı (km/h)
SPEED_LIMITS: Dict[str, int] = {
    "motorway": 90,
    "motorway_link": 70,
    "trunk": 80,
    "trunk_link": 60,
    "primary": 70,
    "primary_link": 50,
    "secondary": 50,
    "secondary_link": 40,
    "tertiary": 40,
    "tertiary_link": 30,
    "residential": 30,
    "living_street": 20,
    "unclassified": 30,
    "service": 20,
}

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

OVERPASS_QUERY = f"""
[out:json][timeout:30];
(
  way["highway"]["highway"!~"footway|cycleway|path|steps|pedestrian|construction"]
    (around:{RADIUS_M},{KIZILAY_LAT},{KIZILAY_LON});
);
out body;
>;
out skel qt;
"""


def _build_road_segments(elements: List[Dict[str, Any]]) -> List[Dict]:
    """OSM element listesinden yol segmentleri oluştur."""
    # Önce node'ları id → {lat, lon} haritasına dönüştür
    nodes: Dict[int, Dict[str, float]] = {}
    ways: List[Dict] = []

    for el in elements:
        if el["type"] == "node":
            nodes[el["id"]] = {"lat": el["lat"], "lon": el["lon"]}
        elif el["type"] == "way":
            ways.append(el)

    roads = []
    seen_ids = set()

    for way in ways:
        tags = way.get("tags", {})
        highway = tags.get("highway", "unclassified")

        # Yaya / bisiklet yollarını atla
        if highway in ("footway", "cycleway", "path", "steps", "pedestrian", "construction"):
            continue

        # Koordinat dizisini oluştur
        node_refs = way.get("nodes", [])
        coords = []
        for nid in node_refs:
            if nid in nodes:
                n = nodes[nid]
                coords.append([n["lat"], n["lon"]])

        if len(coords) < 2:
            continue

        # Yol adı
        name = (
            tags.get("name")
            or tags.get("name:tr")
            or tags.get("ref")
            or f"{highway.capitalize()} Sokak"
        )

        road_id = str(way["id"])
        if road_id in seen_ids:
            continue
        seen_ids.add(road_id)

        speed = SPEED_LIMITS.get(highway, 30)
        # maxspeed etiketi varsa kullan
        if "maxspeed" in tags:
            try:
                speed = int(tags["maxspeed"])
            except ValueError:
                pass

        roads.append({
            "id": road_id,
            "name": name,
            "highway": highway,
            "speed_limit": speed,
            "coordinates": coords,
        })

    logger.info(f"OSM'den {len(roads)} yol segmenti işlendi.")
    return roads


def fetch_roads_from_osm() -> List[Dict]:
    """Overpass API'den yol verisi çek. Hata durumunda fallback döndür."""
    try:
        logger.info("Overpass API'ye istek gönderiliyor...")
        resp = requests.post(
            OVERPASS_URL,
            data={"data": OVERPASS_QUERY},
            timeout=35,
        )
        resp.raise_for_status()
        data = resp.json()
        elements = data.get("elements", [])
        logger.info(f"Overpass API'den {len(elements)} element alındı.")
        roads = _build_road_segments(elements)
        if roads:
            return roads
        logger.warning("Overpass API boş yol listesi döndürdü, fallback kullanılıyor.")
    except Exception as exc:
        logger.error(f"Overpass API hatası: {exc}. Fallback verisi kullanılıyor.")

    return _get_fallback_roads()


def _get_fallback_roads() -> List[Dict]:
    """
    Kızılay çevresindeki temel yolların hardcoded koordinatları.
    OSM API erişilemez olduğunda kullanılır.
    """
    return [
        {
            "id": "f001",
            "name": "Atatürk Bulvarı",
            "highway": "primary",
            "speed_limit": 70,
            "coordinates": [
                [39.9270, 32.8545],
                [39.9250, 32.8543],
                [39.9230, 32.8541],
                [39.9211, 32.8540],
                [39.9190, 32.8538],
                [39.9170, 32.8536],
                [39.9150, 32.8534],
            ],
        },
        {
            "id": "f002",
            "name": "Gazi Mustafa Kemal Bulvarı",
            "highway": "primary",
            "speed_limit": 70,
            "coordinates": [
                [39.9211, 32.8540],
                [39.9210, 32.8510],
                [39.9209, 32.8480],
                [39.9208, 32.8450],
                [39.9207, 32.8420],
            ],
        },
        {
            "id": "f003",
            "name": "Ziya Gökalp Caddesi",
            "highway": "secondary",
            "speed_limit": 50,
            "coordinates": [
                [39.9230, 32.8590],
                [39.9225, 32.8570],
                [39.9220, 32.8550],
                [39.9215, 32.8530],
                [39.9211, 32.8510],
            ],
        },
        {
            "id": "f004",
            "name": "Mithatpaşa Caddesi",
            "highway": "secondary",
            "speed_limit": 50,
            "coordinates": [
                [39.9180, 32.8480],
                [39.9185, 32.8500],
                [39.9190, 32.8520],
                [39.9195, 32.8540],
                [39.9200, 32.8560],
                [39.9205, 32.8580],
            ],
        },
        {
            "id": "f005",
            "name": "İzmir Caddesi",
            "highway": "secondary",
            "speed_limit": 50,
            "coordinates": [
                [39.9211, 32.8540],
                [39.9215, 32.8560],
                [39.9218, 32.8580],
                [39.9220, 32.8600],
                [39.9222, 32.8620],
            ],
        },
        {
            "id": "f006",
            "name": "Necatibey Caddesi",
            "highway": "secondary",
            "speed_limit": 50,
            "coordinates": [
                [39.9240, 32.8480],
                [39.9238, 32.8500],
                [39.9235, 32.8520],
                [39.9232, 32.8540],
                [39.9230, 32.8560],
                [39.9228, 32.8580],
            ],
        },
        {
            "id": "f007",
            "name": "Meşrutiyet Caddesi",
            "highway": "tertiary",
            "speed_limit": 40,
            "coordinates": [
                [39.9200, 32.8540],
                [39.9202, 32.8560],
                [39.9204, 32.8580],
                [39.9206, 32.8600],
            ],
        },
        {
            "id": "f008",
            "name": "Olgunlar Sokak",
            "highway": "residential",
            "speed_limit": 30,
            "coordinates": [
                [39.9195, 32.8545],
                [39.9197, 32.8555],
                [39.9199, 32.8565],
            ],
        },
        {
            "id": "f009",
            "name": "Selanik Caddesi",
            "highway": "secondary",
            "speed_limit": 50,
            "coordinates": [
                [39.9250, 32.8490],
                [39.9248, 32.8510],
                [39.9245, 32.8530],
                [39.9242, 32.8550],
                [39.9240, 32.8570],
            ],
        },
        {
            "id": "f010",
            "name": "Kumrular Sokak",
            "highway": "residential",
            "speed_limit": 30,
            "coordinates": [
                [39.9220, 32.8510],
                [39.9222, 32.8520],
                [39.9224, 32.8530],
                [39.9226, 32.8540],
            ],
        },
        {
            "id": "f011",
            "name": "Atatürk Bulvarı (Güney)",
            "highway": "primary",
            "speed_limit": 70,
            "coordinates": [
                [39.9150, 32.8534],
                [39.9130, 32.8532],
                [39.9110, 32.8530],
                [39.9090, 32.8528],
            ],
        },
        {
            "id": "f012",
            "name": "Beştepe Yolu",
            "highway": "tertiary",
            "speed_limit": 40,
            "coordinates": [
                [39.9207, 32.8420],
                [39.9205, 32.8400],
                [39.9203, 32.8380],
                [39.9201, 32.8360],
            ],
        },
        {
            "id": "f013",
            "name": "Kızılay Meydanı Çevresi",
            "highway": "secondary",
            "speed_limit": 50,
            "coordinates": [
                [39.9220, 32.8545],
                [39.9215, 32.8550],
                [39.9210, 32.8548],
                [39.9205, 32.8545],
                [39.9203, 32.8540],
                [39.9205, 32.8535],
                [39.9210, 32.8532],
                [39.9215, 32.8535],
                [39.9220, 32.8545],
            ],
        },
        {
            "id": "f014",
            "name": "Anafartalar Caddesi",
            "highway": "secondary",
            "speed_limit": 50,
            "coordinates": [
                [39.9250, 32.8560],
                [39.9245, 32.8558],
                [39.9240, 32.8556],
                [39.9235, 32.8554],
                [39.9230, 32.8552],
                [39.9225, 32.8550],
            ],
        },
        {
            "id": "f015",
            "name": "Bayındır Sokak",
            "highway": "residential",
            "speed_limit": 30,
            "coordinates": [
                [39.9225, 32.8560],
                [39.9222, 32.8565],
                [39.9218, 32.8568],
                [39.9215, 32.8570],
            ],
        },
    ]

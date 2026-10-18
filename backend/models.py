"""
Pydantic veri modelleri — Kızılay Trafik Simülasyonu
"""

from pydantic import BaseModel
from typing import List, Tuple, Optional


class RoadSegment(BaseModel):
    """Tek bir yol segmentini temsil eder."""
    id: str
    name: str
    highway: str
    speed_limit: int  # km/h
    coordinates: List[List[float]]  # [[lat, lon], ...]


class TrafficStatus(BaseModel):
    """Bir yol segmentinin anlık trafik durumu."""
    road_id: str
    density_level: str          # free | moderate | heavy | jam
    current_speed: float        # km/h
    color: str                  # hex renk kodu
    congestion_percent: float   # 0–100


class CityStats(BaseModel):
    """Şehir geneli anlık trafik özeti."""
    simulated_time: str         # "HH:MM" formatı
    simulated_date: str         # "DD Ay YYYY" formatı
    overall_density: str        # Genel durum etiketi
    avg_speed: float            # km/h
    free_roads: int
    moderate_roads: int
    heavy_roads: int
    jam_roads: int
    total_roads: int

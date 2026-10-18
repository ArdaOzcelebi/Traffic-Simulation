"""
Canlı trafik simülasyon motoru.
Asyncio arka plan döngüsü ile her 5 saniyede yol trafik durumlarını günceller.
Pik saat modeli (07:30–09:30 ve 17:00–19:30) uygulanır.
"""

import asyncio
import random
import math
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# Trafik yoğunluk renk kodları
DENSITY_COLORS = {
    "free":     "#22c55e",   # Yeşil  — Akıcı
    "moderate": "#f97316",   # Turuncu — Yoğun
    "heavy":    "#ef4444",   # Kırmızı — Ağır
    "jam":      "#7f1d1d",   # Koyu Kırmızı — Kilit
}

DENSITY_LABELS = {
    "free":     "Akıcı",
    "moderate": "Yoğun",
    "heavy":    "Çok Yoğun",
    "jam":      "Kilit",
}

# Simülasyon hızlandırma faktörü: 1 gerçek saniye = SIM_SPEED simülasyon dakikası
SIM_SPEED = 2.0


class TrafficEngine:
    """
    Her yol segmenti için anlık trafik durumu yöneten motor.
    FastAPI lifespan ile başlatılır ve durdurulur.
    """

    def __init__(self):
        # road_id → trafik durumu dict
        self._traffic: Dict[str, Dict] = {}
        self._roads: List[Dict] = []
        self._task: Optional[asyncio.Task] = None

        # Simüle edilmiş saat (gerçek zamandan bağımsız)
        self._sim_start_real = datetime.now()
        self._sim_start_virtual = datetime(2026, 8, 19, 7, 30, 0)  # Simülasyon sabah 07:30'dan başlar

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def load_roads(self, roads: List[Dict]) -> None:
        """Yol listesini yükle ve başlangıç trafik durumlarını ata."""
        self._roads = roads
        for road in roads:
            self._traffic[road["id"]] = self._initial_status(road)
        logger.info(f"TrafficEngine: {len(roads)} yol yüklendi.")

    def start(self) -> None:
        """Arka plan güncelleme döngüsünü başlat."""
        self._task = asyncio.create_task(self._update_loop())
        logger.info("TrafficEngine başlatıldı.")

    def stop(self) -> None:
        """Arka plan döngüsünü durdur."""
        if self._task:
            self._task.cancel()

    def get_traffic(self) -> Dict[str, Dict]:
        """Tüm yolların anlık trafik durumunu döndür."""
        return dict(self._traffic)

    def get_sim_time(self) -> datetime:
        """Simüle edilmiş anlık zamanı döndür."""
        elapsed_real = (datetime.now() - self._sim_start_real).total_seconds()
        elapsed_virtual = elapsed_real * SIM_SPEED * 60  # saniye cinsinden
        return self._sim_start_virtual + timedelta(seconds=elapsed_virtual)

    def get_city_stats(self) -> Dict:
        """Şehir geneli trafik istatistiklerini döndür."""
        sim_dt = self.get_sim_time()

        counts = {"free": 0, "moderate": 0, "heavy": 0, "jam": 0}
        total_speed = 0.0

        for status in self._traffic.values():
            level = status.get("density_level", "free")
            counts[level] = counts.get(level, 0) + 1
            total_speed += status.get("current_speed", 50)

        total = max(len(self._traffic), 1)
        avg_speed = total_speed / total

        # Genel durum etiketi
        if counts["jam"] / total > 0.3:
            overall = "Kilit 🔴"
        elif counts["heavy"] / total > 0.3:
            overall = "Çok Yoğun 🟠"
        elif counts["moderate"] / total > 0.4:
            overall = "Yoğun 🟡"
        else:
            overall = "Akıcı 🟢"

        months_tr = [
            "", "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
            "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"
        ]

        return {
            "simulated_time": sim_dt.strftime("%H:%M"),
            "simulated_date": f"{sim_dt.day} {months_tr[sim_dt.month]} {sim_dt.year}",
            "overall_density": overall,
            "avg_speed": round(avg_speed, 1),
            "free_roads": counts["free"],
            "moderate_roads": counts["moderate"],
            "heavy_roads": counts["heavy"],
            "jam_roads": counts["jam"],
            "total_roads": total,
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _get_peak_factor(self, sim_hour: float) -> float:
        """
        Günün saatine göre trafik yoğunluk faktörü hesapla.
        0.0 = çok akıcı, 1.0 = tam kilit.
        """
        # Sabah piki: 07:30–09:30
        morning_peak = _gaussian(sim_hour, 8.5, 0.8)
        # Akşam piki: 17:00–19:30
        evening_peak = _gaussian(sim_hour, 18.25, 1.0)
        # Öğle hafif yoğunluğu: 12:00–13:30
        lunch_peak = _gaussian(sim_hour, 12.5, 0.5) * 0.5
        # Gece: düşük trafik
        night_factor = 1.0 - _gaussian(sim_hour, 3.0, 2.0) * 0.3

        raw = max(morning_peak, evening_peak, lunch_peak) * night_factor
        return min(max(raw * 0.9, 0.0), 1.0)

    def _determine_density(self, speed_ratio: float) -> str:
        """Hız oranına göre yoğunluk seviyesini belirle."""
        if speed_ratio >= 0.75:
            return "free"
        elif speed_ratio >= 0.45:
            return "moderate"
        elif speed_ratio >= 0.20:
            return "heavy"
        else:
            return "jam"

    def _initial_status(self, road: Dict) -> Dict:
        """Başlangıç trafik durumu oluştur."""
        speed_limit = road.get("speed_limit", 50)
        current_speed = random.uniform(speed_limit * 0.6, speed_limit * 0.95)
        ratio = current_speed / speed_limit
        density = self._determine_density(ratio)
        return {
            "road_id": road["id"],
            "density_level": density,
            "current_speed": round(current_speed, 1),
            "color": DENSITY_COLORS[density],
            "congestion_percent": round((1 - ratio) * 100, 1),
            "label": DENSITY_LABELS[density],
        }

    def _update_road(self, road: Dict, peak_factor: float) -> Dict:
        """Tek bir yolun trafik durumunu güncelle."""
        speed_limit = road.get("speed_limit", 50)
        prev = self._traffic.get(road["id"], {})
        prev_speed = prev.get("current_speed", speed_limit * 0.8)

        # Pik faktörüne göre hedef hız hesapla
        # peak_factor arttıkça hız düşer
        noise = random.gauss(0, 0.05)
        target_ratio = max(0.05, 1.0 - peak_factor * 0.85 + noise)

        # Ani değişimleri önlemek için yumuşatma (exponential moving average)
        smoothing = 0.3
        prev_ratio = prev_speed / speed_limit
        new_ratio = prev_ratio * (1 - smoothing) + target_ratio * smoothing
        # Küçük rastgele sapma ekle
        new_ratio += random.gauss(0, 0.03)
        new_ratio = max(0.05, min(1.05, new_ratio))

        current_speed = round(speed_limit * new_ratio, 1)
        density = self._determine_density(new_ratio)

        return {
            "road_id": road["id"],
            "density_level": density,
            "current_speed": current_speed,
            "color": DENSITY_COLORS[density],
            "congestion_percent": round((1 - new_ratio) * 100, 1),
            "label": DENSITY_LABELS[density],
        }

    async def _update_loop(self) -> None:
        """Her 5 saniyede trafik durumunu güncelle."""
        while True:
            try:
                sim_dt = self.get_sim_time()
                sim_hour = sim_dt.hour + sim_dt.minute / 60.0
                peak_factor = self._get_peak_factor(sim_hour)

                for road in self._roads:
                    self._traffic[road["id"]] = self._update_road(road, peak_factor)

                logger.debug(
                    f"Trafik güncellendi — sim saat: {sim_dt.strftime('%H:%M')}, "
                    f"peak_factor: {peak_factor:.2f}"
                )
            except Exception as exc:
                logger.error(f"Trafik güncelleme hatası: {exc}")

            await asyncio.sleep(5)


# ------------------------------------------------------------------
# Utility
# ------------------------------------------------------------------

def _gaussian(x: float, mu: float, sigma: float) -> float:
    """Normalize edilmemiş Gaussian (tepe değeri 1.0)."""
    return math.exp(-0.5 * ((x - mu) / sigma) ** 2)

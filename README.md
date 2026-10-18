# Kızılay Canlı Trafik Simülasyonu

Ankara Kızılay Meydanı ve çevresindeki ana arterleri kapsayan, gerçek zamanlı trafik yoğunluğunu renk kodlarıyla gösteren interaktif web uygulaması.

## Kurulum

```powershell
# 1. Sanal ortam oluştur
python -m venv .venv

# 2. Aktive et (PowerShell)
.\.venv\Scripts\Activate.ps1

# 3. Bağımlılıkları yükle
pip install -r requirements.txt
```

## Çalıştırma

**Terminal 1 — Backend:**
```powershell
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

**Terminal 2 — Frontend:**
```powershell
python -m http.server 3000 --directory frontend
```

Tarayıcıda aç: **http://localhost:3000**

## API Endpoint'leri

| Endpoint | Açıklama |
|---|---|
| `GET /api/roads` | Tüm yol geometrisi ve metadatası |
| `GET /api/traffic` | Anlık trafik durumu |
| `GET /api/stats` | Şehir geneli trafik özeti |
| `GET /api/roads/{id}` | Belirli bir yol detayı |

## Trafik Renk Kodları

| Renk | Durum | Hız |
|---|---|---|
| 🟢 Yeşil | Akıcı | Hız sınırında |
| 🟠 Turuncu | Yoğun | ~%50'si |
| 🔴 Kırmızı | Çok Yoğun | ~%20'si |
| ⬛ Koyu Kırmızı | Kilit | 0–10 km/s |

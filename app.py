import os
import time
import requests
from collections import defaultdict, Counter
from datetime import datetime
from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv

# Carga variables de entorno desde .env
load_dotenv()

API_KEY = os.getenv("OPENWEATHER_API_KEY", "")
DEFAULT_UNITS = os.getenv("DEFAULT_UNITS", "metric")  # metric | imperial
DEFAULT_LANG = os.getenv("DEFAULT_LANG", "es")

app = Flask(__name__)

# Cache en memoria (simple) por 5 minutos
CACHE_TTL = 300  # segundos
# Estructura: clave -> (timestamp, data)
# Para evitar colisiones entre "actual" y "forecast" añadimos un prefijo en la clave
_cache = {}

# ------------------------------
# Utilidades auxiliares
# ------------------------------

def _cache_get(key_tuple):
    """Recupera de cache si no está vencido."""
    now = time.time()
    if key_tuple in _cache:
        ts, data = _cache[key_tuple]
        if now - ts < CACHE_TTL:
            return data, True
    return None, False

def _cache_set(key_tuple, data):
    """Guarda en cache con timestamp actual."""
    _cache[key_tuple] = (time.time(), data)

def _weekday_es(date_str):
    """
    Devuelve abreviatura de día en español: Lun, Mar, Mié, Jue, Vie, Sáb, Dom
    date_str: 'YYYY-MM-DD'
    """
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    dias = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]
    return dias[dt.weekday()]

def summarize_forecast(forecast_json):
    """
    Recibe el JSON del endpoint /forecast (bloques de 3h por ~5 días)
    y lo reduce a un arreglo por día con:
    - fecha (YYYY-MM-DD)
    - etiqueta corta (p.ej. 'Lun 06')
    - temp_min / temp_max del día
    - desc e icon "representativos" (más frecuentes en el día)
    - pop (probabilidad de precipitación) promedio del día (0..1)
    """
    items = forecast_json.get("list", [])
    # Agrupa por 'YYYY-MM-DD' usando dt_txt
    by_day = defaultdict(list)
    for it in items:
        dt_txt = it.get("dt_txt")  # 'YYYY-MM-DD HH:MM:SS'
        if not dt_txt:
            # fallback por si no viene dt_txt
            dt = it.get("dt")
            if dt is None:
                continue
            dt_txt = datetime.utcfromtimestamp(dt).strftime("%Y-%m-%d %H:%M:%S")
        day_key = dt_txt[:10]
        by_day[day_key].append(it)

    daily = []
    for day_key in sorted(by_day.keys()):
        blocks = by_day[day_key]
        # Listas de min/max y recolección de weather
        mins, maxs, pops = [], [], []
        descs, icons = [], []
        for b in blocks:
            main = b.get("main", {})
            weather_arr = b.get("weather", [])
            if "temp_min" in main:
                mins.append(main["temp_min"])
            if "temp_max" in main:
                maxs.append(main["temp_max"])
            # Probabilidad de precipitación (0..1). No siempre viene, asumimos 0 si falta
            pops.append(b.get("pop", 0))
            if weather_arr:
                w = weather_arr[0]
                descs.append(w.get("description", ""))
                icons.append(w.get("icon", ""))

        # Si no hay datos suficientes, saltamos ese día
        if not mins or not maxs:
            continue

        # Más frecuente para desc/icon (representativo del día)
        desc = Counter([d for d in descs if d]).most_common(1)
        icon = Counter([i for i in icons if i]).most_common(1)
        rep_desc = desc[0][0] if desc else ""
        rep_icon = icon[0][0] if icon else None

        # Etiqueta bonita: 'Lun 06'
        day_tag = f"{_weekday_es(day_key)} {day_key[-2:]}"

        daily.append({
            "date": day_key,
            "day": day_tag,
            "temp_min": round(min(mins), 1),
            "temp_max": round(max(maxs), 1),
            "desc": rep_desc,
            "icon": rep_icon,
            "pop": round(sum(pops) / len(pops), 2) if pops else 0.0,  # promedio
        })

    # Nos quedamos con los próximos 5 días (el API suele traer hasta 5)
    return daily[:5]

# ------------------------------
# Llamadas a OpenWeather
# ------------------------------

def fetch_weather(city: str, units: str, lang: str):
    """
    Clima actual para una ciudad (endpoint 'weather').
    Devuelve (json, from_cache: bool)
    """
    key = ("current", city.lower().strip(), units, lang)
    data, from_cache = _cache_get(key)
    if from_cache:
        return data, True

    url = "https://api.openweathermap.org/data/2.5/weather"
    params = {
        "q": city,
        "appid": API_KEY,
        "units": units,  # metric (°C) | imperial (°F)
        "lang": lang,    # 'es' para descripciones en español
    }
    resp = requests.get(url, params=params, timeout=10)
    if resp.status_code != 200:
        # Intenta extraer mensaje de error legible
        try:
            err = resp.json()
        except Exception:
            err = {"message": resp.text}
        raise ValueError(f"Error de API ({resp.status_code}): {err.get('message','sin detalle')}")

    data = resp.json()
    _cache_set(key, data)
    return data, False

def fetch_forecast(city: str, units: str, lang: str):
    """
    Pronóstico 5 días/3 h (endpoint 'forecast') y resumen diario.
    Devuelve (lista_resumen, from_cache: bool)
    """
    key = ("forecast", city.lower().strip(), units, lang)
    data, from_cache = _cache_get(key)
    if from_cache:
        # Si viene de cache, ya guardamos el JSON resumido (no el crudo)
        return data, True

    url = "https://api.openweathermap.org/data/2.5/forecast"
    params = {
        "q": city,
        "appid": API_KEY,
        "units": units,
        "lang": lang,
    }
    resp = requests.get(url, params=params, timeout=10)
    if resp.status_code != 200:
        try:
            err = resp.json()
        except Exception:
            err = {"message": resp.text}
        raise ValueError(f"Error de API ({resp.status_code}): {err.get('message','sin detalle')}")

    raw = resp.json()
    daily_summary = summarize_forecast(raw)
    _cache_set(key, daily_summary)  # guardamos ya el resumen
    return daily_summary, False

# ------------------------------
# Rutas de páginas (clásico)
# ------------------------------

@app.route("/", methods=["GET"])
def home():
    """
    Renderiza la página inicial.
    En modo clásico no hay resultados; en AJAX el front los pinta.
    """
    return render_template("index.html",
                           result=None,
                           forecast5=None,
                           default_units=DEFAULT_UNITS,
                           default_lang=DEFAULT_LANG,
                           error=None,
                           from_cache=False)

@app.route("/weather", methods=["POST"])
def weather():
    """
    Modo clásico: el formulario hace POST aquí.
    Obtenemos clima actual + pronóstico 5 días y renderizamos la plantilla.
    """
    if not API_KEY:
        return render_template("index.html",
                               result=None,
                               forecast5=None,
                               error="Falta OPENWEATHER_API_KEY en el .env",
                               default_units=DEFAULT_UNITS,
                               default_lang=DEFAULT_LANG,
                               from_cache=False)

    city = (request.form.get("city") or "").strip()
    units = request.form.get("units", DEFAULT_UNITS)
    lang = request.form.get("lang", DEFAULT_LANG)

    if not city:
        return render_template("index.html",
                               result=None,
                               forecast5=None,
                               error="Ingresa una ciudad.",
                               default_units=units,
                               default_lang=lang,
                               from_cache=False)

    try:
        # Clima actual
        data_current, from_cache_current = fetch_weather(city, units, lang)

        # Parseo básico de clima actual
        name = data_current.get("name", city)
        sys = data_current.get("sys", {})
        country = sys.get("country", "")
        main = data_current.get("main", {})
        weather_list = data_current.get("weather", [])
        wind = data_current.get("wind", {})

        result = {
            "city": f"{name}, {country}" if country else name,
            "temp": main.get("temp"),
            "feels_like": main.get("feels_like"),
            "humidity": main.get("humidity"),
            "pressure": main.get("pressure"),
            "desc": weather_list[0]["description"] if weather_list else "Sin descripción",
            "icon": weather_list[0]["icon"] if weather_list else None,
            "wind_speed": wind.get("speed"),
            "units": units,  # para mostrar °C u °F
        }

        # Pronóstico 5 días (resumen diario)
        forecast5, from_cache_forecast = fetch_forecast(city, units, lang)

        return render_template("index.html",
                               result=result,
                               forecast5=forecast5,   # <-- pásalo a la plantilla
                               error=None,
                               default_units=units,
                               default_lang=lang,
                               from_cache=from_cache_current or from_cache_forecast)
    except Exception as e:
        return render_template("index.html",
                               result=None,
                               forecast5=None,
                               error=str(e),
                               default_units=DEFAULT_UNITS,
                               default_lang=DEFAULT_LANG,
                               from_cache=False)

# ------------------------------
# Endpoints JSON (AJAX)
# ------------------------------

@app.post("/api/weather")
def weather_api():
    """
    Modo AJAX: retorna JSON del clima actual para que el front lo pinte.
    Espera JSON: { city, units, lang }
    """
    if not API_KEY:
        return jsonify({"error": "Falta OPENWEATHER_API_KEY en .env"}), 400

    data = request.get_json(silent=True) or {}
    city = (data.get("city") or "").strip()
    units = data.get("units", DEFAULT_UNITS)
    lang  = data.get("lang",  DEFAULT_LANG)
    if not city:
        return jsonify({"error": "Ingresa una ciudad."}), 400

    try:
        cw, from_cache = fetch_weather(city, units, lang)

        w = cw["weather"][0] if cw.get("weather") else {}
        m = cw.get("main", {})
        wind = cw.get("wind", {})

        result = {
            "city": f'{cw.get("name", city)}, {cw.get("sys",{}).get("country","")}'.strip(", "),
            "temp": m.get("temp"),
            "feels_like": m.get("feels_like"),
            "humidity": m.get("humidity"),
            "pressure": m.get("pressure"),
            "desc": w.get("description",""),
            "icon": w.get("icon"),
            "wind_speed": wind.get("speed"),
            "units": units,
            "tz_offset": cw.get("timezone"),  # segundos de diferencia vs UTC
            "dt": cw.get("dt"),               # timestamp base (UTC) de la medición
        }
        return jsonify({"result": result, "from_cache": from_cache})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.post("/api/forecast")
def forecast_api():
    """
    Modo AJAX: retorna JSON con el pronóstico resumido a 5 días.
    Espera JSON: { city, units, lang }
    Respuesta: { forecast5: [ {date, day, temp_min, temp_max, desc, icon, pop}, ... ], from_cache }
    """
    if not API_KEY:
        return jsonify({"error": "Falta OPENWEATHER_API_KEY en .env"}), 400

    data = request.get_json(silent=True) or {}
    city = (data.get("city") or "").strip()
    units = data.get("units", DEFAULT_UNITS)
    lang  = data.get("lang",  DEFAULT_LANG)
    if not city:
        return jsonify({"error": "Ingresa una ciudad."}), 400

    try:
        forecast5, from_cache = fetch_forecast(city, units, lang)
        return jsonify({"forecast5": forecast5, "from_cache": from_cache})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

# ------------------------------

if __name__ == "__main__":
    # `flask run` también funciona; esto es útil para `python app.py`
    app.run(debug=True)



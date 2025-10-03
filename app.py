import os
import time
import requests
from flask import Flask, render_template, request
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("OPENWEATHER_API_KEY", "")
DEFAULT_UNITS = os.getenv("DEFAULT_UNITS", "metric")  # metric|imperial
DEFAULT_LANG = os.getenv("DEFAULT_LANG", "es")

app = Flask(__name__)

# Cachecito en memoria (opcional) para 5 minutos
CACHE_TTL = 300  # segundos
_cache = {}  # clave: (city, units, lang) -> (timestamp, data)

def fetch_weather(city: str, units: str, lang: str):
    key = (city.lower().strip(), units, lang)
    now = time.time()
    if key in _cache:
        ts, data = _cache[key]
        if now - ts < CACHE_TTL:
            return data, True  # desde cache

    # Endpoint de OpenWeather "Current weather data"
    # Doc: https://api.openweathermap.org/data/2.5/weather
    url = "https://api.openweathermap.org/data/2.5/weather"
    params = {
        "q": city,
        "appid": API_KEY,
        "units": units,  # metric (°C), imperial (°F)
        "lang": lang,    # 'es' para descripciones en español
    }
    resp = requests.get(url, params=params, timeout=10)
    if resp.status_code != 200:
        # Intenta extraer mensaje de error de OpenWeather
        try:
            err = resp.json()
        except Exception:
            err = {"message": resp.text}
        raise ValueError(f"Error de API ({resp.status_code}): {err.get('message','sin detalle')}")

    data = resp.json()
    _cache[key] = (now, data)
    return data, False

@app.route("/", methods=["GET"])
def home():
    return render_template("index.html",
                           result=None,
                           default_units=DEFAULT_UNITS,
                           default_lang=DEFAULT_LANG,
                           error=None,
                           from_cache=False)

@app.route("/weather", methods=["POST"])
def weather():
    if not API_KEY:
        return render_template("index.html",
                               result=None,
                               error="Falta OPENWEATHER_API_KEY en el .env",
                               default_units=DEFAULT_UNITS,
                               default_lang=DEFAULT_LANG,
                               from_cache=False)

    city = request.form.get("city", "").strip()
    units = request.form.get("units", DEFAULT_UNITS)
    lang = request.form.get("lang", DEFAULT_LANG)

    if not city:
        return render_template("index.html",
                               result=None,
                               error="Ingresa una ciudad.",
                               default_units=units,
                               default_lang=lang,
                               from_cache=False)

    try:
        data, from_cache = fetch_weather(city, units, lang)

        # Parseo básico
        name = data.get("name", city)
        sys = data.get("sys", {})
        country = sys.get("country", "")
        main = data.get("main", {})
        weather_list = data.get("weather", [])
        wind = data.get("wind", {})

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

        return render_template("index.html",
                               result=result,
                               error=None,
                               default_units=units,
                               default_lang=lang,
                               from_cache=from_cache)
    except Exception as e:
        return render_template("index.html",
                               result=None,
                               error=str(e),
                               default_units=DEFAULT_UNITS,
                               default_lang=DEFAULT_LANG,
                               from_cache=False)

if __name__ == "__main__":
    # `flask run` también funciona; esto es útil para `python app.py`
    app.run(debug=True)


    
import os
import re
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from pymongo import MongoClient, DESCENDING
from pymongo.errors import PyMongoError
from requests import RequestException

load_dotenv()

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False

OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY", "").strip()
MONGODB_URI = os.getenv("MONGODB_URI", "").strip()
MONGODB_DATABASE = os.getenv("MONGODB_DATABASE", "weather_dashboard")
WEATHER_TIMEOUT = float(os.getenv("WEATHER_TIMEOUT_SECONDS", "10"))
HISTORY_LIMIT = min(max(int(os.getenv("HISTORY_LIMIT", "10")), 1), 50)
FAVORITES_LIMIT = 20

mongo_client = None
history_collection = None
favorites_collection = None
if MONGODB_URI:
    try:
        mongo_client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=3000)
        history_collection = mongo_client[MONGODB_DATABASE]["search_history"]
        history_collection.create_index([("searched_at", DESCENDING)])
        favorites_collection = mongo_client[MONGODB_DATABASE]["favorites"]
        favorites_collection.create_index([("saved_at", DESCENDING)])
    except Exception:
        # The app still starts so the frontend can show a useful database error.
        history_collection = None
        favorites_collection = None

BASE_URL = "https://api.openweathermap.org"


class WeatherServiceError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


COMPASS_POINTS = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
]


def wind_dir_label(degrees):
    """Convert wind direction degrees to a 16-point compass label."""
    try:
        value = float(degrees)
    except (TypeError, ValueError):
        return None
    index = int((value % 360) / 22.5 + 0.5) % 16
    return COMPASS_POINTS[index]


def validate_city(city):
    """Validate a user-supplied city name. Returns an error string or None."""
    if not city:
        return "Enter a city name to search."
    if len(city) > 100:
        return "City name must be 100 characters or fewer."
    if any(ord(char) < 32 for char in city):
        return "City name contains invalid characters."
    if any(char in city for char in "<>{};$\\"):
        return "City name contains invalid characters."
    return None


def _weather_request(path, params):
    try:
        response = requests.get(
            f"{BASE_URL}{path}",
            params=params,
            timeout=WEATHER_TIMEOUT,
        )
    except RequestException as exc:
        raise WeatherServiceError(
            "Weather service could not be reached. Check your connection and try again.",
            503,
        ) from exc

    if response.status_code == 404:
        raise WeatherServiceError("City not found. Check the spelling and try again.", 404)
    if response.status_code in (401, 403):
        raise WeatherServiceError(
            "The weather API rejected the key. Verify OPENWEATHER_API_KEY in your .env file.",
            503,
        )
    if response.status_code == 429:
        raise WeatherServiceError("Weather API rate limit reached. Try again later.", 503)
    if not response.ok:
        raise WeatherServiceError("Weather provider returned an error. Please try again.", 502)

    try:
        return response.json()
    except ValueError as exc:
        raise WeatherServiceError("Weather provider returned an invalid response.", 502) from exc


def get_weather_for_city(city):
    if not OPENWEATHER_API_KEY:
        raise WeatherServiceError(
            "Weather API key is missing. Add OPENWEATHER_API_KEY to your .env file.",
            503,
        )

    # Geocoding avoids ambiguity from the legacy city-name parameter on weather endpoints.
    locations = _weather_request(
        "/geo/1.0/direct",
        {"q": city, "limit": 1, "appid": OPENWEATHER_API_KEY},
    )
    if not locations:
        raise WeatherServiceError("City not found. Check the spelling and try again.", 404)

    place = locations[0]
    lat, lon = place.get("lat"), place.get("lon")
    if lat is None or lon is None:
        raise WeatherServiceError("The weather provider could not locate that city.", 502)

    common = {
        "lat": lat,
        "lon": lon,
        "appid": OPENWEATHER_API_KEY,
        "units": "metric",
    }
    current = _weather_request("/data/2.5/weather", common)
    forecast = _weather_request("/data/2.5/forecast", common)

    main = current.get("main", {})
    weather_items = current.get("weather") or [{}]
    weather = weather_items[0]
    wind = current.get("wind", {})
    sys = current.get("sys", {})

    wind_deg = wind.get("deg")
    is_day_icon = str(weather.get("icon", "01d")).endswith("d")
    result = {
        "location": {
            "name": place.get("name") or current.get("name") or city,
            "state": place.get("state", ""),
            "country": place.get("country") or sys.get("country", ""),
            "lat": lat,
            "lon": lon,
            "timezone_offset": current.get("timezone", 0),
        },
        "current": {
            "temperature": round(main.get("temp", 0), 1),
            "feels_like": round(main.get("feels_like", 0), 1),
            "temp_min": round(main.get("temp_min", main.get("temp", 0)), 1),
            "temp_max": round(main.get("temp_max", main.get("temp", 0)), 1),
            "humidity": main.get("humidity"),
            "pressure": main.get("pressure"),
            "visibility": current.get("visibility"),
            "wind_speed": round(wind.get("speed", 0) * 3.6, 1),
            "wind_deg": wind_deg,
            "wind_dir": wind_dir_label(wind_deg),
            "clouds": (current.get("clouds") or {}).get("all"),
            "condition": weather.get("main", "Unknown"),
            "description": weather.get("description", "No description available").capitalize(),
            "icon": weather.get("icon", "01d"),
            "is_day": is_day_icon,
            "sunrise": sys.get("sunrise"),
            "sunset": sys.get("sunset"),
            "observed_at": current.get("dt"),
            "uv_index": None,
        },
        "forecast": [],
        "hourly": [],
        "units": {"temperature": "°C", "wind_speed": "km/h"},
    }

    # The free 5-day endpoint supplies 3-hour samples. Pick the sample nearest 12:00
    # for each local forecast date; if a date has no noon sample, use its first sample.
    grouped = {}
    offset = int(current.get("timezone", 0))
    for item in forecast.get("list", []):
        timestamp = int(item.get("dt", 0))
        local_dt = datetime.fromtimestamp(timestamp + offset, tz=timezone.utc)
        day_key = local_dt.strftime("%Y-%m-%d")
        grouped.setdefault(day_key, []).append((local_dt, item))

    for day_key, samples in list(grouped.items())[:5]:
        selected = min(samples, key=lambda pair: abs(pair[0].hour - 12))[1]
        fmain = selected.get("main", {})
        fweather = (selected.get("weather") or [{}])[0]
        result["forecast"].append({
            "date": day_key,
            "label": datetime.fromisoformat(day_key).strftime("%a"),
            "temperature": round(fmain.get("temp", 0), 1),
            "temp_min": round(fmain.get("temp_min", fmain.get("temp", 0)), 1),
            "temp_max": round(fmain.get("temp_max", fmain.get("temp", 0)), 1),
            "humidity": fmain.get("humidity"),
            "condition": fweather.get("main", "Unknown"),
            "description": fweather.get("description", ""),
            "icon": fweather.get("icon", "01d"),
            "pop": round(float(selected.get("pop", 0)) * 100),
        })

    # Hourly strip: full 3-hour sample list (up to 40 entries ≈ 5 days) in
    # location-local time so the frontend can filter by selected day.
    for item in (forecast.get("list") or [])[:40]:
        timestamp = int(item.get("dt", 0))
        local_dt = datetime.fromtimestamp(timestamp + offset, tz=timezone.utc)
        hmain = item.get("main", {})
        hweather = (item.get("weather") or [{}])[0]
        result["hourly"].append({
            "dt": timestamp,
            "date": local_dt.strftime("%Y-%m-%d"),
            "time": local_dt.strftime("%H:%M"),
            "label": local_dt.strftime("%a %H:%M"),
            "temperature": round(hmain.get("temp", 0), 1),
            "condition": hweather.get("main", "Unknown"),
            "description": hweather.get("description", ""),
            "icon": hweather.get("icon", "01d"),
            "pop": round(float(item.get("pop", 0)) * 100),
        })

    return result


def save_search(weather):
    if history_collection is None:
        return False
    current = weather["current"]
    location = weather["location"]
    document = {
        "city": location["name"],
        "state": location.get("state", ""),
        "country": location.get("country", ""),
        "temperature": current["temperature"],
        "condition": current["condition"],
        "description": current["description"],
        "icon": current.get("icon", "01d"),
        "humidity": current.get("humidity"),
        "wind_speed": current.get("wind_speed"),
        "searched_at": datetime.now(timezone.utc),
    }
    try:
        # Avoid duplicate rows for the same city: keep only the newest entry,
        # then enforce the history limit by dropping the oldest records.
        history_collection.delete_many({
            "city": {"$regex": f"^{re.escape(document['city'])}$", "$options": "i"},
        })
        history_collection.insert_one(document)
        excess = history_collection.count_documents({}) - HISTORY_LIMIT
        if excess > 0:
            oldest = list(history_collection.find({}, {"_id": 1})
                          .sort("searched_at", 1).limit(excess))
            history_collection.delete_many(
                {"_id": {"$in": [doc["_id"] for doc in oldest]}})
        return True
    except PyMongoError:
        return False


def serialize_history(document):
    return {
        "id": str(document.get("_id", "")),
        "city": document.get("city", ""),
        "state": document.get("state", ""),
        "country": document.get("country", ""),
        "temperature": document.get("temperature"),
        "condition": document.get("condition", ""),
        "description": document.get("description", ""),
        "icon": document.get("icon", "01d"),
        "humidity": document.get("humidity"),
        "wind_speed": document.get("wind_speed"),
        "searched_at": document["searched_at"].isoformat()
            if isinstance(document.get("searched_at"), datetime) else None,
    }


def serialize_favorite(document):
    return {
        "id": str(document.get("_id", "")),
        "city": document.get("city", ""),
        "state": document.get("state", ""),
        "country": document.get("country", ""),
        "temperature": document.get("temperature"),
        "condition": document.get("condition", ""),
        "icon": document.get("icon", "01d"),
        "saved_at": document["saved_at"].isoformat()
            if isinstance(document.get("saved_at"), datetime) else None,
    }


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/health")
def health():
    database_status = "not_configured"
    if history_collection is not None:
        try:
            mongo_client.admin.command("ping")
            database_status = "connected"
        except Exception:
            database_status = "unavailable"
    return jsonify({
        "status": "ok",
        "weather_api_configured": bool(OPENWEATHER_API_KEY),
        "database": database_status,
    })


@app.get("/api/weather")
def weather():
    city = (request.args.get("city") or "").strip()
    error = validate_city(city)
    if error:
        status = 400
        return jsonify({"error": error}), status

    try:
        result = get_weather_for_city(city)
    except WeatherServiceError as exc:
        return jsonify({"error": str(exc)}), exc.status

    result["history_saved"] = save_search(result)
    if not result["history_saved"]:
        result["history_warning"] = (
            "Weather loaded, but search history could not be saved. Check MongoDB configuration."
        )
    return jsonify(result)


@app.get("/api/history")
def history():
    if history_collection is None:
        return jsonify({
            "items": [],
            "available": False,
            "error": "MongoDB is not configured or could not connect. Set MONGODB_URI in .env.",
        }), 503
    try:
        documents = list(history_collection.find({}, {
            "city": 1, "state": 1, "country": 1, "temperature": 1,
            "condition": 1, "description": 1, "icon": 1, "humidity": 1,
            "wind_speed": 1, "searched_at": 1,
        }).sort("searched_at", DESCENDING).limit(HISTORY_LIMIT))
        return jsonify({"items": [serialize_history(doc) for doc in documents], "available": True})
    except PyMongoError:
        return jsonify({"items": [], "available": False, "error": "Could not read search history from MongoDB."}), 503


@app.delete("/api/history")
def clear_history():
    if history_collection is None:
        return jsonify({"error": "MongoDB is not configured or connected."}), 503
    try:
        history_collection.delete_many({})
        return jsonify({"message": "Search history cleared."})
    except PyMongoError:
        return jsonify({"error": "Could not clear search history."}), 503


@app.get("/api/favorites")
def list_favorites():
    if favorites_collection is None:
        return jsonify({
            "items": [],
            "available": False,
            "error": "MongoDB is not configured or could not connect. Set MONGODB_URI in .env.",
        }), 503
    try:
        documents = list(favorites_collection.find({}).sort("saved_at", DESCENDING).limit(FAVORITES_LIMIT))
        return jsonify({"items": [serialize_favorite(doc) for doc in documents], "available": True})
    except PyMongoError:
        return jsonify({"items": [], "available": False, "error": "Could not read favorites from MongoDB."}), 503


@app.post("/api/favorites")
def add_favorite():
    if favorites_collection is None:
        return jsonify({"error": "MongoDB is not configured or connected."}), 503
    payload = request.get_json(silent=True) or {}
    city = str(payload.get("city", "")).strip()
    error = validate_city(city)
    if error:
        return jsonify({"error": error}), 400
    try:
        existing = favorites_collection.find_one(
            {"city": {"$regex": f"^{re.escape(city)}$", "$options": "i"}})
        if existing:
            return jsonify({"item": serialize_favorite(existing), "available": True})
        if favorites_collection.count_documents({}) >= FAVORITES_LIMIT:
            return jsonify({"error": f"You can save up to {FAVORITES_LIMIT} favorite cities."}), 400
        # Store the resolved display name plus a live snapshot when possible.
        state, country, temperature, condition, icon = "", "", None, "", "01d"
        if OPENWEATHER_API_KEY:
            try:
                resolved = get_weather_for_city(city)
                state = resolved["location"].get("state", "")
                country = resolved["location"].get("country", "")
                city = resolved["location"].get("name", city)
                temperature = resolved["current"].get("temperature")
                condition = resolved["current"].get("condition", "")
                icon = resolved["current"].get("icon", "01d")
            except WeatherServiceError:
                pass  # Save the typed name; weather snapshot stays empty.
        document = {
            "city": city,
            "state": state,
            "country": country,
            "temperature": temperature,
            "condition": condition,
            "icon": icon,
            "saved_at": datetime.now(timezone.utc),
        }
        favorites_collection.insert_one(document)
        return jsonify({"item": serialize_favorite(document), "available": True}), 201
    except PyMongoError:
        return jsonify({"error": "Could not save favorite city."}), 503


@app.delete("/api/favorites")
def remove_favorite():
    if favorites_collection is None:
        return jsonify({"error": "MongoDB is not configured or connected."}), 503
    city = (request.args.get("city") or "").strip()
    if not city:
        return jsonify({"error": "Provide a city query parameter to remove."}), 400
    try:
        result = favorites_collection.delete_many(
            {"city": {"$regex": f"^{re.escape(city)}$", "$options": "i"}})
        if result.deleted_count == 0:
            return jsonify({"error": "Favorite city not found."}), 404
        return jsonify({"message": "Favorite removed."})
    except PyMongoError:
        return jsonify({"error": "Could not remove favorite city."}), 503


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.getenv("PORT", "5000")), debug=os.getenv("FLASK_DEBUG", "false").lower() == "true")

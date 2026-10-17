"""Automated tests for the Atmos weather dashboard.

All external interactions (OpenWeather HTTP, MongoDB) are mocked.
Nothing here requires live API keys, network access, or credentials.
"""
import re
from types import SimpleNamespace

import pytest

import app as weather_app
from app import app


# ---------- lightweight MongoDB fakes ----------

class _FakeCursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, *args, **kwargs):
        return self

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    def __iter__(self):
        return iter(self._docs)


class _FakeCollection:
    """Minimal pymongo-compatible stand-in for history/favorites tests."""

    def __init__(self):
        self.docs = []
        self._next_id = 1

    def _match(self, doc, filt):
        for key, cond in (filt or {}).items():
            if isinstance(cond, dict) and "$regex" in cond:
                flags = re.IGNORECASE if cond.get("$options") == "i" else 0
                if not re.match(cond["$regex"], str(doc.get(key, "")), flags):
                    return False
            elif isinstance(cond, dict) and "$in" in cond:
                if doc.get(key) not in cond["$in"]:
                    return False
            elif doc.get(key) != cond:
                return False
        return True

    def find_one(self, filt):
        return next((d for d in self.docs if self._match(d, filt)), None)

    def find(self, filt=None, projection=None):
        return _FakeCursor([d for d in self.docs if self._match(d, filt or {})])

    def insert_one(self, doc):
        doc = dict(doc)
        doc["_id"] = self._next_id
        self._next_id += 1
        self.docs.append(doc)
        return SimpleNamespace(inserted_id=doc["_id"])

    def delete_many(self, filt):
        before = len(self.docs)
        self.docs = [d for d in self.docs if not self._match(d, filt)]
        return SimpleNamespace(deleted_count=before - len(self.docs))

    def count_documents(self, filt):
        return sum(1 for d in self.docs if self._match(d, filt or {}))


@pytest.fixture
def client():
    app.config["TESTING"] = True
    return app.test_client()


@pytest.fixture
def fake_history(monkeypatch):
    coll = _FakeCollection()
    monkeypatch.setattr(weather_app, "history_collection", coll)
    return coll


@pytest.fixture
def fake_favorites(monkeypatch):
    coll = _FakeCollection()
    monkeypatch.setattr(weather_app, "favorites_collection", coll)
    return coll


def _sample_weather(city="Pune"):
    return {
        "location": {"name": city, "state": "MH", "country": "IN",
                     "lat": 18.5, "lon": 73.8, "timezone_offset": 19800},
        "current": {"temperature": 29.5, "feels_like": 31.0, "temp_min": 27.0,
                    "temp_max": 32.0, "humidity": 65, "pressure": 1012,
                    "visibility": 8000, "wind_speed": 11.5, "wind_deg": 90,
                    "wind_dir": "E", "clouds": 40, "condition": "Clouds",
                    "description": "Scattered clouds", "icon": "03d",
                    "is_day": True, "sunrise": 1700000000, "sunset": 1700040000,
                    "observed_at": 1700020000, "uv_index": None},
        "forecast": [{"date": "2024-01-01", "label": "Mon", "temperature": 29.0,
                      "temp_min": 27.0, "temp_max": 32.0, "humidity": 65,
                      "condition": "Clouds", "description": "scattered clouds",
                      "icon": "03d", "pop": 10}],
        "hourly": [{"dt": 1700020000, "date": "2024-01-01", "time": "12:00",
                    "label": "Mon 12:00", "temperature": 29.0,
                    "condition": "Clouds", "description": "scattered clouds",
                    "icon": "03d", "pop": 10}],
        "units": {"temperature": "°C", "wind_speed": "km/h"},
    }


# ---------- original behaviour (backward compatibility) ----------

def test_homepage_renders(client):
    response = client.get("/")
    assert response.status_code == 200
    assert b"Weather overview" in response.data


def test_weather_requires_city(client):
    response = client.get("/api/weather")
    assert response.status_code == 400
    assert response.get_json()["error"]


def test_weather_rejects_oversized_city(client):
    response = client.get("/api/weather?city=" + ("x" * 101))
    assert response.status_code == 400


def test_weather_service_error_is_reported(monkeypatch, client):
    def fail(_city):
        raise weather_app.WeatherServiceError("City not found.", 404)
    monkeypatch.setattr(weather_app, "get_weather_for_city", fail)
    response = client.get("/api/weather?city=NotARealCity")
    assert response.status_code == 404
    assert response.get_json()["error"] == "City not found."


def test_health_endpoint(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert "database" in response.get_json()


# ---------- input validation ----------

@pytest.mark.parametrize("city", ["Pune", "New York", "São Paulo", "Mumbai, MH, IN", "St. John's"])
def test_validate_city_accepts_real_names(city):
    assert weather_app.validate_city(city) is None


@pytest.mark.parametrize("city", ["", "   ", "<script>", "a>b", "x" * 101, "bad\x01name", "a;b", "a$b"])
def test_validate_city_rejects_bad_input(city):
    assert weather_app.validate_city(city.strip()) is not None


def test_weather_rejects_html_injection(client):
    response = client.get("/api/weather?city=%3Cscript%3Ealert(1)%3C/script%3E")
    assert response.status_code == 400


def test_favorites_post_rejects_bad_input(client, fake_favorites):
    response = client.post("/api/favorites", json={"city": "<img src=x>"})
    assert response.status_code == 400
    response = client.post("/api/favorites", json={"city": ""})
    assert response.status_code == 400


# ---------- helpers ----------

@pytest.mark.parametrize("deg,expected", [(0, "N"), (90, "E"), (180, "S"), (270, "W"), (45, "NE"), (359, "N")])
def test_wind_dir_label(deg, expected):
    assert weather_app.wind_dir_label(deg) == expected


def test_wind_dir_label_invalid():
    assert weather_app.wind_dir_label(None) is None
    assert weather_app.wind_dir_label("nope") is None


# ---------- weather payload structure (mocked upstream) ----------

def _mock_upstream(monkeypatch):
    monkeypatch.setattr(weather_app, "OPENWEATHER_API_KEY", "test-key")
    def fake_request(path, params):
        if path == "/geo/1.0/direct":
            return [{"name": "Pune", "state": "Maharashtra", "country": "IN",
                     "lat": 18.52, "lon": 73.85}]
        if path == "/data/2.5/weather":
            return {"main": {"temp": 29.5, "feels_like": 31.0, "temp_min": 27.0,
                             "temp_max": 32.0, "humidity": 65, "pressure": 1012},
                    "weather": [{"main": "Clouds", "description": "scattered clouds", "icon": "03d"}],
                    "wind": {"speed": 3.2, "deg": 90},
                    "sys": {"country": "IN", "sunrise": 1700000000, "sunset": 1700040000},
                    "clouds": {"all": 40}, "visibility": 8000,
                    "timezone": 19800, "dt": 1700020000, "name": "Pune"}
        if path == "/data/2.5/forecast":
            base = 1700020000
            items = []
            for i in range(6):
                items.append({"dt": base + i * 10800,
                              "main": {"temp": 29.0, "temp_min": 27.0, "temp_max": 32.0, "humidity": 65},
                              "weather": [{"main": "Clouds", "description": "scattered clouds", "icon": "03d"}],
                              "pop": 0.1})
            return {"list": items}
        raise AssertionError(f"unexpected path {path}")
    monkeypatch.setattr(weather_app, "_weather_request", fake_request)


def test_weather_payload_includes_hourly_and_metadata(monkeypatch):
    _mock_upstream(monkeypatch)
    result = weather_app.get_weather_for_city("Pune")
    assert result["location"]["name"] == "Pune"
    assert result["current"]["wind_dir"] == "E"
    assert result["current"]["is_day"] is True
    assert result["current"]["uv_index"] is None  # free plan: explicit, never fabricated
    assert len(result["forecast"]) >= 1
    assert len(result["hourly"]) == 6
    first = result["hourly"][0]
    for key in ("dt", "date", "time", "label", "temperature", "condition", "icon", "pop"):
        assert key in first
    # Hourly entries are in location-local time (UTC+5:30 for Pune).
    assert re.match(r"^\d{2}:\d{2}$", first["time"])


def test_weather_endpoint_returns_hourly(monkeypatch, client, fake_history):
    _mock_upstream(monkeypatch)
    response = client.get("/api/weather?city=Pune")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["hourly"] and payload["forecast"]
    assert payload["history_saved"] is True
    assert payload["units"] == {"temperature": "°C", "wind_speed": "km/h"}


def test_weather_missing_api_key(monkeypatch, client):
    monkeypatch.setattr(weather_app, "OPENWEATHER_API_KEY", "")
    with pytest.raises(weather_app.WeatherServiceError) as exc:
        weather_app.get_weather_for_city("Pune")
    assert exc.value.status == 503


def test_weather_upstream_rate_limit(monkeypatch, client):
    class _Resp:
        status_code = 429
        ok = False

        def json(self):
            return {}
    monkeypatch.setattr(weather_app.requests, "get", lambda *a, **k: _Resp())
    with pytest.raises(weather_app.WeatherServiceError) as exc:
        weather_app._weather_request("/data/2.5/weather", {})
    assert exc.value.status == 503


def test_weather_upstream_bad_json(monkeypatch):
    class _Resp:
        status_code = 200
        ok = True

        def json(self):
            raise ValueError("nope")
    monkeypatch.setattr(weather_app.requests, "get", lambda *a, **k: _Resp())
    with pytest.raises(weather_app.WeatherServiceError) as exc:
        weather_app._weather_request("/data/2.5/weather", {})
    assert exc.value.status == 502


def test_weather_degrades_without_database(monkeypatch, client):
    _mock_upstream(monkeypatch)
    monkeypatch.setattr(weather_app, "history_collection", None)
    response = client.get("/api/weather?city=Pune")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["history_saved"] is False
    assert "history_warning" in payload


# ---------- search-history deduplication + icons ----------

def test_history_dedupe_and_icon(fake_history):
    assert weather_app.save_search(_sample_weather("Pune")) is True
    assert weather_app.save_search(_sample_weather("pune")) is True  # case-insensitive dup
    assert len(fake_history.docs) == 1
    assert fake_history.docs[0]["icon"] == "03d"
    assert fake_history.docs[0]["city"] == "pune"  # newest entry wins


def test_history_limit_enforced(monkeypatch, fake_history):
    monkeypatch.setattr(weather_app, "HISTORY_LIMIT", 3)
    for i in range(5):
        assert weather_app.save_search(_sample_weather(f"City{i}")) is True
    assert len(fake_history.docs) == 3


def test_history_get_and_clear(client, fake_history):
    weather_app.save_search(_sample_weather("Pune"))
    response = client.get("/api/history")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["available"] is True
    assert payload["items"][0]["city"] == "Pune"
    assert payload["items"][0]["icon"] == "03d"
    response = client.delete("/api/history")
    assert response.status_code == 200
    assert client.get("/api/history").get_json()["items"] == []


def test_history_unavailable_without_db(monkeypatch, client):
    monkeypatch.setattr(weather_app, "history_collection", None)
    assert client.get("/api/history").status_code == 503
    assert client.delete("/api/history").status_code == 503


def test_serialize_history_tolerates_legacy_docs():
    doc = {"city": "Pune", "searched_at": "not-a-date"}  # pre-icon documents
    out = weather_app.serialize_history(doc)
    assert out["icon"] == "01d"
    assert out["searched_at"] is None


# ---------- favorites ----------

def test_favorites_crud(client, fake_favorites, monkeypatch):
    # Resolution is skipped without an API key; typed name is stored.
    monkeypatch.setattr(weather_app, "OPENWEATHER_API_KEY", "")
    response = client.post("/api/favorites", json={"city": "Tokyo"})
    assert response.status_code == 201
    assert response.get_json()["item"]["city"] == "Tokyo"

    response = client.get("/api/favorites")
    assert response.status_code == 200
    assert [i["city"] for i in response.get_json()["items"]] == ["Tokyo"]

    response = client.delete("/api/favorites?city=tokyo")  # case-insensitive
    assert response.status_code == 200
    assert client.get("/api/favorites").get_json()["items"] == []


def test_favorites_duplicate_returns_existing(client, fake_favorites, monkeypatch):
    monkeypatch.setattr(weather_app, "OPENWEATHER_API_KEY", "")
    client.post("/api/favorites", json={"city": "Paris"})
    response = client.post("/api/favorites", json={"city": "PARIS"})
    assert response.status_code == 200
    assert len(fake_favorites.docs) == 1


def test_favorites_limit(client, fake_favorites, monkeypatch):
    monkeypatch.setattr(weather_app, "OPENWEATHER_API_KEY", "")
    monkeypatch.setattr(weather_app, "FAVORITES_LIMIT", 2)
    client.post("/api/favorites", json={"city": "A"})
    client.post("/api/favorites", json={"city": "B"})
    response = client.post("/api/favorites", json={"city": "C"})
    assert response.status_code == 400


def test_favorites_delete_errors(client, fake_favorites):
    assert client.delete("/api/favorites").status_code == 400  # missing ?city=
    assert client.delete("/api/favorites?city=Nowhere").status_code == 404


def test_favorites_unavailable_without_db(monkeypatch, client):
    monkeypatch.setattr(weather_app, "favorites_collection", None)
    assert client.get("/api/favorites").status_code == 503
    assert client.post("/api/favorites", json={"city": "X"}).status_code == 503
    assert client.delete("/api/favorites?city=X").status_code == 503


def test_favorites_snapshot_uses_live_data(client, fake_favorites, monkeypatch):
    monkeypatch.setattr(weather_app, "OPENWEATHER_API_KEY", "test-key")
    monkeypatch.setattr(weather_app, "get_weather_for_city", lambda city: _sample_weather("Pune"))
    response = client.post("/api/favorites", json={"city": "pune"})
    assert response.status_code == 201
    item = response.get_json()["item"]
    assert item["city"] == "Pune"  # resolved display name
    assert item["temperature"] == 29.5
    assert item["icon"] == "03d"

"""Root Record Weather Manager backend tests."""
import os
import uuid
import pytest
import requests
from dotenv import load_dotenv

load_dotenv("/app/frontend/.env")

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

# Seattle coords
LAT, LON = 47.6062, -122.3321


@pytest.fixture(scope="module")
def guest_id():
    return f"TEST{uuid.uuid4().hex[:12]}"


@pytest.fixture(scope="module")
def guest_headers(guest_id):
    return {"X-Guest-Id": guest_id, "Content-Type": "application/json"}


# ---------------- HEALTH ----------------
class TestHealth:
    def test_health(self):
        r = requests.get(f"{API}/health", timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "ok"

    def test_root(self):
        r = requests.get(f"{API}/", timeout=15)
        assert r.status_code == 200
        assert "Root Record" in r.json()["name"]


# ---------------- AUTH PROXY ----------------
class TestAuthProxy:
    def test_login_invalid(self):
        r = requests.post(
            f"{API}/auth/login",
            json={"email": f"nonexistent_{uuid.uuid4().hex}@example.invalid", "password": "wrongpass!!!"},
            timeout=20,
        )
        # Should be a 4xx (proxy returns the upstream error code)
        assert 400 <= r.status_code < 500, f"Expected 4xx got {r.status_code}: {r.text}"
        assert "detail" in r.json()

    def test_signup_invalid(self):
        # use clearly malformed email to force upstream error
        r = requests.post(
            f"{API}/auth/signup",
            json={"email": "not-an-email", "password": "x"},
            timeout=20,
        )
        assert 400 <= r.status_code < 500, f"Expected 4xx got {r.status_code}: {r.text}"

    def test_me_no_token(self):
        r = requests.post(f"{API}/auth/me", timeout=15)
        assert r.status_code == 401

    def test_me_invalid_token(self):
        r = requests.post(
            f"{API}/auth/me",
            headers={"Authorization": "Bearer not-a-real-token"},
            timeout=20,
        )
        # upstream returns whatever it returns; should be 4xx
        assert 400 <= r.status_code < 500, f"Expected 4xx got {r.status_code}"


# ---------------- LOCATIONS (Guest) ----------------
class TestLocations:
    created_id = None

    def test_unauth_locations(self):
        r = requests.get(f"{API}/locations", timeout=15)
        assert r.status_code == 401

    def test_create_location(self, guest_headers):
        payload = {"name": "TEST_Seattle", "latitude": LAT, "longitude": LON}
        r = requests.post(f"{API}/locations", json=payload, headers=guest_headers, timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["name"] == "TEST_Seattle"
        assert data["latitude"] == LAT
        assert "id" in data
        TestLocations.created_id = data["id"]

    def test_list_location(self, guest_headers):
        r = requests.get(f"{API}/locations", headers=guest_headers, timeout=15)
        assert r.status_code == 200
        items = r.json()
        assert any(x["id"] == TestLocations.created_id for x in items)

    def test_patch_location(self, guest_headers):
        assert TestLocations.created_id
        r = requests.patch(
            f"{API}/locations/{TestLocations.created_id}",
            json={"name": "TEST_Seattle_Updated"},
            headers=guest_headers,
            timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.json()["name"] == "TEST_Seattle_Updated"

    def test_create_location_bad_latlon(self, guest_headers):
        r = requests.post(
            f"{API}/locations",
            json={"name": "Bad", "latitude": 999, "longitude": -200},
            headers=guest_headers,
            timeout=15,
        )
        assert r.status_code == 400

    def test_create_location_missing_name(self, guest_headers):
        r = requests.post(
            f"{API}/locations",
            json={"name": "", "latitude": LAT, "longitude": LON},
            headers=guest_headers,
            timeout=15,
        )
        assert r.status_code == 400

    def test_delete_location(self, guest_headers):
        assert TestLocations.created_id
        r = requests.delete(
            f"{API}/locations/{TestLocations.created_id}",
            headers=guest_headers,
            timeout=15,
        )
        assert r.status_code == 200
        # Verify removal
        r2 = requests.get(f"{API}/locations", headers=guest_headers, timeout=15)
        assert all(x["id"] != TestLocations.created_id for x in r2.json())


# ---------------- WEATHER (NOAA NWS) ----------------
class TestWeather:
    def test_current(self):
        r = requests.get(f"{API}/weather/current", params={"lat": LAT, "lon": LON}, timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert data.get("available") is True, data
        assert data.get("city")
        assert data.get("state")

    def test_forecast(self):
        r = requests.get(f"{API}/weather/forecast", params={"lat": LAT, "lon": LON}, timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert "periods" in data
        assert isinstance(data["periods"], list)

    def test_alerts(self):
        r = requests.get(f"{API}/weather/alerts", params={"lat": LAT, "lon": LON}, timeout=30)
        assert r.status_code == 200
        assert "alerts" in r.json()


# ---------------- CANADA ----------------
class TestCanada:
    def test_canada_alerts_seattle(self):
        # outside Canada usually returns empty but should not 500
        r = requests.get(f"{API}/canada/alerts", params={"lat": LAT, "lon": LON}, timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert "alerts" in data
        assert isinstance(data["alerts"], list)


# ---------------- USGS ----------------
class TestUSGS:
    def test_earthquakes(self):
        r = requests.get(
            f"{API}/usgs/earthquakes",
            params={"lat": LAT, "lon": LON, "period": "week", "min_magnitude": 1.0},
            timeout=30,
        )
        assert r.status_code == 200
        data = r.json()
        assert data.get("available") is True
        events = data.get("events", [])
        # Verify sorted newest first
        if len(events) >= 2:
            times = [e.get("time") or 0 for e in events]
            assert times == sorted(times, reverse=True)

    def test_tsunamis(self):
        r = requests.get(f"{API}/usgs/tsunamis", timeout=30)
        assert r.status_code == 200
        assert "bulletins" in r.json()


# ---------------- EONET ----------------
class TestEONET:
    def test_cyclones(self):
        r = requests.get(f"{API}/eonet/cyclones", timeout=30)
        assert r.status_code == 200
        assert "events" in r.json()

    def test_wildfires(self):
        r = requests.get(f"{API}/eonet/wildfires", timeout=30)
        assert r.status_code == 200
        assert "events" in r.json()


# ---------------- DASHBOARD ----------------
class TestDashboard:
    def test_dashboard_bundle(self):
        r = requests.get(f"{API}/dashboard", params={"lat": LAT, "lon": LON}, timeout=60)
        assert r.status_code == 200
        data = r.json()
        for k in ("current", "alerts", "canada_alerts", "usgs", "forecast", "fetched_at"):
            assert k in data

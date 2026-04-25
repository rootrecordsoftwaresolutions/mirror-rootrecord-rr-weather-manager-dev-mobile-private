"""Root Record Weather Manager — Mobile API.

Proxies the existing Cloudflare Workers license/auth API used by the desktop app,
provides per-user saved location CRUD on MongoDB, and aggregates public weather +
hazard feeds (NOAA NWS, Environment Canada, USGS, NASA EONET) for mobile clients.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field

load_dotenv()

# --------------------------------------------------------------------------- env
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
LICENSE_API_BASE_URL = os.environ.get(
    "LICENSE_API_BASE_URL",
    "https://rootrecord-license.wildecho94.workers.dev",
).rstrip("/")
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*")

logger = logging.getLogger("rrweather")
logging.basicConfig(level=logging.INFO)

# --------------------------------------------------------------------------- db
client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]
locations_col = db["locations"]
guest_state_col = db["guest_state"]

# --------------------------------------------------------------------------- app
app = FastAPI(title="Root Record Weather Manager API", version="1.0.0")
api = APIRouter(prefix="/api")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in CORS_ORIGINS.split(",")] if CORS_ORIGINS != "*" else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

USER_AGENT = "RootRecordWeatherManagerMobile/1.0 (contact: root@rootrecord.info)"


# ============================================================================
#                                  MODELS
# ============================================================================
class Location(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    name: str
    latitude: float
    longitude: float
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class LocationCreate(BaseModel):
    name: str
    latitude: float
    longitude: float


class LocationUpdate(BaseModel):
    name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class AuthCredentials(BaseModel):
    email: str
    password: str


class AuthResponse(BaseModel):
    ok: bool
    token: Optional[str] = None
    email: Optional[str] = None
    account_id: Optional[str] = None
    message: Optional[str] = None
    pro_unlocked: Optional[bool] = None


# ============================================================================
#                                  HELPERS
# ============================================================================
async def get_user_id(
    authorization: Optional[str] = Header(None),
    x_guest_id: Optional[str] = Header(None),
) -> str:
    """Resolve the caller. Either signed-in (Authorization: Bearer <token> validated against
    Cloudflare Workers) or guest mode (X-Guest-Id header from device).
    """
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
        async with httpx.AsyncClient(timeout=12.0) as hc:
            try:
                r = await hc.post(
                    f"{LICENSE_API_BASE_URL}/license/prepare",
                    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                    json={},
                )
                if r.status_code == 200:
                    data = r.json()
                    email = (data.get("email") or "").strip().lower()
                    if email and data.get("authenticated"):
                        return f"user:{email}"
            except Exception as e:  # noqa: BLE001
                logger.warning("license prepare failed: %s", e)
        raise HTTPException(status_code=401, detail="Invalid or expired session.")
    if x_guest_id:
        gid = re.sub(r"[^a-zA-Z0-9_-]", "", x_guest_id)[:64]
        if gid:
            return f"guest:{gid}"
    raise HTTPException(status_code=401, detail="Sign in or provide a guest id.")


def _doc_out(doc: dict) -> dict:
    """Strip MongoDB _id and return a plain dict."""
    if not doc:
        return doc
    doc = dict(doc)
    doc.pop("_id", None)
    return doc


def haversine_miles(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    r = 3958.7613
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dphi = math.radians(b_lat - a_lat)
    dlmb = math.radians(b_lon - a_lon)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


# ============================================================================
#                                   ROOT
# ============================================================================
@api.get("/")
async def root():
    return {"name": "Root Record Weather Manager API", "version": "1.0.0"}


@api.get("/health")
async def health():
    try:
        await db.command("ping")
        return {"status": "ok", "db": "ok"}
    except Exception as e:  # noqa: BLE001
        return {"status": "degraded", "db": str(e)}


# ============================================================================
#                                   AUTH (proxy)
# ============================================================================
async def _proxy_license(path: str, payload: dict, token: Optional[str] = None) -> dict:
    async with httpx.AsyncClient(timeout=15.0) as hc:
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            r = await hc.post(f"{LICENSE_API_BASE_URL}{path}", headers=headers, json=payload)
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Auth service unreachable: {e}") from e
        try:
            data = r.json()
        except Exception:  # noqa: BLE001
            data = {}
        if r.status_code >= 400:
            msg = ""
            if isinstance(data, dict):
                msg = data.get("message") or (data.get("error") if isinstance(data.get("error"), str) else "")
                if not msg and isinstance(data.get("error"), dict):
                    msg = data["error"].get("message") or ""
            raise HTTPException(status_code=r.status_code, detail=msg or f"Auth failed (HTTP {r.status_code})")
        return data if isinstance(data, dict) else {}


@api.post("/auth/login", response_model=AuthResponse)
async def auth_login(creds: AuthCredentials):
    data = await _proxy_license("/license/login", {"email": creds.email, "password": creds.password})
    token = data.get("access_token") or data.get("token")
    return AuthResponse(
        ok=True,
        token=token,
        email=(data.get("email") or creds.email).strip(),
        account_id=str(data.get("account_id") or ""),
        message=data.get("message") or "Signed in.",
        pro_unlocked=bool(data.get("proUnlocked") or data.get("pro_unlocked")),
    )


@api.post("/auth/signup", response_model=AuthResponse)
async def auth_signup(creds: AuthCredentials):
    data = await _proxy_license("/license/signup", {"email": creds.email, "password": creds.password})
    token = data.get("access_token") or data.get("token")
    return AuthResponse(
        ok=True,
        token=token,
        email=(data.get("email") or creds.email).strip(),
        account_id=str(data.get("account_id") or ""),
        message=data.get("message") or "Account created.",
        pro_unlocked=bool(data.get("proUnlocked") or data.get("pro_unlocked")),
    )


@api.post("/auth/me")
async def auth_me(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token = authorization.split(" ", 1)[1].strip()
    data = await _proxy_license("/license/prepare", {}, token=token)
    return {
        "authenticated": bool(data.get("authenticated")),
        "email": (data.get("email") or "").strip(),
        "pro_unlocked": bool(data.get("proUnlocked") or data.get("pro_unlocked")),
        "trial_ends_at": data.get("trialEndsAt"),
        "access": data.get("access"),
        "raw": data,
    }


# ============================================================================
#                                 LOCATIONS
# ============================================================================
@api.get("/locations", response_model=List[Location])
async def list_locations(user_id: str = Depends(get_user_id)):
    cursor = locations_col.find({"user_id": user_id}, {"_id": 0}).sort("created_at", 1)
    return [Location(**d) async for d in cursor]


@api.post("/locations", response_model=Location)
async def create_location(payload: LocationCreate, user_id: str = Depends(get_user_id)):
    if not payload.name.strip():
        raise HTTPException(400, "Location name is required.")
    if not (-90 <= payload.latitude <= 90) or not (-180 <= payload.longitude <= 180):
        raise HTTPException(400, "Latitude/longitude out of range.")
    loc = Location(user_id=user_id, name=payload.name.strip(),
                   latitude=payload.latitude, longitude=payload.longitude)
    await locations_col.insert_one(loc.model_dump())
    return loc


@api.patch("/locations/{location_id}", response_model=Location)
async def update_location(location_id: str, payload: LocationUpdate, user_id: str = Depends(get_user_id)):
    update = {k: v for k, v in payload.model_dump(exclude_none=True).items()}
    if not update:
        raise HTTPException(400, "No fields to update.")
    await locations_col.update_one({"id": location_id, "user_id": user_id}, {"$set": update})
    doc = await locations_col.find_one({"id": location_id, "user_id": user_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Location not found.")
    return Location(**doc)


@api.delete("/locations/{location_id}")
async def delete_location(location_id: str, user_id: str = Depends(get_user_id)):
    res = await locations_col.delete_one({"id": location_id, "user_id": user_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "Location not found.")
    return {"ok": True}


# ============================================================================
#                              WEATHER (NOAA NWS)
# ============================================================================
async def _nws_fetch(client_: httpx.AsyncClient, url: str) -> dict:
    r = await client_.get(url, headers={"User-Agent": USER_AGENT, "Accept": "application/geo+json"})
    if r.status_code >= 400:
        raise HTTPException(502, f"NWS upstream error: HTTP {r.status_code}")
    return r.json()


@api.get("/weather/current")
async def weather_current(lat: float = Query(...), lon: float = Query(...)):
    """Return current observation + a derived 'now' summary using the closest NWS station.
    Falls back to a 'forecastHourly' first period if observations are unavailable.
    """
    async with httpx.AsyncClient(timeout=15.0) as hc:
        try:
            points = await _nws_fetch(hc, f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}")
        except HTTPException:
            return {"available": False, "reason": "nws_points_unavailable"}
        props = (points or {}).get("properties") or {}
        stations_url = props.get("observationStations")
        forecast_url = props.get("forecast")
        forecast_hourly_url = props.get("forecastHourly")

        observation: dict = {}
        if stations_url:
            try:
                stations = await _nws_fetch(hc, stations_url)
                features = (stations or {}).get("features") or []
                if features:
                    station_id = features[0]["properties"]["stationIdentifier"]
                    obs = await _nws_fetch(hc, f"https://api.weather.gov/stations/{station_id}/observations/latest")
                    observation = (obs or {}).get("properties") or {}
            except Exception as e:  # noqa: BLE001
                logger.info("station obs failed: %s", e)

        hourly_first: dict = {}
        if forecast_hourly_url:
            try:
                hourly = await _nws_fetch(hc, forecast_hourly_url)
                periods = ((hourly or {}).get("properties") or {}).get("periods") or []
                if periods:
                    hourly_first = periods[0]
            except Exception as e:  # noqa: BLE001
                logger.info("hourly fetch failed: %s", e)

    return {
        "available": True,
        "observation": observation,
        "hourly_now": hourly_first,
        "forecast_url": forecast_url,
        "forecast_hourly_url": forecast_hourly_url,
        "city": props.get("relativeLocation", {}).get("properties", {}).get("city"),
        "state": props.get("relativeLocation", {}).get("properties", {}).get("state"),
    }


@api.get("/weather/forecast")
async def weather_forecast(lat: float = Query(...), lon: float = Query(...)):
    async with httpx.AsyncClient(timeout=15.0) as hc:
        try:
            points = await _nws_fetch(hc, f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}")
        except HTTPException:
            return {"available": False, "periods": [], "hourly": []}
        props = (points or {}).get("properties") or {}
        forecast_url = props.get("forecast")
        forecast_hourly_url = props.get("forecastHourly")

        periods: list = []
        hourly: list = []
        if forecast_url:
            try:
                fc = await _nws_fetch(hc, forecast_url)
                periods = ((fc or {}).get("properties") or {}).get("periods") or []
            except Exception as e:  # noqa: BLE001
                logger.info("forecast failed: %s", e)
        if forecast_hourly_url:
            try:
                fh = await _nws_fetch(hc, forecast_hourly_url)
                hourly = ((fh or {}).get("properties") or {}).get("periods") or []
                hourly = hourly[:24]
            except Exception as e:  # noqa: BLE001
                logger.info("hourly forecast failed: %s", e)

    return {"available": True, "periods": periods, "hourly": hourly}


@api.get("/weather/alerts")
async def weather_alerts(lat: float = Query(...), lon: float = Query(...)):
    async with httpx.AsyncClient(timeout=15.0) as hc:
        try:
            r = await hc.get(
                f"https://api.weather.gov/alerts/active?point={lat:.4f},{lon:.4f}",
                headers={"User-Agent": USER_AGENT, "Accept": "application/geo+json"},
            )
            if r.status_code >= 400:
                return {"available": False, "alerts": []}
            data = r.json()
        except Exception as e:  # noqa: BLE001
            logger.info("noaa alerts failed: %s", e)
            return {"available": False, "alerts": []}
    features = (data or {}).get("features") or []
    out = []
    for f in features:
        p = f.get("properties") or {}
        out.append({
            "id": f.get("id"),
            "event": p.get("event"),
            "headline": p.get("headline"),
            "description": p.get("description"),
            "instruction": p.get("instruction"),
            "severity": p.get("severity"),
            "urgency": p.get("urgency"),
            "certainty": p.get("certainty"),
            "areaDesc": p.get("areaDesc"),
            "sent": p.get("sent"),
            "effective": p.get("effective"),
            "ends": p.get("ends") or p.get("expires"),
            "senderName": p.get("senderName"),
        })
    return {"available": True, "alerts": out}


# ============================================================================
#                               CANADA ALERTS
# ============================================================================
@api.get("/canada/alerts")
async def canada_alerts(lat: float = Query(...), lon: float = Query(...), radius_km: float = Query(150)):
    """Pulls Canadian Meteorological Service active alerts via the public GeoMet WMS GetFeature
    around the requested point. Returns [] outside Canada or when the feed is unavailable.
    """
    bbox_lon = radius_km / 80.0  # rough degrees
    bbox_lat = radius_km / 110.0
    bbox = f"{lon - bbox_lon},{lat - bbox_lat},{lon + bbox_lon},{lat + bbox_lat}"
    url = (
        "https://geo.weather.gc.ca/geomet/features/collections/ALERTS/items?"
        f"f=json&bbox={bbox}&limit=50"
    )
    async with httpx.AsyncClient(timeout=15.0) as hc:
        try:
            r = await hc.get(url, headers={"User-Agent": USER_AGENT})
            if r.status_code >= 400:
                return {"available": False, "alerts": []}
            data = r.json()
        except Exception as e:  # noqa: BLE001
            logger.info("canada alerts failed: %s", e)
            return {"available": False, "alerts": []}
    feats = (data or {}).get("features") or []
    out = []
    for f in feats:
        p = f.get("properties") or {}
        out.append({
            "id": f.get("id") or p.get("identifier"),
            "event": p.get("headline") or p.get("alert_type"),
            "headline": p.get("headline"),
            "description": p.get("descrip_en") or p.get("description"),
            "severity": p.get("severity"),
            "urgency": p.get("urgency"),
            "areaDesc": p.get("area") or p.get("location"),
            "sent": p.get("sent") or p.get("effective"),
            "effective": p.get("effective"),
            "ends": p.get("expires"),
        })
    return {"available": True, "alerts": out}


# ============================================================================
#                                 USGS
# ============================================================================
@api.get("/usgs/earthquakes")
async def usgs_earthquakes(
    lat: Optional[float] = Query(None),
    lon: Optional[float] = Query(None),
    radius_miles: float = Query(2000.0),
    period: str = Query("day", regex="^(hour|day|week|month)$"),
    min_magnitude: float = Query(0.0),
):
    feed_map = {
        "hour": "all_hour",
        "day": "all_day",
        "week": "all_week",
        "month": "all_month",
    }
    feed = feed_map.get(period, "all_day")
    url = f"https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{feed}.geojson"
    async with httpx.AsyncClient(timeout=15.0) as hc:
        try:
            r = await hc.get(url, headers={"User-Agent": USER_AGENT})
            if r.status_code >= 400:
                return {"available": False, "events": []}
            data = r.json()
        except Exception as e:  # noqa: BLE001
            logger.info("usgs failed: %s", e)
            return {"available": False, "events": []}
    feats = (data or {}).get("features") or []
    out = []
    for f in feats:
        p = f.get("properties") or {}
        coords = (f.get("geometry") or {}).get("coordinates") or [None, None, None]
        e_lon, e_lat, e_depth = coords[0], coords[1], coords[2] if len(coords) > 2 else None
        mag = p.get("mag")
        if mag is None or mag < min_magnitude:
            continue
        distance = None
        if lat is not None and lon is not None and e_lat is not None and e_lon is not None:
            distance = haversine_miles(lat, lon, e_lat, e_lon)
            if distance > radius_miles:
                continue
        out.append({
            "id": f.get("id"),
            "magnitude": mag,
            "place": p.get("place"),
            "time": p.get("time"),
            "updated": p.get("updated"),
            "url": p.get("url"),
            "tsunami": bool(p.get("tsunami")),
            "alert": p.get("alert"),
            "depth_km": e_depth,
            "lat": e_lat,
            "lon": e_lon,
            "distance_miles": distance,
        })
    out.sort(key=lambda x: x.get("time") or 0, reverse=True)
    return {"available": True, "events": out}


@api.get("/usgs/tsunamis")
async def tsunami_bulletins():
    """Pull recent significant earthquakes flagged with tsunami=1 plus the PTWC bulletin
    title list via USGS feed.
    """
    url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson"
    async with httpx.AsyncClient(timeout=15.0) as hc:
        try:
            r = await hc.get(url, headers={"User-Agent": USER_AGENT})
            if r.status_code >= 400:
                return {"available": False, "bulletins": []}
            data = r.json()
        except Exception as e:  # noqa: BLE001
            logger.info("ptwc fetch failed: %s", e)
            return {"available": False, "bulletins": []}
    out = []
    for f in (data or {}).get("features") or []:
        p = f.get("properties") or {}
        if not p.get("tsunami"):
            continue
        out.append({
            "id": f.get("id"),
            "title": p.get("title"),
            "place": p.get("place"),
            "magnitude": p.get("mag"),
            "time": p.get("time"),
            "url": p.get("url"),
            "alert": p.get("alert"),
        })
    return {"available": True, "bulletins": out}


# ============================================================================
#                              NASA EONET
# ============================================================================
async def _eonet_events(category: str, days: int = 30) -> list:
    url = f"https://eonet.gsfc.nasa.gov/api/v3/events?category={category}&status=open&days={days}"
    async with httpx.AsyncClient(timeout=15.0) as hc:
        try:
            r = await hc.get(url, headers={"User-Agent": USER_AGENT})
            if r.status_code >= 400:
                return []
            data = r.json()
        except Exception as e:  # noqa: BLE001
            logger.info("eonet %s failed: %s", category, e)
            return []
    out = []
    for ev in (data or {}).get("events") or []:
        geoms = ev.get("geometry") or []
        last = geoms[-1] if geoms else {}
        coords = last.get("coordinates") or [None, None]
        out.append({
            "id": ev.get("id"),
            "title": ev.get("title"),
            "description": ev.get("description"),
            "categories": [c.get("title") for c in ev.get("categories") or []],
            "sources": [s.get("url") for s in ev.get("sources") or []],
            "lat": coords[1] if len(coords) > 1 else None,
            "lon": coords[0] if coords else None,
            "date": last.get("date"),
            "magnitudeValue": last.get("magnitudeValue"),
            "magnitudeUnit": last.get("magnitudeUnit"),
        })
    return out


@api.get("/eonet/cyclones")
async def eonet_cyclones():
    return {"available": True, "events": await _eonet_events("severeStorms", 30)}


@api.get("/eonet/wildfires")
async def eonet_wildfires():
    return {"available": True, "events": await _eonet_events("wildfires", 30)}


# ============================================================================
#                              DASHBOARD BUNDLE
# ============================================================================
@api.get("/dashboard")
async def dashboard(lat: float = Query(...), lon: float = Query(...)):
    """One-shot bundle for mobile home: current weather, NOAA alerts, nearby USGS, and
    the next 12 hourly periods. Each is best-effort; failures degrade gracefully.
    """
    current_t = weather_current(lat=lat, lon=lon)
    alerts_t = weather_alerts(lat=lat, lon=lon)
    canada_t = canada_alerts(lat=lat, lon=lon)
    usgs_t = usgs_earthquakes(lat=lat, lon=lon, radius_miles=300, period="day", min_magnitude=2.5)
    forecast_t = weather_forecast(lat=lat, lon=lon)

    current, alerts, canada, usgs, forecast = await asyncio.gather(
        current_t, alerts_t, canada_t, usgs_t, forecast_t, return_exceptions=True
    )

    def safe(v, default):
        if isinstance(v, Exception):
            return default
        return v

    return {
        "current": safe(current, {"available": False}),
        "alerts": safe(alerts, {"available": False, "alerts": []}),
        "canada_alerts": safe(canada, {"available": False, "alerts": []}),
        "usgs": safe(usgs, {"available": False, "events": []}),
        "forecast": safe(forecast, {"available": False, "periods": [], "hourly": []}),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


app.include_router(api)


@app.on_event("startup")
async def on_startup():
    await locations_col.create_index([("user_id", 1)])
    await locations_col.create_index([("user_id", 1), ("id", 1)], unique=True)
    logger.info("Root Record Weather Manager API ready.")

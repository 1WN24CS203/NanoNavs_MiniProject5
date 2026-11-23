"""
NanoNavs Road Intelligence — Universal Real-Time Backend Server

FastAPI + WebSockets + SQLite server providing:
- Real-time universal map synchronization for all mobile & desktop clients
- Worldwide routing (OSRM integration) & geocoding anywhere on Earth
- Live sensor telemetry processing with PhoneHandlingGuard
- Trip lifecycle management & Road Quality Scoring
- Crowdsourced verification and persistence
"""

import asyncio
import json
import math
import os
import socket
import sys
import time
import urllib.parse
from datetime import datetime
from typing import Dict, List, Optional, Set

import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# Ensure local imports work
sys.path.insert(0, os.path.dirname(__file__))

load_dotenv()
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

import database
from detector import AnomalyDetector
from models import (
    AccelerometerReading,
    AcousticReading,
    AnomalyType,
    DetectedAnomaly,
    GPSCoordinate,
    GyroscopeReading,
    IncidentReport,
    SensorFrame,
    SeverityLevel,
)
from report_generator import ReportGenerator
from sensor_data import generate_custom_route_data, haversine_distance_km

app = FastAPI(
    title="NanoNavs Universal Road Intelligence API",
    description="Real-time crowdsourced road surface monitoring and universal navigation engine",
    version="2.0.0",
)

# Enable CORS for cross-device mobile testing
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── WebSocket Connection Manager ─────────────────────────────────────────────

class ConnectionManager:
    """Manages active WebSocket connections and broadcasts universal road updates."""

    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.active_drivers: Dict[str, dict] = {}

    async def connect(self, client_id: str, websocket: WebSocket):
        await websocket.accept()
        self.active_connections[client_id] = websocket
        # Send initial welcome state
        await websocket.send_json({
            "type": "CONNECTION_ESTABLISHED",
            "client_id": client_id,
            "active_drivers_count": len(self.active_drivers),
            "timestamp": time.time(),
        })

    def disconnect(self, client_id: str):
        if client_id in self.active_connections:
            del self.active_connections[client_id]
        if client_id in self.active_drivers:
            del self.active_drivers[client_id]

    async def broadcast(self, message: dict):
        """Broadcast event to all connected clients."""
        disconnected = []
        for cid, ws in self.active_connections.items():
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.append(cid)
        for cid in disconnected:
            self.disconnect(cid)

    async def update_driver_location(self, client_id: str, data: dict):
        """Update a live vehicle location on the universal map."""
        driver_info = {
            "user_id": client_id,
            "name": data.get("name", f"Driver {client_id[:4]}"),
            "latitude": data.get("latitude"),
            "longitude": data.get("longitude"),
            "speed_kmh": data.get("speed_kmh", 0.0),
            "heading": data.get("heading", 0.0),
            "updated_at": time.time(),
        }
        self.active_drivers[client_id] = driver_info
        await self.broadcast({
            "type": "DRIVER_MOVED",
            "driver": driver_info,
            "active_drivers_count": len(self.active_drivers),
        })

    async def remove_driver(self, client_id: str):
        if client_id in self.active_drivers:
            del self.active_drivers[client_id]
            await self.broadcast({
                "type": "DRIVER_DISCONNECTED",
                "user_id": client_id,
                "active_drivers_count": len(self.active_drivers),
            })


manager = ConnectionManager()

# Active detector instances keyed by trip_id
trip_detectors: Dict[str, AnomalyDetector] = {}
trip_frames: Dict[str, List[SensorFrame]] = {}
trip_metadata: Dict[str, dict] = {}


# ── Utility: Get Local LAN IP ────────────────────────────────────────────────

def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# ── Pydantic Request Models ──────────────────────────────────────────────────

class StartTripRequest(BaseModel):
    trip_id: str
    user_id: str = "guest_driver"
    route_name: str = "Live Navigation Trip"
    start_lat: float
    start_lon: float
    end_lat: float
    end_lon: float


class FrameDataRequest(BaseModel):
    trip_id: str
    frame_id: Optional[str] = None
    timestamp: float
    latitude: float
    longitude: float
    altitude_m: Optional[float] = 0.0
    accel_x: float
    accel_y: float
    accel_z: float
    gyro_x: Optional[float] = 0.0
    gyro_y: Optional[float] = 0.0
    gyro_z: Optional[float] = 0.0
    speed_kmh: float = 0.0
    decibel_level: Optional[float] = 0.0
    dominant_frequency_hz: Optional[float] = 0.0


class EndTripRequest(BaseModel):
    trip_id: str
    user_id: Optional[str] = "guest_driver"
    route_name: Optional[str] = "Completed Trip"
    start_lat: Optional[float] = 0.0
    start_lon: Optional[float] = 0.0
    end_lat: Optional[float] = 0.0
    end_lon: Optional[float] = 0.0
    distance_km: Optional[float] = 0.0
    duration_sec: Optional[float] = 0.0
    detected_anomalies: Optional[List[dict]] = []


class ManualReportRequest(BaseModel):
    anomaly_type: str = "pothole"
    severity: str = "moderate"
    latitude: float
    longitude: float
    description: str = "Citizen reported road anomaly"
    address: Optional[str] = ""
    city: Optional[str] = "Bengaluru"


class ComplaintRequest(BaseModel):
    anomaly_id: str
    priority: Optional[str] = None
    department: Optional[str] = "Municipal Road Infrastructure / BBMP"


class SignupRequest(BaseModel):
    username: str
    email: str
    password: str
    full_name: str
    role: Optional[str] = "driver"


class LoginRequest(BaseModel):
    username_or_email: str
    password: str


class RedeemCouponRequest(BaseModel):
    coupon_id: str


def extract_current_user(request: Request) -> Optional[dict]:
    """Helper to authenticate requests using Bearer token or token query param."""
    auth = request.headers.get("Authorization", "")
    token = None
    if auth.startswith("Bearer "):
        token = auth[7:].strip()
    elif "token" in request.query_params:
        token = request.query_params["token"]
    if token:
        return database.get_user_by_token(token)
    return None


# ── REST Endpoints ───────────────────────────────────────────────────────────

# ── Authentication & Security Endpoints ─────────────────────────────────────

@app.post("/api/auth/signup")
async def auth_signup(req: SignupRequest):
    """Registers a new driver or civic officer account and returns session token."""
    user, err = database.create_user(
        username=req.username,
        email=req.email,
        password=req.password,
        full_name=req.full_name,
        role=req.role or "driver",
    )
    if err:
        raise HTTPException(status_code=400, detail=err)
    token = database.create_session(user["user_id"])
    return {"status": "ok", "token": token, "user": user}


@app.post("/api/auth/login")
async def auth_login(req: LoginRequest):
    """Authenticates credentials and returns user profile + session token."""
    user = database.authenticate_user(req.username_or_email, req.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid username/email or password")
    token = database.create_session(user["user_id"])
    return {"status": "ok", "token": token, "user": user}


@app.get("/api/auth/me")
async def auth_me(request: Request):
    """Returns profile for currently authenticated token."""
    user = extract_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required or session expired")
    return {"status": "ok", "user": user}


@app.post("/api/auth/logout")
async def auth_logout(request: Request):
    """Destroys active session token."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        database.delete_session(auth[7:].strip())
    return {"status": "ok", "message": "Logged out successfully"}


# ── Driver Rewards & Marketplace Endpoints ─────────────────────────────────

@app.get("/api/rewards/coupons")
async def list_rewards_coupons():
    """Lists all available discount coupons in the marketplace."""
    coupons = database.get_all_coupons()
    return {"count": len(coupons), "coupons": coupons}


@app.post("/api/rewards/redeem")
async def redeem_reward_coupon(req: RedeemCouponRequest, request: Request):
    """Redeems a coupon using driver's NanoPoints and generates a promo code."""
    user = extract_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required to redeem coupons")
    redeemed, err = database.redeem_coupon(user["user_id"], req.coupon_id)
    if err:
        raise HTTPException(status_code=400, detail=err)
    return {"status": "success", "redemption": redeemed}


@app.get("/api/rewards/my-coupons")
async def list_my_coupons(request: Request):
    """Retrieves list of active/redeemed coupons with voucher promo codes."""
    user = extract_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    my_coupons = database.get_user_coupons(user["user_id"])
    return {"count": len(my_coupons), "coupons": my_coupons}


@app.get("/api/drivers")
async def list_active_drivers():
    """Returns real-time fleet of active mobile phone drivers for universal map."""
    return {"count": len(manager.active_drivers), "drivers": list(manager.active_drivers.values())}

@app.get("/api/config")
async def get_config():
    """Returns local network server configuration and Gemini status."""
    local_ip = get_local_ip()
    gemini_key = os.getenv("GEMINI_API_KEY", "")
    return {
        "server_ip": local_ip,
        "port": 8000,
        "mobile_url": f"http://{local_ip}:8000",
        "ws_url": f"ws://{local_ip}:8000/ws",
        "gemini_configured": bool(gemini_key),
        "active_connections": len(manager.active_connections),
        "active_drivers": len(manager.active_drivers),
    }


@app.get("/api/stats")
async def get_universal_stats():
    """Returns global road intelligence statistics."""
    stats = database.get_stats()
    stats["active_drivers"] = len(manager.active_drivers)
    stats["active_connections"] = len(manager.active_connections)
    return stats


@app.get("/api/anomalies")
async def get_anomalies(
    min_lat: Optional[float] = None,
    max_lat: Optional[float] = None,
    min_lon: Optional[float] = None,
    max_lon: Optional[float] = None,
    type: Optional[str] = "all",
    severity: Optional[str] = "all",
    status: Optional[str] = "all",
    limit: int = 1000,
):
    """Retrieve crowdsourced anomalies with geographic or type filtering."""
    results = database.get_all_anomalies(
        min_lat=min_lat,
        max_lat=max_lat,
        min_lon=min_lon,
        max_lon=max_lon,
        anomaly_type=type,
        severity=severity,
        status=status,
        limit=limit,
    )
    return {"count": len(results), "anomalies": results}


@app.post("/api/anomalies/report")
async def report_manual_anomaly(req: ManualReportRequest):
    """Allows manual citizen or field verification of a road anomaly."""
    try:
        atype = AnomalyType(req.anomaly_type)
    except ValueError:
        atype = AnomalyType.POTHOLE

    try:
        slevel = SeverityLevel(req.severity)
    except ValueError:
        slevel = SeverityLevel.MODERATE

    anomaly = DetectedAnomaly(
        anomaly_type=atype,
        severity=slevel,
        confidence=0.85,
        location=GPSCoordinate(latitude=req.latitude, longitude=req.longitude),
        timestamp=time.time(),
        description=req.description,
        address=req.address or f"Coordinates ({req.latitude:.5f}, {req.longitude:.5f})",
        status="confirmed",
    )

    record, is_new = database.insert_or_update_anomaly(
        anomaly=anomaly,
        address=req.address or "",
        city=req.city or "",
    )

    # Broadcast to all universal map users immediately
    await manager.broadcast({
        "type": "ANOMALY_ALERT",
        "action": "new" if is_new else "verified",
        "anomaly": record,
    })

    return {"status": "ok", "is_new": is_new, "anomaly": record}


@app.post("/api/anomalies/{anomaly_id}/verify")
async def verify_anomaly_endpoint(anomaly_id: str):
    """Crowd-verify an existing anomaly."""
    res = database.verify_anomaly(anomaly_id)
    if not res:
        raise HTTPException(status_code=404, detail="Anomaly not found")
    await manager.broadcast({
        "type": "ANOMALY_VERIFIED",
        "anomaly_id": anomaly_id,
        "verified_count": res["verified_count"],
    })
    return res


@app.post("/api/anomalies/{anomaly_id}/resolve")
async def resolve_anomaly_endpoint(anomaly_id: str):
    """Mark an anomaly as repaired or resolved."""
    res = database.resolve_anomaly(anomaly_id)
    if not res:
        raise HTTPException(status_code=404, detail="Anomaly not found")
    await manager.broadcast({
        "type": "ANOMALY_RESOLVED",
        "anomaly_id": anomaly_id,
    })
    return res


# ── Municipal Civic Complaints & Work Orders ─────────────────────────────────

@app.get("/api/complaints")
async def list_complaints(status: Optional[str] = "all", limit: int = 100):
    """Retrieve all municipal civic complaint tickets generated by server."""
    complaints = database.get_all_complaints(status=status, limit=limit)
    return {"count": len(complaints), "complaints": complaints}


@app.post("/api/complaints/generate")
async def generate_complaint_endpoint(req: ComplaintRequest):
    """Generates an official civic complaint ticket for an anomaly."""
    res = database.create_complaint_from_anomaly(
        anomaly_id=req.anomaly_id,
        priority=req.priority,
        department=req.department or "Municipal Road Infrastructure / BBMP",
    )
    if not res:
        raise HTTPException(status_code=404, detail="Anomaly not found")
    await manager.broadcast({
        "type": "COMPLAINT_FILED",
        "ticket": res,
    })
    return res


@app.patch("/api/complaints/{complaint_id}")
async def update_complaint_status_endpoint(complaint_id: str, status: str = Query(...)):
    res = database.update_complaint_status(complaint_id, status)
    if not res:
        raise HTTPException(status_code=404, detail="Complaint ticket not found")
    return res


# ── Global Routing & Geocoding (Unrestricted anywhere on Earth) ──────────────

@app.get("/api/route")
async def compute_driving_route(
    start_lat: float = Query(...),
    start_lon: float = Query(...),
    end_lat: float = Query(...),
    end_lon: float = Query(...),
):
    """
    Computes a true driving route between ANY two coordinates on Earth using OSRM,
    with automatic fallbacks.
    """
    osrm_url = (
        f"https://router.project-osrm.org/route/v1/driving/"
        f"{start_lon},{start_lat};{end_lon},{end_lat}"
        f"?overview=full&geometries=geojson&steps=true"
    )

    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.get(osrm_url)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("routes"):
                    primary = data["routes"][0]
                    # GeoJSON is [lon, lat], convert to [lat, lon] for Leaflet
                    coords = [
                        [pt[1], pt[0]] for pt in primary["geometry"]["coordinates"]
                    ]
                    distance_km = primary["distance"] / 1000.0
                    duration_min = primary["duration"] / 60.0

                    return {
                        "status": "ok",
                        "distance_km": round(distance_km, 2),
                        "duration_min": round(duration_min, 1),
                        "coordinates": coords,
                        "source": "osrm",
                    }
    except Exception as e:
        pass

    # Fallback: Generate interpolated waypoints along Great Circle path
    dist_km = haversine_distance_km(start_lat, start_lon, end_lat, end_lon)
    num_pts = max(10, min(100, int(dist_km * 5)))
    coords = []
    for i in range(num_pts + 1):
        t = i / num_pts
        lat = start_lat + (end_lat - start_lat) * t
        lon = start_lon + (end_lon - start_lon) * t
        coords.append([round(lat, 6), round(lon, 6)])

    est_duration_min = (dist_km / 35.0) * 60.0
    return {
        "status": "ok",
        "distance_km": round(dist_km, 2),
        "duration_min": round(est_duration_min, 1),
        "coordinates": coords,
        "source": "interpolated",
    }


@app.get("/api/geocode")
async def geocode_query(q: str = Query(...)):
    """Search for any city, landmark, or street worldwide using OpenStreetMap Nominatim."""
    encoded_q = urllib.parse.quote(q)
    url = f"https://nominatim.openstreetmap.org/search?q={encoded_q}&format=json&limit=5&addressdetails=1"

    headers = {
        "User-Agent": "NanoNavs-Road-Intelligence/2.0 (contact: bmsce.ac.in)"
    }

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                results = []
                for item in data:
                    results.append({
                        "name": item.get("name") or item.get("display_name", "").split(",")[0],
                        "display_name": item.get("display_name"),
                        "latitude": float(item["lat"]),
                        "longitude": float(item["lon"]),
                    })
                return {"results": results}
    except Exception:
        pass

    # Local fallback for common locations
    sample_fallbacks = [
        {"name": "B.M.S. College of Engineering", "display_name": "BMSCE, Bull Temple Rd, Basavanagudi, Bengaluru", "latitude": 12.9412, "longitude": 77.5658},
        {"name": "Silk Board Junction", "display_name": "Silk Board Junction, Outer Ring Rd, Bengaluru", "latitude": 12.9173, "longitude": 77.6230},
        {"name": "Electronic City", "display_name": "Electronic City Phase 1, Bengaluru", "latitude": 12.8399, "longitude": 77.6770},
        {"name": "Koramangala", "display_name": "Koramangala 4th Block, Bengaluru", "latitude": 12.9352, "longitude": 77.6245},
        {"name": "Kempegowda Int'l Airport", "display_name": "BLR Airport, Devanahalli, Bengaluru", "latitude": 13.1986, "longitude": 77.7066},
    ]
    matched = [f for f in sample_fallbacks if q.lower() in f["display_name"].lower()]
    return {"results": matched or sample_fallbacks[:3]}


# ── Trip Lifecycle & Live Frame Telemetry Ingestion ───────────────────────────

@app.post("/api/trip/start")
async def start_trip(req: StartTripRequest):
    """
    Initializes a new trip session. Prepares the detector and notifies universal map.
    """
    trip_id = req.trip_id
    trip_detectors[trip_id] = AnomalyDetector(
        window_size=5,
        min_confidence=0.4,
        enable_acoustic=True,
        enable_handling_guard=True,
        min_speed_kmh=0.0,  # Allow stationary/simulator tests
    )
    trip_frames[trip_id] = []
    trip_metadata[trip_id] = {
        "trip_id": trip_id,
        "user_id": req.user_id,
        "route_name": req.route_name,
        "start_lat": req.start_lat,
        "start_lon": req.start_lon,
        "end_lat": req.end_lat,
        "end_lon": req.end_lon,
        "start_time": time.time(),
        "anomalies": [],
    }

    await manager.broadcast({
        "type": "TRIP_STARTED",
        "trip_id": trip_id,
        "route_name": req.route_name,
        "user_id": req.user_id,
        "start_coords": [req.start_lat, req.start_lon],
        "end_coords": [req.end_lat, req.end_lon],
    })

    return {"status": "started", "trip_id": trip_id}


@app.post("/api/trip/frame")
async def ingest_sensor_frame(req: FrameDataRequest):
    """
    Ingests high-rate real-time telemetry from phone. Runs PhoneHandlingGuard and AnomalyDetector.
    If an anomaly is detected, saves to DB and broadcasts alert in real-time to all clients.
    """
    trip_id = req.trip_id
    detector = trip_detectors.get(trip_id)
    if not detector:
        # Create ad-hoc detector if not explicitly started
        detector = AnomalyDetector(window_size=5, min_confidence=0.4, enable_handling_guard=True)
        trip_detectors[trip_id] = detector
        trip_frames[trip_id] = []
        trip_metadata[trip_id] = {"trip_id": trip_id, "anomalies": [], "start_time": time.time()}

    gps = GPSCoordinate(
        latitude=req.latitude,
        longitude=req.longitude,
        altitude_m=req.altitude_m or 0.0,
    )
    accel = AccelerometerReading(
        x=req.accel_x,
        y=req.accel_y,
        z=req.accel_z,
        timestamp=req.timestamp,
    )
    acoustic = None
    if req.decibel_level and req.decibel_level > 0:
        acoustic = AcousticReading(
            decibel_level=req.decibel_level,
            dominant_frequency_hz=req.dominant_frequency_hz or 100.0,
            timestamp=req.timestamp,
        )
    gyro = None
    if req.gyro_x or req.gyro_y or req.gyro_z:
        gyro = GyroscopeReading(
            x=req.gyro_x or 0.0,
            y=req.gyro_y or 0.0,
            z=req.gyro_z or 0.0,
            timestamp=req.timestamp,
        )

    frame = SensorFrame(
        frame_id=req.frame_id or f"F-{int(req.timestamp * 1000) % 1000000}",
        timestamp=req.timestamp,
        gps=gps,
        accelerometer=accel,
        acoustic=acoustic,
        gyroscope=gyro,
        vehicle_speed_kmh=req.speed_kmh,
    )

    trip_frames[trip_id].append(frame)

    detection = detector.process_frame(frame)
    if detection:
        trip_metadata[trip_id]["anomalies"].append(detection)

        # Save to SQLite
        record, is_new = database.insert_or_update_anomaly(
            anomaly=detection,
            trip_id=trip_id,
        )

        # Broadcast live anomaly alert to universal map
        await manager.broadcast({
            "type": "ANOMALY_ALERT",
            "action": "new" if is_new else "verified",
            "trip_id": trip_id,
            "anomaly": record,
        })

        return {
            "detected": True,
            "anomaly": record,
            "is_new": is_new,
        }

    return {"detected": False}


@app.post("/api/trip/end")
async def end_trip(req: EndTripRequest):
    """
    Concludes a trip session, calculates Road Quality Score (0-100),
    generates incident narrative, persists record, and broadcasts completion.
    """
    trip_id = req.trip_id
    frames = trip_frames.get(trip_id, [])
    meta = trip_metadata.get(trip_id, {})
    detected = meta.get("anomalies", [])

    # If frontend provided additional detections (e.g., from web worker)
    if req.detected_anomalies:
        for da_dict in req.detected_anomalies:
            try:
                da = DetectedAnomaly.from_dict(da_dict)
                detected.append(da)
                database.insert_or_update_anomaly(da, trip_id=trip_id)
            except Exception:
                pass

    distance_km = req.distance_km or 0.0
    if distance_km <= 0.0 and meta.get("start_lat") and meta.get("end_lat"):
        distance_km = haversine_distance_km(
            meta["start_lat"], meta["start_lon"],
            meta["end_lat"], meta["end_lon"],
        )

    duration_sec = req.duration_sec or (time.time() - meta.get("start_time", time.time()))

    # Generate incident report and quality score
    generator = ReportGenerator()
    report = generator.generate(
        anomalies=detected,
        route_name=req.route_name or meta.get("route_name", "Live Navigation Trip"),
        total_distance_km=max(0.1, distance_km),
        total_frames=max(len(frames), 1),
    )

    # Save trip to SQLite
    saved_trip = database.save_trip(
        trip_id=trip_id,
        user_id=req.user_id or meta.get("user_id", "guest_driver"),
        route_name=report.route_name,
        start_lat=req.start_lat or meta.get("start_lat", 0.0),
        start_lon=req.start_lon or meta.get("start_lon", 0.0),
        end_lat=req.end_lat or meta.get("end_lat", 0.0),
        end_lon=req.end_lon or meta.get("end_lon", 0.0),
        distance_km=distance_km,
        duration_sec=duration_sec,
        frames_count=len(frames),
        anomaly_count=len(detected),
        road_quality_score=report.road_quality_score,
        summary=report.summary,
        ai_narrative=report.ai_narrative,
    )

    # Clean up session memory
    trip_detectors.pop(trip_id, None)
    trip_frames.pop(trip_id, None)
    trip_metadata.pop(trip_id, None)

    # Award driver reward points (10 pts per km + 25 pts per confirmed anomaly)
    user_id = req.user_id or meta.get("user_id", "guest_driver")
    points_earned = max(10, int(distance_km * 10) + (len(detected) * 25))
    new_points_balance = None
    if user_id and user_id != "guest_driver":
        new_points_balance = database.award_user_points(user_id, points_earned, f"Trip {trip_id}")

    # Broadcast trip end
    await manager.broadcast({
        "type": "TRIP_ENDED",
        "trip_id": trip_id,
        "road_quality_score": report.road_quality_score,
        "anomaly_count": len(detected),
        "distance_km": round(distance_km, 2),
    })

    return {
        "status": "completed",
        "report": report.to_dict(),
        "saved_trip": saved_trip,
        "points_earned": points_earned,
        "new_points_balance": new_points_balance,
    }


@app.get("/api/trips")
async def list_trips(limit: int = 50):
    return {"trips": database.get_all_trips(limit=limit)}


@app.get("/api/trips/{trip_id}")
async def get_trip_details(trip_id: str):
    trip = database.get_trip(trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    return trip


# ── Simulation Endpoint (for any arbitrary coordinates worldwide) ────────────

class SimulateTripRequest(BaseModel):
    start_lat: float
    start_lon: float
    end_lat: float
    end_lon: float
    route_name: Optional[str] = "Simulated Drive"
    num_frames: Optional[int] = 120
    anomaly_density: Optional[float] = 0.08
    speed_kmh: Optional[float] = 40.0
    waypoints: Optional[List[List[float]]] = None


@app.post("/api/simulate")
async def run_simulation(req: SimulateTripRequest):
    """
    Simulates a vehicle driving along any route anywhere in the world,
    generating realistic multi-sensor telemetry, detecting anomalies, and saving results.
    """
    wps = [(p[0], p[1]) for p in req.waypoints] if req.waypoints else None
    frames, metadata = generate_custom_route_data(
        start_coord=(req.start_lat, req.start_lon),
        end_coord=(req.end_lat, req.end_lon),
        route_name=req.route_name or "Custom Drive",
        num_frames=req.num_frames or 120,
        anomaly_density=req.anomaly_density or 0.08,
        base_speed_kmh=req.speed_kmh or 40.0,
        waypoints=wps,
    )

    detector = AnomalyDetector(window_size=5, min_confidence=0.4, enable_acoustic=True)
    detections = detector.process_batch(frames)

    # Save to SQLite & broadcast
    saved_anomalies = []
    for d in detections:
        rec, is_new = database.insert_or_update_anomaly(d)
        saved_anomalies.append(rec)
        await manager.broadcast({
            "type": "ANOMALY_ALERT",
            "action": "new" if is_new else "verified",
            "anomaly": rec,
        })

    generator = ReportGenerator()
    report = generator.generate(
        anomalies=detections,
        route_name=req.route_name or "Simulated Drive",
        total_distance_km=metadata["distance_km"],
        total_frames=len(frames),
    )

    trip_id = f"SIM-{int(time.time() * 1000) % 1000000}"
    saved_trip = database.save_trip(
        trip_id=trip_id,
        user_id="simulator",
        route_name=report.route_name,
        start_lat=req.start_lat,
        start_lon=req.start_lon,
        end_lat=req.end_lat,
        end_lon=req.end_lon,
        distance_km=metadata["distance_km"],
        duration_sec=len(frames) * 0.1,
        frames_count=len(frames),
        anomaly_count=len(detections),
        road_quality_score=report.road_quality_score,
        summary=report.summary,
        ai_narrative=report.ai_narrative,
    )

    return {
        "status": "completed",
        "trip_id": trip_id,
        "metadata": metadata,
        "detections_count": len(detections),
        "detections": saved_anomalies,
        "road_quality_score": report.road_quality_score,
        "report": report.to_dict(),
        "frames_summary": [
            {
                "frame_id": f.frame_id,
                "lat": f.gps.latitude,
                "lon": f.gps.longitude,
                "z_g": f.accelerometer.z,
                "speed": f.vehicle_speed_kmh,
            }
            for f in frames[::5]  # Subsample for lightweight UI playback
        ],
    }


# ── Real-Time WebSocket Endpoint ─────────────────────────────────────────────

@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await manager.connect(client_id, websocket)
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "DRIVER_LOCATION":
                await manager.update_driver_location(client_id, data)
            elif msg_type == "PING":
                await websocket.send_json({"type": "PONG", "timestamp": time.time()})
            elif msg_type == "MANUAL_ALERT":
                # User tapped quick anomaly report
                lat = data.get("latitude")
                lon = data.get("longitude")
                if lat and lon:
                    anom = DetectedAnomaly(
                        anomaly_type=AnomalyType.POTHOLE,
                        severity=SeverityLevel.HIGH,
                        confidence=0.9,
                        location=GPSCoordinate(latitude=lat, longitude=lon),
                        timestamp=time.time(),
                        description="Quick-reported pothole from mobile driver",
                    )
                    rec, is_new = database.insert_or_update_anomaly(anom)
                    await manager.broadcast({
                        "type": "ANOMALY_ALERT",
                        "action": "new" if is_new else "verified",
                        "anomaly": rec,
                    })

    except WebSocketDisconnect:
        manager.disconnect(client_id)
        await manager.remove_driver(client_id)
    except Exception:
        manager.disconnect(client_id)
        await manager.remove_driver(client_id)


# ── Static File Mount for Mobile PWA ─────────────────────────────────────────

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/")
    async def serve_index():
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))

    @app.get("/mobile")
    async def serve_mobile():
        mobile_file = os.path.join(STATIC_DIR, "mobile.html")
        if os.path.exists(mobile_file):
            return FileResponse(mobile_file)
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))

    @app.get("/manifest.json")
    async def serve_manifest():
        return FileResponse(
            os.path.join(STATIC_DIR, "manifest.json"),
            media_type="application/manifest+json",
        )

    @app.get("/sw.js")
    async def serve_sw():
        return FileResponse(
            os.path.join(STATIC_DIR, "sw.js"),
            media_type="application/javascript",
        )

    @app.get("/favicon.ico")
    async def serve_favicon():
        from fastapi.responses import Response
        return Response(status_code=204)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    host = "0.0.0.0"
    local_ip = get_local_ip()
    print("=" * 70)
    print("🚀 NanoNavs Universal Road Intelligence Server Starting")
    print(f"📡 Desktop / Local URL:  http://localhost:{port}")
    print(f"📱 Mobile Phone URL:     http://{local_ip}:{port}")
    print(f"🗺️ Universal Live Map:   http://{local_ip}:{port}/")
    print(f"⚡ WebSocket Live Hub:   ws://{local_ip}:{port}/ws")
    print("=" * 70)
    uvicorn.run("server:app", host=host, port=port, reload=False)


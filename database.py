"""
NanoNavs Road Intelligence — Universal Database Module

Provides thread-safe SQLite persistence for:
- Crowdsourced road anomalies worldwide (potholes, speed bumps, cracks, depressions, debris)
- Trip history with road quality scores and Gemini AI incident summaries
- Real-time deduplication and crowd verification (merging duplicate reports within 20m)
"""

import json
import math
import os
import sqlite3
import time
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from models import AnomalyType, DetectedAnomaly, GPSCoordinate, IncidentReport, SeverityLevel

DB_PATH = os.path.join(os.path.dirname(__file__), "nanonavs.db")


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Initialize database tables and seed baseline anomalies if empty."""
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS anomalies (
        anomaly_id TEXT PRIMARY KEY,
        anomaly_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        confidence REAL NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        altitude_m REAL DEFAULT 0,
        peak_vertical_g REAL DEFAULT 0,
        peak_acoustic_db REAL DEFAULT 0,
        vehicle_speed_kmh REAL DEFAULT 0,
        timestamp REAL NOT NULL,
        description TEXT,
        address TEXT,
        city TEXT,
        verified_count INTEGER DEFAULT 1,
        status TEXT DEFAULT 'confirmed',
        trip_id TEXT,
        created_at TEXT NOT NULL
    );
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS trips (
        trip_id TEXT PRIMARY KEY,
        user_id TEXT,
        route_name TEXT,
        start_lat REAL,
        start_lon REAL,
        end_lat REAL,
        end_lon REAL,
        distance_km REAL,
        duration_sec REAL,
        frames_count INTEGER,
        anomaly_count INTEGER,
        road_quality_score REAL,
        summary TEXT,
        ai_narrative TEXT,
        created_at TEXT NOT NULL
    );
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS complaints (
        complaint_id TEXT PRIMARY KEY,
        anomaly_id TEXT,
        ticket_number TEXT UNIQUE NOT NULL,
        priority TEXT NOT NULL,
        defect_type TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        address TEXT,
        city TEXT,
        department TEXT DEFAULT 'Municipal Road Infrastructure / BBMP',
        description TEXT,
        ai_narrative TEXT,
        status TEXT DEFAULT 'Submitted',
        created_at TEXT NOT NULL
    );
    """)

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_anomaly_coords ON anomalies(latitude, longitude);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_anomaly_type ON anomalies(anomaly_type);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_anomaly_status ON anomalies(status);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_complaint_status ON complaints(status);")

    conn.commit()

    # Seed if anomalies table is empty
    cursor.execute("SELECT COUNT(*) as count FROM anomalies;")
    count = cursor.fetchone()["count"]
    if count == 0:
        seed_baseline_anomalies(cursor)
        conn.commit()

    # Seed if complaints table is empty
    cursor.execute("SELECT COUNT(*) as count FROM complaints;")
    complaint_count = cursor.fetchone()["count"]
    if complaint_count == 0:
        seed_baseline_complaints(cursor)
        conn.commit()

    conn.close()


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance in meters between two lat/lon coordinates."""
    r = 6371000.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def insert_or_update_anomaly(
    anomaly: DetectedAnomaly,
    trip_id: str = "",
    address: str = "",
    city: str = "",
) -> Tuple[dict, bool]:
    """
    Inserts a detected anomaly into the universal database or increments verification
    count if an existing anomaly of the same type is within 25 meters (crowdsourced verification).

    Returns:
        (anomaly_dict, is_new_entry)
    """
    conn = get_db_connection()
    cursor = conn.cursor()

    lat = anomaly.location.latitude if anomaly.location else 0.0
    lon = anomaly.location.longitude if anomaly.location else 0.0

    # Search nearby anomalies within approx 0.0005 deg (~50m bounding box)
    bbox = 0.0005
    cursor.execute(
        """
        SELECT * FROM anomalies
        WHERE latitude BETWEEN ? AND ?
          AND longitude BETWEEN ? AND ?
          AND anomaly_type = ?
          AND status != 'resolved'
        """,
        (lat - bbox, lat + bbox, lon - bbox, lon + bbox, anomaly.anomaly_type.value),
    )
    nearby = cursor.fetchall()

    for row in nearby:
        dist = haversine_m(lat, lon, row["latitude"], row["longitude"])
        if dist <= 25.0:  # Within 25 meters: crowd-verified match!
            new_count = row["verified_count"] + 1
            new_conf = min(0.99, row["confidence"] + 0.05)
            new_peak_g = max(row["peak_vertical_g"], anomaly.peak_vertical_g)
            cursor.execute(
                """
                UPDATE anomalies
                SET verified_count = ?, confidence = ?, peak_vertical_g = ?, status = 'verified'
                WHERE anomaly_id = ?
                """,
                (new_count, new_conf, new_peak_g, row["anomaly_id"]),
            )
            conn.commit()
            updated_row = dict(row)
            updated_row["verified_count"] = new_count
            updated_row["confidence"] = new_conf
            updated_row["status"] = "verified"
            conn.close()
            return updated_row, False

    # Insert brand new anomaly
    now_str = datetime.now().isoformat()
    cursor.execute(
        """
        INSERT INTO anomalies (
            anomaly_id, anomaly_type, severity, confidence,
            latitude, longitude, altitude_m, peak_vertical_g,
            peak_acoustic_db, vehicle_speed_kmh, timestamp,
            description, address, city, verified_count, status,
            trip_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            anomaly.anomaly_id,
            anomaly.anomaly_type.value,
            anomaly.severity.value,
            anomaly.confidence,
            lat,
            lon,
            anomaly.location.altitude_m if anomaly.location else 0.0,
            anomaly.peak_vertical_g,
            anomaly.peak_acoustic_db,
            anomaly.vehicle_speed_kmh,
            anomaly.timestamp or time.time(),
            anomaly.description,
            address or anomaly.address or "Road surface",
            city or "Bengaluru",
            anomaly.verified_count or 1,
            anomaly.status or "confirmed",
            trip_id,
            now_str,
        ),
    )
    conn.commit()

    cursor.execute("SELECT * FROM anomalies WHERE anomaly_id = ?", (anomaly.anomaly_id,))
    new_record = dict(cursor.fetchone())
    conn.close()
    return new_record, True


def verify_anomaly(anomaly_id: str) -> Optional[dict]:
    """Manually or sensor upvote an anomaly as verified by another user."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE anomalies SET verified_count = verified_count + 1, status = 'verified' WHERE anomaly_id = ?",
        (anomaly_id,),
    )
    conn.commit()
    cursor.execute("SELECT * FROM anomalies WHERE anomaly_id = ?", (anomaly_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def resolve_anomaly(anomaly_id: str) -> Optional[dict]:
    """Mark an anomaly as repaired/resolved by municipal authority or citizen."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE anomalies SET status = 'resolved' WHERE anomaly_id = ?",
        (anomaly_id,),
    )
    conn.commit()
    cursor.execute("SELECT * FROM anomalies WHERE anomaly_id = ?", (anomaly_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def get_all_anomalies(
    min_lat: Optional[float] = None,
    max_lat: Optional[float] = None,
    min_lon: Optional[float] = None,
    max_lon: Optional[float] = None,
    anomaly_type: Optional[str] = None,
    severity: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 1000,
) -> List[dict]:
    """Retrieve anomalies with optional bounding box and attribute filtering."""
    conn = get_db_connection()
    cursor = conn.cursor()

    query = "SELECT * FROM anomalies WHERE 1=1"
    params = []

    if min_lat is not None and max_lat is not None:
        query += " AND latitude BETWEEN ? AND ?"
        params.extend([min_lat, max_lat])

    if min_lon is not None and max_lon is not None:
        query += " AND longitude BETWEEN ? AND ?"
        params.extend([min_lon, max_lon])

    if anomaly_type and anomaly_type != "all":
        query += " AND anomaly_type = ?"
        params.append(anomaly_type)

    if severity and severity != "all":
        query += " AND severity = ?"
        params.append(severity)

    if status and status != "all":
        query += " AND status = ?"
        params.append(status)

    query += " ORDER BY timestamp DESC LIMIT ?"
    params.append(limit)

    cursor.execute(query, tuple(params))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def save_trip(
    trip_id: str,
    user_id: str,
    route_name: str,
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
    distance_km: float,
    duration_sec: float,
    frames_count: int,
    anomaly_count: int,
    road_quality_score: float,
    summary: str,
    ai_narrative: str = "",
) -> dict:
    """Save completed trip record to database."""
    conn = get_db_connection()
    cursor = conn.cursor()
    now_str = datetime.now().isoformat()

    cursor.execute(
        """
        INSERT OR REPLACE INTO trips (
            trip_id, user_id, route_name, start_lat, start_lon,
            end_lat, end_lon, distance_km, duration_sec, frames_count,
            anomaly_count, road_quality_score, summary, ai_narrative, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            trip_id,
            user_id,
            route_name,
            start_lat,
            start_lon,
            end_lat,
            end_lon,
            round(distance_km, 2),
            round(duration_sec, 1),
            frames_count,
            anomaly_count,
            round(road_quality_score, 1),
            summary,
            ai_narrative,
            now_str,
        ),
    )
    conn.commit()
    cursor.execute("SELECT * FROM trips WHERE trip_id = ?", (trip_id,))
    row = dict(cursor.fetchone())
    conn.close()
    return row


def get_all_trips(limit: int = 50) -> List[dict]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM trips ORDER BY created_at DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def get_trip(trip_id: str) -> Optional[dict]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM trips WHERE trip_id = ?", (trip_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


# ── Municipal Civic Complaints Module (Server-Side) ──────────────────────────

def create_complaint_from_anomaly(
    anomaly_id: str,
    priority: Optional[str] = None,
    department: str = "Municipal Road Infrastructure / BBMP",
    custom_narrative: str = "",
) -> Optional[dict]:
    """
    Server-side generation of an official civic complaint ticket for municipal public works.
    Converts raw anomaly detections into actionable work orders.
    """
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM anomalies WHERE anomaly_id = ?", (anomaly_id,))
    anom = cursor.fetchone()
    if not anom:
        conn.close()
        return None

    # Check if a complaint already exists for this anomaly
    cursor.execute("SELECT * FROM complaints WHERE anomaly_id = ?", (anomaly_id,))
    existing = cursor.fetchone()
    if existing:
        conn.close()
        return dict(existing)

    complaint_id = f"CMP-{anom['anomaly_id']}"
    now_year = datetime.now().year
    ticket_number = f"BBMP-RD-{now_year}-{anom['anomaly_id']}"

    # Priority mapping
    if not priority:
        if anom["severity"] == "critical":
            priority = "P1 - Immediate Hazard"
        elif anom["severity"] == "high":
            priority = "P2 - High Priority"
        else:
            priority = "P3 - Routine Maintenance"

    narrative = custom_narrative or (
        f"Automated civic complaint: {anom['anomaly_type'].upper()} detected on {anom['address'] or 'road segment'}. "
        f"Recorded peak vertical impact: {anom['peak_vertical_g']:.2f}g at {anom['vehicle_speed_kmh']:.0f} km/h. "
        f"Verified by {anom['verified_count']} independent vehicles. Dispatched for immediate municipal surface repair."
    )

    now_str = datetime.now().isoformat()
    cursor.execute(
        """
        INSERT INTO complaints (
            complaint_id, anomaly_id, ticket_number, priority, defect_type,
            latitude, longitude, address, city, department, description,
            ai_narrative, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?)
        """,
        (
            complaint_id,
            anom["anomaly_id"],
            ticket_number,
            priority,
            anom["anomaly_type"],
            anom["latitude"],
            anom["longitude"],
            anom["address"] or "Road Surface",
            anom["city"] or "Bengaluru",
            department,
            anom["description"] or f"{anom['anomaly_type']} surface defect",
            narrative,
            now_str,
        ),
    )
    conn.commit()

    cursor.execute("SELECT * FROM complaints WHERE complaint_id = ?", (complaint_id,))
    record = dict(cursor.fetchone())
    conn.close()
    return record


def get_all_complaints(status: Optional[str] = None, limit: int = 100) -> List[dict]:
    conn = get_db_connection()
    cursor = conn.cursor()
    query = "SELECT * FROM complaints"
    params = []
    if status and status != "all":
        query += " WHERE status = ?"
        params.append(status)
    query += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    cursor.execute(query, tuple(params))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def update_complaint_status(complaint_id: str, new_status: str) -> Optional[dict]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE complaints SET status = ? WHERE complaint_id = ?", (new_status, complaint_id))
    conn.commit()
    cursor.execute("SELECT * FROM complaints WHERE complaint_id = ?", (complaint_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def get_stats() -> dict:
    """Calculates universal dashboard stats."""
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT COUNT(*) as total FROM anomalies;")
    total_anomalies = cursor.fetchone()["total"]

    cursor.execute("SELECT COUNT(*) as total, SUM(distance_km) as km, AVG(road_quality_score) as avg_score FROM trips;")
    trip_row = cursor.fetchone()
    total_trips = trip_row["total"] or 0
    total_km = trip_row["km"] or 0.0
    avg_score = trip_row["avg_score"] or 82.5

    cursor.execute("SELECT severity, COUNT(*) as count FROM anomalies GROUP BY severity;")
    severity_counts = {r["severity"]: r["count"] for r in cursor.fetchall()}

    cursor.execute("SELECT anomaly_type, COUNT(*) as count FROM anomalies GROUP BY anomaly_type;")
    type_counts = {r["anomaly_type"]: r["count"] for r in cursor.fetchall()}

    conn.close()

    return {
        "total_anomalies": total_anomalies,
        "total_trips": total_trips,
        "total_km_scanned": round(total_km, 1),
        "average_road_quality": round(avg_score, 1),
        "severity_distribution": severity_counts,
        "type_distribution": type_counts,
    }


def seed_baseline_anomalies(cursor: sqlite3.Cursor):
    """Seed initial realistic anomalies in Bengaluru and major world road corridors."""
    now = time.time()
    now_str = datetime.now().isoformat()

    sample_anomalies = [
        # Bengaluru hotspots
        ("ANM-BLR-001", "pothole", "critical", 0.94, 12.9178, 77.6235, 910.0, 1.85, 92.0, 42.0, "Deep crater pothole near Silk Board Junction (Hosur Rd)", "Silk Board Junction, Outer Ring Road", "Bengaluru", 14),
        ("ANM-BLR-002", "speed_bump", "moderate", 0.88, 12.9234, 77.6310, 915.0, 1.45, 68.0, 32.0, "Unmarked speed bump near HSR Sector 2 entrance", "14th Main Rd, HSR Layout", "Bengaluru", 9),
        ("ANM-BLR-003", "pothole", "high", 0.91, 12.9348, 77.6189, 922.0, 1.62, 88.0, 38.0, "Edge pothole on 80ft Road Koramangala near 4th Block", "80 Feet Rd, Koramangala 4th Block", "Bengaluru", 11),
        ("ANM-BLR-004", "crack", "low", 0.72, 12.8452, 77.6712, 905.0, 1.22, 62.0, 55.0, "Longitudinal surface crack across flyover ramp", "Electronic City Phase 1 Elevated Tollway", "Bengaluru", 4),
        ("ANM-BLR-005", "surface_depression", "moderate", 0.82, 12.9567, 77.7011, 918.0, 1.38, 66.0, 35.0, "Asphalt depression near Marathahalli Bridge bus bay", "HAL Old Airport Rd, Marathahalli", "Bengaluru", 7),
        ("ANM-BLR-006", "pothole", "critical", 0.96, 12.9412, 77.5658, 930.0, 1.92, 94.0, 36.0, "Large jagged pothole near BMS College of Engineering (Bull Temple Rd)", "Bull Temple Rd, Basavanagudi", "Bengaluru", 23),
        ("ANM-BLR-007", "speed_bump", "moderate", 0.85, 12.9388, 77.5699, 928.0, 1.40, 70.0, 28.0, "Pedestrian speed table near Gandhi Bazaar main circle", "Gandhi Bazaar Main Rd, Basavanagudi", "Bengaluru", 8),
        ("ANM-BLR-008", "debris", "moderate", 0.79, 13.0372, 77.5965, 912.0, 1.32, 78.0, 60.0, "Construction gravel spill on shoulder of Bellary Road", "Bellary Rd, Hebbal Flyover approach", "Bengaluru", 5),
        ("ANM-BLR-009", "pothole", "high", 0.89, 12.9782, 77.6405, 918.0, 1.58, 85.0, 40.0, "Sunken sewer manhole pothole on 100ft Road", "100 Feet Rd, Indiranagar", "Bengaluru", 12),
        ("ANM-BLR-010", "crack", "moderate", 0.76, 13.1950, 77.7050, 920.0, 1.28, 64.0, 75.0, "Expansion joint crack on highway lane 2", "NH-44 Airport Expressway, Devanahalli", "Bengaluru", 6),

        # Mumbai
        ("ANM-MUM-001", "pothole", "critical", 0.95, 19.0760, 72.8777, 14.0, 1.88, 91.0, 45.0, "Water-filled monsoon pothole on Western Express Highway", "WEH, Bandra East", "Mumbai", 18),
        ("ANM-MUM-002", "speed_bump", "moderate", 0.84, 19.1136, 72.8697, 18.0, 1.42, 69.0, 30.0, "Rumble strips before JVLR flyover", "Jogeshwari-Vikhroli Link Rd", "Mumbai", 7),

        # Delhi NCR
        ("ANM-DEL-001", "pothole", "high", 0.89, 28.6139, 77.2090, 215.0, 1.64, 87.0, 50.0, "Asphalt erosion crater on Ring Road near Ashram", "Ring Road, Ashram Chowk", "New Delhi", 15),

        # New York
        ("ANM-NYC-001", "pothole", "critical", 0.93, 40.7128, -74.0060, 10.0, 1.82, 89.0, 40.0, "Winter freeze-thaw pothole near Broadway & Fulton St", "Broadway, Lower Manhattan", "New York", 16),

        # London
        ("ANM-LON-001", "surface_depression", "moderate", 0.83, 51.5074, -0.1278, 22.0, 1.35, 65.0, 32.0, "Bus lane surface rutting near Waterloo Bridge", "Waterloo Bridge S Approach", "London", 9),

        # Tokyo
        ("ANM-TYO-001", "crack", "low", 0.74, 35.6762, 139.6503, 40.0, 1.18, 60.0, 50.0, "Minor seismic hairline crack on Shuto Expressway", "Shuto Expressway Route 3", "Tokyo", 4),
    ]

    for item in sample_anomalies:
        cursor.execute(
            """
            INSERT OR IGNORE INTO anomalies (
                anomaly_id, anomaly_type, severity, confidence,
                latitude, longitude, altitude_m, peak_vertical_g,
                peak_acoustic_db, vehicle_speed_kmh, description,
                address, city, verified_count, status, timestamp, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)
            """,
            (
                item[0], item[1], item[2], item[3], item[4], item[5],
                item[6], item[7], item[8], item[9], item[10], item[11],
                item[12], item[13], now - (14 - item[13]) * 3600, now_str,
            ),
        )


def seed_baseline_complaints(cursor: sqlite3.Cursor):
    """Seed sample civic work order tickets for immediate display."""
    now_str = datetime.now().isoformat()
    samples = [
        (
            "CMP-BBMP-2026-001",
            "ANM-BLR-001",
            "BBMP-RD-2026-104",
            "critical",
            "pothole",
            12.9178,
            77.6235,
            "Silk Board Junction, Outer Ring Road",
            "Bengaluru",
            "BBMP Road Infrastructure (South Zone)",
            "High impact pothole (1.85g) causing severe vehicular deceleration and accident risk.",
            "Verified by 14 crowdsourced sensor units. Immediate asphalt hot-mix patching mandated.",
            "In Progress",
            now_str,
        ),
        (
            "CMP-BBMP-2026-002",
            "ANM-BLR-006",
            "BBMP-RD-2026-105",
            "critical",
            "pothole",
            12.9412,
            77.5658,
            "Bull Temple Rd, Basavanagudi",
            "Bengaluru",
            "BBMP Ward 154 - Basavanagudi",
            "Deep jagged pothole (1.92g) near BMS College of Engineering front entrance.",
            "Multiple student and public commuter reports logged. High priority repair ticket dispatched.",
            "Submitted",
            now_str,
        ),
        (
            "CMP-BBMP-2026-003",
            "ANM-BLR-002",
            "BBMP-RD-2026-098",
            "moderate",
            "speed_bump",
            12.9234,
            77.6310,
            "14th Main Rd, HSR Layout",
            "Bengaluru",
            "BBMP Traffic Engineering Cell",
            "Unmarked speed table lacking retro-reflective white thermoplastic striping.",
            "Nighttime visibility hazard. Work order dispatched for paint marking.",
            "Resolved",
            now_str,
        ),
    ]

    for c in samples:
        cursor.execute(
            """
            INSERT OR IGNORE INTO complaints (
                complaint_id, anomaly_id, ticket_number, priority,
                defect_type, latitude, longitude, address, city,
                department, description, ai_narrative, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            c,
        )


# Run initialization on import
init_db()

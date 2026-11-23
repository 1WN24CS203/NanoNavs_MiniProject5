"""
NanoNavs Road Intelligence — Sensor Data Models

Defines the core data structures for road sensor telemetry,
detected anomalies, and generated incident reports.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional
import uuid


class AnomalyType(Enum):
    """Classification of road surface anomalies."""
    POTHOLE = "pothole"
    SPEED_BUMP = "speed_bump"
    CRACK = "crack"
    SURFACE_DEPRESSION = "surface_depression"
    MANHOLE_COVER = "manhole_cover"
    ROAD_JOINT = "road_joint"
    DEBRIS = "debris"
    UNKNOWN = "unknown"


class SeverityLevel(Enum):
    """Risk severity classification for detected anomalies."""
    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class GPSCoordinate:
    """Geographic position with precision metadata."""
    latitude: float
    longitude: float
    altitude_m: float = 0.0
    hdop: float = 1.0  # Horizontal dilution of precision

    def to_dict(self) -> dict:
        return {
            "latitude": round(self.latitude, 6),
            "longitude": round(self.longitude, 6),
            "altitude_m": round(self.altitude_m, 2),
            "hdop": self.hdop,
        }

    def __str__(self) -> str:
        return f"({self.latitude:.6f}, {self.longitude:.6f})"


@dataclass
class AccelerometerReading:
    """Three-axis accelerometer sample from a vehicle-mounted sensor."""
    x: float  # Lateral acceleration (g)
    y: float  # Longitudinal acceleration (g)
    z: float  # Vertical acceleration (g)
    timestamp: float  # Unix epoch seconds

    @property
    def vertical_magnitude(self) -> float:
        """Absolute deviation from 1g on the Z-axis (road impact indicator)."""
        return abs(self.z - 1.0)

    @property
    def total_magnitude(self) -> float:
        """Total acceleration magnitude."""
        return (self.x ** 2 + self.y ** 2 + self.z ** 2) ** 0.5

    def to_dict(self) -> dict:
        return {
            "x": round(self.x, 4),
            "y": round(self.y, 4),
            "z": round(self.z, 4),
            "timestamp": self.timestamp,
            "vertical_magnitude": round(self.vertical_magnitude, 4),
        }


@dataclass
class AcousticReading:
    """Microphone-based road noise measurement."""
    decibel_level: float  # dB SPL
    dominant_frequency_hz: float  # Hz
    timestamp: float

    def to_dict(self) -> dict:
        return {
            "decibel_level": round(self.decibel_level, 1),
            "dominant_frequency_hz": round(self.dominant_frequency_hz, 1),
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "AcousticReading":
        return cls(
            decibel_level=float(data.get("decibel_level", 0.0)),
            dominant_frequency_hz=float(data.get("dominant_frequency_hz", 0.0)),
            timestamp=float(data.get("timestamp", 0.0)),
        )


@dataclass
class GyroscopeReading:
    """Three-axis gyroscope sample from smartphone (rad/s or deg/s)."""
    x: float  # Pitch rate
    y: float  # Roll rate
    z: float  # Yaw rate
    timestamp: float

    @property
    def angular_speed(self) -> float:
        """Total angular velocity magnitude."""
        return (self.x ** 2 + self.y ** 2 + self.z ** 2) ** 0.5

    def to_dict(self) -> dict:
        return {
            "x": round(self.x, 4),
            "y": round(self.y, 4),
            "z": round(self.z, 4),
            "angular_speed": round(self.angular_speed, 4),
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "GyroscopeReading":
        return cls(
            x=float(data.get("x", 0.0)),
            y=float(data.get("y", 0.0)),
            z=float(data.get("z", 0.0)),
            timestamp=float(data.get("timestamp", 0.0)),
        )


@dataclass
class SensorFrame:
    """A single time-synchronised frame of all sensor inputs."""
    frame_id: str
    timestamp: float
    gps: GPSCoordinate
    accelerometer: AccelerometerReading
    acoustic: Optional[AcousticReading] = None
    gyroscope: Optional[GyroscopeReading] = None
    vehicle_speed_kmh: float = 0.0

    def to_dict(self) -> dict:
        result = {
            "frame_id": self.frame_id,
            "timestamp": self.timestamp,
            "gps": self.gps.to_dict(),
            "accelerometer": self.accelerometer.to_dict(),
            "vehicle_speed_kmh": round(self.vehicle_speed_kmh, 1),
        }
        if self.acoustic:
            result["acoustic"] = self.acoustic.to_dict()
        if self.gyroscope:
            result["gyroscope"] = self.gyroscope.to_dict()
        return result

    @classmethod
    def from_dict(cls, data: dict) -> "SensorFrame":
        gps_data = data.get("gps", {})
        gps = GPSCoordinate(
            latitude=float(gps_data.get("latitude", 0.0)),
            longitude=float(gps_data.get("longitude", 0.0)),
            altitude_m=float(gps_data.get("altitude_m", 0.0)),
            hdop=float(gps_data.get("hdop", 1.0)),
        )
        acc_data = data.get("accelerometer", {})
        accel = AccelerometerReading(
            x=float(acc_data.get("x", 0.0)),
            y=float(acc_data.get("y", 0.0)),
            z=float(acc_data.get("z", 1.0)),
            timestamp=float(acc_data.get("timestamp", data.get("timestamp", 0.0))),
        )
        acoustic = None
        if "acoustic" in data and data["acoustic"]:
            acoustic = AcousticReading.from_dict(data["acoustic"])
        gyro = None
        if "gyroscope" in data and data["gyroscope"]:
            gyro = GyroscopeReading.from_dict(data["gyroscope"])

        return cls(
            frame_id=str(data.get("frame_id", uuid.uuid4().hex[:8])),
            timestamp=float(data.get("timestamp", 0.0)),
            gps=gps,
            accelerometer=accel,
            acoustic=acoustic,
            gyroscope=gyro,
            vehicle_speed_kmh=float(data.get("vehicle_speed_kmh", 0.0)),
        )


@dataclass
class DetectedAnomaly:
    """A confirmed road anomaly detection with classification and evidence."""
    anomaly_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    anomaly_type: AnomalyType = AnomalyType.UNKNOWN
    severity: SeverityLevel = SeverityLevel.LOW
    confidence: float = 0.0  # 0.0 to 1.0
    location: Optional[GPSCoordinate] = None
    timestamp: float = 0.0
    peak_vertical_g: float = 0.0
    peak_acoustic_db: float = 0.0
    vehicle_speed_kmh: float = 0.0
    evidence_frames: list = field(default_factory=list)
    description: str = ""
    address: str = ""
    verified_count: int = 1
    status: str = "confirmed"  # candidate, provisional, confirmed, resolved

    def to_dict(self) -> dict:
        return {
            "anomaly_id": self.anomaly_id,
            "anomaly_type": self.anomaly_type.value,
            "severity": self.severity.value,
            "confidence": round(self.confidence, 3),
            "location": self.location.to_dict() if self.location else None,
            "timestamp": self.timestamp,
            "peak_vertical_g": round(self.peak_vertical_g, 4),
            "peak_acoustic_db": round(self.peak_acoustic_db, 1),
            "vehicle_speed_kmh": round(self.vehicle_speed_kmh, 1),
            "description": self.description,
            "address": self.address,
            "verified_count": self.verified_count,
            "status": self.status,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "DetectedAnomaly":
        loc_data = data.get("location")
        location = None
        if loc_data:
            location = GPSCoordinate(
                latitude=float(loc_data.get("latitude", 0.0)),
                longitude=float(loc_data.get("longitude", 0.0)),
                altitude_m=float(loc_data.get("altitude_m", 0.0)),
                hdop=float(loc_data.get("hdop", 1.0)),
            )
        
        # Parse anomaly type
        atype_str = data.get("anomaly_type", "unknown")
        try:
            atype = AnomalyType(atype_str)
        except ValueError:
            atype = AnomalyType.UNKNOWN

        # Parse severity
        sev_str = data.get("severity", "low")
        try:
            severity = SeverityLevel(sev_str)
        except ValueError:
            severity = SeverityLevel.LOW

        return cls(
            anomaly_id=str(data.get("anomaly_id", uuid.uuid4().hex[:8])),
            anomaly_type=atype,
            severity=severity,
            confidence=float(data.get("confidence", 0.5)),
            location=location,
            timestamp=float(data.get("timestamp", 0.0)),
            peak_vertical_g=float(data.get("peak_vertical_g", 0.0)),
            peak_acoustic_db=float(data.get("peak_acoustic_db", 0.0)),
            vehicle_speed_kmh=float(data.get("vehicle_speed_kmh", 0.0)),
            evidence_frames=data.get("evidence_frames", []),
            description=data.get("description", ""),
            address=data.get("address", ""),
            verified_count=int(data.get("verified_count", 1)),
            status=str(data.get("status", "confirmed")),
        )


@dataclass
class IncidentReport:
    """A complete incident report aggregating detected anomalies on a route."""
    report_id: str = field(default_factory=lambda: f"RPT-{uuid.uuid4().hex[:8].upper()}")
    generated_at: str = field(default_factory=lambda: datetime.now().isoformat())
    route_name: str = ""
    total_distance_km: float = 0.0
    total_frames_analysed: int = 0
    anomalies: list = field(default_factory=list)
    road_quality_score: float = 100.0  # 0-100, higher is better
    summary: str = ""
    ai_narrative: str = ""  # Optional Gemini-enhanced narrative

    def to_dict(self) -> dict:
        return {
            "report_id": self.report_id,
            "generated_at": self.generated_at,
            "route_name": self.route_name,
            "total_distance_km": round(self.total_distance_km, 2),
            "total_frames_analysed": self.total_frames_analysed,
            "anomaly_count": len(self.anomalies),
            "anomalies": [a.to_dict() for a in self.anomalies],
            "road_quality_score": round(self.road_quality_score, 1),
            "summary": self.summary,
            "ai_narrative": self.ai_narrative,
        }

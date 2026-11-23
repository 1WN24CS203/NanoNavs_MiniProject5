"""
NanoNavs Road Intelligence — Anomaly Detector

Deterministic signal-processing engine that analyses accelerometer and
acoustic sensor streams to detect and classify road surface anomalies.

This module uses threshold-based detection with sliding-window analysis.
No machine-learning model or external API is required at this layer.
"""

import math
import statistics
from typing import List, Optional

from models import (
    AccelerometerReading,
    AcousticReading,
    AnomalyType,
    DetectedAnomaly,
    GPSCoordinate,
    SensorFrame,
    SeverityLevel,
)


# ── Detection thresholds (empirically calibrated) ────────────────────────────

# Vertical G-force thresholds for anomaly classification
THRESHOLD_POTHOLE_G = 0.45        # Strong downward jolt
THRESHOLD_SPEED_BUMP_G = 0.30     # Moderate sustained bump
THRESHOLD_CRACK_G = 0.15          # Minor surface irregularity
THRESHOLD_NOISE_FLOOR_G = 0.08    # Below this, considered smooth road

# Acoustic thresholds
THRESHOLD_IMPACT_DB = 78.0        # Loud impact noise
THRESHOLD_RUMBLE_DB = 65.0        # Low-frequency rumble

# Classification frequency bands (Hz)
FREQ_POTHOLE_LOW = 20.0
FREQ_POTHOLE_HIGH = 80.0
FREQ_CRACK_LOW = 100.0
FREQ_CRACK_HIGH = 300.0
FREQ_DEBRIS_LOW = 500.0

# Speed-based sensitivity adjustment
SPEED_AMPLIFICATION_FACTOR = 0.02  # Per km/h above 30

# Phone-Handling Guard threshold (angular velocity from Review 2 Slide 11)
THRESHOLD_PHONE_HANDLING_OMEGA = 2.5  # rad/s sudden rotation indicates handling


class AnomalyDetector:
    """
    Deterministic road anomaly detector using multi-sensor fusion.

    Processes a stream of SensorFrames and returns classified DetectedAnomaly
    objects with severity ratings and confidence scores.
    """

    def __init__(
        self,
        window_size: int = 5,
        min_confidence: float = 0.4,
        enable_acoustic: bool = True,
        enable_handling_guard: bool = True,
        min_speed_kmh: float = 0.0,
    ):
        """
        Args:
            window_size: Number of frames in the sliding analysis window.
            min_confidence: Minimum confidence score to emit a detection.
            enable_acoustic: Whether to use acoustic data for fusion.
            enable_handling_guard: Whether to reject false spikes from phone movements.
            min_speed_kmh: Minimum vehicle speed required for valid road events.
        """
        self.window_size = window_size
        self.min_confidence = min_confidence
        self.enable_acoustic = enable_acoustic
        self.enable_handling_guard = enable_handling_guard
        self.min_speed_kmh = min_speed_kmh
        self._window: List[SensorFrame] = []
        self._detections: List[DetectedAnomaly] = []
        self._cooldown_frames = 0

    def process_frame(self, frame: SensorFrame) -> Optional[DetectedAnomaly]:
        """
        Process a single sensor frame through the detection pipeline.

        Returns a DetectedAnomaly if one is found, or None.
        """
        self._window.append(frame)
        if len(self._window) > self.window_size:
            self._window.pop(0)

        # Cooldown prevents double-triggering on the same physical event
        if self._cooldown_frames > 0:
            self._cooldown_frames -= 1
            return None

        if len(self._window) < 3:
            return None

        detection = self._analyse_window(frame)
        if detection and detection.confidence >= self.min_confidence:
            self._detections.append(detection)
            self._cooldown_frames = 2  # Skip next 2 frames
            return detection

        return None

    def process_batch(self, frames: List[SensorFrame]) -> List[DetectedAnomaly]:
        """Process a batch of frames and return all detections."""
        results = []
        for frame in frames:
            detection = self.process_frame(frame)
            if detection:
                results.append(detection)
        return results

    def reset(self):
        """Clear the detector state for a new route."""
        self._window.clear()
        self._detections.clear()
        self._cooldown_frames = 0

    def _analyse_window(self, current_frame: SensorFrame) -> Optional[DetectedAnomaly]:
        """
        Run multi-sensor analysis on the current sliding window using the exact
        Review 2 Slide 13 Confidence Scoring & Hard Rejection Gates formulation:

        C = G × (w_acc·s_acc + w_gyro·s_gyro + w_ctx·s_ctx + w_sens·s_sens + w_gps·s_gps + w_agree·s_agree)
        where G = 1 only if every hard gate passes, otherwise 0.
        """
        # ── Hard Rejection Gates (Review 2 Slide 13: G = 1 or 0) ─────────────
        # Gate 1: Saturated or NaN readings
        if (
            current_frame.timestamp <= 0
            or math.isnan(current_frame.accelerometer.z)
            or abs(current_frame.accelerometer.z) > 10.0
        ):
            return None

        # Gate 2: Vehicle Motion Assessment (Review 2 Slide 10)
        if current_frame.vehicle_speed_kmh < self.min_speed_kmh:
            return None

        # Gate 3: Phone-Handling Guard (Review 2 Slide 11)
        if self.enable_handling_guard and current_frame.gyroscope:
            if current_frame.gyroscope.angular_speed >= THRESHOLD_PHONE_HANDLING_OMEGA:
                # Discard sudden orientation or rotation spikes from user handling
                return None

        # Gate 4: GPS Quality (hdop must not exceed hard limit)
        if current_frame.gps and current_frame.gps.hdop > 15.0:
            return None

        G = 1.0  # All hard gates passed

        accel = current_frame.accelerometer
        v_mag = accel.vertical_magnitude

        # Compute window statistics for baseline comparison
        window_z_values = [f.accelerometer.z for f in self._window]
        baseline_std = statistics.stdev(window_z_values) if len(window_z_values) > 1 else 0.0

        # Speed-adjusted sensitivity
        speed_factor = 1.0
        if current_frame.vehicle_speed_kmh > 30:
            speed_factor = 1.0 + (current_frame.vehicle_speed_kmh - 30) * SPEED_AMPLIFICATION_FACTOR

        adjusted_v_mag = v_mag * speed_factor

        # ── Primary classification candidate via accelerometer ───────────────
        anomaly_type = AnomalyType.UNKNOWN

        if adjusted_v_mag >= THRESHOLD_POTHOLE_G:
            anomaly_type = AnomalyType.POTHOLE
        elif adjusted_v_mag >= THRESHOLD_SPEED_BUMP_G:
            if self._is_symmetric_bump():
                anomaly_type = AnomalyType.SPEED_BUMP
            else:
                anomaly_type = AnomalyType.SURFACE_DEPRESSION
        elif adjusted_v_mag >= THRESHOLD_CRACK_G:
            anomaly_type = AnomalyType.CRACK
        else:
            return None  # Below noise floor

        # ── Evidence Factor Calculation (Review 2 Slide 13: each s ∈ [0, 1]) ──
        # 1. s_acc: Acceleration evidence (peak, energy against baseline)
        if anomaly_type == AnomalyType.POTHOLE:
            s_acc = min(1.0, 0.65 + (adjusted_v_mag - THRESHOLD_POTHOLE_G) * 1.2)
        elif anomaly_type in (AnomalyType.SPEED_BUMP, AnomalyType.SURFACE_DEPRESSION):
            s_acc = min(0.92, 0.55 + (adjusted_v_mag - THRESHOLD_SPEED_BUMP_G) * 1.5)
        else:
            s_acc = min(0.85, 0.45 + (adjusted_v_mag - THRESHOLD_CRACK_G) * 1.5)

        # 2. s_gyro: Rotation consistent with road surface profile
        s_gyro = 0.65
        if current_frame.gyroscope:
            omega = current_frame.gyroscope.angular_speed
            if 0.05 <= omega <= 1.8:
                s_gyro = 0.88  # Road surface pitch/roll
            elif omega < 0.05:
                s_gyro = 0.55  # Mild vibration
            else:
                s_gyro = 0.30  # High rotation approaching handling

        # 3. s_ctx: Sustained vehicle-motion context
        if current_frame.vehicle_speed_kmh > 0:
            s_ctx = min(1.0, max(0.4, current_frame.vehicle_speed_kmh / 45.0))
        else:
            s_ctx = 0.55

        # 4. s_sens: Sensor quality, continuity, absence of clipping
        s_sens = 0.90 if baseline_std < 0.5 else 0.72

        # 5. s_gps: GPS accuracy quality
        if current_frame.gps:
            s_gps = min(1.0, max(0.4, 1.0 / max(0.6, current_frame.gps.hdop)))
        else:
            s_gps = 0.5

        # 6. s_agree: Acoustic agreement or spatial corroboration
        acoustic_boost = 0.0
        if self.enable_acoustic and current_frame.acoustic:
            acoustic_boost = self._acoustic_classification(
                current_frame.acoustic, anomaly_type
            )
        s_agree = min(1.0, 0.50 + acoustic_boost * 2.5)

        # ── Slide 13 Proposed Weights: Σ w = 1.0 ─────────────────────────────
        W_ACC = 0.35
        W_GYRO = 0.15
        W_CTX = 0.15
        W_SENS = 0.10
        W_GPS = 0.10
        W_AGREE = 0.15

        # Slide 13 Formula: C = G × Σ (w_i · s_i)
        confidence = G * (
            W_ACC * s_acc
            + W_GYRO * s_gyro
            + W_CTX * s_ctx
            + W_SENS * s_sens
            + W_GPS * s_gps
            + W_AGREE * s_agree
        )
        final_confidence = min(round(confidence, 3), 0.99)

        # ── Lifecycle Status (Review 2 Slide 13 & 15) ────────────────────────
        # C < 0.45: Uncertain, 0.45 <= C < 0.70: Provisional, C >= 0.70: Corroborated
        if final_confidence >= 0.70:
            lifecycle_status = "corroborated"
        elif final_confidence >= 0.45:
            lifecycle_status = "provisional"
        else:
            lifecycle_status = "uncertain"

        # ── Severity classification ───────────────────────────────────────
        severity = self._classify_severity(anomaly_type, adjusted_v_mag, final_confidence)

        # ── Build detection ───────────────────────────────────────────────
        detection = DetectedAnomaly(
            anomaly_type=anomaly_type,
            severity=severity,
            confidence=final_confidence,
            location=current_frame.gps,
            timestamp=current_frame.timestamp,
            peak_vertical_g=adjusted_v_mag,
            peak_acoustic_db=(
                current_frame.acoustic.decibel_level if current_frame.acoustic else 0.0
            ),
            vehicle_speed_kmh=current_frame.vehicle_speed_kmh,
            evidence_frames=[f.frame_id for f in self._window],
            description=self._generate_description(anomaly_type, severity, adjusted_v_mag),
            status=lifecycle_status,
        )

        return detection

    def _is_symmetric_bump(self) -> bool:
        """Check if the Z-axis profile is symmetric (characteristic of speed bumps)."""
        if len(self._window) < 3:
            return False

        z_values = [f.accelerometer.z for f in self._window]
        mid = len(z_values) // 2

        # Speed bump: rises then falls symmetrically
        first_half = z_values[:mid]
        second_half = z_values[mid + 1:]

        if not first_half or not second_half:
            return False

        rising = all(
            first_half[i] <= first_half[i + 1]
            for i in range(len(first_half) - 1)
        ) if len(first_half) > 1 else True
        falling = all(
            second_half[i] >= second_half[i + 1]
            for i in range(len(second_half) - 1)
        ) if len(second_half) > 1 else True

        return rising and falling

    def _acoustic_classification(
        self, acoustic: AcousticReading, primary_type: AnomalyType
    ) -> float:
        """Calculate confidence boost from acoustic data corroboration."""
        boost = 0.0
        freq = acoustic.dominant_frequency_hz
        db = acoustic.decibel_level

        if primary_type == AnomalyType.POTHOLE:
            # Potholes produce low-frequency thuds
            if FREQ_POTHOLE_LOW <= freq <= FREQ_POTHOLE_HIGH and db >= THRESHOLD_IMPACT_DB:
                boost = 0.15
            elif db >= THRESHOLD_IMPACT_DB:
                boost = 0.08
        elif primary_type == AnomalyType.CRACK:
            # Cracks produce mid-frequency buzzing
            if FREQ_CRACK_LOW <= freq <= FREQ_CRACK_HIGH and db >= THRESHOLD_RUMBLE_DB:
                boost = 0.10
        elif primary_type in (AnomalyType.SPEED_BUMP, AnomalyType.SURFACE_DEPRESSION):
            # Speed bumps produce sustained low rumble
            if freq <= FREQ_POTHOLE_HIGH and db >= THRESHOLD_RUMBLE_DB:
                boost = 0.12
        elif db >= THRESHOLD_IMPACT_DB and freq >= FREQ_DEBRIS_LOW:
            # High-frequency impact suggests debris
            boost = 0.10

        return boost

    def _classify_severity(
        self, anomaly_type: AnomalyType, v_mag: float, confidence: float
    ) -> SeverityLevel:
        """Determine severity level from anomaly type, magnitude, and confidence."""
        if anomaly_type == AnomalyType.POTHOLE:
            if v_mag >= 0.8 and confidence >= 0.8:
                return SeverityLevel.CRITICAL
            elif v_mag >= 0.6:
                return SeverityLevel.HIGH
            else:
                return SeverityLevel.MODERATE
        elif anomaly_type in (AnomalyType.SPEED_BUMP, AnomalyType.SURFACE_DEPRESSION):
            if v_mag >= 0.5:
                return SeverityLevel.MODERATE
            else:
                return SeverityLevel.LOW
        elif anomaly_type == AnomalyType.CRACK:
            if v_mag >= 0.3:
                return SeverityLevel.MODERATE
            else:
                return SeverityLevel.LOW
        else:
            return SeverityLevel.LOW

    @staticmethod
    def _generate_description(
        anomaly_type: AnomalyType, severity: SeverityLevel, v_mag: float
    ) -> str:
        """Generate a human-readable description of the detected anomaly."""
        descriptions = {
            AnomalyType.POTHOLE: f"Pothole detected with {v_mag:.2f}g vertical impact",
            AnomalyType.SPEED_BUMP: f"Speed bump identified with {v_mag:.2f}g displacement",
            AnomalyType.CRACK: f"Road surface crack detected ({v_mag:.2f}g vibration)",
            AnomalyType.SURFACE_DEPRESSION: f"Surface depression found ({v_mag:.2f}g sag)",
            AnomalyType.MANHOLE_COVER: f"Manhole cover impact ({v_mag:.2f}g jolt)",
            AnomalyType.ROAD_JOINT: f"Road joint expansion gap ({v_mag:.2f}g bump)",
            AnomalyType.DEBRIS: f"Road debris impact detected ({v_mag:.2f}g)",
            AnomalyType.UNKNOWN: f"Unclassified road irregularity ({v_mag:.2f}g)",
        }
        base = descriptions.get(anomaly_type, f"Anomaly ({v_mag:.2f}g)")
        return f"[{severity.value.upper()}] {base}"

/**
 * NanoNavs Road Intelligence — Dedicated Background Sensor Web Worker
 *
 * Runs high-rate accelerometer, gyroscope, and GPS frame processing in a separate OS thread.
 * Ensures sensor sampling, gravity filtering, and Phone-Handling Guard execution never stall
 * or drop samples due to UI re-rendering or user background interactions.
 */

const THRESHOLD_POTHOLE_G = 0.45;
const THRESHOLD_SPEED_BUMP_G = 0.30;
const THRESHOLD_CRACK_G = 0.15;
const THRESHOLD_PHONE_HANDLING_OMEGA = 2.5; // rad/s (~143 deg/s)

let windowBuffer = [];
let windowSize = 5;
let cooldownFrames = 0;
let enableHandlingGuard = true;

self.onmessage = function (e) {
  const { type, payload } = e.data;

  if (type === 'CONFIG') {
    if (payload.windowSize) windowSize = payload.windowSize;
    if (payload.enableHandlingGuard !== undefined) enableHandlingGuard = payload.enableHandlingGuard;
    if (payload.reset) {
      windowBuffer = [];
      cooldownFrames = 0;
    }
  } else if (type === 'PROCESS_FRAME') {
    const frame = payload;
    processSensorFrame(frame);
  }
};

function processSensorFrame(frame) {
  windowBuffer.push(frame);
  if (windowBuffer.length > windowSize) {
    windowBuffer.shift();
  }

  // Manage detection cooldown
  if (cooldownFrames > 0) {
    cooldownFrames--;
    return;
  }

  if (windowBuffer.length < 3) return;

  // 1. Phone-Handling Guard (Review 2 Slide 11)
  const gyro = frame.gyroscope;
  if (enableHandlingGuard && gyro) {
    const angularSpeed = Math.sqrt(gyro.x * gyro.x + gyro.y * gyro.y + gyro.z * gyro.z);
    if (angularSpeed >= THRESHOLD_PHONE_HANDLING_OMEGA) {
      self.postMessage({
        type: 'PHONE_HANDLING_DETECTED',
        payload: { angularSpeed, timestamp: frame.timestamp }
      });
      return; // Reject window as phone handling
    }
  }

  // 2. Vertical G deviation from 1.0g gravity
  const accel = frame.accelerometer;
  const vMag = Math.abs(accel.z - 1.0);

  // Speed-adjusted sensitivity factor
  let speedFactor = 1.0;
  if (frame.speed_kmh > 30) {
    speedFactor = 1.0 + (frame.speed_kmh - 30) * 0.02;
  }
  const adjustedVMag = vMag * speedFactor;

  let anomalyType = null;
  let baseConfidence = 0.0;

  if (adjustedVMag >= THRESHOLD_POTHOLE_G) {
    anomalyType = 'pothole';
    baseConfidence = Math.min(0.6 + (adjustedVMag - THRESHOLD_POTHOLE_G) * 1.5, 0.95);
  } else if (adjustedVMag >= THRESHOLD_SPEED_BUMP_G) {
    anomalyType = isSymmetricBump() ? 'speed_bump' : 'surface_depression';
    baseConfidence = Math.min(0.5 + (adjustedVMag - THRESHOLD_SPEED_BUMP_G) * 2.0, 0.90);
  } else if (adjustedVMag >= THRESHOLD_CRACK_G) {
    anomalyType = 'crack';
    baseConfidence = Math.min(0.4 + (adjustedVMag - THRESHOLD_CRACK_G) * 1.8, 0.80);
  }

  if (anomalyType && baseConfidence >= 0.4) {
    // Determine severity
    let severity = 'low';
    if (anomalyType === 'pothole') {
      if (adjustedVMag >= 0.8 && baseConfidence >= 0.75) severity = 'critical';
      else if (adjustedVMag >= 0.6) severity = 'high';
      else severity = 'moderate';
    } else if (adjustedVMag >= 0.5) {
      severity = 'moderate';
    }

    const anomaly = {
      anomaly_id: 'W-' + Math.random().toString(16).substring(2, 10),
      anomaly_type: anomalyType,
      severity: severity,
      confidence: Math.round(baseConfidence * 100) / 100,
      latitude: frame.gps.latitude,
      longitude: frame.gps.longitude,
      altitude_m: frame.gps.altitude_m || 0,
      peak_vertical_g: Math.round(adjustedVMag * 1000) / 1000,
      peak_acoustic_db: frame.acoustic ? frame.acoustic.decibel_level : 0,
      vehicle_speed_kmh: Math.round(frame.speed_kmh || 0),
      timestamp: frame.timestamp,
      description: `[${severity.toUpperCase()}] ${anomalyType.replace('_', ' ')} detected (${adjustedVMag.toFixed(2)}g)`
    };

    cooldownFrames = 3; // Prevent duplicate hits for 3 frames

    self.postMessage({
      type: 'ANOMALY_DETECTED',
      payload: anomaly
    });
  }
}

function isSymmetricBump() {
  if (windowBuffer.length < 3) return false;
  const zValues = windowBuffer.map(f => f.accelerometer.z);
  const mid = Math.floor(zValues.length / 2);
  const firstHalf = zValues.slice(0, mid);
  const secondHalf = zValues.slice(mid + 1);
  if (!firstHalf.length || !secondHalf.length) return false;

  let rising = true;
  for (let i = 0; i < firstHalf.length - 1; i++) {
    if (firstHalf[i] > firstHalf[i + 1]) { rising = false; break; }
  }
  let falling = true;
  for (let i = 0; i < secondHalf.length - 1; i++) {
    if (secondHalf[i] < secondHalf[i + 1]) { falling = false; break; }
  }
  return rising && falling;
}


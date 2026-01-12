// ECG vertical scaling (physiologic)
const MM_PER_MV = 10;
const PX_PER_MM_Y = 4; // 10 mm = 1 mV on standard ECG paper
const MV_TO_PX = MM_PER_MV * PX_PER_MM_Y;

// Physiologic amplitudes
const AMP_P_MV = 0.15;
const AMP_QRS_MV = 1.0;
const AMP_T_MV = 0.4;

const AMP_P_PX = AMP_P_MV * MV_TO_PX;
const AMP_QRS_PX = AMP_QRS_MV * MV_TO_PX;
const AMP_T_PX = AMP_T_MV * MV_TO_PX;

// Physiologic-ish QT limits
const QT_MIN_MS = 300;
const QT_MAX_MS = 600;

class EcgSimulator {
  constructor(backgroundCanvas, traceCanvas, overlayCanvasOrConfig = null, maybeConfig) {
    this.backgroundCanvas = backgroundCanvas;
    this.traceCanvas = traceCanvas;
    this.backgroundCtx = backgroundCanvas.getContext('2d');
    this.traceCtx = traceCanvas.getContext('2d');

    let overlayCanvas = null;
    let config = maybeConfig;

    if (overlayCanvasOrConfig && typeof overlayCanvasOrConfig.getContext === 'function') {
      overlayCanvas = overlayCanvasOrConfig;
    } else {
      config = overlayCanvasOrConfig || maybeConfig || {};
    }

    if (!config) config = {};

    this.overlayCanvas = overlayCanvas || null;
    this.overlayCtx = this.overlayCanvas ? this.overlayCanvas.getContext('2d') : null;
    this.scrollContainer = this.overlayCanvas ? this.overlayCanvas.parentElement : null;

    this.pixelPerMm = PX_PER_MM_Y;
    this.viewScale = 1.5;
    this.sampleIntervalMs = 6;

    this.config = {
      displayTime: config.displayTime || 10,
      heartRate: config.heartRate || 75,
      speed: config.speed || 25, // fixed at 25 mm/s
      autoplay: config.autoplay !== undefined ? config.autoplay : true
    };

    this.highlights = { P: false, QRS: false, T: false };
    this.intervalHighlights = { PR: false, QRSd: false, QT: false };
    const globalIntervalDebug =
      typeof window !== 'undefined' ? window.__ECG_INTERVAL_DEBUG : false;
    this.intervalDebug = globalIntervalDebug === true || globalIntervalDebug === 'true';
    this._intervalDebugTimestamps = {};
    this.isPlaying = false;
    this.simulatedTimeMs = 0;
    this.lastFrameTime = 0;

    // Beat + sweep state
    this.beatDurationMs = 60000 / this.config.heartRate;
    this.beatSamples = [];
    this.sweepStartTime = 0; // where the current left-edge sweep window begins

    // Physiologic intervals (ms) and durations (ms)
    this.intervals = {
      prIntervalMs: 160,
      qrsDurationMs: 90,
      qtIntervalMs: 400,
      pWaveDurationMs: 90,
      tWaveDurationMs: 180
    };
    this.currentRhythm = 'sinus';
    this.beatSchedule = [];
    this.atrialSchedule = [];
    this.rhythmDurationMs = 8000;
    this.waveAmpsPx = {
      p: AMP_P_PX,
      q: -AMP_QRS_PX * 0.25,
      r: AMP_QRS_PX,
      s: -AMP_QRS_PX * 0.35,
      t: AMP_T_PX
    };

    this.handleResize = this.handleResize.bind(this);
    this.tick = this.tick.bind(this);

    this.handleResize();
    window.addEventListener('resize', this.handleResize);

    this.regenerateRhythm();
    this.drawGrid();
    this.reset();
    if (this.config.autoplay) {
      this.play();
    }
  }

  // ---------------------------
  // CONFIG / CONTROL METHODS
  // ---------------------------

  setHeartRate(bpm) {
    this.config.heartRate = bpm;
    this.regenerateRhythm();
    this.sweepStartTime = this.simulatedTimeMs;
  }

  setPRIntervalMs(ms) {
    this.intervals.prIntervalMs = Math.min(Math.max(ms, 80), 320);
    this.regenerateRhythm();
    this.sweepStartTime = this.simulatedTimeMs;
  }

  setQRSDurationMs(ms) {
    this.intervals.qrsDurationMs = Math.min(Math.max(ms, 60), 200);
    this.regenerateRhythm();
    this.sweepStartTime = this.simulatedTimeMs;
  }

  setQTIntervalMs(ms) {
    this.intervals.qtIntervalMs = Math.min(Math.max(ms, QT_MIN_MS), QT_MAX_MS);
    this.regenerateRhythm();
    this.sweepStartTime = this.simulatedTimeMs;
  }

  setRhythm(rhythm) {
    this.currentRhythm = rhythm;
    this.regenerateRhythm();
    this.sweepStartTime = this.simulatedTimeMs;
  }

  setDisplayTime(/*seconds*/) {
    // Locked to 10 seconds for the standard print strip
    if (this.config.displayTime === 10) return;
    this.config.displayTime = 10;
    this.sweepStartTime = this.simulatedTimeMs;
  }

  setSpeed(mmPerSecond) {
    if (this.config.speed === 25) return;
    // Locked at 25 mm/s
    this.config.speed = 25;
    this.sweepStartTime = this.simulatedTimeMs;
  }

  setHighlights(highlightConfig) {
    this.highlights = { ...this.highlights, ...highlightConfig };
  }

  setOverlayCanvas(canvas) {
    this.overlayCanvas = canvas || null;
    this.overlayCtx = this.overlayCanvas ? this.overlayCanvas.getContext('2d') : null;
    this.scrollContainer = this.overlayCanvas ? this.overlayCanvas.parentElement : null;
    this.handleResize();
  }

  setIntervalHighlights(cfg) {
    this.intervalHighlights = { ...this.intervalHighlights, ...cfg };
    this.intervalDebugImmediate('setIntervalHighlights', {
      cfg,
      highlights: this.intervalHighlights
    });
  }

  intervalDebugImmediate(label, info) {
    if (!this.intervalDebug) return;
    console.log('[EcgSimulator][IntervalDebug]', label, info);
  }

  intervalDebugLog(label, info) {
    if (!this.intervalDebug) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const last = this._intervalDebugTimestamps[label] || 0;
    const threshold = 500;
    if (now - last < threshold) return;
    this._intervalDebugTimestamps[label] = now;
    console.log('[EcgSimulator][IntervalDebug]', label, info);
  }

  play() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.lastFrameTime = 0;
    requestAnimationFrame(this.tick);
  }

  pause() {
    this.isPlaying = false;
  }

  destroy() {
    this.pause();
    window.removeEventListener('resize', this.handleResize);
  }

  reset() {
    this.simulatedTimeMs = 0;
    this.sweepStartTime = 0;
    this.drawTrace();
  }

  // ---------------------------
  // CORE ANIMATION LOOP
  // ---------------------------

  tick(timestamp) {
    if (!this.isPlaying) return;

    if (!this.lastFrameTime) {
      this.lastFrameTime = timestamp;
    }

    const dt = timestamp - this.lastFrameTime;
    this.lastFrameTime = timestamp;

    this.simulatedTimeMs += dt;

    this.drawTrace();
    requestAnimationFrame(this.tick);
  }

  // ---------------------------
  // SMOOTH BEAT DEFINITION
  // ---------------------------

  generateBeat() {
    this.beatDurationMs = 60000 / this.config.heartRate;
    this.regenerateRhythm();
  }

  getCyclePhases(heartRate) {
    const RR = 60 / heartRate; // seconds per beat
    const pDur = this.intervals.pWaveDurationMs / 1000;
    const qrsDur = this.intervals.qrsDurationMs / 1000;
    const qtDur = this.intervals.qtIntervalMs / 1000;
    const prInt = this.intervals.prIntervalMs / 1000;
    const tDur = this.intervals.tWaveDurationMs / 1000;

    // Anchor P wave so there’s some flat baseline before it
    const pStartSec = 0.15 * RR; // 15% into cycle
    const pEndSec = pStartSec + pDur;

    // PR interval is P onset -> QRS onset
    const qrsStartSec = pStartSec + prInt;
    const qrsEndSec = qrsStartSec + qrsDur;

    // QT interval is QRS start -> T end
    const tEndSec = qrsStartSec + qtDur;

    // Start T near the end of ST; ensure T finishes at tEndSec
    const minST = 0.06; // 60 ms ST floor
    const tStartSec = Math.max(qrsEndSec + minST, tEndSec - tDur);

    return {
      RR,
      pStartSec,
      pEndSec,
      qrsStartSec,
      qrsEndSec,
      tStartSec,
      tEndSec
    };
  }

  // Smooth single bump: 0 → peak → 0 with curved edges
  smoothBump(t, start, duration, amp) {
    if (t < start || t > start + duration) return 0;
    const phase = (t - start) / duration; // 0 → 1
    return amp * Math.sin(Math.PI * phase);
  }

  // P wave: smooth low-amplitude hump (normal 0.1–0.2 mV, 80–100 ms)
  pWave(t, phases) {
    return this.smoothBump(t, phases.pStartSec, this.intervals.pWaveDurationMs / 1000, ECG_NORMAL.p.amp);
  }

  // T wave: broader smooth hump (normal 0.2–0.4 mV, ~160–200 ms)
  tWave(t, phases) {
    return this.smoothBump(t, phases.tStartSec, this.intervals.tWaveDurationMs / 1000, ECG_NORMAL.t.amp);
  }

  qrsComplex(t, phases) {
    const { qrsStartSec } = phases;
    const dur = this.intervals.qrsDurationMs / 1000;

    const qDur = dur * 0.25;
    const rDur = dur * 0.35;
    const sDur = dur * 0.25;

    const qStart = qrsStartSec;
    const rStart = qStart + qDur * 0.6;
    const sStart = rStart + rDur * 0.6;

    const q = this.smoothBump(t, qStart, qDur, ECG_NORMAL.qrs.qAmp);
    const r = this.smoothBump(t, rStart, rDur, ECG_NORMAL.qrs.rAmp);
    const s = this.smoothBump(t, sStart, sDur, ECG_NORMAL.qrs.sAmp);

    return q + r + s;
  }

  getVoltageAtTime(tGlobalSec) {
    return this.getVoltageAtTimeMs(tGlobalSec * 1000);
  }

  getWaveType(mV) {
    // Approximate wave categorization for coloring using pixel amplitudes
    const abs = Math.abs(mV);
    if (abs >= AMP_QRS_PX * 0.7) return 'QRS';
    if (abs >= AMP_P_PX * 0.6) return mV > 0 ? 'P' : 'T';
    return 'BASE';
  }

  waveTypeAtTime(tMs) {
    const duration = this.rhythmDurationMs || 8000;
    const time = ((tMs % duration) + duration) % duration;
    let closest = { type: 'BASE', dist: Infinity };

    const consider = (type, center, window) => {
      const dist = Math.abs(time - center);
      if (dist < window && dist < closest.dist) {
        closest = { type, dist };
      }
    };

    if (this.currentRhythm === 'avb3') {
      for (const p of this.atrialSchedule) {
        consider('P', p.pTime, p.width);
      }
    } else {
      for (const beat of this.beatSchedule) {
        if (!beat.hasP) continue;
        const pCenter = beat.rTime - beat.pr + 40;
        consider('P', pCenter, 90);
      }
    }

    for (const beat of this.beatSchedule) {
      if (!beat.hasQRS) continue;

      consider('QRS', beat.rTime, beat.qrs);

      const qrsStart = beat.rTime - beat.qrs / 2;
      const qrsEnd = beat.rTime + beat.qrs / 2;

      const tDur = this.intervals.tWaveDurationMs;
      const minST = 60;

      const tEnd = qrsStart + beat.qt;
      const tStart = Math.max(qrsEnd + minST, tEnd - tDur);

      const tCenter = (tStart + tEnd) / 2;
      const tWindow = Math.max(80, tEnd - tStart);

      if (beat.hasT !== false) {
        consider('T', tCenter, tWindow);
      }
    }

    return closest.type;
  }

  fract(x) {
    return x - Math.floor(x);
  }

  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  lobe(phase, skew) {
    const p = this.fract(phase);
    const rise = this.clamp(skew, 0.05, 0.95);
    if (p < rise) {
      const u = p / rise;
      return 0.5 - 0.5 * Math.cos(Math.PI * u);
    }
    const fall = 1 - rise;
    const u = fall > 0 ? (p - rise) / fall : 1;
    return 0.5 + 0.5 * Math.cos(Math.PI * Math.min(u, 1));
  }

  gauss(phase, mu, sigma) {
    const delta = phase - mu;
    const wrapped = delta - Math.round(delta);
    const width = sigma || 0.001;
    return Math.exp(-0.5 * Math.pow(wrapped / width, 2));
  }

  // ---------------------------
  // INTERPOLATED SAMPLING
  // ---------------------------

  sampleAtPhase(phaseMs) {
    const s = this.beatSamples;
    const n = s.length;
    if (!n) return { v: 0, type: 'BASE' };

    if (phaseMs <= s[0].t) return { v: s[0].v, type: s[0].type };
    if (phaseMs >= s[n - 1].t) return { v: s[n - 1].v, type: s[n - 1].type };

    // binary search
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t > phaseMs) hi = mid;
      else lo = mid;
    }

    const a = s[lo];
    const b = s[hi];
    const t = (phaseMs - a.t) / (b.t - a.t || 1);
    const v = a.v + t * (b.v - a.v);
    const type = t < 0.5 ? a.type : b.type;

    return { v, type };
  }

  sampleAtTime(timeMs) {
    const d = this.beatDurationMs || (60000 / this.config.heartRate);
    const phaseMs = ((timeMs % d) + d) % d; // wrap into 0–d
    return this.sampleAtPhase(phaseMs);
  }

  // ---------------------------
  // SWEEP-STYLE DRAWING
  // ---------------------------

  drawTrace() {
    const ctx = this.traceCtx;
    const canvas = this.traceCanvas;
    const dpr = window.devicePixelRatio || 1;
    const w = (canvas.width || this.renderWidth || canvas.clientWidth || 0) / dpr;
    const h = (canvas.height || this.renderHeight || canvas.clientHeight || 0) / dpr;
    ctx.clearRect(0, 0, w, h);

    const SCALE = this.viewScale || 1;
    const logicalWidth = w / SCALE;
    const logicalHeight = h / SCALE;

    const hasIntervalOverlays =
      this.intervalHighlights &&
      (this.intervalHighlights.PR || this.intervalHighlights.QRSd || this.intervalHighlights.QT);
    const OVERLAY_BAND_H = hasIntervalOverlays
      ? Math.round(Math.min(96, Math.max(64, logicalHeight * 0.28)))
      : 0;
    const INTERVAL_OVERLAY_SHIFT_Y = hasIntervalOverlays
      ? Math.round(Math.min(20, Math.max(12, logicalHeight * 0.06)))
      : 0; // pixels (tunable)
    const OVERLAY_TOP_PAD = hasIntervalOverlays
      ? Math.round(Math.min(36, Math.max(24, logicalHeight * 0.12)))
      : 0;
    const plotHeight = Math.max(60, logicalHeight - OVERLAY_BAND_H - OVERLAY_TOP_PAD);
    const overlayTopY = plotHeight + OVERLAY_TOP_PAD;
    const midY = plotHeight * 0.5;
    const verticalOffset = 90;

    const pxPerMmEffective = this.pixelPerMm * SCALE;
    const msPerPixel = 1000 / (this.config.speed * pxPerMmEffective);
    const windowMs = w * msPerPixel;
    const duration = this.rhythmDurationMs || windowMs || 1;

    let elapsedInSweep = this.simulatedTimeMs - this.sweepStartTime;
    if (duration <= windowMs) {
      // Align sweep to rhythm boundary to avoid mid-strip wraps in the R-R spacing.
      const cycleStart = Math.floor(this.simulatedTimeMs / duration) * duration;
      this.sweepStartTime = cycleStart;
      elapsedInSweep = this.simulatedTimeMs - cycleStart;
    } else if (elapsedInSweep >= windowMs || elapsedInSweep < 0) {
      this.sweepStartTime = this.simulatedTimeMs;
      elapsedInSweep = 0;
    }

    const sweepProgress = Math.min(elapsedInSweep / windowMs, 1);
    const sweepRange = Math.max(1, logicalWidth - 1);
    const xMax = Math.max(1, Math.floor(sweepProgress * sweepRange));

    const mV0 = this.getVoltageAtTimeMs(this.sweepStartTime);
    let prevX = 0;
    let prevY = midY + verticalOffset - mV0;
    let prevType = this.waveTypeAtTime(this.sweepStartTime);

    ctx.save();
    ctx.scale(SCALE, SCALE);

    ctx.beginPath();
    ctx.strokeStyle = this.colorForWave(prevType);
    ctx.moveTo(prevX, prevY);

    for (let x = 1; x <= xMax; x++) {
      const physicalX = x * SCALE;
      const tMs = this.sweepStartTime + physicalX * msPerPixel;
      const mV = this.getVoltageAtTimeMs(tMs);
      const y = midY + verticalOffset - mV;
      const type = this.waveTypeAtTime(tMs);

      if (type !== prevType) {
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.strokeStyle = this.colorForWave(type);
        ctx.moveTo(x, y);
        prevType = type;
      } else {
        ctx.lineTo(x, y);
      }

      prevX = x;
      prevY = y;
    }

    ctx.stroke();

    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, overlayTopY + 0.5);
    ctx.lineTo(logicalWidth, overlayTopY + 0.5);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = '#16a34a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xMax + 0.5, 0);
    ctx.lineTo(xMax + 0.5, logicalHeight);
    ctx.stroke();
    ctx.restore();

    const tWindowStart = this.sweepStartTime;
    const tWindowEnd = this.sweepStartTime + (xMax * msPerPixel * SCALE);

    this.drawIntervalOverlays(ctx, {
      tWindowStart,
      tWindowEnd,
      xMax,
      msPerPixel,
      SCALE,
      overlayTopY,
      overlayBandH: OVERLAY_BAND_H,
      overlayShiftY: INTERVAL_OVERLAY_SHIFT_Y,
      midY,
      verticalOffset,
      plotTopY: 0,
      plotBottomY: overlayTopY
    });

    ctx.restore();
    this.drawReadoutOverlay();
  }

  // ---------------------------
  // EXISTING METHODS
  // ---------------------------

  handleResize() {
    const dpr = window.devicePixelRatio || 1;
    const height = this.traceCanvas.clientHeight || this.traceCanvas.offsetHeight || 300;
    const REQUIRED_MM = 250;
    const SCALE = this.viewScale || 1;
    const requiredCssWidthPx = Math.round(REQUIRED_MM * this.pixelPerMm * SCALE);
    this.renderWidth = requiredCssWidthPx;
    this.renderHeight = height;

    [this.backgroundCanvas, this.traceCanvas, this.overlayCanvas].forEach((canvas) => {
      if (!canvas) return;
      canvas.style.width = `${requiredCssWidthPx}px`;
      canvas.width = Math.floor(requiredCssWidthPx * dpr);
      canvas.style.height = `${height}px`;
      canvas.height = Math.floor(height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });

    this.drawGrid();
    this.drawTrace();
  }

  drawGrid() {
    const ctx = this.backgroundCtx;
    const canvas = this.backgroundCanvas;
    const dpr = window.devicePixelRatio || 1;
    const w = (canvas.width || this.renderWidth || canvas.clientWidth || 0) / dpr;
    const h = (canvas.height || this.renderHeight || canvas.clientHeight || 0) / dpr;
    ctx.clearRect(0, 0, w, h);

    const SCALE = this.viewScale || 1;
    const logicalWidth = w / SCALE;
    const logicalHeight = h / SCALE;
    const px = this.pixelPerMm;
    const big = px * 5;

    ctx.save();
    ctx.scale(SCALE, SCALE);

    // ---------- Small grid (1 mm) ----------
    ctx.strokeStyle = 'rgba(255, 180, 180, 0.25)';
    ctx.lineWidth = 0.7;

    ctx.beginPath();
    for (let x = 0; x < logicalWidth; x += px) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, logicalHeight);
    }
    for (let y = 0; y < logicalHeight; y += px) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(logicalWidth, y + 0.5);
    }
    ctx.stroke();

    // ---------- Large grid (5 mm) ----------
    ctx.strokeStyle = 'rgba(255, 120, 120, 0.45)';  // subtle large boxes
    ctx.lineWidth = 1.2;

    ctx.beginPath();
    for (let x = 0; x < logicalWidth; x += big) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, logicalHeight);
    }
    for (let y = 0; y < logicalHeight; y += big) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(logicalWidth, y + 0.5);
    }
    ctx.stroke();

    ctx.restore();
  }

  drawIntervalOverlays(ctx, {
    tWindowStart,
    tWindowEnd,
    xMax,
    msPerPixel,
    SCALE,
    overlayTopY,
    overlayBandH,
    overlayShiftY = 0,
    midY,
    verticalOffset,
    plotTopY = 0,
    plotBottomY
  }) {
    const on = this.intervalHighlights;
    if (!on.PR && !on.QRSd && !on.QT) {
      this.intervalDebugLog('intervalOverlaySkip', { reason: 'highlights-off', highlights: on });
      return;
    }
    if (this.currentRhythm === 'mvtach' || this.currentRhythm === 'pvtach') {
      this.intervalDebugLog('intervalOverlaySkip', {
        reason: 'excluded rhythm',
        currentRhythm: this.currentRhythm
      });
      return;
    }
    if (!this.beatSchedule || !this.beatSchedule.length) {
      this.intervalDebugLog('intervalOverlaySkip', { reason: 'no beats scheduled' });
      return;
    }

    const duration = this.rhythmDurationMs || 8000;
    if (!duration || !msPerPixel || xMax <= 0) {
      this.intervalDebugLog('intervalOverlaySkip', {
        reason: 'invalid geometry',
        duration,
        msPerPixel,
        xMax
      });
      return;
    }

    const tToX = (tMs) => (tMs - tWindowStart) / (msPerPixel * SCALE);

    const padTop = 14;
    const padBottom = 10;
    const usableH = Math.max(40, overlayBandH - padTop - padBottom);
    const laneGap = Math.floor(usableH / 3);

    const shiftedTop = overlayTopY + overlayShiftY;
    const lanes = {
      PR: shiftedTop + padTop + laneGap * 0.3,
      QRSd: shiftedTop + padTop + laneGap * 1.3,
      QT: shiftedTop + padTop + laneGap * 2.3
    };

    const style = {
      PR: { stroke: '#2563eb', fill: 'rgba(37,99,235,0.10)', label: (ms) => `PR ${ms} ms` },
      QRSd: { stroke: '#d33f49', fill: 'rgba(211,63,73,0.10)', label: (ms) => `QRS ${ms} ms` },
      QT: { stroke: '#2f855a', fill: 'rgba(47,133,90,0.10)', label: (ms) => `QT ${ms} ms` }
    };

    const BRACKET_H = 10;
    const TEXT_PAD = 4;

    const GUIDE_STYLE = {
      PR: 'rgba(37,99,235,0.18)',
      QRSd: 'rgba(211,63,73,0.18)',
      QT: 'rgba(47,133,90,0.18)'
    };
    const guideLineWidth = 1;
    const guideDash = [4, 4];

    const yWaveAt = (tMs) => {
      if (typeof midY !== 'number') return plotTopY + 2;
      const v = this.getVoltageAtTimeMs(tMs);
      const y = midY + (verticalOffset || 0) - v;
      const bottomLimit = (typeof plotBottomY === 'number' ? plotBottomY : overlayTopY) - 2;
      return Math.max((plotTopY || 0) + 2, Math.min(bottomLimit, y));
    };

    const drawGuidesToWave = (key, tStartRaw, tEndRaw, x1, x2, yBracketTop) => {
      ctx.save();
      ctx.strokeStyle = GUIDE_STYLE[key] || 'rgba(15,23,42,0.18)';
      ctx.lineWidth = guideLineWidth;
      ctx.setLineDash(guideDash);

      const y1 = yWaveAt(tStartRaw);
      ctx.beginPath();
      ctx.moveTo(x1 + 0.5, yBracketTop);
      ctx.lineTo(x1 + 0.5, y1);
      ctx.stroke();

      const y2 = yWaveAt(tEndRaw);
      ctx.beginPath();
      ctx.moveTo(x2 + 0.5, yBracketTop);
      ctx.lineTo(x2 + 0.5, y2);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.fillStyle = GUIDE_STYLE[key] || 'rgba(15,23,42,0.25)';
      ctx.beginPath();
      ctx.arc(x1 + 0.5, y1, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x2 + 0.5, y2, 2, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    };

    let prDrawn = 0;
    let qrsDrawn = 0;
    let qtDrawn = 0;
    const drawBracket = (key, tStart, tEnd, labelMs) => {
      const x1 = tToX(tStart);
      const x2 = tToX(tEnd);
      if (x2 < 0 || x1 > xMax) return;
      const xx1 = Math.max(0, Math.min(xMax, x1));
      const xx2 = Math.max(0, Math.min(xMax, x2));
      if (xx2 - xx1 <= 1) return;

      const y = lanes[key];

      ctx.save();
      ctx.lineWidth = 2;
      ctx.strokeStyle = style[key].stroke;
      ctx.fillStyle = style[key].fill;

      ctx.beginPath();
      ctx.rect(xx1, y - BRACKET_H, xx2 - xx1, BRACKET_H);
      ctx.fill();
      ctx.stroke();

      ctx.font = '12px Arial';
      ctx.fillStyle = style[key].stroke;
      ctx.fillText(style[key].label(labelMs), xx1, y - BRACKET_H - TEXT_PAD);

      ctx.restore();

      if ((xx2 - xx1) > 1) {
        drawGuidesToWave(key, tStart, tEnd, xx1, xx2, y - BRACKET_H);
      }
    };

    const prAllowedForBeat = (beat) => {
      if (this.currentRhythm === 'afib' || this.currentRhythm === 'avb3') return false;
      return beat.hasP !== false && beat.hasQRS !== false && beat.pr > 0;
    };
    const qrsAllowedForBeat = (beat) => beat.hasQRS !== false && beat.qrs > 0;
    const qtAllowedForBeat = (beat) => beat.hasQRS !== false && beat.qt > 0;

    for (const beat of this.beatSchedule) {
      const t0 = beat.rTime;
      const kStart = Math.floor((tWindowStart - t0) / duration) - 1;
      const kEnd = Math.floor((tWindowEnd - t0) / duration) + 1;

      for (let k = kStart; k <= kEnd; k++) {
        const rOcc = t0 + k * duration;
        const qrsStart = rOcc - beat.qrs / 2;
        const qrsEnd = qrsStart + beat.qrs;
        const prStart = qrsStart - beat.pr;
        const qtStart = qrsStart;
        const qtEnd = qrsStart + beat.qt;

        if (on.PR && prAllowedForBeat(beat)) {
          drawBracket('PR', prStart, qrsStart, Math.round(beat.pr));
          prDrawn++;
        }
        if (on.QRSd && qrsAllowedForBeat(beat)) {
          drawBracket('QRSd', qrsStart, qrsEnd, Math.round(beat.qrs));
          qrsDrawn++;
        }
        if (on.QT && qtAllowedForBeat(beat)) {
          drawBracket('QT', qtStart, qtEnd, Math.round(beat.qt));
          qtDrawn++;
        }
      }
    }
    if (this.intervalDebug) {
      this.intervalDebugLog('intervalOverlayStats', {
        highlights: on,
        counts: { PR: prDrawn, QRSd: qrsDrawn, QT: qtDrawn },
        window: [tWindowStart, tWindowEnd]
      });
      if (on.PR && prDrawn === 0) {
        this.intervalDebugImmediate('intervalOverlayWarning', {
          type: 'PR',
          reason: 'no PR brackets rendered',
          beats: this.beatSchedule.length
        });
      }
    }
  }

  getReadoutSummary() {
    const beats = this.beatSchedule || [];
    const hrBpm = Math.round(this.config.heartRate || 0);
    const allowPR =
      this.currentRhythm !== 'afib' &&
      this.currentRhythm !== 'avb3' &&
      this.currentRhythm !== 'mvtach' &&
      this.currentRhythm !== 'pvtach';
    const isAfib =
      this.currentRhythm === 'afib' || this.currentRhythm === 'atrial_fibrillation';

    const conductionBeats = beats.filter((beat) => beat && beat.hasQRS !== false);

    const collectValues = (selector, filterFn = () => true) =>
      conductionBeats.filter((beat) => filterFn(beat)).map((beat) => selector(beat)).filter((v) => typeof v === 'number' && v > 0);

    const formatRange = (label, values, fallbackValue, allow = true) => {
      if (!allow) return `${label} ——`;
      if (values.length) {
        const min = Math.round(Math.min(...values));
        const max = Math.round(Math.max(...values));
        return min === max ? `${label} ${min} ms` : `${label} ${min}–${max} ms`;
      }
      if (fallbackValue) {
        const rounded = Math.round(fallbackValue);
        return `${label} ${rounded} ms`;
      }
      return `${label} ——`;
    };

    const prValues = allowPR ? collectValues((beat) => beat.pr, (beat) => beat.hasP !== false && beat.pr > 0) : [];
    const qrsValues = collectValues((beat) => beat.qrs);
    const qtValues = collectValues((beat) => beat.qt);

    const prText = isAfib ? 'PR —' : formatRange('PR', prValues, null, allowPR);
    const qrsText = formatRange('QRS', qrsValues, this.intervals.qrsDurationMs);
    const qtText = formatRange('QT', qtValues, this.intervals.qtIntervalMs);

    if (
      this.intervalDebug &&
      (this.intervalHighlights.PR || this.intervalHighlights.QRSd || this.intervalHighlights.QT)
    ) {
      this.intervalDebugLog('readoutSummary', {
        highlights: this.intervalHighlights,
        prValues,
        qrsValues,
        qtValues
      });
    }

    return {
      hrText: `HR ${hrBpm} bpm`,
      prText,
      qrsText,
      qtText
    };
  }

  drawReadoutOverlay() {
    if (!this.overlayCtx || !this.overlayCanvas) return;

    const ctx = this.overlayCtx;
    const w = this.renderWidth || this.overlayCanvas.clientWidth || 0;
    const h = this.renderHeight || this.overlayCanvas.clientHeight || 0;
    if (!w || !h) return;

    ctx.clearRect(0, 0, w, h);

    const summary = this.getReadoutSummary();
    const lines = [summary.hrText, summary.prText, summary.qrsText, summary.qtText];

    const sc = this.scrollContainer || this.overlayCanvas.parentElement;
    const scrollLeft = sc ? sc.scrollLeft : 0;
    const viewW = sc ? sc.clientWidth : w;
    if (
      this.intervalDebug &&
      (this.intervalHighlights.PR || this.intervalHighlights.QRSd || this.intervalHighlights.QT)
    ) {
      this.intervalDebugLog('drawReadoutOverlay', {
        highlights: this.intervalHighlights,
        scrollLeft,
        viewW,
        lines
      });
    }

    const SCALE = this.viewScale || 1;
    const fontSize = Math.max(10, Math.round(12 * SCALE));
    ctx.font = `${fontSize}px "SFMono-Regular", Consolas, "Liberation Mono", monospace`;
    ctx.textBaseline = 'top';

    const lineHeight = fontSize + 2;
    const padding = 10;

    let maxWidth = 0;
    for (const line of lines) {
      maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
    }

    const boxWidth = maxWidth + padding * 2;
    const boxHeight = lines.length * lineHeight + padding * 2;
    const margin = 12;

    const x = Math.max(margin, scrollLeft + viewW - boxWidth - margin);
    const y = margin;

    const radius = 8;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    this.roundedRectPath(ctx, x, y, boxWidth, boxHeight, radius);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#0f172a';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x + padding, y + padding + i * lineHeight);
    }
  }

  roundedRectPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }

  colorForWave(waveType) {
    const base = '#1f2937';
    const highlightMap = { P: '#2563eb', QRS: '#d33f49', T: '#2f855a' };
    if (this.highlights[waveType]) return highlightMap[waveType] || base;
    return base;
  }

  // ---------------------------
  // Rhythm generation
  // ---------------------------

  regenerateRhythm() {
    this.beatSchedule = [];
    this.atrialSchedule = [];

    const baseRrMs = 60000 / this.config.heartRate;
    const TARGET_DURATION_MS = 8000;
    const durationMs = (this.config.displayTime || 10) * 1000;
    const isAfib =
      this.currentRhythm === 'afib' || this.currentRhythm === 'atrial_fibrillation';
    const isRegular =
      this.currentRhythm === 'sinus' ||
      this.currentRhythm === 'avb1' ||
      this.currentRhythm === 'mvtach' ||
      this.currentRhythm === 'vtach';

    if (isAfib) {
      this.initAfibNoise();
      const meanRr = 60000 / this.config.heartRate;
      let t = 0;
      const randn = () => {
        let u = 0;
        let v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
      };

      while (t < durationMs) {
        const rr = Math.max(350, Math.min(1800, meanRr * Math.exp(0.25 * randn())));
        const qrs = this.intervals.qrsDurationMs;
        const qt = this.intervals.qtIntervalMs;

        this.addBeat({
          rTime: t + qrs / 2,
          hasP: false,
          hasQRS: true,
          pr: 0,
          qrs,
          qt
        });

        t += rr;
      }

      this.rhythmDurationMs = durationMs;
      this.drawTrace();
      return;
    }

    if (isRegular) {
      const nBeats = Math.max(1, Math.ceil(TARGET_DURATION_MS / baseRrMs));
      this.rhythmDurationMs = nBeats * baseRrMs;
    }

    const generationDurationMs = isRegular ? this.rhythmDurationMs : durationMs;

    switch (this.currentRhythm) {
      case 'avb1':
        this.generateFirstDegreeAVBlock(generationDurationMs, baseRrMs);
        break;
      case 'avb2_mobitz1':
        this.generateSecondDegreeMobitzI(generationDurationMs, baseRrMs);
        break;
      case 'avb2_mobitz2':
        this.generateSecondDegreeMobitzII(generationDurationMs, baseRrMs);
        break;
      case 'avb3':
        this.generateThirdDegreeAVBlock(generationDurationMs);
        break;
      case 'afib':
        this.generateAFib(generationDurationMs);
        break;
      case 'mvtach':
        this.generateMVTach(generationDurationMs);
        break;
      case 'pvtach':
        this.generatePVTach(generationDurationMs);
        break;
      case 'sinus':
      default:
        this.generateSinusRhythm(generationDurationMs, baseRrMs);
        break;
    }

    if (!isRegular) {
      const lastBeat = this.beatSchedule[this.beatSchedule.length - 1];
      this.rhythmDurationMs = Math.max(
        durationMs,
        lastBeat ? lastBeat.rTime + baseRrMs : 0
      );
    }
    this.drawTrace();
  }

  addBeat({
    rTime,
    hasP = true,
    hasQRS = true,
    hasT = true,
    pr = this.intervals.prIntervalMs,
    qrs = this.intervals.qrsDurationMs,
    qt = this.intervals.qtIntervalMs,
    qrsScale = 1,
    polarity = 1
  }) {
    this.beatSchedule.push({ rTime, hasP, hasQRS, hasT, pr, qrs, qt, qrsScale, polarity });
  }

  generateSinusRhythm(durationMs, baseRrMs) {
    let t = 0;
    while (t < durationMs) {
      const rTime = t + this.intervals.prIntervalMs + this.intervals.qrsDurationMs / 2;
      if (rTime >= durationMs) break;
      this.addBeat({
        rTime,
        hasP: true,
        hasQRS: true,
        pr: this.intervals.prIntervalMs,
        qrs: this.intervals.qrsDurationMs,
        qt: this.intervals.qtIntervalMs
      });
      t += baseRrMs;
    }
  }

  generateFirstDegreeAVBlock(durationMs, baseRrMs) {
    const longPr = Math.max(this.intervals.prIntervalMs, 240);
    let t = 0;
    while (t < durationMs) {
      const rTime = t + longPr + this.intervals.qrsDurationMs / 2;
      if (rTime >= durationMs) break;
      this.addBeat({
        rTime,
        hasP: true,
        hasQRS: true,
        pr: longPr,
        qrs: this.intervals.qrsDurationMs,
        qt: this.intervals.qtIntervalMs
      });
      t += baseRrMs;
    }
  }

  generateSecondDegreeMobitzI(durationMs, baseRrMs) {
    const pr1 = 200;
    const pr2 = 260;
    const pr3 = 320;

    let t = 0;
    while (t < durationMs) {
      this.addBeat({
        rTime: t + pr1 + this.intervals.qrsDurationMs / 2,
        hasP: true,
        hasQRS: true,
        pr: pr1,
        qrs: this.intervals.qrsDurationMs,
        qt: this.intervals.qtIntervalMs
      });
      t += baseRrMs;

      if (t >= durationMs) break;
      this.addBeat({
        rTime: t + pr2 + this.intervals.qrsDurationMs / 2,
        hasP: true,
        hasQRS: true,
        pr: pr2,
        qrs: this.intervals.qrsDurationMs,
        qt: this.intervals.qtIntervalMs
      });
      t += baseRrMs;

      if (t >= durationMs) break;
      this.addBeat({
        rTime: t + pr3 + this.intervals.qrsDurationMs / 2,
        hasP: true,
        hasQRS: true,
        pr: pr3,
        qrs: this.intervals.qrsDurationMs,
        qt: this.intervals.qtIntervalMs
      });
      t += baseRrMs;

      if (t >= durationMs) break;
      this.addBeat({
        rTime: t + pr3 + this.intervals.qrsDurationMs / 2,
        hasP: true,
        hasQRS: false,
        hasT: false,
        pr: pr3,
        qrs: this.intervals.qrsDurationMs,
        qt: this.intervals.qtIntervalMs
      });
      t += baseRrMs;
    }
  }

  generateSecondDegreeMobitzII(durationMs, baseRrMs) {
    /*
     * Mobitz II (unambiguous): constant PR on conducted beats with intermittent dropped QRS.
     * A strict 2:1 pattern is ambiguous ("cannot tell Mobitz I vs II"), so we avoid dropping
     * every other beat by using ≥3:2 / 4:3 conduction with small randomness.
     */
    const fixedPr = Math.max(this.intervals.prIntervalMs, 80);
    const qrsHalf = this.intervals.qrsDurationMs / 2;
    let t = 0;
    let beatIndex = 0;
    let nextDropAt = 3; // start 4:3 (drop the 4th P)

    while (t < durationMs) {
      const dropped = beatIndex === nextDropAt;
      const conducted = !dropped;

      this.addBeat({
        rTime: t + fixedPr + qrsHalf,
        hasP: true,
        hasQRS: conducted,
        hasT: conducted,
        pr: fixedPr,
        qrs: this.intervals.qrsDurationMs,
        qt: this.intervals.qtIntervalMs
      });

      if (dropped) {
        // Mostly 4:3, sometimes 3:2, rarely 5:4. Never 2:1.
        const spacingBase = Math.random() < 0.7 ? 4 : 3;
        const spacing = spacingBase + (Math.random() < 0.15 ? 1 : 0);
        nextDropAt += Math.max(3, spacing);
      }

      t += baseRrMs;
      beatIndex++;
    }

    if (typeof this.logMobitz2SelfCheck === 'function') {
      this.logMobitz2SelfCheck();
    }
  }

  logMobitz2SelfCheck() {
    if (this.currentRhythm !== 'avb2_mobitz2') return;
    const beats = Array.isArray(this.beatSchedule) ? this.beatSchedule : [];
    if (!beats.length) return;

    const sample = beats.slice(0, 12).map((beat, i) => {
      const conducted = beat.hasQRS !== false;
      const pCenter = (beat.rTime || 0) - (beat.pr || 0) + 40;
      const pShown = beat.hasP !== false;
      return {
        i,
        pCenter: pShown ? Math.round(pCenter) : null,
        hasP: pShown,
        hasQRS: conducted,
        hasT: beat.hasT !== false,
        pr: conducted ? Math.round(beat.pr || 0) : null
      };
    });

    const conductedPr = beats.filter((b) => b.hasQRS !== false).map((b) => Math.round(b.pr || 0));
    const uniquePr = [...new Set(conductedPr)].filter((v) => v > 0);
    const pattern = beats.slice(0, 12).map((b) => (b.hasQRS !== false ? 1 : 0));
    const alt1 = pattern.every((v, i) => v === (i % 2 === 0 ? 1 : 0));
    const alt2 = pattern.every((v, i) => v === (i % 2 === 0 ? 0 : 1));

    const dropIdx = beats
      .map((b, i) => (b.hasQRS === false ? i : -1))
      .filter((i) => i >= 0);
    const gaps = [];
    for (let j = 1; j < dropIdx.length; j++) {
      gaps.push(dropIdx[j] - dropIdx[j - 1] - 1);
    }

    console.groupCollapsed('[EcgSimulator][Mobitz II self-check]');
    sample.forEach((row) => {
      console.log(
        `#${row.i} P=${row.hasP ? `@${row.pCenter}ms` : 'off'} QRS=${row.hasQRS ? 'on' : 'off'} T=${row.hasT ? 'on' : 'off'} ${row.hasQRS ? `PR=${row.pr}ms` : '(dropped)'}`
      );
    });
    console.assert(uniquePr.length <= 1, '[Mobitz II] PR should be constant on conducted beats.', uniquePr);
    console.assert(!(alt1 || alt2), '[Mobitz II] Pattern looks like strict 2:1 block; expected ≥3:2 / 4:3.', pattern);
    if (gaps.length) {
      const minGap = Math.min(...gaps);
      console.assert(minGap >= 2, '[Mobitz II] Expected ≥2 conducted beats between drops most of the time.', gaps);
    }
    console.groupEnd();
  }

  generateThirdDegreeAVBlock(durationMs) {
    this.beatSchedule = [];
    this.atrialSchedule = [];

    const atrialRate = 80;
    const ventRate = 35;

    const atrialRrMs = 60000 / atrialRate;
    const ventRrMs = 60000 / ventRate;

    let tA = 0;
    while (tA < durationMs) {
      this.atrialSchedule.push({ pTime: tA, width: 80 });
      tA += atrialRrMs;
    }

    let tV = 0;
    while (tV < durationMs) {
      this.addBeat({
        rTime: tV,
        hasP: false,
        hasQRS: true,
        pr: 0,
        qrs: 160,
        qt: 420
      });
      tV += ventRrMs;
    }
  }

  generateAFib(durationMs) {
    this.beatSchedule = [];
    this.atrialSchedule = [];

    const meanRate = Math.max(this.config.heartRate, 90);
    const meanRrMs = 60000 / meanRate;

    let t = 0;
    while (t < durationMs) {
      const jitterFactor = 0.5 + Math.random();
      const rr = meanRrMs * jitterFactor;

      this.addBeat({
        rTime: t,
        hasP: false,
        hasQRS: true,
        pr: 0,
        qrs: this.intervals.qrsDurationMs,
        qt: this.intervals.qtIntervalMs
      });

      t += rr;
    }
  }

  generateMVTach(durationMs) {
    this.beatSchedule = [];
    this.atrialSchedule = [];
  }

  generatePVTach(durationMs) {
    this.beatSchedule = [];
    this.atrialSchedule = [];
  }

  drawPWave(tMs, centerMs, widthMs) {
    const sigma = widthMs / 6;
    const delta = tMs - centerMs;
    return this.waveAmpsPx.p * Math.exp(-0.5 * Math.pow(delta / (sigma || 1), 2));
  }

  drawQRSComplex(tMs, rTime, qrsWidthMs, qrsScale = 1, polarity = 1) {
    const qCenter = rTime - qrsWidthMs * 0.25;
    const sCenter = rTime + qrsWidthMs * 0.25;
    const sigma = qrsWidthMs / 10;

    const scale = Math.max(0.1, qrsScale || 1);
    const pol = polarity === -1 ? -1 : 1;

    const qAmp = this.waveAmpsPx.q * scale * pol;
    const rAmp = this.waveAmpsPx.r * scale * pol;
    const sAmp = this.waveAmpsPx.s * scale * pol;

    const q = qAmp * Math.exp(-0.5 * Math.pow((tMs - qCenter) / (sigma || 1), 2));
    const r = rAmp * Math.exp(-0.5 * Math.pow((tMs - rTime) / (sigma || 1), 2));
    const s = sAmp * Math.exp(-0.5 * Math.pow((tMs - sCenter) / (sigma || 1), 2));

    return q + r + s;
  }

  drawTWave(tMs, centerMs, widthMs) {
    const sigma = widthMs / 5;
    const delta = tMs - centerMs;
    return this.waveAmpsPx.t * Math.exp(-0.5 * Math.pow(delta / (sigma || 1), 2));
  }

  initAfibNoise() {
    // Create stable “f-wave” components for this rhythm run.
    // AFib f-waves often ~4–9 Hz with irregular morphology.
    const n = 8;
    const comps = [];
    for (let i = 0; i < n; i++) {
      const freq = 4 + Math.random() * 6; // 4–10 Hz
      const phase = Math.random() * Math.PI * 2; // random phase
      const weight = 0.4 + Math.random() * 0.9; // amplitude weight
      comps.push({ freq, phase, weight });
    }
    this._afibNoise = comps;
    this._afibNoiseDriftPhase = Math.random() * Math.PI * 2;
  }

  afibBaseline(tMs) {
    const comps = this._afibNoise;
    if (!comps || !comps.length) return 0;

    const timeSec = tMs / 1000;

    // Target fibrillatory amplitude ~0.10–0.18 mV (visually obvious but not huge)
    // Convert mV -> px using MV_TO_PX.
    const baseAmpPx = 0.14 * MV_TO_PX;

    // Slow amplitude modulation to avoid “machine-like” regularity
    const drift =
      0.75 + 0.25 * Math.sin(2 * Math.PI * 0.25 * timeSec + (this._afibNoiseDriftPhase || 0));

    // Sum of sinusoids -> “noisy” f-wave
    let s = 0;
    let wsum = 0;
    for (const c of comps) {
      s += c.weight * Math.sin(2 * Math.PI * c.freq * timeSec + c.phase);
      wsum += c.weight;
    }
    if (wsum > 0) s /= wsum;

    // Add a small higher-frequency roughness component
    const rough =
      0.25 * Math.sin(2 * Math.PI * 16.0 * timeSec + 1.3) +
      0.2 * Math.sin(2 * Math.PI * 22.0 * timeSec + 2.1);

    return baseAmpPx * drift * (0.85 * s + 0.15 * rough);
  }

  afibQrsBlanking(timeMsFromR) {
    if (!Number.isFinite(timeMsFromR)) return 1;
    const x = Math.abs(timeMsFromR);
    const sigma = 25; // tighter than before
    return 1 - Math.exp(-0.5 * (x / sigma) * (x / sigma));
  }

  afibTBlanking(timeMsFromT) {
    if (!Number.isFinite(timeMsFromT)) return 1;
    const x = Math.abs(timeMsFromT);
    const sigma = 70;
    const dip = Math.exp(-0.5 * (x / sigma) * (x / sigma));
    return 1 - 0.55 * dip;
  }

  getVoltageAtTimeMs(tMs) {
    if (this.currentRhythm === 'mvtach') {
      const t = tMs / 1000;
      const bpm = Math.min(220, Math.max(this.config.heartRate, 160));
      const f = bpm / 60;
      const phase = this.fract(f * t);
      const skew = 0.35;
      const A = AMP_QRS_PX * 1.4;
      const p = 1.35;
      const L = this.lobe(phase, skew);
      let y = -A * Math.pow(L, p);
      y += -A * 0.15 * this.gauss(phase, 0.75, 0.06);
      y += AMP_P_PX * 0.03 * Math.sin(2 * Math.PI * 0.2 * t);
      return y;
    }

    if (this.currentRhythm === 'pvtach') {
      const t = tMs / 1000;
      const bpm = Math.min(260, Math.max(this.config.heartRate, 180));
      const f = bpm / 60;
      const phase = this.fract(f * t);
      const N = 14;
      const fTwist = f / N;
      const E = Math.sin(2 * Math.PI * fTwist * t);
      const A = AMP_QRS_PX * 1.3 * (1 + 0.6 * E);
      const P = Math.sin(2 * Math.PI * fTwist * t + 0.8);
      const skew = this.clamp(0.38 + 0.10 * E, 0.22, 0.60);
      const p = 1.25 + 0.25 * E;
      const L = this.lobe(phase, skew);
      let y = -A * P * Math.pow(L, p);
      y += -AMP_QRS_PX * 0.08 * this.gauss(phase, 0.72, 0.07) * P;
      y += AMP_P_PX * 0.03 * Math.sin(2 * Math.PI * 0.2 * t + 0.4);
      return y;
    }

    const duration = this.rhythmDurationMs || 8000;
    const time = ((tMs % duration) + duration) % duration;
    let y = 0;
    let nearestDtFromR = Infinity;
    let nearestDtFromT = Infinity;
    const isAfib =
      this.currentRhythm === 'afib' || this.currentRhythm === 'atrial_fibrillation';

    if (this.currentRhythm === 'avb3') {
      for (const p of this.atrialSchedule) {
        if (Math.abs(time - p.pTime) <= p.width * 2) {
          y += this.drawPWave(time, p.pTime, p.width);
        }
      }
    } else if (!isAfib) {
      for (const beat of this.beatSchedule) {
        if (!beat.hasP) continue;
        const pCenter = beat.rTime - beat.pr + 40;
        if (Math.abs(time - pCenter) <= 160) {
          y += this.drawPWave(time, pCenter, 80);
        }
      }
    }

    for (const beat of this.beatSchedule) {
      if (!beat.hasQRS) continue;

      const dt = time - beat.rTime;
      if (Math.abs(dt) < Math.abs(nearestDtFromR)) nearestDtFromR = dt;

      // ---- QRS (only draw when we're near it) ----
      if (Math.abs(dt) <= beat.qrs * 2) {
        y += this.drawQRSComplex(
          time,
          beat.rTime,
          beat.qrs,
          beat.qrsScale || 1,
          beat.polarity || 1
        );
      }

      // ---- T wave (independent window; QT is measured QRS start -> T end) ----
      const qrsStart = beat.rTime - beat.qrs / 2;
      const qrsEnd = beat.rTime + beat.qrs / 2;

      const tDur = this.intervals.tWaveDurationMs;
      const minST = 60;

      const tEnd = qrsStart + beat.qt;
      const tStart = Math.max(qrsEnd + minST, tEnd - tDur);

      const tCenter = (tStart + tEnd) / 2;
      const tWidth = Math.max(80, tEnd - tStart);
      const dtT = time - tCenter;
      if (Math.abs(dtT) < Math.abs(nearestDtFromT)) nearestDtFromT = dtT;

      const allowT = beat.hasT !== false && beat.hasQRS !== false;
      if (allowT && Math.abs(time - tCenter) <= tWidth * 2) {
        y += this.drawTWave(time, tCenter, tWidth);
      }
    }

    if (isAfib) {
      const blankQRS = this.afibQrsBlanking(nearestDtFromR);
      const blankT = this.afibTBlanking(nearestDtFromT);
      y += this.afibBaseline(time) * blankQRS * blankT;
    }

    return y;
  }
}

window.EcgSimulator = EcgSimulator;
const ECG_NORMAL = {
  mmPerMv: MM_PER_MV, // standard ECG calibration
  p: { duration: 0.09, amp: AMP_P_MV }, // seconds, mV
  pr: { interval: 0.16 }, // total PR interval
  qrs: { duration: 0.09, rAmp: AMP_QRS_MV, qAmp: -0.2, sAmp: -0.4 },
  st: { duration: 0.12 },
  t: { duration: 0.16, amp: AMP_T_MV },
  qt: { interval: 0.4 }
};

function secToPx(sec, speedMmPerSec, pxPerMm) {
  return sec * speedMmPerSec * pxPerMm;
}

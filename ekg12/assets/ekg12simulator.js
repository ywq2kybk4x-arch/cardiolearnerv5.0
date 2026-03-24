// MVP 12-lead ECG simulator built on the single-lead waveform model.
// This intentionally mirrors the existing sweep engine so it can evolve into a full VCG later.

const MM_PER_MV_12 = 10;
const PX_PER_MM_12 = 4;
const MV_TO_PX_12 = MM_PER_MV_12 * PX_PER_MM_12;
const DEG_TO_RAD_12 = Math.PI / 180;

function normLead(name) {
  return String(name || '')
    .trim()
    .toUpperCase();
}

function normalizeLeadConfig(config) {
  const normalized = {};
  for (const [leadName, cfg] of Object.entries(config || {})) {
    normalized[normLead(leadName)] = { ...cfg };
  }
  return normalized;
}

const CANONICAL_LEAD_LIST = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
const CANONICAL_LEAD_KEYS = CANONICAL_LEAD_LIST.map((name) => normLead(name));
const LIMB_LEADS = CANONICAL_LEAD_KEYS.slice(0, 6);
const CHEST_LEAD_KEYS = CANONICAL_LEAD_KEYS.slice(6);

const LEADS_12 = [
  ['I', 'aVR', 'V1', 'V4'],
  ['II', 'aVL', 'V2', 'V5'],
  ['III', 'aVF', 'V3', 'V6']
];

const ALL_LEAD_KEYS = CANONICAL_LEAD_KEYS;

const LIMB_LEAD_ANGLES = {
  I: 0,
  II: 60,
  III: 120,
  AVR: -150,
  AVL: -30,
  AVF: 90
};

const LIMB_MIN_SCALE = 0.08;
const LIMB_PT_MIN_SCALE = 0.12;

const LIMB_LEAD_CONFIG = normalizeLeadConfig({
  I: { gain: 0.95, polarity: 1, offsetPx: 0 },
  II: { gain: 1.05, polarity: 1, offsetPx: 0 },
  III: { gain: 0.95, polarity: 1, offsetPx: 0 },
  AVR: { gain: 1.0, polarity: 1, offsetPx: 0 },
  AVL: { gain: 1.05, polarity: 1, offsetPx: 0 },
  AVF: { gain: 1.0, polarity: 1, offsetPx: 0 }
});

const PRECORDIAL_ORDER = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
const PRECORDIAL_BASE_GAINS = normalizeLeadConfig({
  V1: { baseGain: 0.9, offsetPx: 0 },
  V2: { baseGain: 0.95, offsetPx: 0 },
  V3: { baseGain: 1.0, offsetPx: 0 },
  V4: { baseGain: 1.05, offsetPx: 0 },
  V5: { baseGain: 0.9, offsetPx: 0 },
  V6: { baseGain: 0.9, offsetPx: 0 }
});

const DEFAULT_LIMB_CONFIG = { gain: 1, polarity: 1, offsetPx: 0 };
const DEFAULT_PRECORDIAL_CONFIG = { baseGain: 1, offsetPx: 0 };

const AMP_PX = {
  P: 0.15 * MV_TO_PX_12,
  Q: -0.25 * MV_TO_PX_12,
  R: 1.0 * MV_TO_PX_12,
  S: -0.35 * MV_TO_PX_12,
  T: 0.4 * MV_TO_PX_12
};

const BASE_INTERVALS = {
  prIntervalMs: 160,
  qrsDurationMs: 90,
  qtIntervalMs: 400,
  pWaveDurationMs: 90,
  tWaveDurationMs: 180
};

const AFIB_T_SCALE = 0.22; // 0.15–0.35 is a good tuning range
const STEMI_CONFIG = { stMv: 0.25 };
const STEMI_IDS = ['stemi_inferior', 'stemi_anterior', 'stemi_lateral'];

const normalizeLeadMap = (map = {}) => {
  const normalized = {};
  for (const [lead, value] of Object.entries(map)) {
    normalized[normLead(lead)] = value;
  }
  return normalized;
};

const STEMI_LEAD_MAPS = {
  inferior: normalizeLeadMap({
    II: 1.0,
    III: 1.1,
    AVF: 1.0,
    I: -0.6,
    AVL: -0.6
  }),
  anterior: normalizeLeadMap({
    V1: 0.7,
    V2: 1.0,
    V3: 1.0,
    V4: 0.8,
    II: -0.5,
    III: -0.6,
    AVF: -0.5
  }),
  lateral: normalizeLeadMap({
    I: 1.0,
    AVL: 1.0,
    V5: 0.9,
    V6: 0.9,
    II: -0.5,
    III: -0.6,
    AVF: -0.5
  })
};

const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / ((edge1 - edge0) || 1), 0, 1);
  return t * t * (3 - 2 * t);
};

const degWrap = (deg) => {
  let d = ((deg + 180) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let a = Math.imul(t ^ (t >>> 15), t | 1);
    a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
    return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  };
}

function randnBM(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

const safeNonZero = (g, minAbs = 0.18) => {
  if (!Number.isFinite(g)) return minAbs;
  if (Math.abs(g) < minAbs) {
    const sign = g === 0 ? 1 : Math.sign(g);
    return sign * minAbs;
  }
  return g;
};

const lerp = (a, b, t) => a + (b - a) * t;
const TILE_BASELINE_SHIFT_PX = 0;
const TILE_EDGE_PAD_PX = 32;
const GRID_TOP_PADDING_PX = 28;
const MAIN_TRACE_VERTICAL_SCALE = 0.78;
const DEFAULT_HR_CLAMP = { min: 40, max: 180 };

const RHYTHM_PRESETS = {
  sinus: {
    id: 'sinus',
    label: 'Sinus Rhythm',
    defaultHR: 75,
    hrClamp: { min: 40, max: 180 },
    intervals: { prIntervalMs: 160, qrsDurationMs: 90, qtIntervalMs: 400, pWaveDurationMs: 90, tWaveDurationMs: 180 }
  },
  sinus_pac: {
    id: 'sinus_pac',
    label: 'Sinus Rhythm With Single PAC',
    defaultHR: 90,
    hrClamp: { min: 50, max: 150 },
    intervals: { prIntervalMs: 160, qrsDurationMs: 90, qtIntervalMs: 400, pWaveDurationMs: 90, tWaveDurationMs: 180 }
  },
  afib: {
    id: 'afib',
    label: 'Atrial Fibrillation',
    defaultHR: 110,
    hrClamp: { min: 90, max: 160 },
    intervals: { prIntervalMs: 0, qrsDurationMs: 90, qtIntervalMs: 380, pWaveDurationMs: 0, tWaveDurationMs: 180 }
  },
  aflutter: {
    id: 'aflutter',
    label: 'Atrial Flutter',
    defaultHR: 150,
    hrClamp: { min: 90, max: 180 },
    intervals: { prIntervalMs: 0, qrsDurationMs: 90, qtIntervalMs: 360, pWaveDurationMs: 0, tWaveDurationMs: 160 }
  },
  stemi_inferior: {
    id: 'stemi_inferior',
    label: 'Inferior STEMI (II, III, aVF)',
    defaultHR: 80,
    hrClamp: { min: 40, max: 140 },
    intervals: { prIntervalMs: 160, qrsDurationMs: 90, qtIntervalMs: 400, pWaveDurationMs: 90, tWaveDurationMs: 180 }
  },
  stemi_anterior: {
    id: 'stemi_anterior',
    label: 'Anterior STEMI (V1–V4)',
    defaultHR: 80,
    hrClamp: { min: 40, max: 140 },
    intervals: { prIntervalMs: 160, qrsDurationMs: 90, qtIntervalMs: 400, pWaveDurationMs: 90, tWaveDurationMs: 180 }
  },
  stemi_lateral: {
    id: 'stemi_lateral',
    label: 'Lateral STEMI (I, V5–V6)',
    defaultHR: 80,
    hrClamp: { min: 40, max: 140 },
    intervals: { prIntervalMs: 160, qrsDurationMs: 90, qtIntervalMs: 400, pWaveDurationMs: 90, tWaveDurationMs: 180 }
  },
  avb1: {
    id: 'avb1',
    label: '1° AV Block',
    defaultHR: 70,
    hrClamp: { min: 40, max: 140 },
    intervals: { prIntervalMs: 260, qrsDurationMs: 90, qtIntervalMs: 410 }
  },
  avb2_mobitz1: {
    id: 'avb2_mobitz1',
    label: '2° AV Block (Mobitz I)',
    defaultHR: 65,
    hrClamp: { min: 40, max: 140 },
    intervals: { prIntervalMs: 200, qrsDurationMs: 90, qtIntervalMs: 410 }
  },
  avb2_mobitz2: {
    id: 'avb2_mobitz2',
    label: '2° AV Block (Mobitz II)',
    defaultHR: 60,
    hrClamp: { min: 35, max: 120 },
    intervals: { prIntervalMs: 190, qrsDurationMs: 110, qtIntervalMs: 420 }
  },
  avb2_2to1: {
    id: 'avb2_2to1',
    label: '2° AV Block (2:1)',
    defaultHR: 72,
    hrClamp: { min: 40, max: 140 },
    intervals: { prIntervalMs: 190, qrsDurationMs: 110, qtIntervalMs: 420 }
  },
  avb3: {
    id: 'avb3',
    label: '3° AV Block',
    defaultHR: 35,
    hrClamp: { min: 30, max: 50 },
    intervals: { prIntervalMs: 0, qrsDurationMs: 160, qtIntervalMs: 420 }
  },
  lbbb: {
    id: 'lbbb',
    label: 'Left Bundle Branch Block',
    defaultHR: 70,
    hrClamp: { min: 40, max: 140 },
    axisDeg: 0,
    intervals: { prIntervalMs: 160, qrsDurationMs: 160, qtIntervalMs: 430 }
  },
  rbbb: {
    id: 'rbbb',
    label: 'Right Bundle Branch Block',
    defaultHR: 70,
    hrClamp: { min: 40, max: 140 },
    intervals: { prIntervalMs: 160, qrsDurationMs: 170, qtIntervalMs: 438 }
  },
  lvh: {
    id: 'lvh',
    label: 'Left Ventricular Hypertrophy',
    defaultHR: 72,
    hrClamp: { min: 40, max: 140 },
    intervals: { prIntervalMs: 160, qrsDurationMs: 108, qtIntervalMs: 410 }
  },
  junctional_escape: {
    id: 'junctional_escape',
    label: 'Junctional Escape Rhythm',
    defaultHR: 50,
    hrClamp: { min: 40, max: 80 },
    intervals: { prIntervalMs: 0, qrsDurationMs: 90, qtIntervalMs: 400, pWaveDurationMs: 0, tWaveDurationMs: 180 }
  },
  paced_ventricular: {
    id: 'paced_ventricular',
    label: 'Ventricular Paced Rhythm',
    defaultHR: 60,
    hrClamp: { min: 40, max: 120 },
    intervals: { prIntervalMs: 0, qrsDurationMs: 170, qtIntervalMs: 430, pWaveDurationMs: 0, tWaveDurationMs: 180 }
  },
  paced_atrial: {
    id: 'paced_atrial',
    label: 'Atrial Paced Rhythm',
    defaultHR: 60,
    hrClamp: { min: 40, max: 120 },
    intervals: { prIntervalMs: 220, qrsDurationMs: 90, qtIntervalMs: 400, pWaveDurationMs: 90, tWaveDurationMs: 180 }
  },
  sinus_pvc_trigeminy: {
    id: 'sinus_pvc_trigeminy',
    label: 'Sinus Rhythm With PVC Trigeminy',
    defaultHR: 84,
    hrClamp: { min: 50, max: 140 },
    intervals: { prIntervalMs: 160, qrsDurationMs: 90, qtIntervalMs: 400 }
  },
  mvtach: {
    id: 'mvtach',
    label: 'Monomorphic Ventricular Tachycardia',
    defaultHR: 210,
    hrClamp: { min: 170, max: 240 },
    intervals: { prIntervalMs: 0, qrsDurationMs: 190, qtIntervalMs: 460 }
  },
  pvtach: {
    id: 'pvtach',
    label: 'Polymorphic Ventricular Tachycardia',
    defaultHR: 210,
    hrClamp: { min: 170, max: 240 },
    intervals: { prIntervalMs: 0, qrsDurationMs: 190, qtIntervalMs: 460 }
  }
};

const RHYTHM_IDS_IN_ORDER = Object.keys(RHYTHM_PRESETS);

class Ecg12Simulator {
  constructor(
    {
      backgroundCanvas,
      traceCanvas,
      overlayCanvas,
      bigBackgroundCanvas,
      bigTraceCanvas,
      bigOverlayCanvas
    },
    config = {}
  ) {
    this.backgroundCanvas = backgroundCanvas;
    this.traceCanvas = traceCanvas;
    this.overlayCanvas = overlayCanvas;
    this.bigBackgroundCanvas = bigBackgroundCanvas;
    this.bigTraceCanvas = bigTraceCanvas;
    this.bigOverlayCanvas = bigOverlayCanvas;

    this.backgroundCtx = backgroundCanvas.getContext('2d');
    this.traceCtx = traceCanvas.getContext('2d');
    this.overlayCtx = overlayCanvas ? overlayCanvas.getContext('2d') : null;
    this.bigBackgroundCtx = bigBackgroundCanvas ? bigBackgroundCanvas.getContext('2d') : null;
    this.bigTraceCtx = bigTraceCanvas ? bigTraceCanvas.getContext('2d') : null;
    this.bigOverlayCtx = bigOverlayCanvas ? bigOverlayCanvas.getContext('2d') : null;

    this.scrollContainer =
      (this.overlayCanvas && this.overlayCanvas.parentElement) ||
      (this.bigOverlayCanvas && this.bigOverlayCanvas.parentElement) ||
      null;

    this.pixelPerMm = PX_PER_MM_12;
    this.viewScale = 1;

    this.config = {
      displayTime: config.displayTime || 10,
      heartRate: config.heartRate || 75,
      speed: 25
    };
    this.currentRhythm = this.normalizeRhythmId(config.rhythm || 'sinus');
    this._seedBase = Math.floor(Math.random() * 0x7fffffff);
    this._seedCounter = 1;
    this.rngSeed = 0;
    this._rng = null;
    this._gaussSpare = null;
    this._afibNoise = [];
    this._afibNoiseDriftPhase = 0;
    this.stemiStMv = STEMI_CONFIG.stMv;
    this.caseStemiKind = null;
    this.caseStemiStMv = null;
    this.caseStemiLeadOverride = null;
    this.caseAfibBaselineGain = 1;
    this.caseAfibJitterGain = 1;
    this.casePWaveGain = 1;
    this.caseUWaveGain = 0;
    this.caseLvhGain = 1;
    this.caseLvhStrainGain = 1;
    this.caseLeadQrsGain = null;
    this.caseLeadQGain = null;
    this.caseLeadTGain = null;
    this.caseStOffsetOverride = null;
    this.caseQrsMorphologyOverride = null;
    this.caseQrsMinMs = null;
    this.initRhythmSeed();
    this.randomizeAfibPhases();
    this.debugLeadModel = false;
    this.debugLeadModelOverlay = false;

    this.showReadout = false;
    this.readoutHiddenText = 'Click to reveal';
    this.readoutBox = null;

    this.highlights = { P: false, QRS: false, T: false, Dropped: false };
    this.intervalHighlights = { PR: false, QRSd: false, QT: false, RR: false };
    const globalIntervalDebug =
      typeof window !== 'undefined' ? window.__ECG_INTERVAL_DEBUG : false;
    this.intervalDebug = globalIntervalDebug === true || globalIntervalDebug === 'true';
    this._intervalDebugTimestamps = {};
    this.measureToolEnabled = false;
    this.measurements = [];
    this.pendingMeasure = null;
    this._bigMouse = { x: 0, y: 0, inside: false };
    this._lastBigMsPerPixel = null;
    this.axisMode = this.normalizeAxisMode(config.axisMode || 'normal');
    this.axisDeg = this.axisDegFromMode(this.axisMode);
    if (typeof config.axisDeg === 'number') {
      this.setAxisDegrees(config.axisDeg);
    }
    this.showCalibrationPulse = true;

    this.selectedLead = 'II';
    this.selectedLeadKey = normLead(this.selectedLead);
    this.hoverLead = null;

    this.isPlaying = false;
    this.simulatedTimeMs = 0;
    this.lastFrameTime = 0;
    this.sweepStartTime = 0;
    this.shouldLoopSweep = true;
    this.singleRunState = null;
    this.highlightedLeads = new Set();

    this.intervals = { ...BASE_INTERVALS };
    const initialPreset = this.getPresetForId(this.currentRhythm);
    if (initialPreset) {
      this.config.heartRate = this.clampHeartRate(initialPreset.defaultHR ?? this.config.heartRate, initialPreset);
      this.applyPresetIntervals(initialPreset);
    }
    this.topReadoutHeight = 36;

    this.beatSchedule = [];
    this.atrialSchedule = [];
    this.rhythmDurationMs = 10000;
    this.viewports = [];
    this._leadConfigChecked = false;
    this._sampleCache = new Map();
    this._pvtachParams = this._seedPolymorphicTorsadesParameters();

    this.handleResize = this.handleResize.bind(this);
    this.tick = this.tick.bind(this);
    this.handleBigMouseMove = this.handleBigMouseMove.bind(this);
    this.handleBigMouseLeave = this.handleBigMouseLeave.bind(this);
    this.handleBigClick = this.handleBigClick.bind(this);
    this.handleBigDoubleClick = this.handleBigDoubleClick.bind(this);
    this.bigContainerObserver = null;

    this.handleResize();
    window.addEventListener('resize', this.handleResize);

    if (typeof window !== 'undefined' && 'ResizeObserver' in window && this.bigTraceCanvas) {
      const parent = this.bigTraceCanvas.parentElement;
      if (parent) {
        this.bigContainerObserver = new ResizeObserver(() => this.handleResize());
        this.bigContainerObserver.observe(parent);
      }
    }

    this.regenerateRhythm();
    this.drawGrid();
    this.drawBigGrid();
    this.reset();

    [this.bigTraceCanvas, this.bigOverlayCanvas].forEach((canvas) => {
      if (!canvas) return;
      canvas.addEventListener('mousemove', this.handleBigMouseMove);
      canvas.addEventListener('mouseleave', this.handleBigMouseLeave);
      canvas.addEventListener('click', this.handleBigClick);
      canvas.addEventListener('dblclick', this.handleBigDoubleClick);
    });
  }

  setHeartRate(bpm) {
    const preset = this.getCurrentPreset();
    const clampedValue = this.clampHeartRate(bpm, preset);
    if (clampedValue === this.config.heartRate) {
      return clampedValue;
    }
    this.config.heartRate = clampedValue;
    this.resetRandomness();
    if (this.currentRhythm === 'afib') {
      this.randomizeAfibPhases();
    }
    this.regenerateRhythm();
    this.sweepStartTime = this.simulatedTimeMs;
    return clampedValue;
  }

  setRhythm(rhythm) {
    const normalized = this.normalizeRhythmId(rhythm);
    const preset = this.getPresetForId(normalized);
    if (!preset) {
      console.warn(`[Ecg12Simulator] Unknown rhythm "${rhythm}", defaulting to sinus.`);
    }
    const nextRhythm = preset ? preset.id : 'sinus';
    if (nextRhythm === this.currentRhythm) {
      return;
    }
    this.currentRhythm = nextRhythm;
    this.caseStemiKind = null;
    this.caseStemiStMv = null;
    this.caseStemiLeadOverride = null;
    this.caseAfibBaselineGain = 1;
    this.caseAfibJitterGain = 1;
    this.casePWaveGain = 1;
    this.caseUWaveGain = 0;
    this.caseLvhGain = 1;
    this.caseLvhStrainGain = 1;
    this.caseLeadQrsGain = null;
    this.caseLeadQGain = null;
    this.caseLeadTGain = null;
    this.caseStOffsetOverride = null;
    this.caseQrsMorphologyOverride = null;
    this.caseQrsMinMs = null;
    const targetPreset = preset || this.getPresetForId('sinus');
    if (targetPreset) {
      this.config.heartRate = this.clampHeartRate(
        targetPreset.defaultHR ?? this.config.heartRate,
        targetPreset
      );
      this.applyPresetIntervals(targetPreset);
      if (Number.isFinite(targetPreset.axisDeg)) {
        this.axisDeg = clamp(targetPreset.axisDeg, -180, 180);
        this.axisMode = this.axisModeFromDeg(this.axisDeg);
      }
    }
    this.resetRandomness();
    if (this.currentRhythm === 'afib') {
      this.randomizeAfibPhases();
    }
    this.regenerateRhythm();
    if (this.currentRhythm === 'avb2_mobitz2' || this.currentRhythm === 'avb2_2to1') {
      this.logMobitz2SelfCheck();
    }
    this.sweepStartTime = this.simulatedTimeMs;
  }

  setHighlights(cfg) {
    this.highlights = { ...this.highlights, ...cfg };
  }

  setHighlightedLeads(leads) {
    if (!this.highlightedLeads) this.highlightedLeads = new Set();
    this.highlightedLeads.clear();
    if (Array.isArray(leads)) {
      leads.forEach((lead) => {
        const key = normLead(lead);
        if (key) this.highlightedLeads.add(key);
      });
    }
    this.drawTrace?.();
  }

  setIntervalHighlights(cfg) {
    this.intervalHighlights = { ...this.intervalHighlights, ...cfg };
    this.intervalDebugImmediate('setIntervalHighlights', {
      cfg,
      highlights: this.intervalHighlights
    });
  }

  clearInteractiveHighlights() {
    this.setHighlightedLeads([]);
    this.setHighlights({ P: false, QRS: false, T: false, Dropped: false });
    this.setIntervalHighlights({ PR: false, QRSd: false, QT: false, RR: false });
    this.drawTrace?.();
    this.drawExpandedTrace?.();
    this.drawReadoutOverlay?.();
  }

  intervalDebugImmediate(label, info) {
    if (!this.intervalDebug) return;
    console.log('[Ecg12Simulator][IntervalDebug]', label, info);
  }

  intervalDebugLog(label, info) {
    if (!this.intervalDebug) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const last = this._intervalDebugTimestamps[label] || 0;
    const threshold = 500;
    if (now - last < threshold) return;
    this._intervalDebugTimestamps[label] = now;
    console.log('[Ecg12Simulator][IntervalDebug]', label, info);
  }

  setAxisDegrees(deg) {
    const clamped = Math.max(-180, Math.min(180, typeof deg === 'number' ? deg : 0));
    if (this.axisDeg === clamped) return;
    this.axisDeg = clamped;
    this.axisMode = this.axisModeFromDeg(clamped);
    this.drawTrace();
    this.drawExpandedTrace();
  }

  setAxisMode(mode) {
    const normalized = this.normalizeAxisMode(mode);
    if (this.axisMode === normalized) return;
    this.axisMode = normalized;
    this.axisDeg = this.axisDegFromMode(normalized);
    this.drawTrace();
    this.drawExpandedTrace();
  }

  setIntervals({ prMs, qrsMs, qtMs, pWaveMs, tWaveMs } = {}) {
    const next = { ...this.intervals };
    if (Number.isFinite(prMs)) next.prIntervalMs = clamp(prMs, 0, 500);
    if (Number.isFinite(qrsMs)) next.qrsDurationMs = clamp(qrsMs, 60, 260);
    if (Number.isFinite(qtMs)) next.qtIntervalMs = clamp(qtMs, 260, 700);
    if (Number.isFinite(pWaveMs)) next.pWaveDurationMs = clamp(pWaveMs, 0, 200);
    if (Number.isFinite(tWaveMs)) next.tWaveDurationMs = clamp(tWaveMs, 80, 320);
    if (
      next.prIntervalMs === this.intervals.prIntervalMs &&
      next.qrsDurationMs === this.intervals.qrsDurationMs &&
      next.qtIntervalMs === this.intervals.qtIntervalMs &&
      next.pWaveDurationMs === this.intervals.pWaveDurationMs &&
      next.tWaveDurationMs === this.intervals.tWaveDurationMs
    ) {
      return;
    }
    this.intervals = next;
    this.regenerateRhythm();
    this.sweepStartTime = this.simulatedTimeMs;
  }

  setCaseState({ rhythmId, heartRate, axisMode, intervals, findings, style, autoLeadHighlights = true } = {}) {
    if (rhythmId) {
      const desiredRhythm = this.normalizeRhythmId(rhythmId);
      if (desiredRhythm !== this.currentRhythm) {
        this.setRhythm(desiredRhythm);
      }
    }
    if (Number.isFinite(heartRate)) {
      const targetHr = this.clampHeartRate(heartRate, this.getCurrentPreset());
      if (targetHr !== this.config.heartRate) {
        this.setHeartRate(targetHr);
      }
    }
    if (axisMode) this.setAxisMode(axisMode);
    if (intervals && typeof intervals === 'object') {
      this.setIntervals({
        prMs: intervals.pr_ms,
        qrsMs: intervals.qrs_ms,
        qtMs: intervals.qt_ms,
        pWaveMs: intervals.p_wave_ms,
        tWaveMs: intervals.t_wave_ms
      });
    }
    const normalizedFindings = Array.isArray(findings)
      ? findings.map((v) => String(v || '').toLowerCase())
      : [];
    const styleCfg = style && typeof style === 'object' ? style : {};
    this.caseStemiStMv = Number.isFinite(styleCfg.stemiMv)
      ? clamp(styleCfg.stemiMv, 0.05, 0.8)
      : null;
    this.caseAfibBaselineGain = Number.isFinite(styleCfg.afibBaselineGain)
      ? clamp(styleCfg.afibBaselineGain, 0.5, 2.5)
      : 1;
    this.caseAfibJitterGain = Number.isFinite(styleCfg.afibJitterGain)
      ? clamp(styleCfg.afibJitterGain, 0.5, 2.5)
      : 1;
    this.casePWaveGain = Number.isFinite(styleCfg.pWaveGain)
      ? clamp(styleCfg.pWaveGain, 0.3, 3.0)
      : 1;
    this.caseUWaveGain = Number.isFinite(styleCfg.uWaveGain)
      ? clamp(styleCfg.uWaveGain, 0, 3.0)
      : 0;
    this.caseLvhGain = Number.isFinite(styleCfg.lvhGain)
      ? clamp(styleCfg.lvhGain, 0.6, 2.5)
      : 1;
    this.caseLvhStrainGain = Number.isFinite(styleCfg.lvhStrainGain)
      ? clamp(styleCfg.lvhStrainGain, 0.6, 2.5)
      : 1;
    this.caseLeadQrsGain =
      styleCfg.leadQrsGain && typeof styleCfg.leadQrsGain === 'object'
        ? Object.fromEntries(
            Object.entries(normalizeLeadMap(styleCfg.leadQrsGain))
              .filter(([, v]) => Number.isFinite(Number(v)))
              .map(([k, v]) => [k, clamp(Number(v), 0.3, 3.0)])
          )
        : null;
    this.caseLeadQGain =
      styleCfg.leadQGain && typeof styleCfg.leadQGain === 'object'
        ? Object.fromEntries(
            Object.entries(normalizeLeadMap(styleCfg.leadQGain))
              .filter(([, v]) => Number.isFinite(Number(v)))
              .map(([k, v]) => [k, clamp(Number(v), 0, 4.0)])
          )
        : null;
    this.caseLeadTGain =
      styleCfg.leadTGain && typeof styleCfg.leadTGain === 'object'
        ? Object.fromEntries(
            Object.entries(normalizeLeadMap(styleCfg.leadTGain))
              .filter(([, v]) => Number.isFinite(Number(v)))
              .map(([k, v]) => [k, clamp(Number(v), -3.0, 3.0)])
          )
        : null;
    const morphologyOverride = String(styleCfg.qrsMorphology || '').toLowerCase();
    this.caseQrsMorphologyOverride = ['lbbb', 'rbbb', 'lvh', 'wpw'].includes(morphologyOverride)
      ? morphologyOverride
      : null;
    this.caseQrsMinMs = Number.isFinite(styleCfg.qrsMinMs)
      ? clamp(styleCfg.qrsMinMs, 100, 260)
      : null;
    this.caseStOffsetOverride =
      styleCfg.stOffsetMv && typeof styleCfg.stOffsetMv === 'object'
        ? Object.fromEntries(
            Object.entries(normalizeLeadMap(styleCfg.stOffsetMv))
              .filter(([, v]) => Number.isFinite(Number(v)))
              .map(([k, v]) => [k, clamp(Number(v), -0.4, 0.4)])
          )
        : null;
    this.caseStemiLeadOverride =
      styleCfg.stemiLeadOverride && typeof styleCfg.stemiLeadOverride === 'object'
        ? normalizeLeadMap(styleCfg.stemiLeadOverride)
        : null;
    if (normalizedFindings.includes('stemi_inferior')) {
      this.caseStemiKind = 'inferior';
    } else if (normalizedFindings.includes('stemi_anterior')) {
      this.caseStemiKind = 'anterior';
    } else if (normalizedFindings.includes('stemi_lateral')) {
      this.caseStemiKind = 'lateral';
    } else {
      this.caseStemiKind = null;
    }
    if (autoLeadHighlights) {
      if (normalizedFindings.includes('stemi_inferior')) {
        this.setHighlightedLeads(['II', 'III', 'aVF']);
      } else if (normalizedFindings.includes('stemi_anterior')) {
        this.setHighlightedLeads(['V1', 'V2', 'V3', 'V4']);
      } else if (normalizedFindings.includes('stemi_lateral')) {
        this.setHighlightedLeads(['I', 'aVL', 'V5', 'V6']);
      } else {
        this.setHighlightedLeads([]);
      }
    } else {
      this.setHighlightedLeads([]);
    }
    this.drawTrace();
    this.drawExpandedTrace();
  }

  setLoopingEnabled(looping = true) {
    this.shouldLoopSweep = looping !== false;
  }

  isLoopingEnabled() {
    return this.shouldLoopSweep;
  }

  cancelSingleRun(resolve = false) {
    if (!this.singleRunState) return;
    const pending = this.singleRunState;
    this.singleRunState = null;
    if (resolve && typeof pending.resolve === 'function') {
      try {
        pending.resolve();
      } catch (err) {
        console.warn('[Ecg12Simulator] Error resolving single-run promise', err);
      }
    }
  }

  computeSweepDurationMs() {
    const pxPerMm = this.pixelPerMm || PX_PER_MM_12;
    const msPerPixel = 1000 / (this.config.speed * pxPerMm);
    const width = this.renderWidth || (this.traceCanvas ? this.traceCanvas.clientWidth : 0);
    if (width > 0 && Number.isFinite(msPerPixel) && msPerPixel > 0) {
      return width * msPerPixel;
    }
    return Math.max(1000, (this.config.displayTime || 10) * 1000);
  }

  renderOnceAndFreeze() {
    if (!this.traceCanvas) return Promise.resolve();
    this.cancelSingleRun(true);
    this.pause();
    this.setLoopingEnabled(false);
    this.simulatedTimeMs = 0;
    this.sweepStartTime = 0;
    this.drawTrace();
    this.drawExpandedTrace();
    const durationMs = Math.max(1, this.computeSweepDurationMs());
    return new Promise((resolve) => {
      this.singleRunState = {
        active: true,
        targetMs: durationMs,
        resolve
      };
      this.play();
    });
  }

  getAxisMode() {
    return this.axisMode;
  }

  normalizeAxisMode(mode) {
    switch ((mode || '').toLowerCase()) {
      case 'lad':
        return 'lad';
      case 'rad':
        return 'rad';
      case 'extreme':
        return 'extreme';
      case 'normal':
      default:
        return 'normal';
    }
  }

  axisDegFromMode(mode) {
    switch (this.normalizeAxisMode(mode)) {
      case 'lad':
        return -60;
      case 'rad':
        return 120;
      case 'extreme':
        return -120;
      case 'normal':
      default:
        return 60;
    }
  }

  axisModeFromDeg(deg) {
    const d = degWrap(deg);
    if (d >= 0 && d <= 90) return 'normal';
    if (d < 0 && d >= -90) return 'lad';
    if (d > 90 && d <= 180) return 'rad';
    return 'extreme';
  }

  normalizeRhythmId(id) {
    const key = String(id || '').toLowerCase();
    return RHYTHM_PRESETS[key] ? key : 'sinus';
  }

  getPresetForId(id) {
    const key = this.normalizeRhythmId(id);
    return RHYTHM_PRESETS[key];
  }

  getCurrentPreset() {
    return this.getPresetForId(this.currentRhythm);
  }

  getRhythmList() {
    return RHYTHM_IDS_IN_ORDER.map((id) => ({
      id,
      label: RHYTHM_PRESETS[id]?.label || id
    }));
  }

  getCurrentRhythm() {
    return this.currentRhythm;
  }

  isStemiRhythm(rhythm = this.currentRhythm) {
    return !!this.getStemiKind(rhythm);
  }

  getStemiKind(rhythm = this.currentRhythm) {
    const id = this.normalizeRhythmId(rhythm);
    if (!STEMI_IDS.includes(id)) {
      if (rhythm === this.currentRhythm && this.caseStemiKind) return this.caseStemiKind;
      return null;
    }
    if (id.endsWith('inferior')) return 'inferior';
    if (id.endsWith('anterior')) return 'anterior';
    if (id.endsWith('lateral')) return 'lateral';
    return null;
  }

  getStemiLeadMultiplier(leadKey, rhythm = this.currentRhythm) {
    const kind = this.getStemiKind(rhythm);
    if (!kind) return 0;
    const key = normLead(leadKey);
    if (this.caseStemiLeadOverride && Object.prototype.hasOwnProperty.call(this.caseStemiLeadOverride, key)) {
      return this.caseStemiLeadOverride[key];
    }
    const map = STEMI_LEAD_MAPS[kind] || {};
    return map[key] || 0;
  }

  getHeartRate() {
    return Math.round(this.config.heartRate);
  }

  getHeartRateClamp() {
    const preset = this.getCurrentPreset();
    return preset?.hrClamp || DEFAULT_HR_CLAMP;
  }

  clampHeartRate(value, preset = this.getCurrentPreset()) {
    const clampRange = preset?.hrClamp || DEFAULT_HR_CLAMP;
    const numeric = Number(value);
    const fallback = this.config.heartRate || clampRange.min;
    const target = Number.isFinite(numeric) ? numeric : fallback;
    return clamp(target, clampRange.min, clampRange.max);
  }

  getCurrentRrMs() {
    return 60000 / Math.max(10, this.config.heartRate || 60);
  }

  applyPresetIntervals(preset) {
    if (!preset) return;
    const intervals = preset.intervals || {};
    this.intervals = {
      prIntervalMs: intervals.prIntervalMs ?? BASE_INTERVALS.prIntervalMs,
      qrsDurationMs: intervals.qrsDurationMs ?? BASE_INTERVALS.qrsDurationMs,
      qtIntervalMs: intervals.qtIntervalMs ?? BASE_INTERVALS.qtIntervalMs,
      pWaveDurationMs: intervals.pWaveDurationMs ?? BASE_INTERVALS.pWaveDurationMs,
      tWaveDurationMs: intervals.tWaveDurationMs ?? BASE_INTERVALS.tWaveDurationMs
    };
  }

  setSelectedLead(leadId) {
    const key = normLead(leadId);
    if (!leadId || !ALL_LEAD_KEYS.includes(key)) return;
    this.selectedLead = leadId;
    this.selectedLeadKey = key;
    this.drawExpandedTrace();
  }

  getSelectedLead() {
    return this.selectedLead;
  }

  setHoverLead(leadId) {
    this.hoverLead = leadId;
  }

  setMeasureToolEnabled(on) {
    const enabled = !!on;
    if (this.measureToolEnabled === enabled) return;
    this.measureToolEnabled = enabled;
    if (!enabled) {
      this.clearMeasurements(false);
    }
    this.drawExpandedTrace();
  }

  clearMeasurements(redraw = true) {
    this.measurements = [];
    this.pendingMeasure = null;
    this.onMeasurementsChange?.(this.measurements.length);
    if (redraw) this.drawExpandedTrace();
  }

  getBigCanvasPoint(event) {
    const canvas = this.bigTraceCanvas;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const width = canvas.clientWidth || rect.width;
    const height = canvas.clientHeight || rect.height;
    if (!rect.width || !rect.height) return null;
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const y = ((event.clientY - rect.top) / rect.height) * height;
    return { x, y };
  }

  getOrthogonalMeasurePoint(anchor, point) {
    const dx = point.x - anchor.x;
    const dy = point.y - anchor.y;
    if (Math.abs(dy) >= Math.abs(dx)) {
      return { x: anchor.x, y: point.y };
    }
    return { x: point.x, y: anchor.y };
  }

  handleBigMouseMove(event) {
    if (!this.measureToolEnabled) return;
    const point = this.getBigCanvasPoint(event);
    if (!point) return;
    this._bigMouse = { ...point, inside: true };
    if (this.pendingMeasure) {
      const snapped = this.getOrthogonalMeasurePoint(
        { x: this.pendingMeasure.ax, y: this.pendingMeasure.ay },
        point
      );
      this.pendingMeasure.bx = snapped.x;
      this.pendingMeasure.by = snapped.y;
    }
    this.drawExpandedTrace();
  }

  handleBigMouseLeave() {
    this._bigMouse = { x: 0, y: 0, inside: false };
  }

  handleBigClick(event) {
    if (!this.measureToolEnabled) return;
    const point = this.getBigCanvasPoint(event);
    if (!point) return;
    const hitIndex = this.findMeasurementAtPoint(point);
    if (hitIndex !== -1) {
      return;
    }

    if (!this.pendingMeasure) {
      if (!event.shiftKey) {
        this.clearMeasurements(false);
      }
      this.pendingMeasure = {
        ax: point.x,
        ay: point.y,
        bx: point.x,
        by: point.y,
        live: true
      };
    } else {
      const snapped = this.getOrthogonalMeasurePoint(
        { x: this.pendingMeasure.ax, y: this.pendingMeasure.ay },
        point
      );
      this.measurements.push({
        ax: this.pendingMeasure.ax,
        ay: this.pendingMeasure.ay,
        bx: snapped.x,
        by: snapped.y
      });
      this.pendingMeasure = null;
      this.onMeasurementsChange?.(this.measurements.length);
    }
    this.drawExpandedTrace();
  }

  handleBigDoubleClick(event) {
    if (!this.measureToolEnabled) return;
    const point = this.getBigCanvasPoint(event);
    if (!point) return;
    const hitIndex = this.findMeasurementAtPoint(point);
    if (hitIndex !== -1) {
      this.measurements.splice(hitIndex, 1);
      this.onMeasurementsChange?.(this.measurements.length);
      this.drawExpandedTrace();
      event.preventDefault();
    }
  }

  findMeasurementAtPoint(point, tolerance = 8) {
    if (!Array.isArray(this.measurements) || !this.measurements.length) return -1;
    for (let i = this.measurements.length - 1; i >= 0; i--) {
      const m = this.measurements[i];
      if (this.measurementContainsPoint(m, point, tolerance)) {
        return i;
      }
    }
    return -1;
  }

  measurementContainsPoint(measurement, point, tolerance = 8) {
    if (!measurement) return false;
    const bounds = measurement.labelBounds;
    if (bounds) {
      if (
        point.x >= bounds.x &&
        point.x <= bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y <= bounds.y + bounds.height
      ) {
        return true;
      }
    }
    const dist = this.pointToSegmentDistance(
      measurement.ax,
      measurement.ay,
      measurement.bx,
      measurement.by,
      point.x,
      point.y
    );
    return dist <= tolerance;
  }

  pointToSegmentDistance(ax, ay, bx, by, px, py) {
    const dx = bx - ax;
    const dy = by - ay;
    if (dx === 0 && dy === 0) {
      const ddx = px - ax;
      const ddy = py - ay;
      return Math.sqrt(ddx * ddx + ddy * ddy);
    }
    const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    const clamped = Math.max(0, Math.min(1, t));
    const cx = ax + clamped * dx;
    const cy = ay + clamped * dy;
    const ddx = px - cx;
    const ddy = py - cy;
    return Math.sqrt(ddx * ddx + ddy * ddy);
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

  reset() {
    this.cancelSingleRun();
    this.simulatedTimeMs = 0;
    this.sweepStartTime = 0;
    this.drawTrace();
    this.drawExpandedTrace();
  }

  tick(timestamp) {
    if (!this.isPlaying) return;
    if (!this.lastFrameTime) this.lastFrameTime = timestamp;
    const dt = timestamp - this.lastFrameTime;
    this.lastFrameTime = timestamp;
    this.simulatedTimeMs += dt;
    const singleRunActive = this.singleRunState && this.singleRunState.active;
    const targetMs = singleRunActive ? this.singleRunState.targetMs : 0;
    if (singleRunActive && this.simulatedTimeMs >= targetMs) {
      this.simulatedTimeMs = targetMs;
    }
    this.drawTrace();
    this.drawExpandedTrace();
    if (singleRunActive && this.simulatedTimeMs >= targetMs) {
      const resolver = this.singleRunState.resolve;
      this.singleRunState = null;
      this.pause();
      if (typeof resolver === 'function') {
        resolver();
      }
      return;
    }
    requestAnimationFrame(this.tick);
  }

  handleResize() {
    const dpr = window.devicePixelRatio || 1;
    const REQUIRED_MM = 250;
    const paperCssWidth = Math.round(REQUIRED_MM * this.pixelPerMm * this.viewScale);
    const containerCssWidth = this.scrollContainer ? this.scrollContainer.clientWidth : 0;
    const requiredCssWidth = Math.max(paperCssWidth, containerCssWidth);
    const mainHeight = this.traceCanvas.clientHeight || 320;
    const bigParentHeight = this.bigTraceCanvas?.parentElement?.clientHeight || 0;
    const bigHeight = this.bigTraceCanvas ? (bigParentHeight || this.bigTraceCanvas.clientHeight || 220) : 220;

    const resizeCanvas = (canvas, height) => {
      if (!canvas) return;
      canvas.style.width = `${requiredCssWidth}px`;
      canvas.style.height = `${height}px`;
      canvas.width = Math.floor(requiredCssWidth * dpr);
      canvas.height = Math.floor(height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resizeCanvas(this.backgroundCanvas, mainHeight);
    resizeCanvas(this.traceCanvas, mainHeight);
    resizeCanvas(this.overlayCanvas, mainHeight);
    resizeCanvas(this.bigBackgroundCanvas, bigHeight);
    resizeCanvas(this.bigTraceCanvas, bigHeight);
    resizeCanvas(this.bigOverlayCanvas, bigHeight);

    this.renderWidth = requiredCssWidth;
    this.renderHeight = mainHeight;
    this.bigRenderHeight = bigHeight;

    this.computeViewports();
    this.drawGrid();
    this.drawBigGrid();
    this.drawTrace();
    this.drawExpandedTrace();
  }

  computeViewports() {
    const cols = LEADS_12[0].length;
    const rows = LEADS_12.length;
    const gutterX = 8;
    const gutterY = 8;
    const w = this.renderWidth || (this.traceCanvas ? this.traceCanvas.clientWidth : 0);
    const h =
      (this.renderHeight || (this.traceCanvas ? this.traceCanvas.clientHeight : 0)) -
      this.topReadoutHeight;

    const tileWidth = (w - gutterX * (cols + 1)) / cols;
    const tileHeight = (h - GRID_TOP_PADDING_PX - gutterY * (rows + 1)) / rows;
    const viewports = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const leadLabel = LEADS_12[r][c];
        const x = gutterX + c * (tileWidth + gutterX);
        const y = this.topReadoutHeight + GRID_TOP_PADDING_PX + gutterY + r * (tileHeight + gutterY);
        viewports.push({
          leadLabel,
          leadKey: normLead(leadLabel),
          x,
          y,
          width: tileWidth,
          height: tileHeight
        });
      }
    }

    this.viewports = viewports;
  }

  drawGrid() {
    if (!this.backgroundCtx) return;
    const ctx = this.backgroundCtx;
    const width = this.renderWidth || this.backgroundCanvas.clientWidth || 0;
    const height = this.renderHeight || this.backgroundCanvas.clientHeight || 0;
    ctx.clearRect(0, 0, width, height);
    this.drawGridOnCanvas(ctx, width, height);
  }

  drawBigGrid() {
    if (!this.bigBackgroundCtx || !this.bigBackgroundCanvas) return;
    const ctx = this.bigBackgroundCtx;
    const width = this.bigBackgroundCanvas.clientWidth || this.renderWidth || 0;
    const height = this.bigBackgroundCanvas.clientHeight || this.bigRenderHeight || 0;
    ctx.clearRect(0, 0, width, height);
    this.drawGridOnCanvas(ctx, width, height);
  }

  drawGridOnCanvas(ctx, width, height) {
    ctx.clearRect(0, 0, width, height);
    const px = this.pixelPerMm;
    const big = px * 5;
    ctx.strokeStyle = 'rgba(255,180,180,0.25)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (let x = 0; x < width; x += px) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
    }
    for (let y = 0; y < height; y += px) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,120,120,0.45)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let x = 0; x < width; x += big) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
    }
    for (let y = 0; y < height; y += big) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
    }
    ctx.stroke();
  }

  drawTrace() {
    const ctx = this.traceCtx;
    if (!ctx) return;
    const w = this.renderWidth || this.traceCanvas.clientWidth || 0;
    const h = this.renderHeight || this.traceCanvas.clientHeight || 0;
    ctx.clearRect(0, 0, w, h);

    if (!this.highlightedLeads) this.highlightedLeads = new Set();

    const pxPerMm = this.pixelPerMm;
    const msPerPixel = 1000 / (this.config.speed * pxPerMm);
    this._lastBigMsPerPixel = msPerPixel;
    const windowMs = w * msPerPixel;
    const duration = this.rhythmDurationMs || windowMs || 1;
    let elapsedInSweep = this.simulatedTimeMs - this.sweepStartTime;
    if (this.shouldLoopSweep) {
      if (duration <= windowMs) {
        // Align sweep to rhythm boundary to avoid mid-strip wraps in the R-R spacing.
        const cycleStart = Math.floor(this.simulatedTimeMs / duration) * duration;
        this.sweepStartTime = cycleStart;
        elapsedInSweep = this.simulatedTimeMs - cycleStart;
      } else if (elapsedInSweep >= windowMs || elapsedInSweep < 0) {
        this.sweepStartTime = this.simulatedTimeMs;
        elapsedInSweep = 0;
      }
    } else {
      elapsedInSweep = clamp(elapsedInSweep, 0, windowMs);
    }
    const sweepProgress = Math.min(elapsedInSweep / windowMs, 1);
    const xMax = Math.max(1, Math.floor(sweepProgress * (w - 1)));
    const sweepCursorVisible = this.shouldLoopSweep || (this.singleRunState && this.singleRunState.active);

    this.viewports.forEach((vp) => {
      const leadLabel = vp.leadLabel;
      const leadKey = vp.leadKey;
      ctx.save();
      // Allow high-voltage complexes to intrude into the row above, like printed ECG paper.
      // Lower rows are drawn later, so their overlap appears on top of the row above.
      const overlapUpPx = Math.min(vp.y, vp.height * 0.95);
      const overlapDownPx = 6;
      ctx.beginPath();
      ctx.rect(vp.x, vp.y - overlapUpPx, vp.width, vp.height + overlapUpPx + overlapDownPx);
      ctx.clip();

      ctx.fillStyle = 'rgba(15,23,42,0.65)';
      ctx.font = '12px Arial';
      ctx.textBaseline = 'top';
      const labelX = vp.x + 6;
      const labelY = vp.y + 14;
      const labelPaddingX = 4;
      const labelPaddingY = 2;
      const labelHeight = 14;
      const labelWidth = ctx.measureText(leadLabel).width + labelPaddingX * 2;
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.strokeStyle = 'rgba(15,23,42,0.08)';
      ctx.beginPath();
      this.roundedRectPath(ctx, labelX - labelPaddingX, labelY - labelPaddingY, labelWidth, labelHeight, 4);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = 'rgba(15,23,42,0.8)';
      ctx.fillText(leadLabel, labelX, labelY);
      ctx.textBaseline = 'alphabetic';

      if (this.highlightedLeads && this.highlightedLeads.has(leadKey)) {
        ctx.strokeStyle = '#f97316';
        ctx.lineWidth = 2;
        ctx.strokeRect(vp.x + 2, vp.y + 2, vp.width - 4, vp.height - 4);
      }

      if (this.debugLeadModelOverlay) {
        const dbgGain = this.getLeadDebugGain(leadKey);
        ctx.fillStyle = 'rgba(30,41,59,0.65)';
        ctx.font = '10px "SFMono-Regular", monospace';
        ctx.fillText(`g=${dbgGain.toFixed(2)}`, vp.x + 6, vp.y + 18);
        ctx.fillStyle = 'rgba(15,23,42,0.65)';
        ctx.font = '12px Arial';
      }

      const baselineYRaw = vp.y + vp.height * 0.5 + TILE_BASELINE_SHIFT_PX;
      const baselineY = Math.max(
        vp.y + TILE_EDGE_PAD_PX,
        Math.min(vp.y + vp.height - TILE_EDGE_PAD_PX, baselineYRaw)
      );
      ctx.strokeStyle = 'rgba(148,163,184,0.5)';
      ctx.beginPath();
      ctx.moveTo(vp.x, baselineY + 0.5);
      ctx.lineTo(vp.x + vp.width, baselineY + 0.5);
      ctx.stroke();

      const baseTime = this.sweepStartTime;
      // Keep 12-lead morphology visually aligned with expanded lead in high-voltage
      // profiles by using fixed scaling; preserve adaptive fit for other rhythms.
      const activeMorphology = String(this.caseQrsMorphologyOverride || '').toLowerCase();
      const fixedScaleProfiles = new Set(['lbbb', 'lvh']);
      const isFixedScaleProfile = fixedScaleProfiles.has(activeMorphology);
      const rhythmFixedScale = fixedScaleProfiles.has(String(this.currentRhythm || '').toLowerCase());
      let leadTileScale = MAIN_TRACE_VERTICAL_SCALE;
      if (!(isFixedScaleProfile || rhythmFixedScale)) {
        let maxPos = 0;
        let maxNeg = 0;
        const probeStepPx = 2;
        for (let px = 0; px <= xMax; px += probeStepPx) {
          const tProbe = baseTime + px * msPerPixel;
          const vProbe = this.getLeadVoltageAtTimeMs(tProbe, leadKey);
          if (vProbe > maxPos) maxPos = vProbe;
          if (vProbe < 0) maxNeg = Math.max(maxNeg, -vProbe);
        }
        const topBound = vp.y + TILE_EDGE_PAD_PX;
        const bottomBound = vp.y + vp.height - TILE_EDGE_PAD_PX;
        const availTop = Math.max(10, baselineY - topBound);
        const availBottom = Math.max(10, bottomBound - baselineY);
        let fitRatio = 1;
        const scaledTop = maxPos * MAIN_TRACE_VERTICAL_SCALE;
        const scaledBottom = maxNeg * MAIN_TRACE_VERTICAL_SCALE;
        if (scaledTop > availTop) fitRatio = Math.min(fitRatio, availTop / scaledTop);
        if (scaledBottom > availBottom) fitRatio = Math.min(fitRatio, availBottom / scaledBottom);
        leadTileScale = MAIN_TRACE_VERTICAL_SCALE * clamp(fitRatio * 0.98, 0.45, 1.0);
      }

      const mV0 = this.getLeadVoltageAtTimeMs(baseTime, leadKey) * leadTileScale;
      let prevY = baselineY - mV0;
      let prevType = this.waveTypeAtTime(baseTime);
      ctx.beginPath();
      ctx.strokeStyle = this.colorForWave(prevType);
      ctx.moveTo(vp.x, prevY);

      for (let x = 1; x <= xMax; x++) {
        const canvasX = vp.x + x;
        if (canvasX > vp.x + vp.width) break;
        const tMs = baseTime + x * msPerPixel;
        const leadVal = this.getLeadVoltageAtTimeMs(tMs, leadKey) * leadTileScale;
        const waveType = this.waveTypeAtTime(tMs);
        const y = baselineY - leadVal;

        if (waveType !== prevType) {
          ctx.lineTo(canvasX, y);
          ctx.stroke();
          ctx.beginPath();
          ctx.strokeStyle = this.colorForWave(waveType);
          ctx.moveTo(canvasX, y);
          prevType = waveType;
        } else {
          ctx.lineTo(canvasX, y);
        }
        prevY = y;
      }

      ctx.stroke();

      if (sweepCursorVisible) {
        ctx.strokeStyle = '#16a34a';
        ctx.beginPath();
        const sweepX = vp.x + Math.min(xMax, vp.width - 1) + 0.5;
        ctx.moveTo(sweepX, vp.y);
        ctx.lineTo(sweepX, vp.y + vp.height);
        ctx.stroke();
      }
      ctx.restore();
    });
    this.drawReadoutOverlay();
  }

  drawExpandedTrace() {
    const ctx = this.bigTraceCtx;
    if (!ctx) return;
    const w = this.bigBackgroundCanvas ? this.bigBackgroundCanvas.clientWidth : this.renderWidth;
    const h = this.bigBackgroundCanvas ? this.bigBackgroundCanvas.clientHeight : this.bigRenderHeight;
    ctx.clearRect(0, 0, w, h);

    const pxPerMm = this.pixelPerMm;
    const msPerPixel = 1000 / (this.config.speed * pxPerMm);
    const windowMs = (this.renderWidth || w) * msPerPixel;
    const duration = this.rhythmDurationMs || windowMs || 1;
    let elapsedInSweep = this.simulatedTimeMs - this.sweepStartTime;
    if (this.shouldLoopSweep) {
      if (duration <= windowMs) {
        // Align sweep to rhythm boundary to avoid mid-strip wraps in the R-R spacing.
        const cycleStart = Math.floor(this.simulatedTimeMs / duration) * duration;
        this.sweepStartTime = cycleStart;
        elapsedInSweep = this.simulatedTimeMs - cycleStart;
      } else if (elapsedInSweep >= windowMs || elapsedInSweep < 0) {
        this.sweepStartTime = this.simulatedTimeMs;
        elapsedInSweep = 0;
      }
    } else {
      elapsedInSweep = clamp(elapsedInSweep, 0, windowMs);
    }
    const sweepProgress = Math.min(elapsedInSweep / windowMs, 1);
    const xMax = Math.max(1, Math.floor(sweepProgress * ((this.renderWidth || w) - 1)));

    const baselineY = h * 0.45;
    const overlayBandHeight = clamp(h * 0.35, 90, 130);
    const overlayTopY = Math.min(baselineY + overlayBandHeight * 0.25, h - overlayBandHeight - 8);
    const leadLabel = this.selectedLead;
    const leadKey = this.selectedLeadKey || normLead(leadLabel);

    const baseTime = this.sweepStartTime;
    let prevType = this.waveTypeAtTime(baseTime);
    ctx.beginPath();
    ctx.strokeStyle = this.colorForWave(prevType);
    ctx.moveTo(0, baselineY - this.getLeadVoltageAtTimeMs(baseTime, leadKey));

    for (let x = 1; x <= xMax; x++) {
      const tMs = baseTime + x * msPerPixel;
      const val = this.getLeadVoltageAtTimeMs(tMs, leadKey);
      const waveType = this.waveTypeAtTime(tMs);
      const y = baselineY - val;

      if (waveType !== prevType) {
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.strokeStyle = this.colorForWave(waveType);
        ctx.moveTo(x, y);
        prevType = waveType;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    const sweepCursorVisible = this.shouldLoopSweep || (this.singleRunState && this.singleRunState.active);
    if (sweepCursorVisible) {
      ctx.strokeStyle = '#16a34a';
      ctx.beginPath();
      ctx.moveTo(xMax + 0.5, 0);
      ctx.lineTo(xMax + 0.5, h);
      ctx.stroke();
    }

    if (this.showCalibrationPulse) {
      this.drawCalibrationPulse(ctx, baselineY, msPerPixel, overlayTopY, h);
    }

    if (this.bigOverlayCtx) {
      this.bigOverlayCtx.clearRect(0, 0, w, h);
      this.drawIntervalOverlays(this.bigOverlayCtx, {
        tWindowStart: this.sweepStartTime,
        tWindowEnd: this.sweepStartTime + xMax * msPerPixel,
        xMax,
        msPerPixel,
        overlayTopY,
        overlayBandH: overlayBandHeight,
        midY: baselineY,
        verticalOffset: 0,
        plotTopY: 0,
        plotBottomY: overlayTopY,
        leadKey
      });
      this.drawMeasureToolOverlay(this.bigOverlayCtx, { width: w, height: h });
    }
  }

  drawIntervalOverlays(ctx, params) {
    const on = this.intervalHighlights;
    const showDropped =
      this.highlights.Dropped === true &&
      (this.currentRhythm === 'avb2_mobitz1' || this.currentRhythm === 'avb2_mobitz2' || this.currentRhythm === 'avb2_2to1');
    if (!on.PR && !on.QRSd && !on.QT && !on.RR && !showDropped) {
      this.intervalDebugLog('intervalOverlaySkip', { reason: 'no highlights', highlights: on });
      return;
    }
    const {
      tWindowStart,
      tWindowEnd,
      xMax,
      msPerPixel,
      overlayTopY,
      overlayBandH,
      midY,
      verticalOffset,
      plotTopY,
      plotBottomY,
      leadKey
    } = params;
    const duration = this.rhythmDurationMs || 10000;
    const baseRrMs = this.getCurrentRrMs();
    const overlayLeadKey = leadKey || this.selectedLeadKey || normLead(this.selectedLead);
    const baselineY = midY + (verticalOffset || 0);
    const padTop = 8;
    const padBottom = 8;
    const usableH = Math.max(72, overlayBandH - padTop - padBottom);
    const laneCount = 4;
    const laneGap = Math.max(26, Math.floor(usableH / laneCount));
    const shiftedTop = overlayTopY;
    const laneStart = shiftedTop + padTop;
    const lanes = {
      RR: laneStart + laneGap * 0.5,
      PR: laneStart + laneGap * 1.5,
      QRSd: laneStart + laneGap * 2.5,
      QT: laneStart + laneGap * 3.5
    };
    const bracketH = 8;
    const labelGap = 6;
    const labelFontSize = Math.max(10, Math.min(12, Math.floor(laneGap * 0.55)));
    const counts = {
      RR: 0,
      PR: 0,
      QRSd: 0,
      QT: 0
    };
    const style = {
      RR: { stroke: '#7c3aed', fill: 'rgba(124,58,237,0.10)', fullLabel: (ms) => `RR ${ms} ms`, shortLabel: (ms) => `${ms} ms` },
      PR: { stroke: '#2563eb', fill: 'rgba(37,99,235,0.10)', fullLabel: (ms) => `PR ${ms} ms`, shortLabel: (ms) => `${ms} ms` },
      QRSd: { stroke: '#d33f49', fill: 'rgba(211,63,73,0.10)', fullLabel: (ms) => `QRS ${ms} ms`, shortLabel: (ms) => `${ms} ms` },
      QT: { stroke: '#2f855a', fill: 'rgba(47,133,90,0.10)', fullLabel: (ms) => `QT ${ms} ms`, shortLabel: (ms) => `${ms} ms` }
    };
    const firstLabelShown = { RR: false, PR: false, QRSd: false, QT: false };
    const droppedStyle = { stroke: '#f59e0b', fill: 'rgba(245,158,11,0.12)' };

    const waveformY = (tMs) => {
      const v = this.getLeadVoltageAtTimeMs(tMs, overlayLeadKey);
      const y = baselineY - v;
      const limitBottom = (plotBottomY || overlayTopY) - 2;
      return Math.max((plotTopY || 0) + 2, Math.min(limitBottom, y));
    };

    const drawGuides = (key, x1, x2, yTop, tStart, tEnd) => {
      ctx.save();
      ctx.strokeStyle = style[key].stroke;
      ctx.globalAlpha = 0.28;
      ctx.lineWidth = 1.25;
      ctx.setLineDash([3, 3]);

      const y1 = waveformY(tStart);
      ctx.beginPath();
      ctx.moveTo(x1 + 0.5, yTop);
      ctx.lineTo(x1 + 0.5, y1);
      ctx.stroke();
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = style[key].stroke;
      ctx.lineWidth = 1.25;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x1 - 6, y1 + 0.5);
      ctx.lineTo(x1 + 6, y1 + 0.5);
      ctx.stroke();
      ctx.restore();

      const y2 = waveformY(tEnd);
      ctx.beginPath();
      ctx.moveTo(x2 + 0.5, yTop);
      ctx.lineTo(x2 + 0.5, y2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = style[key].stroke;
      ctx.beginPath();
      ctx.arc(x1 + 0.5, y1, 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x2 + 0.5, y2, 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = style[key].stroke;
      ctx.lineWidth = 1.25;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x2 - 6, y2 + 0.5);
      ctx.lineTo(x2 + 6, y2 + 0.5);
      ctx.stroke();
      ctx.restore();
      ctx.restore();
    };

    const drawBracket = (key, tStart, tEnd, label) => {
      const x1 = (tStart - tWindowStart) / msPerPixel;
      const x2 = (tEnd - tWindowStart) / msPerPixel;
      if (x2 < 0 || x1 > xMax) return false;
      const xx1 = Math.max(0, Math.min(xMax, x1));
      const xx2 = Math.max(0, Math.min(xMax, x2));
      if (xx2 - xx1 <= 1) return false;
      const y = lanes[key];
      const labelY = y - bracketH - labelGap;
      ctx.save();
      ctx.lineWidth = 2;
      ctx.strokeStyle = style[key].stroke;
      ctx.fillStyle = style[key].fill;
      ctx.beginPath();
      ctx.rect(xx1, y - bracketH, xx2 - xx1, bracketH);
      ctx.fill();
      ctx.stroke();
      ctx.font = `${labelFontSize}px Arial`;
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = style[key].stroke;
      const text = !firstLabelShown[key] ? style[key].fullLabel(label) : style[key].shortLabel(label);
      ctx.fillText(text, xx1, labelY);
      firstLabelShown[key] = true;
      ctx.restore();
      drawGuides(key, xx1, xx2, y - bracketH, tStart, tEnd);
      return true;
    };

    const drawDroppedBox = (tStart, tEnd) => {
      const x1 = (tStart - tWindowStart) / msPerPixel;
      const x2 = (tEnd - tWindowStart) / msPerPixel;
      if (x2 < 0 || x1 > xMax) return false;
      const xx1 = Math.max(0, Math.min(xMax, x1));
      const xx2 = Math.max(0, Math.min(xMax, x2));
      if (xx2 - xx1 <= 2) return false;
      const top = (plotTopY || 0) + 4;
      const bottom = (plotBottomY || overlayTopY) - 4;
      const height = Math.max(12, bottom - top);
      ctx.save();
      ctx.fillStyle = droppedStyle.fill;
      ctx.strokeStyle = droppedStyle.stroke;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.rect(xx1, top, xx2 - xx1, height);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      return true;
    };

    const beats = this.beatSchedule || [];
    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i];
      if (!beat) continue;
      const t0 = beat.rTime;
      if (!Number.isFinite(t0)) continue;
      const hasQrs = beat.hasQRS !== false;
      const nextBeat = beats[(i + 1) % beats.length];
      const nextHasQrs = nextBeat && nextBeat.hasQRS !== false;
      const t1 = nextBeat && Number.isFinite(nextBeat.rTime) ? nextBeat.rTime : null;

      const baseRr =
        hasQrs && nextHasQrs && t1 != null
          ? i === beats.length - 1
            ? t1 + duration - t0
            : t1 - t0
          : null;
      const rrMs = baseRr != null ? Math.max(0, Math.round(baseRr)) : null;

      const kStart = Math.floor((tWindowStart - t0) / duration) - 1;
      const kEnd = Math.floor((tWindowEnd - t0) / duration) + 1;
      for (let k = kStart; k <= kEnd; k++) {
        const rOcc = t0 + k * duration;
        const nextOcc =
          rrMs != null ? (i === beats.length - 1 ? t1 + (k + 1) * duration : t1 + k * duration) : null;
        const qrsStart = rOcc - beat.qrs / 2;
        const qrsEnd = qrsStart + beat.qrs;
        const qtEnd = qrsStart + beat.qt;
        const prStart = qrsStart - beat.pr;
        const droppedActive =
          this.highlights.Dropped === true &&
          (this.currentRhythm === 'avb2_mobitz1' || this.currentRhythm === 'avb2_mobitz2' || this.currentRhythm === 'avb2_2to1') &&
          beat.hasP &&
          !hasQrs;

        if (droppedActive) {
          const nextPStart = prStart + baseRrMs;
          if (nextPStart > prStart) {
            drawDroppedBox(prStart, nextPStart);
          }
        }

        if (on.RR && rrMs != null && drawBracket('RR', rOcc, nextOcc, rrMs)) counts.RR++;
        if (
          on.PR &&
          hasQrs &&
          beat.hasP &&
          beat.pr > 0 &&
          drawBracket('PR', prStart, qrsStart, Math.round(beat.pr))
        )
          counts.PR++;
        if (hasQrs && on.QRSd && drawBracket('QRSd', qrsStart, qrsEnd, Math.round(beat.qrs))) counts.QRSd++;
        if (hasQrs && on.QT && drawBracket('QT', qrsStart, qtEnd, Math.round(beat.qt))) counts.QT++;
      }
    }
    if (this.intervalDebug) {
      this.intervalDebugLog('intervalOverlayStats', {
        highlights: on,
        counts,
        window: [tWindowStart, tWindowEnd],
        leadKey: overlayLeadKey
      });
      Object.entries(counts).forEach(([key, value]) => {
        if (on[key] && value === 0) {
          this.intervalDebugImmediate('intervalOverlayWarning', {
            type: key,
            reason: 'highlight enabled but no brackets rendered',
            leadKey: overlayLeadKey,
            window: [tWindowStart, tWindowEnd]
          });
        }
      });
    }
  }

  drawMeasureToolOverlay(ctx, { width, height }) {
    if (!this.measureToolEnabled || !ctx) return;
    const msPerPixel = this._lastBigMsPerPixel || 0;
    const entries = [];
    if (this.measurements?.length) {
      this.measurements.forEach((m, idx) => entries.push({ data: m, live: false, index: idx }));
    }
    if (this.pendingMeasure) {
      entries.push({ data: this.pendingMeasure, live: true, index: this.measurements.length });
    }
    if (!entries.length) return;

    const latestFinalIndex = this.measurements.length - 1;

    const clampCoord = (value, min, max) => Math.max(min, Math.min(max, value));

    ctx.save();
    ctx.font = '11px "SFMono-Regular", Consolas, monospace';
    entries.forEach((entry) => {
      const { data, live, index } = entry;
      const ax = data.ax;
      const ay = data.ay;
      const bx = data.bx;
      const by = data.by;
      const isLatestFinal = !live && index === latestFinalIndex;
      const alpha = live ? 0.9 : isLatestFinal ? 1 : 0.75;
      const lineColor = `rgba(15,23,42,${0.55 * alpha})`;
      const dotColor = `rgba(15,23,42,${alpha})`;

      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1.5;
      if (live) ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      if (live) ctx.setLineDash([]);

      const drawHandle = (x, y) => {
        ctx.fillStyle = dotColor;
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      };
      drawHandle(ax, ay);
      drawHandle(bx, by);

      const dx = bx - ax;
      const dy = by - ay;
      const dtMs = Math.round(Math.abs(dx) * msPerPixel);
      const dvMv = -(dy / MV_TO_PX_12);

      const line1 = `Δt ${dtMs} ms`;
      const line2 = `ΔV ${dvMv.toFixed(2)} mV`;
      const textPadX = 5;
      const textPadY = 6;
      const lineHeight = 12;

      ctx.font = '11px "SFMono-Regular", Consolas, monospace';
      const textWidth = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width);
      const labelW = textWidth + textPadX * 2;
      const labelH = lineHeight * 2 + textPadY * 2;

      let labelX = (ax + bx) / 2 - labelW / 2;
      let labelY = (ay + by) / 2 - labelH - 6;
      labelX = clampCoord(labelX, 6, Math.max(6, width - labelW - 6));
      labelY = clampCoord(labelY, 6, Math.max(6, height - labelH - 6));

      if (!live) {
        data.labelBounds = { x: labelX, y: labelY, width: labelW, height: labelH };
      } else if (data.labelBounds) {
        delete data.labelBounds;
      }

      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeStyle = 'rgba(15,23,42,0.18)';
      ctx.lineWidth = 1;
      this.roundedRectPath(ctx, labelX, labelY, labelW, labelH, 8);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = 'rgba(15,23,42,0.9)';
      ctx.textBaseline = 'top';
      ctx.fillText(line1, labelX + textPadX, labelY + textPadY);
      ctx.fillText(line2, labelX + textPadX, labelY + textPadY + lineHeight);
    });
    ctx.restore();
  }

  drawReadoutOverlay() {
    if (!this.overlayCtx || !this.overlayCanvas) return;
    const ctx = this.overlayCtx;
    const w = this.renderWidth || this.overlayCanvas.clientWidth || 0;
    const h = this.renderHeight || this.overlayCanvas.clientHeight || 0;
    ctx.clearRect(0, 0, w, h);
    const showReadout = this.showReadout !== false;
    const summary = this.getReadoutSummary();
    const iv = this.getIntervalReadout();
    const prLine = iv.prMs == null ? 'PR —' : `PR ${iv.prMs} ms`;
    const hiddenText = this.readoutHiddenText || 'Click to reveal';
    const lines = showReadout
      ? [summary.hrText, summary.axisText, prLine, `QRS ${iv.qrsMs} ms`, `QT ${iv.qtMs} ms`]
      : [hiddenText];
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
        iv,
        lines
      });
    }
    const fontSize = 12;
    ctx.font = `${fontSize}px "SFMono-Regular", Consolas, monospace`;
    ctx.textBaseline = 'top';
    const padding = 8;
    const lineHeight = fontSize + 2;
    let maxWidth = 0;
    lines.forEach((line) => {
      maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
    });
    const boxWidth = maxWidth + padding * 2;
    const boxHeight = lines.length * lineHeight + padding * 1.5;
    const margin = 12;
    const x = Math.max(margin, scrollLeft + viewW - boxWidth - margin);
    const y = 8;
    this.readoutBox = { x, y, width: boxWidth, height: boxHeight };
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    this.roundedRectPath(ctx, x, y, boxWidth, boxHeight, 8);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#0f172a';
    lines.forEach((line, i) => ctx.fillText(line, x + padding, y + padding + i * lineHeight));
  }

  handleReadoutClick(event) {
    if (!this.overlayCanvas || !this.readoutBox) return false;
    const rect = this.overlayCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const scaleX = (this.renderWidth || rect.width) / rect.width;
    const scaleY = (this.renderHeight || rect.height) / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;
    const { x: bx, y: by, width, height } = this.readoutBox;
    const hit = x >= bx && x <= bx + width && y >= by && y <= by + height;
    if (!hit) return false;
    this.showReadout = !this.showReadout;
    this.drawReadoutOverlay();
    return true;
  }

  getIntervalReadout() {
    return {
      prMs: this.currentRhythm === 'afib' || this.currentRhythm === 'aflutter'
        ? null
        : Math.round(this.intervals.prIntervalMs),
      qrsMs: Math.round(this.intervals.qrsDurationMs),
      qtMs: Math.round(this.intervals.qtIntervalMs)
    };
  }

  destroy() {
    this.pause();
    this.cancelSingleRun();
    window.removeEventListener('resize', this.handleResize);
    if (this.bigContainerObserver) {
      this.bigContainerObserver.disconnect();
      this.bigContainerObserver = null;
    }
    [this.bigTraceCanvas, this.bigOverlayCanvas].forEach((canvas) => {
      if (!canvas) return;
      canvas.removeEventListener('mousemove', this.handleBigMouseMove);
      canvas.removeEventListener('mouseleave', this.handleBigMouseLeave);
      canvas.removeEventListener('click', this.handleBigClick);
      canvas.removeEventListener('dblclick', this.handleBigDoubleClick);
    });
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

  drawCalibrationPulse(ctx, baselineY, msPerPixel, overlayTopY, canvasHeight) {
    const calWidthMs = 200;
    const calHeightPx = MV_TO_PX_12;
    const calWidthPx = Math.max(4, calWidthMs / (msPerPixel || 1));
    const xStart = 12;
    const baseY = Math.min(canvasHeight - 20, overlayTopY - 10);
    ctx.save();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xStart, baseY);
    ctx.lineTo(xStart, baseY - calHeightPx);
    ctx.lineTo(xStart + calWidthPx, baseY - calHeightPx);
    ctx.lineTo(xStart + calWidthPx, baseY);
    ctx.stroke();
    ctx.restore();
  }

  colorForWave(type) {
    const base = '#1f2937';
    if (this.highlights[type]) {
      const map = { P: '#2563eb', QRS: '#d33f49', T: '#2f855a' };
      return map[type] || base;
    }
    return base;
  }

  getLeadAtEvent(event) {
    const rect = this.traceCanvas.getBoundingClientRect();
    const scaleX = (this.renderWidth || rect.width) / rect.width;
    const scaleY = (this.renderHeight || rect.height) / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;
    return this.getLeadAtPoint(x, y);
  }

  getLeadAtPoint(x, y) {
    for (const vp of this.viewports) {
      if (x >= vp.x && x <= vp.x + vp.width && y >= vp.y && y <= vp.y + vp.height) {
        return vp.leadLabel;
      }
    }
    return null;
  }

  getReadoutSummary() {
    const axisMode = this.axisMode || 'normal';
    const axisLabelMap = {
      normal: 'Normal Axis (0° to +90°)',
      lad: 'Left Axis Deviation (0° to −90°)',
      rad: 'Right Axis Deviation (+90° to +180°)',
      extreme: 'Extreme Axis (−90° to −180°)'
    };
    const axisLabel = axisLabelMap[axisMode] || axisLabelMap.normal;
    return {
      hrText: `HR ${Math.round(this.config.heartRate)} bpm`,
      axisText: `Axis: ${axisLabel}`
    };
  }

  ensureLeadSanityChecked() {
    if (this._leadConfigChecked) return;
    this._leadConfigChecked = true;
    this.verifyLeadConfiguration();
  }

  verifyLeadConfiguration() {
    const unique = ALL_LEAD_KEYS;
    console.log('[Ecg12Simulator] Lead set:', CANONICAL_LEAD_LIST.join(', '));
    console.log('[Ecg12Simulator] Layout order:', LEADS_12.flat().join(', '));
    const hasV3 = unique.includes(normLead('V3'));
    const hasV6 = unique.includes(normLead('V6'));
    console.assert(hasV3, '[Ecg12Simulator] Lead configuration is missing V3.');
    console.assert(hasV6, '[Ecg12Simulator] Lead configuration is missing V6.');
    const firstBeat = this.beatSchedule[0];
    if (firstBeat) {
      const sample = Math.abs(this.getLeadValueAtTimeMs(firstBeat.rTime + 5, 'V3'));
      console.assert(sample > 1e-2, '[Ecg12Simulator] Lead V3 appears nearly flat; check configuration.', sample);
    }
  }

  regenerateRhythm() {
    const preset = this.getCurrentPreset();
    const durationMs = (this.config.displayTime || 10) * 1000;
    const baseRrMs = this.getCurrentRrMs();
    const TARGET_DURATION_MS = 8000;
    const isRegular =
      this.currentRhythm === 'sinus' ||
      this.currentRhythm === 'sinus_pac' ||
      this.currentRhythm === 'aflutter' ||
      this.currentRhythm === 'avb1' ||
      this.currentRhythm === 'avb2_2to1' ||
      this.currentRhythm === 'lbbb' ||
      this.currentRhythm === 'rbbb' ||
      this.currentRhythm === 'junctional_escape' ||
      this.currentRhythm === 'paced_ventricular' ||
      this.currentRhythm === 'paced_atrial' ||
      this.currentRhythm === 'sinus_pvc_trigeminy' ||
      this.currentRhythm === 'mvtach' ||
      this.currentRhythm === 'stemi_inferior' ||
      this.currentRhythm === 'stemi_anterior' ||
      this.currentRhythm === 'stemi_lateral';
    this.atrialSchedule = [];
    if (this.currentRhythm === 'afib') {
      this.initAfibNoise();
    }

    if (isRegular) {
      const nBeats = Math.max(1, Math.ceil(TARGET_DURATION_MS / baseRrMs));
      this.rhythmDurationMs = nBeats * baseRrMs;
    }

    const generationDurationMs = isRegular ? this.rhythmDurationMs : durationMs;
    this.beatSchedule = this.buildBeatSchedule(preset, generationDurationMs);

    if (!isRegular) {
      const lastBeat = this.beatSchedule[this.beatSchedule.length - 1];
      this.rhythmDurationMs = lastBeat
        ? Math.max(durationMs, lastBeat.rTime + baseRrMs)
        : durationMs;
    }
    this._sampleCache.clear();
    this.drawTrace();
    this.drawExpandedTrace();
    this.ensureLeadSanityChecked();
  }

  buildBeatSchedule(preset, durationMs) {
    const schedule = [];
    const activePreset = preset || this.getPresetForId('sinus');
    const id = activePreset?.id || 'sinus';
    switch (id) {
      case 'afib':
        this.generateAFibBeats(schedule, durationMs);
        break;
      case 'aflutter':
        this.generateAtrialFlutterBeats(schedule, durationMs);
        break;
      case 'avb1':
        this.generateFirstDegreeBeats(schedule, durationMs);
        break;
      case 'avb2_mobitz1':
        this.generateMobitzIBeats(schedule, durationMs);
        break;
      case 'avb2_mobitz2':
        this.generateMobitzIIBeats(schedule, durationMs);
        break;
      case 'avb2_2to1':
        this.generateTwoToOneAvBlockBeats(schedule, durationMs);
        break;
      case 'avb3':
        this.generateThirdDegreeBeats(schedule, durationMs);
        break;
      case 'lbbb':
        this.generateSinusBeats(schedule, durationMs, {
          morphology: 'lbbb',
          qrs: Math.max(this.intervals.qrsDurationMs, 160)
        });
        break;
      case 'rbbb':
        this.generateBundleBranchBlockBeats(schedule, durationMs, 'rbbb');
        break;
      case 'lvh':
        this.generateSinusBeats(schedule, durationMs, {
          morphology: 'lvh',
          qrs: Math.max(this.intervals.qrsDurationMs, 104)
        });
        break;
      case 'junctional_escape':
        this.generateJunctionalEscapeBeats(schedule, durationMs);
        break;
      case 'paced_ventricular':
        this.generatePacedVentricularBeats(schedule, durationMs);
        break;
      case 'paced_atrial':
        this.generatePacedAtrialBeats(schedule, durationMs);
        break;
      case 'sinus_pvc_trigeminy':
        this.generateSinusPvcTrigeminyBeats(schedule, durationMs);
        break;
      case 'sinus_pac':
        this.generateSinusPacBeats(schedule, durationMs);
        break;
      case 'stemi_inferior':
      case 'stemi_anterior':
      case 'stemi_lateral':
        this.generateSinusBeats(schedule, durationMs);
        break;
      case 'mvtach':
        console.warn('[Ecg12Simulator] Monomorphic VT is approximated for the 12-lead view.');
        this.generateVentricularTachBeats(schedule, durationMs, { polymorphic: false });
        break;
      case 'pvtach':
        console.warn('[Ecg12Simulator] Polymorphic VT placeholder: no waveform generated yet.');
        break;
      case 'sinus':
      default:
        this.generateSinusBeats(schedule, durationMs);
        break;
    }
    // If pvtach is intentionally empty, return an empty schedule (flat baseline).
    if (id === 'pvtach') {
      return schedule;
    }
    if (!schedule.length) {
      console.warn('[Ecg12Simulator] Rhythm schedule was empty; falling back to sinus.');
      this.generateSinusBeats(schedule, durationMs);
    }
    schedule.sort((a, b) => a.rTime - b.rTime);
    if (id === 'afib' || id === 'aflutter') {
      schedule.forEach((beat) => {
        beat.hasP = false;
        beat.pr = 0;
      });
    }
    this.applyCaseConductionOverrides(schedule);
    return schedule;
  }

  applyCaseConductionOverrides(schedule) {
    if (!Array.isArray(schedule) || !schedule.length) return;
    const morph = this.caseQrsMorphologyOverride;
    if (!morph) return;
    const defaultWideQrs = morph === 'lbbb' ? 160 : (morph === 'rbbb' ? 168 : null);
    const minQrs = Number.isFinite(this.caseQrsMinMs) ? this.caseQrsMinMs : defaultWideQrs;
    schedule.forEach((beat) => {
      if (!beat || beat.hasQRS === false) return;
      beat.morphology = morph;
      if (Number.isFinite(minQrs)) {
        beat.qrs = Math.max(beat.qrs || this.intervals.qrsDurationMs || minQrs, minQrs);
      }
    });
  }

  addBeatToSchedule(schedule, beat) {
    if (!beat || typeof beat.rTime !== 'number') return;
    const base = this.intervals;
    schedule.push({
      rTime: beat.rTime,
      hasP: beat.hasP !== undefined ? beat.hasP : true,
      hasQRS: beat.hasQRS !== undefined ? beat.hasQRS : true,
      hasT: beat.hasT !== undefined ? beat.hasT : true,
      pr: beat.pr != null ? beat.pr : base.prIntervalMs,
      qrs: beat.qrs != null ? beat.qrs : base.qrsDurationMs,
      qt: beat.qt != null ? beat.qt : base.qtIntervalMs,
      qrsScale: beat.qrsScale || 1,
      polarity: beat.polarity || 1,
      morphology: beat.morphology || 'normal',
      pacedMode: beat.pacedMode || null,
      isPac: !!beat.isPac,
      pScale: Number.isFinite(beat.pScale) ? beat.pScale : 1,
      pWidthScale: Number.isFinite(beat.pWidthScale) ? beat.pWidthScale : 1,
      pCenterShiftMs: Number.isFinite(beat.pCenterShiftMs) ? beat.pCenterShiftMs : 0
    });
  }

  generateSinusBeats(schedule, durationMs, options = {}) {
    const baseRrMs = this.getCurrentRrMs();
    const morphology = options?.morphology || 'normal';
    const qrsOverride = Number.isFinite(options?.qrs) ? options.qrs : null;
    let cycleStart = 0;
    while (cycleStart < durationMs) {
      const rTime = cycleStart + this.intervals.prIntervalMs + this.intervals.qrsDurationMs / 2;
      if (rTime >= durationMs) break;
      this.addBeatToSchedule(schedule, {
        rTime,
        morphology,
        qrs: qrsOverride != null ? qrsOverride : undefined
      });
      cycleStart += baseRrMs;
    }
  }

  generateBundleBranchBlockBeats(schedule, durationMs, type = 'lbbb') {
    const baseRrMs = this.getCurrentRrMs();
    const qrsMs = Math.max(this.intervals.qrsDurationMs, type === 'lbbb' ? 160 : 168);
    let cycleStart = 0;
    while (cycleStart < durationMs) {
      const rTime = cycleStart + this.intervals.prIntervalMs + qrsMs / 2;
      if (rTime >= durationMs) break;
      this.addBeatToSchedule(schedule, {
        rTime,
        qrs: qrsMs,
        morphology: type
      });
      cycleStart += baseRrMs;
    }
  }

  generateJunctionalEscapeBeats(schedule, durationMs) {
    const rate = clamp(this.config.heartRate || 50, 40, 80);
    const rr = 60000 / rate;
    let cycleStart = 0;
    while (cycleStart < durationMs) {
      const rTime = cycleStart + this.intervals.qrsDurationMs / 2;
      if (rTime >= durationMs) break;
      this.addBeatToSchedule(schedule, {
        rTime,
        hasP: false,
        pr: 0,
        morphology: 'junctional'
      });
      cycleStart += rr;
    }
  }

  generatePacedVentricularBeats(schedule, durationMs) {
    const rate = clamp(this.config.heartRate || 60, 40, 120);
    const rr = 60000 / rate;
    let cycleStart = 0;
    const qrsMs = Math.max(this.intervals.qrsDurationMs, 170);
    while (cycleStart < durationMs) {
      const rTime = cycleStart + qrsMs / 2;
      if (rTime >= durationMs) break;
      this.addBeatToSchedule(schedule, {
        rTime,
        hasP: false,
        pr: 0,
        qrs: qrsMs,
        morphology: 'paced_ventricular',
        pacedMode: 'ventricular'
      });
      cycleStart += rr;
    }
  }

  generatePacedAtrialBeats(schedule, durationMs) {
    const baseRrMs = this.getCurrentRrMs();
    const pr = Math.max(this.intervals.prIntervalMs, 220);
    let cycleStart = 0;
    while (cycleStart < durationMs) {
      const rTime = cycleStart + pr + this.intervals.qrsDurationMs / 2;
      if (rTime >= durationMs) break;
      this.addBeatToSchedule(schedule, {
        rTime,
        pr,
        morphology: 'paced_atrial',
        pacedMode: 'atrial'
      });
      cycleStart += baseRrMs;
    }
  }

  generateSinusPvcTrigeminyBeats(schedule, durationMs) {
    const baseRrMs = this.getCurrentRrMs();
    let cycleStart = 0;
    let idx = 0;
    while (cycleStart < durationMs) {
      const isPvcBeat = idx % 3 === 2;
      if (isPvcBeat) {
        const pvcRTime = cycleStart + Math.max(120, this.intervals.qrsDurationMs);
        this.addBeatToSchedule(schedule, {
          rTime: pvcRTime,
          hasP: false,
          pr: 0,
          qrs: Math.max(this.intervals.qrsDurationMs, 160),
          qt: Math.max(this.intervals.qtIntervalMs, 430),
          morphology: 'pvc'
        });
        cycleStart += baseRrMs * 1.15;
      } else {
        const rTime = cycleStart + this.intervals.prIntervalMs + this.intervals.qrsDurationMs / 2;
        if (rTime >= durationMs) break;
        this.addBeatToSchedule(schedule, {
          rTime,
          morphology: 'normal'
        });
        cycleStart += baseRrMs;
      }
      idx += 1;
    }
  }

  generateSinusPacBeats(schedule, durationMs) {
    const baseRrMs = this.getCurrentRrMs();
    const pacAdvanceFraction = 0.20; // one RR shortened by ~20%
    const postPacFraction = 1.10; // slight noncompensatory pause
    const totalCycles = Math.max(3, Math.floor(durationMs / baseRrMs));
    const pacCycleIndex = Math.max(2, Math.floor(totalCycles * 0.45));
    let cycleStart = 0;
    let idx = 0;
    while (cycleStart < durationMs) {
      let rTime = cycleStart + this.intervals.prIntervalMs + this.intervals.qrsDurationMs / 2;
      if (idx === pacCycleIndex) {
        rTime -= baseRrMs * pacAdvanceFraction;
      }
      if (rTime >= durationMs) break;
      this.addBeatToSchedule(schedule, {
        rTime,
        morphology: 'normal',
        isPac: idx === pacCycleIndex,
        pScale: idx === pacCycleIndex ? 0.82 : 1,
        pWidthScale: idx === pacCycleIndex ? 0.76 : 1,
        pCenterShiftMs: idx === pacCycleIndex ? -10 : 0
      });
      cycleStart += baseRrMs * (idx === pacCycleIndex ? postPacFraction : 1);
      idx += 1;
    }
  }

  generateFirstDegreeBeats(schedule, durationMs) {
    const baseRrMs = this.getCurrentRrMs();
    const longPr = Math.max(this.intervals.prIntervalMs, 240);
    let cycleStart = 0;
    while (cycleStart < durationMs) {
      const rTime = cycleStart + longPr + this.intervals.qrsDurationMs / 2;
      if (rTime >= durationMs) break;
      this.addBeatToSchedule(schedule, { rTime, pr: longPr });
      cycleStart += baseRrMs;
    }
  }

  generateMobitzIBeats(schedule, durationMs) {
    const baseRrMs = this.getCurrentRrMs();
    const longPr = Math.max(this.intervals.prIntervalMs, 200);
    const increment = longPr >= 320 ? 80 : 60;
    const pattern = [
      { pr: longPr, conducted: true },
      { pr: longPr, conducted: true },
      { pr: longPr + increment, conducted: true },
      { pr: longPr + increment, conducted: false }
    ];
    let cycleStart = 0;
    let idx = 0;
    while (cycleStart < durationMs) {
      const step = pattern[idx % pattern.length];
      const conducted = !!step.conducted;
      const rTime = cycleStart + step.pr + this.intervals.qrsDurationMs / 2;
      this.addBeatToSchedule(schedule, {
        rTime,
        pr: step.pr,
        hasP: true,
        hasQRS: conducted,
        hasT: conducted
      });
      cycleStart += baseRrMs;
      idx++;
    }
  }

  generateMobitzIIBeats(schedule, durationMs) {
    const baseRrMs = this.getCurrentRrMs();
    let cycleStart = 0;
    let idx = 0;

    /*
     * Mobitz II (unambiguous): constant PR on conducted beats with intermittent dropped QRS.
     * A strict 2:1 pattern (every other P not conducted) is ambiguous and can be mistaken for
     * non-typeable 2° AV block (could be Mobitz I or II). We avoid that by using ≥3:2 / 4:3
     * conduction: there are usually ≥2 conducted beats between drops, and PR stays constant.
     */
    const fixedPr = Math.max(this.intervals.prIntervalMs, 80);
    const qrsHalf = this.intervals.qrsDurationMs / 2;
    let nextDropAt = 3; // start with a 4:3 pattern (drop the 4th P)

    while (cycleStart < durationMs) {
      const dropped = idx === nextDropAt;
      const conducted = !dropped;
      const rTime = cycleStart + fixedPr + qrsHalf;
      this.addBeatToSchedule(schedule, {
        rTime,
        pr: fixedPr,
        hasP: true,
        hasQRS: conducted,
        hasT: conducted
      });
      if (dropped) {
        // Choose spacing between dropped beats: mostly 4:3, sometimes 3:2, rarely 5:4.
        const spacingBase = this.rand() < 0.7 ? 4 : 3;
        const spacing = spacingBase + (this.rand() < 0.15 ? 1 : 0);
        nextDropAt += Math.max(3, spacing);
      }
      cycleStart += baseRrMs;
      idx++;
    }
  }

  generateTwoToOneAvBlockBeats(schedule, durationMs) {
    const baseRrMs = this.getCurrentRrMs();
    const fixedPr = Math.max(this.intervals.prIntervalMs, 120);
    const qrsHalf = this.intervals.qrsDurationMs / 2;
    let cycleStart = 0;
    let idx = 0;
    while (cycleStart < durationMs) {
      const conducted = idx % 2 === 0;
      const rTime = cycleStart + fixedPr + qrsHalf;
      this.addBeatToSchedule(schedule, {
        rTime,
        pr: fixedPr,
        hasP: true,
        hasQRS: conducted,
        hasT: conducted
      });
      cycleStart += baseRrMs;
      idx += 1;
    }
  }

  logMobitz2SelfCheck() {
    const beats = Array.isArray(this.beatSchedule) ? this.beatSchedule : [];
    if (!beats.length) return;

    const sample = beats.slice(0, 12).map((beat, i) => {
      const conducted = beat.hasQRS !== false;
      const pShown = beat.hasP !== false;
      // Approximate P center based on the same cue used for rendering.
      const pCenter = (beat.rTime || 0) - (beat.pr || 0) + 40;
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

    console.groupCollapsed('[Ecg12Simulator][Mobitz II self-check]');
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

  generateThirdDegreeBeats(schedule, durationMs) {
    const ventRate = clamp(this.config.heartRate, 30, 50);
    const ventRr = 60000 / ventRate;
    let ventTime = 0;
    while (ventTime < durationMs) {
      this.addBeatToSchedule(schedule, {
        rTime: ventTime,
        hasP: false,
        pr: 0,
        qrs: Math.max(this.intervals.qrsDurationMs, 160),
        qt: Math.max(this.intervals.qtIntervalMs, 420)
      });
      ventTime += ventRr;
    }
    const atrialRr = 60000 / 80;
    let atrialTime = 0;
    while (atrialTime < durationMs) {
      this.addBeatToSchedule(schedule, {
        rTime: atrialTime,
        hasP: true,
        hasQRS: false,
        pr: 140,
        qrs: this.intervals.qrsDurationMs,
        qt: this.intervals.qtIntervalMs
      });
      atrialTime += atrialRr;
    }
  }

  generateAFibBeats(schedule, durationMs) {
    const hr = Math.max(this.config.heartRate || 90, 30);
    const meanRr = 60000 / hr;
    const minRr = 350;
    const maxRr = 1800;
    const jitterGain = Number.isFinite(this.caseAfibJitterGain) ? this.caseAfibJitterGain : 1;
    let t = 0;
    while (t < durationMs) {
      const jitter = Math.exp(0.25 * jitterGain * this.randn());
      const rr = clamp(meanRr * jitter, minRr, maxRr);
      const rTime = t + this.intervals.qrsDurationMs / 2;
      this.addBeatToSchedule(schedule, {
        rTime,
        hasP: false,
        pr: 0,
        qrs: this.intervals.qrsDurationMs,
        qt: this.intervals.qtIntervalMs
      });
      t += rr;
    }
  }

  generateAtrialFlutterBeats(schedule, durationMs) {
    const baseRrMs = this.getCurrentRrMs();
    let cycleStart = 0;
    while (cycleStart < durationMs) {
      const rTime = cycleStart + this.intervals.qrsDurationMs / 2;
      if (rTime >= durationMs) break;
      this.addBeatToSchedule(schedule, {
        rTime,
        hasP: false,
        hasT: false,
        pr: 0
      });
      cycleStart += baseRrMs;
    }
  }

  generateVentricularTachBeats(schedule, durationMs, options = {}) {
    const { polymorphic } = options;
    const rr = 60000 / Math.max(this.config.heartRate, polymorphic ? 190 : 170);
    let t = 0;
    let i = 0;
    while (t < durationMs) {
      const rTime = t;
      const polarity = polymorphic ? (i % 2 === 0 ? 1 : -1) : 1;
      const qrsWidth = polymorphic ? 190 : 160;
      this.addBeatToSchedule(schedule, {
        rTime,
        hasP: false,
        pr: 0,
        qrs: qrsWidth,
        qt: Math.max(this.intervals.qtIntervalMs, 440),
        polarity,
        hasT: true
      });
      t += rr;
      i++;
    }
  }

  _seedPolymorphicTorsadesParameters() {
    return {
      envPeriodSec: 3.6 + Math.random() * (4.8 - 3.6),
      envPhaseRad: Math.random() * Math.PI * 2,

      axisPeriodSec: 4.2 + Math.random() * (6.2 - 4.2),
      axisPhaseRad: Math.random() * Math.PI * 2,

      fmDepth: 0.06 + Math.random() * (0.11 - 0.06),
      fmPhaseRad: Math.random() * Math.PI * 2,

      morphPhaseRad: Math.random() * Math.PI * 2,
      morphRateHz: 0.10 + Math.random() * 0.10
    };
  }

  torsadesVoltage(tSeconds, config, bpm) {
    const p = config || {};
    const vtBpm = Math.max(160, Math.min(240, bpm || 200));
    const baseFreq = vtBpm / 60;

    const clampLocal = (v, a, b) => Math.min(Math.max(v, a), b);
    const smoothstepLocal = (a, b, x) => {
      const t = clampLocal((x - a) / ((b - a) || 1), 0, 1);
      return t * t * (3 - 2 * t);
    };

    const hash01 = (x) => {
      const s = Math.sin(x * 127.1 + 311.7) * 43758.5453123;
      return s - Math.floor(s);
    };

    const fmDepth = p.fmDepth ?? 0.09;
    const fmPhase = p.fmPhaseRad ?? 0;
    const fmRate = 0.28;
    const fm = fmDepth * Math.sin(2 * Math.PI * fmRate * tSeconds + fmPhase);

    const drift = 0.015 * Math.sin(2 * Math.PI * 0.11 * tSeconds + 1.1);
    const tightness = 2;
    const phase = 2 * Math.PI * (baseFreq * tightness * tSeconds + fm + drift);

    const h1 = Math.sin(phase);
    const h3 = 0.55 * Math.sin(3 * phase + 0.35);
    const h5 = 0.20 * Math.sin(5 * phase + 0.85);

    const morphRate = p.morphRateHz ?? 0.16;
    const morphPhase = p.morphPhaseRad ?? 0;
    const morphMix = 0.08 * Math.sin(2 * Math.PI * morphRate * tSeconds + morphPhase);

    const raw = (1.0 + morphMix) * h1 + (1.0 - morphMix) * h3 + h5;
    const clipped = Math.tanh(raw * 1.35);
    const smoothCarrier = Math.sin(phase + 0.25);
    const smoothCarrier2 = Math.sin(phase + 0.65);
    const smoothWave = 0.55 * clipped + 0.25 * smoothCarrier + 0.20 * smoothCarrier2;

    const envPeriod = p.envPeriodSec ?? 4.2;
    const envPhase = p.envPhaseRad ?? 0;
    const envSin = 0.5 + 0.5 * Math.sin((2 * Math.PI * tSeconds) / envPeriod + envPhase);
    const shaped = smoothstepLocal(0.08, 0.92, envSin);
    const envelope = 0.18 + 0.82 * Math.pow(shaped, 1.15);

    const n = hash01(Math.floor(tSeconds * 12.0));
    const envJitter = 1.0 + 0.03 * (n - 0.5);
    const envFinal = envelope * envJitter;

    const axisPeriod = p.axisPeriodSec ?? 5.3;
    const axisPhase = p.axisPhaseRad ?? 0;
    const axisBase = Math.sin((2 * Math.PI * tSeconds) / axisPeriod + axisPhase);
    const axis = 0.20 + 0.80 * axisBase;

    const A = AMP_PX.R * 1.15;
    return -(A * envFinal) * smoothWave * axis;
  }

  getLeadVoltageAtTimeMs(tMs, leadId) {
    return this.getLeadValueAtTimeMs(tMs, leadId);
  }

  getLeadValueAtTimeMs(tMs, leadId) {
    const key = normLead(leadId);
    const sample = this.getWaveSampleForLead(tMs, key);
    if (LIMB_LEADS.includes(key)) {
      return this.computeLimbLeadValue(key, sample);
    }
    return this.computePrecordialLeadValue(key, sample);
  }

  getWaveSampleForLead(tMs, leadKey) {
    const cacheKey = `${leadKey}|${tMs}`;
    if (this._sampleCache.has(cacheKey)) {
      return this._sampleCache.get(cacheKey);
    }
    const data = this.sampleWaveComponentsAtTime(tMs, leadKey);
    if (this._sampleCache.size > 2000) {
      this._sampleCache.clear();
    }
    this._sampleCache.set(cacheKey, data);
    return data;
  }


  initAfibNoise() {
    const comps = [];
    const n = 8;
    for (let i = 0; i < n; i++) {
      const freq = 4 + this.rand() * 6;
      const phase = this.rand() * Math.PI * 2;
      const weight = 0.4 + this.rand() * 0.9;
      comps.push({ freq, phase, weight });
    }
    this._afibNoise = comps;
    this._afibNoiseDriftPhase = this.rand() * Math.PI * 2;
  }

  afibBaseline(tMs) {
    const comps = this._afibNoise;
    if (!comps || !comps.length) return 0;
    const timeSec = tMs / 1000;
    const baselineGain = Number.isFinite(this.caseAfibBaselineGain) ? this.caseAfibBaselineGain : 1;
    const baseAmpPx = 0.14 * MV_TO_PX_12 * baselineGain;
    const drift =
      0.75 + 0.25 * Math.sin(2 * Math.PI * 0.25 * timeSec + (this._afibNoiseDriftPhase || 0));
    let sum = 0;
    let weightSum = 0;
    for (const c of comps) {
      sum += c.weight * Math.sin(2 * Math.PI * c.freq * timeSec + c.phase);
      weightSum += c.weight;
    }
    if (weightSum > 0) sum /= weightSum;
    const rough =
      0.25 * Math.sin(2 * Math.PI * 16.0 * timeSec + 1.3) +
      0.2 * Math.sin(2 * Math.PI * 22.0 * timeSec + 2.1);
    return baseAmpPx * drift * (0.85 * sum + 0.15 * rough);
  }

  flutterBaseline(tMs) {
    const periodMs = 200;
    const phase = ((tMs % periodMs) + periodMs) % periodMs / periodMs;
    let wave;
    if (phase < 0.15) {
      const u = phase / 0.15;
      wave = -0.25 + 1.25 * (0.5 - 0.5 * Math.cos(Math.PI * u));
    } else {
      const u = (phase - 0.15) / 0.85;
      const decay = 1 - u;
      const notch = 0.18 * Math.sin(2 * Math.PI * (u + 0.08)) * (1 - u);
      wave = 1.0 * decay + notch - 0.2;
    }
    const ampPx = 0.17 * MV_TO_PX_12;
    return ampPx * wave;
  }

  afibQrsBlanking(timeMsFromR) {
    if (!Number.isFinite(timeMsFromR)) return 1;
    const x = Math.abs(timeMsFromR);
    const sigma = 25;
    return 1 - Math.exp(-0.5 * (x / sigma) * (x / sigma));
  }

  afibTBlanking(timeMsFromT) {
    if (!Number.isFinite(timeMsFromT)) return 1;
    const x = Math.abs(timeMsFromT);
    const sigma = 70;
    const dip = Math.exp(-0.5 * (x / sigma) * (x / sigma));
    return 1 - 0.55 * dip;
  }

  resetRandomness(extraSalt = 0) {
    this.initRhythmSeed(extraSalt);
    if (this.currentRhythm === 'pvtach') {
      this._pvtachParams = this._seedPolymorphicTorsadesParameters();
    }
  }

  randomizeAfibPhases() {
    this.initAfibNoise();
  }

  computeLimbLeadValue(leadKey, sample) {
    const cfg = LIMB_LEAD_CONFIG[leadKey] || DEFAULT_LIMB_CONFIG;

    const pAxis = this.getWaveAxisDeg('P');
    const qrsAxis = this.getWaveAxisDeg('QRS');
    const tAxis = this.getWaveAxisDeg('T');

    const projected =
      this.scaleLimbComponent(sample.P, leadKey, pAxis, 'P') +
      this.scaleLimbComponent(sample.QRS, leadKey, qrsAxis, 'QRS') +
      this.scaleLimbComponent(sample.T, leadKey, tAxis, 'T');

    // ST is already computed per-lead in sampleWaveComponentsAtTime(t, leadKey),
    // so just add it directly (like baseline). Do NOT project it again.
    const st = sample.ST || 0;
    const base = sample.baseline || 0;

    const total = projected + st + base;
    return total * (cfg.gain || 1) * (cfg.polarity || 1) + (cfg.offsetPx || 0);
  }

  scaleLimbComponent(magnitude, leadKey, axisDeg, waveType) {
    if (!magnitude) return 0;
    const leadAngle = LIMB_LEAD_ANGLES[leadKey];
    if (typeof leadAngle !== 'number') return 0;
    const diff = degWrap(axisDeg - leadAngle);
    const minScale = waveType === 'QRS' ? LIMB_MIN_SCALE : LIMB_PT_MIN_SCALE;
    const scale = safeNonZero(Math.cos(diff * DEG_TO_RAD_12), minScale);
    if (this.debugLeadModel) {
      console.log(
        `[Ecg12Simulator][DEBUG] lead=${leadKey} wave=${waveType} axis=${axisDeg.toFixed(
          1
        )} diff=${diff.toFixed(1)} scale=${scale.toFixed(3)}`
      );
    }
    return magnitude * scale;
  }

  computePrecordialLeadValue(leadKey, sample) {
    const idx = PRECORDIAL_ORDER.indexOf(leadKey);
    if (idx === -1) {
      const msg = `[Ecg12Simulator] Unknown precordial lead "${leadKey}" requested.`;
      console.error(msg);
      throw new Error(msg);
    }
    const frac = PRECORDIAL_ORDER.length > 1 ? idx / (PRECORDIAL_ORDER.length - 1) : 0;
    const cfg = PRECORDIAL_BASE_GAINS[leadKey] || DEFAULT_PRECORDIAL_CONFIG;
    const qrsParts = sample.qrsParts || { q: 0, r: 0, s: 0 };

    const rWeight = clamp((idx - 1) / 4, 0, 1);
    const sWeight = 1 - rWeight;
    const qWeight = 0.15;

    const q = qrsParts.q * qWeight;
    const r = qrsParts.r * (0.35 + 0.95 * rWeight);
    const s = qrsParts.s * (0.35 + 1.0 * sWeight);
    const qrs = q + r + s;

    const pScale = lerp(0.9, 1.05, frac);
    let tScale = lerp(0.65, 1.2, frac);
    const activeMorphology = String(this.caseQrsMorphologyOverride || '').toLowerCase();
    const isLbbbProfile = activeMorphology === 'lbbb';
    if (isLbbbProfile) {
      if (leadKey === 'V1') tScale *= 1.7;
      else if (leadKey === 'V2') tScale *= 1.55;
      else if (leadKey === 'V3') tScale *= 1.35;
      else if (leadKey === 'V4') tScale *= 0.92;
      else if (leadKey === 'V5' || leadKey === 'V6') tScale *= 0.92;
    }
    const pPart = sample.P * pScale;
    const tPart = sample.T * tScale;
    const ptComponent = (pPart + tPart) * (cfg.baseGain || 1);

    let value = qrs * (cfg.baseGain || 1) + ptComponent + (cfg.offsetPx || 0);

    // Add ST (per-lead) and baseline using the same lead gain scaling.
    value += (sample.ST || 0) * (cfg.baseGain || 1);
    value += (sample.baseline || 0) * (cfg.baseGain || 1);

    if (isLbbbProfile) {
      if (leadKey === 'V1') value *= 1.06;
      else if (leadKey === 'V2') value *= 1.10;
      else if (leadKey === 'V3') value *= 1.15;
      else if (leadKey === 'V4') value *= 0.96;
      else if (leadKey === 'V5') value *= 1.12;
      else if (leadKey === 'V6') value *= 1.08;
    } else {
      if (leadKey === 'V1') value *= 0.95;
      else if (leadKey === 'V3') value *= 0.9;
      else if (leadKey === 'V5') value *= 1.05;
    }

    if (this.debugLeadModel) {
      console.log(
        `[Ecg12Simulator][DEBUG] lead=${leadKey} idx=${idx} rW=${rWeight.toFixed(2)} sW=${sWeight.toFixed(
          2
        )} value=${value.toFixed(2)}`
      );
    }

    return value;
  }

  getLeadDebugGain(leadKey) {
    if (LIMB_LEADS.includes(leadKey)) {
      const angle = LIMB_LEAD_ANGLES[leadKey];
      if (typeof angle !== 'number') return 1;
      const diff = degWrap((this.axisDeg || 0) - angle);
      return safeNonZero(Math.cos(diff * DEG_TO_RAD_12), LIMB_MIN_SCALE);
    }
    if (PRECORDIAL_ORDER.includes(leadKey)) {
      const cfg = PRECORDIAL_BASE_GAINS[leadKey] || DEFAULT_PRECORDIAL_CONFIG;
      return cfg.baseGain || 1;
    }
    return 1;
  }

  getLeadSkewMs(leadKey) {
    if (!leadKey) return 0;
    if (!this._leadSkewMap) this._leadSkewMap = {};
    if (this._leadSkewMap[leadKey] == null) {
      const hash = this.hashLeadKey(`${leadKey}_skew`);
      this._leadSkewMap[leadKey] = ((hash % 7) - 3) * 0.6;
    }
    return this._leadSkewMap[leadKey];
  }

  hashLeadKey(key) {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash << 5) - hash + key.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  initRhythmSeed(extraSalt = 0) {
    const rhythmKey = `${this.currentRhythm || 'sinus'}|${Math.round(this.config.heartRate || 0)}`;
    const rhythmHash = this.hashLeadKey(rhythmKey);
    const counter = this._seedCounter = (this._seedCounter + 1) >>> 0;
    const newSeed = (this._seedBase + rhythmHash + counter + (extraSalt || 0)) >>> 0;
    this.rngSeed = newSeed;
    this._rng = mulberry32(newSeed);
    this._gaussSpare = null;
  }

  rand() {
    if (!this._rng) this.initRhythmSeed();
    return this._rng();
  }

  randn() {
    return randnBM(() => this.rand());
  }

  getWaveAxisDeg(type) {
    const axis = this.axisDeg || 0;
    if (type === 'P') return degWrap(axis - 10);
    if (type === 'T') return degWrap(axis + 20);
    return degWrap(axis);
  }

  sampleWaveComponentsAtTime(tMs, leadKey = 'BASE') {
    const duration = this.rhythmDurationMs || 8000;
    const time = ((tMs % duration) + duration) % duration;
    if (this.currentRhythm === 'pvtach') {
      const params = this._pvtachParams || this._seedPolymorphicTorsadesParameters();
      const bpm = this.config.heartRate || 210;
      const total = this.torsadesVoltage(tMs / 1000, params, bpm);
      const qrsParts = {
        q: 0.22 * total,
        r: 0.56 * total,
        s: 0.22 * total
      };
      return {
        total,
        ST: 0,
        baseline: 0,
        P: 0,
        QRS: total,
        T: 0,
        qrsParts
      };
    }
    let p = 0;
    let qrs = 0;
    let tWave = 0;
    let uWave = 0;
    let pacerSpike = 0;
    const qrsParts = { q: 0, r: 0, s: 0 };
    const skew = this.getLeadSkewMs(leadKey);
    const isAfib = this.currentRhythm === 'afib';
    const isFlutter = this.currentRhythm === 'aflutter';
    const stemiMultiplier = this.getStemiLeadMultiplier(leadKey);
    const hasStemi = this.isStemiRhythm() && stemiMultiplier !== 0;
    const isRightPrecordial = ['V1', 'V2', 'V3'].includes(leadKey);
    const isLateral = ['I', 'AVL', 'V5', 'V6'].includes(leadKey);
    let nearestDtFromR = Infinity;
    let nearestDtFromT = Infinity;
    let st = 0;
    let nearestStDist = Infinity;

    for (const beat of this.beatSchedule) {
      if (!beat.hasP && !beat.hasQRS) continue;

      if (!isAfib && !isFlutter && beat.hasP) {
        const pCenter = beat.rTime - beat.pr + 40 + (Number.isFinite(beat.pCenterShiftMs) ? beat.pCenterShiftMs : 0);
        const basePWidth = 80 * (Number.isFinite(beat.pWidthScale) ? beat.pWidthScale : 1);
        const pacLeadTuning = beat.isPac
          ? (leadKey === 'II' ? { amp: 0.88, width: 0.86 } : { amp: 0.95, width: 0.93 })
          : { amp: 1, width: 1 };
        const pWidth = basePWidth * pacLeadTuning.width;
        const pAmp = (Number.isFinite(beat.pScale) ? beat.pScale : 1) * pacLeadTuning.amp;
        if (Math.abs(time - pCenter) <= 160) {
          p += this.drawP(time, pCenter, pWidth) * pAmp * (Number.isFinite(this.casePWaveGain) ? this.casePWaveGain : 1);
        }
        if (beat.pacedMode === 'atrial') {
          pacerSpike += this.drawPacerSpike(time, pCenter - 28);
        }
      }

      if (beat.hasQRS) {
        const dt = time - beat.rTime;
        if (Math.abs(dt) < Math.abs(nearestDtFromR)) nearestDtFromR = dt;
      }

      if (beat.hasQRS && Math.abs(time - beat.rTime) <= beat.qrs * 2) {
        let parts = this.drawQRSParts(time, beat.rTime, beat.qrs, skew, beat, leadKey);
        const leadQGain = this.caseLeadQGain?.[leadKey];
        if (Number.isFinite(leadQGain) && leadQGain >= 0) {
          parts = {
            ...parts,
            q: parts.q * leadQGain
          };
        }
        const leadQrsGain = this.caseLeadQrsGain?.[leadKey];
        if (Number.isFinite(leadQrsGain) && leadQrsGain > 0) {
          parts = {
            q: parts.q * leadQrsGain,
            r: parts.r * leadQrsGain,
            s: parts.s * leadQrsGain
          };
        }

        // In STEMI elevation leads, blunt the S wave so the J-point transitions smoothly into the elevated ST.
        if (hasStemi && stemiMultiplier > 0) {
          parts = { ...parts, s: parts.s * 0.45 };
        }

        qrsParts.q += parts.q;
        qrsParts.r += parts.r;
        qrsParts.s += parts.s;
        qrs += parts.q + parts.r + parts.s;
      }
      if (beat.hasQRS && beat.pacedMode === 'ventricular') {
        const qrsStart = beat.rTime - beat.qrs / 2;
        pacerSpike += this.drawPacerSpike(time, qrsStart - 20);
      }

      if (beat.hasQRS) {
        const qrsStart = beat.rTime - beat.qrs / 2;
        const tEnd = qrsStart + beat.qt;
        const tStart = Math.max(beat.rTime + beat.qrs / 2 + 60, tEnd - this.intervals.tWaveDurationMs);
        const tCenter = (tStart + tEnd) / 2;

        // --- T wave handling ---
        // For STEMI elevation leads, suppress the separate T wave so ST blends into a single dome.
        const isStElevationLead = hasStemi && stemiMultiplier > 0;

        if (beat.hasT !== false && !isStElevationLead && Math.abs(time - tCenter) <= 160) {
          const tScale = this.currentRhythm === 'afib' ? AFIB_T_SCALE : 1;
          let tVal = tScale * this.drawT(time, tCenter, 120);
          if (!hasStemi) {
            const morph = beat?.morphology || 'normal';
            if (morph === 'rbbb') {
              if (isRightPrecordial) {
                // Secondary T inversion in V1–V3.
                const tInvScale = leadKey === 'V1' ? 0.86 : (leadKey === 'V2' ? 0.8 : 0.68);
                tVal = -Math.abs(tVal) * tInvScale;
              } else if (isLateral) {
                // Often opposite terminal S-wave direction (frequently upright).
                tVal = Math.abs(tVal) * 0.9;
              }
            } else if (morph === 'lbbb') {
              // Secondary discordance tuned for board-style LBBB.
              if (['V1', 'V2', 'V3', 'AVR'].includes(leadKey)) {
                if (leadKey === 'V1' || leadKey === 'V2' || leadKey === 'V3') {
                  const shift = leadKey === 'V1' ? -14 : (leadKey === 'V2' ? -12 : -10);
                  const width = leadKey === 'V1' ? 170 : (leadKey === 'V2' ? 166 : 160);
                  const gain = leadKey === 'V1' ? 1.52 : (leadKey === 'V2' ? 1.42 : 1.30);
                  const broadT = this.drawT(time, tCenter + shift, width);
                  tVal = Math.abs(broadT) * gain;
                } else {
                  const upScale = 0.45;
                  tVal = Math.abs(tVal) * upScale;
                }
              } else if (['I', 'II', 'AVL', 'V4', 'V5', 'V6'].includes(leadKey)) {
                const invScale = leadKey === 'V5' || leadKey === 'V6' ? 1.12 : (leadKey === 'I' || leadKey === 'AVL' ? 1.0 : (leadKey === 'II' ? 0.7 : 0.62));
                tVal = -Math.abs(tVal) * invScale;
              } else if (['III', 'AVF'].includes(leadKey)) {
                tVal = -Math.abs(tVal) * 0.35;
              }
            } else if (morph === 'lvh') {
              // Optional LVH strain in lateral leads.
              const lvhStrainGain = Number.isFinite(this.caseLvhStrainGain) ? this.caseLvhStrainGain : 1;
              if (isLateral) {
                const strainScale = leadKey === 'AVL' ? 1.06 : 0.86;
                tVal = -Math.abs(tVal) * strainScale * lvhStrainGain;
              } else if (['V1', 'V2', 'V3'].includes(leadKey)) {
                tVal = Math.abs(tVal) * (0.88 + 0.12 * (lvhStrainGain - 1));
              }
            }
          }
          const leadTGain = this.caseLeadTGain?.[leadKey];
          if (Number.isFinite(leadTGain)) {
            tVal *= leadTGain;
          }
          tWave += tVal;
        }
        if (beat.hasT !== false && (Number.isFinite(this.caseUWaveGain) ? this.caseUWaveGain : 0) > 0) {
          const uCenter = tCenter + 150;
          if (Math.abs(time - uCenter) <= 180) {
            const precordialBoost = ['V2', 'V3', 'V4', 'V5', 'V6'].includes(leadKey) ? 1.0 : 0.65;
            const uVal = this.drawU(time, uCenter, 120) * this.caseUWaveGain * precordialBoost;
            uWave += uVal;
          }
        }
        if (beat.hasT !== false) {
          const dtT = time - tCenter;
          if (Math.abs(dtT) < Math.abs(nearestDtFromT)) nearestDtFromT = dtT;
        }

        if (hasStemi) {
          const qrsEnd = qrsStart + beat.qrs;
          const stStart = qrsEnd;
          const stEnd = tEnd; // extend through repolarization for a continuous dome
          if (stEnd > stStart && time >= stStart && time <= stEnd) {
            const mid = (stStart + stEnd) / 2;
            const dist = Math.abs(time - mid);
            if (dist < nearestStDist) {
              const u = clamp((time - stStart) / ((stEnd - stStart) || 1), 0, 1);

              // Fast J-point rise (first ~8% of ST duration)
              const jRise = smoothstep(0.0, 0.08, u);

              // Remain elevated through mid ST, then smooth decay into end of QT
              const decay = 1 - smoothstep(0.55, 1.0, u);

              // Slight bulge so ST merges into a T-dome rather than staying flat
              const bulge = 1 + 0.18 * Math.sin(Math.PI * clamp((u - 0.25) / 0.75, 0, 1));

              const shape = jRise * decay * bulge;
              const stBaseMv = Number.isFinite(this.caseStemiStMv) ? this.caseStemiStMv : (this.stemiStMv || STEMI_CONFIG.stMv);
              const stPx = stBaseMv * MV_TO_PX_12 * stemiMultiplier;
              st = stPx * shape;
              nearestStDist = dist;
            }
          }
        } else {
          const morph = beat?.morphology || 'normal';
          const hasCaseStOffset =
            this.caseStOffsetOverride &&
            Object.prototype.hasOwnProperty.call(this.caseStOffsetOverride, leadKey);
          if (morph === 'rbbb' || morph === 'lbbb' || morph === 'lvh' || hasCaseStOffset) {
            const qrsEnd = qrsStart + beat.qrs;
            const stStart = qrsEnd;
            const stEnd = Math.min(tEnd, qrsEnd + 170);
            if (stEnd > stStart && time >= stStart && time <= stEnd) {
              const u = clamp((time - stStart) / ((stEnd - stStart) || 1), 0, 1);
              const shape = smoothstep(0.0, 0.12, u) * (1 - smoothstep(0.7, 1.0, u));
              let stMv = 0;
              if (morph === 'rbbb') {
                // Secondary ST depression most prominent in V1–V3.
                if (isRightPrecordial) {
                  stMv = leadKey === 'V1' ? -0.064 : (leadKey === 'V2' ? -0.055 : -0.042);
                }
                else if (isLateral) stMv = 0.02;
              } else if (morph === 'lbbb') {
                // Discordant ST: elevation in right precordials, depression laterally.
                if (leadKey === 'V1') stMv = 0.095;
                else if (leadKey === 'V2') stMv = 0.085;
                else if (leadKey === 'V3') stMv = 0.075;
                else if (leadKey === 'V4') stMv = -0.04;
                else if (leadKey === 'V5' || leadKey === 'V6') stMv = -0.10;
                else if (leadKey === 'I' || leadKey === 'AVL') stMv = -0.08;
                else if (leadKey === 'II') stMv = -0.05;
                else if (leadKey === 'III') stMv = -0.02;
                else if (leadKey === 'AVF') stMv = -0.03;
                else if (leadKey === 'AVR') stMv = 0.04;
              } else if (morph === 'lvh') {
                // Mild lateral downsloping ST depression (strain-like).
                const lvhStrainGain = Number.isFinite(this.caseLvhStrainGain) ? this.caseLvhStrainGain : 1;
                if (isLateral) {
                  stMv = (leadKey === 'AVL' ? -0.075 : -0.052) * lvhStrainGain;
                } else if (['V1', 'V2', 'V3'].includes(leadKey)) {
                  stMv = 0.01 * (0.9 + 0.2 * lvhStrainGain);
                }
              }
              let stShape = shape;
              if (morph === 'lbbb' && (leadKey === 'V1' || leadKey === 'V2' || leadKey === 'V3')) {
                stShape = smoothstep(0.0, 0.34, u) * (1 - smoothstep(0.54, 1.0, u));
              }
              if (hasCaseStOffset) {
                stMv += Number(this.caseStOffsetOverride[leadKey]) || 0;
              }
              st += stMv * MV_TO_PX_12 * stShape;
            }
          }
        }
      }
    }

    let baseline = 0;
    if (isAfib) {
      const blankQRS = this.afibQrsBlanking(nearestDtFromR);
      const blankT = this.afibTBlanking(nearestDtFromT);
      baseline = this.afibBaseline(tMs) * blankQRS * blankT;
    }
    if (isFlutter) {
      const blankQRS = this.afibQrsBlanking(nearestDtFromR);
      const blankT = this.afibTBlanking(nearestDtFromT);
      const flutterBlank = 0.7 + 0.3 * blankQRS * blankT;
      baseline = this.flutterBaseline(tMs) * flutterBlank;
    }

    return {
      total: p + qrs + tWave + uWave + baseline + st + pacerSpike,
      ST: st,
      baseline,
      P: p,
      QRS: qrs,
      T: tWave,
      U: uWave,
      qrsParts
    };
  }

  getBaseVoltageAtTimeMs(tMs) {
    return this.sampleWaveComponentsAtTime(tMs, 'BASE').total;
  }

  drawP(t, center, width) {
    const sigma = width / 6;
    const delta = t - center;
    return AMP_PX.P * Math.exp(-0.5 * Math.pow(delta / (sigma || 1), 2));
  }

  drawQRSParts(t, center, width, skewMs = 0, beat = null, leadKey = 'BASE') {
    const sigma = width / 10;
    const qCenter = center - width * 0.25 + skewMs;
    const sCenter = center + width * 0.25 - skewMs * 0.6;
    const qBase = AMP_PX.Q * Math.exp(-0.5 * Math.pow((t - qCenter) / sigma, 2));
    const rBase = AMP_PX.R * Math.exp(-0.5 * Math.pow((t - center) / sigma, 2));
    const sBase = AMP_PX.S * Math.exp(-0.5 * Math.pow((t - sCenter) / sigma, 2));

    const morphology = beat?.morphology || 'normal';
    let q = qBase;
    let r = rBase;
    let s = sBase;

    if (morphology === 'lbbb') {
      const isV1 = leadKey === 'V1';
      const isV2 = leadKey === 'V2';
      const isV3 = leadKey === 'V3';
      const isI = leadKey === 'I';
      const isII = leadKey === 'II';
      const isIII = leadKey === 'III';
      const isV4 = leadKey === 'V4';
      const isV5 = leadKey === 'V5';
      const isV6 = leadKey === 'V6';
      if (isV1) {
        // Step 1 anchor lead: broad, predominantly negative QRS with tiny initial r.
        r *= 0.02;
        s *= 3.7;
        q *= 0.01;
        // Broaden and delay terminal negativity so recovery is smooth (not a second deflection).
        const lateS = 0.44 * AMP_PX.S * Math.exp(-0.5 * Math.pow((t - (center + width * 0.39)) / (sigma * 2.15), 2));
        s += lateS;
      } else if (isV2) {
        // V2 mirrors V1 pattern but slightly less pronounced.
        r *= 0.024;
        s *= 3.45;
        q *= 0.012;
        const lateS = 0.40 * AMP_PX.S * Math.exp(-0.5 * Math.pow((t - (center + width * 0.385)) / (sigma * 2.0), 2));
        s += lateS;
      } else if (isV3) {
        // V3 remains very similar to V1/V2 with another subtle reduction in depth.
        r *= 0.032;
        s *= 3.1;
        q *= 0.016;
        const lateS = 0.35 * AMP_PX.S * Math.exp(-0.5 * Math.pow((t - (center + width * 0.38)) / (sigma * 1.9), 2));
        s += lateS;
      } else if (isI) {
        // Lead I: most supportive limb lead for LBBB (broad positive, slurred/notched, no q).
        q = 0;
        r *= 1.72;
        s *= 0.18;
        const slur1 = 0.18 * AMP_PX.R * Math.exp(-0.5 * Math.pow((t - (center + width * 0.16)) / (sigma * 1.85), 2));
        const slur2 = 0.14 * AMP_PX.R * Math.exp(-0.5 * Math.pow((t - (center + width * 0.30)) / (sigma * 2.2), 2));
        r += slur1 + slur2;
      } else if (isII) {
        // Lead II: broad mostly-positive QRS, less dramatic/notched than I/V5/V6.
        r *= 1.34;
        s *= 0.42;
        q *= 0.08;
        const terminalSlur = 0.11 * AMP_PX.R * Math.exp(-0.5 * Math.pow((t - (center + width * 0.27)) / (sigma * 1.9), 2));
        r += terminalSlur;
      } else if (isIII) {
        // Lead III: variable morphology but still broad and blunted.
        r *= 0.88;
        s *= 0.88;
        q *= 0.16;
        const broadLateR = 0.06 * AMP_PX.R * Math.exp(-0.5 * Math.pow((t - (center + width * 0.25)) / (sigma * 2.0), 2));
        const broadLateS = 0.12 * AMP_PX.S * Math.exp(-0.5 * Math.pow((t - (center + width * 0.34)) / (sigma * 1.85), 2));
        r += broadLateR;
        s += broadLateS;
      } else if (isV4) {
        // V4: near-isoelectric transitional lead.
        const notchBoost = 0.66;
        q = 0;
        r = 0;
        s *= 0.07;
        const firstPeak = (0.46 * notchBoost) * AMP_PX.R * Math.exp(-0.5 * Math.pow((t - (center + width * 0.082)) / (sigma * 1.48), 2));
        const midDip = (-0.30 * notchBoost) * AMP_PX.R * Math.exp(-0.5 * Math.pow((t - (center + width * 0.182)) / (sigma * 0.98), 2));
        const secondPeak = (0.40 * notchBoost) * AMP_PX.R * Math.exp(-0.5 * Math.pow((t - (center + width * 0.272)) / (sigma * 1.42), 2));
        const terminalSlur = (0.09 * notchBoost) * AMP_PX.R * Math.exp(-0.5 * Math.pow((t - (center + width * 0.365)) / (sigma * 2.0), 2));
        r += firstPeak + midDip + secondPeak + terminalSlur;
        const downstroke = (0.055 * notchBoost) * AMP_PX.S * Math.exp(-0.5 * Math.pow((t - (center + width * 0.355)) / (sigma * 1.55), 2));
        s += downstroke;
      } else if (isV5 || isV6) {
        // LBBB lateral leads: preserve M-shaped notched R, then flow directly
        // into one broad smooth discordant negative wave.
        const notchBoost = isV6 ? 1.15 : 1.05;
        q = 0;
        r = 0;
        s = 0;

        const firstPeak = (isV6 ? 0.82 : 0.76) * notchBoost * AMP_PX.R * Math.exp(
          -0.5 * Math.pow((t - (center + width * (isV6 ? 0.06 : 0.065))) / (sigma * (isV6 ? 1.30 : 1.34)), 2)
        );

        const midDip = -(isV6 ? 0.72 : 0.62) * notchBoost * AMP_PX.R * Math.exp(
          -0.5 * Math.pow((t - (center + width * (isV6 ? 0.16 : 0.165))) / (sigma * (isV6 ? 0.90 : 0.94)), 2)
        );

        const secondPeak = (isV6 ? 0.74 : 0.68) * notchBoost * AMP_PX.R * Math.exp(
          -0.5 * Math.pow((t - (center + width * (isV6 ? 0.25 : 0.255))) / (sigma * (isV6 ? 1.26 : 1.30)), 2)
        );

        const terminalSlur = (isV6 ? 0.22 : 0.20) * notchBoost * AMP_PX.R * Math.exp(
          -0.5 * Math.pow((t - (center + width * (isV6 ? 0.37 : 0.375))) / (sigma * (isV6 ? 2.25 : 2.15)), 2)
        );

        r += firstPeak + midDip + secondPeak + terminalSlur;

        const bridgeDrop = (isV6 ? 0.10 : 0.09) * notchBoost * AMP_PX.S * Math.exp(
          -0.5 * Math.pow((t - (center + width * (isV6 ? 0.40 : 0.405))) / (sigma * (isV6 ? 2.6 : 2.45)), 2)
        );

        const broadTroughMain = (isV6 ? 0.26 : 0.22) * notchBoost * AMP_PX.S * Math.exp(
          -0.5 * Math.pow((t - (center + width * (isV6 ? 0.58 : 0.575))) / (sigma * (isV6 ? 5.0 : 4.7)), 2)
        );

        const broadTroughShoulder = (isV6 ? 0.16 : 0.13) * notchBoost * AMP_PX.S * Math.exp(
          -0.5 * Math.pow((t - (center + width * (isV6 ? 0.69 : 0.68))) / (sigma * (isV6 ? 5.7 : 5.3)), 2)
        );

        const recoveryTail = (isV6 ? 0.05 : 0.045) * notchBoost * AMP_PX.S * Math.exp(
          -0.5 * Math.pow((t - (center + width * (isV6 ? 0.82 : 0.80))) / (sigma * (isV6 ? 6.8 : 6.3)), 2)
        );

        s += bridgeDrop + broadTroughMain + broadTroughShoulder + recoveryTail;
      } else {
        // Keep other leads broad but intentionally generic for stepwise build.
        r *= 1.08;
        s *= 0.72;
        q *= 0.14;
        if (['I', 'AVL', 'V5'].includes(leadKey)) q *= 0.05;
      }
    } else if (morphology === 'paced_ventricular') {
      const isRightPrecordial = ['V1', 'V2', 'V3'].includes(leadKey);
      const isLateral = ['I', 'AVL', 'V5', 'V6'].includes(leadKey);
      if (isRightPrecordial) {
        r *= 0.2;
        s *= 2.0;
        q *= 0.3;
      } else if (isLateral) {
        r *= 1.7;
        s *= 0.2;
        q *= 0.15;
        const notch = 0.26 * AMP_PX.R * Math.exp(-0.5 * Math.pow((t - (center + width * 0.18)) / (sigma * 1.25), 2));
        r += notch;
      } else {
        r *= 1.25;
        s *= 0.55;
      }
    } else if (morphology === 'rbbb') {
      const isV1V2 = ['V1', 'V2'].includes(leadKey);
      const isV3 = leadKey === 'V3';
      const isV4 = leadKey === 'V4';
      const isLateral = ['I', 'AVL', 'V5', 'V6'].includes(leadKey);
      const isInferior = ['II', 'III', 'AVF'].includes(leadKey);
      if (isV1V2) {
        // Classic right-precordial rSR' / rsR' with delayed, smooth terminal R'.
        const isV1 = leadKey === 'V1';
        const rPrimeAmp = isV1 ? 2.02 : 1.66;
        const rPrimeDelay = isV1 ? 0.355 : 0.318;
        const rPrimeWidth = isV1 ? 1.08 : 0.95;
        const rPrime = rPrimeAmp * AMP_PX.R * Math.exp(-0.5 * Math.pow((t - (center + width * rPrimeDelay)) / (sigma * rPrimeWidth), 2));
        r = r * (isV1 ? 0.38 : 0.34) + rPrime;
        s *= isV1 ? 1.12 : 0.92; // keep V2 cleaner/less jagged
        q *= isV1 ? 0.2 : 0.1;
      } else if (isV3) {
        // Transition lead: retain delayed terminal right-precordial force.
        const rPrime = 1.12 * AMP_PX.R * Math.exp(-0.5 * Math.pow((t - (center + width * 0.284)) / (sigma * 1.08), 2));
        r = r * 0.62 + rPrime;
        s *= 1.0;
      } else if (isV4) {
        r *= 0.92;
        s *= 1.28;
        const lateSV4 = 0.24 * AMP_PX.S * Math.exp(-0.5 * Math.pow((t - (center + width * 0.31)) / (sigma * 1.35), 2));
        s += lateSV4;
      } else if (isLateral) {
        // Broad/slurred terminal S in lateral leads.
        const isV5V6 = ['V5', 'V6'].includes(leadKey);
        const lateS1 = (isV5V6 ? 0.8 : 0.62) * AMP_PX.S * Math.exp(-0.5 * Math.pow((t - (center + width * (isV5V6 ? 0.39 : 0.35))) / (sigma * (isV5V6 ? 1.92 : 1.62)), 2));
        const lateS2 = (isV5V6 ? 0.38 : 0.24) * AMP_PX.S * Math.exp(-0.5 * Math.pow((t - (center + width * (isV5V6 ? 0.46 : 0.41))) / (sigma * (isV5V6 ? 2.1 : 1.8)), 2));
        s = s * (isV5V6 ? 2.36 : 2.08) + lateS1 + lateS2;
        r *= isV5V6 ? 0.82 : 0.86;
      } else if (isInferior) {
        r *= 0.98;
        s *= 1.28;
      } else {
        s *= 1.24;
      }
    } else if (morphology === 'lvh') {
      const isV1 = leadKey === 'V1';
      const isV2 = leadKey === 'V2';
      const isV3 = leadKey === 'V3';
      const isV4 = leadKey === 'V4';
      const isV5 = leadKey === 'V5';
      const isV6 = leadKey === 'V6';
      const isAVL = leadKey === 'AVL';
      const isI = leadKey === 'I';
      const isLateral = isI || isAVL || isV5 || isV6;
      const isInferior = ['II', 'III', 'AVF'].includes(leadKey);

      if (isV1 || isV2 || isV3) {
        // LVH voltage: deep S in right precordials with delayed transition.
        const sAmp = isV1 ? 2.25 : (isV2 ? 2.05 : 1.7);
        const rAmp = isV1 ? 0.22 : (isV2 ? 0.34 : 0.52);
        s *= sAmp;
        r *= rAmp;
        q *= 0.16;
        const lateS = 0.2 * AMP_PX.S * Math.exp(-0.5 * Math.pow((t - (center + width * 0.3)) / (sigma * 1.28), 2));
        s += lateS;
      } else if (isV4) {
        // Delayed precordial transition.
        r *= 1.18;
        s *= 0.88;
        q *= 0.1;
      } else if (isV5 || isV6) {
        // Very tall dominant R with little to no S.
        r *= isV5 ? 2.35 : 2.2;
        s *= 0.08;
        q *= 0.04;
      } else if (isAVL) {
        // Prominent tall R in aVL.
        r *= 2.15;
        s *= 0.12;
        q *= 0.04;
      } else if (isI) {
        r *= 1.72;
        s *= 0.2;
        q *= 0.08;
      } else if (isInferior) {
        r *= 1.12;
        s *= 0.66;
        q *= 0.22;
      } else if (isLateral) {
        r *= 1.4;
        s *= 0.25;
      } else {
        r *= 1.2;
        s *= 0.55;
      }
      const lvhGain = Number.isFinite(this.caseLvhGain) ? this.caseLvhGain : 1;
      if (lvhGain !== 1) {
        r *= lvhGain;
        s *= lvhGain;
        q *= clamp(0.92 * lvhGain, 0.75, 1.35);
      }
    } else if (morphology === 'wpw') {
      const isPrecordial = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6'].includes(leadKey);
      const isLeadIII = leadKey === 'III';
      const isLeadV1 = leadKey === 'V1';
      const isLeadV2 = leadKey === 'V2';
      const isLeadV3 = leadKey === 'V3';
      const isLeadV4 = leadKey === 'V4';
      const isLeadV5 = leadKey === 'V5';
      const isLeadV6 = leadKey === 'V6';

      // Keep QRS overall narrow, but make pre-excitation clearly visible.
      q *= isLeadIII ? 1.7 : 0.28;
      r *= isPrecordial ? 1.28 : 1.0;
      s *= isPrecordial ? 0.72 : 0.88;

      // Delta wave: stronger/broader early shoulder + bridge into the R upstroke.
      const deltaMain = (isPrecordial ? 0.82 : 0.62) * AMP_PX.R * Math.exp(
        -0.5 * Math.pow((t - (center - width * 0.41)) / (sigma * 4.2), 2)
      );
      const deltaBridge = (isPrecordial ? 0.40 : 0.30) * AMP_PX.R * Math.exp(
        -0.5 * Math.pow((t - (center - width * 0.28)) / (sigma * 3.1), 2)
      );
      const deltaTail = (isPrecordial ? 0.24 : 0.18) * AMP_PX.R * Math.exp(
        -0.5 * Math.pow((t - (center - width * 0.20)) / (sigma * 2.0), 2)
      );
      r += deltaMain + deltaBridge + deltaTail;

      // Higher precordial voltages (can mimic LVH in WPW pattern).
      if (isLeadV1) r *= 1.12;
      if (isLeadV2) r *= 1.2;
      if (isLeadV3) r *= 1.28;
      if (isLeadV4) r *= 1.34;
      if (isLeadV5) r *= 1.32;
      if (isLeadV6) r *= 1.22;

      // Lead III pseudo-infarct pattern tendency.
      if (isLeadIII) {
        const qExtra = 0.26 * AMP_PX.Q * Math.exp(
          -0.5 * Math.pow((t - (center - width * 0.38)) / (sigma * 1.2), 2)
        );
        q += qExtra;
      }
    } else if (morphology === 'pvc') {
      const isRightPrecordial = ['V1', 'V2'].includes(leadKey);
      if (isRightPrecordial) {
        r *= 0.35;
        s *= 1.9;
      } else {
        r *= 1.25;
        s *= 0.55;
      }
      q *= 0.5;
    }
    return { q, r, s };
  }

  drawPacerSpike(t, center) {
    const sigma = 1.2;
    return 0.55 * AMP_PX.R * Math.exp(-0.5 * Math.pow((t - center) / sigma, 2));
  }

  drawQRS(t, center, width, skewMs = 0) {
    const parts = this.drawQRSParts(t, center, width, skewMs);
    return parts.q + parts.r + parts.s;
  }

  drawT(t, center, width) {
    const sigma = width / 5;
    const delta = t - center;
    return AMP_PX.T * Math.exp(-0.5 * Math.pow(delta / (sigma || 1), 2));
  }

  drawU(t, center, width) {
    const sigma = width / 5.5;
    const delta = t - center;
    return 0.22 * AMP_PX.T * Math.exp(-0.5 * Math.pow(delta / (sigma || 1), 2));
  }

  waveTypeAtTime(tMs) {
    const duration = this.rhythmDurationMs || 8000;
    const time = ((tMs % duration) + duration) % duration;
    let closest = { type: 'BASE', dist: Infinity };
    const consider = (type, center, window) => {
      const dist = Math.abs(time - center);
      if (dist < window && dist < closest.dist) closest = { type, dist };
    };
    const isAfib = this.currentRhythm === 'afib' || this.currentRhythm === 'aflutter';
    for (const beat of this.beatSchedule) {
      if (!isAfib && beat.hasP) consider('P', beat.rTime - beat.pr + 40, 90);
      consider('QRS', beat.rTime, beat.qrs);
      if (beat.hasQRS && beat.hasT !== false) {
        const qrsStart = beat.rTime - beat.qrs / 2;
        const tEnd = qrsStart + beat.qt;
        const tStart = Math.max(beat.rTime + beat.qrs / 2 + 60, tEnd - this.intervals.tWaveDurationMs);
        const tCenter = (tStart + tEnd) / 2;
        consider('T', tCenter, Math.max(80, tEnd - tStart));
      }
    }
    return closest.type;
  }
}

window.Ecg12Simulator = Ecg12Simulator;

window.initEcg12Simulator = function initEcg12Simulator(rootEl) {
  console.log('[EKG12] init called', rootEl);
  if (!rootEl) return null;
  if (rootEl.__ecg12Initialized && rootEl.__ecg12Sim) return rootEl.__ecg12Sim;

  const scoped = (id) => rootEl.querySelector(`#${id}`);

  const backgroundCanvas = scoped('ecg12Background');
  const traceCanvas = scoped('ecg12Trace');
  const overlayCanvas = scoped('ecg12Overlay');
  const bigBackgroundCanvas = scoped('ecg12BigBackground');
  const bigTraceCanvas = scoped('ecg12BigTrace');
  const bigOverlayCanvas = scoped('ecg12BigOverlay');

  if (!backgroundCanvas || !traceCanvas || !overlayCanvas) {
    console.warn('[EKG12] missing canvas', {
      backgroundCanvas,
      traceCanvas,
      overlayCanvas
    });
    return null;
  }

  const sim = new Ecg12Simulator(
    {
      backgroundCanvas,
      traceCanvas,
      overlayCanvas,
      bigBackgroundCanvas,
      bigTraceCanvas,
      bigOverlayCanvas
    },
    { displayTime: 10, heartRate: 75 }
  );

  rootEl.__ecg12Initialized = true;
  rootEl.__ecg12Sim = sim;

  sim.forceLayout = () => {
    if (typeof sim.handleResize === 'function') sim.handleResize();
    if (typeof sim.drawGrid === 'function') sim.drawGrid();
    if (typeof sim.drawBigGrid === 'function') sim.drawBigGrid();
    if (typeof sim.drawTrace === 'function') sim.drawTrace();
    if (typeof sim.drawExpandedTrace === 'function') sim.drawExpandedTrace();
  };

  const gridWrap = scoped('ecg12GridWrap');
  if (gridWrap) {
    gridWrap.addEventListener('scroll', () => sim.drawReadoutOverlay());
  }

  const heartRateInput = scoped('ecg12HeartRate');
  const axisModeSelect = scoped('ecg12AxisMode');
  const leadISignSelect = scoped('ecg12LeadISign');
  const leadIISignSelect = scoped('ecg12LeadIISign');
  const rhythmSelect = scoped('ecg12RhythmPreset');
  const measureToggle = scoped('ecg12MeasureTool');
  const measureHint = scoped('ecg12MeasureHint');
  const playBtn = scoped('ecg12Play');
  const pauseBtn = scoped('ecg12Pause');
  const resetBtn = scoped('ecg12Reset');
  const expandedLabel = scoped('ecg12ActiveLead');
  const trace = scoped('ecg12Trace');

  const clampNumber = (val, min, max) => Math.min(Math.max(val, min), max);

  const updateExpandedLabel = () => {
    if (expandedLabel) {
      expandedLabel.textContent = sim.getSelectedLead();
    }
  };

  const commitHeartRate = () => {
    if (!heartRateInput) return;
    const clampRange = typeof sim.getHeartRateClamp === 'function'
      ? sim.getHeartRateClamp()
      : { min: 40, max: 180 };
    const raw = parseInt(heartRateInput.value || String(sim.getHeartRate ? sim.getHeartRate() : clampRange.min), 10);
    const fallback = Number.isNaN(raw) ? (sim.getHeartRate ? sim.getHeartRate() : clampRange.min) : raw;
    const target = clampNumber(fallback, clampRange.min, clampRange.max);
    const applied = typeof sim.setHeartRate === 'function' ? sim.setHeartRate(target) : target;
    heartRateInput.value = applied;
  };

  const syncHeartRateInput = () => {
    if (!heartRateInput) return;
    const clampRange = typeof sim.getHeartRateClamp === 'function'
      ? sim.getHeartRateClamp()
      : { min: 40, max: 180 };
    heartRateInput.min = clampRange.min;
    heartRateInput.max = clampRange.max;
    const hr = sim.getHeartRate ? sim.getHeartRate() : clampNumber(75, clampRange.min, clampRange.max);
    heartRateInput.value = hr;
  };

  if (heartRateInput) {
    heartRateInput.addEventListener('change', commitHeartRate);
    heartRateInput.addEventListener('blur', commitHeartRate);
  }

  const axisModeToQuadrant = {
    normal: { leadI: 'pos', leadII: 'pos' },
    lad: { leadI: 'pos', leadII: 'neg' },
    rad: { leadI: 'neg', leadII: 'pos' },
    extreme: { leadI: 'neg', leadII: 'neg' }
  };

  const quadrantToAxisMode = (leadISign, leadIISign) => {
    if (leadISign === 'pos' && leadIISign === 'pos') return 'normal';
    if (leadISign === 'pos' && leadIISign === 'neg') return 'lad';
    if (leadISign === 'neg' && leadIISign === 'pos') return 'rad';
    return 'extreme';
  };

  let syncingAxisControls = false;

  const syncQuadrantFromMode = (mode) => {
    const mapping = axisModeToQuadrant[mode] || axisModeToQuadrant.normal;
    syncingAxisControls = true;
    if (leadISignSelect) leadISignSelect.value = mapping.leadI;
    if (leadIISignSelect) leadIISignSelect.value = mapping.leadII;
    syncingAxisControls = false;
  };

  const applyAxisMode = (mode) => {
    const normalized = axisModeToQuadrant[mode] ? mode : 'normal';
    if (axisModeSelect) axisModeSelect.value = normalized;
    sim.setAxisMode(normalized);
    syncQuadrantFromMode(normalized);
  };

  if (axisModeSelect) {
    axisModeSelect.addEventListener('change', () => applyAxisMode(axisModeSelect.value));
  }

  const handleQuadrantChange = () => {
    if (syncingAxisControls) return;
    const leadISign = leadISignSelect ? leadISignSelect.value : 'pos';
    const leadIISign = leadIISignSelect ? leadIISignSelect.value : 'pos';
    const mode = quadrantToAxisMode(leadISign, leadIISign);
    if (axisModeSelect) axisModeSelect.value = mode;
    sim.setAxisMode(mode);
  };

  if (leadISignSelect) leadISignSelect.addEventListener('change', handleQuadrantChange);
  if (leadIISignSelect) leadIISignSelect.addEventListener('change', handleQuadrantChange);

  const handleRhythmChange = () => {
    if (!rhythmSelect) return;
    const desired = rhythmSelect.value;
    if (typeof sim.setRhythm === 'function') {
      sim.setRhythm(desired);
      const current = sim.getCurrentRhythm ? sim.getCurrentRhythm() : desired;
      rhythmSelect.value = current;
      syncHeartRateInput();
    }
  };

  const populateRhythmOptions = () => {
    if (!rhythmSelect || typeof sim.getRhythmList !== 'function') return;
    const rhythms = sim.getRhythmList();
    if (rhythms && rhythms.length) {
      rhythmSelect.innerHTML = '';
      rhythms.forEach(({ id, label }) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = label;
        rhythmSelect.appendChild(option);
      });
    }
    const current = sim.getCurrentRhythm ? sim.getCurrentRhythm() : null;
    if (current) rhythmSelect.value = current;
    rhythmSelect.addEventListener('change', handleRhythmChange);
  };

  const highlightIds = [
    ['ecg12HighlightP', 'P'],
    ['ecg12HighlightQRS', 'QRS'],
    ['ecg12HighlightT', 'T']
  ];
  const intervalHighlightIds = [
    ['ecg12HighlightPR', 'PR'],
    ['ecg12HighlightQRSDur', 'QRSd'],
    ['ecg12HighlightQT', 'QT'],
    ['ecg12HighlightRR', 'RR']
  ];

  const updateHighlights = () => {
    const highlightState = {};
    highlightIds.forEach(([id, key]) => {
      const el = scoped(id);
      highlightState[key] = !!(el && el.checked);
    });
    sim.setHighlights(highlightState);

    const intervalState = {};
    intervalHighlightIds.forEach(([id, key]) => {
      const el = scoped(id);
      intervalState[key] = !!(el && el.checked);
    });
    sim.setIntervalHighlights(intervalState);

    if (measureToggle) {
      const enabled = !!measureToggle.checked;
      if (measureHint) {
        measureHint.classList.toggle('active', enabled);
      }
      if (typeof sim.setMeasureToolEnabled === 'function') {
        sim.setMeasureToolEnabled(enabled);
      }
    }
  };

  [...highlightIds, ...intervalHighlightIds].forEach(([id]) => {
    const el = scoped(id);
    if (el) el.addEventListener('change', updateHighlights);
  });
  if (measureToggle) measureToggle.addEventListener('change', updateHighlights);

  if (playBtn) playBtn.addEventListener('click', () => sim.play());
  if (pauseBtn) pauseBtn.addEventListener('click', () => sim.pause());
  if (resetBtn) resetBtn.addEventListener('click', () => sim.reset());

  const handleLeadClick = (event) => {
    if (sim.handleReadoutClick && sim.handleReadoutClick(event)) return;
    const lead = sim.getLeadAtEvent(event);
    if (lead) {
      sim.setSelectedLead(lead);
      updateExpandedLabel();
    }
  };

  [trace, overlayCanvas].filter(Boolean).forEach((canvas) => {
    canvas.addEventListener('click', handleLeadClick);
  });

  if (gridWrap) {
    gridWrap.addEventListener('mousemove', (event) => {
      sim.setHoverLead(sim.getLeadAtEvent(event));
    });
  }

  const initialAxisMode = typeof sim.getAxisMode === 'function' ? sim.getAxisMode() : 'normal';
  applyAxisMode(initialAxisMode);
  populateRhythmOptions();
  syncHeartRateInput();

  sim.setHoverLead(null);
  updateHighlights();
  updateExpandedLabel();

  sim.handleResize();
  sim.reset();

  return sim;
};

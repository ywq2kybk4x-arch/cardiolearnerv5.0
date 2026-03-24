'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const SOUND_ON_BPM = 75;
  const SOUND_OFF_BPM = 25;
  const DEFAULT_VOLUME = 0.6;
  const DEFAULT_COMPARE_ON = true;
  const SYSTOLE_FRACTION = 0.4;
  const S2_OFFSET_SEC = -0.03;
  const AR_SILENCE_FRACTION = 0.375;
  const AR_FADE_START = 1 - AR_SILENCE_FRACTION - 0.08;
  const AR_FADE_END = 1 - AR_SILENCE_FRACTION;
  const MURMUR_GAIN = 0.45;

  function buildTimeline(cycleMs) {
    const durationSec = cycleMs / 1000;
    const systoleFrac = SYSTOLE_FRACTION || 0.4;
    const s1Sec = 0;
    const s2Sec = Math.max(0, systoleFrac * durationSec + S2_OFFSET_SEC);
    return {
      durationSec,
      systoleFrac,
      s1Sec,
      s2Sec,
      s1Phase: s1Sec / durationSec,
      s2Phase: s2Sec / durationSec
    };
  }

  function smoothStep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  // Data-driven murmur configuration with timing and shapes.
  const MURMURS = {
    normal: {
      id: 'normal',
      name: 'Normal (no murmur)',
      type: 'none',
      shape: 'none',
      timing: null,
      side: 'none',
      profile: {
        timing: 'No pathologic turbulence',
        quality: 'Normal S1 and S2',
        pitch: 'Physiologic heart sounds',
        location: 'All valve areas (normal exam)',
        radiation: 'None',
        increase: 'N/A',
        decrease: 'N/A',
        mechanism: 'Normal laminar forward flow through all valves.'
      },
      flowPattern: () => ({ mr: 0, ar: 0, ms: 0, asGradient: 0, hcmGradient: 0, mvp: 0 }),
      info: [
        'No pathologic murmur.',
        'Normal laminar flow through all valves.',
        'S1 marks AV valve closure at systole onset; S2 marks semilunar closure at systole end.'
      ]
    },
    as: {
      id: 'as',
      name: 'Aortic stenosis',
      type: 'systolic',
      shape: 'crescendo-decrescendo',
      timing: { start: 0, end: SYSTOLE_FRACTION },
      side: 'left',
      profile: {
        timing: 'Midsystolic ejection murmur',
        quality: 'Crescendo-decrescendo, harsh',
        pitch: 'Medium to high',
        location: 'Right upper sternal border',
        radiation: 'Carotid arteries',
        increase: 'Squatting, passive leg raise',
        decrease: 'Valsalva strain, standing, handgrip',
        mechanism: 'Fixed LV outflow obstruction across a stenotic aortic valve.'
      },
      flowPattern: (phase, isSystole) => {
        if (!isSystole) {
          return { mr: 0, ar: 0, ms: 0, asGradient: 0, hcmGradient: 0, mvp: 0 };
        }
        const asGradient = Math.sin(Math.PI * phase);
        return { mr: 0, ar: 0, ms: 0, asGradient, hcmGradient: 0, mvp: 0 };
      },
      info: [
        'Harsh midsystolic crescendo-decrescendo murmur (ejection murmur).',
        'Best heard at the right upper sternal border; classically radiates to the carotids.',
        'Pathophysiology: fixed LV outflow obstruction from a stenotic aortic valve.',
        'Step 1 maneuver pattern: softer with Valsalva/standing, louder with squatting or passive leg raise; handgrip usually softens AS.'
      ]
    },
    mr: {
      id: 'mr',
      name: 'Mitral regurgitation',
      type: 'systolic',
      shape: 'holo',
      timing: { start: 0, end: SYSTOLE_FRACTION },
      side: 'left',
      profile: {
        timing: 'Holosystolic',
        quality: 'Blowing regurgitant murmur',
        pitch: 'High',
        location: 'Cardiac apex',
        radiation: 'Left axilla',
        increase: 'Handgrip, squatting, passive leg raise',
        decrease: 'Valsalva strain, standing',
        mechanism: 'Incompetent mitral closure allows LV -> LA regurgitation in systole.'
      },
      flowPattern: (phase, isSystole) => ({
        mr: isSystole ? 1 : 0,
        ar: 0,
        ms: 0,
        asGradient: 0,
        hcmGradient: 0,
        mvp: 0
      }),
      info: [
        'High-pitched blowing holosystolic murmur.',
        'Best heard at the apex; classically radiates to the left axilla.',
        'Pathophysiology: retrograde LV -> LA flow throughout systole.',
        'Step 1 maneuver pattern: louder with handgrip (increased afterload) and usually with squat/leg raise; softer with Valsalva/standing.'
      ]
    },
    ar: {
      id: 'ar',
      name: 'Aortic regurgitation',
      type: 'diastolic',
      shape: 'decrescendo',
      timing: { start: SYSTOLE_FRACTION + 0.03, end: AR_FADE_END },
      side: 'left',
      profile: {
        timing: 'Early diastolic',
        quality: 'Decrescendo regurgitant murmur',
        pitch: 'High',
        location: 'Left sternal border',
        radiation: 'Along left sternal edge',
        increase: 'Handgrip, squatting',
        decrease: 'Valsalva strain, standing',
        mechanism: 'Aortic valve incompetence causes aortic backflow into LV in diastole.'
      },
      flowPattern: (phase, isSystole) => {
        if (isSystole) {
          return { mr: 0, ar: 0, ms: 0, asGradient: 0, hcmGradient: 0, mvp: 0 };
        }
        const taper = 1 - smoothStep(AR_FADE_START, AR_FADE_END, phase);
        const ar = Math.exp(-phase * 1.1) * taper;
        return { mr: 0, ar, ms: 0, asGradient: 0, hcmGradient: 0, mvp: 0 };
      },
      info: [
        'High-pitched early diastolic decrescendo murmur.',
        'Best heard along the left sternal border with patient leaning forward at end-expiration.',
        'Pathophysiology: retrograde aorta -> LV flow during diastole.',
        'Step 1 maneuver pattern: often louder with handgrip (higher afterload); generally softer with Valsalva/standing.'
      ]
    },
    ms: {
      id: 'ms',
      name: 'Mitral stenosis',
      type: 'diastolic',
      shape: 'decrescendo-crescendo',
      timing: { start: SYSTOLE_FRACTION + 0.02, end: 0.98 },
      side: 'left',
      profile: {
        timing: 'Mid-to-late diastolic',
        quality: 'Low rumble with opening snap',
        pitch: 'Low',
        location: 'Cardiac apex (left lateral decubitus)',
        radiation: 'Minimal',
        increase: 'Mildly with increased preload',
        decrease: 'Valsalva strain, standing',
        mechanism: 'Narrowed mitral valve restricts LA -> LV filling.'
      },
      flowPattern: (phase, isSystole) => {
        if (isSystole) {
          return { mr: 0, ar: 0, ms: 0, asGradient: 0, hcmGradient: 0, mvp: 0 };
        }
        const ms = 0.5 + 0.3 * Math.sin(Math.PI * (phase - 0.25));
        return { mr: 0, ar: 0, ms: Math.max(0, ms), asGradient: 0, hcmGradient: 0, mvp: 0 };
      },
      info: [
        'Low-pitched diastolic rumble with opening snap after S2.',
        'Best heard at the apex in left lateral decubitus position.',
        'Pathophysiology: restricted LA -> LV filling across a narrowed mitral valve.',
        'Presystolic accentuation is most evident when sinus rhythm is present.'
      ]
    },
    hcm: {
      id: 'hcm',
      name: 'Hypertrophic cardiomyopathy',
      type: 'systolic',
      shape: 'crescendo-decrescendo',
      timing: { start: 0.05, end: SYSTOLE_FRACTION - 0.02 },
      side: 'left',
      profile: {
        timing: 'Midsystolic ejection murmur',
        quality: 'Dynamic crescendo-decrescendo',
        pitch: 'Medium',
        location: 'Left lower sternal border to apex',
        radiation: 'Limited (less carotid radiation than AS)',
        increase: 'Valsalva strain, standing',
        decrease: 'Squatting, passive leg raise, handgrip',
        mechanism: 'Dynamic LV outflow tract obstruction from septal hypertrophy.'
      },
      flowPattern: (phase, isSystole) => {
        if (!isSystole) {
          return { mr: 0, ar: 0, ms: 0, asGradient: 0, hcmGradient: 0, mvp: 0 };
        }
        const x = Math.max(0, Math.min(1, (phase - 0.08) / 0.84));
        const hcmGradient = Math.pow(Math.sin(Math.PI * x), 1.2);
        return { mr: 0, ar: 0, ms: 0, asGradient: 0, hcmGradient, mvp: 0 };
      },
      info: [
        'Dynamic systolic crescendo-decrescendo murmur from LVOT obstruction.',
        'Typically best heard at left sternal border/apex.',
        'Increases with lower preload (Valsalva/standing), decreases with higher preload or afterload (squatting/handgrip).'
      ]
    },
    mvp: {
      id: 'mvp',
      name: 'Mitral valve prolapse',
      type: 'systolic',
      shape: 'late-crescendo',
      timing: { start: SYSTOLE_FRACTION * 0.5, end: SYSTOLE_FRACTION },
      side: 'left',
      profile: {
        timing: 'Late systolic',
        quality: 'Click followed by late systolic murmur',
        pitch: 'Mid to high',
        location: 'Cardiac apex',
        radiation: 'Variable, may extend toward axilla',
        increase: 'Valsalva strain, standing',
        decrease: 'Squatting, passive leg raise, handgrip',
        mechanism: 'Late systolic leaflet prolapse with mitral regurgitation.'
      },
      flowPattern: (phase, isSystole) => {
        if (!isSystole) {
          return { mr: 0, ar: 0, ms: 0, asGradient: 0, hcmGradient: 0, mvp: 0 };
        }
        const start = 0.52;
        if (phase < start) {
          return { mr: 0, ar: 0, ms: 0, asGradient: 0, hcmGradient: 0, mvp: 0 };
        }
        const x = (phase - start) / (1 - start);
        const lateMr = 0.45 + 0.55 * x;
        return { mr: lateMr, ar: 0, ms: 0, asGradient: 0, hcmGradient: 0, mvp: lateMr };
      },
      info: [
        'Mid-systolic click with late systolic murmur.',
        'Murmur begins later in systole than classic holosystolic MR.',
        'With lower preload (Valsalva/standing), click and murmur move earlier and intensify.'
      ]
    }
  };

  class HeartSoundEngine {
    constructor() {
      this.audioCtx = null;
      this.currentBuffer = null;
      this.source = null;
      this.gainNode = null;
      this.enabled = true;
      this.cycleMs = 800;
      this.currentMurmurId = 'normal';
      this.isPlaying = false;
      this.murmurBuffers = {};
      this.supported = Boolean(window.AudioContext || window.webkitAudioContext);
      this.volume = 0.6;
      this.startTime = null;
      this.s1PhaseJitter = 0;
      this.s2PhaseJitter = 0;
      this.s1NoiseState = 0;
      this.s2NoiseState = 0;
      this.murmurBeatScale = 1;
    }

    ensureContext() {
      if (!this.supported) {
        this.enabled = false;
        return false;
      }
      if (!this.audioCtx) {
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioCtor();
        this.gainNode = this.audioCtx.createGain();
        this.gainNode.gain.value = this.volume;
        this.gainNode.connect(this.audioCtx.destination);
      }
      return true;
    }

    setEnabled(enabled) {
      this.enabled = enabled;
      if (!enabled) {
        this.stopSourceOnly();
        return;
      }
      if (this.isPlaying) {
        this.updateBuffer();
      }
    }

    setCycleDuration(cycleMs) {
      this.cycleMs = cycleMs;
      this.updateBuffer();
    }

    setMurmur(murmurId) {
      this.currentMurmurId = murmurId;
      this.updateBuffer();
    }

    updateBuffer() {
      if (!this.enabled) {
        return;
      }
      if (!this.ensureContext()) {
        return;
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }

      this.stopSourceOnly();

      const cacheKey = `${this.currentMurmurId}:${this.cycleMs}`;
      if (this.murmurBuffers[cacheKey]) {
        this.currentBuffer = this.murmurBuffers[cacheKey];
      } else {
        this.currentBuffer = this.generateCycleBuffer(this.currentMurmurId, this.cycleMs);
        this.murmurBuffers[cacheKey] = this.currentBuffer;
      }

      if (this.isPlaying) {
        this.playFromStart();
      }
    }

    stopSourceOnly() {
      if (this.source) {
        try {
          this.source.stop();
        } catch (e) {
          // Ignore if already stopped.
        }
        this.source.disconnect();
        this.source = null;
      }
    }

    playFromStart() {
      if (!this.enabled) {
        return;
      }
      if (!this.ensureContext()) {
        return;
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }
      if (!this.currentBuffer) {
        this.currentBuffer = this.generateCycleBuffer(this.currentMurmurId, this.cycleMs);
      }
      this.stopSourceOnly();
      this.source = this.audioCtx.createBufferSource();
      this.source.buffer = this.currentBuffer;
      this.source.loop = true;
      this.source.connect(this.gainNode || this.audioCtx.destination);
      this.startTime = this.audioCtx.currentTime;
      this.source.start();
    }

    play() {
      this.isPlaying = true;
      if (!this.enabled) {
        return;
      }
      if (!this.currentBuffer) {
        this.updateBuffer();
      } else {
        this.playFromStart();
      }
    }

    stop() {
      this.isPlaying = false;
      this.stopSourceOnly();
    }

    getPhase(cycleMs) {
      if (!this.audioCtx || this.startTime === null) {
        return null;
      }
      const durationSec = cycleMs / 1000;
      const elapsed = this.audioCtx.currentTime - this.startTime;
      if (elapsed < 0) {
        return 0;
      }
      const phase = (elapsed % durationSec) / durationSec;
      return phase;
    }

    setVolume(value) {
      this.volume = value;
      if (this.gainNode) {
        this.gainNode.gain.value = value;
      }
    }

    generateCycleBuffer(murmurId, cycleMs) {
      const ctx = this.audioCtx;
      const sampleRate = ctx.sampleRate;
      const timeline = buildTimeline(cycleMs);
      const durationSec = timeline.durationSec;
      const frameCount = Math.floor(sampleRate * durationSec);

      const buffer = ctx.createBuffer(1, frameCount, sampleRate);
      const data = buffer.getChannelData(0);

      const systoleFraction = timeline.systoleFrac;
      const s1TimeBase = timeline.s1Sec;
      const s2TimeBase = timeline.s2Sec;

      const jitterS1 = (Math.random() - 0.5) * 0.005;
      const jitterS2 = (Math.random() - 0.5) * 0.005;
      const s1Time = s1TimeBase + jitterS1;
      const s2Time = s2TimeBase + jitterS2;

      this.s1PhaseJitter = (Math.random() - 0.5) * 0.8;
      this.s2PhaseJitter = (Math.random() - 0.5) * 0.8;
      this.s1NoiseState = 0;
      this.s2NoiseState = 0;
      this.murmurBeatScale = 0.9 + 0.2 * Math.random();

      const noiseState = { lowFast: 0, lowSlow: 0 };
      const noiseConfig = this.getNoiseConfig(murmurId);
      const timbre = this.getMurmurTimbre(murmurId);

      for (let i = 0; i < frameCount; i += 1) {
        const t = i / sampleRate;
        let v = 0;

        const white = (Math.random() * 2 - 1);
        noiseState.lowFast += (white - noiseState.lowFast) * noiseConfig.fast;
        noiseState.lowSlow += (white - noiseState.lowSlow) * noiseConfig.slow;
        const low = noiseState.lowSlow;
        const mid = noiseState.lowFast - noiseState.lowSlow;
        const flowNoise = timbre.lowWeight * low + timbre.midWeight * mid;

        v += this.s1Component(t, s1Time);
        v += this.s2Component(t, s2Time);
        v += this.valvularExtraComponent(t, murmurId, s1Time, s2Time, durationSec);
        v += this.murmurComponent(t, durationSec, systoleFraction, murmurId, flowNoise);
        v += 0.0015 * white;

        data[i] = v;
      }

      let max = 0;
      for (let i = 0; i < frameCount; i += 1) {
        const a = Math.abs(data[i]);
        if (a > max) {
          max = a;
        }
      }
      if (max > 0) {
        const scale = 0.9 / max;
        for (let i = 0; i < frameCount; i += 1) {
          data[i] *= scale;
        }
      }

      let lp = 0;
      let sub = 0;
      const alpha = 0.12;
      for (let i = 0; i < frameCount; i += 1) {
        lp += alpha * (data[i] - lp);
        sub += 0.018 * (lp - sub);
        data[i] = lp - 0.4 * sub;
      }

      return buffer;
    }

    valvularExtraComponent(t, murmurId, s1Time, s2Time, durationSec) {
      let v = 0;

      if (murmurId === 'ms') {
        const osDelaySec = Math.min(0.08, 0.14 * durationSec);
        const dt = t - (s2Time + osDelaySec);
        if (dt >= 0 && dt <= 0.028) {
          const env = (1 - Math.exp(-dt / 0.0015)) * Math.exp(-dt / 0.012);
          const click =
            0.75 * Math.sin(2 * Math.PI * 170 * dt) +
            0.45 * Math.sin(2 * Math.PI * 240 * dt);
          v += 0.16 * env * click;
        }
      }

      if (murmurId === 'as') {
        const ecDelaySec = Math.min(0.05, 0.08 * durationSec);
        const dt = t - (s1Time + ecDelaySec);
        if (dt >= 0 && dt <= 0.02) {
          const env = (1 - Math.exp(-dt / 0.0012)) * Math.exp(-dt / 0.008);
          const click =
            0.7 * Math.sin(2 * Math.PI * 140 * dt) +
            0.4 * Math.sin(2 * Math.PI * 210 * dt);
          v += 0.1 * env * click;
        }
      }

      if (murmurId === 'mvp') {
        const clickDelay = 0.58 * (s2Time - s1Time);
        const dt = t - (s1Time + clickDelay);
        if (dt >= 0 && dt <= 0.024) {
          const env = (1 - Math.exp(-dt / 0.001)) * Math.exp(-dt / 0.009);
          const click =
            0.7 * Math.sin(2 * Math.PI * 180 * dt) +
            0.45 * Math.sin(2 * Math.PI * 260 * dt);
          v += 0.13 * env * click;
        }
      }

      return v;
    }

    s1Component(t, onsetTime) {
      const dt = t - onsetTime;
      const duration = 0.095;
      if (dt < 0 || dt > duration) {
        return 0;
      }
      const attack = 0.006;
      const decay = 0.075;
      const env = (1 - Math.exp(-dt / attack)) * Math.exp(-dt / decay);

      const phaseJitter = this.s1PhaseJitter || 0;
      const f1 = 42;
      const f2 = 68;
      const f3 = 120;

      const tone =
        0.9 * Math.sin(2 * Math.PI * f1 * dt + phaseJitter) +
        0.6 * Math.sin(2 * Math.PI * f2 * dt + 0.7 * phaseJitter) +
        0.35 * Math.sin(2 * Math.PI * f3 * dt + 1.3 * phaseJitter);

      const noiseTarget = (Math.random() * 2 - 1);
      this.s1NoiseState += (noiseTarget - this.s1NoiseState) * 0.12;
      const noise = this.s1NoiseState * 0.25;

      return env * (0.55 * tone + noise);
    }

    s2Component(t, onsetTime) {
      const dt = t - onsetTime;
      const duration = 0.075;
      if (dt < 0 || dt > duration) {
        return 0;
      }
      const attack = 0.004;
      const decay = 0.055;
      const env = (1 - Math.exp(-dt / attack)) * Math.exp(-dt / decay);

      const phaseJitter = this.s2PhaseJitter || 0;
      const f1 = 55;
      const f2 = 90;
      const f3 = 150;

      const tone =
        0.85 * Math.sin(2 * Math.PI * f1 * dt + phaseJitter) +
        0.55 * Math.sin(2 * Math.PI * f2 * dt + 0.6 * phaseJitter) +
        0.3 * Math.sin(2 * Math.PI * f3 * dt + 1.2 * phaseJitter);

      const noiseTarget = (Math.random() * 2 - 1);
      this.s2NoiseState += (noiseTarget - this.s2NoiseState) * 0.16;
      const noise = this.s2NoiseState * 0.2;

      return env * (0.55 * tone + noise);
    }

    gaussianWindow(dt, sigma) {
      const x = dt / sigma;
      return Math.exp(-0.5 * x * x);
    }

    smoothStep(edge0, edge1, x) {
      const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
      return t * t * (3 - 2 * t);
    }

    getNoiseConfig(murmurId) {
      switch (murmurId) {
        case 'as':
          return { fast: 0.13, slow: 0.008 };
        case 'mr':
          return { fast: 0.11, slow: 0.007 };
        case 'ar':
          return { fast: 0.1, slow: 0.006 };
        case 'ms':
          return { fast: 0.07, slow: 0.012 };
        case 'hcm':
          return { fast: 0.12, slow: 0.009 };
        case 'mvp':
          return { fast: 0.1, slow: 0.008 };
        default:
          return { fast: 0.1, slow: 0.007 };
      }
    }

    getMurmurTimbre(murmurId) {
      switch (murmurId) {
        case 'ms':
          return { lowWeight: 0.62, midWeight: 0.38, shimmer1: 58, shimmer2: 84 };
        case 'mr':
          return { lowWeight: 0.22, midWeight: 0.78, shimmer1: 110, shimmer2: 150 };
        case 'ar':
          return { lowWeight: 0.18, midWeight: 0.82, shimmer1: 120, shimmer2: 170 };
        case 'as':
          return { lowWeight: 0.28, midWeight: 0.72, shimmer1: 95, shimmer2: 132 };
        case 'hcm':
          return { lowWeight: 0.24, midWeight: 0.76, shimmer1: 102, shimmer2: 144 };
        case 'mvp':
          return { lowWeight: 0.2, midWeight: 0.8, shimmer1: 115, shimmer2: 158 };
        default:
          return { lowWeight: 0.26, midWeight: 0.74, shimmer1: 96, shimmer2: 128 };
      }
    }

    murmurComponent(t, durationSec, systoleFraction, murmurId, noiseSample) {
      const phase = t / durationSec;
      const isSystole = phase <= systoleFraction;
      const phaseInSystole = isSystole ? (phase / systoleFraction) : 0;
      const phaseInDiastole = !isSystole ? ((phase - systoleFraction) / (1 - systoleFraction)) : 0;

      let amp = 0;

      switch (murmurId) {
        case 'as': {
          if (isSystole) {
            const start = 0.12;
            const end = 0.92;
            if (phaseInSystole >= start && phaseInSystole <= end) {
              const x = (phaseInSystole - start) / (end - start);
              amp = Math.sin(Math.PI * x);
            }
          }
          break;
        }
        case 'mr':
          if (isSystole) {
            const undulation = 0.9 + 0.1 * Math.sin(2 * Math.PI * phaseInSystole);
            amp = 0.95 * undulation;
          }
          break;
        case 'ar':
          if (!isSystole) {
            const start = 0.02;
            const tDiastole = Math.max(0, phaseInDiastole - start);
            const decay = Math.exp(-tDiastole * 3.2);
            const taper = 1 - this.smoothStep(AR_FADE_START, AR_FADE_END, phaseInDiastole);
            amp = 0.95 * decay * taper;
          }
          break;
        case 'ms':
          if (!isSystole) {
            const base = 0.35;
            const bumpPhase = Math.min(1, Math.max(0, (phaseInDiastole - 0.65) / 0.35));
            const bump = Math.sin(Math.PI * bumpPhase);
            amp = base + 0.35 * bump;
          }
          break;
        case 'hcm': {
          if (isSystole) {
            const start = 0.1;
            const end = 0.96;
            if (phaseInSystole >= start && phaseInSystole <= end) {
              const x = (phaseInSystole - start) / (end - start);
              amp = 0.8 * Math.pow(Math.sin(Math.PI * x), 1.2);
            }
          }
          break;
        }
        case 'mvp': {
          if (isSystole && phaseInSystole >= 0.52) {
            const x = (phaseInSystole - 0.52) / 0.48;
            amp = 0.5 + 0.45 * Math.min(1, x);
          }
          break;
        }
        default:
          amp = 0;
      }

      if (amp <= 0.001) {
        return 0;
      }

      let freqColor = 1;
      switch (murmurId) {
        case 'as':
          freqColor = 0.9;
          break;
        case 'mr':
          freqColor = 0.75;
          break;
        case 'ar':
          freqColor = 0.8;
          break;
        case 'ms':
          freqColor = 0.6;
          break;
        case 'hcm':
          freqColor = 0.84;
          break;
        case 'mvp':
          freqColor = 0.78;
          break;
        default:
          freqColor = 0.7;
      }

      const timbre = this.getMurmurTimbre(murmurId);
      const shimmer =
        0.65 * Math.sin(2 * Math.PI * timbre.shimmer1 * t) +
        0.35 * Math.sin(2 * Math.PI * timbre.shimmer2 * t + 0.3);
      const source = 0.86 * noiseSample + 0.14 * shimmer;
      return amp * MURMUR_GAIN * freqColor * source * (this.murmurBeatScale || 1);
    }
  }
  const MANEUVERS = {
    baseline: { as: 1, mr: 1, ar: 1, ms: 1, hcm: 1, mvp: 1 },
    inspiration: { as: 0.95, mr: 1.0, ar: 1.0, ms: 0.95, hcm: 1.0, mvp: 1.0 },
    valsalva: { as: 0.6, mr: 0.7, ar: 0.75, ms: 0.75, hcm: 1.4, mvp: 1.35 },
    stand: { as: 0.65, mr: 0.7, ar: 0.75, ms: 0.75, hcm: 1.3, mvp: 1.25 },
    'leg-raise': { as: 1.2, mr: 1.15, ar: 1.05, ms: 1.1, hcm: 0.75, mvp: 0.8 },
    squat: { as: 1.3, mr: 1.2, ar: 1.1, ms: 1.05, hcm: 0.7, mvp: 0.75 },
    handgrip: { as: 0.8, mr: 1.3, ar: 1.25, ms: 0.95, hcm: 0.8, mvp: 0.8 }
  };

  const MANEUVER_TEXT = {
    inspiration: 'Inspiration increases venous return to the right heart.',
    valsalva: 'Valsalva strain reduces preload and LV volume.',
    stand: 'Standing reduces preload and LV volume.',
    'leg-raise': 'Passive leg raise increases preload and LV volume.',
    squat: 'Squatting increases preload and afterload.',
    handgrip: 'Handgrip increases afterload and systemic resistance.'
  };

  const MANEUVER_MURMUR_TEACHING = {
    as: {
      inspiration: 'Aortic stenosis is usually unchanged or slightly softer with inspiration (left-sided murmur).',
      valsalva: 'Aortic stenosis softens because reduced preload lowers transvalvular flow.',
      stand: 'Aortic stenosis softens with standing due to lower preload.',
      'leg-raise': 'Aortic stenosis becomes louder with higher preload.',
      squat: 'Aortic stenosis becomes louder with squatting (more preload/flow).',
      handgrip: 'Aortic stenosis typically softens with handgrip because the forward-flow gradient falls.'
    },
    mr: {
      inspiration: 'Mitral regurgitation is usually unchanged with inspiration.',
      valsalva: 'Mitral regurgitation softens as preload falls.',
      stand: 'Mitral regurgitation softens with standing due to reduced preload.',
      'leg-raise': 'Mitral regurgitation often gets louder with increased preload.',
      squat: 'Mitral regurgitation generally gets louder with squatting.',
      handgrip: 'Mitral regurgitation gets louder with handgrip (higher afterload increases regurgitant flow).'
    },
    ar: {
      inspiration: 'Aortic regurgitation is usually unchanged with inspiration.',
      valsalva: 'Aortic regurgitation usually softens with reduced preload.',
      stand: 'Aortic regurgitation usually softens with standing.',
      'leg-raise': 'Aortic regurgitation can increase mildly with greater filling/flow.',
      squat: 'Aortic regurgitation can become louder with squatting.',
      handgrip: 'Aortic regurgitation gets louder with handgrip because afterload rises.'
    },
    ms: {
      inspiration: 'Mitral stenosis is usually unchanged or slightly softer with inspiration.',
      valsalva: 'Mitral stenosis softens with reduced preload.',
      stand: 'Mitral stenosis softens with standing due to reduced filling.',
      'leg-raise': 'Mitral stenosis often gets a bit louder with increased preload.',
      squat: 'Mitral stenosis may increase modestly with squatting.',
      handgrip: 'Mitral stenosis changes little with handgrip compared with MR/AR.'
    },
    hcm: {
      inspiration: 'HCM murmur is usually unchanged with inspiration.',
      valsalva: 'HCM murmur becomes louder as LV volume falls and dynamic LVOT obstruction worsens.',
      stand: 'HCM murmur becomes louder with standing because preload falls.',
      'leg-raise': 'HCM murmur softens with increased preload.',
      squat: 'HCM murmur softens with squatting because LV cavity size increases.',
      handgrip: 'HCM murmur usually softens with handgrip.'
    },
    mvp: {
      inspiration: 'MVP findings are usually unchanged with inspiration.',
      valsalva: 'MVP click and murmur move earlier and become louder with reduced preload.',
      stand: 'MVP click and murmur move earlier with standing and often intensify.',
      'leg-raise': 'MVP click and murmur move later and may soften with higher preload.',
      squat: 'MVP findings generally shift later and soften with squatting.',
      handgrip: 'MVP murmur often softens with handgrip.'
    }
  };

  const FLOW_DIRECTION = {
    la_lv: 1,
    ra_rv: 1,
    lv_ao: 1,
    rv_pa: 1,
    lv_la: 1,
    ao_lv: 1,
    ms_la_lv: 1
  };

  const QUIZ_POOL = Object.keys(MURMURS).filter((id) => id !== 'normal');

  const murmurRadios = document.querySelectorAll('input[name="murmur"]');
  const playToggle = document.getElementById('play-toggle');
  const soundToggle = document.getElementById('sound-toggle');
  const volumeSlider = document.getElementById('volume-slider');
  const hrSlider = document.getElementById('hr-slider');
  const hrValue = document.getElementById('hr-value');
  const valveTooltip = document.getElementById('valve-tooltip');
  const infoList = document.getElementById('info-list');
  const profileTiming = document.getElementById('profile-timing');
  const profileQuality = document.getElementById('profile-quality');
  const profilePitch = document.getElementById('profile-pitch');
  const profileLocation = document.getElementById('profile-location');
  const profileRadiation = document.getElementById('profile-radiation');
  const profileIncrease = document.getElementById('profile-increase');
  const profileDecrease = document.getElementById('profile-decrease');
  const profileMechanism = document.getElementById('profile-mechanism');
  const beatPlayhead = document.getElementById('beat-playhead');
  const compareToggle = document.getElementById('compare-toggle');
  const murmurReset = document.getElementById('murmur-reset');
  const heartDisplay = document.getElementById('heart-display');

  const phonoMiniMurmur = document.getElementById('phono-mini-murmur');
  const phonoMiniNormal = document.getElementById('phono-mini-normal');
  const phonoMiniMurmurCtx = phonoMiniMurmur.getContext('2d');
  const phonoMiniNormalCtx = phonoMiniNormal.getContext('2d');
  const heartTitleMurmur = document.getElementById('heart-title-murmur');

  const labelS1 = document.getElementById('label-s1');
  const labelS2 = document.getElementById('label-s2');

  const modeButtons = document.querySelectorAll('.mode-btn');
  const quizCard = document.getElementById('quiz-card');
  const quizOptions = document.getElementById('quiz-options');
  const quizCheck = document.getElementById('quiz-check');
  const quizNext = document.getElementById('quiz-next');
  const quizFeedback = document.getElementById('quiz-feedback');
  const maneuverExplain = document.getElementById('maneuver-explain');
  const maneuverEffect = document.getElementById('maneuver-effect');
  const maneuverPathology = document.getElementById('maneuver-pathology');

  const maneuverButtons = document.querySelectorAll('.maneuver-btn');

  const heartMain = createHeartRefs('');
  const heartNormal = createHeartRefs('-normal');
  const heartSoundEngine = new HeartSoundEngine();

  let currentMurmur = 'normal';
  let quizCurrentMurmur = null;
  let mode = 'learn';
  let activeManeuver = 'baseline';
  let isPlaying = false;
  let cycleStartTime = null;
  let userBpm = SOUND_ON_BPM;
  let currentBpm = SOUND_ON_BPM;
  let cycleMs = bpmToCycleMs(currentBpm);
  let rafId = null;
  let lastPhase = 0;
  let compareOn = true;
  let soundOn = true;
  let tooltipVisible = false;

  function createHeartRefs(suffix) {
    const flows = {
      la_lv: document.getElementById(`flow-la-lv${suffix}`),
      ra_rv: document.getElementById(`flow-ra-rv${suffix}`),
      lv_ao: document.getElementById(`flow-lv-ao${suffix}`),
      rv_pa: document.getElementById(`flow-rv-pa${suffix}`),
      lv_la: document.getElementById(`flow-lv-la${suffix}`),
      ao_lv: document.getElementById(`flow-ao-lv${suffix}`),
      ms_la_lv: document.getElementById(`flow-ms-la-lv${suffix}`)
    };

    const dots = {
      la_lv: document.getElementById(`dot-la-lv${suffix}`),
      ra_rv: document.getElementById(`dot-ra-rv${suffix}`),
      lv_ao: document.getElementById(`dot-lv-ao${suffix}`),
      rv_pa: document.getElementById(`dot-rv-pa${suffix}`),
      lv_la: document.getElementById(`dot-lv-la${suffix}`),
      ao_lv: document.getElementById(`dot-ao-lv${suffix}`),
      ms_la_lv: document.getElementById(`dot-ms-la-lv${suffix}`)
    };

    const arrows = {
      lv_la: document.getElementById(`arrow-lv-la${suffix}`),
      ao_lv: document.getElementById(`arrow-ao-lv${suffix}`),
      ms_la_lv: document.getElementById(`arrow-ms-la-lv${suffix}`)
    };

    const flowLengths = {};
    Object.entries(flows).forEach(([key, path]) => {
      if (path && typeof path.getTotalLength === 'function') {
        flowLengths[key] = path.getTotalLength();
      }
    });

    return {
      svg: document.getElementById(`heart-svg${suffix}`),
      chambers: {
        la: document.getElementById(`chamber-la${suffix}`),
        ra: document.getElementById(`chamber-ra${suffix}`),
        lv: document.getElementById(`chamber-lv${suffix}`),
        rv: document.getElementById(`chamber-rv${suffix}`)
      },
      labels: {
        la: document.getElementById(`label-la${suffix}`),
        lv: document.getElementById(`label-lv${suffix}`)
      },
      valves: {
        mitral: document.getElementById(`valve-mitral-group${suffix}`),
        tricuspid: document.getElementById(`valve-tricuspid-group${suffix}`),
        aortic: document.getElementById(`valve-aortic-group${suffix}`),
        pulmonic: document.getElementById(`valve-pulmonic-group${suffix}`)
      },
      valveRects: {
        mitral: document.getElementById(`valve-mitral${suffix}`),
        tricuspid: document.getElementById(`valve-tricuspid${suffix}`),
        aortic: document.getElementById(`valve-aortic${suffix}`),
        pulmonic: document.getElementById(`valve-pulmonic${suffix}`)
      },
      flows,
      dots,
      arrows,
      flowLengths
    };
  }

  function bpmToCycleMs(bpm) {
    return 60000 / bpm;
  }

  function updateSpeed(bpm = currentBpm) {
    currentBpm = bpm;
    cycleMs = bpmToCycleMs(currentBpm);
    heartSoundEngine.setCycleDuration(cycleMs);
  }

  function updateHrDisplay(bpm) {
    if (hrValue) {
      hrValue.textContent = `${Math.round(bpm)} bpm`;
    }
  }

  function setMurmur(type) {
    currentMurmur = type;
    updateInfo();
    updateProfile();
    updateHeartTitle();
    updateManeuverExplain();
    heartSoundEngine.setMurmur(type);
    resetToS1();
  }

  function updateInfo(murmurId = currentMurmur) {
    infoList.innerHTML = '';
    MURMURS[murmurId].info.forEach((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      infoList.appendChild(li);
    });
  }

  function updateProfile(murmurId = currentMurmur) {
    const profile = (MURMURS[murmurId] || MURMURS.normal).profile || MURMURS.normal.profile;
    if (profileTiming) {
      profileTiming.textContent = profile.timing || '';
    }
    if (profileQuality) {
      profileQuality.textContent = profile.quality || '';
    }
    if (profilePitch) {
      profilePitch.textContent = profile.pitch || '';
    }
    if (profileLocation) {
      profileLocation.textContent = profile.location || '';
    }
    if (profileRadiation) {
      profileRadiation.textContent = profile.radiation || '';
    }
    if (profileIncrease) {
      profileIncrease.textContent = profile.increase || '';
    }
    if (profileDecrease) {
      profileDecrease.textContent = profile.decrease || '';
    }
    if (profileMechanism) {
      profileMechanism.textContent = profile.mechanism || '';
    }
  }

  function clearProfileForQuiz() {
    const prompt = 'Identify the murmur to reveal this field.';
    if (profileTiming) {
      profileTiming.textContent = prompt;
    }
    if (profileQuality) {
      profileQuality.textContent = prompt;
    }
    if (profilePitch) {
      profilePitch.textContent = prompt;
    }
    if (profileLocation) {
      profileLocation.textContent = prompt;
    }
    if (profileRadiation) {
      profileRadiation.textContent = prompt;
    }
    if (profileIncrease) {
      profileIncrease.textContent = prompt;
    }
    if (profileDecrease) {
      profileDecrease.textContent = prompt;
    }
    if (profileMechanism) {
      profileMechanism.textContent = prompt;
    }
  }

  function updateHeartTitle(murmurId = currentMurmur) {
    if (!heartTitleMurmur) {
      return;
    }
    heartTitleMurmur.textContent = MURMURS[murmurId].name;
  }

  function updateManeuverExplain() {
    if (!maneuverExplain || !maneuverEffect || !maneuverPathology) {
      return;
    }
    if (currentMurmur === 'normal') {
      maneuverExplain.classList.add('is-hidden');
      return;
    }
    maneuverExplain.classList.remove('is-hidden');
    if (activeManeuver === 'baseline') {
      maneuverEffect.textContent = 'Select a maneuver to see its physiologic effect.';
      maneuverPathology.textContent = '';
      return;
    }
    maneuverEffect.textContent = MANEUVER_TEXT[activeManeuver] || '';
    maneuverPathology.textContent = (MANEUVER_MURMUR_TEACHING[currentMurmur] || {})[activeManeuver] || '';
  }

  // Maneuver logic: adjust murmur intensity by side and maneuver.
  function getManeuverMultiplier(murmurId) {
    const murmur = MURMURS[murmurId];
    if (!murmur || murmur.type === 'none') {
      return 1;
    }
    const profile = MANEUVERS[activeManeuver] || MANEUVERS.baseline;
    return profile[murmurId] || 1;
  }

  function updatePhase(elapsedMs) {
    const phase = (elapsedMs % cycleMs) / cycleMs;
    const inSystole = phase <= SYSTOLE_FRACTION;
    return { phase, inSystole };
  }

  function shapeAmplitude(shape, t) {
    if (shape === 'holo') {
      return 1;
    }
    if (shape === 'crescendo-decrescendo') {
      return Math.sin(Math.PI * t);
    }
    if (shape === 'decrescendo') {
      return 1 - t;
    }
    if (shape === 'decrescendo-crescendo') {
      if (t < 0.5) {
        return 1 - 0.7 * (t / 0.5);
      }
      return 0.3 + 0.4 * ((t - 0.5) / 0.5);
    }
    if (shape === 'late-crescendo') {
      return 0.35 + 0.65 * Math.pow(t, 0.7);
    }
    return 0;
  }

  function resetFlowBands(refs) {
    Object.values(refs.flows).forEach((band) => {
      if (!band) {
        return;
      }
      band.classList.remove(
        'flow-active',
        'flow-mid',
        'flow-low',
        'flow-animated',
        'flow-animated-fast',
        'flow-animated-slow'
      );
      band.style.opacity = '';
      band.style.strokeWidth = '';
    });
  }

  function applyIntensityToBand(band, intensity) {
    if (!band || intensity <= 0) {
      return;
    }
    if (intensity > 0.66) {
      band.classList.add('flow-active');
    } else if (intensity > 0.33) {
      band.classList.add('flow-mid');
    } else {
      band.classList.add('flow-low');
    }
    const width = 4 + 4 * intensity;
    const opacity = 0.2 + 0.7 * intensity;
    band.style.strokeWidth = width.toFixed(1);
    band.style.opacity = opacity.toFixed(2);
  }

  function activateNormalFlowBands(refs, inSystole) {
    if (inSystole) {
      refs.flows.lv_ao.classList.add('flow-animated-slow');
      refs.flows.rv_pa.classList.add('flow-animated-slow');
      applyIntensityToBand(refs.flows.lv_ao, 0.3);
      applyIntensityToBand(refs.flows.rv_pa, 0.3);
    } else {
      refs.flows.la_lv.classList.add('flow-animated-slow');
      refs.flows.ra_rv.classList.add('flow-animated-slow');
      applyIntensityToBand(refs.flows.la_lv, 0.3);
      applyIntensityToBand(refs.flows.ra_rv, 0.3);
    }
  }

  function resetFlowDots(refs) {
    Object.values(refs.dots).forEach((dot) => {
      if (!dot) {
        return;
      }
      dot.style.opacity = 0;
    });
  }

  function resetFlowArrows(refs) {
    Object.values(refs.arrows).forEach((arrow) => {
      if (!arrow) {
        return;
      }
      arrow.style.opacity = 0;
    });
  }

  function setDotAlongPath(refs, key, progress, visible) {
    const path = refs.flows[key];
    const dot = refs.dots[key];
    if (!path || !dot) {
      return;
    }
    if (!visible || progress <= 0 || progress >= 1) {
      dot.style.opacity = 0;
      return;
    }
    const total = refs.flowLengths[key] || path.getTotalLength();
    const length = total * progress;
    const point = path.getPointAtLength(length);
    dot.setAttribute('cx', point.x);
    dot.setAttribute('cy', point.y);
    dot.style.opacity = 1;
  }

  function setArrowAlongPath(refs, key, progress, visible, direction = 1) {
    const path = refs.flows[key];
    const arrow = refs.arrows[key];
    if (!path || !arrow) {
      return;
    }
    if (!visible || progress <= 0 || progress >= 1) {
      arrow.style.opacity = 0;
      return;
    }
    const total = refs.flowLengths[key] || path.getTotalLength();
    const length = total * progress;
    const delta = 4;
    const ahead = Math.min(total, Math.max(0, length + delta));
    const behind = Math.min(total, Math.max(0, length - delta));
    const p1 = path.getPointAtLength(behind);
    const p2 = path.getPointAtLength(ahead);
    let angle = Math.atan2(p2.y - p1.y, p2.x - p1.x) * (180 / Math.PI);
    if (direction < 0) {
      angle += 180;
    }
    arrow.setAttribute('transform', `translate(${p2.x} ${p2.y}) rotate(${angle})`);
    arrow.style.opacity = 1;
  }

  function moveDotWithPhase(refs, key, phaseWithin, active, speedFactor = 1) {
    if (!active) {
      setDotAlongPath(refs, key, 0, false);
      return;
    }
    let progress = Math.max(0, Math.min(1, phaseWithin * speedFactor));
    const direction = FLOW_DIRECTION[key] || 1;
    if (direction < 0) {
      progress = 1 - progress;
    }
    const pad = 0.02;
    progress = pad + (1 - 2 * pad) * progress;
    setDotAlongPath(refs, key, progress, true);
  }

  function moveArrowWithPhase(refs, key, phaseWithin, active, speedFactor = 1, offset = 0.06) {
    if (!active) {
      setArrowAlongPath(refs, key, 0, false);
      return;
    }
    let progress = Math.max(0, Math.min(1, phaseWithin * speedFactor));
    const direction = FLOW_DIRECTION[key] || 1;
    if (direction < 0) {
      progress = 1 - progress;
    }
    const pad = 0.02;
    progress = pad + (1 - 2 * pad) * progress;
    const adjusted = Math.max(0, Math.min(1, progress + offset * direction));
    setArrowAlongPath(refs, key, adjusted, true, direction);
  }

  // Flow bands: map murmur patterns to animated ribbon intensities.
  function updateFlowBands(refs, murmurId, inSystole, phaseWithin) {
    resetFlowBands(refs);
    resetFlowDots(refs);
    resetFlowArrows(refs);
    activateNormalFlowBands(refs, inSystole);

    const murmur = MURMURS[murmurId] || MURMURS.normal;
    const pattern = murmur.flowPattern ? murmur.flowPattern(phaseWithin, inSystole) : null;
    if (!pattern) {
      return;
    }

    const intensity = getManeuverMultiplier(murmurId);
    const mr = pattern.mr * intensity;
    const ar = pattern.ar * intensity;
    const ms = pattern.ms * intensity;
    const asGradient = pattern.asGradient * intensity;
    const hcmGradient = (pattern.hcmGradient || 0) * intensity;

    if (mr > 0) {
      applyIntensityToBand(refs.flows.lv_la, mr);
      refs.flows.lv_la.classList.add('flow-animated');
    }
    if (ar > 0) {
      applyIntensityToBand(refs.flows.ao_lv, ar);
      refs.flows.ao_lv.classList.add('flow-animated');
    }
    if (ms > 0) {
      applyIntensityToBand(refs.flows.ms_la_lv, ms);
      refs.flows.ms_la_lv.classList.add('flow-animated');
    }
    const outflowGradient = Math.max(asGradient, hcmGradient);
    if (outflowGradient > 0) {
      applyIntensityToBand(refs.flows.lv_ao, outflowGradient);
      refs.flows.lv_ao.classList.add('flow-animated-slow');
    }

    if (inSystole) {
      moveDotWithPhase(refs, 'lv_ao', phaseWithin, true, outflowGradient > 0 ? 0.55 : 1);
      moveDotWithPhase(refs, 'rv_pa', phaseWithin, true);
    } else {
      moveDotWithPhase(refs, 'la_lv', phaseWithin, true);
      moveDotWithPhase(refs, 'ra_rv', phaseWithin, true);
    }

    if (mr > 0) {
      moveDotWithPhase(refs, 'lv_la', phaseWithin, inSystole);
      moveArrowWithPhase(refs, 'lv_la', phaseWithin, inSystole);
    }
    if (ar > 0) {
      moveDotWithPhase(refs, 'ao_lv', phaseWithin, !inSystole);
      moveArrowWithPhase(refs, 'ao_lv', phaseWithin, !inSystole);
    }
    if (ms > 0) {
      moveDotWithPhase(refs, 'ms_la_lv', phaseWithin, !inSystole, 0.6);
      moveArrowWithPhase(refs, 'ms_la_lv', phaseWithin, !inSystole, 0.6);
    }
  }

  function updateValveClasses(refs, inSystole, murmurId, phaseWithin) {
    const valves = Object.values(refs.valves);
    valves.forEach((valve) => {
      valve.classList.remove('valve-open-normal', 'valve-closed-normal', 'valve-leaking', 'valve-stenotic');
    });

    const avValves = [refs.valves.mitral, refs.valves.tricuspid];
    const semilunarValves = [refs.valves.aortic, refs.valves.pulmonic];

    if (inSystole) {
      avValves.forEach((valve) => valve.classList.add('valve-closed-normal'));
      semilunarValves.forEach((valve) => valve.classList.add('valve-open-normal'));
    } else {
      avValves.forEach((valve) => valve.classList.add('valve-open-normal'));
      semilunarValves.forEach((valve) => valve.classList.add('valve-closed-normal'));
    }

    if (murmurId === 'mr' && inSystole) {
      refs.valves.mitral.classList.add('valve-leaking');
    }

    if (murmurId === 'ar' && !inSystole) {
      refs.valves.aortic.classList.add('valve-leaking');
    }

    if (murmurId === 'as' && inSystole) {
      refs.valves.aortic.classList.add('valve-stenotic');
    }

    if (murmurId === 'ms' && !inSystole) {
      refs.valves.mitral.classList.add('valve-stenotic');
    }

    if (murmurId === 'mvp' && inSystole && phaseWithin >= 0.55) {
      refs.valves.mitral.classList.add('valve-leaking');
    }
  }

  function updateValveTitles(refs, murmurId) {
    const titles = {
      mitral: 'Mitral valve: normal one-way flow from LA to LV.',
      tricuspid: 'Tricuspid valve: normal one-way flow from RA to RV.',
      aortic: 'Aortic valve (to aorta): normal systolic outflow from LV.',
      pulmonic: 'Pulmonic valve (to pulmonary artery): normal systolic outflow from RV.'
    };

    switch (murmurId) {
      case 'mr':
        titles.mitral = 'Mitral valve: regurgitation — the valve is incompetent, so it does not seal during systole and blood leaks from LV back into LA.';
        break;
      case 'ms':
        titles.mitral = 'Mitral valve: stenosis — thickened, narrowed leaflets restrict diastolic filling from LA to LV and raise left atrial pressure.';
        break;
      case 'ar':
        titles.aortic = 'Aortic valve (to aorta): regurgitation — it fails to close in diastole, so blood falls back from the aorta into the LV.';
        break;
      case 'as':
        titles.aortic = 'Aortic valve (to aorta): stenosis — a narrowed, stiff valve obstructs systolic ejection from LV into the aorta.';
        break;
      case 'hcm':
        titles.aortic = 'LV outflow tract: dynamic obstruction from septal hypertrophy causes a systolic ejection murmur that varies with preload.';
        break;
      case 'mvp':
        titles.mitral = 'Mitral valve: leaflet prolapse with late systolic regurgitation. A midsystolic click may precede the murmur.';
        break;
      default:
        break;
    }

    const applyTitle = (node, text) => {
      if (!node) {
        return;
      }
      const titleNode = node.querySelector('title');
      if (titleNode) {
        titleNode.remove();
      }
      node.setAttribute('data-tooltip', text);
    };

    Object.entries(refs.valves).forEach(([key, valve]) => {
      const text = titles[key] || '';
      applyTitle(valve, text);

      const rect = refs.valveRects[key];
      applyTitle(rect, text);

      if (valve) {
        valve.querySelectorAll('.valve-leaf').forEach((leaf) => {
          applyTitle(leaf, text);
        });
      }
    });
  }

  function positionValveTooltip(x, y) {
    if (!valveTooltip) {
      return;
    }
    const offset = 12;
    const rect = valveTooltip.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    const nextX = Math.max(8, Math.min(maxX, x + offset));
    const nextY = Math.max(8, Math.min(maxY, y + offset));
    valveTooltip.style.left = `${nextX}px`;
    valveTooltip.style.top = `${nextY}px`;
  }

  function showValveTooltip(text, event) {
    if (!valveTooltip || !text) {
      return;
    }
    valveTooltip.textContent = text;
    valveTooltip.setAttribute('aria-hidden', 'false');
    valveTooltip.classList.add('is-visible');
    tooltipVisible = true;
    positionValveTooltip(event.clientX, event.clientY);
  }

  function hideValveTooltip() {
    if (!valveTooltip) {
      return;
    }
    valveTooltip.setAttribute('aria-hidden', 'true');
    valveTooltip.classList.remove('is-visible');
    tooltipVisible = false;
  }

  function bindValveTooltips(refs) {
    if (!refs.svg) {
      return;
    }
    const padding = 16;
    const targets = [];

    Object.values(refs.valves).forEach((valve) => {
      if (!valve) {
        return;
      }
      targets.push(valve);
    });
    Object.values(refs.valveRects).forEach((rect) => {
      if (rect) {
        targets.push(rect);
      }
    });

    refs.svg.addEventListener('pointermove', (event) => {
      let hitText = '';
      for (let i = 0; i < targets.length; i += 1) {
        const node = targets[i];
        const text = node.getAttribute('data-tooltip');
        if (!text) {
          continue;
        }
        const rect = node.getBoundingClientRect();
        const left = rect.left - padding;
        const right = rect.right + padding;
        const top = rect.top - padding;
        const bottom = rect.bottom + padding;
        if (event.clientX >= left && event.clientX <= right && event.clientY >= top && event.clientY <= bottom) {
          hitText = text;
          break;
        }
      }
      if (hitText) {
        showValveTooltip(hitText, event);
      } else if (tooltipVisible) {
        hideValveTooltip();
      }
    });

    refs.svg.addEventListener('pointerleave', hideValveTooltip);
  }

  function updateHeartLabels(refs, murmurId) {
    if (!refs.labels.la || !refs.labels.lv) {
      return;
    }
    if (murmurId === 'mr') {
      refs.labels.la.setAttribute('title', 'Regurgitant flow across mitral valve');
      refs.labels.lv.setAttribute('title', 'Regurgitant flow across mitral valve');
    } else if (murmurId === 'ms') {
      refs.labels.la.setAttribute('title', 'Stenotic flow across mitral valve');
      refs.labels.lv.setAttribute('title', 'Stenotic flow across mitral valve');
    } else {
      refs.labels.la.removeAttribute('title');
      refs.labels.lv.removeAttribute('title');
    }
  }

  function updateHeartVisuals(phase, murmurId, refs) {
    const inSystole = phase <= SYSTOLE_FRACTION;
    const systolePhase = Math.min(phase / SYSTOLE_FRACTION, 1);
    const diastolePhase = inSystole ? 0 : (phase - SYSTOLE_FRACTION) / (1 - SYSTOLE_FRACTION);
    const phaseWithin = inSystole ? systolePhase : diastolePhase;

    refs.svg.classList.toggle('phase-systole', inSystole);
    refs.svg.classList.toggle('phase-diastole', !inSystole);

    const ventricleScale = inSystole ? 0.96 + 0.02 * (1 - systolePhase) : 1;
    refs.chambers.lv.style.transform = `scale(${ventricleScale})`;
    refs.chambers.rv.style.transform = `scale(${ventricleScale})`;

    const atriaScale = inSystole ? 1 : 1.02 + 0.02 * diastolePhase;
    refs.chambers.la.style.transform = `scale(${atriaScale})`;
    refs.chambers.ra.style.transform = `scale(${atriaScale})`;

    updateValveClasses(refs, inSystole, murmurId, phaseWithin);
    updateValveTitles(refs, murmurId);
    updateHeartLabels(refs, murmurId);

    updateFlowBands(refs, murmurId, inSystole, phaseWithin);

    if (murmurId === 'ms' && !inSystole) {
      refs.valveRects.mitral.setAttribute('width', '28');
      refs.valveRects.mitral.setAttribute('height', '20');
      refs.valveRects.mitral.setAttribute('x', '351');
      refs.valveRects.mitral.setAttribute('y', '208');
    } else {
      refs.valveRects.mitral.setAttribute('width', '20');
      refs.valveRects.mitral.setAttribute('height', '16');
      refs.valveRects.mitral.setAttribute('x', '355');
      refs.valveRects.mitral.setAttribute('y', '210');
    }

    if (murmurId === 'as' && inSystole) {
      refs.valveRects.aortic.setAttribute('width', '24');
      refs.valveRects.aortic.setAttribute('height', '20');
      refs.valveRects.aortic.setAttribute('x', '353');
      refs.valveRects.aortic.setAttribute('y', '334');
    } else {
      refs.valveRects.aortic.setAttribute('width', '20');
      refs.valveRects.aortic.setAttribute('height', '16');
      refs.valveRects.aortic.setAttribute('x', '355');
      refs.valveRects.aortic.setAttribute('y', '336');
    }
  }

  function renderPhonocardiogram(ctx, canvas, phase, murmurId, intensity, showCursor) {
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = '#f8f7f4';
    ctx.fillRect(0, 0, width, height);

    const left = 20;
    const right = width - 20;
    const timeline = buildTimeline(cycleMs);
    const s1X = left + (right - left) * timeline.s1Phase;
    const s2X = left + (right - left) * timeline.s2Phase;
    const baseline = height * 0.65;

    ctx.strokeStyle = '#c7b9a6';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s1X, baseline - 24);
    ctx.lineTo(s1X, baseline + 24);
    ctx.moveTo(s2X, baseline - 24);
    ctx.lineTo(s2X, baseline + 24);
    ctx.stroke();

    if (murmurId === 'ms') {
      const osDelaySec = Math.min(0.08, 0.14 * timeline.durationSec);
      const osPhase = Math.min(1, (timeline.s2Sec + osDelaySec) / timeline.durationSec);
      const osX = left + (right - left) * osPhase;
      ctx.strokeStyle = '#a66f2f';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(osX, baseline - 18);
      ctx.lineTo(osX, baseline + 6);
      ctx.stroke();
    }

    if (murmurId === 'mvp') {
      const clickPhase = timeline.s1Phase + 0.58 * (timeline.s2Phase - timeline.s1Phase);
      const clickX = left + (right - left) * clickPhase;
      ctx.strokeStyle = '#a66f2f';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(clickX, baseline - 18);
      ctx.lineTo(clickX, baseline + 6);
      ctx.stroke();
    }

    ctx.fillStyle = '#e7d7c6';
    ctx.fillRect(left, baseline + 18, right - left, 2);

    const murmur = MURMURS[murmurId];
    if (murmur && murmur.shape !== 'none') {
      const bandStart = left + (right - left) * murmur.timing.start;
      const bandEnd = left + (right - left) * murmur.timing.end;
      const arExtend = 0.16;
      const effectiveEnd = murmurId === 'ar'
        ? left + (right - left) * Math.min(1, murmur.timing.end + arExtend)
        : bandEnd;
      const steps = 40;
      const maxHeight = 30 * intensity;

      if (murmurId === 'ar') {
        ctx.strokeStyle = 'rgba(226, 87, 76, 0.45)';
        ctx.lineWidth = 1;
        const lineStep = 3;
        for (let x = bandStart; x <= effectiveEnd; x += lineStep) {
          const t = (x - bandStart) / (effectiveEnd - bandStart || 1);
          const amp = 1 - t;
          const y = baseline - amp * maxHeight;
          ctx.beginPath();
          ctx.moveTo(x, baseline + 10);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = 'rgba(226, 87, 76, 0.35)';
        ctx.beginPath();
        for (let i = 0; i <= steps; i += 1) {
          const t = i / steps;
          const x = bandStart + (effectiveEnd - bandStart) * t;
          const amp = shapeAmplitude(murmur.shape, t);
          const y = baseline - amp * maxHeight;
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        for (let i = steps; i >= 0; i -= 1) {
          const t = i / steps;
          const x = bandStart + (effectiveEnd - bandStart) * t;
          ctx.lineTo(x, baseline + 10);
        }
        ctx.closePath();
        ctx.fill();
      }
    }

    if (showCursor) {
      const cursorX = left + phase * (right - left);
      ctx.strokeStyle = '#6b5d50';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cursorX, 10);
      ctx.lineTo(cursorX, height - 10);
      ctx.stroke();
    }
  }

  function flashElements(elements) {
    elements.forEach((element) => {
      if (!element) {
        return;
      }
      element.classList.remove('flash');
      void element.offsetWidth;
      element.classList.add('flash');
    });
  }

  function handleS1() {
    flashElements([labelS1, heartMain.valves.mitral, heartMain.valves.tricuspid]);
    if (compareOn) {
      flashElements([heartNormal.valves.mitral, heartNormal.valves.tricuspid]);
    }
  }

  function handleS2() {
    flashElements([labelS2, heartMain.valves.aortic, heartMain.valves.pulmonic]);
    if (compareOn) {
      flashElements([heartNormal.valves.aortic, heartNormal.valves.pulmonic]);
    }
  }

  function updateProgress(phase) {
    beatPlayhead.style.left = `${phase * 100}%`;
  }

  function updateFrame(phase) {
    updateHeartVisuals(phase, currentMurmur, heartMain);
    updateHeartVisuals(phase, 'normal', heartNormal);

    const intensity = getManeuverMultiplier(currentMurmur);
    renderPhonocardiogram(phonoMiniMurmurCtx, phonoMiniMurmur, phase, currentMurmur, intensity, true);
    renderPhonocardiogram(phonoMiniNormalCtx, phonoMiniNormal, phase, 'normal', 1, true);

    updateProgress(phase);
  }

  function resetToS1() {
    cycleStartTime = null;
    lastPhase = 0;
    updateFrame(0);
    if (isPlaying) {
      heartSoundEngine.playFromStart();
    }
  }

  function tick(timestamp) {
    if (!cycleStartTime) {
      cycleStartTime = timestamp;
    }

    let phase = null;
    if (soundOn && heartSoundEngine.supported && heartSoundEngine.enabled && heartSoundEngine.isPlaying) {
      phase = heartSoundEngine.getPhase(cycleMs);
    }
    if (phase === null) {
      const elapsed = timestamp - cycleStartTime;
      phase = updatePhase(elapsed).phase;
    }
    const timeline = buildTimeline(cycleMs);
    const s1Phase = timeline.s1Phase;
    const s2Phase = timeline.s2Phase;

    if (phase < lastPhase) {
      if (phase >= s1Phase) {
        handleS1();
      }
    } else {
      if (lastPhase < s1Phase && phase >= s1Phase) {
        handleS1();
      }
    }

    if (lastPhase <= phase && lastPhase < s2Phase && phase >= s2Phase) {
      handleS2();
    }

    updateFrame(phase);
    lastPhase = phase;

    if (isPlaying) {
      rafId = requestAnimationFrame(tick);
    }
  }

  function play() {
    if (isPlaying) {
      return;
    }
    isPlaying = true;
    playToggle.textContent = 'Pause';
    cycleStartTime = null;
    heartSoundEngine.play();
    rafId = requestAnimationFrame(tick);
  }

  function pause() {
    isPlaying = false;
    playToggle.textContent = 'Play';
    cycleStartTime = null;
    heartSoundEngine.stop();

    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    lastPhase = 0;
    updateFrame(0);
  }

  function setMode(nextMode) {
    mode = nextMode;
    modeButtons.forEach((button) => {
      button.classList.toggle('is-active', button.dataset.mode === mode);
    });

    const isQuiz = mode === 'quiz';
    quizCard.classList.toggle('is-hidden', !isQuiz);

    murmurRadios.forEach((radio) => {
      radio.disabled = isQuiz;
    });

    if (isQuiz) {
      startQuiz();
    } else {
      quizCurrentMurmur = null;
      quizFeedback.textContent = '';
      quizNext.classList.add('is-hidden');
      setMurmur(document.querySelector('input[name="murmur"]:checked').value);
    }
  }

  // Quiz mode logic: hide murmur selection and randomize the active murmur.
  function startQuiz() {
    const next = pickRandomMurmur();
    quizCurrentMurmur = next;
    currentMurmur = next;
    quizFeedback.textContent = '';
    quizNext.classList.add('is-hidden');
    buildQuizOptions();
    infoList.innerHTML = '';
    clearProfileForQuiz();
    updateHeartTitle(quizCurrentMurmur);
    updateManeuverExplain();
    heartSoundEngine.setMurmur(quizCurrentMurmur);
    resetToS1();
  }

  function pickRandomMurmur() {
    const pool = QUIZ_POOL.filter((id) => id !== quizCurrentMurmur);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function buildQuizOptions() {
    quizOptions.innerHTML = '';
    QUIZ_POOL.forEach((id) => {
      const label = document.createElement('label');
      label.className = 'quiz-option';
      label.innerHTML = `
        <input type="radio" name="quiz" value="${id}">
        <span>${MURMURS[id].name}</span>
      `;
      quizOptions.appendChild(label);
    });
  }

  function checkQuizAnswer() {
    const selected = quizOptions.querySelector('input[name="quiz"]:checked');
    if (!selected) {
      quizFeedback.textContent = 'Select an answer first.';
      return;
    }

    const answer = selected.value;
    if (answer === quizCurrentMurmur) {
      quizFeedback.textContent = `Correct. ${MURMURS[quizCurrentMurmur].info[0]}`;
    } else {
      quizFeedback.textContent = `Not quite. This is ${MURMURS[quizCurrentMurmur].name}. ${MURMURS[quizCurrentMurmur].info[0]}`;
    }

    updateInfo(quizCurrentMurmur);
    updateProfile(quizCurrentMurmur);

    quizNext.classList.remove('is-hidden');
  }

  function toggleManeuver(next) {
    if (activeManeuver === next) {
      activeManeuver = 'baseline';
    } else {
      activeManeuver = next;
    }

    maneuverButtons.forEach((button) => {
      button.classList.toggle('is-active', button.dataset.maneuver === activeManeuver);
    });

    updateManeuverExplain();
    updateFrame(isPlaying ? lastPhase : 0);
  }

  function toggleCompare() {
    compareOn = !compareOn;
    heartDisplay.classList.toggle('compare-on', compareOn);
    document.querySelector('.heart-view-normal').classList.toggle('is-hidden', !compareOn);
    compareToggle.textContent = compareOn ? 'Single view' : 'Compare to Normal';
    updateFrame(isPlaying ? lastPhase : 0);
  }

  function applyCompareState() {
    compareOn = DEFAULT_COMPARE_ON;
    heartDisplay.classList.toggle('compare-on', compareOn);
    document.querySelector('.heart-view-normal').classList.toggle('is-hidden', !compareOn);
    compareToggle.textContent = compareOn ? 'Single view' : 'Compare to Normal';
  }

  function resetManeuvers() {
    activeManeuver = 'baseline';
    maneuverButtons.forEach((button) => {
      button.classList.toggle('is-active', false);
    });
  }

  function resetQuizState() {
    quizCurrentMurmur = null;
    quizFeedback.textContent = '';
    quizNext.classList.add('is-hidden');
    quizOptions.querySelectorAll('input[name="quiz"]').forEach((input) => {
      input.checked = false;
    });
  }

  function hardReset(nextMurmurId, skipModeReset = false) {
    if (!skipModeReset) {
      setMode('learn');
    } else {
      resetQuizState();
      quizCard.classList.toggle('is-hidden', mode !== 'quiz');
    }

    pause();
    hideValveTooltip();
    resetManeuvers();

    userBpm = SOUND_ON_BPM;
    if (volumeSlider) {
      volumeSlider.value = DEFAULT_VOLUME;
      heartSoundEngine.setVolume(DEFAULT_VOLUME);
    }
    if (!heartSoundEngine.supported) {
      setSoundToggleState(false);
      heartSoundEngine.setEnabled(false);
    } else {
      setSoundToggleState(true);
      heartSoundEngine.setEnabled(true);
    }

    if (hrSlider) {
      hrSlider.value = userBpm;
      updateHrDisplay(hrSlider.value);
    }

    if (nextMurmurId) {
      const nextRadio = document.querySelector(`input[name="murmur"][value="${nextMurmurId}"]`);
      if (nextRadio) {
        nextRadio.checked = true;
      }
    }

    applyCompareState();

    if (nextMurmurId) {
      setMurmur(nextMurmurId);
    } else {
      setMurmur(currentMurmur);
    }
  }

  function setSoundToggleState(isOn) {
    soundOn = isOn;
    if (soundOn) {
      updateSpeed(userBpm || SOUND_ON_BPM);
    } else {
      updateSpeed(SOUND_OFF_BPM);
    }
    if (hrSlider) {
      hrSlider.disabled = !soundOn;
      hrSlider.value = soundOn ? userBpm : SOUND_OFF_BPM;
      updateHrDisplay(hrSlider.value);
    }
    resetToS1();
    if (!soundToggle) {
      return;
    }
    soundToggle.setAttribute('aria-pressed', soundOn ? 'false' : 'true');
    soundToggle.textContent = soundOn ? 'Sound: On' : 'Sound: Off';
  }

  murmurRadios.forEach((radio) => {
    radio.addEventListener('change', (event) => {
      if (mode !== 'learn') {
        return;
      }
      hardReset(event.target.value, true);
    });
  });

  playToggle.addEventListener('click', () => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  });

  if (soundToggle) {
    if (!heartSoundEngine.supported) {
      setSoundToggleState(false);
      soundToggle.disabled = true;
      soundToggle.setAttribute('aria-pressed', 'true');
      soundToggle.textContent = 'Sound: Unavailable';
      heartSoundEngine.setEnabled(false);
    } else {
      setSoundToggleState(true);
      soundToggle.addEventListener('click', () => {
        setSoundToggleState(!soundOn);
        heartSoundEngine.setEnabled(soundOn);
      });
    }
  }

  if (volumeSlider) {
    heartSoundEngine.setVolume(parseFloat(volumeSlider.value));
    if (!heartSoundEngine.supported) {
      volumeSlider.disabled = true;
    }
    volumeSlider.addEventListener('input', (event) => {
      const value = parseFloat(event.target.value);
      heartSoundEngine.setVolume(value);
    });
  }

  if (hrSlider) {
    hrSlider.value = userBpm;
    updateHrDisplay(hrSlider.value);
    hrSlider.addEventListener('input', (event) => {
      const value = parseInt(event.target.value, 10);
      userBpm = value;
      if (soundOn) {
        updateSpeed(userBpm);
        resetToS1();
      }
      updateHrDisplay(value);
    });
  }

  modeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setMode(button.dataset.mode);
    });
  });

  quizCheck.addEventListener('click', checkQuizAnswer);
  quizNext.addEventListener('click', startQuiz);

  maneuverButtons.forEach((button) => {
    button.addEventListener('click', () => {
      toggleManeuver(button.dataset.maneuver);
    });
  });

  compareToggle.addEventListener('click', toggleCompare);
  if (murmurReset) {
    murmurReset.addEventListener('click', () => {
      hardReset(document.querySelector('input[name="murmur"]:checked').value);
    });
  }

  applyCompareState();
  bindValveTooltips(heartMain);
  bindValveTooltips(heartNormal);
  updateSpeed(currentBpm);
  setMurmur(currentMurmur);
  updateProfile(currentMurmur);
  updateFrame(0);
});

// WebAudio Procedural Synthesizer Engine for Parsewaver
// Enhanced version with richer synthwave pads, layered engine, and better sequencing

export class AudioSynthManager {
  constructor() {
    this.ctx = null;
    
    // Master Gains
    this.musicGain = null;
    this.sfxGain = null;
    this.masterCompressor = null;

    // Audio Nodes
    this.engineOsc1 = null;
    this.engineOsc2 = null;
    this.engineFilter = null;
    this.engineGain = null;

    this.windNoise = null;
    this.windGain = null;

    this.roadNoise = null;
    this.roadFilter = null;
    this.roadGain = null;

    this.screechNoise = null;
    this.screechFilter = null;
    this.screechGain = null;

    // Music sequencer state
    this.musicIntervalId = null;
    this.musicTempoBPM = 108;
    this.musicStep = 0;
    this.musicActive = false;

    // Pad state
    this.padOscs = [];
    this.padGain = null;
    this.padFilter = null;
    this.currentChordIndex = -1;

    this.isMusicMuted = false;
    this.isSFXMuted = false;
  }

  init() {
    if (this.ctx) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContextClass();

    // Master compressor to prevent clipping
    this.masterCompressor = this.ctx.createDynamicsCompressor();
    this.masterCompressor.threshold.setValueAtTime(-18, this.ctx.currentTime);
    this.masterCompressor.knee.setValueAtTime(12, this.ctx.currentTime);
    this.masterCompressor.ratio.setValueAtTime(4, this.ctx.currentTime);
    this.masterCompressor.connect(this.ctx.destination);

    // Master Music Channel
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.18;
    this.musicGain.connect(this.masterCompressor);

    // Master SFX Channel
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.5;
    this.sfxGain.connect(this.masterCompressor);

    // Start Synthesizing
    this.setupEngineSynth();
    this.setupWindSynth();
    this.setupRoadSynth();
    this.setupPadSynth();
    this.startMusicSequencer();
  }

  // -------------------------------------------------------------
  // 1. Engine Sound (Dual Oscillator + Lowpass Filter)
  // -------------------------------------------------------------
  setupEngineSynth() {
    // Primary sawtooth for fundamental
    this.engineOsc1 = this.ctx.createOscillator();
    this.engineOsc1.type = 'sawtooth';
    this.engineOsc1.frequency.value = 42;

    // Secondary square for harmonic richness, detuned slightly
    this.engineOsc2 = this.ctx.createOscillator();
    this.engineOsc2.type = 'square';
    this.engineOsc2.frequency.value = 42;
    this.engineOsc2.detune.value = -8;

    // Mix the two oscillators
    const oscMix = this.ctx.createGain();
    oscMix.gain.value = 0.5;

    this.engineFilter = this.ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 150;
    this.engineFilter.Q.value = 2.5;

    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0.2;

    this.engineOsc1.connect(this.engineFilter);
    this.engineOsc2.connect(oscMix);
    oscMix.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.sfxGain);

    this.engineOsc1.start(0);
    this.engineOsc2.start(0);
  }

  updateEngineSound(speed, isCrashed) {
    if (!this.ctx || isCrashed) {
      if (this.engineGain) this.engineGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
      return;
    }

    const absSpeed = Math.abs(speed);
    const pitch = 42.0 + (absSpeed * 2.0);
    const filterCutoff = pitch * 2.5 + 80.0;

    if (this.engineOsc1 && this.engineOsc2 && this.engineFilter && this.engineGain) {
      this.engineOsc1.frequency.setTargetAtTime(pitch, this.ctx.currentTime, 0.06);
      this.engineOsc2.frequency.setTargetAtTime(pitch * 0.998, this.ctx.currentTime, 0.06);
      this.engineFilter.frequency.setTargetAtTime(filterCutoff, this.ctx.currentTime, 0.06);
      
      const vol = 0.12 + (absSpeed / 70.0) * 0.2;
      this.engineGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.04);
    }
  }

  // -------------------------------------------------------------
  // 2. Wind Sound (Lowpass-filtered White Noise)
  // -------------------------------------------------------------
  setupWindSynth() {
    const bufferSize = this.ctx.sampleRate * 2.0;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2.0 - 1.0;
    }

    this.windNoise = this.ctx.createBufferSource();
    this.windNoise.buffer = noiseBuffer;
    this.windNoise.loop = true;

    const windFilter = this.ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 200.0;

    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0.03;

    this.windNoise.connect(windFilter);
    windFilter.connect(this.windGain);
    this.windGain.connect(this.sfxGain);

    this.windNoise.start(0);
  }

  updateWindSound(speed) {
    if (!this.ctx || !this.windGain) return;
    const normSpeed = Math.abs(speed) / 70.0;
    const vol = normSpeed * normSpeed * 0.12;
    this.windGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.1);
  }

  // -------------------------------------------------------------
  // 2b. Road Texture (Low rumble + tire bed)
  // -------------------------------------------------------------
  setupRoadSynth() {
    const bufferSize = this.ctx.sampleRate * 2.0;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2.0 - 1.0;
      last = last * 0.82 + white * 0.18;
      output[i] = last;
    }

    this.roadNoise = this.ctx.createBufferSource();
    this.roadNoise.buffer = noiseBuffer;
    this.roadNoise.loop = true;

    this.roadFilter = this.ctx.createBiquadFilter();
    this.roadFilter.type = 'bandpass';
    this.roadFilter.frequency.value = 95.0;
    this.roadFilter.Q.value = 0.9;

    this.roadGain = this.ctx.createGain();
    this.roadGain.gain.value = 0.0;

    this.roadNoise.connect(this.roadFilter);
    this.roadFilter.connect(this.roadGain);
    this.roadGain.connect(this.sfxGain);

    this.roadNoise.start(0);
  }

  updateRoadSound(speed) {
    if (!this.ctx || !this.roadGain || !this.roadFilter) return;
    const normSpeed = Math.min(1.0, Math.abs(speed) / 70.0);
    this.roadGain.gain.setTargetAtTime(0.025 + normSpeed * 0.13, this.ctx.currentTime, 0.08);
    this.roadFilter.frequency.setTargetAtTime(70 + normSpeed * 170, this.ctx.currentTime, 0.08);
    this.roadFilter.Q.setTargetAtTime(0.8 + normSpeed * 1.2, this.ctx.currentTime, 0.08);
  }

  // -------------------------------------------------------------
  // 3. Tire Screech (Bandpass-filtered White Noise)
  // -------------------------------------------------------------
  setupScreechSynth() {
    const bufferSize = this.ctx.sampleRate * 2.0;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2.0 - 1.0;
    }

    this.screechNoise = this.ctx.createBufferSource();
    this.screechNoise.buffer = noiseBuffer;
    this.screechNoise.loop = true;

    this.screechFilter = this.ctx.createBiquadFilter();
    this.screechFilter.type = 'bandpass';
    this.screechFilter.frequency.value = 1100.0;
    this.screechFilter.Q.value = 2.5;

    this.screechGain = this.ctx.createGain();
    this.screechGain.gain.value = 0.0;

    this.screechNoise.connect(this.screechFilter);
    this.screechFilter.connect(this.screechGain);
    this.screechGain.connect(this.sfxGain);

    this.screechNoise.start(0);
  }

  updateScreechSound(traction, speed) {
    if (!this.ctx || !this.screechGain) return;

    const absSpeed = Math.abs(speed);
    const tractionLoss = 1.0 - traction;

    if (tractionLoss > 0.1 && absSpeed > 10.0) {
      const vol = tractionLoss * 0.15;
      this.screechGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.04);
      const pitch = 850.0 + (absSpeed * 4.0);
      this.screechFilter.frequency.setTargetAtTime(pitch, this.ctx.currentTime, 0.04);
    } else {
      this.screechGain.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.06);
    }
  }

  // -------------------------------------------------------------
  // 4. SFX: Crash Crunch
  // -------------------------------------------------------------
  playCrashSFX() {
    if (!this.ctx) return;

    const now = this.ctx.currentTime;

    // Low thud
    const thud = this.ctx.createOscillator();
    thud.type = 'sawtooth';
    thud.frequency.setValueAtTime(90.0, now);
    thud.frequency.exponentialRampToValueAtTime(25.0, now + 0.45);

    const thudFilter = this.ctx.createBiquadFilter();
    thudFilter.type = 'lowpass';
    thudFilter.frequency.setValueAtTime(200.0, now);
    thudFilter.frequency.exponentialRampToValueAtTime(15.0, now + 0.5);

    const thudGain = this.ctx.createGain();
    thudGain.gain.setValueAtTime(0.65, now);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

    thud.connect(thudFilter);
    thudFilter.connect(thudGain);
    thudGain.connect(this.sfxGain);
    thud.start(now);
    thud.stop(now + 0.6);

    // Crunch noise burst
    const bufLen = this.ctx.sampleRate * 0.3;
    const noiseBuf = this.ctx.createBuffer(1, bufLen, this.ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufLen * 0.15));
    }
    const noiseSource = this.ctx.createBufferSource();
    noiseSource.buffer = noiseBuf;

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.35, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    const noiseBpf = this.ctx.createBiquadFilter();
    noiseBpf.type = 'bandpass';
    noiseBpf.frequency.value = 600;
    noiseBpf.Q.value = 1.0;

    noiseSource.connect(noiseBpf);
    noiseBpf.connect(noiseGain);
    noiseGain.connect(this.sfxGain);
    noiseSource.start(now);
  }

  // -------------------------------------------------------------
  // 5. SFX: Near-Miss Chime (Ascending Pentatonic Arpeggio)
  // -------------------------------------------------------------
  playNearMissChime() {
    if (!this.ctx) return;

    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
    const now = this.ctx.currentTime;

    notes.forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.07);

      // Slight detune for shimmer
      const osc2 = this.ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(freq * 1.003, now + idx * 0.07);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0, now + idx * 0.07);
      gain.gain.linearRampToValueAtTime(0.1, now + idx * 0.07 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.3);

      const gain2 = this.ctx.createGain();
      gain2.gain.value = 0.06;

      osc.connect(gain);
      osc2.connect(gain2);
      gain2.connect(gain);
      gain.connect(this.sfxGain);

      osc.start(now + idx * 0.07);
      osc.stop(now + idx * 0.07 + 0.35);
      osc2.start(now + idx * 0.07);
      osc2.stop(now + idx * 0.07 + 0.35);
    });
  }

  // -------------------------------------------------------------
  // 6. Music: Sustained Pad Synth (Layered Chord Pads)
  // -------------------------------------------------------------
  setupPadSynth() {
    this.padFilter = this.ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 800;
    this.padFilter.Q.value = 0.7;

    this.padGain = this.ctx.createGain();
    this.padGain.gain.value = 0.0;

    this.padFilter.connect(this.padGain);
    this.padGain.connect(this.musicGain);
  }

  playChordPad(chordIndex) {
    if (!this.ctx || chordIndex === this.currentChordIndex) return;
    this.currentChordIndex = chordIndex;

    // Fade out existing pad oscillators
    this.padOscs.forEach(osc => {
      try { osc.stop(this.ctx.currentTime + 0.5); } catch(e) {}
    });
    this.padOscs = [];

    // Chord voicings: Am7 - Fmaj7 - Cmaj7 - G7
    const chords = [
      [220.0, 261.63, 329.63, 415.30],  // Am7: A3, C4, E4, G#4
      [174.61, 220.0, 261.63, 329.63],   // Fmaj7: F3, A3, C4, E4
      [130.81, 164.81, 196.0, 246.94],   // Cmaj7: C3, E3, G3, B3
      [196.0, 246.94, 293.66, 349.23],   // G7: G3, B3, D4, F4
    ];

    const now = this.ctx.currentTime;
    const notes = chords[chordIndex % chords.length];

    notes.forEach((freq) => {
      // Saw oscillator for richness
      const osc1 = this.ctx.createOscillator();
      osc1.type = 'sawtooth';
      osc1.frequency.value = freq;

      // Slightly detuned sine for warmth
      const osc2 = this.ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.value = freq * 1.005;

      const oscGain = this.ctx.createGain();
      oscGain.gain.setValueAtTime(0.0, now);
      oscGain.gain.linearRampToValueAtTime(0.04, now + 0.8);

      osc1.connect(oscGain);
      osc2.connect(oscGain);
      oscGain.connect(this.padFilter);

      osc1.start(now);
      osc2.start(now);

      this.padOscs.push(osc1, osc2);
    });

    // Swell pad volume
    this.padGain.gain.setTargetAtTime(1.0, now, 0.4);
  }

  // -------------------------------------------------------------
  // 7. Music Sequencer (Bass + Melody + Pad changes)
  // -------------------------------------------------------------
  startMusicSequencer() {
    this.musicActive = true;

    // Bass frequencies: A1, F1, C2, G1
    const bassProgressions = [55.0, 43.65, 65.41, 49.0];

    // Pentatonic melody in Am (with rests as 0)
    const melodyPattern = [
      440.0, 0, 523.25, 0, 587.33, 0, 659.25, 0,
      783.99, 0, 659.25, 0, 523.25, 587.33, 440.0, 0,
      523.25, 659.25, 0, 783.99, 880.0, 0, 783.99, 659.25,
      587.33, 0, 523.25, 0, 440.0, 0, 0, 0,
    ];

    const stepDuration = 60.0 / this.musicTempoBPM / 2.0;

    const playSequenceStep = () => {
      if (!this.musicActive || !this.ctx) return;

      const now = this.ctx.currentTime;
      const chordIndex = Math.floor(this.musicStep / 8) % bassProgressions.length;

      // Change pad chord
      this.playChordPad(chordIndex);

      // Bass note (every 4 steps)
      if (this.musicStep % 4 === 0) {
        const bassFreq = bassProgressions[chordIndex];

        const bassOsc = this.ctx.createOscillator();
        bassOsc.type = 'sawtooth';
        bassOsc.frequency.setValueAtTime(bassFreq, now);

        const subOsc = this.ctx.createOscillator();
        subOsc.type = 'sine';
        subOsc.frequency.setValueAtTime(bassFreq * 0.5, now);

        const bassFilter = this.ctx.createBiquadFilter();
        bassFilter.type = 'lowpass';
        bassFilter.frequency.setValueAtTime(160.0, now);

        const bassGain = this.ctx.createGain();
        bassGain.gain.setValueAtTime(0.2, now);
        bassGain.gain.exponentialRampToValueAtTime(0.001, now + stepDuration * 3.5);

        const subGain = this.ctx.createGain();
        subGain.gain.setValueAtTime(0.12, now);
        subGain.gain.exponentialRampToValueAtTime(0.001, now + stepDuration * 3.5);

        bassOsc.connect(bassFilter);
        subOsc.connect(subGain);
        subGain.connect(bassFilter);
        bassFilter.connect(bassGain);
        bassGain.connect(this.musicGain);

        bassOsc.start(now);
        subOsc.start(now);
        bassOsc.stop(now + stepDuration * 4.0);
        subOsc.stop(now + stepDuration * 4.0);
      }

      // Melody arpeggio (with rests)
      const melodyFreq = melodyPattern[this.musicStep % melodyPattern.length];
      if (melodyFreq > 0) {
        const melOsc = this.ctx.createOscillator();
        melOsc.type = 'triangle';
        melOsc.frequency.setValueAtTime(melodyFreq, now);

        // Delay feedback for dreamy echo
        const melDelay = this.ctx.createDelay();
        melDelay.delayTime.value = stepDuration * 0.75;

        const melFeedback = this.ctx.createGain();
        melFeedback.gain.value = 0.2;

        const melGain = this.ctx.createGain();
        melGain.gain.setValueAtTime(0.07, now);
        melGain.gain.exponentialRampToValueAtTime(0.001, now + stepDuration * 1.2);

        melOsc.connect(melGain);
        melGain.connect(this.musicGain);
        melGain.connect(melDelay);
        melDelay.connect(melFeedback);
        melFeedback.connect(melDelay);
        melDelay.connect(this.musicGain);

        melOsc.start(now);
        melOsc.stop(now + stepDuration * 2.0);
      }

      // Hi-hat rhythm (every 2 steps, subtle)
      if (this.musicStep % 2 === 0) {
        const hatLen = this.ctx.sampleRate * 0.05;
        const hatBuf = this.ctx.createBuffer(1, hatLen, this.ctx.sampleRate);
        const hatData = hatBuf.getChannelData(0);
        for (let i = 0; i < hatLen; i++) {
          hatData[i] = (Math.random() * 2 - 1) * Math.exp(-i / (hatLen * 0.15));
        }
        const hatSource = this.ctx.createBufferSource();
        hatSource.buffer = hatBuf;

        const hatFilter = this.ctx.createBiquadFilter();
        hatFilter.type = 'highpass';
        hatFilter.frequency.value = 7000;

        const hatGain = this.ctx.createGain();
        hatGain.gain.setValueAtTime(0.035, now);
        hatGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

        hatSource.connect(hatFilter);
        hatFilter.connect(hatGain);
        hatGain.connect(this.musicGain);
        hatSource.start(now);
      }

      this.musicStep = (this.musicStep + 1) % 32;
    };

    this.musicIntervalId = setInterval(playSequenceStep, stepDuration * 1000);
  }

  // -------------------------------------------------------------
  // Mute & Settings Panel Toggles
  // -------------------------------------------------------------
  toggleMusic() {
    this.isMusicMuted = !this.isMusicMuted;
    if (this.musicGain) {
      this.musicGain.gain.setTargetAtTime(this.isMusicMuted ? 0.0 : 0.18, this.ctx.currentTime, 0.1);
    }
    return !this.isMusicMuted;
  }

  toggleSFX() {
    this.isSFXMuted = !this.isSFXMuted;
    if (this.sfxGain) {
      this.sfxGain.gain.setTargetAtTime(this.isSFXMuted ? 0.0 : 0.5, this.ctx.currentTime, 0.1);
    }
    return !this.isSFXMuted;
  }

  clear() {
    if (this.musicIntervalId) {
      clearInterval(this.musicIntervalId);
      this.musicIntervalId = null;
    }
    this.musicActive = false;

    // Clean up pad oscillators
    this.padOscs.forEach(osc => {
      try { osc.stop(); } catch(e) {}
    });
    this.padOscs = [];
    this.currentChordIndex = -1;

    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
  }
}

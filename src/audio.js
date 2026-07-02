// Audio engine for Parsewaver.
// Music: streamed CC-BY tracks (Kevin MacLeod / incompetech.com), looped with crossfades.
// Engine: one recorded loop (CC0, opengameart.org "Racing car engine sound loops"),
//   pitch-mapped to speed through a lowpass filter.
// Other SFX (wind, road, skid, scrape, crash) are procedural WebAudio.

const ENGINE_LOOP_URL = '/sfx/loop_2.wav';

const PLAYLIST = [
  { url: '/music/neon-laser-horizon.mp3', title: 'Neon Laser Horizon — Kevin MacLeod' },
  { url: '/music/voxel-revolution.mp3', title: 'Voxel Revolution — Kevin MacLeod' }
];

const MUSIC_VOLUME = 0.32;
const SFX_VOLUME = 0.5;
const CROSSFADE_SEC = 4.0;

export class AudioSynthManager {
  constructor() {
    this.ctx = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.masterCompressor = null;

    // Music state
    this.trackBuffers = new Map();
    this.trackIndex = Math.floor(Math.random() * PLAYLIST.length);
    this.currentSource = null;
    this.currentTrackGain = null;
    this.nextTrackTimer = null;
    this.onTrackChange = null; // callback(title)

    // Engine sampler state
    this.engineSource = null;
    this.engineFilter = null;
    this.engineBus = null;
    this.rpm = 0;
    this.windGain = null;
    this.roadGain = null;
    this.roadFilter = null;
    this.skidGain = null;
    this.skidFilter = null;
    this.scrapeGain = null;
    this.scrapeFilter = null;

    this.isMusicMuted = false;
    this.isSFXMuted = false;
  }

  init() {
    if (this.ctx) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContextClass();

    this.masterCompressor = this.ctx.createDynamicsCompressor();
    this.masterCompressor.threshold.setValueAtTime(-14, this.ctx.currentTime);
    this.masterCompressor.knee.setValueAtTime(18, this.ctx.currentTime);
    this.masterCompressor.ratio.setValueAtTime(4, this.ctx.currentTime);
    this.masterCompressor.connect(this.ctx.destination);

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = this.isMusicMuted ? 0 : MUSIC_VOLUME;
    this.musicGain.connect(this.masterCompressor);

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = this.isSFXMuted ? 0 : SFX_VOLUME;
    this.sfxGain.connect(this.masterCompressor);

    this.setupEngineSampler();
    this.setupWindSynth();
    this.setupRoadSynth();
    this.setupSkidSynth();
    this.setupScrapeSynth();

    this.startMusic();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  // -------------------------------------------------------------
  // Music playback (real tracks, looped with crossfade)
  // -------------------------------------------------------------
  async loadTrack(index) {
    const track = PLAYLIST[index];
    if (this.trackBuffers.has(track.url)) return this.trackBuffers.get(track.url);
    const res = await fetch(track.url);
    const raw = await res.arrayBuffer();
    const buffer = await this.ctx.decodeAudioData(raw);
    this.trackBuffers.set(track.url, buffer);
    return buffer;
  }

  async startMusic() {
    try {
      await this.playTrack(this.trackIndex);
      // Preload the next track in the background so the crossfade is seamless.
      this.loadTrack((this.trackIndex + 1) % PLAYLIST.length).catch(() => {});
    } catch (err) {
      console.warn('Music failed to load:', err);
    }
  }

  async playTrack(index) {
    if (!this.ctx) return;
    const buffer = await this.loadTrack(index);
    if (!this.ctx) return;

    const now = this.ctx.currentTime;

    // Fade out whatever is playing
    if (this.currentSource && this.currentTrackGain) {
      const oldSource = this.currentSource;
      this.currentTrackGain.gain.setTargetAtTime(0, now, CROSSFADE_SEC / 3);
      setTimeout(() => { try { oldSource.stop(); } catch (e) {} }, CROSSFADE_SEC * 1000 + 500);
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    const trackGain = this.ctx.createGain();
    trackGain.gain.setValueAtTime(0, now);
    trackGain.gain.linearRampToValueAtTime(1, now + CROSSFADE_SEC * 0.5);

    source.connect(trackGain);
    trackGain.connect(this.musicGain);
    source.start(now);

    this.currentSource = source;
    this.currentTrackGain = trackGain;
    this.trackIndex = index;

    if (this.onTrackChange) this.onTrackChange(PLAYLIST[index].title);

    // Schedule the next track to crossfade in before this one ends.
    if (this.nextTrackTimer) clearTimeout(this.nextTrackTimer);
    const switchInMs = Math.max(10, (buffer.duration - CROSSFADE_SEC) * 1000);
    this.nextTrackTimer = setTimeout(() => {
      this.playTrack((this.trackIndex + 1) % PLAYLIST.length);
    }, switchInMs);
  }

  // -------------------------------------------------------------
  // Engine: one recorded loop, pitch mapped to speed, low-passed.
  // Deliberately simple — crossfading multiple loops sounded awful.
  // -------------------------------------------------------------
  async setupEngineSampler() {
    const ctx = this.ctx;

    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = 0.0;
    this.engineBus.connect(this.sfxGain);

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 700;
    this.engineFilter.Q.value = 0.6;
    this.engineFilter.connect(this.engineBus);

    try {
      const raw = await fetch(ENGINE_LOOP_URL).then(r => r.arrayBuffer());
      if (!this.ctx) return;
      const buffer = await ctx.decodeAudioData(raw);

      this.engineSource = ctx.createBufferSource();
      this.engineSource.buffer = buffer;
      this.engineSource.loop = true;
      this.engineSource.playbackRate.value = 0.55;
      this.engineSource.connect(this.engineFilter);
      this.engineSource.start();
    } catch (err) {
      console.warn('Engine sample failed to load:', err);
    }
  }

  updateEngineSound(speed, isCrashed, throttle = 0, dt = 0.016) {
    if (!this.ctx || !this.engineSource) return;
    const now = this.ctx.currentTime;

    if (isCrashed) {
      this.engineBus.gain.setTargetAtTime(0, now, 0.15);
      return;
    }

    // Rev band 0..1 with inertia: revs rise faster than they fall
    const norm = Math.min(1, Math.abs(speed) / 70);
    const target = Math.min(1, Math.pow(norm, 0.85) + throttle * 0.04);
    const rate = target > this.rpm ? 1.4 : 0.8;
    this.rpm += (target - this.rpm) * Math.min(1, rate * dt * 4);

    this.engineSource.playbackRate.setTargetAtTime(0.55 + this.rpm * 0.85, now, 0.08);
    this.engineFilter.frequency.setTargetAtTime(500 + this.rpm * 1100 + throttle * 300, now, 0.1);

    const vol = 0.13 + this.rpm * 0.12 + throttle * 0.05;
    this.engineBus.gain.setTargetAtTime(vol, now, 0.08);
  }

  // -------------------------------------------------------------
  // Wind / road / skid / scrape beds
  // -------------------------------------------------------------
  makeNoiseBuffer(seconds, smooth = 0) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = last * smooth + white * (1 - smooth);
      data[i] = last;
    }
    return buf;
  }

  setupWindSynth() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.makeNoiseBuffer(2.0);
    src.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;

    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0.0;

    src.connect(filter);
    filter.connect(this.windGain);
    this.windGain.connect(this.sfxGain);
    src.start();
  }

  updateWindSound(speed) {
    if (!this.ctx || !this.windGain) return;
    const t = Math.min(1, Math.abs(speed) / 70);
    this.windGain.gain.setTargetAtTime(t * t * 0.1, this.ctx.currentTime, 0.1);
  }

  setupRoadSynth() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.makeNoiseBuffer(2.0, 0.82);
    src.loop = true;

    this.roadFilter = this.ctx.createBiquadFilter();
    this.roadFilter.type = 'bandpass';
    this.roadFilter.frequency.value = 95;
    this.roadFilter.Q.value = 0.9;

    this.roadGain = this.ctx.createGain();
    this.roadGain.gain.value = 0.0;

    src.connect(this.roadFilter);
    this.roadFilter.connect(this.roadGain);
    this.roadGain.connect(this.sfxGain);
    src.start();
  }

  updateRoadSound(speed) {
    if (!this.ctx || !this.roadGain) return;
    const now = this.ctx.currentTime;
    const t = Math.min(1, Math.abs(speed) / 70);
    this.roadGain.gain.setTargetAtTime(t * 0.1, now, 0.08);
    this.roadFilter.frequency.setTargetAtTime(70 + t * 170, now, 0.08);
  }

  setupSkidSynth() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.makeNoiseBuffer(2.0);
    src.loop = true;

    this.skidFilter = this.ctx.createBiquadFilter();
    this.skidFilter.type = 'bandpass';
    this.skidFilter.frequency.value = 900;
    this.skidFilter.Q.value = 3.5;

    this.skidGain = this.ctx.createGain();
    this.skidGain.gain.value = 0.0;

    src.connect(this.skidFilter);
    this.skidFilter.connect(this.skidGain);
    this.skidGain.connect(this.sfxGain);
    src.start();
  }

  updateSkidSound(lateralVel, speed) {
    if (!this.ctx || !this.skidGain) return;
    const now = this.ctx.currentTime;
    const slip = Math.abs(lateralVel);
    if (slip > 2.2 && Math.abs(speed) > 8) {
      const t = Math.min(1, (slip - 2.2) / 8);
      this.skidGain.gain.setTargetAtTime(t * 0.11, now, 0.04);
      this.skidFilter.frequency.setTargetAtTime(750 + Math.abs(speed) * 5, now, 0.05);
    } else {
      this.skidGain.gain.setTargetAtTime(0, now, 0.08);
    }
  }

  setupScrapeSynth() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.makeNoiseBuffer(1.5);
    src.loop = true;

    this.scrapeFilter = this.ctx.createBiquadFilter();
    this.scrapeFilter.type = 'bandpass';
    this.scrapeFilter.frequency.value = 2600;
    this.scrapeFilter.Q.value = 1.6;

    this.scrapeGain = this.ctx.createGain();
    this.scrapeGain.gain.value = 0.0;

    src.connect(this.scrapeFilter);
    this.scrapeFilter.connect(this.scrapeGain);
    this.scrapeGain.connect(this.sfxGain);
    src.start();
  }

  updateScrapeSound(isScraping, speed) {
    if (!this.ctx || !this.scrapeGain) return;
    const now = this.ctx.currentTime;
    if (isScraping && Math.abs(speed) > 3) {
      const t = Math.min(1, Math.abs(speed) / 50);
      this.scrapeGain.gain.setTargetAtTime(0.05 + t * 0.1, now, 0.03);
      this.scrapeFilter.frequency.setTargetAtTime(1800 + t * 1800, now, 0.05);
    } else {
      this.scrapeGain.gain.setTargetAtTime(0, now, 0.05);
    }
  }

  // -------------------------------------------------------------
  // One-shot SFX
  // -------------------------------------------------------------
  playCrashSFX() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    // Deep impact thud
    const thud = this.ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(110, now);
    thud.frequency.exponentialRampToValueAtTime(28, now + 0.4);
    const thudGain = this.ctx.createGain();
    thudGain.gain.setValueAtTime(0.8, now);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    thud.connect(thudGain);
    thudGain.connect(this.sfxGain);
    thud.start(now);
    thud.stop(now + 0.6);

    // Metallic crunch: two noise bursts through resonant filters
    [{ f: 700, q: 2, d: 0.28, g: 0.4 }, { f: 2400, q: 5, d: 0.45, g: 0.22 }].forEach(p => {
      const len = Math.floor(this.ctx.sampleRate * p.d);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.2));
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = p.f;
      filter.Q.value = p.q;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(p.g, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + p.d);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.sfxGain);
      src.start(now);
    });
  }

  playRailHitSFX() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const len = Math.floor(this.ctx.sampleRate * 0.12);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.1));
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1500;
    filter.Q.value = 2.5;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxGain);
    src.start(now);
  }

  // -------------------------------------------------------------
  // Toggles / lifecycle
  // -------------------------------------------------------------
  toggleMusic() {
    this.resume();
    this.isMusicMuted = !this.isMusicMuted;
    if (this.ctx && this.musicGain) {
      this.musicGain.gain.setTargetAtTime(this.isMusicMuted ? 0 : MUSIC_VOLUME, this.ctx.currentTime, 0.1);
    }
    return !this.isMusicMuted;
  }

  toggleSFX() {
    this.resume();
    this.isSFXMuted = !this.isSFXMuted;
    if (this.ctx && this.sfxGain) {
      this.sfxGain.gain.setTargetAtTime(this.isSFXMuted ? 0 : SFX_VOLUME, this.ctx.currentTime, 0.1);
    }
    return !this.isSFXMuted;
  }

  clear() {
    if (this.nextTrackTimer) {
      clearTimeout(this.nextTrackTimer);
      this.nextTrackTimer = null;
    }
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (e) {}
      this.currentSource = null;
    }
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
  }
}

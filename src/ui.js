// UI Controller for Parsewaver

export class UIController {
  constructor() {
    // HUD elements
    this.distVal = document.getElementById('dist-val');
    this.distBest = document.getElementById('dist-best');
    this.speedVal = document.getElementById('speed-val');
    this.speedBarFill = document.getElementById('speed-bar-fill');
    this.driveMode = document.getElementById('drive-mode');

    // Screens
    this.gameOverOverlay = document.getElementById('game-over-overlay');
    this.screenFlash = document.getElementById('screen-flash');

    // Buttons
    this.btnStart = null;
    this.btnRestart = document.getElementById('btn-restart');
    this.btnMuteMusic = document.getElementById('btn-mute-music');
    this.btnMuteSFX = document.getElementById('btn-mute-sfx');

    // Telemetry
    this.telemetryPanel = document.getElementById('telemetry-panel');
    this.telPosX = document.getElementById('tel-pos-x');
    this.telPosZ = document.getElementById('tel-pos-z');
    this.telHeading = document.getElementById('tel-heading');
    this.telSpeed = document.getElementById('tel-speed');
    this.telTraction = document.getElementById('tel-traction');
    this.telLatVel = document.getElementById('tel-lat-vel');
    this.telSlip = document.getElementById('tel-slip');
    this.telOffset = document.getElementById('tel-offset');
    this.telFPS = document.getElementById('tel-fps');

    this.showTelemetry = false;

    // Best distance in meters
    this.bestMeters = parseFloat(localStorage.getItem('parsewaver_best_m') || '0');
    this.updateBestDisplay();

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyT') {
        this.toggleTelemetryPanel();
      }
    });
  }

  setAudioHint(show) {
    const el = document.getElementById('audio-hint');
    if (el) el.classList.toggle('visible', !!show);
  }

  showNowPlaying(title) {
    const el = document.getElementById('now-playing');
    if (!el) return;
    el.textContent = `♫ ${title}`;
    el.classList.add('visible');
    clearTimeout(this._nowPlayingTimer);
    this._nowPlayingTimer = setTimeout(() => el.classList.remove('visible'), 5000);
  }

  updateHUD(distanceMeters, speed, mode = '') {
    if (this.distVal) {
      this.distVal.innerHTML = `${(distanceMeters / 1000).toFixed(2)}<span class="dist-unit">km</span>`;
    }
    if (this.speedVal) {
      this.speedVal.textContent = Math.abs(Math.round(speed * 3.6));
    }
    if (this.speedBarFill) {
      const pct = Math.min(1, Math.abs(speed) / 70) * 100;
      this.speedBarFill.style.width = `${pct}%`;
    }
    if (this.driveMode) {
      this.driveMode.textContent = mode;
    }
  }

  updateBestDisplay() {
    if (this.distBest) {
      this.distBest.textContent = `best ${(this.bestMeters / 1000).toFixed(2)} km`;
    }
  }

  saveHighScore(distanceMeters) {
    if (distanceMeters > this.bestMeters) {
      this.bestMeters = distanceMeters;
      localStorage.setItem('parsewaver_best_m', String(this.bestMeters));
      this.updateBestDisplay();
    }
  }

  toggleTelemetryPanel() {
    this.showTelemetry = !this.showTelemetry;
    if (this.telemetryPanel) {
      this.telemetryPanel.style.display = this.showTelemetry ? 'block' : 'none';
    }
  }

  updateTelemetry(car, lateralOffset, fps) {
    if (!this.showTelemetry) return;

    if (this.telPosX) this.telPosX.textContent = car.position.x.toFixed(4);
    if (this.telPosZ) this.telPosZ.textContent = car.position.z.toFixed(4);
    if (this.telHeading) this.telHeading.textContent = `${car.heading.toFixed(4)} rad`;
    if (this.telSpeed) this.telSpeed.textContent = car.speed.toFixed(4);
    if (this.telTraction) this.telTraction.textContent = car.traction.toFixed(4);
    if (this.telLatVel) this.telLatVel.textContent = car.localLatVel.toFixed(4);
    if (this.telSlip) this.telSlip.textContent = `${car.slipAngle.toFixed(2)}°`;
    if (this.telOffset) this.telOffset.textContent = lateralOffset.toFixed(4);
    if (this.telFPS) this.telFPS.textContent = Math.round(fps);
  }

  flashCrash() {
    if (this.screenFlash) {
      this.screenFlash.classList.add('flash-crash');
      setTimeout(() => {
        this.screenFlash.classList.remove('flash-crash');
      }, 150);
    }
  }

  hideMenu() {}

  showGameOver(distanceMeters) {
    if (this.gameOverOverlay) {
      this.gameOverOverlay.classList.remove('hidden');
      document.getElementById('final-score').textContent = (distanceMeters / 1000).toFixed(2);
    }
  }

  hideGameOver() {
    if (this.gameOverOverlay) this.gameOverOverlay.classList.add('hidden');
  }
}

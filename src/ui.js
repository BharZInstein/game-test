// UI Controller for Parsewaver

export class UIController {
  constructor() {
    // HUD element selections
    this.scoreVal = document.getElementById('score-val');
    this.bestVal = document.getElementById('best-val');
    this.speedVal = document.getElementById('speed-val');
    this.tractionIndicator = document.getElementById('traction-indicator');
    
    // Screens
    this.menuOverlay = document.getElementById('menu-overlay');
    this.gameOverOverlay = document.getElementById('game-over-overlay');
    this.screenFlash = document.getElementById('screen-flash');
    
    // Buttons
    this.btnStart = document.getElementById('btn-start');
    this.btnRestart = document.getElementById('btn-restart');
    this.btnMuteMusic = document.getElementById('btn-mute-music');
    this.btnMuteSFX = document.getElementById('btn-mute-sfx');

    // Telemetry Elements
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

    // Load High Score
    this.bestScore = parseInt(localStorage.getItem('parsewaver_high_score') || '0', 10);
    this.updateBestScoreDisplay();

    // Event listeners
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyT') {
        this.toggleTelemetryPanel();
      }
    });
  }

  // Update HUD text displays
  updateHUD(score, speed) {
    // Update Score (Padded 6 digits)
    if (this.scoreVal) {
      this.scoreVal.textContent = Math.floor(score).toString().padStart(6, '0');
    }

    // Update Speedometer (km/h conversion factor = speed * 3.6 for roughly m/s equivalents)
    if (this.speedVal) {
      this.speedVal.textContent = Math.abs(Math.floor(speed * 3.6));
    }

    if (this.tractionIndicator) {
      this.tractionIndicator.textContent = 'CRUISE';
      this.tractionIndicator.classList.remove('slide');
    }
  }

  updateBestScoreDisplay() {
    if (this.bestVal) {
      this.bestVal.textContent = this.bestScore.toString().padStart(6, '0');
    }
  }

  saveHighScore(score) {
    if (score > this.bestScore) {
      this.bestScore = Math.floor(score);
      localStorage.setItem('parsewaver_high_score', this.bestScore.toString());
      this.updateBestScoreDisplay();
    }
  }

  // Diagnostic Telemetry Panel
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

  // Screen Flash Visual Effects
  flashCrash() {
    if (this.screenFlash) {
      this.screenFlash.classList.add('flash-crash');
      setTimeout(() => {
        this.screenFlash.classList.remove('flash-crash');
      }, 150);
    }
  }

  flashNearMiss() {
    if (this.screenFlash) {
      this.screenFlash.classList.add('flash-near-miss');
      setTimeout(() => {
        this.screenFlash.classList.remove('flash-near-miss');
      }, 100);
    }
  }

  // Floating text spawn for event indicators
  spawnFloatingText(text, isNearMiss, x, y) {
    const el = document.createElement('div');
    el.className = `floating-text ${isNearMiss ? 'text-near-miss' : 'text-drift'}`;
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    document.body.appendChild(el);

    // Self-destruct after animation completes
    setTimeout(() => {
      el.remove();
    }, 1200);
  }

  // Screen visibility states
  showMenu() {
    if (this.menuOverlay) this.menuOverlay.classList.remove('hidden');
    if (this.gameOverOverlay) this.gameOverOverlay.classList.add('hidden');
  }

  hideMenu() {
    if (this.menuOverlay) this.menuOverlay.classList.add('hidden');
  }

  showGameOver(score) {
    if (this.gameOverOverlay) {
      this.gameOverOverlay.classList.remove('hidden');
      document.getElementById('final-score').textContent = Math.floor(score);
    }
  }

  hideGameOver() {
    if (this.gameOverOverlay) this.gameOverOverlay.classList.add('hidden');
  }
}

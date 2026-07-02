export class InputController {
  constructor() {
    this.keys = {};
    
    // Set up keyboard event listeners
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      
      // Prevent browser default scroll actions when playing the game
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
    });
  }

  get inputs() {
    const throttle = (this.keys['KeyW'] || this.keys['ArrowUp']) ? 1.0 : 0.0;
    const brake = (this.keys['KeyS'] || this.keys['ArrowDown']) ? 1.0 : 0.0;
    
    let steering = 0.0;
    if (this.keys['KeyA'] || this.keys['ArrowLeft']) steering += 1.0;
    if (this.keys['KeyD'] || this.keys['ArrowRight']) steering -= 1.0;
    
    const handbrake = false;
    const reset = !!this.keys['KeyR'];
    const toggleTelemetry = !!this.keys['KeyT'];

    return { throttle, brake, steering, handbrake, reset, toggleTelemetry };
  }
}

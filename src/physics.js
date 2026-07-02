export class CarPhysics {
  constructor() {
    this.position = { x: 0, y: 0, z: 0 };
    this.heading = 0; // Rotation in radians around Y-axis (yaw), 0 faces world +Z
    this.speed = 0;   // Forward speed (units/sec)
    this.localLatVel = 0; // Local lateral velocity (slipping to the side)

    // Physics constants
    this.maxSpeed = 70;         // Max forward speed
    this.maxReverseSpeed = -15; // Max reverse speed
    this.accel = 26;            // Acceleration rate
    this.braking = 38;          // Braking rate
    this.dragCoeff = 0.045;     // Linear drag coefficient
    this.windCoeff = 0.0008;    // Quadratic air resistance coefficient
    this.baseTurnRate = 2.1;    // Steering speed (rad/s)

    this.traction = 1.0;
    this.slipAngle = 0;
    this.grade = 0;        // Road slope along heading (rise/run), set externally
    this.surfaceGrip = 1.0; // 1 on asphalt, < 1 on shoulder
  }

  update(inputs, dt) {
    if (dt <= 0) return;
    if (dt > 0.1) dt = 0.1; // Cap dt to prevent numerical explosions

    this.traction = this.surfaceGrip;

    // Acceleration / Braking
    const throttleInput = inputs.throttle || 0; // 0 to 1
    const brakeInput = inputs.brake || 0;       // 0 to 1

    let accelForce = 0;
    if (this.speed >= 0) {
      accelForce = throttleInput * this.accel - brakeInput * this.braking;
    } else {
      accelForce = throttleInput * this.braking - brakeInput * this.accel;
    }

    // Gravity along the road grade: climbing slows you down, descending speeds you up.
    accelForce -= this.grade * 9.81 * 0.6;

    // Engine braking / rolling resistance: with no pedal pressed the car must
    // always bleed speed, even downhill (otherwise it slowly accelerates on descents).
    if (throttleInput < 0.05 && brakeInput < 0.05 && Math.abs(this.speed) > 0.5) {
      accelForce -= Math.sign(this.speed) * 2.4;
    }

    // Apply linear drag and air resistance
    const speedSign = Math.sign(this.speed);
    let drag = this.speed * this.dragCoeff + this.speed * this.speed * this.windCoeff * speedSign;

    // Rolling on the shoulder adds drag
    drag += this.speed * (1.0 - this.surfaceGrip) * 0.35;

    this.speed += (accelForce - drag) * dt;
    this.speed = Math.max(this.maxReverseSpeed, Math.min(this.maxSpeed, this.speed));

    // Steering & Heading
    const steeringInput = inputs.steering || 0; // -1 (left) to 1 (right)

    // Scale turning rate by speed
    const absSpeed = Math.abs(this.speed);
    let turnRateFactor = Math.min(absSpeed / 4.0, 1.0);

    // Steering authority falls off hard at speed — highway physics, not twitch dodging
    if (absSpeed > 25.0) {
      turnRateFactor *= Math.max(0.3, 1.0 - (absSpeed - 25.0) / 80.0);
    }

    const turnAmount = steeringInput * this.baseTurnRate * turnRateFactor * dt * Math.sign(this.speed || 1);
    this.heading += turnAmount;

    // Momentum transfer due to yaw rotation: heading turns but the velocity vector lags,
    // converting some forward speed into side slip.
    const cosYaw = Math.cos(turnAmount);
    const sinYaw = Math.sin(turnAmount);

    const prevFwd = this.speed;
    const prevLat = this.localLatVel;

    this.speed = prevFwd * cosYaw + prevLat * sinYaw;
    this.localLatVel = prevLat * cosYaw - prevFwd * sinYaw;

    // Dampen lateral velocity based on current traction
    const gripCoeff = 11.0 * this.traction;
    this.localLatVel *= Math.exp(-gripCoeff * dt);

    // World position translation
    const fwdX = Math.sin(this.heading);
    const fwdZ = Math.cos(this.heading);
    const latX = Math.cos(this.heading);
    const latZ = -Math.sin(this.heading);

    const velX = fwdX * this.speed + latX * this.localLatVel;
    const velZ = fwdZ * this.speed + latZ * this.localLatVel;

    this.position.x += velX * dt;
    this.position.z += velZ * dt;

    // Telemetry slip angle
    if (absSpeed > 1.0) {
      this.slipAngle = Math.atan2(this.localLatVel, this.speed) * (180.0 / Math.PI);
    } else {
      this.slipAngle = 0.0;
    }
  }
}

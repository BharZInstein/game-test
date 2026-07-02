// Visual juice for Parsewaver: particles (sparks, tire smoke), skid marks,
// canvas-generated lens flare textures, god rays, birds, and stars.

import * as THREE from 'three';

// ---------------------------------------------------------------
// Screen-space god rays (radial light scattering toward the sun)
// ---------------------------------------------------------------
export const GodRaysShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
    uIntensity: { value: 0.0 }
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 uSunScreen;
    uniform float uIntensity;
    varying vec2 vUv;

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (uIntensity < 0.003) { gl_FragColor = base; return; }

      const int STEPS = 28;
      vec2 delta = (uSunScreen - vUv) / float(STEPS);
      vec2 pos = vUv;
      float accum = 0.0;
      float weight = 1.0;

      for (int i = 0; i < STEPS; i++) {
        pos += delta;
        vec3 s = texture2D(tDiffuse, pos).rgb;
        float luma = dot(s, vec3(0.299, 0.587, 0.114));
        accum += max(0.0, luma - 0.72) * weight;
        weight *= 0.94;
      }

      vec3 rayColor = vec3(1.0, 0.85, 0.62) * accum * uIntensity * 0.05;
      gl_FragColor = vec4(base.rgb + rayColor, base.a);
    }
  `
};

// ---------------------------------------------------------------
// Birds — small flapping silhouettes circling above the valley
// ---------------------------------------------------------------
export class BirdFlock {
  constructor(scene, count = 7) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.birds = [];
    this.time = 0;

    const mat = new THREE.MeshBasicMaterial({ color: 0x14100e, side: THREE.DoubleSide });
    const wingGeo = new THREE.BufferGeometry();
    wingGeo.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0.12, 0, 0, -0.12, 1.0, 0.12, 0
    ], 3));
    wingGeo.setIndex([0, 1, 2]);
    wingGeo.computeVertexNormals();

    for (let i = 0; i < count; i++) {
      const bird = new THREE.Group();
      const left = new THREE.Mesh(wingGeo, mat);
      const right = new THREE.Mesh(wingGeo, mat);
      right.scale.x = -1;
      bird.add(left, right);
      bird.userData = {
        wings: [left, right],
        phase: Math.random() * Math.PI * 2,
        radius: 16 + Math.random() * 26,
        height: 34 + Math.random() * 22,
        speed: 0.14 + Math.random() * 0.12,
        flap: 7 + Math.random() * 4,
        scale: 1.4 + Math.random() * 1.3
      };
      bird.scale.setScalar(bird.userData.scale);
      this.group.add(bird);
      this.birds.push(bird);
    }
  }

  update(dt, carX, carZ) {
    this.time += dt;
    // Flock center drifts along ahead of the car
    this.group.position.set(carX + 30, 0, carZ + 130);

    this.birds.forEach(bird => {
      const u = bird.userData;
      const a = this.time * u.speed + u.phase;
      bird.position.set(Math.cos(a) * u.radius, u.height + Math.sin(a * 2.3) * 3, Math.sin(a) * u.radius);
      bird.rotation.y = -a - Math.PI / 2;
      const flap = Math.sin(this.time * u.flap + u.phase) * 0.7;
      u.wings[0].rotation.z = flap;
      u.wings[1].rotation.z = -flap;
    });
  }

  setVisible(v) {
    this.group.visible = v;
  }
}

// ---------------------------------------------------------------
// Stars — camera-following point sphere, faded in at night
// ---------------------------------------------------------------
export class StarField {
  constructor(scene, count = 700) {
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Upper hemisphere only
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.95);
      const r = 850;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    this.material = new THREE.PointsMaterial({
      color: 0xdfe8ff,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = -1;
    scene.add(this.points);
  }

  update(cameraPos, nightFactor) {
    this.points.position.copy(cameraPos);
    this.points.rotation.y += 0.00002;
    this.material.opacity = nightFactor * 0.9;
    this.points.visible = nightFactor > 0.02;
  }
}

// ---------------------------------------------------------------
// Canvas texture helpers
// ---------------------------------------------------------------
export function makeRadialTexture(size, stops) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([t, color]) => grad.addColorStop(t, color));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------
// Sparks — additive points with gravity, short life
// ---------------------------------------------------------------
export class SparkSystem {
  constructor(scene, count = 220) {
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.life = new Float32Array(count); // seconds remaining
    this.maxLife = new Float32Array(count);
    this.colors = new Float32Array(count * 3);
    this.cursor = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));

    const mat = new THREE.PointsMaterial({
      size: 0.14,
      map: makeRadialTexture(32, [[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,220,150,0.9)'], [1, 'rgba(255,150,50,0)']]),
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      sizeAttenuation: true
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  spawn(x, y, z, vx, vy, vz) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.velocities[i * 3] = vx;
    this.velocities[i * 3 + 1] = vy;
    this.velocities[i * 3 + 2] = vz;
    const life = 0.25 + Math.random() * 0.45;
    this.life[i] = life;
    this.maxLife[i] = life;
  }

  update(dt) {
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) {
        this.colors[i * 3] = this.colors[i * 3 + 1] = this.colors[i * 3 + 2] = 0;
        continue;
      }
      this.life[i] -= dt;
      this.velocities[i * 3 + 1] -= 14 * dt; // gravity
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;

      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      this.colors[i * 3] = t;               // white-hot → orange → out
      this.colors[i * 3 + 1] = t * t * 0.85;
      this.colors[i * 3 + 2] = t * t * t * 0.5;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}

// ---------------------------------------------------------------
// Tire smoke — small pool of individually faded sprites
// ---------------------------------------------------------------
export class SmokeSystem {
  constructor(scene, count = 26) {
    this.pool = [];
    const tex = makeRadialTexture(64, [[0, 'rgba(210,205,200,0.55)'], [0.55, 'rgba(190,185,180,0.28)'], [1, 'rgba(180,175,170,0)']]);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      scene.add(sprite);
      this.pool.push({ sprite, life: 0, maxLife: 1, vx: 0, vy: 0, vz: 0 });
    }
    this.cursor = 0;
  }

  spawn(x, y, z, vx, vz) {
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;
    p.sprite.position.set(x, y, z);
    p.sprite.scale.setScalar(0.55 + Math.random() * 0.4);
    p.vx = vx + (Math.random() - 0.5) * 1.5;
    p.vy = 0.9 + Math.random() * 0.8;
    p.vz = vz + (Math.random() - 0.5) * 1.5;
    p.maxLife = 0.7 + Math.random() * 0.5;
    p.life = p.maxLife;
    p.sprite.visible = true;
  }

  update(dt) {
    this.pool.forEach(p => {
      if (p.life <= 0) {
        p.sprite.visible = false;
        return;
      }
      p.life -= dt;
      const t = Math.max(0, p.life / p.maxLife);
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.position.z += p.vz * dt;
      p.sprite.scale.addScalar(2.4 * dt);
      p.sprite.material.opacity = t * 0.5;
    });
  }
}

// ---------------------------------------------------------------
// Skid marks — ring buffer of fading quads laid on the road
// ---------------------------------------------------------------
export class SkidMarkSystem {
  constructor(scene, maxQuads = 420) {
    this.maxQuads = maxQuads;
    this.cursor = 0;

    this.positions = new Float32Array(maxQuads * 4 * 3);
    this.colors = new Float32Array(maxQuads * 4 * 4); // RGBA per vertex
    const indices = new Uint32Array(maxQuads * 6);
    for (let q = 0; q < maxQuads; q++) {
      const v = q * 4;
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 4));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    const mat = new THREE.MeshBasicMaterial({
      color: 0x0a0a0c,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);

    // Per-wheel last laid position, keyed by caller
    this.lastPos = new Map();
  }

  // Lay a segment from the wheel's previous position to its current one.
  lay(key, x, y, z, heading, width = 0.42, alpha = 0.55) {
    const prev = this.lastPos.get(key);
    this.lastPos.set(key, { x, y, z });
    if (!prev) return;

    const dx = x - prev.x;
    const dz = z - prev.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.25 || len > 6) return; // too short to matter / teleported

    // Perpendicular to segment direction
    const px = -dz / len * width * 0.5;
    const pz = dx / len * width * 0.5;

    const q = this.cursor;
    this.cursor = (this.cursor + 1) % this.maxQuads;

    const P = this.positions;
    const base = q * 12;
    P[base] = prev.x + px; P[base + 1] = prev.y; P[base + 2] = prev.z + pz;
    P[base + 3] = prev.x - px; P[base + 4] = prev.y; P[base + 5] = prev.z - pz;
    P[base + 6] = x - px; P[base + 7] = y; P[base + 8] = z - pz;
    P[base + 9] = x + px; P[base + 10] = y; P[base + 11] = z + pz;

    const C = this.colors;
    for (let v = 0; v < 4; v++) {
      const c = q * 16 + v * 4;
      C[c] = 0.04; C[c + 1] = 0.04; C[c + 2] = 0.05; C[c + 3] = alpha;
    }
    this.dirty = true;
  }

  release(key) {
    this.lastPos.delete(key);
  }

  update(dt) {
    // Fade all marks slowly
    const decay = Math.exp(-dt / 7);
    const C = this.colors;
    let any = false;
    for (let i = 3; i < C.length; i += 4) {
      if (C[i] > 0.004) {
        C[i] *= decay;
        any = true;
      } else if (C[i] !== 0) {
        C[i] = 0;
        any = true;
      }
    }
    if (any || this.dirty) {
      this.mesh.geometry.attributes.color.needsUpdate = true;
      this.mesh.geometry.attributes.position.needsUpdate = true;
      this.dirty = false;
    }
  }
}

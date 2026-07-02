import * as THREE from 'three';
import { CarPhysics } from './physics.js';
import { InputController } from './input.js';
import { WorldManager, getTerrainHeight, getRoadX, getRoadElevation, getRoadAngle } from './world.js';
import { UIController } from './ui.js';
import { AudioSynthManager } from './audio.js';

// Post-processing imports
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

// -------------------------------------------------------------
// Global States
// -------------------------------------------------------------
let scene, camera, renderer;
let carPhysics, inputController, worldManager, uiController;
let carGroup, carShell, wheels = [];
let carVisuals = {
  headlights: [],
  tailMaterials: [],
  underglow: null,
  fillLight: null
};
let dirLight;

// Post-processing and Audio (Layer 5 & 6)
let composer, bloomPass;
let useBloom = true; // Will dynamically toggle off if frame drops
let audioSynthManager;
let sky, sunPosition;
let skyDetails;

// No title/menu state: world is visible immediately, first W starts audio/run timing.
let gameState = 'PLAYING';
let runStarted = false;

// Score states
let score = 0;
let distanceTraveled = 0;

// Straight-Line Test State Variables (Layer 1 Verification)
let startingX = 0;
let startingZ = 0;
let startingHeading = 0;
let isFirstDriveFrame = true;

// Crash & Feedback State Variables
let cameraShake = 0.0;

// Performance timing
let lastTime = 0;
let frameCount = 0;
let fpsTimer = 0;
let currentFPS = 60;

// -------------------------------------------------------------
// Core Helper Methods
// -------------------------------------------------------------
function triggerCrash() {
  if (gameState !== 'PLAYING') return;
  gameState = 'CRASHED';
  cameraShake = 2.8;

  // Visual cues
  uiController.flashCrash();
  uiController.saveHighScore(score);
  uiController.showGameOver(score);

  // Play procedural sound effects
  if (audioSynthManager) {
    audioSynthManager.playCrashSFX();
  }

  // Stop car kinematics
  carPhysics.speed = 0.0;
  carPhysics.localLatVel = 0.0;
}

function getScreenPosition(position3D, camera) {
  const tempV = position3D.clone();
  tempV.project(camera);
  
  // Map projected clip coordinates [-1, 1] to screen dimensions
  const x = (tempV.x * 0.5 + 0.5) * window.innerWidth;
  const y = (tempV.y * -0.5 + 0.5) * window.innerHeight;
  return { x, y };
}

function shortestAngleDelta(target, current) {
  return Math.atan2(Math.sin(target - current), Math.cos(target - current));
}

// -------------------------------------------------------------
// Core Initialization
// -------------------------------------------------------------
function init() {
  // --- Height-based fog shader patches (MUST be before material creation) ---
  THREE.ShaderChunk.fog_pars_vertex = `
    #ifdef USE_FOG
      varying float vFogDepth;
      varying vec3 vFogWorldPosition;
    #endif
  `;
  THREE.ShaderChunk.fog_vertex = `
    #ifdef USE_FOG
      vFogDepth = -mvPosition.z;
      vFogWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    #endif
  `;
  THREE.ShaderChunk.fog_pars_fragment = `
    #ifdef USE_FOG
      uniform vec3 fogColor;
      varying float vFogDepth;
      varying vec3 vFogWorldPosition;
      #ifdef FOG_EXP2
        uniform float fogDensity;
      #endif
      uniform float fogNear;
      uniform float fogFar;
    #endif
  `;
  THREE.ShaderChunk.fog_fragment = `
    #ifdef USE_FOG
      float fogDepth = vFogDepth;
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * fogDepth * fogDepth);
      #else
        float fogFactor = smoothstep(fogNear, fogFar, fogDepth);
      #endif
      float heightFog = 1.0 - smoothstep(-10.0, 80.0, vFogWorldPosition.y);
      fogFactor *= heightFog;
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
    #endif
  `;

  // 1. Scene, Camera, Renderer Setup
  scene = new THREE.Scene();
  // Fog color matches sunset horizon for seamless blending
  scene.fog = new THREE.FogExp2(0xe4a16f, 0.00145);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.getElementById('canvas-container').appendChild(renderer.domElement);

  // Post-processing setup (Layer 5)
  const renderPass = new RenderPass(scene, camera);
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.28,
    0.24,
    0.58
  );

  // Color grading + vignette shader pass
  const ColorGradeShader = {
    uniforms: { tDiffuse: { value: null } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      varying vec2 vUv;
      void main() {
        vec4 color = texture2D(tDiffuse, vUv);
        // Warm shadows, slightly cool highlights
        color.rgb = pow(color.rgb, vec3(0.94, 0.98, 1.04));
        // Subtle saturation boost
        float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
        color.rgb = mix(vec3(gray), color.rgb, 1.15);
        // Vignette
        float dist = distance(vUv, vec2(0.5));
        color.rgb *= 1.0 - smoothstep(0.35, 0.85, dist) * 0.45;
        gl_FragColor = color;
      }
    `
  };
  const colorGradePass = new ShaderPass(ColorGradeShader);

  composer = new EffectComposer(renderer);
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(colorGradePass);

  // 2. Lighting Setup
  const ambientLight = new THREE.AmbientLight(0xfff4e4, 0.56);
  scene.add(ambientLight);

  dirLight = new THREE.DirectionalLight(0xffb46b, 1.18); // Warm sunset light
  dirLight.position.set(100, 80, 200);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 500;
  
  const d = 150;
  dirLight.shadow.camera.left = -d;
  dirLight.shadow.camera.right = d;
  dirLight.shadow.camera.top = d;
  dirLight.shadow.camera.bottom = -d;
  scene.add(dirLight);

  // Decorative hemisphere light to color upward-facing surfaces purple
  const hemiLight = new THREE.HemisphereLight(0x9fd2ff, 0xffa86c, 0.84);
  hemiLight.position.set(0, 50, 0);
  scene.add(hemiLight);

  // --- Atmospheric Sky Shader (Preetham model) ---
  sky = new Sky();
  sky.scale.setScalar(50000);
  scene.add(sky);

  const skyUniforms = sky.material.uniforms;
  skyUniforms['turbidity'].value = 6;
  skyUniforms['rayleigh'].value = 1.55;
  skyUniforms['mieCoefficient'].value = 0.004;
  skyUniforms['mieDirectionalG'].value = 0.78;

  // Sun at 7° above horizon for a readable golden-hour road.
  const phi = THREE.MathUtils.degToRad(90 - 7);
  const theta = THREE.MathUtils.degToRad(215);
  sunPosition = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  skyUniforms['sunPosition'].value.copy(sunPosition);

  // Align directional light with sun direction
  dirLight.position.copy(sunPosition).multiplyScalar(200);

  createSkyDetails();

  // 3. Module Instances
  carPhysics = new CarPhysics();
  inputController = new InputController();
  worldManager = new WorldManager(scene);
  uiController = new UIController();

  audioSynthManager = new AudioSynthManager();

  // 4. Create 3D Car Representation
  createCarMesh();

  // 5. Connect UI Button Handlers
  setupButtonListeners();

  // 6. Handle Window Resize
  window.addEventListener('resize', onWindowResize);

  // 7. Start Animation Loop
  lastTime = performance.now();
  requestAnimationFrame(animate);
}

// -------------------------------------------------------------
// Create 3D Car Mesh
// -------------------------------------------------------------
function createSkyDetails() {
  skyDetails = new THREE.Group();
  scene.add(skyDetails);

  const cloudMat = new THREE.MeshBasicMaterial({
    color: 0xffe6d2,
    transparent: true,
    opacity: 0.38,
    depthWrite: false
  });
  const shadowCloudMat = new THREE.MeshBasicMaterial({
    color: 0xb88986,
    transparent: true,
    opacity: 0.18,
    depthWrite: false
  });
  const cloudGeo = new THREE.DodecahedronGeometry(1, 1);

  for (let i = 0; i < 24; i++) {
    const cluster = new THREE.Group();
    const angle = i * 2.399;
    const radius = 160 + (i % 7) * 44;
    cluster.position.set(
      Math.cos(angle) * radius,
      72 + (i % 5) * 10,
      Math.sin(angle) * radius + 190
    );
    cluster.rotation.y = angle * 0.35;

    const puffs = 4 + (i % 4);
    for (let p = 0; p < puffs; p++) {
      const puff = new THREE.Mesh(cloudGeo, p % 3 === 0 ? shadowCloudMat : cloudMat);
      puff.position.set((p - puffs * 0.5) * 8, (p % 2) * 2.5, Math.sin(p * 1.7) * 5);
      puff.scale.set(14 + p * 3, 4.5 + (p % 2) * 2, 7 + (p % 3) * 2.4);
      cluster.add(puff);
    }

    skyDetails.add(cluster);
  }

}

function createCarMesh() {
  carGroup = new THREE.Group();
  scene.add(carGroup);

  carShell = new THREE.Group();
  carGroup.add(carShell);
  wheels = [];
  carVisuals = { headlights: [], tailMaterials: [], underglow: null, fillLight: null };

  const taperBox = (width, height, length, frontScale = 0.74, rearScale = 0.92) => {
    const geo = new THREE.BoxGeometry(width, height, length, 2, 1, 5);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      const y = pos.getY(i);
      const t = (z + length * 0.5) / length;
      const sideScale = THREE.MathUtils.lerp(rearScale, frontScale, t);
      pos.setX(i, pos.getX(i) * sideScale);
      if (y > 0) {
        const hoodDrop = Math.max(0, t - 0.58) * 0.22;
        const deckDrop = Math.max(0, 0.24 - t) * 0.14;
        pos.setY(i, y - hoodDrop - deckDrop);
      }
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  };

  const hullGeometry = (sections) => {
    const vertices = [];
    const indices = [];
    const addQuad = (a, b, c, d) => {
      indices.push(a, b, c, a, c, d);
    };

    sections.forEach(section => {
      vertices.push(
        -section.wb, section.y0, section.z,
        section.wb, section.y0, section.z,
        section.wt, section.y1, section.z,
        -section.wt, section.y1, section.z
      );
    });

    for (let i = 0; i < sections.length - 1; i++) {
      const a = i * 4;
      const b = (i + 1) * 4;
      addQuad(a, b, b + 1, a + 1);       // undertray
      addQuad(a + 1, b + 1, b + 2, a + 2); // right side
      addQuad(a + 2, b + 2, b + 3, a + 3); // top planes
      addQuad(a + 3, b + 3, b, a);       // left side
    }

    addQuad(0, 1, 2, 3);
    const last = (sections.length - 1) * 4;
    addQuad(last + 3, last + 2, last + 1, last);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  };

  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: 0x22b8c7,
    roughness: 0.3,
    metalness: 0.42,
    emissive: 0x06353c,
    emissiveIntensity: 0.32,
    clearcoat: 1.0,
    clearcoatRoughness: 0.2,
    side: THREE.DoubleSide
  });
  const accentMat = new THREE.MeshPhysicalMaterial({
    color: 0xffa23f,
    roughness: 0.22,
    metalness: 0.55,
    emissive: 0xff5f1f,
    emissiveIntensity: 0.18,
    clearcoat: 0.8,
    side: THREE.DoubleSide
  });
  const carbonMat = new THREE.MeshStandardMaterial({
    color: 0x101923,
    roughness: 0.55,
    metalness: 0.35,
    emissive: 0x03080c,
    emissiveIntensity: 0.22
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x12364a,
    roughness: 0.04,
    metalness: 0.05,
    emissive: 0x062033,
    emissiveIntensity: 0.26,
    transmission: 0.15,
    transparent: true,
    opacity: 0.86
  });
  const rearPanelMat = new THREE.MeshPhysicalMaterial({
    color: 0x21c5d0,
    roughness: 0.32,
    metalness: 0.32,
    emissive: 0x06343a,
    emissiveIntensity: 0.35,
    clearcoat: 0.7,
    side: THREE.DoubleSide
  });
  const amberGlowMat = new THREE.MeshBasicMaterial({ color: 0xffa43d, toneMapped: false });
  const rearPanelGeometry = (bottomWidth, topWidth, y0, y1, z) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
      -bottomWidth * 0.5, y0, z,
      bottomWidth * 0.5, y0, z,
      topWidth * 0.5, y1, z,
      -topWidth * 0.5, y1, z
    ], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.computeVertexNormals();
    return geo;
  };

  const bodyMesh = new THREE.Mesh(hullGeometry([
    { z: -2.68, wb: 1.12, wt: 0.82, y0: 0.22, y1: 0.65 },
    { z: -1.72, wb: 1.3, wt: 1.02, y0: 0.2, y1: 0.78 },
    { z: -0.18, wb: 1.2, wt: 0.92, y0: 0.22, y1: 0.83 },
    { z: 1.24, wb: 1.0, wt: 0.68, y0: 0.22, y1: 0.65 },
    { z: 2.58, wb: 0.7, wt: 0.42, y0: 0.26, y1: 0.48 }
  ]), bodyMat);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  carShell.add(bodyMesh);

  const lowerMesh = new THREE.Mesh(hullGeometry([
    { z: -2.82, wb: 1.18, wt: 1.12, y0: 0.08, y1: 0.28 },
    { z: -1.25, wb: 1.36, wt: 1.28, y0: 0.08, y1: 0.36 },
    { z: 1.1, wb: 1.12, wt: 1.0, y0: 0.1, y1: 0.32 },
    { z: 2.72, wb: 0.78, wt: 0.66, y0: 0.12, y1: 0.24 }
  ]), carbonMat);
  lowerMesh.castShadow = true;
  lowerMesh.receiveShadow = true;
  carShell.add(lowerMesh);

  const noseStripe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.035, 3.15), accentMat);
  noseStripe.position.set(0, 0.9, 0.65);
  noseStripe.castShadow = true;
  carShell.add(noseStripe);

  const cabinMesh = new THREE.Mesh(hullGeometry([
    { z: -1.16, wb: 0.72, wt: 0.54, y0: 0.78, y1: 1.04 },
    { z: -0.34, wb: 0.88, wt: 0.58, y0: 0.82, y1: 1.28 },
    { z: 0.88, wb: 0.6, wt: 0.34, y0: 0.7, y1: 1.02 }
  ]), glassMat);
  cabinMesh.castShadow = true;
  carShell.add(cabinMesh);

  const fenderGeo = new THREE.SphereGeometry(1, 18, 8);
  [
    { x: -1.06, z: 1.42, sx: 0.34, sz: 0.62 },
    { x: 1.06, z: 1.42, sx: 0.34, sz: 0.62 },
    { x: -1.16, z: -1.48, sx: 0.4, sz: 0.68 },
    { x: 1.16, z: -1.48, sx: 0.4, sz: 0.68 }
  ].forEach(f => {
    const fender = new THREE.Mesh(fenderGeo, bodyMat);
    fender.position.set(f.x, 0.52, f.z);
    fender.scale.set(f.sx, 0.22, f.sz);
    fender.castShadow = true;
    fender.receiveShadow = true;
    carShell.add(fender);
  });

  const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.07, 0.42), carbonMat);
  splitter.position.set(0, 0.2, 2.58);
  splitter.castShadow = true;
  carShell.add(splitter);

  const spoilerBlade = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.1, 0.22), carbonMat);
  spoilerBlade.position.set(0, 1.08, -2.34);
  spoilerBlade.castShadow = true;
  carShell.add(spoilerBlade);

  const rearPlate = new THREE.Mesh(
    new THREE.BoxGeometry(0.58, 0.11, 0.05),
    new THREE.MeshBasicMaterial({ color: 0xc9feff, toneMapped: false })
  );
  rearPlate.position.set(0, 0.42, -2.86);
  carShell.add(rearPlate);

  const rearFascia = new THREE.Mesh(rearPanelGeometry(1.42, 1.08, 0.38, 0.7, -2.82), rearPanelMat);
  carShell.add(rearFascia);

  const rearDeckStripe = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.045, 0.04), amberGlowMat);
  rearDeckStripe.position.set(0, 0.76, -2.84);
  carShell.add(rearDeckStripe);

  const rearDiffuser = new THREE.Mesh(new THREE.BoxGeometry(1.28, 0.12, 0.12), carbonMat);
  rearDiffuser.position.set(0, 0.24, -2.86);
  rearDiffuser.castShadow = true;
  carShell.add(rearDiffuser);

  const spoilerPostGeo = new THREE.BoxGeometry(0.08, 0.42, 0.08);
  [-0.72, 0.72].forEach(x => {
    const post = new THREE.Mesh(spoilerPostGeo, carbonMat);
    post.position.set(x, 0.82, -2.28);
    post.castShadow = true;
    carShell.add(post);
  });

  const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.46, 24);
  wheelGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.27, 0.27, 0.49, 12);
  rimGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x05070b, roughness: 0.72, metalness: 0.12 });
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0xc6f7ff,
    roughness: 0.2,
    metalness: 0.8,
    emissive: 0x123d48,
    emissiveIntensity: 0.6
  });

  const wheelOffsets = [
    { x: -1.16, y: 0.34, z: 1.45 },
    { x: 1.16, y: 0.34, z: 1.45 },
    { x: -1.16, y: 0.34, z: -1.47 },
    { x: 1.16, y: 0.34, z: -1.47 }
  ];

  wheelOffsets.forEach(offset => {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.set(offset.x, offset.y, offset.z);
    wheel.castShadow = true;
    wheel.receiveShadow = true;
    carGroup.add(wheel);
    wheels.push(wheel);

    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.copy(wheel.position);
    rim.castShadow = true;
    carGroup.add(rim);
  });

  const headlightGeo = new THREE.BoxGeometry(0.44, 0.12, 0.08);
  const headlightMat = new THREE.MeshBasicMaterial({ color: 0xdffcff });
  [-0.62, 0.62].forEach(x => {
    const lamp = new THREE.Mesh(headlightGeo, headlightMat);
    lamp.position.set(x, 0.61, 2.43);
    carShell.add(lamp);

    const spot = new THREE.SpotLight(0xfff2d6, 2.6, 70, Math.PI / 7.5, 0.55, 1.6);
    spot.position.set(x, 0.65, 2.52);
    spot.target.position.set(x * 0.55, -0.2, 12.5);
    spot.castShadow = true;
    spot.shadow.mapSize.set(512, 512);
    carGroup.add(spot);
    carGroup.add(spot.target);
    carVisuals.headlights.push(spot);
  });

  const tailGeo = new THREE.BoxGeometry(0.42, 0.1, 0.055);
  [-0.48, 0.48].forEach(x => {
    const tailMat = new THREE.MeshBasicMaterial({ color: 0xff2d1b });
    const tail = new THREE.Mesh(tailGeo, tailMat);
    tail.position.set(x, 0.61, -2.87);
    carShell.add(tail);
    carVisuals.tailMaterials.push(tailMat);
  });

  const tailBarMat = new THREE.MeshBasicMaterial({ color: 0xff2517 });
  const tailBar = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.032, 0.055), tailBarMat);
  tailBar.position.set(0, 0.71, -2.88);
  carShell.add(tailBar);
  carVisuals.tailMaterials.push(tailBarMat);

  const underglow = new THREE.PointLight(0x27d8ff, 0.72, 5.2, 2.1);
  underglow.position.set(0, 0.22, 0);
  carGroup.add(underglow);
  carVisuals.underglow = underglow;

  const fillLight = new THREE.PointLight(0xd8fbff, 1.75, 7.2, 1.7);
  fillLight.position.set(0, 2.2, -3.2);
  carGroup.add(fillLight);
  carVisuals.fillLight = fillLight;
}

// -------------------------------------------------------------
// Interactive UI Handlers
// -------------------------------------------------------------
function setupButtonListeners() {
  if (uiController.btnStart) uiController.btnStart.addEventListener('click', startGame);
  if (uiController.btnRestart) uiController.btnRestart.addEventListener('click', restartGame);

  uiController.btnMuteMusic?.addEventListener('click', () => {
    if (audioSynthManager) {
      const active = audioSynthManager.toggleMusic();
      uiController.btnMuteMusic.classList.toggle('active', active);
      uiController.btnMuteMusic.classList.toggle('muted', !active);
      uiController.btnMuteMusic.innerHTML = `<span class="icon-label">🎵</span> MUSIC: ${active ? 'ON' : 'OFF'}`;
    }
  });
  
  uiController.btnMuteSFX?.addEventListener('click', () => {
    if (audioSynthManager) {
      const active = audioSynthManager.toggleSFX();
      uiController.btnMuteSFX.classList.toggle('active', active);
      uiController.btnMuteSFX.classList.toggle('muted', !active);
      uiController.btnMuteSFX.innerHTML = `<span class="icon-label">🔊</span> SFX: ${active ? 'ON' : 'OFF'}`;
    }
  });
}

function startGame() {
  if (runStarted && gameState === 'PLAYING') return;

  // Initialize procedural audio context on user interaction
  if (audioSynthManager) {
    audioSynthManager.init();
  }

  uiController.hideMenu();
  gameState = 'PLAYING';
  runStarted = true;
  isFirstDriveFrame = true;
  score = 0;
  distanceTraveled = 0;
}

function restartGame() {
  // Reset audio loops
  if (audioSynthManager) {
    audioSynthManager.clear();
    audioSynthManager = new AudioSynthManager();
  }

  uiController.hideGameOver();
  // Reset physics state
  carPhysics = new CarPhysics();
  
  // Re-init starting positions
  gameState = 'PLAYING';
  runStarted = false;
  isFirstDriveFrame = true;
  score = 0;
  distanceTraveled = 0;
}

// -------------------------------------------------------------
// Game Logic Frame Update Loop
// -------------------------------------------------------------
function animate(time) {
  requestAnimationFrame(animate);

  const dt = Math.min((time - lastTime) / 1000, 0.1);
  lastTime = time;

  // FPS estimation
  frameCount++;
  fpsTimer += dt;
  if (fpsTimer >= 1.0) {
    currentFPS = frameCount / fpsTimer;
    frameCount = 0;
    fpsTimer = 0;
  }

  // Get current inputs
  const inputs = inputController.inputs;

  if (!runStarted && gameState === 'PLAYING' && inputs.throttle > 0) {
    startGame();
  }

  // Manual reset key
  if (inputs.reset && (gameState === 'PLAYING' || gameState === 'CRASHED')) {
    restartGame();
  }

  if (gameState === 'PLAYING') {
    // 1. Update Physics
    carPhysics.update(inputs, dt);

    // Lane assist keeps W-only driving scenic and non-twitchy while preserving steering agency.
    if (Math.abs(carPhysics.speed) > 1.0) {
      const roadX = getRoadX(carPhysics.position.z);
      const roadAngle = getRoadAngle(carPhysics.position.z);
      const isSteering = Math.abs(inputs.steering) > 0.05;
      const centerRate = isSteering ? 0.75 : 2.6;
      const headingRate = isSteering ? 0.35 : 2.35;
      const laneT = Math.min(1, centerRate * dt);
      const headingT = Math.min(1, headingRate * dt);

      carPhysics.position.x += (roadX - carPhysics.position.x) * laneT;
      carPhysics.heading += shortestAngleDelta(roadAngle, carPhysics.heading) * headingT;
    }

    // Record starting coordinates on first frame of run for telemetry.
    if (isFirstDriveFrame && Math.abs(carPhysics.speed) > 0.1) {
      startingX = carPhysics.position.x;
      startingZ = carPhysics.position.z;
      startingHeading = carPhysics.heading;
      isFirstDriveFrame = false;
    }

    // 2. Snap Car visually to Terrain (purely decorative)
    const wx = carPhysics.position.x;
    const wz = carPhysics.position.z;
    const wy = getTerrainHeight(wx, wz);
    
    carGroup.position.set(wx, wy, wz);
    if (skyDetails) {
      skyDetails.position.set(wx, 0, wz);
    }

    // Rotate car wheels visually based on forward speed
    wheels.forEach(w => {
      w.rotation.x -= carPhysics.speed * 0.15 * dt;
    });

    // Pitch and Roll calculation based on finite differences on the terrain
    const heading = carPhysics.heading;
    const fwdX = Math.sin(heading);
    const fwdZ = Math.cos(heading);
    const latX = Math.cos(heading);
    const latZ = -Math.sin(heading);

    const sampleOffset = 1.5;
    const frontY = getTerrainHeight(wx + fwdX * sampleOffset, wz + fwdZ * sampleOffset);
    const backY = getTerrainHeight(wx - fwdX * sampleOffset, wz - fwdZ * sampleOffset);
    const leftY = getTerrainHeight(wx - latX * sampleOffset, wz - latZ * sampleOffset);
    const rightY = getTerrainHeight(wx + latX * sampleOffset, wz + latZ * sampleOffset);

    const pitch = Math.atan2(frontY - backY, sampleOffset * 2.0);
    const roll = Math.atan2(leftY - rightY, sampleOffset * 2.0);

    // Apply rotations
    carGroup.rotation.set(0, 0, 0); // reset
    carGroup.rotation.y = carPhysics.heading;
    carGroup.rotation.x = pitch;
    // Cosmetic body lean into turns
    const leanAmount = -carPhysics.localLatVel * 0.012;
    carGroup.rotation.z = THREE.MathUtils.clamp(roll + leanAmount, -0.2, 0.2);

    // Ensure world matrix is updated before reading wheel positions
    carGroup.updateMatrixWorld(true);

    // 3. Update Colliders
    worldManager.updateColliders(dt);

    // Bounding volumes collision checks
    const playerRadius = 1.0;
    worldManager.colliders.forEach(c => {
      const dx = wx - c.position.x;
      const dy = wy - c.position.y;
      const dz = wz - c.position.z;
      const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

      // Collision trigger
      const collisionThreshold = c.radius + playerRadius - 0.2;
      if (dist < collisionThreshold) {
        triggerCrash();
      }

    });

    // 5. Update Endless Road Generation
    worldManager.update(wz);

    // 6. Update directional sun light position to follow car
    // Sun light follows car but maintains directional angle
    if (sunPosition) {
      dirLight.position.set(wx + sunPosition.x * 200, wy + sunPosition.y * 200, wz + sunPosition.z * 200);
    }
    dirLight.target = carGroup;

    // 7. Score Ticking: speed * time (proportional to distance traveled)
    if (carPhysics.speed > 1.0) {
      const dist = carPhysics.speed * dt;
      distanceTraveled += dist;
      score += dist * 0.08;
    }

    // Speed-based FOV (sense of velocity)
    const targetFOV = 60 + (Math.abs(carPhysics.speed) / 70) * 14;
    camera.fov += (targetFOV - camera.fov) * (1.0 - Math.exp(-3.0 * dt));
    camera.updateProjectionMatrix();

    // 8. Camera Follow System (Elastic Chase Camera)
    const camDist = 8.4;
    const camHeight = 3.45;

    // Ideal camera position behind the car relative to heading
    const targetCamX = wx - fwdX * camDist;
    const targetCamY = wy + camHeight;
    const targetCamZ = wz - fwdZ * camDist;

    // Smoothly interpolate camera position without overshoot on slow frames.
    const cameraLerp = 1.0 - Math.exp(-6.0 * dt);
    camera.position.x += (targetCamX - camera.position.x) * cameraLerp;
    camera.position.y += (targetCamY - camera.position.y) * cameraLerp;
    camera.position.z += (targetCamZ - camera.position.z) * cameraLerp;

    // Camera looks slightly ahead of the car
    const lookAtPos = new THREE.Vector3(wx + fwdX * 2.8, wy + 0.46, wz + fwdZ * 2.8);
    camera.lookAt(lookAtPos);

    // Apply Camera Shake on crash
    if (cameraShake > 0.01) {
      cameraShake *= 0.88; // decay
      camera.position.x += (Math.random() - 0.5) * cameraShake;
      camera.position.y += (Math.random() - 0.5) * cameraShake;
      camera.position.z += (Math.random() - 0.5) * cameraShake;
    }

    // 9. Calculate lateral offset from the starting axis.
    // Starting Vector: (startFwdX, startFwdZ) = (-sin(startingHeading), -cos(startingHeading))
    // Perpendicular Right Vector: (latFwdX, latFwdZ) = (-cos(startingHeading), sin(startingHeading))
    let lateralOffset = 0.0;
    if (!isFirstDriveFrame) {
      const dx = wx - startingX;
      const dz = wz - startingZ;
      const latFwdX = Math.cos(startingHeading);
      const latFwdZ = -Math.sin(startingHeading);
      // Project displacement onto lateral vector
      lateralOffset = dx * latFwdX + dz * latFwdZ;
    }

    // 10. Update HUD and Telemetry
    uiController.updateHUD(score, carPhysics.speed);
    uiController.updateTelemetry(carPhysics, lateralOffset, currentFPS);

    // 11. Update real-time synthesizer audio parameters (Layer 6)
    if (audioSynthManager) {
      const isCrashed = gameState === 'CRASHED';
      audioSynthManager.updateEngineSound(carPhysics.speed, isCrashed);
      audioSynthManager.updateWindSound(carPhysics.speed);
      audioSynthManager.updateRoadSound(carPhysics.speed);
    }

    const speedT = THREE.MathUtils.clamp(Math.abs(carPhysics.speed) / carPhysics.maxSpeed, 0, 1);
    carVisuals.headlights.forEach(light => {
      light.intensity = 1.8 + speedT * 2.8;
      light.distance = 45 + speedT * 35;
    });
    carVisuals.tailMaterials.forEach(mat => {
      mat.color.set(inputs.brake > 0 ? 0xff5a22 : 0xff2517);
    });
    if (carVisuals.underglow) {
      carVisuals.underglow.intensity = 0.45 + speedT * 0.45;
    }
    if (carVisuals.fillLight) {
      carVisuals.fillLight.intensity = 1.45 + speedT * 0.65;
    }

  } else {
    // Crash state: freeze the last camera composition and fade vehicle sounds.
    if (audioSynthManager) {
      audioSynthManager.updateEngineSound(0.0, true);
      audioSynthManager.updateWindSound(0.0);
      audioSynthManager.updateRoadSound(0.0);
    }
  }

  // Dynamic bloom bypass on low-end hardware
  if (currentFPS < 35 && useBloom && time > 6000) {
    useBloom = false;
    console.warn("FPS dropped below threshold. Disabling bloom pass to optimize game performance.");
  }

  // Render frame
  if (useBloom && composer) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

// -------------------------------------------------------------
// Resize Handler
// -------------------------------------------------------------
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) {
    composer.setSize(window.innerWidth, window.innerHeight);
  }
}

// Start Game Setup
init();

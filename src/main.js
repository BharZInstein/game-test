import * as THREE from 'three';
import { CarPhysics } from './physics.js';
import { InputController } from './input.js';
import {
  WorldManager,
  getTerrainHeight,
  getGroundHeight,
  getRoadX,
  getRoadAngle,
  getRoadGrade,
  ROAD_WIDTH,
  RAIL_OFFSET
} from './world.js';
import { UIController } from './ui.js';
import { AudioSynthManager } from './audio.js';

import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';
import {
  SparkSystem, SmokeSystem, SkidMarkSystem, makeRadialTexture,
  GodRaysShader, BirdFlock, StarField
} from './effects.js';

// -------------------------------------------------------------
// Global state
// -------------------------------------------------------------
let scene, camera, renderer;
let carPhysics, inputController, worldManager, uiController;
let carGroup;
let carModel = null;
let wheelNodes = { frontLeft: null, frontRight: null, backLeft: null, backRight: null };
let carVisuals = {
  headlights: [],
  brakeLight: null,
  blobShadow: null,
  beamGlow: null
};
let dirLight;

const CAR_MODEL_URL = '/models/race-future.glb';
const CAR_SCALE = 1.8;
const WHEEL_RADIUS = 0.3 * CAR_SCALE;
// Wheel contact points in car-local space (from the race-future GLB, scaled)
const WHEEL_POINTS = {
  front: 0.59 * CAR_SCALE,
  back: -0.93 * CAR_SCALE,
  track: 0.3 * CAR_SCALE
};
const CAR_HALF_WIDTH = 0.6 * CAR_SCALE;

let composer, bloomPass;
let useBloom = true;
let audioSynthManager;
let sky, sunPosition;
let skyDetails;

let gameState = 'PLAYING';
let runStarted = false;

let distanceTraveled = 0; // furthest forward progress, meters
let maxZ = 0;

let startingX = 0;
let startingZ = 0;
let startingHeading = 0;
let isFirstDriveFrame = true;

let cameraShake = 0.0;
let isScrapingRail = false;
let wasScrapingRail = false;
let steerIntoRailTime = 0;
let railPeakImpact = 0;
let railContactGrace = 0;

// Suspension smoothing state
let susY = 0;
let susPitch = 0;
let susRoll = 0;
let steerVisual = 0;
let camYaw = 0;
const wheelTravel = { fl: 0, fr: 0, bl: 0, br: 0 };

// Effects
let sparks, smoke, skidMarks;
let sunFlareAnchor;
let colorGradePass;
let godRaysPass;
let birds, stars;

// Day/night cycle
const DAY_CYCLE_SEC = 480;               // full cycle at daytime pace (nights run faster)
const SUN_THETA = THREE.MathUtils.degToRad(215);
const DAY_PHASE0 = Math.PI - Math.asin(11 / 26); // start at 11° elevation, descending: golden hour first
let dayPhase = 0;
let sunElev = 11;
let ambientLight, hemiLight;
let headlightBoost = 1.0;
const lightDir = new THREE.Vector3();    // current key light direction (sun or moon)
let cloudMats = null;
const FOG_NIGHT = new THREE.Color(0x0e1724);
const FOG_DUSK = new THREE.Color(0xe4a16f);
const FOG_DAY = new THREE.Color(0xa9c6da);
const _sunScreen = new THREE.Vector3();
const _camDir = new THREE.Vector3();

let lastTime = 0;
let frameCount = 0;
let fpsTimer = 0;
let currentFPS = 60;

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function triggerCrash() {
  if (gameState !== 'PLAYING') return;
  gameState = 'CRASHED';
  cameraShake = 2.8;

  uiController.flashCrash();
  uiController.saveHighScore(distanceTraveled);
  uiController.showGameOver(distanceTraveled);

  if (audioSynthManager) {
    audioSynthManager.playCrashSFX();
  }

  carPhysics.speed = 0.0;
  carPhysics.localLatVel = 0.0;
}

function shortestAngleDelta(target, current) {
  return Math.atan2(Math.sin(target - current), Math.cos(target - current));
}

const smooth01 = (a, b, x) => THREE.MathUtils.smoothstep(x, a, b);

// -------------------------------------------------------------
// Day/night cycle: drives the sun, moonlight, fog, clouds, stars,
// birds, lens flare, god rays and headlight strength.
// -------------------------------------------------------------
function updateDayNight(dt) {
  // Nights tick faster so the game spends most of its time in golden light
  const paceScale = sunElev < 0 ? 3.1 : 1.0;
  dayPhase = (dayPhase + (dt / DAY_CYCLE_SEC) * paceScale) % 1;
  sunElev = 26 * Math.sin(dayPhase * Math.PI * 2 + DAY_PHASE0);

  const e = sunElev;
  const dayF = smooth01(-3, 12, e);   // 0 night → 1 day
  const nightF = 1 - smooth01(-8, 0, e); // 1 deep night → 0 daylight

  // Sun position feeds the sky shader, flare, and god rays
  const phi = THREE.MathUtils.degToRad(90 - Math.max(e, -30));
  sunPosition.setFromSphericalCoords(1, phi, SUN_THETA);
  sky.material.uniforms['sunPosition'].value.copy(sunPosition);

  // Key light: sun by day, moon by night (opposite azimuth, cool blue)
  const sunI = 1.45 * smooth01(-4, 10, e);
  const moonI = 0.3 * smooth01(2, 12, -e);
  if (sunI >= moonI) {
    dirLight.intensity = Math.max(sunI, 0.02);
    dirLight.color.setHex(0xffb46b).lerp(new THREE.Color(0xfff0dc), smooth01(5, 22, e));
    lightDir.copy(sunPosition);
  } else {
    dirLight.intensity = moonI;
    dirLight.color.setHex(0x93aed6);
    lightDir.set(-sunPosition.x, Math.abs(sunPosition.y) + 0.35, -sunPosition.z).normalize();
  }

  ambientLight.intensity = 0.19 + 0.43 * dayF;
  hemiLight.intensity = 0.3 + 0.75 * dayF;
  scene.environmentIntensity = 0.08 + 0.62 * dayF;

  // Fog: night blue → day haze, pulled warm around the golden hour
  const duskW = Math.exp(-((e - 4) * (e - 4)) / 55);
  scene.fog.color.copy(FOG_NIGHT).lerp(FOG_DAY, smooth01(-6, 16, e)).lerp(FOG_DUSK, duskW * 0.85);

  // Clouds dim to silhouettes at night
  if (cloudMats) {
    Object.values(cloudMats).forEach(c => {
      c.mat.color.copy(c.base).lerp(c.night, nightF);
      c.mat.opacity = c.baseOpacity * (0.4 + 0.6 * dayF);
    });
  }

  if (stars) stars.update(camera.position, nightF);
  if (birds) {
    birds.setVisible(e > 0.5);
    if (e > 0.5) birds.update(dt, carPhysics.position.x, carPhysics.position.z);
  }
  if (sunFlareAnchor) sunFlareAnchor.visible = e > 1.5;

  // Headlights matter at night
  headlightBoost = 0.55 + (1 - dayF) * 1.8;

  // God rays: only when the sun is up AND actually on screen
  if (godRaysPass) {
    let intensity = 0;
    camera.getWorldDirection(_camDir);
    if (e > 0.5 && _camDir.dot(sunPosition) > 0.1) {
      _sunScreen.copy(camera.position).addScaledVector(sunPosition, 1000).project(camera);
      const sx = _sunScreen.x * 0.5 + 0.5;
      const sy = _sunScreen.y * 0.5 + 0.5;
      const edge = smooth01(-0.35, 0.05, sx) * smooth01(-0.35, 0.05, 1 - sx) *
                   smooth01(-0.35, 0.05, sy) * smooth01(-0.35, 0.05, 1 - sy);
      intensity = edge * smooth01(0.5, 5, e) * 0.85;
      godRaysPass.uniforms.uSunScreen.value.set(sx, sy);
    }
    godRaysPass.uniforms.uIntensity.value = intensity;
  }
}

// -------------------------------------------------------------
// Init
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

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xe4a16f, 0.00145);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.getElementById('canvas-container').appendChild(renderer.domElement);

  // Post-processing
  const renderPass = new RenderPass(scene, camera);
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.26,
    0.3,
    0.985
  );

  const ColorGradeShader = {
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uSpeed: { value: 0 } // 0..1, drives chromatic aberration
    },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform float uSpeed;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      }

      void main() {
        vec2 fromCenter = vUv - 0.5;

        // Chromatic aberration, stronger at the edges and with speed
        float ca = (0.0004 + uSpeed * 0.0014) * smoothstep(0.22, 0.75, length(fromCenter));
        vec4 color;
        color.r = texture2D(tDiffuse, vUv + fromCenter * ca).r;
        color.g = texture2D(tDiffuse, vUv).g;
        color.b = texture2D(tDiffuse, vUv - fromCenter * ca).b;
        color.a = 1.0;

        // Warm-lean grade + saturation
        color.rgb = pow(color.rgb, vec3(0.94, 0.98, 1.04));
        float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
        color.rgb = mix(vec3(gray), color.rgb, 1.15);

        // Vignette
        float dist = length(fromCenter);
        color.rgb *= 1.0 - smoothstep(0.4, 0.9, dist) * 0.32;

        // Fine animated film grain
        float grain = hash(vUv * vec2(1613.0, 947.0) + fract(uTime) * 43.7) - 0.5;
        color.rgb += grain * 0.028;

        gl_FragColor = color;
      }
    `
  };
  colorGradePass = new ShaderPass(ColorGradeShader);

  godRaysPass = new ShaderPass(GodRaysShader);

  composer = new EffectComposer(renderer);
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(godRaysPass);
  composer.addPass(colorGradePass);

  // Lighting
  ambientLight = new THREE.AmbientLight(0xfff4e4, 0.62);
  scene.add(ambientLight);

  dirLight = new THREE.DirectionalLight(0xffb46b, 1.45);
  dirLight.position.set(100, 80, 200);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 500;
  dirLight.shadow.bias = -0.0004;

  const d = 150;
  dirLight.shadow.camera.left = -d;
  dirLight.shadow.camera.right = d;
  dirLight.shadow.camera.top = d;
  dirLight.shadow.camera.bottom = -d;
  scene.add(dirLight);

  hemiLight = new THREE.HemisphereLight(0x9fd2ff, 0xffa86c, 1.05);
  hemiLight.position.set(0, 50, 0);
  scene.add(hemiLight);

  // Atmospheric sky
  sky = new Sky();
  sky.scale.setScalar(50000);
  scene.add(sky);

  const skyUniforms = sky.material.uniforms;
  skyUniforms['turbidity'].value = 3.2;
  skyUniforms['rayleigh'].value = 1.25;
  skyUniforms['mieCoefficient'].value = 0.0016;
  skyUniforms['mieDirectionalG'].value = 0.7;

  const phi = THREE.MathUtils.degToRad(90 - 11);
  sunPosition = new THREE.Vector3().setFromSphericalCoords(1, phi, SUN_THETA);
  skyUniforms['sunPosition'].value.copy(sunPosition);

  lightDir.copy(sunPosition);
  dirLight.position.copy(sunPosition).multiplyScalar(200);

  // Environment map from the sky, so the car paint actually reflects the sunset.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(50000);
  envSky.material.uniforms['turbidity'].value = 3.2;
  envSky.material.uniforms['rayleigh'].value = 1.25;
  envSky.material.uniforms['mieCoefficient'].value = 0.0016;
  envSky.material.uniforms['mieDirectionalG'].value = 0.7;
  envSky.material.uniforms['sunPosition'].value.copy(sunPosition);
  envScene.add(envSky);
  const envRT = pmrem.fromScene(envScene, 0.02);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.7;
  pmrem.dispose();

  createSkyDetails();

  // Sun lens flare — anchored far along the sun direction, repositioned per frame
  sunFlareAnchor = new THREE.Object3D();
  scene.add(sunFlareAnchor);
  const flareMain = makeRadialTexture(256, [
    [0, 'rgba(255,240,220,1)'],
    [0.25, 'rgba(255,190,120,0.5)'],
    [0.6, 'rgba(255,150,80,0.12)'],
    [1, 'rgba(255,140,70,0)']
  ]);
  const flareGhost = makeRadialTexture(64, [
    [0, 'rgba(255,210,160,0.0)'],
    [0.7, 'rgba(255,200,150,0.28)'],
    [0.85, 'rgba(255,190,140,0.1)'],
    [1, 'rgba(255,180,130,0)']
  ]);
  const lensflare = new Lensflare();
  lensflare.addElement(new LensflareElement(flareMain, 420, 0));
  lensflare.addElement(new LensflareElement(flareGhost, 60, 0.35));
  lensflare.addElement(new LensflareElement(flareGhost, 110, 0.55));
  lensflare.addElement(new LensflareElement(flareGhost, 45, 0.8));
  lensflare.addElement(new LensflareElement(flareGhost, 150, 1.05));
  sunFlareAnchor.add(lensflare);

  // Particle & mark systems
  sparks = new SparkSystem(scene);
  smoke = new SmokeSystem(scene);
  skidMarks = new SkidMarkSystem(scene);

  // Wildlife & night sky
  birds = new BirdFlock(scene);
  stars = new StarField(scene);

  carPhysics = new CarPhysics();
  inputController = new InputController();
  worldManager = new WorldManager(scene);
  uiController = new UIController();

  audioSynthManager = new AudioSynthManager();
  audioSynthManager.onTrackChange = (title) => uiController.showNowPlaying(title);

  createCarGroup();
  loadCarModel();

  setupButtonListeners();
  window.addEventListener('resize', onWindowResize);

  // Audio must start on the FIRST user interaction of any kind — browsers
  // (especially Firefox) don't always grant audio on keypresses alone.
  const kickAudio = () => {
    if (audioSynthManager) {
      audioSynthManager.init();
      audioSynthManager.resume();
    }
  };
  window.addEventListener('pointerdown', kickAudio);
  window.addEventListener('keydown', kickAudio);

  // Event-based restart so a quick R tap can't fall between polled frames
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && (gameState === 'PLAYING' || gameState === 'CRASHED')) {
      restartGame();
    }
  });

  lastTime = performance.now();
  requestAnimationFrame(animate);
}

// -------------------------------------------------------------
// Sky details (clouds)
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
  cloudMats = {
    lit: { mat: cloudMat, base: cloudMat.color.clone(), night: new THREE.Color(0x232c3a), baseOpacity: 0.38 },
    shadow: { mat: shadowCloudMat, base: shadowCloudMat.color.clone(), night: new THREE.Color(0x161d28), baseOpacity: 0.18 }
  };
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

// -------------------------------------------------------------
// Car: real glTF model (Kenney Car Kit, CC0) + lights + blob shadow
// -------------------------------------------------------------
function createCarGroup() {
  carGroup = new THREE.Group();
  carGroup.rotation.order = 'YXZ';
  scene.add(carGroup);

  // Soft blob shadow to ground the car (in addition to the shadow map)
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = 128;
  shadowCanvas.height = 128;
  const sctx = shadowCanvas.getContext('2d');
  const grad = sctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.42)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.22)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, 128, 128);

  const shadowTex = new THREE.CanvasTexture(shadowCanvas);
  const blobShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4 * CAR_SCALE, 4.2 * CAR_SCALE),
    new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2
    })
  );
  blobShadow.rotation.x = -Math.PI / 2;
  blobShadow.position.y = 0.06;
  blobShadow.renderOrder = 1;
  carGroup.add(blobShadow);
  carVisuals.blobShadow = blobShadow;

  // Headlights (physical units — needs serious candela to read at night)
  [-0.38 * CAR_SCALE, 0.38 * CAR_SCALE].forEach(x => {
    const spot = new THREE.SpotLight(0xfff2d6, 40, 80, Math.PI / 6.5, 0.6, 1.4);
    spot.position.set(x, 0.42 * CAR_SCALE, 1.3 * CAR_SCALE);
    spot.target.position.set(x * 0.55, -0.2, 13.5);
    carGroup.add(spot);
    carGroup.add(spot.target);
    carVisuals.headlights.push(spot);
  });

  // Fake projected headlight pool — additive quad that fades in at night.
  // Physical spotlight falloff alone never reads on the road at distance.
  const beamTex = makeRadialTexture(128, [
    [0, 'rgba(255,240,200,0.55)'],
    [0.5, 'rgba(255,225,170,0.22)'],
    [1, 'rgba(255,210,150,0)']
  ]);
  const beamGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(6.5, 15),
    new THREE.MeshBasicMaterial({
      map: beamTex,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3
    })
  );
  beamGlow.rotation.order = 'YXZ';
  beamGlow.renderOrder = 2;
  scene.add(beamGlow); // positioned on the road surface every frame, not on the car
  carVisuals.beamGlow = beamGlow;

  // Brake glow — sits behind the bumper so it tints the road, not the bodywork
  const brakeLight = new THREE.PointLight(0xff2517, 0.0, 5.0, 2.0);
  brakeLight.position.set(0, 0.4 * CAR_SCALE, -1.55 * CAR_SCALE);
  carGroup.add(brakeLight);
  carVisuals.brakeLight = brakeLight;

}

function loadCarModel() {
  const loader = new GLTFLoader();
  loader.load(CAR_MODEL_URL, (gltf) => {
    carModel = gltf.scene;
    carModel.scale.setScalar(CAR_SCALE);

    carModel.traverse(node => {
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        const old = node.material;
        // Upgrade the flat Kenney material to clearcoated paint that picks up the sky.
        node.material = new THREE.MeshPhysicalMaterial({
          map: old.map || null,
          // Darken the albedo so sunlit whites stay below the bloom threshold
          color: new THREE.Color(0xb0b0b0),
          roughness: 0.5,
          metalness: 0.05,
          clearcoat: 0.45,
          clearcoatRoughness: 0.4,
          envMapIntensity: 0.18
        });
      }
    });

    wheelNodes.frontLeft = carModel.getObjectByName('wheel-front-left');
    wheelNodes.frontRight = carModel.getObjectByName('wheel-front-right');
    wheelNodes.backLeft = carModel.getObjectByName('wheel-back-left');
    wheelNodes.backRight = carModel.getObjectByName('wheel-back-right');
    Object.values(wheelNodes).forEach(w => {
      if (w) w.rotation.order = 'YXZ';
    });

    carGroup.add(carModel);
  }, undefined, (err) => {
    console.error('Failed to load car model:', err);
  });
}

// -------------------------------------------------------------
// UI wiring
// -------------------------------------------------------------
function setupButtonListeners() {
  if (uiController.btnStart) uiController.btnStart.addEventListener('click', startGame);
  if (uiController.btnRestart) uiController.btnRestart.addEventListener('click', restartGame);

  uiController.btnMuteMusic?.addEventListener('click', () => {
    if (audioSynthManager) {
      const active = audioSynthManager.toggleMusic();
      uiController.btnMuteMusic.classList.toggle('muted', !active);
    }
  });

  uiController.btnMuteSFX?.addEventListener('click', () => {
    if (audioSynthManager) {
      const active = audioSynthManager.toggleSFX();
      uiController.btnMuteSFX.classList.toggle('muted', !active);
    }
  });
}

function startGame() {
  if (runStarted && gameState === 'PLAYING') return;

  if (audioSynthManager) {
    audioSynthManager.init();
    audioSynthManager.resume();
  }

  uiController.hideMenu();
  gameState = 'PLAYING';
  runStarted = true;
  isFirstDriveFrame = true;
  distanceTraveled = 0;
  maxZ = 0;
}

function restartGame() {
  uiController.hideGameOver();
  carPhysics = new CarPhysics();

  susY = 0;
  susPitch = 0;
  susRoll = 0;
  camYaw = 0;
  cameraShake = 0;

  // Rebuild the world window around the start — without this the car
  // respawns onto bare terrain because the chunks are still miles away.
  worldManager.update(0);

  camera.position.set(0, 3.5, -8.5);

  gameState = 'PLAYING';
  runStarted = false;
  isFirstDriveFrame = true;
  distanceTraveled = 0;
  maxZ = 0;
}

// -------------------------------------------------------------
// Frame loop
// -------------------------------------------------------------
function animate(time) {
  requestAnimationFrame(animate);

  const dt = Math.min((time - lastTime) / 1000, 0.1);
  lastTime = time;

  frameCount++;
  fpsTimer += dt;
  if (fpsTimer >= 1.0) {
    currentFPS = frameCount / fpsTimer;
    frameCount = 0;
    fpsTimer = 0;
  }

  const inputs = inputController.inputs;

  if (!runStarted && gameState === 'PLAYING' && inputs.throttle > 0) {
    startGame();
  }

  if (gameState === 'PLAYING') {
    // --- Surface conditions feed the physics ---
    const preZ = carPhysics.position.z;
    const roadXAtCar = getRoadX(preZ);
    const lateralFromCenter = carPhysics.position.x - roadXAtCar;
    carPhysics.surfaceGrip = Math.abs(lateralFromCenter) > ROAD_WIDTH * 0.5 ? 0.72 : 1.0;
    carPhysics.grade = getRoadGrade(preZ) * Math.cos(carPhysics.heading);

    // --- Physics step ---
    carPhysics.update(inputs, dt);

    // --- Guardrails are real: clamp the car between them ---
    isScrapingRail = false;
    {
      const z = carPhysics.position.z;
      const roadX = getRoadX(z);
      const roadAngle = getRoadAngle(z);
      const railLimit = RAIL_OFFSET - CAR_HALF_WIDTH + 0.15;
      const offset = carPhysics.position.x - roadX;

      if (Math.abs(offset) > railLimit) {
        const side = Math.sign(offset);
        carPhysics.position.x = roadX + side * railLimit;

        // Nearest road direction (forward OR reverse), so U-turned driving works too
        let roadDir = roadAngle;
        if (Math.abs(shortestAngleDelta(roadAngle, carPhysics.heading)) > Math.PI / 2) {
          roadDir = roadAngle + Math.PI;
        }

        // Impact severity from how hard the car is angled into the rail
        const angleIntoRail = shortestAngleDelta(carPhysics.heading, roadDir) * side * Math.sign(carPhysics.speed || 1);
        const impact = Math.abs(carPhysics.speed) * Math.max(0, Math.sin(Math.abs(angleIntoRail)));

        // Crashing requires INTENT: a hard hit (peak impact of this contact)
        // while continuously steering into the rail. A swerve that ends at
        // the rail, or a gentle sustained grind, just scrapes.
        railPeakImpact = Math.max(railPeakImpact, impact);
        railContactGrace = 0.35;
        if (Math.sign(inputs.steering) === side && Math.abs(inputs.steering) > 0.05) {
          steerIntoRailTime += dt;
        } else {
          steerIntoRailTime = 0;
        }

        if (railPeakImpact > 30 && steerIntoRailTime > 0.45) {
          triggerCrash();
        } else {
          isScrapingRail = true;
          // Scrub speed, kill sideways momentum, deflect heading back along the road
          carPhysics.speed *= Math.max(0, 1 - (0.25 + impact * 0.05) * dt * 4);
          carPhysics.localLatVel *= Math.exp(-10 * dt);
          carPhysics.heading += shortestAngleDelta(roadDir, carPhysics.heading) * Math.min(1, 4.5 * dt);
          // Nudge back toward the lane so the car peels off the rail instead of grinding forever
          carPhysics.position.x += (roadX - carPhysics.position.x) * Math.min(1, 1.4 * dt);

          if (!wasScrapingRail) {
            cameraShake = Math.min(1.2, 0.25 + impact * 0.06);
            if (audioSynthManager) audioSynthManager.playRailHitSFX();
          }
        }
      } else {
        // The peel-off nudge makes contact flicker frame to frame, so only
        // reset the crash-intent tracking after a short grace period.
        railContactGrace -= dt;
        if (railContactGrace <= 0) {
          steerIntoRailTime = 0;
          railPeakImpact = 0;
        }
      }
    }
    wasScrapingRail = isScrapingRail;

    // Gentle lane assist: only when cruising hands-off AND roughly road-aligned.
    // Steering or committing to a big angle (e.g. a U-turn) disables it entirely.
    if (Math.abs(carPhysics.speed) > 1.0 && !isScrapingRail && Math.abs(inputs.steering) < 0.05) {
      const roadX = getRoadX(carPhysics.position.z);
      const roadAngle = getRoadAngle(carPhysics.position.z);

      let roadDir = roadAngle;
      let diff = shortestAngleDelta(roadAngle, carPhysics.heading);
      if (Math.abs(diff) > Math.PI / 2) {
        roadDir = roadAngle + Math.PI;
        diff = shortestAngleDelta(roadDir, carPhysics.heading);
      }

      if (Math.abs(diff) < 1.0) {
        const laneT = Math.min(1, 2.6 * dt);
        const headingT = Math.min(1, 2.4 * dt);
        carPhysics.position.x += (roadX - carPhysics.position.x) * laneT;
        carPhysics.heading += diff * headingT;
      }
    }

    if (isFirstDriveFrame && Math.abs(carPhysics.speed) > 0.1) {
      startingX = carPhysics.position.x;
      startingZ = carPhysics.position.z;
      startingHeading = carPhysics.heading;
      isFirstDriveFrame = false;
    }

    // --- Per-wheel ground contact + suspension ---
    const wx = carPhysics.position.x;
    const wz = carPhysics.position.z;
    const heading = carPhysics.heading;
    const fwdX = Math.sin(heading);
    const fwdZ = Math.cos(heading);
    const latX = Math.cos(heading);
    const latZ = -Math.sin(heading);

    const wheelGround = (fz, lx) => getGroundHeight(
      wx + fwdX * fz + latX * lx,
      wz + fwdZ * fz + latZ * lx
    );

    const gFL = wheelGround(WHEEL_POINTS.front, -WHEEL_POINTS.track);
    const gFR = wheelGround(WHEEL_POINTS.front, WHEEL_POINTS.track);
    const gBL = wheelGround(WHEEL_POINTS.back, -WHEEL_POINTS.track);
    const gBR = wheelGround(WHEEL_POINTS.back, WHEEL_POINTS.track);

    const frontY = (gFL + gFR) * 0.5;
    const backY = (gBL + gBR) * 0.5;
    const leftY = (gFL + gBL) * 0.5;
    const rightY = (gFR + gBR) * 0.5;

    const wheelbase = WHEEL_POINTS.front - WHEEL_POINTS.back;
    const targetY = (frontY + backY) * 0.5;
    const targetPitch = -Math.atan2(frontY - backY, wheelbase);
    const targetRoll = Math.atan2(rightY - leftY, WHEEL_POINTS.track * 2);

    // Spring-smoothed suspension so crests/dips feel damped, not snapped
    const susLerp = 1.0 - Math.exp(-10.0 * dt);
    susY += (targetY - susY) * susLerp;
    susPitch += (targetPitch - susPitch) * susLerp;
    susRoll += (targetRoll - susRoll) * susLerp;

    // Hard floor: the body must never sink below the highest wheel contact.
    const hardMin = Math.max(gFL, gFR, gBL, gBR) - 0.32;
    if (susY < hardMin) susY = hardMin;

    carPhysics.position.y = susY;
    carGroup.position.set(wx, susY, wz);
    if (skyDetails) {
      skyDetails.position.set(wx, 0, wz);
    }

    // Body attitude: suspension pitch/roll plus a cosmetic lean into corners
    const lean = THREE.MathUtils.clamp(carPhysics.localLatVel * 0.014, -0.09, 0.09);
    carGroup.rotation.y = heading;
    carGroup.rotation.x = THREE.MathUtils.clamp(susPitch, -0.45, 0.45);
    carGroup.rotation.z = THREE.MathUtils.clamp(susRoll + lean, -0.3, 0.3);

    // --- Wheel animation: spin (capped so it doesn't strobe), front steer,
    // and per-wheel suspension travel so each tire hugs the ground ---
    const spinDelta = THREE.MathUtils.clamp((carPhysics.speed / WHEEL_RADIUS) * dt, -1.2, 1.2);
    const steerTarget = inputs.steering * 0.42;
    steerVisual += (steerTarget - steerVisual) * Math.min(1, 10 * dt);

    if (wheelNodes.frontLeft) {
      // Body-plane height at each wheel (small-angle) vs its actual ground height
      const planeAt = (fz, lx) => susY - susPitch * fz + susRoll * lx;
      const travelLerp = Math.min(1, 14 * dt);
      const setTravel = (key, node, ground, fz, lx) => {
        const target = THREE.MathUtils.clamp(ground - planeAt(fz, lx), -0.24, 0.18);
        wheelTravel[key] += (target - wheelTravel[key]) * travelLerp;
        node.position.y = 0.3 + wheelTravel[key] / CAR_SCALE;
      };
      setTravel('fl', wheelNodes.frontLeft, gFL, WHEEL_POINTS.front, -WHEEL_POINTS.track);
      setTravel('fr', wheelNodes.frontRight, gFR, WHEEL_POINTS.front, WHEEL_POINTS.track);
      setTravel('bl', wheelNodes.backLeft, gBL, WHEEL_POINTS.back, -WHEEL_POINTS.track);
      setTravel('br', wheelNodes.backRight, gBR, WHEEL_POINTS.back, WHEEL_POINTS.track);

      wheelNodes.frontLeft.rotation.y = steerVisual;
      wheelNodes.frontRight.rotation.y = steerVisual;
      wheelNodes.frontLeft.rotation.x += spinDelta;
      wheelNodes.frontRight.rotation.x += spinDelta;
      wheelNodes.backLeft.rotation.x += spinDelta;
      wheelNodes.backRight.rotation.x += spinDelta;
    }

    carGroup.updateMatrixWorld(true);

    // --- Ground effects: sparks on rail grind, smoke + skid marks on drift ---
    const drifting = Math.abs(carPhysics.localLatVel) > 2.6 && Math.abs(carPhysics.speed) > 8;
    const rearY = (gBL + gBR) * 0.5;

    if (isScrapingRail && Math.abs(carPhysics.speed) > 5) {
      const side = Math.sign(carPhysics.position.x - getRoadX(wz)) || 1;
      const cx = wx + latX * side * CAR_HALF_WIDTH;
      const cz = wz + latZ * side * CAR_HALF_WIDTH;
      const backVx = -fwdX * carPhysics.speed * 0.25;
      const backVz = -fwdZ * carPhysics.speed * 0.25;
      for (let s = 0; s < 3; s++) {
        sparks.spawn(
          cx, susY + 0.35 + Math.random() * 0.4, cz,
          backVx + (Math.random() - 0.5) * 3 + latX * side * 2,
          1.5 + Math.random() * 3.5,
          backVz + (Math.random() - 0.5) * 3 + latZ * side * 2
        );
      }
    }

    if (drifting || isScrapingRail) {
      [-1, 1].forEach((s, i) => {
        const bx = wx + fwdX * WHEEL_POINTS.back + latX * s * WHEEL_POINTS.track;
        const bz = wz + fwdZ * WHEEL_POINTS.back + latZ * s * WHEEL_POINTS.track;
        skidMarks.lay(i === 0 ? 'bl' : 'br', bx, rearY + 0.14, bz, heading);
        if (frameCount % 3 === i) {
          smoke.spawn(bx, rearY + 0.35, bz, -fwdX * 2, -fwdZ * 2);
        }
      });
    } else {
      skidMarks.release('bl');
      skidMarks.release('br');
    }

    // --- Colliders ---
    worldManager.updateColliders(dt);
    const playerRadius = 1.0;
    worldManager.colliders.forEach(c => {
      const dx = wx - c.position.x;
      const dy = susY - c.position.y;
      const dz = wz - c.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < c.radius + playerRadius - 0.2) {
        triggerCrash();
      }
    });

    // --- Endless world ---
    worldManager.update(wz);

    dirLight.position.set(wx + lightDir.x * 200, susY + Math.max(lightDir.y, 0.08) * 200, wz + lightDir.z * 200);
    dirLight.target = carGroup;

    // --- Distance: only forward progress counts ---
    if (wz > maxZ) {
      distanceTraveled += wz - maxZ;
      maxZ = wz;
    }

    // --- Camera: rigid chase rig. Only the yaw is smoothed, so the car
    // stays glued to the center of the frame instead of drifting off. ---
    const targetFOV = 60 + (Math.abs(carPhysics.speed) / 70) * 12;
    camera.fov += (targetFOV - camera.fov) * (1.0 - Math.exp(-3.0 * dt));
    camera.updateProjectionMatrix();

    const speedT01 = Math.min(1, Math.abs(carPhysics.speed) / 70);
    const camDist = 7.3 + speedT01 * 1.7;
    const camHeight = 2.9 + speedT01 * 0.45;

    camYaw += shortestAngleDelta(heading, camYaw) * (1.0 - Math.exp(-7.0 * dt));
    const camFx = Math.sin(camYaw);
    const camFz = Math.cos(camYaw);

    camera.position.set(
      wx - camFx * camDist,
      susY + camHeight,
      wz - camFz * camDist
    );

    // Never let the camera dip into a hill behind the car
    const camGround = getGroundHeight(camera.position.x, camera.position.z);
    if (camera.position.y < camGround + 1.4) {
      camera.position.y = camGround + 1.4;
    }

    camera.lookAt(wx + camFx * 3.0, susY + 0.9, wz + camFz * 3.0);

    // Subtle banking into corners sells the speed
    const bank = THREE.MathUtils.clamp(
      -steerVisual * 0.16 * speedT01 - carPhysics.localLatVel * 0.004,
      -0.055, 0.055
    );
    camera.rotateZ(bank);

    if (cameraShake > 0.01) {
      cameraShake *= 0.88;
      camera.position.x += (Math.random() - 0.5) * cameraShake;
      camera.position.y += (Math.random() - 0.5) * cameraShake;
      camera.position.z += (Math.random() - 0.5) * cameraShake;
    }

    // --- Telemetry lateral offset ---
    let lateralOffset = 0.0;
    if (!isFirstDriveFrame) {
      const dx = wx - startingX;
      const dz = wz - startingZ;
      const latFwdX = Math.cos(startingHeading);
      const latFwdZ = -Math.sin(startingHeading);
      lateralOffset = dx * latFwdX + dz * latFwdZ;
    }

    // --- HUD ---
    const driveMode = isScrapingRail ? 'SCRAPE' : (Math.abs(carPhysics.localLatVel) > 2.2 ? 'DRIFT' : '');
    uiController.updateHUD(distanceTraveled, carPhysics.speed, driveMode);
    uiController.updateTelemetry(carPhysics, lateralOffset, currentFPS);

    // --- Audio ---
    if (audioSynthManager) {
      audioSynthManager.updateEngineSound(carPhysics.speed, false, inputs.throttle, dt);
      audioSynthManager.updateWindSound(carPhysics.speed);
      audioSynthManager.updateRoadSound(carPhysics.speed);
      audioSynthManager.updateSkidSound(carPhysics.localLatVel, carPhysics.speed);
      audioSynthManager.updateScrapeSound(isScrapingRail, carPhysics.speed);
    }

    // --- Car light effects ---
    carVisuals.headlights.forEach(light => {
      light.intensity = (55 + speedT01 * 45) * headlightBoost;
      light.distance = 55 + speedT01 * 35;
    });
    if (carVisuals.beamGlow) {
      const bg = carVisuals.beamGlow;
      bg.material.opacity = THREE.MathUtils.clamp((headlightBoost - 1.0) * 0.42, 0, 0.55);
      // Drape the glow over the road ahead, tilted to the local slope
      const gNear = getGroundHeight(wx + fwdX * 4, wz + fwdZ * 4);
      const gFar = getGroundHeight(wx + fwdX * 14, wz + fwdZ * 14);
      bg.position.set(wx + fwdX * 9, (gNear + gFar) * 0.5 + 0.22, wz + fwdZ * 9);
      bg.rotation.y = heading;
      bg.rotation.x = -Math.PI / 2 + Math.atan2(gFar - gNear, 10);
    }
    if (carVisuals.brakeLight) {
      carVisuals.brakeLight.intensity = inputs.brake > 0 ? 1.3 : 0.0;
    }
  } else {
    if (audioSynthManager) {
      audioSynthManager.updateEngineSound(0.0, true);
      audioSynthManager.updateWindSound(0.0);
      audioSynthManager.updateRoadSound(0.0);
      audioSynthManager.updateSkidSound(0.0, 0.0);
      audioSynthManager.updateScrapeSound(false, 0.0);
    }
    if (cameraShake > 0.01) {
      cameraShake *= 0.88;
      camera.position.x += (Math.random() - 0.5) * cameraShake;
      camera.position.y += (Math.random() - 0.5) * cameraShake;
    }
  }

  // --- Effects that keep animating in every state ---
  updateDayNight(dt);
  if (sparks) {
    sparks.update(dt);
    smoke.update(dt);
    skidMarks.update(dt);
  }
  if (sunFlareAnchor && sunPosition) {
    sunFlareAnchor.position.copy(camera.position).addScaledVector(sunPosition, 800);
  }
  if (colorGradePass) {
    colorGradePass.uniforms.uTime.value = (time % 10000) / 1000;
    colorGradePass.uniforms.uSpeed.value = gameState === 'PLAYING'
      ? Math.min(1, Math.abs(carPhysics.speed) / 70)
      : 0;
  }

  // Browsers (Firefox especially) only unlock audio on a CLICK, not a keypress.
  // Keep retrying resume and tell the player a single click fixes it.
  if (audioSynthManager && audioSynthManager.ctx) {
    const blocked = audioSynthManager.ctx.state === 'suspended';
    uiController.setAudioHint(blocked);
    if (blocked) audioSynthManager.resume();
  }

  if (currentFPS < 35 && useBloom && time > 6000) {
    useBloom = false;
    console.warn('FPS dropped below threshold. Disabling bloom pass to optimize game performance.');
  }

  if (useBloom && composer) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

// -------------------------------------------------------------
// Resize
// -------------------------------------------------------------
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) {
    composer.setSize(window.innerWidth, window.innerHeight);
  }
}

init();

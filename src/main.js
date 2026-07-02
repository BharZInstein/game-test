import './style.css';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const canvas = document.querySelector('#game');
const promptEl = document.querySelector('#prompt');
const speedEl = document.querySelector('#speed');
const signalEl = document.querySelector('#signal');

const UP = new THREE.Vector3(0, 1, 0);
const ROUTE_LENGTH = 5200;
const ROAD_WIDTH = 10.6;
const ROAD_HALF_WIDTH = ROAD_WIDTH / 2;
const input = {
  left: false,
  right: false,
  forward: false,
  brake: false,
};

let started = false;
let elapsedRunTime = 0;
let distance = 28;
let speed = 0;
let laneOffset = 0;
let laneVelocity = 0;
let lastHudUpdate = 0;
let audioStarted = false;
let audioContext;
let engineOscillator;
let engineGain;
let windGain;

const clock = new THREE.Clock();
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x8fc4dd, 240, 1220);

const camera = new THREE.PerspectiveCamera(61, window.innerWidth / window.innerHeight, 0.1, 1300);
camera.position.set(0, 11, 32);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.65));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.82;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const composer = new EffectComposer(renderer);
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.06,
  0.32,
  0.82,
);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

const scratchCenter = new THREE.Vector3();
const scratchCenterA = new THREE.Vector3();
const scratchCenterB = new THREE.Vector3();
const scratchTangent = new THREE.Vector3();
const scratchSide = new THREE.Vector3();
const scratchNormal = new THREE.Vector3();
const scratchMatrix = new THREE.Matrix4();
const scratchQuaternion = new THREE.Quaternion();
const scratchScale = new THREE.Vector3(1, 1, 1);
const colorScratch = new THREE.Color();

const world = new THREE.Group();
scene.add(world);

const skyDome = addSky();
const sunDisk = addSunDisc();
addLighting();
addTerrain();
addWater();
addRoadSystem();
addTrees();
addClouds();
addMountains();
addRoadsideDetails();
const vehicle = createVehicle();
world.add(vehicle.group);

const cameraTarget = new THREE.Vector3();
const desiredCamera = new THREE.Vector3();
const currentCamera = new THREE.Vector3(0, 11, 32);
const currentLook = new THREE.Vector3(0, 5, -28);

setVehiclePose(distance, 0, 0, 0);
camera.position.copy(currentCamera);
camera.lookAt(currentLook);

window.addEventListener('resize', handleResize);
window.addEventListener('keydown', handleKeyDown);
window.addEventListener('keyup', handleKeyUp);
window.addEventListener('pointerdown', handlePointerStart, { passive: true });

animate();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;

  updateGame(dt, time);
  skyDome.position.copy(camera.position);
  updateSunDisc();
  composer.render();
}

function updateGame(dt, time) {
  if (started) {
    elapsedRunTime += dt;
  }

  const progress = THREE.MathUtils.clamp(elapsedRunTime / 60, 0, 1);
  const cruiseSpeed = started ? 30 + progress * 8 : 0;
  const targetSpeed = input.brake ? 14 : input.forward ? 43 + progress * 4 : cruiseSpeed;
  speed = THREE.MathUtils.damp(speed, targetSpeed, started ? 1.2 : 2.8, dt);

  if (started) {
    distance += speed * dt;
    if (distance > ROUTE_LENGTH - 160) {
      distance = 160;
    }
  }

  const steer = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  laneVelocity = THREE.MathUtils.damp(laneVelocity, steer * 7.8, 5.2, dt);
  laneOffset += laneVelocity * dt;
  laneOffset = THREE.MathUtils.clamp(laneOffset, -3.35, 3.35);
  if (!steer) {
    laneOffset = THREE.MathUtils.damp(laneOffset, Math.sin(time * 0.22) * 0.25, 1.4, dt);
  }

  setVehiclePose(distance, laneOffset, time, steer);
  updateCamera(dt, time);
  updateVehicleEffects(time, progress);
  updateAtmosphere(progress, time);
  updateAudio();

  if (time - lastHudUpdate > 0.08) {
    lastHudUpdate = time;
    speedEl.textContent = Math.round(speed * 2.2).toString();
    signalEl.textContent = `${Math.round(progress * 100)}%`;
  }
}

function setVehiclePose(s, lane, time, steer) {
  const center = centerAt(s, scratchCenter);
  const tangent = tangentAt(s, scratchTangent);
  const side = sideAt(s, scratchSide);
  const normal = normalAt(s, scratchNormal);
  const bob = Math.sin(time * 2.4) * 0.018 + Math.sin(s * 0.08) * 0.012;

  vehicle.group.position
    .copy(center)
    .addScaledVector(side, lane)
    .addScaledVector(normal, 0.52 + bob);

  scratchMatrix.makeBasis(side, normal, tangent);
  scratchQuaternion.setFromRotationMatrix(scratchMatrix);
  const localMotion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.clamp((speed - 32) * -0.0015, -0.035, 0.02),
      steer * -0.065 + laneVelocity * -0.011,
      THREE.MathUtils.clamp(-laneVelocity * 0.035, -0.24, 0.24),
      'XYZ',
    ),
  );
  vehicle.group.quaternion.copy(scratchQuaternion).multiply(localMotion);
}

function updateCamera(dt, time) {
  const tangent = tangentAt(distance + 12, scratchTangent);
  const side = sideAt(distance + 8, scratchSide);
  const normal = normalAt(distance + 8, scratchNormal);
  const behind = centerAt(Math.max(distance - 19, 0), scratchCenterA);
  const ahead = centerAt(distance + 50, scratchCenterB);

  desiredCamera
    .copy(behind)
    .addScaledVector(side, laneOffset * 0.36)
    .addScaledVector(normal, 6.7 + Math.sin(time * 0.18) * 0.4)
    .addScaledVector(tangent, -0.8);

  cameraTarget
    .copy(ahead)
    .addScaledVector(side, laneOffset * 0.25)
    .addScaledVector(normal, 2.6);

  currentCamera.lerp(desiredCamera, 1 - Math.pow(0.00008, dt));
  currentLook.lerp(cameraTarget, 1 - Math.pow(0.00002, dt));
  camera.position.copy(currentCamera);
  camera.lookAt(currentLook);
  camera.fov = THREE.MathUtils.damp(camera.fov, 58 + THREE.MathUtils.clamp(speed - 28, 0, 24) * 0.12, 2.5, dt);
  camera.updateProjectionMatrix();
}

function updateVehicleEffects(time, progress) {
  const headlightPulse = 1.4 + Math.sin(time * 6) * 0.06 + progress * 0.18;
  vehicle.headlights.forEach((light) => {
    light.intensity = 3.5 * headlightPulse;
  });
  vehicle.tailGlow.material.opacity = 0.18 + Math.sin(time * 8) * 0.03;
  vehicle.windshield.material.emissiveIntensity = 0.38 + Math.sin(time * 1.4) * 0.04;
}

function updateAtmosphere(progress, time) {
  const daylight = 0.5 + Math.sin(time * 0.04) * 0.04;
  scene.fog.near = 240 - progress * 18;
  scene.fog.far = 1220 - progress * 90;
  scene.fog.color.setHSL(0.56, 0.42, daylight + progress * 0.02);
  bloomPass.strength = 0.06 + progress * 0.03;
  renderer.toneMappingExposure = 0.82 + progress * 0.03;
}

function handleKeyDown(event) {
  const key = event.key.toLowerCase();
  if (key === 'w' || key === 'arrowup') {
    input.forward = true;
    startRun();
  } else if (key === 'a' || key === 'arrowleft') {
    input.left = true;
  } else if (key === 'd' || key === 'arrowright') {
    input.right = true;
  } else if (key === 's' || key === 'arrowdown') {
    input.brake = true;
  }
}

function handleKeyUp(event) {
  const key = event.key.toLowerCase();
  if (key === 'w' || key === 'arrowup') {
    input.forward = false;
  } else if (key === 'a' || key === 'arrowleft') {
    input.left = false;
  } else if (key === 'd' || key === 'arrowright') {
    input.right = false;
  } else if (key === 's' || key === 'arrowdown') {
    input.brake = false;
  }
}

function handlePointerStart() {
  input.forward = true;
  startRun();
  window.setTimeout(() => {
    input.forward = false;
  }, 520);
}

function startRun() {
  if (started) {
    return;
  }
  started = true;
  promptEl.classList.add('is-hidden');
  startAudio();
}

function baseElevation(s) {
  return 7 + Math.sin(s * 0.0024 + 0.7) * 13 + Math.sin(s * 0.0074 - 0.3) * 3.2;
}

function centerAt(s, target = new THREE.Vector3()) {
  const clamped = THREE.MathUtils.clamp(s, 0, ROUTE_LENGTH);
  const x =
    Math.sin(clamped * 0.0028 + 0.2) * 92 +
    Math.sin(clamped * 0.0062 + 2.1) * 34 +
    Math.sin(clamped * 0.00082 + 1.6) * 86;
  target.set(x, baseElevation(clamped), -clamped);
  return target;
}

function tangentAt(s, target = new THREE.Vector3()) {
  centerAt(s + 3.5, scratchCenterA);
  centerAt(s - 3.5, scratchCenterB);
  return target.copy(scratchCenterA).sub(scratchCenterB).normalize();
}

function sideAt(s, target = new THREE.Vector3()) {
  tangentAt(s, scratchTangent);
  return target.crossVectors(scratchTangent, UP).normalize();
}

function normalAt(s, target = new THREE.Vector3()) {
  const tangent = tangentAt(s, scratchTangent);
  const side = sideAt(s, scratchSide);
  return target.crossVectors(side, tangent).normalize();
}

function terrainOffset(s, lateral) {
  const edge = Math.abs(lateral);
  const shoulder = smoothstep(ROAD_HALF_WIDTH + 2, ROAD_HALF_WIDTH + 28, edge) * 2.2;
  const hillside = Math.pow(THREE.MathUtils.clamp((edge - 26) / 210, 0, 1), 1.55) * (30 + Math.sin(s * 0.002) * 10);
  const distantRise = Math.pow(THREE.MathUtils.clamp((edge - 150) / 120, 0, 1), 1.2) * 18;
  const rolling =
    Math.sin(s * 0.007 + lateral * 0.025) * 2.1 +
    Math.sin(s * 0.017 - lateral * 0.013 + 1.1) * 1.25 +
    Math.sin((s + lateral * 2.1) * 0.031) * 0.55;
  const roadCut = 1 - smoothstep(ROAD_HALF_WIDTH + 1, ROAD_HALF_WIDTH + 10, edge);
  return shoulder + hillside + distantRise + rolling * (0.2 + smoothstep(10, 80, edge) * 0.85) - roadCut * 1.35;
}

function smoothstep(edge0, edge1, value) {
  const x = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return x * x * (3 - 2 * x);
}

function hash(value) {
  return fract(Math.sin(value * 127.1 + 311.7) * 43758.5453123);
}

function fract(value) {
  return value - Math.floor(value);
}

function addLighting() {
  const hemi = new THREE.HemisphereLight(0xdff7ff, 0x304d2d, 1.05);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2cf, 2.15);
  sun.position.set(-120, 190, 95);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -130;
  sun.shadow.camera.right = 130;
  sun.shadow.camera.top = 130;
  sun.shadow.camera.bottom = -130;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 420;
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0x8cc7ff, 0.32);
  fill.position.set(130, 80, -80);
  scene.add(fill);
}

function addSky() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x3698dd) },
      uHorizon: { value: new THREE.Color(0xbfe7ee) },
      uGround: { value: new THREE.Color(0x7fbf89) },
    },
    vertexShader: `
      varying vec3 vWorld;

      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform vec3 uGround;
      varying vec3 vWorld;

      void main() {
        vec3 dir = normalize(vWorld);
        float height = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 sky = mix(uHorizon, uTop, smoothstep(0.36, 1.0, height));
        sky = mix(uGround, sky, smoothstep(0.1, 0.45, height));
        float sun = smoothstep(0.992, 1.0, dot(dir, normalize(vec3(-0.46, 0.78, 0.42))));
        sky += vec3(1.0, 0.62, 0.24) * sun * 0.9;
        gl_FragColor = vec4(sky, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1100, 48, 24), material);
  sky.frustumCulled = false;
  scene.add(sky);
  return sky;
}

function addSunDisc() {
  const material = new THREE.MeshBasicMaterial({
    color: 0xffe3a3,
    transparent: true,
    opacity: 0.86,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const sun = new THREE.Mesh(new THREE.CircleGeometry(28, 48), material);
  sun.frustumCulled = false;
  scene.add(sun);
  return sun;
}

function updateSunDisc() {
  sunDisk.position.copy(camera.position).add(new THREE.Vector3(-360, 290, -470));
  sunDisk.lookAt(camera.position);
}

function addTerrain() {
  const longitudinalSegments = 560;
  const lateralSegments = 96;
  const width = 285;
  const positions = [];
  const colors = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= longitudinalSegments; i++) {
    const s = (i / longitudinalSegments) * ROUTE_LENGTH;
    const center = centerAt(s, new THREE.Vector3());
    const side = sideAt(s, new THREE.Vector3());

    for (let j = 0; j <= lateralSegments; j++) {
      const pct = j / lateralSegments;
      const lateral = THREE.MathUtils.lerp(-width, width, pct);
      const edge = Math.abs(lateral);
      const position = center.clone().addScaledVector(side, lateral);
      position.y += terrainOffset(s, lateral);
      positions.push(position.x, position.y, position.z);

      const slope = THREE.MathUtils.clamp((position.y - center.y) / 58, 0, 1);
      const noise = hash(i * 41.7 + j * 19.1);
      const nearRoad = 1 - smoothstep(ROAD_HALF_WIDTH + 4, ROAD_HALF_WIDTH + 30, edge);
      const meadow = new THREE.Color(0x4f963f).lerp(new THREE.Color(0x93b552), noise * 0.45);
      const hillside = new THREE.Color(0x23543a).lerp(new THREE.Color(0x58724b), noise * 0.55);
      const rock = new THREE.Color(0x59665f).lerp(new THREE.Color(0xcac9b6), smoothstep(0.65, 1, slope));
      colorScratch.copy(meadow).lerp(hillside, smoothstep(48, 190, edge)).lerp(rock, smoothstep(0.62, 0.98, slope));
      colorScratch.lerp(new THREE.Color(0x7d8f51), nearRoad * 0.12);
      colors.push(colorScratch.r, colorScratch.g, colorScratch.b);
      uvs.push(pct, s / ROUTE_LENGTH);
    }
  }

  const row = lateralSegments + 1;
  for (let i = 0; i < longitudinalSegments; i++) {
    for (let j = 0; j < lateralSegments; j++) {
      const a = i * row + j;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  const terrain = new THREE.Mesh(geometry, material);
  terrain.receiveShadow = true;
  world.add(terrain);
}

function addRoadSystem() {
  const asphaltTexture = createAsphaltTexture();
  const roadMaterial = new THREE.MeshBasicMaterial({
    color: 0x34393d,
    map: asphaltTexture,
    fog: false,
    side: THREE.DoubleSide,
  });
  const shoulderMaterial = new THREE.MeshStandardMaterial({
    color: 0x7f7758,
    map: createGravelTexture(),
    roughness: 0.96,
    side: THREE.DoubleSide,
  });
  const markingMaterial = new THREE.MeshBasicMaterial({
    color: 0xf5f6ec,
    fog: false,
    side: THREE.DoubleSide,
  });
  const railMaterial = new THREE.MeshStandardMaterial({
    color: 0xc9d0d2,
    roughness: 0.36,
    metalness: 0.7,
  });
  const postMaterial = new THREE.MeshStandardMaterial({
    color: 0xe5e7db,
    roughness: 0.5,
  });

  const road = new THREE.Mesh(createRibbonGeometry(0, ROAD_WIDTH, 720, 0.46), roadMaterial);
  road.receiveShadow = true;
  world.add(road);

  const leftShoulder = new THREE.Mesh(createRibbonGeometry(-ROAD_HALF_WIDTH - 1.25, 2.5, 720, 0.38), shoulderMaterial);
  const rightShoulder = new THREE.Mesh(createRibbonGeometry(ROAD_HALF_WIDTH + 1.25, 2.5, 720, 0.38), shoulderMaterial);
  leftShoulder.receiveShadow = true;
  rightShoulder.receiveShadow = true;
  world.add(leftShoulder, rightShoulder);

  const leftEdge = new THREE.Mesh(createRibbonGeometry(-ROAD_HALF_WIDTH + 0.2, 0.15, 720, 0.57), markingMaterial);
  const rightEdge = new THREE.Mesh(createRibbonGeometry(ROAD_HALF_WIDTH - 0.2, 0.15, 720, 0.57), markingMaterial);
  world.add(leftEdge, rightEdge);

  addLaneDashes(markingMaterial);
  addGuardRails(railMaterial, postMaterial);
}

function addLaneDashes(material) {
  const geometry = new THREE.BoxGeometry(0.24, 0.035, 5.8);
  const count = Math.floor(ROUTE_LENGTH / 18);
  const dashes = new THREE.InstancedMesh(geometry, material, count);
  dashes.castShadow = false;
  dashes.receiveShadow = true;

  for (let i = 0; i < count; i++) {
    const s = 18 + i * 18;
    const center = centerAt(s, scratchCenter);
    const tangent = tangentAt(s, scratchTangent);
    const side = sideAt(s, scratchSide);
    const normal = normalAt(s, scratchNormal);
    const position = center.clone().addScaledVector(normal, 0.62);
    scratchMatrix.makeBasis(side, normal, tangent);
    scratchQuaternion.setFromRotationMatrix(scratchMatrix);
    scratchScale.set(1, 1, 1);
    scratchMatrix.compose(position, scratchQuaternion, scratchScale);
    dashes.setMatrixAt(i, scratchMatrix);
  }

  dashes.instanceMatrix.needsUpdate = true;
  world.add(dashes);
}

function addGuardRails(railMaterial, postMaterial) {
  const railGeometry = new THREE.BoxGeometry(0.2, 0.26, 7.4);
  const postGeometry = new THREE.CylinderGeometry(0.11, 0.16, 1.45, 8);
  const railCount = Math.floor(ROUTE_LENGTH / 8) * 2;
  const postCount = Math.floor(ROUTE_LENGTH / 16) * 2;
  const rails = new THREE.InstancedMesh(railGeometry, railMaterial, railCount);
  const posts = new THREE.InstancedMesh(postGeometry, postMaterial, postCount);

  let railIndex = 0;
  let postIndex = 0;
  for (let s = 0; s < ROUTE_LENGTH; s += 8) {
    for (const sign of [-1, 1]) {
      placeRailInstance(rails, railIndex, s, sign);
      railIndex++;
    }
  }
  for (let s = 0; s < ROUTE_LENGTH; s += 16) {
    for (const sign of [-1, 1]) {
      const center = centerAt(s, scratchCenter);
      const side = sideAt(s, scratchSide);
      const lateral = sign * (ROAD_HALF_WIDTH + 1.85);
      const position = center.clone().addScaledVector(side, lateral);
      position.y += terrainOffset(s, lateral) + 0.7;
      scratchQuaternion.identity();
      scratchScale.set(1, 1, 1);
      scratchMatrix.compose(position, scratchQuaternion, scratchScale);
      posts.setMatrixAt(postIndex, scratchMatrix);
      postIndex++;
    }
  }

  rails.instanceMatrix.needsUpdate = true;
  posts.instanceMatrix.needsUpdate = true;
  rails.castShadow = true;
  posts.castShadow = true;
  world.add(rails, posts);
}

function placeRailInstance(mesh, index, s, sign) {
  const center = centerAt(s, scratchCenter);
  const tangent = tangentAt(s, scratchTangent);
  const side = sideAt(s, scratchSide);
  const normal = normalAt(s, scratchNormal);
  const lateral = sign * (ROAD_HALF_WIDTH + 1.85);
  const position = center.clone().addScaledVector(side, lateral).addScaledVector(normal, 1.02);
  scratchMatrix.makeBasis(side, normal, tangent);
  scratchQuaternion.setFromRotationMatrix(scratchMatrix);
  scratchScale.set(1, 1, 1);
  scratchMatrix.compose(position, scratchQuaternion, scratchScale);
  mesh.setMatrixAt(index, scratchMatrix);
}

function addWater() {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColorA: { value: new THREE.Color(0x2f94a4) },
      uColorB: { value: new THREE.Color(0x9bd7c6) },
      uTime: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorld;

      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vWorld;

      void main() {
        float shimmer = sin(vWorld.x * 0.08 + uTime * 0.9) * sin(vWorld.z * 0.045 - uTime * 0.45);
        float stripe = smoothstep(0.88, 1.0, sin(vUv.y * 190.0 + uTime * 1.6) * 0.5 + 0.5);
        vec3 color = mix(uColorA, uColorB, 0.45 + shimmer * 0.16);
        color += vec3(0.35, 0.55, 0.5) * stripe * 0.18;
        gl_FragColor = vec4(color, 0.56);
      }
    `,
  });
  material.onBeforeRender = () => {
    material.uniforms.uTime.value = clock.elapsedTime;
  };

  const river = new THREE.Mesh(createWaterRibbonGeometry(62, 36, 420), material);
  river.receiveShadow = true;
  world.add(river);
}

function addTrees() {
  const count = 1300;
  const trunkGeometry = new THREE.CylinderGeometry(0.16, 0.23, 1, 6);
  const pineGeometry = new THREE.ConeGeometry(1, 1, 7);
  pineGeometry.translate(0, 0.5, 0);
  const trunkMaterial = new THREE.MeshStandardMaterial({
    color: 0x5a3a27,
    roughness: 0.86,
  });
  const pineMaterial = new THREE.MeshStandardMaterial({
    color: 0x2f6f45,
    roughness: 0.82,
  });
  const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, count);
  const pines = new THREE.InstancedMesh(pineGeometry, pineMaterial, count);

  for (let i = 0; i < count; i++) {
    const s = 22 + hash(i + 10) * (ROUTE_LENGTH - 80);
    const sign = hash(i + 99) > 0.5 ? 1 : -1;
    const lateral = sign * (18 + Math.pow(hash(i + 33), 0.72) * 245);
    const center = centerAt(s, scratchCenter);
    const side = sideAt(s, scratchSide);
    const ground = center.clone().addScaledVector(side, lateral);
    ground.y += terrainOffset(s, lateral);
    const treeHeight = 5 + Math.pow(hash(i + 61), 1.9) * 14;
    const radius = treeHeight * (0.16 + hash(i + 71) * 0.045);
    const trunkHeight = treeHeight * 0.32;

    scratchQuaternion.setFromEuler(new THREE.Euler(0, hash(i + 47) * Math.PI * 2, 0));
    scratchScale.set(0.7 + hash(i + 2) * 0.6, trunkHeight, 0.7 + hash(i + 4) * 0.5);
    scratchMatrix.compose(
      ground.clone().add(new THREE.Vector3(0, trunkHeight * 0.5, 0)),
      scratchQuaternion,
      scratchScale,
    );
    trunks.setMatrixAt(i, scratchMatrix);

    scratchScale.set(radius, treeHeight, radius);
    scratchMatrix.compose(
      ground.clone().add(new THREE.Vector3(0, trunkHeight * 0.65, 0)),
      scratchQuaternion,
      scratchScale,
    );
    pines.setMatrixAt(i, scratchMatrix);

    colorScratch.setHSL(0.29 + hash(i + 6) * 0.05, 0.43 + hash(i + 9) * 0.12, 0.24 + hash(i + 14) * 0.12);
    if (hash(i + 121) > 0.94) {
      colorScratch.setHSL(0.1, 0.55, 0.48);
    }
    pines.setColorAt(i, colorScratch);
  }

  trunks.instanceMatrix.needsUpdate = true;
  pines.instanceMatrix.needsUpdate = true;
  pines.instanceColor.needsUpdate = true;
  trunks.castShadow = true;
  pines.castShadow = true;
  world.add(trunks, pines);
}

function addClouds() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xf7fbff,
    roughness: 1,
    metalness: 0,
    transparent: true,
    opacity: 0.74,
    depthWrite: false,
  });
  const puffGeometry = new THREE.SphereGeometry(1, 16, 8);

  for (let i = 0; i < 34; i++) {
    const group = new THREE.Group();
    const s = hash(i + 71) * ROUTE_LENGTH;
    const center = centerAt(s, scratchCenter);
    const side = sideAt(s, scratchSide);
    const lateral = (hash(i + 72) - 0.5) * 680;
    group.position.copy(center).addScaledVector(side, lateral);
    group.position.y += 90 + hash(i + 73) * 58;
    group.position.z += (hash(i + 74) - 0.5) * 120;

    const puffs = 4 + Math.floor(hash(i + 75) * 4);
    for (let j = 0; j < puffs; j++) {
      const puff = new THREE.Mesh(puffGeometry, material);
      puff.position.set((hash(i * 10 + j) - 0.5) * 42, (hash(i * 10 + j + 1) - 0.5) * 9, (hash(i * 10 + j + 2) - 0.5) * 20);
      puff.scale.set(7 + hash(i * 10 + j + 3) * 13, 4 + hash(i * 10 + j + 4) * 6, 5 + hash(i * 10 + j + 5) * 9);
      group.add(puff);
    }
    world.add(group);
  }
}

function addMountains() {
  const material = new THREE.MeshStandardMaterial({
    color: 0x6c7f84,
    roughness: 0.92,
    metalness: 0,
    flatShading: true,
  });
  const snowMaterial = new THREE.MeshStandardMaterial({
    color: 0xe7e4d4,
    roughness: 0.7,
    flatShading: true,
  });
  const geometry = new THREE.ConeGeometry(1, 1, 6);
  geometry.translate(0, 0.5, 0);

  for (let i = 0; i < 58; i++) {
    const s = 80 + hash(i + 211) * (ROUTE_LENGTH - 160);
    const sign = hash(i + 212) > 0.5 ? 1 : -1;
    const lateral = sign * (210 + hash(i + 213) * 180);
    const center = centerAt(s, scratchCenter);
    const side = sideAt(s, scratchSide);
    const ground = center.clone().addScaledVector(side, lateral);
    ground.y += terrainOffset(s, lateral) - 4;
    const height = 42 + hash(i + 214) * 96;
    const radius = 24 + hash(i + 215) * 54;
    const mountain = new THREE.Mesh(geometry, material);
    mountain.position.copy(ground);
    mountain.rotation.y = hash(i + 216) * Math.PI * 2;
    mountain.scale.set(radius, height, radius * (0.78 + hash(i + 217) * 0.45));
    mountain.receiveShadow = true;
    world.add(mountain);

    if (height > 72) {
      const snow = new THREE.Mesh(geometry, snowMaterial);
      snow.position.copy(ground).add(new THREE.Vector3(0, height * 0.62, 0));
      snow.rotation.y = mountain.rotation.y;
      snow.scale.set(radius * 0.34, height * 0.34, radius * 0.28);
      world.add(snow);
    }
  }
}

function addRoadsideDetails() {
  const markerGeometry = new THREE.BoxGeometry(0.24, 1.45, 0.18);
  const markerMaterial = new THREE.MeshStandardMaterial({
    color: 0xf7f1dc,
    roughness: 0.45,
    emissive: 0x101010,
  });
  const reflectorMaterial = new THREE.MeshBasicMaterial({
    color: 0xff6f46,
  });
  const markerCount = Math.floor(ROUTE_LENGTH / 28) * 2;
  const markers = new THREE.InstancedMesh(markerGeometry, markerMaterial, markerCount);
  const reflectors = new THREE.InstancedMesh(new THREE.BoxGeometry(0.28, 0.16, 0.05), reflectorMaterial, markerCount);

  let index = 0;
  for (let s = 6; s < ROUTE_LENGTH; s += 28) {
    for (const sign of [-1, 1]) {
      const center = centerAt(s, scratchCenter);
      const side = sideAt(s, scratchSide);
      const tangent = tangentAt(s, scratchTangent);
      const lateral = sign * (ROAD_HALF_WIDTH + 3.1);
      const position = center.clone().addScaledVector(side, lateral);
      position.y += terrainOffset(s, lateral) + 0.73;
      scratchMatrix.makeBasis(side, UP, tangent);
      scratchQuaternion.setFromRotationMatrix(scratchMatrix);
      scratchScale.set(1, 1, 1);
      scratchMatrix.compose(position, scratchQuaternion, scratchScale);
      markers.setMatrixAt(index, scratchMatrix);

      const reflectorPosition = position.clone().add(new THREE.Vector3(0, 0.36, 0)).addScaledVector(side, -sign * 0.14);
      scratchMatrix.compose(reflectorPosition, scratchQuaternion, scratchScale);
      reflectors.setMatrixAt(index, scratchMatrix);
      index++;
    }
  }
  markers.instanceMatrix.needsUpdate = true;
  reflectors.instanceMatrix.needsUpdate = true;
  markers.castShadow = true;
  world.add(markers, reflectors);
}

function createVehicle() {
  const group = new THREE.Group();
  const paintMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xc93628,
    roughness: 0.2,
    metalness: 0.36,
    clearcoat: 1,
    clearcoatRoughness: 0.13,
  });
  const trimMaterial = new THREE.MeshStandardMaterial({
    color: 0x101417,
    roughness: 0.38,
    metalness: 0.55,
  });
  const tireMaterial = new THREE.MeshStandardMaterial({
    color: 0x080a0b,
    roughness: 0.84,
  });
  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x5aaec6,
    emissive: 0x0b2832,
    emissiveIntensity: 0.22,
    metalness: 0.05,
    roughness: 0.05,
    transmission: 0.22,
    transparent: true,
    opacity: 0.67,
  });
  const headlightMaterial = new THREE.MeshBasicMaterial({
    color: 0xfff0b5,
  });
  const tailMaterial = new THREE.MeshBasicMaterial({
    color: 0xff241d,
    transparent: true,
    opacity: 0.72,
  });

  const underbody = new THREE.Mesh(new RoundedBoxGeometry(4.25, 0.42, 6.5, 5, 0.16), trimMaterial);
  underbody.position.set(0, 0.46, -0.06);
  underbody.castShadow = true;
  group.add(underbody);

  const lowerBody = new THREE.Mesh(new RoundedBoxGeometry(4.05, 0.78, 5.95, 7, 0.26), paintMaterial);
  lowerBody.position.set(0, 0.82, -0.03);
  lowerBody.scale.set(1, 0.92, 1);
  lowerBody.castShadow = true;
  lowerBody.receiveShadow = true;
  group.add(lowerBody);

  const rearHaunch = new THREE.Mesh(new RoundedBoxGeometry(4.35, 0.64, 2.15, 6, 0.24), paintMaterial);
  rearHaunch.position.set(0, 1.03, -1.72);
  rearHaunch.castShadow = true;
  group.add(rearHaunch);

  const hood = new THREE.Mesh(new RoundedBoxGeometry(3.5, 0.34, 2.45, 5, 0.18), paintMaterial);
  hood.position.set(0, 1.24, 1.72);
  hood.rotation.x = -0.075;
  hood.castShadow = true;
  group.add(hood);

  const cabin = new THREE.Mesh(new RoundedBoxGeometry(2.45, 0.72, 1.82, 5, 0.14), glassMaterial);
  cabin.position.set(0, 1.54, -0.66);
  cabin.rotation.x = -0.045;
  cabin.castShadow = true;
  group.add(cabin);

  const roof = new THREE.Mesh(new RoundedBoxGeometry(2.04, 0.18, 1.22, 4, 0.08), trimMaterial);
  roof.position.set(0, 1.94, -0.54);
  roof.castShadow = true;
  group.add(roof);

  const rearWindow = new THREE.Mesh(
    new THREE.PlaneGeometry(2.1, 0.76),
    new THREE.MeshPhysicalMaterial({
      color: 0x316f84,
      emissive: 0x061820,
      emissiveIntensity: 0.16,
      roughness: 0.08,
      metalness: 0.05,
      transparent: true,
      opacity: 0.78,
      side: THREE.DoubleSide,
    }),
  );
  rearWindow.position.set(0, 1.58, -1.55);
  rearWindow.rotation.x = -0.48;
  group.add(rearWindow);

  const frontSplitter = new THREE.Mesh(new RoundedBoxGeometry(4.35, 0.16, 0.52, 3, 0.04), trimMaterial);
  frontSplitter.position.set(0, 0.49, 3.13);
  group.add(frontSplitter);

  const rearBumper = new THREE.Mesh(new RoundedBoxGeometry(4.12, 0.42, 0.46, 4, 0.08), trimMaterial);
  rearBumper.position.set(0, 0.67, -3.14);
  rearBumper.castShadow = true;
  group.add(rearBumper);

  const spoilerMaterial = new THREE.MeshStandardMaterial({
    color: 0x16191a,
    roughness: 0.28,
    metalness: 0.68,
  });
  const spoiler = new THREE.Mesh(new RoundedBoxGeometry(3.7, 0.13, 0.42, 4, 0.05), spoilerMaterial);
  spoiler.position.set(0, 1.44, -3.02);
  spoiler.rotation.x = 0.08;
  spoiler.castShadow = true;
  group.add(spoiler);

  for (const x of [-1.55, 1.55]) {
    const strut = new THREE.Mesh(new RoundedBoxGeometry(0.13, 0.48, 0.12, 2, 0.03), spoilerMaterial);
    strut.position.set(x, 1.18, -2.91);
    group.add(strut);
  }

  const skirtGeometry = new RoundedBoxGeometry(0.18, 0.28, 5.35, 3, 0.05);
  for (const x of [-2.16, 2.16]) {
    const skirt = new THREE.Mesh(skirtGeometry, trimMaterial);
    skirt.position.set(x, 0.56, -0.1);
    skirt.castShadow = true;
    group.add(skirt);
  }

  const wheelArchMaterial = new THREE.MeshBasicMaterial({
    color: 0x060708,
    transparent: true,
    opacity: 0.92,
  });
  const archGeometry = new THREE.TorusGeometry(0.63, 0.075, 8, 24, Math.PI);
  for (const x of [-2.13, 2.13]) {
    for (const z of [-2.04, 1.96]) {
      const arch = new THREE.Mesh(archGeometry, wheelArchMaterial);
      arch.position.set(x, 0.74, z);
      arch.rotation.set(0, Math.PI / 2, x < 0 ? Math.PI : 0);
      group.add(arch);
    }
  }

  const tireGeometry = new THREE.TorusGeometry(0.48, 0.16, 14, 32);
  tireGeometry.rotateY(Math.PI / 2);
  const rimGeometry = new THREE.CylinderGeometry(0.29, 0.29, 0.16, 22);
  rimGeometry.rotateZ(Math.PI / 2);
  const rimMaterial = new THREE.MeshStandardMaterial({
    color: 0xd6dde0,
    roughness: 0.22,
    metalness: 0.86,
  });

  for (const x of [-2.05, 2.05]) {
    for (const z of [-2.02, 1.94]) {
      const wheel = new THREE.Mesh(tireGeometry, tireMaterial);
      wheel.position.set(x, 0.55, z);
      wheel.castShadow = true;
      group.add(wheel);

      const rim = new THREE.Mesh(rimGeometry, rimMaterial);
      rim.position.set(x + Math.sign(x) * 0.015, 0.55, z);
      group.add(rim);
    }
  }

  const headlights = [];
  for (const x of [-0.95, 0.95]) {
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.18, 0.08), headlightMaterial);
    lens.position.set(x, 0.87, 3.16);
    group.add(lens);
    const light = new THREE.PointLight(0xfff2c4, 2.2, 38, 2.4);
    light.position.set(x, 0.92, 3.35);
    group.add(light);
    headlights.push(light);
  }

  const tailGlow = new THREE.Mesh(new RoundedBoxGeometry(0.72, 0.1, 0.06, 3, 0.03), tailMaterial.clone());
  tailGlow.position.set(0, 0.89, -3.42);
  group.add(tailGlow);

  for (const x of [-1.22, 1.22]) {
    const brakeLamp = new THREE.Mesh(new RoundedBoxGeometry(0.8, 0.24, 0.08, 3, 0.04), tailMaterial.clone());
    brakeLamp.position.set(x, 1.05, -3.43);
    group.add(brakeLamp);
  }

  const plate = new THREE.Mesh(
    new RoundedBoxGeometry(0.84, 0.22, 0.05, 2, 0.025),
    new THREE.MeshBasicMaterial({ color: 0xf2ead2 }),
  );
  plate.position.set(0, 0.75, -3.45);
  group.add(plate);

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(3.45, 36),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -0.04;
  shadow.scale.set(1.24, 0.7, 1);
  group.add(shadow);

  return {
    group,
    windshield: cabin,
    headlights,
    tailGlow,
  };
}

function createRibbonGeometry(lateralCenter, width, segments, yOffset) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const half = width / 2;

  for (let i = 0; i <= segments; i++) {
    const s = (i / segments) * ROUTE_LENGTH;
    const center = centerAt(s, new THREE.Vector3());
    const side = sideAt(s, new THREE.Vector3());
    const left = center.clone().addScaledVector(side, lateralCenter - half).add(new THREE.Vector3(0, yOffset, 0));
    const right = center.clone().addScaledVector(side, lateralCenter + half).add(new THREE.Vector3(0, yOffset, 0));
    positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
    uvs.push(0, s * 0.047, 1, s * 0.047);
  }

  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createWaterRibbonGeometry(lateralCenter, width, segments) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const half = width / 2;

  for (let i = 0; i <= segments; i++) {
    const s = (i / segments) * ROUTE_LENGTH;
    const wobble = Math.sin(s * 0.006) * 17 + Math.sin(s * 0.018 + 1.8) * 5;
    const center = centerAt(s, new THREE.Vector3());
    const side = sideAt(s, new THREE.Vector3());
    const riverCenter = lateralCenter + wobble;
    const left = center.clone().addScaledVector(side, riverCenter - half);
    const right = center.clone().addScaledVector(side, riverCenter + half);
    left.y = center.y + terrainOffset(s, riverCenter) * 0.22 - 5.3;
    right.y = left.y + Math.sin(s * 0.013) * 0.18;
    positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
    uvs.push(0, s / 80, 1, s / 80);
  }

  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createAsphaltTexture() {
  const canvasTexture = document.createElement('canvas');
  canvasTexture.width = 256;
  canvasTexture.height = 256;
  const ctx = canvasTexture.getContext('2d');
  ctx.fillStyle = '#2c3035';
  ctx.fillRect(0, 0, 256, 256);

  for (let i = 0; i < 7600; i++) {
    const v = 34 + Math.floor(hash(i + 4) * 42);
    ctx.fillStyle = `rgba(${v}, ${v + 2}, ${v + 5}, ${0.16 + hash(i + 7) * 0.22})`;
    ctx.fillRect(hash(i + 10) * 256, hash(i + 11) * 256, 1 + hash(i + 12) * 1.7, 1 + hash(i + 13) * 1.7);
  }

  for (let y = 0; y < 256; y += 32) {
    ctx.fillStyle = 'rgba(255,255,255,0.026)';
    ctx.fillRect(0, y + hash(y) * 6, 256, 1);
  }

  const texture = new THREE.CanvasTexture(canvasTexture);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.4, 1.4);
  texture.anisotropy = 8;
  return texture;
}

function createGravelTexture() {
  const canvasTexture = document.createElement('canvas');
  canvasTexture.width = 128;
  canvasTexture.height = 128;
  const ctx = canvasTexture.getContext('2d');
  ctx.fillStyle = '#948b6a';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 3000; i++) {
    const v = 105 + Math.floor(hash(i + 99) * 80);
    ctx.fillStyle = `rgba(${v}, ${v - 4}, ${v - 28}, ${0.18 + hash(i + 17) * 0.26})`;
    ctx.fillRect(hash(i + 15) * 128, hash(i + 16) * 128, 1 + hash(i + 18) * 2, 1 + hash(i + 19) * 2);
  }
  const texture = new THREE.CanvasTexture(canvasTexture);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.2, 2.6);
  texture.anisotropy = 8;
  return texture;
}

function startAudio() {
  if (audioStarted) {
    return;
  }
  audioStarted = true;
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  engineOscillator = audioContext.createOscillator();
  const windOscillator = audioContext.createOscillator();
  engineGain = audioContext.createGain();
  windGain = audioContext.createGain();
  const filter = audioContext.createBiquadFilter();

  engineOscillator.type = 'sawtooth';
  engineOscillator.frequency.value = 46;
  engineGain.gain.value = 0.0001;

  windOscillator.type = 'triangle';
  windOscillator.frequency.value = 180;
  windGain.gain.value = 0.0001;
  filter.type = 'lowpass';
  filter.frequency.value = 620;

  engineOscillator.connect(engineGain);
  engineGain.connect(audioContext.destination);
  windOscillator.connect(filter);
  filter.connect(windGain);
  windGain.connect(audioContext.destination);
  engineOscillator.start();
  windOscillator.start();
}

function updateAudio() {
  if (!audioStarted || !audioContext) {
    return;
  }
  const normalized = THREE.MathUtils.clamp(speed / 45, 0, 1);
  const now = audioContext.currentTime;
  engineOscillator.frequency.setTargetAtTime(42 + normalized * 72, now, 0.08);
  engineGain.gain.setTargetAtTime(0.012 + normalized * 0.033, now, 0.12);
  windGain.gain.setTargetAtTime(0.003 + normalized * 0.014, now, 0.4);
}

function handleResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.65));
  composer.setSize(width, height);
  bloomPass.setSize(width, height);
}

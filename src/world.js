import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

const ROAD_WIDTH = 16.0;
const SHOULDER_WIDTH = 3.25;
const ROAD_SAMPLE_STEP = 2.0;

function createSeededRandom(seedText) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedText.length; i++) {
    h ^= seedText.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const terrainNoise = createNoise2D(createSeededRandom('parsewaver-terrain'));
const roadNoise = createNoise2D(createSeededRandom('parsewaver-road'));
const detailNoise = createNoise2D(createSeededRandom('parsewaver-detail'));

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function hash01(a, b) {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function fbm(noise, x, z, octaves, frequency, amplitude) {
  let sum = 0;
  let amp = amplitude;
  let freq = frequency;
  let norm = 0;

  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, z * freq) * amp;
    norm += amp;
    amp *= 0.52;
    freq *= 2.03;
  }

  return sum / Math.max(0.0001, norm);
}

function roadRawX(z) {
  return (
    roadNoise(z * 0.00125, 4.2) * 118 +
    roadNoise(z * 0.0036, 19.7) * 38 +
    roadNoise(z * 0.0075, 71.5) * 12
  );
}

function roadRawY(z) {
  return (
    roadNoise(33.7, z * 0.0011) * 28 +
    roadNoise(91.4, z * 0.0038) * 8
  );
}

const ROAD_START_X = roadRawX(0);
const ROAD_START_Y = roadRawY(0);

export function getRoadX(z) {
  return roadRawX(z) - ROAD_START_X;
}

export function getRoadElevation(z) {
  return roadRawY(z) - ROAD_START_Y;
}

export function getRoadTangent(z) {
  const x0 = getRoadX(z - ROAD_SAMPLE_STEP);
  const x1 = getRoadX(z + ROAD_SAMPLE_STEP);
  const y0 = getRoadElevation(z - ROAD_SAMPLE_STEP);
  const y1 = getRoadElevation(z + ROAD_SAMPLE_STEP);
  return new THREE.Vector3(x1 - x0, y1 - y0, ROAD_SAMPLE_STEP * 2).normalize();
}

export function getRoadAngle(z) {
  const tangent = getRoadTangent(z);
  return Math.atan2(tangent.x, tangent.z);
}

export function getRoadPosition(z, lateralOffset = 0, lift = 0) {
  const tangent = getRoadTangent(z);
  const right = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize();
  return new THREE.Vector3(
    getRoadX(z) + right.x * lateralOffset,
    getRoadElevation(z) + lift,
    z + right.z * lateralOffset
  );
}

export function getTerrainHeight(x, z) {
  const roadX = getRoadX(z);
  const roadY = getRoadElevation(z);
  const distToRoad = Math.abs(x - roadX);
  const roadBlendStart = ROAD_WIDTH * 0.5 + SHOULDER_WIDTH;
  const blendWidth = 58.0;

  const broad = fbm(terrainNoise, x, z, 5, 0.0019, 1.0);
  const detail = fbm(detailNoise, x + 300, z - 900, 4, 0.008, 1.0);
  const ridgeNoise = fbm(terrainNoise, x - 800, z + 500, 3, 0.00095, 1.0);

  let terrain = -2 + broad * 28 + detail * 5;
  const mountainDistance = Math.max(0, distToRoad - 210);
  terrain += Math.pow(mountainDistance * 0.013, 1.25) * (20 + ridgeNoise * 18);

  const valleyShape = smoothstep(0, 190, distToRoad);
  terrain = THREE.MathUtils.lerp(terrain, terrain + roadY * 0.42, 1 - valleyShape);

  if (distToRoad <= roadBlendStart) {
    return roadY;
  }

  if (distToRoad < roadBlendStart + blendWidth) {
    const t = smoothstep(roadBlendStart, roadBlendStart + blendWidth, distToRoad);
    return THREE.MathUtils.lerp(roadY, terrain, t);
  }

  return THREE.MathUtils.clamp(terrain, -22, 82);
}

const TERRAIN_STOPS = [
  { h: -28, color: new THREE.Color(0x102c2d) },
  { h: -4, color: new THREE.Color(0x254637) },
  { h: 18, color: new THREE.Color(0x486b3d) },
  { h: 42, color: new THREE.Color(0x786b3e) },
  { h: 72, color: new THREE.Color(0x9a6a52) },
  { h: 112, color: new THREE.Color(0xc08d75) },
  { h: 160, color: new THREE.Color(0xe6b9a0) }
];

const SHOULDER_COLOR = new THREE.Color(0x302a21);

function getTerrainColor(height, distToRoad) {
  if (distToRoad < ROAD_WIDTH * 0.5 + SHOULDER_WIDTH + 4) {
    return SHOULDER_COLOR.clone();
  }

  for (let i = 0; i < TERRAIN_STOPS.length - 1; i++) {
    const a = TERRAIN_STOPS[i];
    const b = TERRAIN_STOPS[i + 1];
    if (height <= b.h) {
      const t = smoothstep(a.h, b.h, height);
      return a.color.clone().lerp(b.color, t);
    }
  }

  return TERRAIN_STOPS[TERRAIN_STOPS.length - 1].color.clone();
}

class WorldChunk {
  constructor(chunkIndex, length, scene) {
    this.chunkIndex = chunkIndex;
    this.length = length;
    this.startZ = chunkIndex * length;
    this.endZ = this.startZ + length;
    this.scene = scene;
    this.roadWidth = ROAD_WIDTH;
    this.terrainWidth = 680;
    this.terrainCenterX = getRoadX(this.startZ + this.length * 0.5);

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.meshes = [];

    this.buildGeometry();
  }

  buildGeometry() {
    this.buildTerrain();
    this.buildRoad();
    this.createRoadMarkings();
    this.createGuardRails();
    this.spawnVegetation();
    this.spawnRoadsideDetails();
  }

  buildTerrain() {
    const cols = 84;
    const rows = 38;
    const terrainGeo = new THREE.PlaneGeometry(this.terrainWidth, this.length, cols, rows);
    terrainGeo.rotateX(-Math.PI / 2);
    terrainGeo.translate(0, 0, this.length / 2);

    const pos = terrainGeo.attributes.position;
    const colors = [];

    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + this.terrainCenterX;
      const wz = this.startZ + pos.getZ(i);
      const wy = getTerrainHeight(wx, wz);
      const dist = Math.abs(wx - getRoadX(wz));
      const col = getTerrainColor(wy, dist);

      pos.setX(i, wx);
      pos.setY(i, wy);
      colors.push(col.r, col.g, col.b);
    }

    terrainGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    terrainGeo.computeVertexNormals();

    const terrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0.02,
      flatShading: true
    });

    const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
    terrainMesh.position.z = this.startZ;
    terrainMesh.receiveShadow = true;
    this.group.add(terrainMesh);
    this.meshes.push(terrainMesh);
  }

  buildDistantRidges() {
    const rows = 18;
    const ridgeMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1.0,
      metalness: 0,
      flatShading: true
    });

    [-1, 1].forEach(side => {
      const vertices = [];
      const colors = [];
      const indices = [];

      for (let i = 0; i <= rows; i++) {
        const t = i / rows;
        const wz = this.startZ + t * this.length;
        const centerX = getRoadX(wz);
        const nearX = centerX + side * this.terrainWidth * 0.42;
        const farX = centerX + side * this.terrainWidth * 0.78;
        const baseY = getTerrainHeight(nearX, wz) - 8;
        const peak = 74 + hash01(this.chunkIndex + i, side * 8.7) * 58;
        const farY = baseY + peak + Math.max(0, getTerrainHeight(farX, wz) * 0.18);

        vertices.push(nearX, baseY, wz, farX, farY, wz);

        const nearColor = new THREE.Color(0x45523a).lerp(new THREE.Color(0x9a6a52), clamp01((baseY + 20) / 110));
        const farColor = new THREE.Color(0x6b5161).lerp(new THREE.Color(0xd49a7a), clamp01(farY / 170));
        colors.push(nearColor.r, nearColor.g, nearColor.b, farColor.r, farColor.g, farColor.b);
      }

      for (let i = 0; i < rows; i++) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, ridgeMat);
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
    });
  }

  buildRoad() {
    const rows = 84;
    const offsets = [-11.5, -9.2, -6.2, -3.1, 0, 3.1, 6.2, 9.2, 11.5];
    const vertices = [];
    const colors = [];
    const uvs = [];
    const indices = [];

    const asphalt = new THREE.Color(0x30363a);
    const shoulder = new THREE.Color(0x4b4235);
    const crownTint = new THREE.Color(0x42494f);

    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      const wz = this.startZ + t * this.length;
      const tangent = getRoadTangent(wz);
      const right = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize();
      const centerX = getRoadX(wz);
      const centerY = getRoadElevation(wz);

      offsets.forEach((offset, c) => {
        const absOffset = Math.abs(offset);
        const crown = (1 - clamp01(absOffset / (ROAD_WIDTH * 0.5))) * 0.14;
        const shoulderDrop = Math.max(0, absOffset - ROAD_WIDTH * 0.5) * -0.035;
        const x = centerX + right.x * offset;
        const y = centerY + 0.08 + crown + shoulderDrop;
        const z = wz + right.z * offset;
        const laneT = clamp01(absOffset / (ROAD_WIDTH * 0.5 + SHOULDER_WIDTH));
        const color = asphalt.clone().lerp(shoulder, smoothstep(0.72, 1.0, laneT)).lerp(crownTint, 0.12 * (1 - laneT));

        vertices.push(x, y, z);
        colors.push(color.r, color.g, color.b);
        uvs.push(c / (offsets.length - 1), t * this.length * 0.08);
      });
    }

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < offsets.length - 1; c++) {
        const a = r * offsets.length + c;
        indices.push(a, a + 1, a + offsets.length, a + 1, a + offsets.length + 1, a + offsets.length);
      }
    }

    const roadGeo = new THREE.BufferGeometry();
    roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    roadGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    roadGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    roadGeo.setIndex(indices);
    roadGeo.computeVertexNormals();

    const roadMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.68,
      metalness: 0.08,
      emissive: 0x12100e,
      emissiveIntensity: 0.18,
      flatShading: false
    });

    const roadMesh = new THREE.Mesh(roadGeo, roadMat);
    roadMesh.receiveShadow = true;
    this.group.add(roadMesh);
    this.meshes.push(roadMesh);
  }

  createRoadMarkings() {
    const dashCount = 12;
    const dashLength = 7.4;
    const dashWidth = 0.34;
    const dashMat = new THREE.MeshBasicMaterial({
      color: 0xffd76a,
      transparent: true,
      opacity: 0.88
    });
    const dashGeo = new THREE.PlaneGeometry(dashWidth, dashLength);
    dashGeo.rotateX(-Math.PI / 2);

    for (let i = 0; i < dashCount; i++) {
      const wz = this.startZ + (i + 0.5) * (this.length / dashCount);
      const p = getRoadPosition(wz, 0, 0.24);
      const dash = new THREE.Mesh(dashGeo, dashMat);
      dash.position.copy(p);
      dash.rotation.y = getRoadAngle(wz);
      this.group.add(dash);
      this.meshes.push(dash);
    }

    const edgeMat = new THREE.MeshBasicMaterial({
      color: 0xf3efe1,
      transparent: true,
      opacity: 0.82
    });
    const edgeSegments = 22;
    const segLength = this.length / edgeSegments;
    const edgeGeo = new THREE.PlaneGeometry(0.22, segLength * 0.82);
    edgeGeo.rotateX(-Math.PI / 2);

    [-1, 1].forEach(side => {
      for (let i = 0; i < edgeSegments; i++) {
        const wz = this.startZ + (i + 0.5) * segLength;
        const p = getRoadPosition(wz, side * (ROAD_WIDTH * 0.5 - 0.55), 0.22);
        const edge = new THREE.Mesh(edgeGeo, edgeMat);
        edge.position.copy(p);
        edge.rotation.y = getRoadAngle(wz);
        this.group.add(edge);
        this.meshes.push(edge);
      }
    });
  }

  createGuardRails() {
    const spacing = 17.5;
    const perSide = Math.floor(this.length / spacing);
    const total = perSide * 2;
    const dummy = new THREE.Object3D();

    const postGeo = new THREE.BoxGeometry(0.18, 0.9, 0.18);
    postGeo.translate(0, 0.45, 0);
    const railGeo = new THREE.BoxGeometry(0.16, 0.16, spacing * 0.82);
    railGeo.translate(0, 0.78, 0);

    const metalMat = new THREE.MeshStandardMaterial({
      color: 0xb7b0a0,
      roughness: 0.42,
      metalness: 0.38
    });

    const posts = new THREE.InstancedMesh(postGeo, metalMat, total);
    const rails = new THREE.InstancedMesh(railGeo, metalMat, total);

    let idx = 0;
    [-1, 1].forEach(side => {
      for (let i = 0; i < perSide; i++) {
        const wz = this.startZ + (i + 0.5) * spacing;
        const p = getRoadPosition(wz, side * (ROAD_WIDTH * 0.5 + 2.35), 0.08);
        const angle = getRoadAngle(wz);

        dummy.position.copy(p);
        dummy.rotation.set(0, angle, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        posts.setMatrixAt(idx, dummy.matrix);

        const railPos = getRoadPosition(wz, side * (ROAD_WIDTH * 0.5 + 2.42), 0.08);
        dummy.position.copy(railPos);
        dummy.rotation.set(0, angle, 0);
        dummy.updateMatrix();
        rails.setMatrixAt(idx, dummy.matrix);

        idx++;
      }
    });

    posts.castShadow = true;
    rails.castShadow = true;
    posts.receiveShadow = true;
    rails.receiveShadow = true;
    this.group.add(posts, rails);
    this.meshes.push(posts, rails);
  }

  spawnVegetation() {
    const dummy = new THREE.Object3D();
    const treeCount = 92;
    const trunkGeo = new THREE.CylinderGeometry(0.38, 0.62, 3.4, 6);
    trunkGeo.translate(0, 1.7, 0);
    const lowerGeo = new THREE.ConeGeometry(2.9, 6.8, 7);
    lowerGeo.translate(0, 5.0, 0);
    const upperGeo = new THREE.ConeGeometry(2.0, 5.2, 7);
    upperGeo.translate(0, 8.0, 0);

    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3a2218, roughness: 0.86, flatShading: true });
    const foliageMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.9,
      metalness: 0,
      flatShading: true
    });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
    const lower = new THREE.InstancedMesh(lowerGeo, foliageMat, treeCount);
    const upper = new THREE.InstancedMesh(upperGeo, foliageMat, treeCount);
    const treePalette = [
      new THREE.Color(0x204d37),
      new THREE.Color(0x315b35),
      new THREE.Color(0x496b3a),
      new THREE.Color(0x5a7141),
      new THREE.Color(0x32615a)
    ];

    for (let i = 0; i < treeCount; i++) {
      const seed = hash01(this.chunkIndex * 37.2, i * 14.7);
      const wz = this.startZ + hash01(i * 8.1, this.chunkIndex * 3.9) * this.length;
      const side = hash01(i * 11.3, this.chunkIndex * 17.9) > 0.5 ? 1 : -1;
      const distance = 32 + Math.pow(seed, 1.7) * 260;
      const lateralJitter = (hash01(i * 21.8, this.chunkIndex) - 0.5) * 18;
      const wx = getRoadX(wz) + side * distance + lateralJitter;
      const wy = getTerrainHeight(wx, wz);
      const scale = 0.58 + hash01(i * 4.4, this.chunkIndex * 9.1) * 1.15;

      dummy.position.set(wx, wy, wz);
      dummy.rotation.set(0, hash01(i, this.chunkIndex) * Math.PI * 2, 0);
      dummy.scale.set(scale, scale * (0.92 + seed * 0.22), scale);
      dummy.updateMatrix();

      trunks.setMatrixAt(i, dummy.matrix);
      lower.setMatrixAt(i, dummy.matrix);
      upper.setMatrixAt(i, dummy.matrix);

      const color = treePalette[Math.floor(seed * treePalette.length)].clone();
      color.offsetHSL((seed - 0.5) * 0.04, 0.04, (seed - 0.5) * 0.1);
      lower.setColorAt(i, color);
      upper.setColorAt(i, color.clone().offsetHSL(0.015, 0.02, 0.08));
    }

    trunks.castShadow = true;
    lower.castShadow = true;
    upper.castShadow = true;
    trunks.receiveShadow = true;
    lower.receiveShadow = true;
    upper.receiveShadow = true;
    trunks.instanceMatrix.needsUpdate = true;
    lower.instanceMatrix.needsUpdate = true;
    upper.instanceMatrix.needsUpdate = true;
    lower.instanceColor.needsUpdate = true;
    upper.instanceColor.needsUpdate = true;

    this.group.add(trunks, lower, upper);
    this.meshes.push(trunks, lower, upper);

    const rockCount = 46;
    const rockGeo = new THREE.IcosahedronGeometry(1.25, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x4b4640, roughness: 0.98, flatShading: true });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);

    for (let i = 0; i < rockCount; i++) {
      const seed = hash01(this.chunkIndex * 5.3, i * 27.1);
      const wz = this.startZ + seed * this.length;
      const side = hash01(i * 3.2, this.chunkIndex * 8.7) > 0.5 ? 1 : -1;
      const wx = getRoadX(wz) + side * (18 + hash01(i, this.chunkIndex) * 95);
      const wy = getTerrainHeight(wx, wz);

      dummy.position.set(wx, wy + 0.08, wz);
      dummy.rotation.set(seed * Math.PI, seed * 6.28, seed * 2.5);
      dummy.scale.set(0.5 + seed * 1.7, 0.28 + seed * 0.9, 0.5 + hash01(i * 9.1, seed) * 1.8);
      dummy.updateMatrix();
      rocks.setMatrixAt(i, dummy.matrix);
    }

    rocks.castShadow = true;
    rocks.receiveShadow = true;
    rocks.instanceMatrix.needsUpdate = true;
    this.group.add(rocks);
    this.meshes.push(rocks);
  }

  spawnRoadsideDetails() {
    const dummy = new THREE.Object3D();
    const reflectorSpacing = 27;
    const perSide = Math.floor(this.length / reflectorSpacing);
    const total = perSide * 2;
    const postGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.72, 6);
    postGeo.translate(0, 0.36, 0);
    const capGeo = new THREE.BoxGeometry(0.22, 0.13, 0.05);
    capGeo.translate(0, 0.68, 0);
    const postMat = new THREE.MeshStandardMaterial({ color: 0xd7d2be, roughness: 0.5 });
    const capMat = new THREE.MeshBasicMaterial({ color: 0xffc463 });
    const posts = new THREE.InstancedMesh(postGeo, postMat, total);
    const caps = new THREE.InstancedMesh(capGeo, capMat, total);

    let idx = 0;
    [-1, 1].forEach(side => {
      for (let i = 0; i < perSide; i++) {
        const wz = this.startZ + (i + 0.35) * reflectorSpacing;
        const p = getRoadPosition(wz, side * (ROAD_WIDTH * 0.5 + 4.7), 0.04);
        dummy.position.copy(p);
        dummy.rotation.set(0, getRoadAngle(wz) + side * 0.18, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        posts.setMatrixAt(idx, dummy.matrix);
        caps.setMatrixAt(idx, dummy.matrix);
        idx++;
      }
    });

    posts.castShadow = true;
    posts.instanceMatrix.needsUpdate = true;
    caps.instanceMatrix.needsUpdate = true;
    this.group.add(posts, caps);
    this.meshes.push(posts, caps);

    if (this.chunkIndex % 2 === 0) {
      const signZ = this.startZ + this.length * (0.38 + hash01(this.chunkIndex, 5.2) * 0.3);
      const side = hash01(this.chunkIndex, 8.9) > 0.5 ? 1 : -1;
      const signPos = getRoadPosition(signZ, side * (ROAD_WIDTH * 0.5 + 7.2), 0.08);
      const sign = new THREE.Group();
      sign.position.copy(signPos);
      sign.rotation.y = getRoadAngle(signZ) - side * 0.2;

      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.25, 8), postMat);
      pole.position.y = 1.12;
      pole.castShadow = true;
      sign.add(pole);

      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(1.15, 0.7, 0.08),
        new THREE.MeshStandardMaterial({ color: 0x2b6f7f, roughness: 0.35, metalness: 0.25 })
      );
      panel.position.y = 2.15;
      panel.castShadow = true;
      sign.add(panel);

      this.group.add(sign);
      this.meshes.push(sign);
    }
  }

  spawnColliders() {
    // Scenic drive: no lane obstacles. This keeps the one-minute run focused on cruising,
    // not twitch avoidance.
  }

  destroy() {
    this.group.traverse(node => {
      if (node.isMesh) {
        if (node.geometry) node.geometry.dispose();
        if (node.material) {
          if (Array.isArray(node.material)) {
            node.material.forEach(m => m.dispose());
          } else {
            node.material.dispose();
          }
        }
      }
    });

    this.group.clear();
    this.scene.remove(this.group);
    this.meshes = [];
  }
}

export class WorldManager {
  constructor(scene) {
    this.scene = scene;
    this.chunkLength = 220.0;
    this.chunkCount = 7;
    this.chunks = [];
    this.colliders = [];

    this.init();
  }

  init() {
    this.colliders = [];
    for (let i = -1; i < this.chunkCount - 1; i++) {
      const chunk = new WorldChunk(i, this.chunkLength, this.scene);
      chunk.spawnColliders(this.colliders);
      this.chunks.push(chunk);
    }
  }

  update(carZ) {
    const activeChunkIndex = Math.floor(carZ / this.chunkLength);
    const targetMinIndex = activeChunkIndex - 1;

    while (this.chunks[0] && this.chunks[0].chunkIndex < targetMinIndex) {
      const oldChunk = this.chunks.shift();
      const newIndex = this.chunks[this.chunks.length - 1].chunkIndex + 1;

      oldChunk.destroy();
      this.colliders = this.colliders.filter(c => c.chunkIndex !== oldChunk.chunkIndex);

      const newChunk = new WorldChunk(newIndex, this.chunkLength, this.scene);
      newChunk.spawnColliders(this.colliders);
      this.chunks.push(newChunk);
    }
  }

  updateColliders() {
    // Reserved for future scenic AI traffic. Current build intentionally has no hazards.
  }

  clear() {
    this.chunks.forEach(chunk => chunk.destroy());
    this.chunks = [];
    this.colliders = [];
  }
}

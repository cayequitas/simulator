// Atmosphere: a room-filling haze layer plus fog-machine / low-fog particles.
// Particles are camera-facing quads lit per vertex by every fixture cone and the LED wall,
// so beams sweeping through the fog light it up.
import * as THREE from 'three';
import { NUM_LIGHTS, ROOM, RIG, LED } from './config.js';
import { noiseVolume } from './haze.js';

const VS = /* glsl */ `
#define NL ${NUM_LIGHTS}
attribute vec3 iPos; attribute float iAlpha; attribute float iSize; attribute float iSeed;
uniform vec3 uLPos[NL]; uniform vec3 uLDir[NL]; uniform float uLCos[NL]; uniform vec3 uLCol[NL];
uniform vec3 uAmbient; uniform vec3 uLed[3]; uniform float uTime;
varying vec2 vUv; varying float vAlpha; varying vec3 vCol; varying float vY; varying vec3 vWp; varying float vSeed;
void main() {
  float a = iSeed * 6.283 + uTime * 0.04 * (iSeed - 0.5);
  vec2 c = mat2(cos(a), sin(a), -sin(a), cos(a)) * position.xy;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wp = iPos + (right * c.x + up * c.y) * iSize;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  vUv = position.xy + 0.5;
  vY = wp.y;
  vWp = wp;
  vSeed = iSeed;
  vec3 lit = uAmbient;
  for (int i = 0; i < NL; i++) {
    vec3 d = wp - uLPos[i];
    float dist = length(d);
    float cs = dot(d / max(dist, 0.001), uLDir[i]);
    float cone = smoothstep(uLCos[i], mix(uLCos[i], 1.0, 0.3), cs);
    lit += uLCol[i] * cone / (1.0 + dist * dist * 0.015);
  }
  // glow from the LED wall (left / centre / right thirds)
  float wallFall = exp(-max(wp.z, 0.0) * 0.18) * smoothstep(${(LED.bottom + LED.height + 3).toFixed(1)}, ${LED.bottom.toFixed(1)}, wp.y);
  float sx = clamp((wp.x / ${LED.width.toFixed(1)} + 0.5) * 3.0 - 0.5, 0.0, 2.0);
  vec3 led = sx < 1.0 ? mix(uLed[0], uLed[1], sx) : mix(uLed[1], uLed[2], sx - 1.0);
  lit += led * wallFall;
  vCol = lit;
  vAlpha = iAlpha;
}
`;

// Each puff is a camera-facing slice through a drifting 3D noise field, so overlapping puffs
// read as one continuous, evolving volume of smoke instead of separate sprites.
const FS = /* glsl */ `
precision highp sampler3D;
uniform sampler2D uPuff; uniform sampler3D uNoise; uniform float uTime; uniform float uDrift;
varying vec2 vUv; varying float vAlpha; varying vec3 vCol; varying float vY; varying vec3 vWp; varying float vSeed;
void main() {
  float shape = texture2D(uPuff, vUv).r;
  vec3 flow = vec3(0.02, 0.012, -0.015) * uTime * uDrift;
  float warp = texture(uNoise, vWp * 0.04 - flow).r;
  float n = texture(uNoise, vWp * 0.11 + flow + warp * 0.35).r * 0.65 + texture(uNoise, vWp * 0.33 - flow * 1.7).r * 0.35;
  float wisps = smoothstep(0.25, 0.8, n);
  float a = (shape * 0.45 + shape * wisps * 1.4) * vAlpha * smoothstep(0.0, 0.6, vY);
  if (a < 0.002) discard;
  gl_FragColor = vec4(vCol * a, a * 0.55);   // premultiplied: adds scattered light, slightly obscures
}
`;

// Wispy cloud sprite: fractal value noise under a soft radial falloff.
function puffTexture() {
  const N = 256, G = 16;
  let s = 11;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const lattice = Float32Array.from({ length: G * G }, r);
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const at = (i, j) => lattice[((j % G + G) % G) * G + ((i % G + G) % G)];
    return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v) + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v;
  };
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  const img = g.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let f = 0, a = 0.5, fx = (x / N) * 4, fy = (y / N) * 4;
    for (let o = 0; o < 5; o++) { f += a * noise(fx, fy); fx *= 2; fy *= 2; a *= 0.5; }
    const d = Math.hypot(x - N / 2, y - N / 2) / (N / 2);
    const fall = Math.max(0, 1 - d * d);
    const v = Math.max(0, f * 1.6 - 0.45) * fall * fall;
    const i = (y * N + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.min(255, v * 255);
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

const MAX = 1100;
const HAZE_N = 0;   // room haze is rendered inside the beams now (see fixtures.js)

export class Atmosphere {
  constructor(scene) {
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iAlpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
    this.iSize = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
    this.iSeed = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.iPos);
    geo.setAttribute('iAlpha', this.iAlpha);
    geo.setAttribute('iSize', this.iSize);
    geo.setAttribute('iSeed', this.iSeed);
    geo.instanceCount = 0;
    this.geo = geo;
    const v3 = () => Array.from({ length: NUM_LIGHTS }, () => new THREE.Vector3());
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS,
      uniforms: {
        uLPos: { value: v3() }, uLDir: { value: v3() }, uLCos: { value: new Array(NUM_LIGHTS).fill(1) },
        uLCol: { value: v3() }, uAmbient: { value: new THREE.Vector3() }, uLed: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
        uTime: { value: 0 }, uPuff: { value: puffTexture() }, uNoise: { value: noiseVolume() }, uDrift: { value: 1 },
      },
      transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);

    this.fog = new THREE.FogExp2(0x000000, 0.01);
    scene.fog = this.fog;

    // haze cells fill the room volume and drift slowly
    this.haze = [];
    for (let i = 0; i < HAZE_N; i++) {
      this.haze.push({
        p: new THREE.Vector3((Math.random() - 0.5) * (ROOM.width - 2), 0.8 + Math.random() * 8.5, 0.5 + Math.random() * (ROOM.depth - 1)),
        v: new THREE.Vector3((Math.random() - 0.5) * 0.15, (Math.random() - 0.5) * 0.04, (Math.random() - 0.5) * 0.15),
        size: 6 + Math.random() * 5, seed: Math.random(),
      });
    }
    this.parts = [];
    this.emitAcc = 0;
  }

  burst(n = 160, low = false) { for (let i = 0; i < n; i++) this.spawn(RIG.fogMachines[i % RIG.fogMachines.length], low); }

  spawn(m, low) {
    if (this.parts.length >= MAX - HAZE_N) return;
    const d = new THREE.Vector3(...m.dir).normalize();
    const speed = low ? 1.6 + Math.random() * 1.2 : 2.5 + Math.random() * 2.5;
    this.parts.push({
      p: new THREE.Vector3(m.x + (Math.random() - 0.5) * 0.3, low ? 0.15 : 0.45, m.z),
      v: d.multiplyScalar(speed).add(new THREE.Vector3((Math.random() - 0.5) * 0.8, low ? 0 : 0.3 + Math.random() * 0.4, (Math.random() - 0.5) * 0.8)),
      age: 0, life: low ? 16 + Math.random() * 10 : 9 + Math.random() * 7,
      s0: 1.0 + Math.random() * 0.8, s1: low ? 5 + Math.random() * 4 : 5 + Math.random() * 5,
      seed: Math.random(), low,
    });
  }

  update(dt, time, a, lights, ledAvg, ambient) {
    const low = a.fogMode === 'Low fog';
    // continuous output from the machines
    this.emitAcc += dt * a.fogOutput * 60;
    while (this.emitAcc >= 1) {
      this.emitAcc -= 1;
      this.spawn(RIG.fogMachines[Math.floor(Math.random() * (low ? 2 : RIG.fogMachines.length))], low);
    }
    // global haze → exponential fog density
    this.fog.density = 0.003 + a.haze * 0.02;

    let n = 0;
    const P = this.iPos.array, A = this.iAlpha.array, S = this.iSize.array, E = this.iSeed.array;
    const W = ROOM.width / 2 - 0.5;
    for (const h of this.haze) {
      h.p.addScaledVector(h.v, dt);
      if (h.p.x < -W) h.p.x += 2 * W; else if (h.p.x > W) h.p.x -= 2 * W;
      if (h.p.z < 0.5) h.p.z += ROOM.depth - 1; else if (h.p.z > ROOM.depth - 0.5) h.p.z -= ROOM.depth - 1;
      h.p.y = THREE.MathUtils.clamp(h.p.y, 0.8, 9.3);
      P[n * 3] = h.p.x; P[n * 3 + 1] = h.p.y; P[n * 3 + 2] = h.p.z;
      A[n] = 0;
      S[n] = h.size; E[n] = h.seed;
      n++;
    }
    const alive = [];
    for (const q of this.parts) {
      q.age += dt;
      if (q.age > q.life) continue;
      alive.push(q);
      // drag + buoyancy + gentle turbulence
      q.v.multiplyScalar(Math.exp(-dt * (q.low ? 0.35 : 0.55)));
      q.v.y += dt * (q.low ? -0.05 : 0.06);
      q.v.x += Math.sin(q.p.z * 0.5 + time * 0.7 + q.seed * 6) * dt * 0.15;
      q.v.z += Math.cos(q.p.x * 0.5 + time * 0.6) * dt * 0.1;
      q.p.addScaledVector(q.v, dt);
      const t = q.age / q.life;
      const size = q.s0 + (q.s1 - q.s0) * Math.sqrt(t);
      if (q.low) q.p.y = Math.max(q.p.y, size * 0.12);
      q.p.y = Math.min(q.p.y, 9);
      q.p.x = THREE.MathUtils.clamp(q.p.x, -W, W);
      q.p.z = THREE.MathUtils.clamp(q.p.z, 0.4, ROOM.depth - 0.5);
      const env = Math.min(1, q.age / 0.6) * (1 - THREE.MathUtils.smoothstep(t, 0.5, 1));
      P[n * 3] = q.p.x; P[n * 3 + 1] = q.p.y; P[n * 3 + 2] = q.p.z;
      A[n] = env * a.fogDensity * (q.low ? 0.45 : 0.3);
      S[n] = size; E[n] = q.seed;
      n++;
    }
    this.parts = alive;
    this.geo.instanceCount = n;
    this.iPos.needsUpdate = this.iAlpha.needsUpdate = this.iSize.needsUpdate = this.iSeed.needsUpdate = true;

    const u = this.mat.uniforms;
    u.uTime.value = time;
    u.uDrift.value = a.drift;
    lights.forEach((f, i) => {
      u.uLPos.value[i].copy(f.worldPos);
      u.uLDir.value[i].copy(f.worldDir);
      u.uLCos.value[i] = Math.cos(f.halfAngle);
      u.uLCol.value[i].set(f.color.r, f.color.g, f.color.b).multiplyScalar(f.level * a.scatter * (f.isBar ? 0.5 : 1.0));
    });
    for (let i = 0; i < 3; i++) u.uLed.value[i].set(ledAvg[i].r, ledAvg[i].g, ledAvg[i].b).multiplyScalar(a.scatter * 1.5);
    u.uAmbient.value.copy(ambient);
    return n;
  }
}

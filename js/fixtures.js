// Lighting fixtures: moving heads and LED batten/strobe bars, each with a real SpotLight,
// a ray-marched volumetric beam (animated haze noise + gobo) and an emissive lens.
import * as THREE from 'three';
import { TRUSS } from './config.js';
import { glowTexture } from './venue.js';
import { noiseVolume } from './haze.js';
import { GOBO_UNIFORMS, goboCell } from './gobos.js';

const BEAM_VS = /* glsl */ `
uniform float uLen; uniform float uTan; uniform float uLens;
varying vec3 vWorld;
void main() {
  float t = -position.y;                         // 0 at lens … 1 at far end
  float r = (uLens + uTan * t * uLen) * 1.04;    // slightly outside the true cone
  vec4 w = modelMatrix * vec4(position.x * r, -t * uLen, position.z * r, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// The cone mesh only provides fragments: the light is integrated along the view ray through the
// analytic cone, sampling a drifting 3D noise volume (the haze) and the gobo at every step.
const BEAM_FS = /* glsl */ `
precision highp sampler3D;
uniform vec3 uOrigin; uniform vec3 uDir; uniform vec3 uUp;
uniform float uTan; uniform float uLens; uniform float uLen;
uniform vec3 uColor; uniform float uInt; uniform float uHaze; uniform float uTime;
uniform float uTurb; uniform float uScale; uniform float uFlow; uniform float uFogBoost; uniform float uSteps;
uniform sampler3D uNoise; uniform sampler2D uGoboAtlas; uniform vec3 uGobo;   // atlas cell xy, rotation
uniform vec3 uFogColor; uniform float uFogDensity;
varying vec3 vWorld;

vec2 clipHalf(float s0, float sv, vec2 iv) {     // keep the part of the ray where s0 + t*sv >= 0
  if (abs(sv) < 1e-6) return s0 < 0.0 ? vec2(1.0, 0.0) : iv;
  float t = -s0 / sv;
  if (sv > 0.0) iv.x = max(iv.x, t); else iv.y = min(iv.y, t);
  return iv;
}

void main() {
  vec3 C = cameraPosition;
  vec3 v = normalize(vWorld - C);
  float tFrag = length(vWorld - C);
  float cos2 = 1.0 / (1.0 + uTan * uTan);
  vec3 A = uOrigin - uDir * (uLens / uTan);       // virtual apex behind the lens
  vec3 co = C - A;
  float vd = dot(v, uDir), cd = dot(co, uDir);
  float a = vd * vd - cos2, b = 2.0 * (vd * cd - cos2 * dot(v, co)), c = cd * cd - cos2 * dot(co, co);
  vec2 iv;
  if (gl_FrontFacing) {
    float tExit = tFrag + 60.0;
    float disc = b * b - 4.0 * a * c;
    if (disc > 0.0 && abs(a) > 1e-6) {
      float sq = sqrt(disc);
      float t1 = (-b - sq) / (2.0 * a), t2 = (-b + sq) / (2.0 * a);
      float lo = min(t1, t2), hi = max(t1, t2);
      tExit = hi > tFrag ? hi : (lo > tFrag ? lo : tExit);
    }
    iv = vec2(tFrag * 0.98, tExit);
  } else {
    if (!(c > 0.0 && cd > 0.0)) discard;           // back faces only matter with the camera inside the beam
    iv = vec2(0.0, tFrag);
  }
  float s0 = dot(C - uOrigin, uDir), sv = dot(v, uDir);
  iv = clipHalf(s0, sv, iv);                       // in front of the lens
  iv = clipHalf(uLen - s0, -sv, iv);               // within beam length
  iv = clipHalf(C.y, v.y, iv);                     // above the floor
  iv = clipHalf(C.z, v.z, iv);                     // in front of the LED wall
  iv.x = max(iv.x, 0.0);
  if (iv.y <= iv.x) discard;

  vec3 right = normalize(cross(uDir, uUp));
  vec3 up2 = cross(right, uDir);
  float cr = cos(uGobo.z), sr = sin(uGobo.z);
  int steps = int(uSteps);
  float dt = (iv.y - iv.x) / uSteps;
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec3 flow1 = vec3(0.012, -0.025, 0.018) * uTime * uFlow;
  vec3 flow2 = vec3(-0.03, 0.01, -0.02) * uTime * uFlow;
  vec3 acc = vec3(0.0);
  for (int k = 0; k < steps; k++) {
    float t = iv.x + (float(k) + jitter) * dt;
    vec3 X = C + v * t;
    vec3 rel = X - uOrigin;
    float ax = max(dot(rel, uDir), 0.0);
    float R = uLens + uTan * ax;
    vec2 q = vec2(dot(rel, right), dot(rel, up2)) / R;
    if (length(q) > 1.0) continue;
    q = mat2(cr, -sr, sr, cr) * q;
    vec3 g = textureLod(uGoboAtlas, uGobo.xy + (q * 0.5 + 0.5) * 0.24 + 0.005, 0.0).rgb;
    // haze: two drifting octaves of the domain-warped noise volume, the second one advected by a third
    vec3 P = X * uScale;
    float warp = textureLod(uNoise, P * 0.05 - flow1, 0.0).r;
    float n = textureLod(uNoise, P * 0.09 + flow1, 0.0).r * 0.62 + textureLod(uNoise, P * 0.27 + flow2 + warp * 0.4, 0.0).r * 0.38;
    float dens = mix(1.0, smoothstep(0.18, 0.82, n) * 2.2, uTurb);
    dens *= 1.0 + uFogBoost * smoothstep(3.5, 0.3, X.y) * (0.5 + n);
    // flux spreads over the cross-section; mild loss along the beam
    float spread = 1.0 / (R * R + 0.04);
    acc += g * dens * spread / (1.0 + ax * 0.04);
  }
  vec3 col = uColor * acc * dt * uInt * uHaze;
  float dist = iv.x + (iv.y - iv.x) * 0.5;
  col *= exp(-uFogDensity * uFogDensity * dist * dist * 0.5);
  gl_FragColor = vec4(col, 1.0);
}
`;

const unitCone = (() => {
  const g = new THREE.CylinderGeometry(1, 1, 1, 48, 1, true);
  g.translate(0, -0.5, 0);
  return g;
})();

function beamMaterial(lens) {
  return new THREE.ShaderMaterial({
    vertexShader: BEAM_VS, fragmentShader: BEAM_FS,
    uniforms: {
      uLen: { value: 26 }, uTan: { value: 0.05 }, uLens: { value: lens },
      uOrigin: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3(0, -1, 0) }, uUp: { value: new THREE.Vector3(0, 0, 1) },
      uColor: { value: new THREE.Color() }, uInt: { value: 0 }, uHaze: { value: 0.5 }, uTime: { value: 0 },
      uTurb: { value: 0.8 }, uScale: { value: 1 }, uFlow: { value: 1 }, uFogBoost: { value: 0 }, uSteps: { value: 12 },
      uNoise: { value: noiseVolume() }, uGoboAtlas: GOBO_UNIFORMS.uGoboAtlas, uGobo: { value: new THREE.Vector3() },
      uFogColor: { value: new THREE.Color() }, uFogDensity: { value: 0 },
    },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

const GLOW = glowTexture();
const bodyWhite = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.45, metalness: 0.1 });
const bodyBlack = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.5, metalness: 0.2 });
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

class Fixture {
  constructor() {
    this.level = 0;                         // final 0..1 after FX / strobe / master
    this.color = new THREE.Color();
    this.worldPos = new THREE.Vector3();
    this.worldDir = new THREE.Vector3(0, -1, 0);
    this.worldUp = new THREE.Vector3(0, 0, 1);
    this.halfAngle = 0.1;
    this.gobo = 0;                          // atlas index (GOBOS)
    this.goboAngle = 0;                     // radians
  }

  makeBeam(parent, y, lens, spotDistance, steps) {
    this.beamMat = beamMaterial(lens);
    this.baseSteps = steps;
    this.beam = new THREE.Mesh(unitCone, this.beamMat);
    this.beam.position.y = y;
    this.beam.frustumCulled = false;
    this.beam.renderOrder = 10;
    this.spot = new THREE.SpotLight(0xffffff, 0, spotDistance, 0.2, 0.5, 2);
    this.spot.position.y = y;
    this.target = new THREE.Object3D();
    this.target.position.y = y - 5;
    this.spot.target = this.target;
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: GLOW, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false,
    }));
    this.glow.position.y = y - 0.02;
    this.glow.renderOrder = 11;
    parent.add(this.beam, this.spot, this.target, this.glow);
    this.emitterParent = parent;
    this.emitterY = y;
  }

  // Shared output stage: drives spot light, beam shader, lens and glow.
  // hz = { haze, turb, scale, flow, fogBoost }
  apply(time, hz, fog, camera, spotGain, beamGain, glowSize, useSpot) {
    const L = this.level;
    const tanH = Math.tan(this.halfAngle);
    // world-space emitter position, beam direction and gobo "up" (turns with the head)
    this.emitterParent.getWorldQuaternion(_q);
    this.worldDir.set(0, -1, 0).applyQuaternion(_q);
    this.worldUp.set(0, 0, 1).applyQuaternion(_q);
    this.worldPos.set(0, this.emitterY, 0);
    this.emitterParent.localToWorld(this.worldPos);

    this.spot.angle = Math.min(this.halfAngle * 1.05, Math.PI / 2 - 0.01);
    this.spot.color.copy(this.color);
    // narrower beam → brighter pool (same flux into a smaller solid angle)
    const focus = THREE.MathUtils.clamp(0.35 / tanH, 1, 25);
    this.spot.intensity = useSpot ? L * spotGain * focus : 0;
    const u = this.beamMat.uniforms;
    u.uTan.value = tanH;
    u.uOrigin.value.copy(this.worldPos);
    u.uDir.value.copy(this.worldDir);
    u.uUp.value.copy(this.worldUp);
    u.uColor.value.copy(this.color);
    u.uInt.value = L * beamGain;
    u.uHaze.value = hz.haze;
    u.uTime.value = time;
    u.uTurb.value = hz.turb;
    u.uScale.value = hz.scale;
    u.uFlow.value = hz.flow;
    u.uFogBoost.value = hz.fogBoost;
    u.uSteps.value = Math.max(4, Math.round(this.baseSteps * hz.steps));
    const cell = goboCell(this.gobo);
    u.uGobo.value.set(cell.x, cell.y, this.goboAngle);
    u.uFogColor.value.copy(fog.color);
    u.uFogDensity.value = fog.density;
    this.beam.visible = L > 0.001 && hz.haze > 0.001;

    this.lensMat.color.copy(this.color).multiplyScalar(L * 6);
    // lens flare grows when looking into the beam
    _v.subVectors(camera.position, this.worldPos).normalize();
    const facing = Math.max(0, this.worldDir.dot(_v));
    const flare = Math.pow(facing, 8) * 3 + 0.5;
    this.glow.material.color.copy(this.color).multiplyScalar(L * flare);
    this.glow.scale.setScalar(glowSize * (0.6 + flare * 0.5));
    this.glow.visible = L > 0.001;
  }
}

export class MovingHead extends Fixture {
  constructor(parent, x, z, white = true) {
    super();
    const body = white ? bodyWhite : bodyBlack;
    this.root = new THREE.Group();
    this.root.position.set(x, TRUSS.y, z);
    parent.add(this.root);
    const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.08), bodyBlack);
    clamp.position.y = -0.03;
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.32), body);
    base.position.y = -0.17;
    this.root.add(clamp, base);
    this.yoke = new THREE.Group();
    this.yoke.position.y = -0.25;
    this.root.add(this.yoke);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.05, 0.16), body);
    plate.position.y = -0.025;
    this.yoke.add(plate);
    for (const sx of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.4, 0.15), body);
      arm.position.set(sx * 0.21, -0.2, 0);
      this.yoke.add(arm);
    }
    this.head = new THREE.Group();
    this.head.position.y = -0.36;
    this.yoke.add(this.head);
    const hb = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.4, 24), body);
    this.head.add(hb);
    this.lensMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.12, 24), this.lensMat);
    lens.rotation.x = Math.PI / 2;
    lens.position.y = -0.202;
    this.head.add(lens);
    this.makeBeam(this.head, -0.21, 0.07, 60, 18);
    this.pan = 0; this.tilt = 0;           // degrees, smoothed
    this.panTarget = 0; this.tiltTarget = 0;
  }

  // Direction for pan p / tilt t (hanging): (sin t · sin p, −cos t, sin t · cos p)
  static aimAngles(from, to) {
    const d = _v.subVectors(to, from).normalize();
    return { pan: THREE.MathUtils.radToDeg(Math.atan2(d.x, d.z)), tilt: THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(-d.y, -1, 1))) };
  }

  move(dt) {
    const k = 1 - Math.exp(-dt * 9);
    this.pan += (this.panTarget - this.pan) * k;
    this.tilt += (this.tiltTarget - this.tilt) * k;
    this.yoke.rotation.y = THREE.MathUtils.degToRad(this.pan);
    this.head.rotation.x = -THREE.MathUtils.degToRad(this.tilt);
  }
}

export class LedBar extends Fixture {
  constructor(parent, x, z) {
    super();
    this.isBar = true;
    this.root = new THREE.Group();
    this.root.position.set(x, TRUSS.y, z);
    parent.add(this.root);
    const hanger = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.05), bodyBlack);
    hanger.position.y = -0.04;
    this.root.add(hanger);
    this.pivot = new THREE.Group();
    this.pivot.position.y = -0.18;
    this.root.add(this.pivot);
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.13, 0.22),
      new THREE.MeshStandardMaterial({ color: 0x2b2a24, roughness: 0.5, metalness: 0.3 }));
    this.pivot.add(body);
    this.lensMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const em = new THREE.Mesh(new THREE.PlaneGeometry(0.94, 0.15), this.lensMat);
    em.rotation.x = Math.PI / 2;
    em.position.y = -0.066;
    this.pivot.add(em);
    this.makeBeam(this.pivot, -0.07, 0.42, 40, 10);
    this.halfAngle = THREE.MathUtils.degToRad(28);
  }

  setTilt(deg) { this.pivot.rotation.x = -THREE.MathUtils.degToRad(deg); }
}

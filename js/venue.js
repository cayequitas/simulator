// Static architecture: room shell, polished concrete floor (with planar reflection),
// steel ceiling, spiral ducts, truss grid with hoists, PA hangs and DJ booth.
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROOM, TRUSS, LED } from './config.js';
import { NOISE } from './glsl.js';

// ---------- procedural textures ----------
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function rand(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Vertical flutes on the riser below the LED wall.
function flutedNormal() {
  return canvasTex(64, 4, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let x = 0; x < w; x++) {
      const nx = Math.sin((x / w) * Math.PI * 2) * 0.8;
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        img.data[i] = (nx * 0.5 + 0.5) * 255;
        img.data[i + 1] = 128;
        img.data[i + 2] = 255;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, false);
}

// Spiral seams on the round ducts.
function ductNormal() {
  return canvasTex(64, 64, (g, w, h) => {
    g.fillStyle = 'rgb(128,128,255)';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgb(128,40,220)';
    g.lineWidth = 3;
    for (let k = -1; k <= 1; k++) {
      g.beginPath(); g.moveTo(0, k * h + h * 0.5); g.lineTo(w, k * h + h * 0.5 + h * 0.3); g.stroke();
    }
  }, false);
}

export function glowTexture() {
  const t = canvasTex(128, 128, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.15, 'rgba(255,255,255,0.5)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.08)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// Polished concrete screed: multi-scale mottling, aggregate specks, burnish streaks, hairline cracks.
// Computed once per floor point into a texture at startup (no tiling, and far cheaper than per-frame noise).
// r = tone, g = roughness variation.
function bakeConcrete(renderer, W, D, minZ, size) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    depthBuffer: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
  });
  rt.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      varying vec2 vUv;
      ${NOISE}
      void main() {
        vec2 p = vec2(vUv.x * ${W.toFixed(2)} - ${(W / 2).toFixed(2)}, vUv.y * ${D.toFixed(2)} + ${minZ.toFixed(2)});
        float macro = fbm(vec3(p * 0.045, 1.3));
        float mid = fbm(vec3(p * 0.35, 5.7));
        float fine = vnoise(vec3(p * 9.0, 2.0)) * 0.6 + vnoise(vec3(p * 23.0, 4.0)) * 0.4;
        vec2 cell = floor(p * 110.0);
        float h = hash13(vec3(cell, 3.0));
        float speck = step(0.982, h) * (hash13(vec3(cell, 9.0)) > 0.5 ? 1.0 : -1.0);
        vec2 warp = p + vec2(fbm(vec3(p * 0.15, 8.0)), fbm(vec3(p * 0.15, 9.0))) * 3.0;
        float swirl = smoothstep(0.45, 0.75, fbm(vec3(warp.x * 0.5, warp.y * 2.2, 12.0)));
        float n = fbm(vec3(p * 0.18, 11.0));
        float crack = (1.0 - smoothstep(0.0, 0.006, abs(n - 0.5))) * smoothstep(0.55, 0.7, fbm(vec3(p * 0.07, 21.0)));
        float tone = 0.82 + (macro - 0.5) * 0.65 + (mid - 0.5) * 0.4 + (fine - 0.5) * 0.14
                   + speck * 0.12 + swirl * 0.07 - crack * 0.3;
        float rough = (mid - 0.5) * 0.3 + (macro - 0.5) * 0.35 - swirl * 0.15 + crack * 0.3;
        gl_FragColor = vec4(tone / 1.5, (rough + 0.6) / 1.2, 0.0, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  const scene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  // in small tiles, so slower GPUs never choke on one huge draw call
  const tiles = 8, tile = size / tiles, gl = renderer.getContext();
  const prevAuto = renderer.autoClear;
  renderer.autoClear = false;
  rt.scissorTest = true;
  renderer.setRenderTarget(rt);
  for (let y = 0; y < tiles; y++) for (let x = 0; x < tiles; x++) {
    rt.scissor.set(x * tile, y * tile, tile, tile);
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    gl.flush();
  }
  rt.scissorTest = false;
  renderer.setRenderTarget(null);
  renderer.autoClear = prevAuto;
  mat.dispose();
  quad.geometry.dispose();
  return rt.texture;
}

function concreteMaterial(renderer, reflector, W, D, minZ) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0 });
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const size = renderer.capabilities.maxTextureSize >= 8192 && !mobile ? 4096 : 2048;
  const uniforms = {
    uReflTex: { value: reflector.getRenderTarget().texture },
    uReflMatrix: { value: reflector.material.uniforms.textureMatrix.value },
    uConcrete: { value: bakeConcrete(renderer, W, D, minZ, size) },
    uFloorMin: { value: new THREE.Vector2(-W / 2, minZ) },
    uFloorSize: { value: new THREE.Vector2(W, D) },
    uGloss: { value: 0.6 },
    uPolish: { value: 0.6 },
    uTaps: { value: 12 },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform mat4 uReflMatrix;
        varying vec3 vFloorW;
        varying vec4 vReflUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vFloorW = (modelMatrix * vec4(position, 1.0)).xyz;
        vReflUv = uReflMatrix * vec4(position, 1.0);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uReflTex; uniform sampler2D uConcrete;
        uniform vec2 uFloorMin; uniform vec2 uFloorSize;
        uniform float uGloss; uniform float uPolish; uniform float uTaps;
        varying vec3 vFloorW;
        varying vec4 vReflUv;
        float concreteRough;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec4 baked = texture2D(uConcrete, (vFloorW.xz - uFloorMin) / uFloorSize);
          diffuseColor.rgb *= vec3(0.27, 0.268, 0.255) * baked.r * 1.5;   // linear mid-grey with a slight warm cast
          concreteRough = clamp(0.6 - uPolish * 0.42 + baked.g * 1.2 - 0.6, 0.1, 0.95);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = concreteRough;`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        {
          // blurred planar reflection; blur radius follows local roughness
          vec2 ruv = vReflUv.xy / vReflUv.w;
          float blur = concreteRough * concreteRough * 0.035 + 0.0015;
          float jitter = 6.28 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          vec3 refl = vec3(0.0);
          float wsum = 0.0;
          int taps = int(uTaps);
          for (int k = 0; k < taps; k++) {
            float a = float(k) * 2.39996 + jitter;
            float r = sqrt((float(k) + 0.5) / uTaps);
            float w = 1.0 - r * 0.6;
            refl += textureLod(uReflTex, ruv + vec2(cos(a), sin(a)) * r * blur, 0.0).rgb * w;
            wsum += w;
          }
          refl /= wsum;
          vec3 V = normalize(cameraPosition - vFloorW);
          float fres = 0.06 + 0.94 * pow(1.0 - clamp(V.y, 0.0, 1.0), 4.0);
          float glossy = (1.0 - concreteRough) * uGloss;
          reflectedLight.indirectSpecular += refl * fres * glossy * 2.4;
        }`);
  };
  return mat;
}

// ---------- geometry helpers ----------
const UP = new THREE.Vector3(0, 1, 0);
function rod(a, b, r, seg = 6) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  return g;
}

// 4-chord box truss along +x, centred on origin, bottom chords at y = 0.
function trussGeometry(length, s) {
  const parts = [];
  const h = s / 2, L = length / 2;
  const chords = [[-h, 0], [h, 0], [-h, s], [h, s]];          // [z, y]
  for (const [z, y] of chords) parts.push(rod(new THREE.Vector3(-L, y, z), new THREE.Vector3(L, y, z), 0.024));
  const bays = Math.round(length / s);
  const step = length / bays;
  const faces = [
    [[-h, 0], [-h, s]], [[h, 0], [h, s]], [[-h, 0], [h, 0]], [[-h, s], [h, s]],
  ];
  for (let i = 0; i < bays; i++) {
    const x0 = -L + i * step, x1 = x0 + step;
    for (const [[za, ya], [zb, yb]] of faces) {
      const flip = i % 2 === 0;
      parts.push(rod(
        new THREE.Vector3(x0, flip ? ya : yb, flip ? za : zb),
        new THREE.Vector3(x1, flip ? yb : ya, flip ? zb : za), 0.012, 4));
    }
  }
  return mergeGeometries(parts);
}

function iBeam(length, depth, width, mat) {
  const g = new THREE.Group();
  const web = new THREE.Mesh(new THREE.BoxGeometry(0.02, depth, length), mat);
  const top = new THREE.Mesh(new THREE.BoxGeometry(width, 0.03, length), mat);
  const bot = top.clone();
  top.position.y = depth / 2; bot.position.y = -depth / 2;
  g.add(web, top, bot);
  return g;
}

// ---------- venue ----------
export class Venue {
  constructor(scene, renderer) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.ceiling = new THREE.Group();
    scene.add(this.group, this.ceiling);
    const W = ROOM.width, D = ROOM.depth, H = ROOM.height;

    // Floor: procedural polished concrete (world-space, no tiling) with a blurred planar reflection.
    // The Reflector only renders the mirrored scene into a texture; the floor shader samples it.
    const floorGeo = new THREE.PlaneGeometry(W, D - ROOM.backWallZ);
    this.reflector = new Reflector(floorGeo, { textureWidth: 1024, textureHeight: 1024, clipBias: 0.003, multisample: 0 });
    this.reflector.rotation.x = -Math.PI / 2;
    this.reflector.position.set(0, -0.001, (D + ROOM.backWallZ) / 2);
    this.reflector.material.colorWrite = false;
    this.reflector.material.depthWrite = false;
    this.reflector.renderOrder = -100;        // render the mirror texture before the floor samples it
    this.floorMat = concreteMaterial(renderer, this.reflector, W, D - ROOM.backWallZ, ROOM.backWallZ);
    this.floor = new THREE.Mesh(floorGeo, this.floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.copy(this.reflector.position).setY(0);
    this.floor.renderOrder = -10;
    this.group.add(this.reflector, this.floor);

    // Walls (dark painted) and ceiling.
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.95 });
    const addPlane = (w, h, pos, rotY, mat = wallMat) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      m.position.copy(pos); m.rotation.y = rotY;
      this.group.add(m);
      return m;
    };
    const midZ = (D + ROOM.backWallZ) / 2, depthAll = D - ROOM.backWallZ;
    addPlane(W, H, new THREE.Vector3(0, H / 2, ROOM.backWallZ), 0);
    addPlane(W, H, new THREE.Vector3(0, H / 2, D), Math.PI);
    addPlane(depthAll, H, new THREE.Vector3(-W / 2, H / 2, midZ), Math.PI / 2);
    addPlane(depthAll, H, new THREE.Vector3(W / 2, H / 2, midZ), -Math.PI / 2);
    // Skirting columns along side walls
    const colMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1f, roughness: 0.9 });
    for (let z = 4; z < D; z += 7) {
      for (const sx of [-1, 1]) {
        const c = new THREE.Mesh(new THREE.BoxGeometry(0.6, H, 0.6), colMat);
        c.position.set(sx * (W / 2 - 0.3), H / 2, z);
        this.group.add(c);
      }
    }

    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, depthAll),
      new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 1 }));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(0, H, midZ);
    this.ceiling.add(ceil);

    const steel = new THREE.MeshStandardMaterial({ color: 0x232427, roughness: 0.7, metalness: 0.4 });
    for (let x = -15; x <= 15; x += 6) {
      const b = iBeam(depthAll, 0.6, 0.3, steel);
      b.position.set(x, ROOM.beamY, midZ);
      this.ceiling.add(b);
    }
    for (let z = 3; z < D; z += 8) {
      const b = iBeam(W, 0.3, 0.18, steel);
      b.rotation.y = Math.PI / 2;
      b.position.set(0, ROOM.beamY - 0.45, z);
      this.ceiling.add(b);
    }
    const dn = ductNormal();
    dn.repeat.set(60, 1);
    const ductMat = new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.5, metalness: 0.6, normalMap: dn });
    for (const [z, r, y] of [[5.5, 0.45, ROOM.ductY], [12.5, 0.32, ROOM.ductY + 0.2], [21, 0.45, ROOM.ductY]]) {
      const d = new THREE.Mesh(new THREE.CylinderGeometry(r, r, W, 24, 1, true), ductMat);
      d.rotation.z = Math.PI / 2;
      d.position.set(0, y, z);
      this.ceiling.add(d);
    }

    // House lights (high-bays) — emissive discs, intensity driven by houseLevel.
    this.houseMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    for (let x = -12; x <= 12; x += 12) {
      for (const z of [8, 20]) {
        const hb = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 0.15, 20), this.houseMat);
        hb.position.set(x, ROOM.beamY - 0.5, z);
        this.ceiling.add(hb);
      }
    }
    this.hemi = new THREE.HemisphereLight(0xdfe6ee, 0x303030, 0);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.02);
    scene.add(this.hemi, this.ambient);

    // LED riser (black fluted panels) + wall structure behind the LED.
    const fl = flutedNormal();
    fl.repeat.set(LED.width / 0.08, 1);
    const riserMat = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.55, normalMap: fl });
    const riser = new THREE.Mesh(new THREE.BoxGeometry(LED.width + 0.6, LED.bottom, 0.7), riserMat);
    riser.position.set(0, LED.bottom / 2, -0.3);
    this.group.add(riser);
    const back = new THREE.Mesh(new THREE.BoxGeometry(LED.width + 0.6, LED.height + 0.4, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x080809, roughness: 0.9 }));
    back.position.set(0, LED.bottom + LED.height / 2, -0.4);
    this.group.add(back);

    this.buildTruss();
    this.buildPA();
    this.buildBooth();
  }

  buildTruss() {
    this.truss = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xaab0b8, roughness: 0.35, metalness: 0.55 });
    const chain = [];
    const motorMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });
    for (const ln of TRUSS.lines) {
      const len = ln.to - ln.from;
      const m = new THREE.Mesh(trussGeometry(len, TRUSS.size), mat);
      const mid = (ln.from + ln.to) / 2;
      if (ln.axis === 'x') m.position.set(mid, TRUSS.y, ln.z);
      else { m.rotation.y = Math.PI / 2; m.position.set(ln.x, TRUSS.y + 0.001, mid); }
      this.truss.add(m);
      // hoists every ~8 m
      const n = Math.max(2, Math.round(len / 8) + 1);
      for (let i = 0; i < n; i++) {
        const t = ln.from + (len * i) / (n - 1);
        const p = ln.axis === 'x' ? new THREE.Vector3(t, TRUSS.y + TRUSS.size, ln.z) : new THREE.Vector3(ln.x, TRUSS.y + TRUSS.size, t);
        const motor = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.4, 0.25), motorMat);
        motor.position.copy(p).setY(TRUSS.y + 1.0);
        this.truss.add(motor);
        chain.push(p.x, p.y, p.z, p.x, ROOM.beamY - 0.3, p.z);
      }
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(chain, 3));
    this.truss.add(new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: 0x555555 })));
    this.group.add(this.truss);
  }

  buildPA() {
    this.pa = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x0e0e0f, roughness: 0.6 });
    const grill = new THREE.MeshStandardMaterial({ color: 0x1b1b1c, roughness: 0.9 });
    for (const sx of [-1, 1]) {
      const hang = new THREE.Group();
      hang.position.set(sx * 16.8, 9.9, 3.2);
      hang.rotation.y = -sx * 0.25;
      let y = 0, ang = 0;
      for (let i = 0; i < 9; i++) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.32, 0.6), [mat, mat, mat, mat, grill, mat]);
        ang += 0.02 + i * 0.012;
        y -= 0.33;
        box.position.set(0, y, Math.sin(ang) * 0.6 * i * 0.3);
        box.rotation.x = ang;
        hang.add(box);
      }
      this.pa.add(hang);
      // ground subs
      for (let k = 0; k < 2; k++) {
        const sub = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.6, 0.9), [mat, mat, mat, mat, grill, mat]);
        sub.position.set(sx * (11 + k * 1.35), 0.3, 1.2);
        this.pa.add(sub);
      }
    }
    this.group.add(this.pa);
  }

  buildBooth() {
    this.booth = new THREE.Group();
    const black = new THREE.MeshStandardMaterial({ color: 0x0d0d0e, roughness: 0.7 });
    const desk = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.0, 0.9), black);
    desk.position.set(0, 0.5, 2.4);
    const riser = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.2, 2.6), black);
    riser.position.set(0, 0.1, 1.9);
    desk.position.y += 0.2;
    const laptop = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.7, roughness: 0.3 }));
    laptop.position.set(0.6, 1.33, 2.3);
    laptop.rotation.x = -0.3;
    const decks = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.1, 0.45), black);
    decks.position.set(-0.3, 1.25, 2.45);
    this.booth.add(desk, riser, laptop, decks);
    for (const sx of [-1, 1]) {
      const mon = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.7, 0.5), black);
      mon.position.set(sx * 2.7, 0.35, 2.6);
      this.booth.add(mon);
    }
    this.group.add(this.booth);
  }

  setReflections(on, gloss) {
    this.reflector.visible = on;
    this.floorMat.userData.uniforms.uGloss.value = on ? gloss : 0;
    this.floorMat.userData.uniforms.uPolish.value = gloss;
  }

  setTaps(n) { this.floorMat.userData.uniforms.uTaps.value = n; }

  setReflectorSize(w, h) {
    this.reflector.getRenderTarget().setSize(Math.round(w), Math.round(h));
  }

  setHouse(level) {
    this.hemi.intensity = level * 2.0;
    this.houseMat.color.setScalar(level * 6);
  }
}

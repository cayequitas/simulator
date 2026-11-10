// Gobo atlas (4 × 4 cells of 256 px): 12 built-in gobos + 4 custom slots that can be filled with
// images or live frames from TouchDesigner. The same atlas drives the gobo pattern inside the
// volumetric beams and the projection onto the floor / walls (patched into three's spot-light loop).
import * as THREE from 'three';

export const GOBOS = [
  'Open', 'Dot ring', 'Breakup', 'Star', 'Bars', 'Prism 3', 'Spokes', 'Honeycomb',
  'Ring', 'Spiral', 'Flower', 'Water', 'Custom 1', 'Custom 2', 'Custom 3', 'Custom 4',
];
export const MAX_GOBO_FIXTURES = 16;   // the movers are the first 16 spot lights in the scene
const CELL = 256, ATLAS = CELL * 4;

// Shared uniforms, referenced by every patched material and beam.
export const GOBO_UNIFORMS = {
  uGoboAtlas: { value: null },
  uGoboData: { value: Array.from({ length: MAX_GOBO_FIXTURES }, () => new THREE.Vector4(0, 0, 0, 0.1)) }, // cellX, cellY, rotation, tanHalf
  uGoboUp: { value: Array.from({ length: MAX_GOBO_FIXTURES }, () => new THREE.Vector3(0, 0, 1)) },
};

export function goboCell(index) {
  return new THREE.Vector2((index % 4) / 4, 1 - (Math.floor(index / 4) + 1) / 4);
}

function drawBuiltIns() {
  const c = document.createElement('canvas');
  c.width = c.height = ATLAS;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, ATLAS, ATLAS);
  let s = 77;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const R = CELL * 0.46;
  const cell = (i, fn) => {
    g.save();
    g.translate((i % 4) * CELL + CELL / 2, Math.floor(i / 4) * CELL + CELL / 2);
    g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.clip();      // round aperture
    g.fillStyle = '#fff'; g.strokeStyle = '#fff';
    fn();
    g.restore();
  };
  cell(0, () => { g.fillRect(-R, -R, 2 * R, 2 * R); });
  cell(1, () => { for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; g.beginPath(); g.arc(Math.cos(a) * R * 0.68, Math.sin(a) * R * 0.68, R * 0.14, 0, Math.PI * 2); g.fill(); } g.beginPath(); g.arc(0, 0, R * 0.16, 0, Math.PI * 2); g.fill(); });
  cell(2, () => { for (let k = 0; k < 70; k++) { g.beginPath(); g.ellipse((r() - 0.5) * 2 * R, (r() - 0.5) * 2 * R, 6 + r() * 22, 4 + r() * 12, r() * 3, 0, Math.PI * 2); g.fill(); } });
  cell(3, () => { g.beginPath(); for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2 - Math.PI / 2, rr = k % 2 ? R * 0.38 : R * 0.98; g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } g.closePath(); g.fill(); });
  cell(4, () => { for (let x = -R; x < R; x += R * 0.28) g.fillRect(x, -R, R * 0.12, 2 * R); });
  cell(5, () => { for (let k = 0; k < 3; k++) { const a = k / 3 * Math.PI * 2 - Math.PI / 2; g.beginPath(); g.arc(Math.cos(a) * R * 0.45, Math.sin(a) * R * 0.45, R * 0.36, 0, Math.PI * 2); g.fill(); } });
  cell(6, () => { for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, R, a, a + 0.16); g.closePath(); g.fill(); } });
  cell(7, () => { const h = R * 0.3; for (let y = -R * 1.2, row = 0; y < R * 1.2; y += h * 0.9, row++) for (let x = -R * 1.2 + (row % 2) * h * 0.52; x < R * 1.2; x += h * 1.04) { g.beginPath(); for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; g.lineTo(x + Math.cos(a) * h * 0.42, y + Math.sin(a) * h * 0.42); } g.closePath(); g.fill(); } });
  cell(8, () => { g.lineWidth = R * 0.18; g.beginPath(); g.arc(0, 0, R * 0.7, 0, Math.PI * 2); g.stroke(); });
  cell(9, () => { g.lineWidth = R * 0.11; g.beginPath(); for (let a = 0; a < Math.PI * 8; a += 0.05) g.lineTo(Math.cos(a) * a / (Math.PI * 8) * R, Math.sin(a) * a / (Math.PI * 8) * R); g.stroke(); });
  cell(10, () => { for (let k = 0; k < 8; k++) { g.save(); g.rotate(k / 8 * Math.PI * 2); g.beginPath(); g.ellipse(0, -R * 0.5, R * 0.16, R * 0.42, 0, 0, Math.PI * 2); g.fill(); g.restore(); } });
  cell(11, () => {
    const img = g.getImageData((11 % 4) * CELL, Math.floor(11 / 4) * CELL, CELL, CELL);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const v = Math.sin(x * 0.09 + Math.sin(y * 0.05) * 3) + Math.sin(y * 0.11 + Math.sin(x * 0.04) * 3);
      const k = (y * CELL + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = Math.max(0, 1 - Math.abs(v) * 1.2) * 255;
      img.data[k + 3] = 255;
    }
    g.putImageData(img, (11 % 4) * CELL, Math.floor(11 / 4) * CELL);
  });
  // custom slots start as a labelled open aperture
  for (let i = 12; i < 16; i++) cell(i, () => { g.globalAlpha = 0.5; g.fillRect(-R, -R, 2 * R, 2 * R); g.globalAlpha = 1; g.fillStyle = '#000'; g.font = `bold ${CELL * 0.22}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(`C${i - 11}`, 0, 0); });
  return c;
}

export class GoboAtlas {
  constructor(renderer) {
    this.renderer = renderer;
    this.rt = new THREE.WebGLRenderTarget(ATLAS, ATLAS, { depthBuffer: false });
    this.rt.texture.minFilter = THREE.LinearFilter;
    this.rt.texture.generateMipmaps = false;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null }, uMask: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D uTex; uniform float uMask; varying vec2 vUv;
        void main(){
          vec3 c = texture2D(uTex, vUv).rgb;
          float ap = mix(1.0, smoothstep(0.5, 0.47, length(vUv - 0.5)), uMask);   // round aperture for custom gobos
          gl_FragColor = vec4(c * ap, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
    const base = new THREE.CanvasTexture(drawBuiltIns());
    this.blit(base, 0, 0, ATLAS, ATLAS, false);
    base.dispose();
    GOBO_UNIFORMS.uGoboAtlas.value = this.rt.texture;
    this.live = new Map();          // slot → live texture (video) redrawn every frame
  }

  blit(tex, x, y, w, h, mask) {
    this.mat.uniforms.uTex.value = tex;
    this.mat.uniforms.uMask.value = mask ? 1 : 0;
    const prev = this.renderer.getRenderTarget();
    this.rt.viewport.set(x, y, w, h);
    this.rt.scissor.set(x, y, w, h);
    this.rt.scissorTest = true;
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.cam);
    this.rt.scissorTest = false;
    this.rt.viewport.set(0, 0, ATLAS, ATLAS);
    this.renderer.setRenderTarget(prev);
  }

  // slot 1..4 → atlas cells 12..15
  setCustom(slot, tex) {
    const i = 11 + slot;
    const x = (i % 4) * CELL, y = ATLAS - (Math.floor(i / 4) + 1) * CELL;
    this.blit(tex, x, y, CELL, CELL, true);
  }

  async setCustomImage(slot, src) {
    const img = new Image();
    img.src = src;
    await img.decode();
    const tex = new THREE.Texture(img);
    tex.needsUpdate = true;
    this.setCustom(slot, tex);
    tex.dispose();
  }

  setLive(slot, tex) { if (tex) this.live.set(slot, tex); else this.live.delete(slot); }

  update() { for (const [slot, tex] of this.live) this.setCustom(slot, tex); }
}

// Multiplies each of the first 16 spot lights by its gobo, projected along the beam.
// Used on surfaces that should show gobo patterns (floor, walls, riser).
export function patchGoboProjection(material) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    Object.assign(shader.uniforms, GOBO_UNIFORMS);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uGoboAtlas;
        uniform vec4 uGoboData[${MAX_GOBO_FIXTURES}];
        uniform vec3 uGoboUp[${MAX_GOBO_FIXTURES}];
        vec3 goboFactor(int k, vec3 lightPos, vec3 lightDirToSource, vec3 p) {
          if (k >= ${MAX_GOBO_FIXTURES}) return vec3(1.0);
          vec4 gd = uGoboData[k];
          vec3 d = -lightDirToSource;                               // beam direction (view space)
          vec3 up = normalize((viewMatrix * vec4(uGoboUp[k], 0.0)).xyz);
          vec3 right = normalize(cross(d, up)); vec3 up2 = cross(right, d);
          vec3 rel = p - lightPos;
          float ax = max(dot(rel, d), 1e-3);
          vec2 q = vec2(dot(rel, right), dot(rel, up2)) / (ax * gd.w);
          float c = cos(gd.z), s = sin(gd.z);
          q = mat2(c, -s, s, c) * q;
          if (length(q) > 1.0) return vec3(0.0);
          vec3 g = textureLod(uGoboAtlas, gd.xy + (q * 0.5 + 0.5) * 0.24 + 0.005, 0.0).rgb;
          return min(max(g, vec3(0.0)), vec3(1.0));   // also flushes NaN on D3D
        }`)
      // includes are still unresolved here, so expand the light loop chunk and patch it
      .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(
        'getSpotLightInfo( spotLight, geometryPosition, directLight );',
        `getSpotLightInfo( spotLight, geometryPosition, directLight );
        directLight.color *= goboFactor( UNROLLED_LOOP_INDEX, spotLight.position, spotLight.direction, geometryPosition );`));
  };
  material.needsUpdate = true;
}

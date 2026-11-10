// The 30 m × 6.72 m LED wall (3840 × 860 px).
// Content sources: built-in shader generators, a pixel-map test card, media files,
// capture devices (webcam / capture card / OBS or NDI virtual camera), screen capture
// and network streams (MP4 / HLS). The wall also lights the room through three
// RectAreaLights fed with the average colour of the left / centre / right thirds.
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { LED } from './config.js';
import { NOISE } from './glsl.js';

export const PATTERNS = ['Strands', 'Scan', 'Hue sweep', 'Plasma', 'Scanner lines', 'Solid', 'Black'];

const FULLSCREEN_VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const GENERATOR_FS = /* glsl */ `
uniform float uTime; uniform float uMode; uniform vec3 uA; uniform vec3 uB; uniform vec2 uRes;
varying vec2 vUv;
${NOISE}
vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}
void main() {
  vec2 uv = vUv;
  vec2 p = vec2(uv.x * ${LED.aspect.toFixed(4)}, uv.y);
  float t = uTime;
  vec3 col = vec3(0.0);
  float grain = hash13(vec3(floor(uv * uRes), floor(t * 30.0)));
  if (uMode < 0.5) {
    // Strands — glowing filaments over a dusty dark field
    float tt = t * 0.12;
    float w1 = fbm(vec3(p.x * 0.7, p.y * 0.5, tt));
    float w2 = fbm3(vec3(p.x * 1.6 + 5.0, p.y * 1.1, tt * 1.3));
    float field = p.x * 2.6 + w1 * 4.0 + w2 * 1.6 + p.y * 0.6 * sin(p.x * 0.7 + tt * 2.0);
    float l = abs(fract(field) - 0.5);
    float thick = 0.5 + fbm3(vec3(p * 3.0, tt));
    float strand = smoothstep(0.03, 0.0, l * thick);
    float cluster = smoothstep(0.42, 0.72, fbm3(vec3(p.x * 0.9, p.y * 0.35, tt * 0.5 + 3.0)));
    float halo = smoothstep(0.25, 0.0, l) * 0.18;
    float dust = step(0.975 - cluster * 0.2, grain);
    float bg = 0.25 + 0.5 * fbm3(vec3(p * 2.0, tt));
    col = uB * bg + uA * (cluster * (strand + halo) * 1.3 + dust * (0.25 + cluster * 0.9));
  } else if (uMode < 1.5) {
    // Scan — high-contrast point-cloud look
    float tt = t * 0.08;
    float big = fbm3(vec3(p * 0.8, tt));
    float detail = fbm(vec3(p * vec2(10.0, 14.0), tt * 3.0));
    float lines = smoothstep(0.05, 0.0, abs(detail - 0.5));
    float oval = 1.0 - smoothstep(0.25, 0.5, length((uv - vec2(0.55, 0.5)) * vec2(1.0, 1.4)));
    float mask = smoothstep(0.4, 0.6, big) * oval;
    float flare = pow(max(0.0, 1.0 - length((uv - vec2(0.45 + 0.1 * sin(t * 0.3), 0.4)) * vec2(8.0, 2.0))), 4.0);
    col = uB * 0.2 + uA * (lines * mask * 1.4 + step(0.88, grain) * mask * 0.7 + flare * 1.5);
  } else if (uMode < 2.5) {
    float h = fract(p.x * 0.12 - t * 0.08);
    float bars = 0.6 + 0.4 * step(0.5, fract(p.x * 1.5 - t * 0.3));
    col = hsv(h, 0.9, bars);
  } else if (uMode < 3.5) {
    float v = sin(p.x * 1.3 + t) + sin(p.y * 3.0 - t * 0.7) + sin((p.x + p.y) * 0.9 + t * 0.5) + fbm3(vec3(p * 0.6, t * 0.2)) * 3.0;
    col = mix(uB, uA, 0.5 + 0.5 * sin(v * 1.6));
  } else if (uMode < 4.5) {
    float x = fract(t * 0.1), y = fract(t * 0.23);
    float vx = smoothstep(0.004, 0.0, abs(uv.x - x));
    float vy = smoothstep(0.02, 0.0, abs(uv.y - y));
    col = uA * max(vx, vy) + uB * 0.05;
  } else if (uMode < 5.5) {
    col = uA;
  }
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const SAMPLE_GLSL = /* glsl */ `
uniform sampler2D uTex; uniform vec2 uScale; uniform vec2 uOffset;
vec3 srcColor(vec2 uv) {
  vec2 s = (uv - 0.5) * uScale + 0.5 + uOffset;
  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0) return vec3(0.0);
  return pow(texture2D(uTex, s).rgb, vec3(2.2));   // display-referred source → linear
}
`;

const WALL_VS = /* glsl */ `
varying vec2 vUv; varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const WALL_FS = /* glsl */ `
uniform vec2 uRes; uniform float uBright; uniform float uGrid;
uniform vec3 uFogColor; uniform float uFogDensity;
varying vec2 vUv; varying vec3 vWorld;
${SAMPLE_GLSL}
void main() {
  vec2 px = vUv * uRes;
  vec2 fw = fwidth(px);
  float near = (1.0 - smoothstep(0.2, 0.7, max(fw.x, fw.y))) * uGrid;  // 1 = LED pixels resolved on screen
  vec3 c = srcColor(vUv);
  if (near > 0.001) {
    vec3 cq = srcColor((floor(px) + 0.5) / uRes);
    float d = length(fract(px) - 0.5);
    float dotm = smoothstep(0.44, 0.2, d);
    c = mix(c, cq * dotm * 2.6, near);
  }
  // slight off-axis falloff of the LED modules
  vec3 V = normalize(cameraPosition - vWorld);
  float axis = mix(0.75, 1.0, V.z);
  vec3 col = c * uBright * axis + vec3(0.003);
  float dist = length(cameraPosition - vWorld);
  float fogF = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  gl_FragColor = vec4(mix(col, uFogColor, fogF), 1.0);
}
`;

const AVG_FS = /* glsl */ `
${SAMPLE_GLSL}
void main() {
  float region = floor(gl_FragCoord.x);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 12; i++) for (int j = 0; j < 6; j++) {
    vec2 uv = vec2((region + (float(i) + 0.5) / 12.0) / 3.0, (float(j) + 0.5) / 6.0);
    acc += srcColor(uv);
  }
  gl_FragColor = vec4(sqrt(acc / 72.0), 1.0);
}
`;

function testCardTexture() {
  const c = document.createElement('canvas');
  c.width = LED.pxW; c.height = LED.pxH;
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.fillStyle = '#101012'; g.fillRect(0, 0, W, H);
  // 64 px grid
  g.strokeStyle = '#2c2c32'; g.lineWidth = 1;
  for (let x = 0; x <= W; x += 64) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke(); }
  for (let y = 0; y <= H; y += 64) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke(); }
  // quarter sections
  const cols = ['#e5484d', '#30a46c', '#0090ff', '#f5d90a'];
  for (let i = 0; i < 4; i++) {
    g.fillStyle = cols[i]; g.globalAlpha = 0.18; g.fillRect(i * 960, 0, 960, H); g.globalAlpha = 1;
    g.fillStyle = cols[i]; g.font = 'bold 220px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText(String(i + 1), i * 960 + 480, 300);
    g.font = '36px system-ui, sans-serif';
    g.fillText(`x ${i * 960}–${(i + 1) * 960 - 1}`, i * 960 + 480, 360);
  }
  // diagonals + centre circle
  g.strokeStyle = '#ffffff'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(W, H); g.moveTo(W, 0); g.lineTo(0, H); g.stroke();
  g.beginPath(); g.arc(W / 2, H / 2, 400, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
  // grey ramp + colour bars
  for (let i = 0; i < 32; i++) {
    const v = Math.round((i / 31) * 255);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(960 + i * 60, H - 150, 60, 70);
  }
  const bars = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff', '#000000'];
  bars.forEach((b, i) => { g.fillStyle = b; g.fillRect(960 + i * 240, H - 80, 240, 80); });
  // label
  g.fillStyle = '#ffffff'; g.font = 'bold 54px system-ui, sans-serif'; g.textAlign = 'center';
  g.fillText(`ALTE MÜNZE · LED ${LED.pxW} × ${LED.pxH} px · ${LED.width.toFixed(1)} × ${LED.height.toFixed(2)} m · ≈${LED.pitchMM.toFixed(2)} mm pitch`, W / 2, H / 2 - 30);
  g.font = '34px system-ui, sans-serif';
  g.fillText('grid = 64 px', W / 2, H / 2 + 30);
  // 1px border
  g.strokeStyle = '#ff0000'; g.lineWidth = 2; g.strokeRect(1, 1, W - 2, H - 2);
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
  return t;
}

export class LedWall {
  constructor(renderer, scene) {
    this.renderer = renderer;
    RectAreaLightUniformsLib.init();

    // --- content generator ---
    this.genScale = 1;
    this.genRT = new THREE.WebGLRenderTarget(LED.pxW, LED.pxH, { depthBuffer: false });
    this.genMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VS, fragmentShader: GENERATOR_FS,
      uniforms: {
        uTime: { value: 0 }, uMode: { value: 0 }, uRes: { value: new THREE.Vector2(LED.pxW, LED.pxH) },
        uA: { value: new THREE.Color(1, 1, 1) }, uB: { value: new THREE.Color(0.1, 0.22, 0.2) },
      },
      depthTest: false, depthWrite: false,
    });
    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.genMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.testCard = testCardTexture();

    // --- wall surface ---
    const shared = {
      uTex: { value: this.genRT.texture }, uScale: { value: new THREE.Vector2(1, 1) }, uOffset: { value: new THREE.Vector2() },
    };
    this.mat = new THREE.ShaderMaterial({
      vertexShader: WALL_VS, fragmentShader: WALL_FS,
      uniforms: {
        ...shared,
        uRes: { value: new THREE.Vector2(LED.pxW, LED.pxH) }, uBright: { value: 1.4 }, uGrid: { value: 1 },
        uFogColor: { value: new THREE.Color() }, uFogDensity: { value: 0 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(LED.width, LED.height), this.mat);
    this.mesh.position.set(0, LED.bottom + LED.height / 2, 0);
    scene.add(this.mesh);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(LED.width + LED.frame * 2, LED.height + LED.frame * 2, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.6 }));
    frame.position.set(0, this.mesh.position.y, -0.065);
    scene.add(frame);

    // --- average colour → room light ---
    this.avgRT = new THREE.WebGLRenderTarget(3, 1, { depthBuffer: false });
    this.avgMat = new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VS, fragmentShader: AVG_FS, uniforms: shared, depthTest: false });
    this.avgBuf = new Uint8Array(12);
    this.avg = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
    this.avgAll = new THREE.Color();
    this.areaLights = [];
    for (let i = 0; i < 3; i++) {
      const l = new THREE.RectAreaLight(0x000000, 1, LED.width / 3, LED.height);
      l.position.set((i - 1) * LED.width / 3, this.mesh.position.y, 0.02);
      l.lookAt(l.position.x, l.position.y, 10);
      scene.add(l);
      this.areaLights.push(l);
    }

    // --- media sources ---
    this.source = 'Generator';
    this.mediaTex = null;
    this.mediaAspect = LED.aspect;
    this.video = document.createElement('video');
    this.video.muted = true; this.video.loop = true; this.video.playsInline = true; this.video.crossOrigin = 'anonymous';
    this.stream = null;
    this.hls = null;
    this.info = 'Generator';
    this.frame = 0;
  }

  // ----- sources -----
  stopMedia() {
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.srcObject = null;
    if (this.mediaTex) { this.mediaTex.dispose(); this.mediaTex = null; }
  }

  useGenerator() { this.stopMedia(); this.source = 'Generator'; this.mediaAspect = LED.aspect; }
  useTestCard() { this.stopMedia(); this.source = 'Test card'; this.mediaAspect = LED.aspect; this.info = `Test card ${LED.pxW}×${LED.pxH}`; }

  async useVideoElement(label) {
    const v = this.video;
    await new Promise((res, rej) => {
      if (v.readyState >= 1) return res();
      v.onloadedmetadata = () => res();
      v.onerror = () => rej(new Error('Could not load media'));
    });
    await v.play().catch(() => {});
    this.mediaTex = new THREE.VideoTexture(v);
    this.mediaTex.minFilter = THREE.LinearFilter;
    this.mediaTex.generateMipmaps = false;
    this.mediaAspect = (v.videoWidth || 16) / (v.videoHeight || 9);
    this.info = `${label} ${v.videoWidth}×${v.videoHeight}`;
  }

  async loadFile(file) {
    this.stopMedia();
    const url = URL.createObjectURL(file);
    if (file.type.startsWith('image/')) {
      const tex = await new THREE.TextureLoader().loadAsync(url);
      tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
      this.mediaTex = tex;
      this.mediaAspect = tex.image.width / tex.image.height;
      this.info = `Image ${tex.image.width}×${tex.image.height}`;
    } else {
      this.video.src = url;
      await this.useVideoElement('File');
    }
    this.source = 'Media';
  }

  async loadURL(url) {
    this.stopMedia();
    const v = this.video;
    if (/\.m3u8(\?|$)/i.test(url) && !v.canPlayType('application/vnd.apple.mpegurl')) {
      if (!window.Hls) {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js';
          s.onload = res; s.onerror = () => rej(new Error('hls.js failed to load'));
          document.head.appendChild(s);
        });
      }
      this.hls = new window.Hls({ lowLatencyMode: true });
      this.hls.loadSource(url);
      this.hls.attachMedia(v);
    } else {
      v.src = url;
    }
    await this.useVideoElement('Stream');
    this.source = 'Media';
  }

  async useCapture(deviceId) {
    this.stopMedia();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 60 },
      },
      audio: false,
    });
    this.video.srcObject = this.stream;
    const label = this.stream.getVideoTracks()[0]?.label || 'Capture';
    await this.useVideoElement(label);
    this.source = 'Media';
  }

  // TouchDesigner stream: JPEG frames sent through the bridge, decoded to ImageBitmaps (already flipped)
  useStream() { this.stopMedia(); this.source = 'Stream'; }

  setStreamFrame(bitmap) {
    const t = this.streamTex;
    if (!t || t.image.width !== bitmap.width || t.image.height !== bitmap.height) {
      t?.dispose();
      this.streamTex = new THREE.Texture(bitmap);
      this.streamTex.flipY = false;
      this.streamTex.minFilter = THREE.LinearFilter;
      this.streamTex.generateMipmaps = false;
    } else {
      const old = t.image;
      t.image = bitmap;
      old.close?.();
    }
    this.streamTex.needsUpdate = true;
    this.streamAt = performance.now();
  }

  // Finds a capture device by name (e.g. SpoutCam, OBS Virtual Camera) and starts it.
  // Device names are only visible after camera permission was granted once, so ask first if needed.
  async useNamedCapture(pattern, label) {
    let list = await LedWall.listDevices();
    if (!list.some(d => d.label)) {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      probe.getTracks().forEach(t => t.stop());
      list = await LedWall.listDevices();
    }
    const dev = list.find(d => pattern.test(d.label));
    if (!dev) throw new Error(`${label} not found. Found: ${list.map(d => d.label).join(', ') || 'no cameras'}`);
    await this.useCapture(dev.deviceId);
  }

  async useScreen() {
    this.stopMedia();
    this.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60 } }, audio: false });
    this.video.srcObject = this.stream;
    this.stream.getVideoTracks()[0].addEventListener('ended', () => this.useGenerator());
    await this.useVideoElement('Screen');
    this.source = 'Media';
  }

  static async listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'videoinput');
  }

  // ----- per frame -----
  update(time, p, fog) {
    const u = this.mat.uniforms;
    let tex;
    if (this.source === 'Generator') {
      const scale = p.contentRes === 'Half' ? 0.5 : 1;
      if (scale !== this.genScale) { this.genScale = scale; this.genRT.setSize(LED.pxW * scale, LED.pxH * scale); }
      const g = this.genMat.uniforms;
      g.uTime.value = time * p.speed;
      g.uMode.value = PATTERNS.indexOf(p.pattern);
      g.uA.value.set(p.colorA).convertLinearToSRGB();
      g.uB.value.set(p.colorB).convertLinearToSRGB();
      g.uRes.value.set(LED.pxW * scale, LED.pxH * scale);
      // generated content runs at half the display rate — it is slow-moving and the full-res pass is costly
      if ((this.frame & 1) === 0) {
        this.renderer.setRenderTarget(this.genRT);
        this.renderer.render(this.quadScene, this.quadCam);
        this.renderer.setRenderTarget(null);
      }
      tex = this.genRT.texture;
      this.info = `Generator · ${p.pattern} · ${LED.pxW * scale}×${LED.pxH * scale}`;
    } else if (this.source === 'Test card') {
      tex = this.testCard;
    } else if (this.source === 'Stream') {
      tex = this.streamTex || this.genRT.texture;
      if (this.streamTex) {
        const { width: w, height: h } = this.streamTex.image;
        this.mediaAspect = w / h;
        const stalled = performance.now() - this.streamAt > 2000;
        this.info = `TouchDesigner stream ${w}×${h}${stalled ? ' · no frames (check TouchDesigner)' : ''}`;
      } else {
        this.info = 'TouchDesigner stream · waiting for frames';
      }
    } else {
      tex = this.mediaTex || this.genRT.texture;
      if (this.video.videoWidth) this.mediaAspect = this.video.videoWidth / this.video.videoHeight;
    }
    u.uTex.value = tex;

    // fit mode
    const wa = LED.aspect, sa = this.mediaAspect;
    const s = u.uScale.value.set(1, 1);
    if (p.fit === 'Fill') { if (sa > wa) s.x = wa / sa; else s.y = sa / wa; }
    else if (p.fit === 'Fit') { if (sa > wa) s.y = sa / wa; else s.x = wa / sa; }
    s.divideScalar(p.zoom);
    u.uOffset.value.set(p.offsetX, p.offsetY);
    u.uBright.value = p.brightness;
    u.uGrid.value = p.pixelGrid ? 1 : 0;
    u.uFogColor.value.copy(fog.color);
    u.uFogDensity.value = fog.density;

    // average colour every 6th frame (readback stalls the GPU pipeline)
    if (this.frame++ % 6 === 1) {
      this.quad.material = this.avgMat;
      this.renderer.setRenderTarget(this.avgRT);
      this.renderer.render(this.quadScene, this.quadCam);
      this.renderer.readRenderTargetPixels(this.avgRT, 0, 0, 3, 1, this.avgBuf);
      this.renderer.setRenderTarget(null);
      this.quad.material = this.genMat;
      this.avgAll.setRGB(0, 0, 0);
      for (let i = 0; i < 3; i++) {
        const r = this.avgBuf[i * 4] / 255, g = this.avgBuf[i * 4 + 1] / 255, b = this.avgBuf[i * 4 + 2] / 255;
        this.avg[i].setRGB(r * r, g * g, b * b);
        this.avgAll.r += this.avg[i].r / 3; this.avgAll.g += this.avg[i].g / 3; this.avgAll.b += this.avg[i].b / 3;
      }
    }
    for (let i = 0; i < 3; i++) {
      const l = this.areaLights[i];
      l.color.copy(this.avg[i]);
      l.intensity = p.brightness * p.roomLight * 6;
    }
  }
}

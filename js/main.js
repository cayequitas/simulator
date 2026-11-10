// Alte Münze show simulator — scene setup, FX engine, cues, UI and remote control.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { LED, ROOM, RIG } from './config.js';
import { Venue } from './venue.js';
import { LedWall, PATTERNS } from './ledwall.js';
import { MovingHead, LedBar } from './fixtures.js';
import { Atmosphere } from './fog.js';
import { VideoAnalyzer, AudioReact, Director, LOOKS, LOOK_NAMES } from './videolights.js';
import { Transport } from './transport.js';
import { ClientUI, rollLabel } from './clientui.js';
import { GoboAtlas, GOBOS, GOBO_UNIFORMS, MAX_GOBO_FIXTURES, goboCell, patchGoboProjection } from './gobos.js';

// Client link build: no control panel, start screen, adaptive quality (see tools/build_site.py)
const SHOW_MODE = !!window.SIM_SHOW || new URLSearchParams(location.search).has('show');
const SHOW_URL = window.SIM_SHOW || 'show/show.json';
const IS_MOBILE = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

// ---------------------------------------------------------------- renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.05, 200);
camera.position.set(1.5, 1.7, 15);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 5.6, 0);
controls.enableDamping = true;
controls.maxDistance = 70;

const composerRT = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, composerRT);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.45, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// Quality tiers. 'Auto' starts at the top and steps down if the machine can't hold the frame rate.
const TIERS = [
  { pr: 1.5, refl: 0.5, beam: 1, taps: 12, msaa: 4, bloom: true, bars: true },
  { pr: 1, refl: 0.35, beam: 0.7, taps: 8, msaa: 4, bloom: true, bars: true },
  { pr: 0.8, refl: 0.25, beam: 0.5, taps: 6, msaa: 0, bloom: true, bars: false },
  { pr: 0.6, refl: 0.18, beam: 0.35, taps: 4, msaa: 0, bloom: false, bars: false },
];
let autoTier = IS_MOBILE ? 2 : 0, T = TIERS[autoTier];

const gobos = new GoboAtlas(renderer);
const venue = new Venue(scene, renderer);
// gobo patterns are projected onto the floor
patchGoboProjection(venue.floorMat);
const led = new LedWall(renderer, scene);
const atmos = new Atmosphere(scene);
scene.background = atmos.fog.color;
// fog particles are skipped in the floor reflection pass (large overdraw, barely visible there)
const reflectorBefore = venue.reflector.onBeforeRender;
venue.reflector.onBeforeRender = function (...args) {
  atmos.mesh.visible = false;
  const hideBeams = T.beam < 0.6;                     // on slower machines beams are left out of the reflection
  if (hideBeams) allLights.forEach(f => { f.beam.userData.v = f.beam.visible; f.beam.visible = false; });
  reflectorBefore.apply(this, args);
  if (hideBeams) allLights.forEach(f => { f.beam.visible = f.beam.userData.v; });
  atmos.mesh.visible = true;
};

const rig = new THREE.Group();
scene.add(rig);
const front = RIG.frontMovers.xs.map(x => new MovingHead(rig, x, RIG.frontMovers.z, true));
const mid = RIG.midMovers.xs.map(x => new MovingHead(rig, x, RIG.midMovers.z, false));
const bars = RIG.bars.map(b => new LedBar(rig, b.x, b.z));
const movers = [...front, ...mid];       // scene order: these are spot lights 0–15 (gobo projection relies on it)
const allLights = [...movers, ...bars];
// ids used everywhere (GUI, cues, OSC /sim/m3/dimmer, TouchDesigner): m1–m8 front, m9–m16 mid, b1–b11 bars, left to right
movers.forEach((m, i) => { m.id = `m${i + 1}`; m.label = `Mover ${i + 1} · ${i < front.length ? 'front' : 'mid'}`; });
bars.forEach((b, i) => { b.id = `b${i + 1}`; b.label = `Bar ${i + 1} · ${b.root.position.z < 5 ? 'front' : 'mid'}`; });

// ---------------------------------------------------------------- state
const MOVE_FX = ['Static', 'Fan', 'Circle', 'Sweep', 'Tilt wave', 'Ballyhoo', 'Crossfire', 'Aim at point'];
const DIM_FX = ['None', 'Pulse', 'Chase', 'Random', 'Alternate'];
const COLOR_FX = ['Static', 'A/B alternate', 'A/B chase', 'Rainbow'];
const SOURCES = ['Generator', 'Test card', 'TouchDesigner stream', 'Spout (SpoutCam)', 'Media file', 'Capture device', 'Screen capture', 'Stream URL'];

const mover = o => ({
  dimmer: 0.8, color: '#ffffff', colorB: '#8a3cff', colorFx: 'Static', zoom: 4, strobe: 0,
  fx: 'Fan', pan: 0, tilt: 30, spread: 60, size: 25, speed: 8, phase: 0.5, dimFx: 'None',
  aimX: 0, aimY: 0, aimZ: 14, gobo: 'Open', goboRot: 0, ...o,
});

// Light colours for the show. The rig keeps reacting to the film; only the colours come from here.
const PALETTE_NAMES = ['Cyan, steel, white', 'From the video'];
const CYAN = new THREE.Color('#19e3ff'), STEEL = new THREE.Color('#9fb0bd'), WHITE = new THREE.Color('#ffffff');

const S = {
  master: {
    grand: 1, bpm: 126, cueFade: 1.5,
    frontLevel: 1, frontOn: true, midLevel: 1, midOn: true, barsLevel: 1, barsOn: true,
    whiteStrobe: false, whiteRate: 12,
  },
  atmos: { haze: 0.45, turbulence: 0.8, hazeScale: 1, drift: 1, scatter: 1, fogOutput: 0, fogMode: 'Machine', fogDensity: 1 },
  led: {
    pattern: 'Strands', colorA: '#ffffff', colorB: '#16302d', speed: 1, brightness: 1.3, roomLight: 1,
    fit: 'Fill', zoom: 1, offsetX: 0, offsetY: 0, pixelGrid: true, contentRes: 'Full',
  },
  front: mover({ colorB: '#19e3ff', fx: 'Sweep', size: 30, spread: 50, tilt: 35, dimmer: 0.7, zoom: 3 }),
  mid: mover({ color: '#19e3ff', colorB: '#9fb0bd', fx: 'Ballyhoo', zoom: 16, dimmer: 0.45, tilt: 20, size: 20 }),
  bars: { dimmer: 0.85, color: '#19e3ff', colorB: '#9fb0bd', colorFx: 'Static', strobe: 0, dimFx: 'None', tiltFx: 'Static', tilt: 30, spread: 20, zoom: 56, speed: 4, phase: 0.5 },
  show: { follow: true, color: 1, react: 1, hits: 1, director: true, palette: PALETTE_NAMES[0], title: 'Alte Münze', date: '28.11.2026' },
  venue: { house: 0, truss: true, booth: true, pa: true, floorGloss: 0.6 },
  render: { exposure: 1, bloom: 0.55, reflections: true, barSpots: true, quality: SHOW_MODE ? 'Auto' : 'High' },
};
// Individual fixture overrides. Mode: follow the group, or take the fixture's own look (dimmer, colour,
// strobe, zoom, gobo), own position (pan/tilt), or both.
const FIX_MODES = ['Follow group', 'Own look', 'Own position', 'Own everything'];
for (const m of movers) S[m.id] = { mode: 'Follow group', dimmer: 1, color: '#ffffff', strobe: 0, zoom: 6, gobo: 'Open', goboRot: 0, pan: 0, tilt: 30 };
for (const b of bars) S[b.id] = { mode: 'Follow group', dimmer: 1, color: '#ffffff', strobe: 0, zoom: 56, tilt: 30 };
const FIX_IDS = allLights.map(f => f.id);

const live = { blackout: false, flash: false, source: 'Generator', url: '', device: '', cue: 1, muted: true, ws: 'ws://localhost:8787', wsStatus: 'disconnected', followDmx: true, dmxStatus: 'no DMX' };

// ---------------------------------------------------------------- FX engine
let time = 0, beat = 0;
const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
const _ca = new THREE.Color(), _cb = new THREE.Color(), _aim = new THREE.Vector3();

function dimFx(p, i, n) {
  const u = n > 1 ? i / (n - 1) : 0;
  const ph = beat / p.speed + p.phase * u;
  switch (p.dimFx) {
    case 'Pulse': return 0.5 + 0.5 * Math.cos(Math.PI * 2 * ph);
    case 'Chase': {
      const pos = ((beat / p.speed) % 1 + 1) % 1;
      let d = Math.abs(pos - i / n); d = Math.min(d, 1 - d);
      return Math.max(0, 1 - d * n * 1.2);
    }
    case 'Random': return hash(i, Math.floor((beat * 4) / p.speed)) > 0.55 ? 1 : 0;
    case 'Alternate': return (Math.floor((beat * 2) / p.speed) + i) % 2 ? 1 : 0;
    default: return 1;
  }
}

function fxColor(p, i, n, out) {
  _ca.set(p.color); _cb.set(p.colorB);
  switch (p.colorFx) {
    case 'A/B alternate': return out.copy(i % 2 ? _cb : _ca);
    case 'A/B chase': return out.copy((Math.floor((beat * 2) / p.speed) + i) % 2 ? _cb : _ca);
    case 'Rainbow': return out.setHSL((((beat / p.speed + (p.phase * i) / n) % 1) + 1) % 1, 1, 0.5);
    default: return out.copy(_ca);
  }
}

function level(p, i, n) {
  if (live.blackout) return 0;
  if (live.flash) return 1;
  const strobe = p.strobe > 0 ? ((time * p.strobe) % 1 < 0.25 ? 1 : 0) : 1;
  return S.master.grand * p.dimmer * dimFx(p, i, n) * strobe;
}

// DMX from the bridge overrides the FX engine per fixture while frames keep arriving.
let dmxFrame = null, dmxAt = -1e9;
const dmxActive = () => live.followDmx && dmxFrame && performance.now() - dmxAt < 10000;
function dmxLevel(dim, hz) {
  if (live.blackout) return 0;
  if (live.flash) return 1;
  const strobe = hz > 0 ? ((time * hz) % 1 < 0.25 ? 1 : 0) : 1;
  return S.master.grand * dim * strobe;
}

// haze parameters handed to every beam each frame
const hz = { haze: 0, turb: 0, scale: 1, flow: 1, fogBoost: 0, steps: 1 };

// ---- the rig follows the picture on the wall (see videolights.js)
const analyzer = new VideoAnalyzer(), audio = new AudioReact(), director = new Director();
const _px = [0, 0, 0], _film = new THREE.Color(), _white = new THREE.Color(1, 1, 1);
// The video leads; the rig answers it and never outshines it. Worked out once per frame in tickShow:
//  atmo   0..1  soft mover glow while the picture is busy, gone when the film goes dark
//  chaos  0..1  big moments (hits in a cluster): the front heads open up together, in one clean move
//  strobe s     time left on the bars' white strobe burst (each hit in the film starts one)
//  duck   0..1  1 = wall dark; drops toward 0.3 while the wall is bright, so the film stays the star
const dyn = { atmo: 0, chaos: 0, chaosHold: 0, strobe: 0, strobeHz: 12, lastHit: 0, hits: [], duck: 1 };
function followVideo(f, group, i) {
  const P = S.show;
  const on = P.follow && analyzer.valid;
  const palette = P.palette === PALETTE_NAMES[0];
  if (!on && !palette) return;
  const react = on ? P.react : 0;
  if (group === 'bars') {
    // bars continue the part of the picture they hang in front of, and stay dark where the picture is dark
    const u = THREE.MathUtils.clamp((f.root.position.x + LED.width / 2) / LED.width, 0, 1);
    const lv = on ? analyzer.sample(u, _px) : 0;
    if (palette) {                                    // dark parts of the film cyan, mid steel, bright parts white
      if (lv < 0.55) f.color.copy(CYAN).lerp(STEEL, lv / 0.55);
      else f.color.copy(STEEL).lerp(WHITE, (lv - 0.55) / 0.45);
    } else if (lv > 0.02) f.color.lerp(_film.setRGB(_px[0], _px[1], _px[2]), Math.min(1, P.color));
    f.level *= 1 - react + react * 0.45 * Math.pow(lv, 1.8) * dyn.duck;
    // each hit strobes every other bar, alternating odd and even, so the wall never disappears behind them
    if (on && dyn.strobe > 0 && !live.blackout && i % 2 === dyn.hits.length % 2) {
      f.color.copy(_white);
      f.level = (time * dyn.strobeHz) % 1 < 0.25 ? S.master.grand * 0.38 * Math.min(1, dyn.strobe * 5) : 0;
    }
  } else {
    // only the front heads take part in big moments; the mid heads stay atmosphere
    const c = on && group === 'front' ? dyn.chaos : 0;
    if (palette) {
      if (group === 'front') f.color.copy(STEEL).lerp(WHITE, c * 0.35);
      else f.color.copy(CYAN);
    } else if (on) {
      const col = group === 'front' ? analyzer.colorA : analyzer.colorB;
      f.color.lerp(_film.setRGB(col[0], col[1], col[2], THREE.SRGBColorSpace), Math.min(1, P.color * 0.85));
    }
    const atmo = 0.32 * dyn.atmo * (group === 'front' ? 1 : 0.7);
    f.level *= 1 - react + react * (atmo + (0.55 - atmo) * c) * dyn.duck;
  }
}

function runMovers(list, p, dt, offset) {
  const n = list.length;
  const dmx = dmxActive() ? dmxFrame.movers : null;
  list.forEach((m, i) => {
    const d = dmx?.[offset + i];
    if (d) {
      // [pan°, tilt°, dimmer, r, g, b, beam°, strobe Hz, gobo index, gobo rotation °/s]
      m.panTarget = d[0]; m.tiltTarget = d[1];
      m.move(dt);
      m.level = dmxLevel(d[2], d[7]);
      m.color.setRGB(d[3], d[4], d[5], THREE.SRGBColorSpace);
      m.halfAngle = THREE.MathUtils.degToRad(d[6] / 2);
      m.gobo = THREE.MathUtils.clamp(d[8] ?? 0, 0, GOBOS.length - 1);
      m.goboAngle += THREE.MathUtils.degToRad(d[9] ?? 0) * dt;
      m.level *= groupLevel(offset ? 'mid' : 'front');
      m.apply(time, hz, atmos.fog, camera, 90, 0.35, 0.9, true);
      return;
    }
    const u = n > 1 ? i / (n - 1) : 0.5, c = u * 2 - 1;
    const w = Math.PI * 2 * (beat / p.speed + p.phase * u);
    let pan = p.pan, tilt = p.tilt;
    switch (p.fx) {
      case 'Fan': pan += c * p.spread; break;
      case 'Circle': pan += c * p.spread * 0.5 + p.size * Math.cos(w); tilt += p.size * Math.sin(w); break;
      case 'Sweep': pan += c * p.spread * 0.5 + p.size * Math.sin(w); break;
      case 'Tilt wave': pan += c * p.spread; tilt += p.size * Math.sin(w); break;
      case 'Ballyhoo': pan += c * p.spread * 0.5 + p.size * 1.5 * Math.sin(w + i * 1.3); tilt += p.size * Math.sin(w * 1.37 + i * 2.1); break;
      case 'Crossfire': pan += (i % 2 ? 1 : -1) * (p.spread * 0.5 + p.size * Math.sin(w)); break;
      case 'Aim at point': {
        const a = MovingHead.aimAngles(m.worldPos, _aim.set(p.aimX, p.aimY, p.aimZ));
        pan = a.pan + p.size * 0.2 * Math.cos(w); tilt = a.tilt + p.size * 0.2 * Math.sin(w);
        break;
      }
    }
    if (dyn.chaos > 0.01 && !offset) {                // big moments: the front heads fan open and lift together
      const k = dyn.chaos;
      pan += k * 16 * c;
      tilt += k * (8 + 6 * Math.sin(time * 1.4));
    }
    const own = S[m.id];
    const ownPos = own.mode === 'Own position' || own.mode === 'Own everything';
    const ownLook = own.mode === 'Own look' || own.mode === 'Own everything';
    m.panTarget = ownPos ? own.pan : pan;
    m.tiltTarget = ownPos ? own.tilt : tilt;
    m.move(dt);
    if (ownLook) {
      m.level = dmxLevel(own.dimmer, own.strobe);
      m.color.set(own.color);
      m.halfAngle = THREE.MathUtils.degToRad(own.zoom / 2);
      m.gobo = Math.max(0, GOBOS.indexOf(own.gobo));
      m.goboAngle += THREE.MathUtils.degToRad(own.goboRot) * dt;
    } else {
      m.level = level(p, i, n);
      fxColor(p, i, n, m.color);
      m.halfAngle = THREE.MathUtils.degToRad(p.zoom / 2);
      m.gobo = Math.max(0, GOBOS.indexOf(p.gobo));
      m.goboAngle += THREE.MathUtils.degToRad(p.goboRot) * dt;
      followVideo(m, offset ? 'mid' : 'front', i);
    }
    m.level *= groupLevel(offset ? 'mid' : 'front');
    identify(m);
    m.apply(time, hz, atmos.fog, camera, 90, 0.35, 0.9, true);
  });
}

// group faders / on-off (apply on top of everything, including DMX)
function groupLevel(g) {
  const M = S.master;
  if (g === 'front') return M.frontOn ? M.frontLevel : 0;
  if (g === 'mid') return M.midOn ? M.midLevel : 0;
  return M.barsOn ? M.barsLevel : 0;
}

// "Identify" flashes one fixture in full white so you can find it in the rig
let identifyId = null, identifyUntil = 0;
function identify(f) {
  if (f.id === identifyId && time < identifyUntil) {
    f.level = (time * 4) % 1 < 0.6 ? 1 : 0.15;
    f.color.setRGB(1, 1, 1);
  }
}

function runBars(p) {
  const n = bars.length;
  const dmx = dmxActive() ? dmxFrame.bars : null;
  bars.forEach((b, i) => {
    const d = dmx?.[i];
    if (d) {
      // [dimmer, r, g, b, strobe Hz, tilt°, beam°]
      b.setTilt(d[5]);
      b.level = dmxLevel(d[0], d[4]);
      b.color.setRGB(d[1], d[2], d[3], THREE.SRGBColorSpace);
      b.halfAngle = THREE.MathUtils.degToRad(d[6] / 2);
    } else {
      const u = n > 1 ? i / (n - 1) : 0.5;
      let tilt = p.tilt;
      if (p.tiltFx === 'Wave') tilt += p.spread * Math.sin(Math.PI * 2 * (beat / p.speed + p.phase * u));
      else if (p.tiltFx === 'Fan') tilt += (i % 2 ? 1 : -1) * p.spread;
      const own = S[b.id];
      const ownPos = own.mode === 'Own position' || own.mode === 'Own everything';
      const ownLook = own.mode === 'Own look' || own.mode === 'Own everything';
      b.setTilt(ownPos ? own.tilt : tilt);
      if (ownLook) {
        b.level = dmxLevel(own.dimmer, own.strobe);
        b.color.set(own.color);
        b.halfAngle = THREE.MathUtils.degToRad(own.zoom / 2);
      } else {
        b.level = level(p, i, n);
        fxColor(p, i, n, b.color);
        b.halfAngle = THREE.MathUtils.degToRad(p.zoom / 2);
        followVideo(b, 'bars', i);
      }
    }
    if (S.master.whiteStrobe || live.whiteHold) {      // LED bars white strobe FX (also over DMX)
      b.color.setRGB(1, 1, 1);
      b.level = live.blackout ? 0 : ((time * S.master.whiteRate) % 1 < 0.25 ? S.master.grand : 0);
    }
    b.level *= groupLevel('bars');
    identify(b);
    const spots = S.render.barSpots && T.bars;
    b.spot.visible = spots;
    b.apply(time, hz, atmos.fog, camera, 140, 0.5, 1.6, spots);
  });
}

// tap tempo
let taps = [];
function tap() {
  const now = performance.now();
  taps = taps.filter(t => now - t < 2500);
  taps.push(now);
  if (taps.length >= 2) {
    const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    S.master.bpm = Math.round(60000 / iv);
    beat = Math.round(beat);
  }
}

// ---------------------------------------------------------------- cues
const CUE_GROUPS = { master: ['grand', 'bpm', 'frontLevel', 'frontOn', 'midLevel', 'midOn', 'barsLevel', 'barsOn', 'whiteStrobe', 'whiteRate'], atmos: null, led: ['pattern', 'colorA', 'colorB', 'speed', 'brightness'], front: null, mid: null, bars: null, show: ['follow', 'palette', 'color', 'react', 'hits'],
  ...Object.fromEntries(FIX_IDS.map(id => [id, null])) };
const CUE_STORE = 'altemuenze-sim-cues-v1';

function snapshot() {
  const o = {};
  for (const [g, keys] of Object.entries(CUE_GROUPS)) {
    o[g] = {};
    for (const k of keys || Object.keys(S[g])) o[g][k] = S[g][k];
  }
  return JSON.parse(JSON.stringify(o));
}
function withOverrides(base, ov) {
  const o = JSON.parse(JSON.stringify(base));
  for (const g in ov) Object.assign(o[g], ov[g]);
  return o;
}

const base = snapshot();
const DEFAULT_CUES = {
  1: base,
  2: withOverrides(base, {
    atmos: { haze: 0.7 },
    led: { pattern: 'Scan', brightness: 1.6 },
    front: { fx: 'Ballyhoo', zoom: 2, dimmer: 1, size: 35, speed: 4, color: '#ffffff', colorFx: 'Static' },
    mid: { fx: 'Crossfire', zoom: 3, dimmer: 1, color: '#ffffff', size: 30, speed: 2, dimFx: 'Random' },
    bars: { color: '#ffffff', strobe: 12, dimmer: 1, tiltFx: 'Fan', spread: 25 },
  }),
  3: withOverrides(base, {
    atmos: { haze: 0.55 },
    led: { pattern: 'Plasma', colorA: '#6a1bff', colorB: '#05010d', brightness: 1.0 },
    front: { dimmer: 0 },
    mid: { fx: 'Aim at point', aimZ: 12, aimY: 0, zoom: 30, color: '#7b2cff', dimmer: 0.9, size: 0, dimFx: 'None' },
    bars: { color: '#7b2cff', dimmer: 0.9, tilt: 10, strobe: 0, dimFx: 'Pulse', speed: 8 },
  }),
  4: withOverrides(base, {
    led: { pattern: 'Hue sweep', brightness: 1.2 },
    front: { fx: 'Circle', colorFx: 'Rainbow', zoom: 5, dimmer: 0.9, size: 25, speed: 8, phase: 1 },
    mid: { fx: 'Tilt wave', colorFx: 'Rainbow', zoom: 6, dimmer: 0.8, size: 30, speed: 8, phase: 1 },
    bars: { colorFx: 'Rainbow', dimFx: 'Chase', speed: 4, dimmer: 1, phase: 1 },
  }),
};
let cues;
try { cues = JSON.parse(localStorage.getItem(CUE_STORE)) || DEFAULT_CUES; } catch { cues = DEFAULT_CUES; }
const saveCues = () => { try { localStorage.setItem(CUE_STORE, JSON.stringify(cues)); } catch { /* storage unavailable */ } };

let fade = null;
function startFade(target, dur) {
  fade = { from: snapshot(), to: target, t: 0, dur: Math.max(0.001, dur) };
  // non-numeric values (FX names, gobos, modes) change at once
  for (const g in target) {
    if (!S[g]) continue;
    for (const k in target[g]) {
      const v = target[g][k];
      if (typeof v !== 'number' && !(typeof v === 'string' && v[0] === '#')) S[g][k] = v;
    }
  }
}
function storeCue(n) { cues[n] = snapshot(); saveCues(); toast(`Stored cue ${n}`); }
function recallCue(n) {
  const c = cues[n];
  if (!c) return toast(`Cue ${n} is empty`);
  live.cue = n;
  startFade(c, S.master.cueFade);
  const held = dmxHeldCount();
  toast(held ? `Cue ${n} · ${held} fixtures are held by TouchDesigner/DMX` : `Cue ${n}`);
}
function dmxHeldCount() {
  if (!dmxActive()) return 0;
  return (dmxFrame.movers || []).filter(Boolean).length + (dmxFrame.bars || []).filter(Boolean).length;
}
function stepFade(dt) {
  if (!fade) return;
  fade.t = Math.min(1, fade.t + dt / fade.dur);
  const e = fade.t * fade.t * (3 - 2 * fade.t);
  for (const g in fade.to) if (S[g]) for (const k in fade.to[g]) {
    const a = fade.from[g]?.[k], b = fade.to[g][k];
    if (typeof b === 'number' && typeof a === 'number') S[g][k] = a + (b - a) * e;
    else if (typeof b === 'string' && b[0] === '#' && typeof a === 'string') S[g][k] = '#' + _ca.set(a).lerp(_cb.set(b), e).getHexString();
  }
  if (fade.t >= 1) fade = null;
  if (!SHOW_MODE) refreshGUI();
}

// ---------------------------------------------------------------- camera presets
const PRESETS = {
  'Photo 1 · left corner': { pos: [-15, 1.7, 17], target: [3, 5.5, 0] },
  'Photo 2 · centre floor': { pos: [1.5, 1.7, 15], target: [0, 5.6, 0] },
  'FOH': { pos: [0, 3.2, 27], target: [0, 4.4, 0] },
  'DJ booth': { pos: [0, 2.2, 2.6], target: [0, 2, 20] },
  'Rigger · truss': { pos: [14, 8.4, 22], target: [-4, 6.5, 2] },
  'Plan (top)': { pos: [0, 42, 14.01], target: [0, 0, 14] },
};
const presetNames = Object.keys(PRESETS);
// the first one is where the client page starts
const CLIENT_CAMERAS = { 'Back of room': 'FOH', 'Floor': 'Photo 2 · centre floor', 'Side': 'Photo 1 · left corner', 'Stage': 'DJ booth' };
let tween = null, presetIdx = 1;
function goTo(name, instant) {
  const p = PRESETS[name];
  if (instant) {
    tween = null;
    camera.position.set(...p.pos);
    controls.target.set(...p.target);
    controls.update();
    return;
  }
  tween = { from: camera.position.clone(), fromT: controls.target.clone(), to: new THREE.Vector3(...p.pos), toT: new THREE.Vector3(...p.target), t: 0 };
}

// ---------------------------------------------------------------- media sources
const fileInput = document.getElementById('file');
fileInput.addEventListener('change', async () => {
  const f = fileInput.files[0];
  fileInput.value = '';
  if (!f) return;
  try { await led.loadFile(f); live.source = 'Media file'; applyMute(); pendingVideo = f; autoSaveShow(); } catch (e) { toast(e.message); }
  refreshGUI();
});

function applyMute() {
  if (audio.gain) { led.video.muted = false; audio.setVolume(live.muted ? 0 : 1); }
  else led.video.muted = live.muted;
}

async function selectSource(v) {
  live.source = v;
  try {
    if (v === 'Generator') led.useGenerator();
    else if (v === 'Test card') led.useTestCard();
    else if (v === 'Media file') fileInput.click();
    else if (v === 'TouchDesigner stream') led.useStream();
    else if (v === 'Spout (SpoutCam)') {
      // TouchDesigner's spout_led sender reaches the browser through the SpoutCam virtual camera
      await led.useNamedCapture(/spoutcam/i, 'SpoutCam');
      S.led.fit = 'Stretch';                 // SpoutCam outputs a fixed size; stretch back to 3840 x 860
      refreshDevices();
    }
    else if (v === 'Capture device') { await led.useCapture(live.device); refreshDevices(); }
    else if (v === 'Screen capture') await led.useScreen();
    else if (v === 'Stream URL') {
      if (!live.url) { toast('Enter a stream URL first'); return; }
      await led.loadURL(live.url);
      applyMute();
    }
  } catch (e) {
    toast(e.message || String(e));
    led.useGenerator();
    live.source = 'Generator';
  }
  refreshGUI();
}

// ---------------------------------------------------------------- remote control (WebSocket JSON)
let ws = null, bridgeSeen = false;
function setPath(path, value) {
  const [g, k] = path.split('.');
  const target = g === 'live' ? live : S[g];
  if (!target || !(k in target)) return;
  // coerce to the existing type so OSC ints can drive toggles and strings can drive sliders
  const cur = target[k];
  if (typeof cur === 'boolean') value = typeof value === 'string' ? value === 'true' || value === '1' : !!value;
  else if (typeof cur === 'number') value = Number(value);
  else value = String(value);
  if (typeof value === 'number' && Number.isNaN(value)) return;
  target[k] = value;
}
// Binary messages from TouchDesigner (via the bridge): [1, 0, ...jpeg] = LED frame, [2, slot, ...jpeg] = custom gobo.
// Only the newest LED frame is decoded; frames that arrive while one is decoding are skipped.
let pendingFrame = null, decoding = false, streamAutoSwitched = false;
function handleBinary(buf) {
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 1) {
    pendingFrame = buf;
    if (!decoding) decodeFrames();
  } else if (head[0] === 2) {
    const slot = THREE.MathUtils.clamp(head[1] || 1, 1, 4);
    createImageBitmap(new Blob([new Uint8Array(buf, 2)]), { imageOrientation: 'flipY' }).then(bmp => {
      const t = new THREE.Texture(bmp);
      t.flipY = false;
      t.needsUpdate = true;
      gobos.setCustom(slot, t);
      t.dispose();
      bmp.close();
    }).catch(() => {});
  }
}
async function decodeFrames() {
  decoding = true;
  while (pendingFrame) {
    const buf = pendingFrame;
    pendingFrame = null;
    try {
      led.setStreamFrame(await createImageBitmap(new Blob([new Uint8Array(buf, 2)]), { imageOrientation: 'flipY' }));
      // first frame of the session: switch the wall to the stream unless a media source is playing
      if (!streamAutoSwitched && ['Generator', 'Test card', 'Spout (SpoutCam)'].includes(live.source)) {
        streamAutoSwitched = true;
        selectSource('TouchDesigner stream');
        toast('LED wall: showing the TouchDesigner stream');
      }
    } catch { /* corrupt frame */ }
  }
  decoding = false;
}

function handleMessage(m) {
  if (m.gobo && m.gobo.image) {
    const slot = THREE.MathUtils.clamp(Math.round(m.gobo.slot || 1), 1, 4);
    gobos.setCustomImage(slot, m.gobo.image).catch(() => {});
    return;
  }
  if (m.dmx) { dmxFrame = m.dmx; dmxAt = performance.now(); return; }
  if (m.ledSource && SOURCES.includes(m.ledSource)) selectSource(m.ledSource);
  if (m.cue) recallCue(m.cue);
  if (m.set) for (const [p, v] of Object.entries(m.set)) setPath(p, v);
  if (m.path) setPath(m.path, m.value);
  if ('blackout' in m) live.blackout = !!m.blackout;
  if ('flash' in m) live.flash = !!m.flash;
  if (m.fogBurst) atmos.burst(160, S.atmos.fogMode === 'Low fog');
  if (m.camera && PRESETS[m.camera]) goTo(m.camera);
  refreshGUI();
}
function connectWS() {
  if (ws) ws.close();
  try { ws = new WebSocket(live.ws); } catch (e) { toast(e.message); return; }
  live.wsStatus = 'connecting…';
  ws.onopen = () => { bridgeSeen = true; live.wsStatus = 'connected'; refreshGUI(); toast('Bridge connected'); };
  ws.onclose = () => {
    live.wsStatus = 'disconnected'; refreshGUI();
    if (bridgeSeen) setTimeout(connectWS, 2000);   // bridge restarted: keep trying
  };
  ws.onerror = () => { live.wsStatus = 'error'; refreshGUI(); };
  ws.binaryType = 'arraybuffer';
  ws.onmessage = e => {
    if (typeof e.data !== 'string') { handleBinary(e.data); return; }
    try { handleMessage(JSON.parse(e.data)); } catch { /* ignore malformed */ }
  };
}

// ---------------------------------------------------------------- GUI
const gui = new GUI({ title: 'Show control', width: 320 });
const refreshGUI = () => gui.controllersRecursive().forEach(c => c.updateDisplay());

const fMaster = gui.addFolder('Master');
fMaster.add(S.master, 'grand', 0, 1, 0.01).name('Grand master');
fMaster.add(live, 'blackout').name('Blackout  [B]');
fMaster.add(S.master, 'bpm', 60, 200, 1).name('BPM');
fMaster.add({ tap }, 'tap').name('Tap tempo  [T]');
fMaster.add(S.master, 'frontLevel', 0, 1, 0.01).name('Front movers level');
fMaster.add(S.master, 'frontOn').name('Front movers on');
fMaster.add(S.master, 'midLevel', 0, 1, 0.01).name('Mid movers level');
fMaster.add(S.master, 'midOn').name('Mid movers on');
fMaster.add(S.master, 'barsLevel', 0, 1, 0.01).name('LED bars level');
fMaster.add(S.master, 'barsOn').name('LED bars on');
fMaster.add(S.master, 'whiteStrobe').name('LED bars WHITE STROBE  [hold S]');
fMaster.add(S.master, 'whiteRate', 1, 25, 0.5).name('White strobe rate Hz');

const fCue = gui.addFolder('Cues  [1–8 recall · Shift store]');
fCue.add(live, 'cue', 1, 8, 1).name('Cue #');
fCue.add(S.master, 'cueFade', 0, 10, 0.1).name('Fade time (s)');
fCue.add({ recall: () => recallCue(live.cue) }, 'recall').name('Recall');
fCue.add({ store: () => storeCue(live.cue) }, 'store').name('Store');
fCue.add({
  exp: () => {
    const blob = new Blob([JSON.stringify({ cues, state: S }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'altemuenze-show.json'; a.click();
  },
}, 'exp').name('Export show file');
const showInput = document.getElementById('showfile');
showInput.addEventListener('change', async () => {
  const f = showInput.files[0]; showInput.value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (j.cues) { cues = j.cues; saveCues(); }
    if (j.state) for (const g in j.state) if (S[g]) Object.assign(S[g], j.state[g]);
    refreshGUI(); toast('Show file loaded');
  } catch (e) { toast('Invalid show file'); }
});
fCue.add({ imp: () => showInput.click() }, 'imp').name('Import show file');
fCue.close();

const fAtmos = gui.addFolder('Haze & fog');
fAtmos.add(S.atmos, 'haze', 0, 1, 0.01).name('Haze density');
fAtmos.add(S.atmos, 'turbulence', 0, 1, 0.01).name('Haze turbulence');
fAtmos.add(S.atmos, 'hazeScale', 0.3, 3, 0.01).name('Haze detail');
fAtmos.add(S.atmos, 'drift', 0, 4, 0.01).name('Haze drift speed');
fAtmos.add(S.atmos, 'scatter', 0, 3, 0.01).name('Light scatter');
fAtmos.add(S.atmos, 'fogMode', ['Machine', 'Low fog']).name('Fog type');
fAtmos.add(S.atmos, 'fogOutput', 0, 1, 0.01).name('Fog output');
fAtmos.add(S.atmos, 'fogDensity', 0, 2, 0.01).name('Fog opacity');
fAtmos.add({ burst: () => atmos.burst(160, S.atmos.fogMode === 'Low fog') }, 'burst').name('Fog burst  [G]');

const fLed = gui.addFolder(`LED wall · ${LED.pxW}×${LED.pxH}`);
fLed.add(live, 'source', SOURCES).name('Source').onChange(selectSource);
fLed.add(S.led, 'pattern', PATTERNS).name('Generator');
fLed.addColor(S.led, 'colorA').name('Colour A');
fLed.addColor(S.led, 'colorB').name('Colour B');
fLed.add(S.led, 'speed', 0, 4, 0.01).name('Speed');
fLed.add(S.led, 'brightness', 0, 3, 0.01).name('Brightness');
fLed.add(S.led, 'roomLight', 0, 3, 0.01).name('Spill on room');
fLed.add(S.led, 'fit', ['Fill', 'Fit', 'Stretch']).name('Fit');
fLed.add(S.led, 'zoom', 0.25, 4, 0.01).name('Zoom');
fLed.add(S.led, 'offsetX', -1, 1, 0.001).name('Offset X');
fLed.add(S.led, 'offsetY', -1, 1, 0.001).name('Offset Y');
fLed.add(S.led, 'pixelGrid').name('Show LED pixels up close');
fLed.add(S.led, 'contentRes', ['Full', 'Half']).name('Generator resolution');
const fIn = fLed.addFolder('Inputs');
fIn.add({ pick: () => fileInput.click() }, 'pick').name('Load video / image…');
let deviceCtrl = fIn.add(live, 'device', { '(default)': '' }).name('Capture device');
async function refreshDevices() {
  const list = await LedWall.listDevices();
  const opts = { '(default)': '' };
  list.forEach((d, i) => { opts[d.label || `Camera ${i + 1}`] = d.deviceId; });
  deviceCtrl = deviceCtrl.options(opts).name('Capture device')
    .onChange(() => { if (live.source === 'Capture device') selectSource('Capture device'); });
}
fIn.add({ refreshDevices }, 'refreshDevices').name('Refresh device list');
fIn.add({ go: () => selectSource('Capture device') }, 'go').name('Start capture device');
fIn.add({ go: () => selectSource('Screen capture') }, 'go').name('Capture screen / window…');
fIn.add(live, 'url').name('Stream URL');
fIn.add({ go: () => selectSource('Stream URL') }, 'go').name('Play URL');
fIn.add(live, 'muted').name('Mute media audio').onChange(() => { audio.attach(led.video); applyMute(); });

function moverFolder(title, p) {
  const f = gui.addFolder(title);
  f.add(p, 'dimmer', 0, 1, 0.01).name('Dimmer');
  f.addColor(p, 'color').name('Colour A');
  f.addColor(p, 'colorB').name('Colour B');
  f.add(p, 'colorFx', COLOR_FX).name('Colour FX');
  f.add(p, 'zoom', 1.5, 45, 0.5).name('Beam angle °');
  f.add(p, 'strobe', 0, 25, 0.5).name('Strobe Hz');
  f.add(p, 'fx', MOVE_FX).name('Movement FX');
  f.add(p, 'pan', -180, 180, 1).name('Pan °');
  f.add(p, 'tilt', -120, 120, 1).name('Tilt °');
  f.add(p, 'spread', 0, 180, 1).name('Fan spread °');
  f.add(p, 'size', 0, 90, 1).name('FX size °');
  f.add(p, 'speed', 0.5, 32, 0.5).name('FX beats / cycle');
  f.add(p, 'phase', 0, 2, 0.05).name('FX phase spread');
  f.add(p, 'dimFx', DIM_FX).name('Dimmer FX');
  f.add(p, 'gobo', GOBOS).name('Gobo');
  f.add(p, 'goboRot', -360, 360, 1).name('Gobo rotation °/s');
  const a = f.addFolder('Aim point (Aim FX)');
  a.add(p, 'aimX', -18, 18, 0.1).name('X');
  a.add(p, 'aimY', 0, 10, 0.1).name('Y');
  a.add(p, 'aimZ', 0, 32, 0.1).name('Z');
  a.close();
  f.close();
  return f;
}
moverFolder(`Movers · front truss (${front.length})`, S.front);
moverFolder(`Movers · mid truss (${mid.length})`, S.mid);

const fBars = gui.addFolder(`LED bars (${bars.length})`);
fBars.add(S.bars, 'dimmer', 0, 1, 0.01).name('Dimmer');
fBars.addColor(S.bars, 'color').name('Colour A');
fBars.addColor(S.bars, 'colorB').name('Colour B');
fBars.add(S.bars, 'colorFx', COLOR_FX).name('Colour FX');
fBars.add(S.bars, 'strobe', 0, 25, 0.5).name('Strobe Hz');
fBars.add(S.bars, 'dimFx', DIM_FX).name('Dimmer FX');
fBars.add(S.bars, 'tilt', -90, 90, 1).name('Tilt °');
fBars.add(S.bars, 'tiltFx', ['Static', 'Wave', 'Fan']).name('Tilt FX');
fBars.add(S.bars, 'spread', 0, 60, 1).name('Tilt FX size °');
fBars.add(S.bars, 'zoom', 10, 90, 1).name('Beam angle °');
fBars.add(S.bars, 'speed', 0.5, 32, 0.5).name('FX beats / cycle');
fBars.add(S.bars, 'phase', 0, 2, 0.05).name('FX phase spread');
fBars.close();

const goboInput = document.getElementById('gobofile');
let goboSlot = 1;
goboInput.addEventListener('change', async () => {
  const f = goboInput.files[0]; goboInput.value = '';
  if (!f) return;
  const url = URL.createObjectURL(f);
  try { await gobos.setCustomImage(goboSlot, url); toast(`Custom gobo ${goboSlot} loaded`); } catch { toast('Could not load image'); }
  URL.revokeObjectURL(url);
});
const fGobo = gui.addFolder('Custom gobos');
for (let k = 1; k <= 4; k++) fGobo.add({ go: () => { goboSlot = k; goboInput.click(); } }, 'go').name(`Load image → Custom ${k}`);
fGobo.close();

// Individual fixtures: pick one, set its mode and values; copy the settings to others ("m1-m4, m9, b1-b11")
const fInd = gui.addFolder('Individual fixtures');
const ed = { fixture: 'm1', copyTo: '' };
fInd.add(ed, 'fixture', Object.fromEntries(allLights.map(f => [f.label, f.id]))).name('Fixture').onChange(buildFixturePanel);
fInd.add({ go: () => { identifyId = ed.fixture; identifyUntil = time + 2; } }, 'go').name('Identify (flash 2 s)');
let fixPanel = null;
function buildFixturePanel() {
  fixPanel?.destroy();
  const p = S[ed.fixture];
  const isMover = ed.fixture[0] === 'm';
  fixPanel = fInd.addFolder(allLights.find(f => f.id === ed.fixture).label);
  fixPanel.add(p, 'mode', FIX_MODES).name('Mode');
  fixPanel.add(p, 'dimmer', 0, 1, 0.01).name('Dimmer');
  fixPanel.addColor(p, 'color').name('Colour');
  fixPanel.add(p, 'strobe', 0, 25, 0.5).name('Strobe Hz');
  fixPanel.add(p, 'zoom', isMover ? 1.5 : 10, isMover ? 45 : 90, 0.5).name('Beam angle °');
  if (isMover) {
    fixPanel.add(p, 'gobo', GOBOS).name('Gobo');
    fixPanel.add(p, 'goboRot', -360, 360, 1).name('Gobo rotation °/s');
    fixPanel.add(p, 'pan', -270, 270, 1).name('Pan °');
  }
  fixPanel.add(p, 'tilt', isMover ? -135 : -90, isMover ? 135 : 90, 1).name('Tilt °');
}
function parseFixtureList(text) {
  const out = new Set();
  for (const part of text.toLowerCase().split(/[,\s]+/).filter(Boolean)) {
    if (part === 'movers' || part === 'all-movers') movers.forEach(m => out.add(m.id));
    else if (part === 'bars' || part === 'all-bars') bars.forEach(b => out.add(b.id));
    else if (part === 'all') FIX_IDS.forEach(id => out.add(id));
    else {
      const r = part.match(/^([mb])(\d+)(?:-(?:[mb])?(\d+))?$/);
      if (r) for (let k = +r[2]; k <= +(r[3] || r[2]); k++) if (S[r[1] + k]) out.add(r[1] + k);
    }
  }
  return [...out];
}
fInd.add(ed, 'copyTo').name('Copy settings to…');
fInd.add({ go: () => {
  const src = S[ed.fixture], ids = parseFixtureList(ed.copyTo);
  for (const id of ids) if (id[0] === ed.fixture[0]) Object.assign(S[id], JSON.parse(JSON.stringify(src)));
  toast(ids.length ? `Copied to ${ids.length} fixtures` : 'Type fixtures like: m1-m4, m9, b1-b11, movers, bars, all');
} }, 'go').name('Copy');
fInd.add({ go: () => { FIX_IDS.forEach(id => { S[id].mode = 'Follow group'; }); refreshGUI(); toast('All fixtures follow their group'); } }, 'go')
  .name('Release all → follow group');
buildFixturePanel();
fInd.close();

const fVenue = gui.addFolder('Venue');
fVenue.add(S.venue, 'house', 0, 1, 0.01).name('House lights');
fVenue.add(S.venue, 'floorGloss', 0, 1, 0.01).name('Floor gloss');
fVenue.add(S.venue, 'truss').name('Truss');
fVenue.add(S.venue, 'booth').name('DJ booth');
fVenue.add(S.venue, 'pa').name('PA');
fVenue.close();

const fCam = gui.addFolder('Camera  [C]');
presetNames.forEach(n => fCam.add({ go: () => goTo(n) }, 'go').name(n));
fCam.close();

const fShow = gui.addFolder('Show · lights follow the video');
fShow.add(S.show, 'follow').name('Lights follow video');
fShow.add(S.show, 'palette', PALETTE_NAMES).name('Light colours');
fShow.add(S.show, 'color', 0, 1, 0.01).name('Colour from video');
fShow.add(S.show, 'react', 0, 1, 0.01).name('Brightness reaction');
fShow.add(S.show, 'hits', 0, 1, 0.01).name('Flash on hits / kicks');
fShow.add(S.show, 'director').name('Auto director (no timeline)');
const tlUi = { look: 'Peak' };
const TL_CHOICES = [...LOOK_NAMES, ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => `Cue ${n}`)];
fShow.add(tlUi, 'look', TL_CHOICES).name('Look');
fShow.add({ go: () => triggerLook(tlUi.look) }, 'go').name('Try this look now');
fShow.add({ go: () => addMarker(tlUi.look) }, 'go').name('Add to timeline at playhead  [M]');
fShow.add({ go: removeNearestMarker }, 'go').name('Remove nearest marker');
fShow.add({ go: () => { timeline = []; tlIndex = -1; director.reset(); autoSaveShow(); toast('Timeline cleared, auto director is back on'); } }, 'go').name('Clear timeline');
fShow.add(S.show, 'title').name('Show title');
fShow.add(S.show, 'date').name('Show date');
fShow.add({ go: () => saveShow(true) }, 'go').name('Save show for the client link');
fShow.add({ go: () => makePoster() }, 'go').name('Make link preview image (from this view)');

const fRender = gui.addFolder('Render');
fRender.add(S.render, 'exposure', 0.2, 3, 0.01).name('Exposure');
fRender.add(S.render, 'bloom', 0, 2, 0.01).name('Bloom');
fRender.add(S.render, 'reflections').name('Floor reflections');
fRender.add(S.render, 'barSpots').name('Bar floor lighting');
fRender.add(S.render, 'quality', ['High', 'Medium', 'Low', 'Auto']).name('Quality').onChange(() => { autoTier = IS_MOBILE ? 2 : 0; resize(); });
fRender.close();

const fRemote = gui.addFolder('Remote (WebSocket)');
fRemote.add(live, 'ws').name('URL');
fRemote.add({ connectWS }, 'connectWS').name('Connect');
fRemote.add(live, 'wsStatus').name('Status').disable();
fRemote.add(live, 'followDmx').name('Follow DMX (fixtures)');
fRemote.add(live, 'dmxStatus').name('DMX').disable();
fRemote.close();

// ---------------------------------------------------------------- HUD / input
const $ = id => document.getElementById(id);
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

addEventListener('keydown', e => {
  if (e.target.closest?.('input, textarea, select')) return;
  if (e.code === 'Space' && transport.available()) { e.preventDefault(); transport.toggle(); return; }
  if (SHOW_MODE) { if (e.code === 'KeyC') cycleClientCamera(); return; }
  const d = e.code.match(/^Digit([1-8])$/);
  if (d) { e.shiftKey ? storeCue(+d[1]) : recallCue(+d[1]); return; }
  switch (e.code) {
    case 'KeyM': addMarker(tlUi.look); break;
    case 'KeyB': live.blackout = !live.blackout; refreshGUI(); break;
    case 'KeyF': live.flash = true; break;
    case 'KeyS': live.whiteHold = true; break;
    case 'KeyT': tap(); refreshGUI(); break;
    case 'KeyG': atmos.burst(160, S.atmos.fogMode === 'Low fog'); break;
    case 'KeyC': presetIdx = (presetIdx + 1) % presetNames.length; goTo(presetNames[presetIdx]); toast(presetNames[presetIdx]); break;
    case 'KeyH': document.body.classList.toggle('hidden-ui'); gui.show(!document.body.classList.contains('hidden-ui')); break;
  }
});
addEventListener('keyup', e => {
  if (e.code === 'KeyF') live.flash = false;
  if (e.code === 'KeyS') live.whiteHold = false;
});

const drop = $('drop');
addEventListener('dragover', e => { e.preventDefault(); if (!SHOW_MODE) drop.classList.add('show'); });
addEventListener('dragleave', e => { if (e.target === drop) drop.classList.remove('show'); });
addEventListener('drop', async e => {
  e.preventDefault(); drop.classList.remove('show');
  const f = e.dataTransfer.files[0];
  if (!f || SHOW_MODE) return;
  try { await led.loadFile(f); live.source = 'Media file'; applyMute(); pendingVideo = f; autoSaveShow(); refreshGUI(); toast(`Playing ${f.name}`); } catch (err) { toast(err.message); }
});

function currentTier() {
  const q = S.render.quality;
  return q === 'Auto' ? autoTier : q === 'High' ? 0 : q === 'Medium' ? 1 : 2;
}
function resize() {
  const q = S.render.quality, idx = currentTier();
  T = TIERS[idx];
  const pr = (q === 'High' ? Math.min(devicePixelRatio, 2) : Math.min(devicePixelRatio, T.pr));
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight);
  if (composer.renderTarget1.samples !== T.msaa) {
    for (const rt of [composer.renderTarget1, composer.renderTarget2]) { rt.samples = T.msaa; rt.dispose(); }
  }
  composer.setPixelRatio(pr);
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  if (SHOW_MODE) {                                    // tall screens get a wider lens so the 30 m wall still fits
    const hfov = THREE.MathUtils.degToRad(82);
    const vfov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / camera.aspect));
    camera.fov = THREE.MathUtils.clamp(vfov, 62, 100);
  }
  camera.updateProjectionMatrix();
  venue.setReflectorSize(innerWidth * pr * T.refl, innerHeight * pr * T.refl);
  venue.setTaps(T.taps);
  hz.steps = T.beam;
  bloom.enabled = T.bloom;
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
const ambient = new THREE.Vector3();
let fpsAcc = 0, fpsN = 0;
const hudSrc = $('src'), hudFps = $('fps'), hudBeat = $('beat');

function frame() {
  requestAnimationFrame(frame);
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.1);
  time += dt;
  beat += (dt * S.master.bpm) / 60;
  stepFade(dt);
  tickShow(dt);
  tickQuality(rawDt);

  if (tween) {
    tween.t = Math.min(1, tween.t + dt / 1.4);
    const e = 1 - Math.pow(1 - tween.t, 3);
    camera.position.lerpVectors(tween.from, tween.to, e);
    controls.target.lerpVectors(tween.fromT, tween.toT, e);
    if (tween.t >= 1) tween = null;
  }
  controls.update();
  camera.position.y = Math.max(camera.position.y, 0.3);
  camera.position.z = Math.max(camera.position.z, 0.4);
  if (SHOW_MODE) {                                    // the client stays inside the hall
    camera.position.x = THREE.MathUtils.clamp(camera.position.x, -ROOM.width / 2 + 1, ROOM.width / 2 - 1);
    camera.position.y = THREE.MathUtils.clamp(camera.position.y, 0.5, ROOM.height - 1.2);
    camera.position.z = THREE.MathUtils.clamp(camera.position.z, 1, ROOM.depth - 1);
  }

  // venue
  const V = S.venue;
  venue.truss.visible = V.truss;
  venue.booth.visible = V.booth;
  venue.pa.visible = V.pa;
  venue.setReflections(S.render.reflections, V.floorGloss);
  venue.setHouse(V.house);
  venue.ceiling.visible = camera.position.y < ROOM.height;

  // fixtures
  hz.haze = S.atmos.haze;
  hz.turb = S.atmos.turbulence;
  hz.scale = S.atmos.hazeScale;
  hz.flow = S.atmos.drift;
  hz.fogBoost = Math.min(1.5, atmos.parts.length / 250) * S.atmos.fogDensity;
  runMovers(front, S.front, dt, 0);
  runMovers(mid, S.mid, dt, front.length);
  runBars(S.bars);
  for (let i = 0; i < MAX_GOBO_FIXTURES && i < movers.length; i++) {
    const m = movers[i], c = goboCell(m.gobo);
    GOBO_UNIFORMS.uGoboData.value[i].set(c.x, c.y, m.goboAngle, Math.tan(m.halfAngle));
    GOBO_UNIFORMS.uGoboUp.value[i].copy(m.worldUp);
  }

  // LED wall
  led.update(time, S.led, atmos.fog);
  gobos.update();

  // light scattered by haze tints the whole room atmosphere
  const fc = atmos.fog.color.setRGB(0.004, 0.004, 0.005);
  const k = S.atmos.haze * S.atmos.scatter;
  for (const f of allLights) {
    const w = (f.isBar ? 0.0012 : 0.001) * f.level * k;
    fc.r += f.color.r * w; fc.g += f.color.g * w; fc.b += f.color.b * w;
  }
  const lw = S.led.brightness * S.led.roomLight * 0.03 * k;
  fc.r += led.avgAll.r * lw; fc.g += led.avgAll.g * lw; fc.b += led.avgAll.b * lw;
  fc.r += V.house * 0.05; fc.g += V.house * 0.05; fc.b += V.house * 0.05;

  ambient.setScalar(V.house * 0.6 + 0.01);
  atmos.update(dt, time, S.atmos, allLights, led.avg, ambient);

  renderer.toneMappingExposure = S.render.exposure;
  bloom.strength = S.render.bloom;
  composer.render();

  // HUD
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { hudFps.textContent = `${Math.round(fpsN / fpsAcc)} fps`; fpsAcc = 0; fpsN = 0; }
  const dmxNow = dmxActive() ? 'receiving' : 'no DMX';
  if (dmxNow !== live.dmxStatus) { live.dmxStatus = dmxNow; refreshGUI(); }
  const held = dmxHeldCount();
  hudSrc.textContent = (dmxNow === 'receiving' ? `DMX holds ${held}/${allLights.length} fixtures · ` : '') + (led.source === 'Generator' ? led.info : `${live.source} · ${led.info}`);
  hudBeat.style.opacity = 1 - (beat % 1);
  transport.update(led.source === 'Media');
  if (SHOW_MODE) ui.update({ hit: analyzer.valid ? analyzer.hit : 0, audio, muted: live.muted, playing: !led.video.paused });
}

// ---------------------------------------------------------------- show: timeline, auto director, saving
let timeline = [], tlIndex = -1, fogCooldown = 0, qAcc = 0, qN = 0, qGrace = 4;
let lastLook = '', pendingVideo = null, videoName = null, saveWarned = false, saveTimer = null;

function hasVideo() { return !!(led.video.currentSrc || led.video.srcObject) && led.video.videoWidth > 0; }

function triggerLook(name) {
  lastLook = name;
  if (LOOKS[name]) startFade(LOOKS[name], 1.6);
  else { const n = +name.split(' ')[1]; if (cues[n]) startFade(cues[n], S.master.cueFade); }
}

function tickShow(dt) {
  const isMedia = led.source === 'Media';
  const src = isMedia ? (hasVideo() ? led.video : led.mediaTex?.image) : led.source === 'Stream' ? led.streamTex?.image : null;
  const ready = src === led.video ? led.video.readyState >= 2 : !!src;
  analyzer.update(src, dt, ready && !dmxActive());
  if (!analyzer.valid) { dyn.atmo = dyn.chaos = dyn.strobe = dyn.chaosHold = 0; return; }
  const playing = src === led.video && !led.video.paused;
  if (playing && audio.update(dt, time)) {
    analyzer.kick(0.85 * Math.min(1, audio.level * 1.6));
    beat += (Math.round(beat) - beat) * 0.2;
  }
  if (audio.bpm && S.show.follow) S.master.bpm = audio.bpm;
  const audible = audio.slow > 0.05;
  const energy = audible ? 0.5 * analyzer.energy + 0.5 * Math.min(1, audio.slow * 1.35) : analyzer.energy;

  if (timeline.length && src === led.video) {
    const ct = led.video.currentTime;
    let i = -1;
    while (i + 1 < timeline.length && timeline[i + 1].t <= ct) i++;
    if (i !== tlIndex) { tlIndex = i; if (i >= 0) triggerLook(timeline[i].look); }
  } else if (S.show.director && S.show.follow && (playing || src !== led.video)) {
    const name = director.update(dt, energy, analyzer.hit);
    if (name) triggerLook(name);
  }
  tickDynamics(dt, playing || src !== led.video, audible);
}

function tickDynamics(dt, running, audible) {
  if (!S.show.follow) { dyn.atmo = dyn.chaos = dyn.strobe = dyn.chaosHold = 0; return; }
  const ef = audible ? Math.max(analyzer.energyFast, Math.min(1, audio.level * 1.3)) : analyzer.energyFast;
  // atmosphere follows how busy the picture is right now; black film = no light
  const atmoT = running ? THREE.MathUtils.smoothstep(ef, 0.22, 0.6) : dyn.atmo;
  dyn.atmo += (atmoT - dyn.atmo) * (1 - Math.exp(-dt * (atmoT > dyn.atmo ? 2.5 : 3.5)));
  // every flash or cut in the film (or kick in the sound) fires a strobe burst on the bars
  const h = analyzer.hit * S.show.hits;
  if (running && h > 0.3 && h > dyn.lastHit + 0.15) {
    dyn.hits = dyn.hits.filter(t => time - t < 1.8);
    dyn.hits.push(time);
    dyn.strobe = Math.max(dyn.strobe, 0.15 + 0.45 * Math.min(1, h));
    dyn.strobeHz = 10 + 8 * Math.min(1, h);
    // hits in a cluster, or one huge hit in a busy picture: chaos
    if (dyn.hits.length >= 3 || (h > 0.85 && ef > 0.55)) dyn.chaosHold = 0.9 + 0.6 * Math.min(1, h);
  }
  // the brighter the wall, the further the rig steps back (fast down, slow back up)
  const bright = THREE.MathUtils.smoothstep(analyzer.luma / analyzer.lumaPeak, 0.25, 0.85);
  const duckT = 1 - 0.7 * bright;
  dyn.duck += (duckT - dyn.duck) * (1 - Math.exp(-dt * (duckT < dyn.duck ? 8 : 2)));
  dyn.lastHit = h;
  dyn.strobe = Math.max(0, dyn.strobe - dt);
  dyn.chaosHold -= dt;
  fogCooldown -= dt;
  if (ef < 0.12) dyn.chaosHold = Math.min(dyn.chaosHold, 0);  // the film went dark: so does the chaos
  const chaosT = dyn.chaosHold > 0 ? 1 : 0;
  dyn.chaos += (chaosT - dyn.chaos) * (1 - Math.exp(-dt * (chaosT ? 10 : 3.5)));
}

function tickQuality(rawDt) {
  if (S.render.quality !== 'Auto' || autoTier >= TIERS.length - 1) return;
  if (rawDt > 0.25) return;                           // tab was hidden
  qGrace -= rawDt;
  if (qGrace > 0) return;
  qAcc += rawDt; qN++;
  if (qAcc < 2) return;
  const avg = qAcc / qN;
  qAcc = 0; qN = 0;
  if (avg > 1 / 40) { autoTier++; qGrace = 3; resize(); }
}

function addMarker(look) {
  if (!hasVideo()) return toast('Load a video first');
  const t = +led.video.currentTime.toFixed(2);
  timeline = timeline.filter(m => Math.abs(m.t - t) > 0.05);
  timeline.push({ t, look });
  timeline.sort((a, b) => a.t - b.t);
  tlIndex = -2;
  autoSaveShow();
  toast(`${look} at ${Transport.fmt(t)}`);
}
function removeNearestMarker() {
  if (!timeline.length) return;
  const ct = led.video.currentTime;
  let best = 0;
  timeline.forEach((m, i) => { if (Math.abs(m.t - ct) < Math.abs(timeline[best].t - ct)) best = i; });
  timeline.splice(best, 1);
  tlIndex = -2;
  autoSaveShow();
}

function showData() {
  return { version: 1, title: S.show.title, date: S.show.date, video: videoName, timeline, cues, state: snapshot() };
}
async function saveShow(loud) {
  try {
    if (pendingVideo) {
      if (loud) toast('Copying the video into the project…');
      const ext = (pendingVideo.name.split('.').pop() || 'mp4').toLowerCase();
      const r = await fetch(`/save-video?ext=${encodeURIComponent(ext)}`, { method: 'POST', headers: { 'X-Sim-Save': '1' }, body: pendingVideo });
      if (!r.ok) throw new Error(await r.text());
      videoName = `show/video.${ext}`;
      pendingVideo = null;
    }
    const r = await fetch('/save-show', { method: 'POST', headers: { 'X-Sim-Save': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(showData(), null, 1) });
    if (!r.ok) throw new Error(await r.text());
    if (loud) toast('Show saved. Build the client link with tools/build_site.py');
  } catch (e) {
    if (loud || !saveWarned) toast('Could not save the show: run the simulator with start.bat');
    saveWarned = true;
  }
}
function autoSaveShow() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveShow(false), 800);
}

async function loadShow() {
  let data = null;
  try {
    const r = await fetch(SHOW_URL, { cache: 'no-store' });
    if (r.ok) data = await r.json();
  } catch { /* no saved show yet */ }
  if (!data) return null;
  for (const g in data.state || {}) if (S[g]) Object.assign(S[g], data.state[g]);
  if (data.title) S.show.title = data.title;
  if (data.date) S.show.date = data.date;
  if (data.cues) cues = data.cues;
  timeline = data.timeline || [];
  videoName = data.video || null;
  refreshGUI();
  return data;
}

// ---------------------------------------------------------------- transport + client start screen
const ui = SHOW_MODE ? new ClientUI() : null;
const transport = new Transport(led.video, {
  markers: () => timeline,
  onUserGesture: () => { audio.attach(led.video); applyMute(); },
  isMuted: () => live.muted,
  setMuted: m => { live.muted = m; audio.attach(led.video); applyMute(); refreshGUI(); },
  onSeek: () => { tlIndex = -2; },
});

let clientCam = 0;
function cycleClientCamera() {
  const names = Object.keys(CLIENT_CAMERAS);
  clientCam = (clientCam + 1) % names.length;
  selectClientCamera(names[clientCam]);
}
function selectClientCamera(label) {
  goTo(CLIENT_CAMERAS[label]);
  document.querySelectorAll('#cams button').forEach(b => b.classList.toggle('on', b.dataset.label === label));
  ui?.moveCamDot();
}

const MIN_SHOW_SECONDS = 60;
let playedTime = 0;

// Before the film starts the rig is a few thin white beams on black.
let idleKeep = null;
function setIdlePalette(on) {
  if (on && !idleKeep) {
    idleKeep = { front: { ...S.front }, mid: { ...S.mid }, bars: { ...S.bars }, haze: S.atmos.haze };
    Object.assign(S.front, { color: '#ffffff', colorFx: 'Static', dimmer: 0.32, zoom: 2.5, fx: 'Fan', spread: 34, tilt: 16, strobe: 0, dimFx: 'None', gobo: 'Open' });
    S.mid.dimmer = 0;
    S.bars.dimmer = 0;
    S.atmos.haze = 0.32;
  } else if (!on && idleKeep) {
    Object.assign(S.front, idleKeep.front);
    Object.assign(S.mid, idleKeep.mid);
    Object.assign(S.bars, idleKeep.bars);
    S.atmos.haze = idleKeep.haze;
    idleKeep = null;
  }
}

// Controls fade away while the show plays, and come back when the viewer moves.
let idleTimer = 0;
function wakeUi() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (document.body.classList.contains('started') && !led.video.paused) document.body.classList.add('idle');
  }, 3500);
}

// The image shown when the link is shared: the current view of the hall in black and white, with the title.
async function makePoster() {
  await document.fonts.load('900 100px Archivo');
  composer.render();
  const src = renderer.domElement, W = 1200, H = 630;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const k = Math.max(W / src.width, H / src.height);
  g.filter = 'grayscale(1) contrast(1.08)';
  g.drawImage(src, (W - src.width * k) / 2, (H - src.height * k) / 2, src.width * k, src.height * k);
  g.filter = 'none';
  const scrim = g.createLinearGradient(0, H, 0, H * 0.3);
  scrim.addColorStop(0, 'rgba(0,0,0,.9)');
  scrim.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = scrim;
  g.fillRect(0, 0, W, H);
  const words = S.show.title.toUpperCase().split(/\s+/);
  let size = 170;
  for (;; size -= 4) {
    g.font = `900 ${size}px Archivo, Arial, sans-serif`;
    if (g.measureText(words.join(' ')).width <= W - 112 || size < 40) break;
  }
  let x = 56;
  words.forEach((w, i) => {
    g.fillStyle = i === words.length - 1 ? '#fff' : '#757575';
    g.fillText(w, x, H - 52);
    x += g.measureText(w + ' ').width;
  });
  g.fillStyle = '#fff';
  g.font = '500 26px Archivo, Arial, sans-serif';
  g.globalAlpha = 0.7;
  g.fillText(['Alte Münze, Berlin', formatShowDate(S.show.date)].filter(Boolean).join('  ·  '), 58, H - 52 - size * 0.86);
  g.globalAlpha = 1;
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
  const res = await fetch('/save-poster', { method: 'POST', headers: { 'X-Sim-Save': '1' }, body: blob });
  toast(res.ok ? 'Link preview image saved' : 'Could not save the image');
  return res.ok;
}

async function startClientShow() {
  const v = led.video;
  playedTime = 0;
  ui.exit();
  document.body.classList.add('started');
  setIdlePalette(false);
  wakeUi();
  live.muted = false;
  audio.attach(v);
  applyMute();
  v.loop = false;
  await led.useVideoElement('Show');
  led.source = 'Media';
  live.source = 'Media file';
  v.currentTime = 0;
  v.play().catch(() => {});
  director.reset();
  tlIndex = -2;
}

// Long videos are split to fit GitHub's 100 MB file limit (tools/build_site.py); put them back together here.
async function downloadParts(data) {
  const blobs = [];
  let got = 0;
  for (const url of data.parts) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('missing part');
    const reader = res.body.getReader(), chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      const pct = Math.floor((got / data.size) * 100);
      ui.setLabel(`Loading ${pct}%`);
      $('startBtn').style.setProperty('--p', `${pct}%`);
    }
    blobs.push(new Blob(chunks));
  }
  return URL.createObjectURL(new Blob(blobs, { type: data.mime || 'video/mp4' }));
}

function formatShowDate(d) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(d || '');
  if (!m) return d || '';
  return new Date(+m[3], +m[2] - 1, +m[1]).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

async function initShowMode() {
  document.body.classList.add('show-mode');
  gui.show(false);
  controls.enablePan = false;
  controls.maxDistance = 34;
  controls.maxPolarAngle = Math.PI * 0.62;
  const cams = $('cams');
  Object.keys(CLIENT_CAMERAS).forEach((label, i) => {
    const b = document.createElement('button');
    b.dataset.label = label;
    b.innerHTML = rollLabel(label);
    b.className = i === 0 ? 'on' : '';
    b.onclick = () => { clientCam = i; selectClientCamera(label); };
    cams.appendChild(b);
  });
  $('fullscreen').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  };
  led.video.addEventListener('ended', () => {
    // short videos repeat, so the client always gets at least a minute of show
    playedTime += led.video.duration;
    if (playedTime < MIN_SHOW_SECONDS) {
      led.video.currentTime = 0;
      led.video.play().catch(() => {});
      tlIndex = -2;
      return;
    }
    document.body.classList.remove('started', 'idle');
    ui.enter();
    setIdlePalette(true);
    ui.setLabel('Watch again');
  });
  goTo(CLIENT_CAMERAS['Back of room'], true);         // the show starts from the back of the room
  const data = await loadShow();
  ui.setTitle(S.show.title);
  ui.enter();
  $('startMeta').textContent = ['Alte Münze, Berlin', formatShowDate(S.show.date)].filter(Boolean).join(' · ');
  document.title = S.show.title;
  for (const ev of ['pointermove', 'pointerdown', 'keydown']) addEventListener(ev, wakeUi, { passive: true });
  if (!data || !data.video) { ui.setLabel('Show not available'); $('startBtn').disabled = true; return; }
  S.led.pattern = 'Black';
  setIdlePalette(true);
  $('startBtn').onclick = startClientShow;
  try {
    led.video.preload = 'auto';
    led.video.src = data.parts ? await downloadParts(data) : data.video;
    led.video.load();
    ui.setLabel('Start the show');
    $('startBtn').disabled = false;
  } catch {
    ui.setLabel('Could not load the video');
  }
}

async function initAuthorMode() {
  connectWS();                                        // picks up a running bridge automatically
  const data = await loadShow();
  if (data?.video) {
    led.video.src = data.video;
    led.video.muted = true;
    try { await led.useVideoElement('Show'); led.source = 'Media'; live.source = 'Media file'; refreshGUI(); } catch { /* video file missing */ }
  }
}

frame();
if (SHOW_MODE) initShowMode(); else initAuthorMode();

window.sim = { ui, makePoster, dyn,get playedTime() { return playedTime; }, analyzer, audio, director, get timeline() { return timeline; }, get tier() { return currentTier(); }, addMarker, triggerLook, saveShow, dmxInfo: () => ({ active: !!dmxActive(), ageMs: Math.round(performance.now() - dmxAt), movers: dmxFrame?.movers?.length, mover1: dmxFrame?.movers?.[0] }), gui, renderer, composer, scene, camera, controls, venue, S, live, recallCue, storeCue, setPath, goTo, led, atmos, gobos, fixtures: { front, mid, bars } };

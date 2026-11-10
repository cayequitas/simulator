// Makes the rig react to whatever is playing on the LED wall, without TouchDesigner.
// VideoAnalyzer reads a tiny copy of the picture (colours per column, brightness, motion, hits).
// AudioReact listens to the video's soundtrack (kick onsets, tempo).
// LOOKS are the rig states the auto director switches between as the energy of the video changes.

const W = 64, H = 16;
const hsv = (r, g, b) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 1e-5) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, max > 0 ? d / max : 0, max];
};
const hueRGB = h => {
  const f = n => {
    const k = (n + h * 6) % 6;
    return 1 - Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
};
const toLinear = v => v * v * (0.3 * v + 0.7);        // cheap sRGB → linear

export class VideoAnalyzer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = new Float32Array(W * H);
    this.col = new Float32Array(W * 3);                 // linear RGB per column
    this.valid = false;
    this.luma = 0; this.lumaSlow = 0; this.lumaPeak = 0.2;
    this.motion = 0; this.motionPeak = 0.02;
    this.energy = 0; this.energyFast = 0;
    this.hit = 0;                                       // 0..1, jumps on flashes and cuts, decays fast
    this.colorA = [1, 1, 1]; this.colorB = [0.4, 0.5, 1];
    this.mono = true;
    this.acc = 0;
    this.hist = new Float32Array(24);
  }

  update(src, dt, ready) {
    this.hit *= Math.exp(-dt * 7);
    if (!src || !ready) { this.valid = false; return; }
    this.acc += dt;
    if (this.acc < 1 / 30) return;
    const step = this.acc;
    this.acc = 0;
    let data;
    try {
      this.ctx.drawImage(src, 0, 0, W, H);
      data = this.ctx.getImageData(0, 0, W, H).data;
    } catch { this.valid = false; return; }             // cross-origin or not decoded yet
    this.valid = true;
    this.col.fill(0);
    this.hist.fill(0);
    let sum = 0, diff = 0, chroma = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const k = y * W + x;
      diff += Math.abs(l - this.prev[k]);
      this.prev[k] = l;
      sum += l;
      this.col[x * 3] += toLinear(r) / H;
      this.col[x * 3 + 1] += toLinear(g) / H;
      this.col[x * 3 + 2] += toLinear(b) / H;
      const [h, s, v] = hsv(r, g, b);
      const w = s * s * v;
      this.hist[Math.floor(h * 24) % 24] += w;
      chroma += w;
    }
    const n = W * H;
    const luma = sum / n, motion = diff / n;
    // adaptive range, so dark or very bright films both use the whole reaction range
    this.lumaPeak = Math.max(luma, this.lumaPeak * Math.exp(-step * 0.05), 0.08);
    this.motionPeak = Math.max(motion, this.motionPeak * Math.exp(-step * 0.05), 0.012);
    const prevLuma = this.luma;
    this.luma = luma;
    this.motion = motion;
    this.lumaSlow += (luma - this.lumaSlow) * (1 - Math.exp(-step * 1.2));
    // a flash or a hard cut
    const jump = Math.max(0, luma - prevLuma) / this.lumaPeak;
    const cut = motion / this.motionPeak;
    if (jump > 0.22) this.kick(Math.min(1, jump * 2.2));
    else if (cut > 0.92 && motion > 0.05) this.kick(0.7);
    // energy: how bright and how busy the picture is right now
    const e = Math.min(1, 0.45 * (luma / this.lumaPeak) + 0.55 * Math.pow(cut, 0.7));
    this.energyFast += (e - this.energyFast) * (1 - Math.exp(-step * 5));
    this.energy += (e - this.energy) * (1 - Math.exp(-step * 0.55));
    this.pickColors(chroma / n, step);
  }

  kick(v) { this.hit = Math.max(this.hit, v); }

  pickColors(chroma, step) {
    this.mono = chroma < 0.012;
    const k = 1 - Math.exp(-step * 2.5);
    let a = 0;
    for (let i = 1; i < 24; i++) if (this.hist[i] > this.hist[a]) a = i;
    let b = -1, best = 0;
    for (let i = 0; i < 24; i++) {
      const d = Math.min(Math.abs(i - a), 24 - Math.abs(i - a));
      if (d >= 3 && this.hist[i] > best) { best = this.hist[i]; b = i; }
    }
    const A = this.mono ? [1, 1, 1] : hueRGB((a + 0.5) / 24);
    // no clear second colour in the film: use the opposite hue's neighbour for contrast
    const B = this.mono ? [0.55, 0.65, 1] : hueRGB((b >= 0 && best > this.hist[a] * 0.12 ? b + 0.5 : a + 8.5) / 24);
    for (let i = 0; i < 3; i++) {
      this.colorA[i] += (A[i] - this.colorA[i]) * k;
      this.colorB[i] += (B[i] - this.colorB[i]) * k;
    }
  }

  // Linear colour of the picture at u (0 = left of the wall, 1 = right), boosted so washes stay colourful.
  sample(u, out) {
    const x = Math.max(0, Math.min(W - 1, Math.floor(u * W)));
    let r = 0, g = 0, b = 0, c = 0;
    for (let k = Math.max(0, x - 2); k <= Math.min(W - 1, x + 2); k++) {
      r += this.col[k * 3]; g += this.col[k * 3 + 1]; b += this.col[k * 3 + 2]; c++;
    }
    r /= c; g /= c; b /= c;
    const level = Math.max(r, g, b);
    if (level > 1e-4) {
      const grey = (r + g + b) / 3, sat = 1.7;
      out[0] = Math.max(0, grey + (r - grey) * sat) / level;
      out[1] = Math.max(0, grey + (g - grey) * sat) / level;
      out[2] = Math.max(0, grey + (b - grey) * sat) / level;
    } else { out[0] = out[1] = out[2] = 0; }
    return Math.pow(level, 0.55);                       // perceived brightness at that spot, 0..1
  }
}

export class AudioReact {
  constructor() {
    this.ctx = null; this.analyser = null; this.gain = null;
    this.level = 0; this.slow = 0; this.onset = false;
    this.lastOnset = 0; this.intervals = [];
    this.bpm = 0;
    this.buf = null;
  }

  // Must run from a click or key press, browsers keep audio locked until then.
  attach(video) {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      const srcNode = this.ctx.createMediaElementSource(video);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.3;
      this.gain = this.ctx.createGain();
      srcNode.connect(this.analyser);
      srcNode.connect(this.gain);
      this.gain.connect(this.ctx.destination);
      this.buf = new Uint8Array(this.analyser.frequencyBinCount);
    } catch { this.ctx = null; this.analyser = null; }
  }

  setVolume(v) { if (this.gain) this.gain.gain.value = v; }

  // Returns true on a kick. `now` in seconds.
  update(dt, now) {
    this.onset = false;
    if (!this.analyser) return false;
    this.analyser.getByteFrequencyData(this.buf);
    const hz = this.ctx.sampleRate / this.analyser.fftSize;
    const top = Math.max(2, Math.round(160 / hz));
    let s = 0;
    for (let i = 1; i <= top; i++) s += this.buf[i];
    const v = s / top / 255;
    this.level = v;
    this.slow += (v - this.slow) * (1 - Math.exp(-dt * 3));
    if (v > 0.22 && v > this.slow * 1.22 && now - this.lastOnset > 0.17) {
      const gap = now - this.lastOnset;
      this.lastOnset = now;
      this.onset = true;
      if (gap < 1.5) {
        this.intervals.push(gap);
        if (this.intervals.length > 24) this.intervals.shift();
        if (this.intervals.length >= 12) {
          const m = [...this.intervals].sort((a, b) => a - b)[this.intervals.length >> 1];
          let bpm = 60 / m;
          while (bpm < 85) bpm *= 2;
          while (bpm > 170) bpm /= 2;
          this.bpm = Math.round(bpm);
        }
      }
    }
    return this.onset;
  }
}

// Rig states: where the heads point, how they move, which gobo. Values are the normal group settings,
// so anything here can also be set by hand. With "Follow the video" on, brightness and strobes come from the
// video itself (main.js followVideo), so the dimmers here are just the ceiling.
export const LOOKS = {
  Dark: {
    front: { fx: 'Fan', spread: 25, tilt: 12, zoom: 2.5, gobo: 'Open', goboRot: 0, speed: 32, dimmer: 1, size: 6, strobe: 0, dimFx: 'None' },
    mid: { fx: 'Static', tilt: 8, zoom: 30, gobo: 'Water', goboRot: 6, speed: 32, dimmer: 1, spread: 0, size: 0, strobe: 0, dimFx: 'None' },
    bars: { dimmer: 1, tilt: 20, tiltFx: 'Static', zoom: 34, strobe: 0, dimFx: 'None', speed: 8 },
    atmos: { haze: 0.5 },
  },
  Calm: {
    front: { fx: 'Sweep', size: 12, spread: 44, tilt: 24, zoom: 6, gobo: 'Breakup', goboRot: 12, speed: 32, dimmer: 1, strobe: 0, dimFx: 'None' },
    mid: { fx: 'Tilt wave', size: 10, spread: 30, tilt: 15, zoom: 14, gobo: 'Water', goboRot: -8, speed: 32, dimmer: 1, strobe: 0, dimFx: 'None' },
    bars: { dimmer: 1, tilt: 30, tiltFx: 'Static', zoom: 30, strobe: 0, dimFx: 'None', speed: 8 },
    atmos: { haze: 0.5 },
  },
  Flow: {
    front: { fx: 'Circle', size: 16, spread: 56, tilt: 30, zoom: 5, gobo: 'Spokes', goboRot: 40, speed: 16, dimmer: 1, strobe: 0, dimFx: 'None' },
    mid: { fx: 'Fan', spread: 70, tilt: 34, zoom: 10, gobo: 'Prism 3', goboRot: -30, speed: 16, size: 12, dimmer: 1, strobe: 0, dimFx: 'None' },
    bars: { dimmer: 1, tilt: 34, tiltFx: 'Wave', spread: 14, zoom: 28, strobe: 0, dimFx: 'None', speed: 8 },
    atmos: { haze: 0.55 },
  },
  Build: {
    front: { fx: 'Tilt wave', size: 16, spread: 66, tilt: 36, zoom: 4, gobo: 'Open', goboRot: 0, speed: 16, dimmer: 1, strobe: 0, dimFx: 'None' },
    mid: { fx: 'Sweep', size: 18, spread: 40, tilt: 30, zoom: 6, gobo: 'Dot ring', goboRot: 30, speed: 16, dimmer: 1, strobe: 0, dimFx: 'None' },
    bars: { dimmer: 1, tilt: 40, tiltFx: 'Wave', spread: 20, zoom: 26, strobe: 0, dimFx: 'None', speed: 4 },
    atmos: { haze: 0.6 },
  },
  Peak: {
    front: { fx: 'Tilt wave', size: 14, spread: 70, tilt: 34, zoom: 3, gobo: 'Open', goboRot: 0, speed: 8, dimmer: 1, strobe: 0, dimFx: 'None' },
    mid: { fx: 'Sweep', size: 14, spread: 50, tilt: 34, zoom: 4, gobo: 'Open', goboRot: 0, speed: 8, dimmer: 1, strobe: 0, dimFx: 'None' },
    bars: { dimmer: 1, tilt: 44, tiltFx: 'Fan', spread: 22, zoom: 24, strobe: 0, dimFx: 'None', speed: 2 },
    atmos: { haze: 0.66 },
  },
};
export const LOOK_NAMES = Object.keys(LOOKS);

// Picks a look from the energy of the video, holding each one long enough to read as a choice.
export class Director {
  constructor() { this.current = null; this.held = 0; this.pending = null; this.pendingFor = 0; }

  target(e) {
    if (e < 0.16) return 'Dark';
    if (e < 0.36) return 'Calm';
    if (e < 0.56) return 'Flow';
    if (e < 0.74) return 'Build';
    return 'Peak';
  }

  // Returns the name of a look to change to, or null.
  update(dt, energy, hit) {
    this.held += dt;
    const t = this.target(energy);
    if (t === this.current) { this.pending = null; return null; }
    if (t !== this.pending) { this.pending = t; this.pendingFor = 0; }
    this.pendingFor += dt;
    // change on a hit when one comes, otherwise after the energy has stayed there for a while
    const ready = this.current === null || (this.held > 3 && (hit > 0.5 || this.pendingFor > 1.2));
    if (!ready) return null;
    this.current = t; this.held = 0; this.pending = null;
    return t;
  }

  reset() { this.current = null; this.held = 0; this.pending = null; }
}

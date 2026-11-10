// Tileable 3D noise volume used to animate haze density inside the beams and the fog puffs.
// Generated once on the CPU (64³ voxels, three octaves of periodic value noise with domain warp).
import * as THREE from 'three';

let cached = null;

export function noiseVolume() {
  if (cached) return cached;
  const N = 64;
  let s = 1234567;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);

  // periodic lattice noise with period P (divides N), smooth interpolation
  function makeOctave(P) {
    const lat = new Float32Array(P * P * P);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    const at = (x, y, z) => lat[((z % P + P) % P) * P * P + ((y % P + P) % P) * P + ((x % P + P) % P)];
    return (x, y, z) => {
      const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
      let xf = x - xi, yf = y - yi, zf = z - zi;
      xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf); zf = zf * zf * (3 - 2 * zf);
      const l = (a, b, t) => a + (b - a) * t;
      return l(
        l(l(at(xi, yi, zi), at(xi + 1, yi, zi), xf), l(at(xi, yi + 1, zi), at(xi + 1, yi + 1, zi), xf), yf),
        l(l(at(xi, yi, zi + 1), at(xi + 1, yi, zi + 1), xf), l(at(xi, yi + 1, zi + 1), at(xi + 1, yi + 1, zi + 1), xf), yf),
        zf);
    };
  }
  const o1 = makeOctave(4), o2 = makeOctave(8), o3 = makeOctave(16), w = makeOctave(4);
  const data = new Uint8Array(N * N * N);
  let i = 0;
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    // coordinates in lattice units of the coarsest octave (period 4 over 64 voxels)
    const u = (x / N) * 4, v = (y / N) * 4, q = (z / N) * 4;
    // domain warp gives curling, smoke-like structures instead of round blobs
    const wx = (w(u + 3.1, v, q) - 0.5) * 1.6, wy = (w(u, v + 7.7, q) - 0.5) * 1.6;
    const a = o1(u + wx, v + wy, q);
    const b = o2((u + wx) * 2, (v + wy) * 2, q * 2);
    const c = o3((u + wx) * 4, (v + wy) * 4, q * 4);
    const n = a * 0.55 + b * 0.3 + c * 0.15;
    data[i++] = Math.max(0, Math.min(255, Math.round(((n - 0.5) * 1.8 + 0.5) * 255)));
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}

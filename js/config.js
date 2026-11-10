// Venue model for the Alte Münze hall with the 30 m LED wall.
// All units are metres. Values marked "est." were estimated from photos —
// replace them with numbers from the venue's CAD / rigging plot when available.
// Coordinate system: LED wall face at z = 0, audience towards +z, floor at y = 0.

export const LED = {
  pxW: 3840,
  pxH: 860,
  width: 30,            // given
  bottom: 1.2,          // est. height of the black fluted riser under the wall
  frame: 0.06,          // est. black border
};
LED.height = LED.width * LED.pxH / LED.pxW;           // 6.72 m
LED.pitchMM = (LED.width * 1000) / LED.pxW;           // ≈ 7.81 mm
LED.aspect = LED.pxW / LED.pxH;                       // ≈ 4.465

export const ROOM = {
  width: 38,            // est. wall-to-wall (x)
  depth: 32,            // est. LED wall to rear wall (z)
  height: 11.2,         // est. underside of ceiling slab
  backWallZ: -0.7,
  beamY: 10.5,          // est. steel beams
  ductY: 9.8,           // est. spiral ducts
};

export const TRUSS = {
  y: 8.7,               // est. bottom chord trim height
  size: 0.3,            // 30 cm box truss
  lines: [
    { axis: 'x', z: 1.8, from: -16, to: 16 },   // front truss, just in front of the LED wall top
    { axis: 'x', z: 9, from: -16, to: 16 },     // mid truss
    { axis: 'x', z: 16, from: -16, to: 16 },    // rear truss
    { axis: 'z', x: -13, from: 1.8, to: 16 },   // perpendicular runs
    { axis: 'z', x: 0, from: 1.8, to: 16 },
    { axis: 'z', x: 13, from: 1.8, to: 16 },
  ],
};

export const RIG = {
  frontMovers: { z: 1.8, xs: [-14, -10, -6, -2, 2, 6, 10, 14] },
  midMovers: { z: 9, xs: [-14, -10, -6, -2, 2, 6, 10, 14] },
  bars: [
    ...[-12, -8, -4, 0, 4, 8, 12].map(x => ({ x, z: 1.8 })),
    ...[-12, -4, 4, 12].map(x => ({ x, z: 9 })),
  ],
  fogMachines: [
    { x: -5, z: 0.9, dir: [0.15, 0, 1] },
    { x: 5, z: 0.9, dir: [-0.15, 0, 1] },
    { x: -17.5, z: 10, dir: [1, 0, 0.2] },
    { x: 17.5, z: 10, dir: [-1, 0, 0.2] },
  ],
};

export const NUM_LIGHTS = RIG.frontMovers.xs.length + RIG.midMovers.xs.length + RIG.bars.length;

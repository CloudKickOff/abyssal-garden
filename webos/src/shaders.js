// ============================================================================
// GLSL ES 3.00 sources (WebGL2), translated from ../../source/src/shaders.js
// ============================================================================
// The bodies stay close to the WGSL originals: the #defines below keep its type and sampling names, so only the
// declarations differ. What had to change for WebGL:
//   - clip space z is -1..1: every position goes through z * 2 - w (emit() / the shadow pass), which keeps the
//     original reverse-Z depth values (near / distance) in a 24-bit depth buffer
//   - framebuffer and texture rows both start at the bottom, so nothing flips: only the three places that turn clip
//     space into texture coordinates (shadow lookups, light shaft rays) lose their y flip
//   - no compute shaders: the terrain density is drawn slice by slice, four slices per RGBA target (G_DENS)
//   - no multisampling

const fl = (x) => (Number.isInteger(x) ? x + '.' : '' + x); // a JS number as a GLSL float literal

const GH = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D; precision highp sampler3D; precision highp sampler2DShadow;
#define vec2f vec2
#define vec3f vec3
#define vec4f vec4
#define vec2i ivec2
#define f32 float
#define i32 int
#define atan2 atan
#define textureSample(t, s, uv) texture(t, uv)
#define textureSampleLevel(t, s, uv, l) textureLod(t, uv, l)
#define textureSampleCompareLevel(t, s, uv, z) textureLod(t, vec3(uv, z), 0.)
`;

// fullscreen triangle
const G_FSV = GH + `
void main() { gl_Position = vec4(float((gl_VertexID & 1) * 4 - 1), float((gl_VertexID >> 1) * 4 - 1), 0., 1.); }
`;

const G_NOISE = `
float ss(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
float h31(vec3 p) { vec3 q = fract(p * vec3f(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec3 h33(vec3 p) { vec3 q = fract(p * vec3f(.1031, .1030, .0973)); q += dot(q, q.yxz + 33.33); return fract((q.xxy + q.yxx) * q.zyx); }
float vn(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); vec3 u = f * f * (3. - 2. * f);
  return mix(mix(mix(h31(i), h31(i + vec3f(1., 0., 0.)), u.x), mix(h31(i + vec3f(0., 1., 0.)), h31(i + vec3f(1., 1., 0.)), u.x), u.y),
             mix(mix(h31(i + vec3f(0., 0., 1.)), h31(i + vec3f(1., 0., 1.)), u.x), mix(h31(i + vec3f(0., 1., 1.)), h31(i + vec3f(1., 1., 1.)), u.x), u.y), u.z);
}
float fbm(vec3 p, int n) {
  float a = .5; float s = 0.; vec3 q = p;
  for (int i = 0; i < n; i++) { s += a * vn(q); q = q * 2.03 + vec3f(17.1, 31.7, 5.3); a *= .5; }
  return s / (1. - 2. * a);
}
float wor(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); float d = 9.;
  for (int x = -1; x <= 1; x++) { for (int y = -1; y <= 1; y++) { for (int z = -1; z <= 1; z++) {
    vec3 o = vec3f(f32(x), f32(y), f32(z)); vec3 r = o + h33(i + o) - f; d = min(d, dot(r, r));
  } } }
  return sqrt(d);
}
`;

// ---------------------------------------------------------------- terrain density
// One draw fills an NX x NY target with four z slices (z0 .. z0 + 3) in r, g, b, a. tP holds the primitives
// (primBuffer(): two texels each) in one row. A function: the primitive lists are defined after this file.
const G_DENS = () => GH + G_NOISE + `
uniform sampler2D tP; uniform float z0;
out vec4 oc;
#define PR(k) texelFetch(tP, ivec2(k, 0), 0)
const int NM = ${MESAS.length}, NA = ${ARCHES.length}, NH = ${HOLES.length}, NC = ${CLEARS.length};
float smax(float a, float b, float k) { float h = max(k - abs(a - b), 0.) / k; return max(a, b) + h * h * k * .25; }
float smin(float a, float b, float k) { return -smax(-a, -b, k); }
float seg2(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a; vec2 ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0., 1.); return length(pa - ba * h); }
float seg3(vec3 p, vec3 a, vec3 b) { vec3 pa = p - a; vec3 ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0., 1.); return length(pa - ba * h); }
float dens(vec3 p) {
  vec3 w = vec3f(fbm(p * .04 + 11., 3), fbm(p * .04 + 47., 3), fbm(p * .04 + 83., 3)) - .5;
  vec3 q = p + w * vec3f(15., 6., 15.);
  float g0 = -45.5 + 7. * (fbm(vec3f(q.xz * .011, 3.), 4) - .5) + 1.6 * (fbm(vec3f(q.xz * .07, 9.), 3) - .5);
  float tn = 3. * (fbm(vec3f(q.xz * .09, 2.), 3) - .5);
  float dm = -1e3; float de = 1e3;
  int k = 0;
  for (int i = 0; i < NM; i++) {
    vec4 a = PR(k); vec4 b = PR(k + 1); k += 2;
    float yr = clamp((p.y - g0) / (b.y - g0), 0., 1.3);
    float e = seg2(q.xz, a.xy, a.zw) - b.x;
    e -= b.z * ss(.3, .92, yr) + 3. * (1. - yr) * (1. - yr) - b.w * ss(.0, .5, yr) * (1. - ss(.5, 1., yr));
    dm = smax(dm, smin(-e, b.y + tn - p.y, 3.), 2.5);
    de = min(de, e);
  }
  float clr = 0.;
  int kc = (NM + NA + NH) * 2;
  for (int i = 0; i < NC; i++) {
    vec4 a = PR(kc + i * 2); vec4 b = PR(kc + i * 2 + 1);
    clr = max(clr, 1. - ss(0., b.y, seg2(q.xz, a.xy, a.zw) - b.x));
  }
  float rad = length(p.xz) + w.x * 14.;
  float n = fbm(vec3f(q.xz * .0125, 1.7), 4);
  float ring = ss(156., 172., rad);
  float plat = max(ss(.5, .565, n) * (1. - clr), ring);
  float th = g0 + plat * mix(26. + 17. * fbm(vec3f(q.xz * .03, 5.), 2), 60., ring);
  float d = smax(g0 + 4.5 * ss(10., 0., de) - p.y, dm, 3.);
  d = smax(d, (th - p.y) * .7, 3.);
  k = NM * 2;
  for (int i = 0; i < NA; i++) {
    vec4 a = PR(k); vec4 b = PR(k + 1); k += 2;
    vec3 r = p + w * 3. - a.xyz;
    float cs = cos(a.w); float sn = sin(a.w);
    r = vec3f(cs * r.x + sn * r.z, r.y / b.z, -sn * r.x + cs * r.z);
    d = smax(d, b.y - length(vec2f(length(r.xy) - b.x, r.z)), 1.5);
  }
  float hg = p.y - g0;
  float rk = mix(.25, 1., ss(.5, 5., hg));
  d += rk * ((.5 - wor(p * .17 + w * 2.)) * 3.4 + (.5 - wor(p * .41 + 7.)) * 1.3 + (fbm(p * .3, 3) - .5) * 2.2);
  d += rk * 2.2 * (abs(fract(p.y * .21 + w.y * 2.2) - .5) - .25);
  for (int i = 0; i < NH; i++) {
    vec4 a = PR(k); vec4 b = PR(k + 1); k += 2;
    d = smin(d, seg3(p + w * 2., a.xyz, b.xyz) - a.w, 2.);
  }
  return min(d, 3. - p.y);
}
void main() {
  vec2 f = floor(gl_FragCoord.xy); vec4 r = vec4(0.);
  for (int c = 0; c < 4; c++) {
    float z = z0 + float(c);
    float d = dens(vec3f(${fl(OX)}, ${fl(OY)}, ${fl(OZ)}) + vec3f(f.x, f.y, z) * ${fl(VS)});
    if (f.x == 0. || z == 0. || f.x == ${NX - 1}. || z == ${NZ - 1}. || f.y == ${NY - 1}.) { d = -1.; }
    r[c] = d;
  }
  oc = r;
}
`;

// rock detail texture (tileable): rg = slope, b = height, a = mottling
const G_DETAIL = GH + G_NOISE + `
out vec4 oc;
float hp(vec2 p, float per) { return h31(vec3f(p - per * floor(p / per), per)); }
float tn(vec2 p, float per) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hp(i, per), hp(i + vec2f(1., 0.), per), u.x), mix(hp(i + vec2f(0., 1.), per), hp(i + vec2f(1., 1.), per), u.x), u.y);
}
float tf(vec2 uv, float per, int n) { float a = .5; float s = 0.; float pr = per; for (int i = 0; i < n; i++) { s += a * tn(uv * pr + f32(i) * 7.3, pr); pr *= 2.; a *= .5; } return s / (1. - 2. * a); }
vec3 tw(vec2 p, float per) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 d = vec2f(9.); float id = 0.;
  for (int x = -1; x <= 1; x++) { for (int y = -1; y <= 1; y++) {
    vec2 o = vec2f(f32(x), f32(y)); vec2 c = i + o; vec2 cw = c - per * floor(c / per);
    vec3 hh = h33(vec3f(cw, per)); vec2 r = o + hh.xy - f; float l = dot(r, r);
    if (l < d.x) { d.y = d.x; d.x = l; id = hh.z; } else if (l < d.y) { d.y = l; }
  } }
  return vec3f(sqrt(d), id);
}
float H(vec2 uv) {
  vec2 wq = uv + .11 * (vec2f(tf(uv, 3., 4), tf(uv + .5, 3., 4)) - .5);
  float f = tf(wq, 3., 8);
  float r1 = 1. - abs(tf(wq + 1.7, 5., 6) * 2. - 1.);
  float cr = min(abs(tf(wq + 4.1, 4., 5) * 2. - 1.) * 7., 1.);
  float cr2 = min(abs(tf(wq.yx + 2.3, 9., 4) * 2. - 1.) * 9., 1.);
  vec3 pt = tw(wq * 29., 29.);
  float pit = (1. - ss(.0, .34, pt.x)) * step(.62, pt.z);
  return f * .50 + r1 * r1 * .24 + cr * cr2 * .26 - pit * .07;
}
void main() {
  vec4 fc = gl_FragCoord;
  vec2 uv = fc.xy / 1024.; float e = 1. / 1024.;
  float h = H(uv);
  float gx = H(uv + vec2f(e, 0.)) - H(uv - vec2f(e, 0.)); float gy = H(uv + vec2f(0., e)) - H(uv - vec2f(0., e));
  vec2 s = clamp(vec2f(gx, gy) * 1024. * .5 * .075, vec2f(-1.), vec2f(1.));
  oc = vec4f(-s * .5 + .5, h, tf(uv + 3.7, 3., 5));
}
`;

// bloom chain
const G_BLIT = GH + `
uniform sampler2D t;
out vec4 oc;
vec2 uvOf(vec4 fc, float k) { return fc.xy * k / vec2f(textureSize(t, 0)); }
vec4 kar(vec3 c) { float w = 1. / (1. + max(c.r, max(c.g, c.b))); return vec4f(c * w, w); }
`;
const G_DOWN0 = G_BLIT + `
void main() {
  vec4 fc = gl_FragCoord;
  vec2 uv = uvOf(fc, 2.); vec2 e = 1. / vec2f(textureSize(t, 0));
  vec4 a = kar(min(textureLod(t, uv + e * vec2f(-1., -1.), 0.).rgb, vec3f(24.)));
  vec4 b = kar(min(textureLod(t, uv + e * vec2f(1., -1.), 0.).rgb, vec3f(24.)));
  vec4 c = kar(min(textureLod(t, uv + e * vec2f(-1., 1.), 0.).rgb, vec3f(24.)));
  vec4 d = kar(min(textureLod(t, uv + e * vec2f(1., 1.), 0.).rgb, vec3f(24.)));
  vec4 m = a + b + c + d;
  oc = vec4f(m.rgb / m.a, 1.);
}
`;
const G_TAP4 = (k, e) => G_BLIT + `
void main() {
  vec4 fc = gl_FragCoord;
  vec2 uv = uvOf(fc, ${k}); vec2 e = ${e} / vec2f(textureSize(t, 0));
  oc = (textureLod(t, uv + e * vec2f(-1., -1.), 0.) + textureLod(t, uv + e * vec2f(1., -1.), 0.)
      + textureLod(t, uv + e * vec2f(-1., 1.), 0.) + textureLod(t, uv + e * vec2f(1., 1.), 0.)) * .25;
}
`;
const G_DOWN = G_TAP4('2.', '1.'), G_UP = G_TAP4('.5', '.75');

// animated water texture: r = caustic, ba = surface slope
const G_WATER = GH + `
uniform vec4 tm;
out vec4 oc;
float caus(vec2 uv, float t) {
  vec2 p = uv * 6.2831853;
  vec2 i = p; float c = 0.;
  for (int n = 1; n <= 5; n++) {
    float tt = t * (1. - 3.5 / f32(n));
    i = p + vec2f(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    float s = sin(i.x + tt); float k = cos(i.y + tt);
    c += abs(s * k) / (1.25 * sqrt(s * s + k * k) + 1e-4);
  }
  c = 1.17 - pow(c / 5., 1.4);
  return pow(abs(c), 8.);
}
const vec3 WK[10] = vec3[10](vec3f(1., 2., 1.), vec3f(-2., 1., .9), vec3f(3., 1., .6), vec3f(1., -4., .5), vec3f(4., 3., .4),
  vec3f(-3., 5., .32), vec3f(6., -2., .28), vec3f(5., 7., .2), vec3f(-8., 3., .18), vec3f(2., 11., .14));
void main() {
  vec4 fc = gl_FragCoord;
  vec2 uv = fc.xy / ${WATER}.; float t = tm.x;
  float c = caus(uv, t * .45 + 23.);
  vec2 wu = uv + .02 * vec2f(sin(6.2831853 * (uv.y * 2. + .1 * t)), cos(6.2831853 * (uv.x * 3. - .07 * t)));
  vec2 s = vec2f(0.);
  for (int i = 0; i < 10; i++) {
    vec3 k = WK[i];
    s += k.xy * k.z * cos(dot(k.xy, wu) * 6.2831853 + t * (.5 + .35 * sqrt(length(k.xy))) * ((i & 1) == 0 ? 1. : -1.) + f32(i) * 1.7);
  }
  oc = vec4f(c, c, s * .06);
}
`;

// ---------------------------------------------------------------- shared scene code
const S_G = `
layout(std140) uniform G { mat4 vp; mat4 sm; vec4 cam; vec4 right; vec4 up; vec4 fwd; vec4 sun; vec4 res; vec4 mis; } g;
const vec3 SIG = vec3f(.058, .0235, .0195);
const vec3 KD = vec3f(.056, .0245, .0170);
const vec3 WCOL = vec3f(.16, .58, .90);
const vec3 KDZ = vec3f(.034, .023, .018);
const vec3 PCOL = vec3f(.58, .66, .98);
const vec3 SUNC = vec3f(1.7, 1.6, 1.45);
const float TAU = 6.2831853;
const bool LOW = ${LV > 1};
const bool LEAN = ${LEAN};
float sat(float x) { return clamp(x, 0., 1.); }
float ss(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2f(.06711056, .00583715)))); }
float hs(float x) { return fract(sin(x * 127.1) * 43758.5453); }
vec3 kd(float z) { return mix(KD, KDZ, z); }
vec3 sg(float z) { return mix(SIG, vec3f(.034, .026, .022), z); }
vec4 fin(vec3 c) { return vec4f(min(max(c, vec3f(0.)), vec3f(40.)), 1.); }
const vec3 KDF = vec3f(.043, .045, .042);
vec3 fogIn(vec3 ro, vec3 rd, float d, float z, vec3 sun) {
  vec3 k = mix(KD, KDF, z);
  vec3 a = sg(z) - k * rd.y;
  vec3 I = (1. - exp(-a * d)) / a;
  float mu = max(dot(rd, sun), 0.);
  float m2 = mu * mu;
  return mix(WCOL, PCOL, z) * sg(z) * exp(k * ro.y) * I * (1.22 + .3 * m2 * m2);
}
`;

const S_B = S_G + `
uniform sampler2DShadow tSh;
uniform sampler2D tW;
uniform sampler2D tD;
uniform sampler3D tV;
uniform sampler2D tM;
vec3 shUV(vec3 p) { vec4 s = g.sm * vec4f(p, 1.); return vec3f(s.x * .5 + .5, s.y * .5 + .5, s.z - .0007); }
float shadow1(vec3 p) { vec3 s = shUV(p); return textureSampleCompareLevel(tSh, sS, s.xy, s.z); }
float shadow4(vec3 p) {
  vec3 s = shUV(p); float e = 1.8 / ${SHADOW}.;
  return (textureSampleCompareLevel(tSh, sS, s.xy + vec2f(-e, -e), s.z) + textureSampleCompareLevel(tSh, sS, s.xy + vec2f(e, -e), s.z)
        + textureSampleCompareLevel(tSh, sS, s.xy + vec2f(-e, e), s.z) + textureSampleCompareLevel(tSh, sS, s.xy + vec2f(e, e), s.z)) * .25;
}
float shadow9(vec3 p) {
  if (LOW) { return shadow1(p); }
  vec3 s = shUV(p); float e = 2.1 / ${SHADOW}.; float a = 0.;
  for (int x = -1; x <= 1; x++) { for (int y = -1; y <= 1; y++) { a += textureSampleCompareLevel(tSh, sS, s.xy + vec2f(f32(x), f32(y)) * e, s.z); } }
  return a / 9.;
}
vec2 cuv(vec3 p) { return p.xz - g.sun.xz * (p.y / g.sun.y); }
vec3 caus(vec3 p, float d) {
  vec2 q = cuv(p);
  vec2 o = vec2f(.004, .0025);
  vec3 a = vec3f(textureSample(tW, sR, q / 3.3 + o).r, textureSample(tW, sR, q / 3.3).r, textureSample(tW, sR, q / 3.3 - o).r);
  float b = textureSample(tW, sR, q.yx / 6.9 + .37).r;
  vec3 c = min(pow(a, vec3f(2.3)) * 5. * (.45 + b * 1.3), vec3f(4.));
  return mix(c, vec3f(.33), ss(35., 100., d));
}
float caus2(vec3 p, float d) {
  vec2 q = cuv(p);
  float c = min(pow(textureSample(tW, sR, q / 4.1).r, 1.4) * 2.6 * (.45 + textureSample(tW, sR, q.yx / 6.9 + .37).r * 1.3), 2.6);
  return mix(c, .33, ss(35., 100., d));
}
vec3 sunE(float y, float z) { return SUNC * exp(kd(z) * (min(y, 0.) / g.sun.y)) * (.5 + .5 * sat(-y / 30.)); }
vec4 vol(vec3 p) { return textureSampleLevel(tV, sC, (p - vec3f(-192., -56., -192.)) / vec3f(384., 60., 384.), 0.); }
vec3 amb(vec3 p, vec3 n, float sky, float z) {
  float up = n.y * .5 + .5;
  return mix(vec3f(.22, .60, .80), vec3f(.34, .56, .82), z) * exp(kd(z) * min(p.y, 0.) * 1.2) * (.3 + .7 * sky) * (.24 + .76 * up * up) * 1.3 * (.55 + .45 * sat(-p.y / 30.)) + vec3f(.003, .010, .016);
}
float zone(vec3 p) { return mix(g.sun.w, textureSampleLevel(tM, sC, p.xz / 384. + .5, 0.).b, .2); }
vec3 side(vec3 p, vec3 n, float open, float z) { return mix(WCOL, PCOL, z) * exp(kd(z) * min(p.y, 0.)) * open * (1. - abs(n.y)) * .7; }
// skylight at most 150 m along the ray: past that, terrain and the background behind it (vsB) get the same haze
vec3 fog(vec3 c, vec3 wp, float z) {
  vec3 v = wp - g.cam.xyz; float d = length(v); vec3 rd = v / d;
  return c * exp(-sg(z) * d) * ss(230., 185., d) + fogIn(g.cam.xyz, rd, d, z, g.sun.xyz) * (.58 + .42 * vol(g.cam.xyz + rd * min(d, 150.)).g);
}
vec3 qrot(vec4 q, vec3 v) { return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
`;

// Varyings of a vertex / fragment shader pair, declared once as [type, name, flat]: the vertex shader fills a
// `VO o` and calls emit(o), the fragment shader reads `VO i = vin()`.
const vary = (fields) => {
  const st = (cp) => `struct VO { ${cp ? 'vec4 cp; ' : ''}${fields.map(([t, n]) => `${t} ${n};`).join(' ')} };`;
  return {
    vs: fields.map(([t, n, f]) => `${f ? 'flat ' : ''}out ${t} v_${n};`).join('\n') + '\n' + st(1)
      + `\nvoid emit(VO o) { gl_Position = vec4(o.cp.xy, o.cp.z * 2. - o.cp.w, o.cp.w); ${fields.map(([, n]) => `v_${n} = o.${n};`).join(' ')} }\n`,
    fs: fields.map(([t, n, f]) => `${f ? 'flat ' : ''}in ${t} v_${n};`).join('\n') + '\n' + st(0)
      + `\nVO vin() { VO i; ${fields.map(([, n]) => `i.${n} = v_${n};`).join(' ')} return i; }\nout vec4 oc;\n`,
  };
};
// depth-only passes (the shadow map) still need a fragment shader
const G_NONE = GH + `out vec4 oc; void main() { oc = vec4(0.); }`;

// ---------------------------------------------------------------- solid meshes (terrain, rocks, set pieces, sponges, coral)
const V_SOLID = vary([['vec3', 'wp'], ['vec3', 'n'], ['vec3', 'op'], ['vec3', 'on'], ['vec4', 'm', 1], ['vec4', 'q', 1], ['float', 'ao']]);
const G_SOLID_V = GH + S_B + V_SOLID.vs + `
layout(location = 0) in vec3 a_p; layout(location = 1) in vec4 a_n; layout(location = 2) in vec4 a_a; layout(location = 3) in vec4 a_b; layout(location = 4) in vec4 a_c;
struct VI { vec3 p; vec4 n; vec4 a; vec4 b; vec4 c; };
void main() {
  VI i = VI(a_p, a_n, a_a, a_b, a_c); VO o;
  float sc = i.a.w;
  if (i.c.x < 1.5 && i.c.z > 1.5 && g.res.x > 0.) { sc *= 1. - ss(i.c.z * .7, i.c.z, distance(i.a.xyz, g.cam.xyz) / g.mis.z); }
  // the TV level draws sponges and corals (materials 4, 5) less far: they shrink away instead of popping
  // (by g.mis.w metres, whatever the draw distance scale)
  if (LEAN && i.c.x > 3.5 && g.res.x > 0.) { sc *= 1. - ss(g.mis.w * .72, g.mis.w, distance(i.a.xyz, g.cam.xyz)); }
  vec3 w = i.a.xyz + qrot(i.b, i.p * sc);
  w.y += sin(g.cam.w * .3 + i.c.y * 40.) * i.c.w;
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = qrot(i.b, i.n.xyz); o.op = i.p * i.a.w + i.c.y * 37.; o.on = i.n.xyz;
  o.m = i.c; o.q = i.b; o.ao = i.n.w;
  emit(o);
}
`;
const G_SOLID_F = GH + S_B + V_SOLID.fs + `
struct TP { float h; float c; vec3 n; };
TP tri(vec3 p, vec3 n, float s) {
  vec3 w = pow(abs(n), vec3f(4.)); w /= (w.x + w.y + w.z);
  vec4 x = textureSample(tD, sR, p.zy * s); vec4 y = textureSample(tD, sR, p.xz * s); vec4 z = textureSample(tD, sR, p.xy * s);
  TP o;
  o.h = x.b * w.x + y.b * w.y + z.b * w.z;
  o.c = x.a * w.x + y.a * w.y + z.a * w.z;
  vec2 a = x.rg * 2. - 1.; vec2 b = y.rg * 2. - 1.; vec2 c = z.rg * 2. - 1.;
  o.n = vec3f(0., a.y, a.x) * w.x + vec3f(b.x, 0., b.y) * w.y + vec3f(c.x, c.y, 0.) * w.z;
  return o;
}
void main() {
  VO i = vin();
  int mat = i32(i.m.x + .5); float sd = i.m.y; float fl_ = gl_FrontFacing ? 1. : -1.;
  vec3 on = normalize(i.on) * fl_; vec3 n0 = normalize(i.n) * fl_;
  float dist = length(i.wp - g.cam.xyz);
  float ts = mat >= 2 ? i.m.z : 1.;
  // LEAN (the TV level) takes 13 texture samples here instead of 27: two detail scales instead of four, the wood and
  // streak textures only for the ship and the fluke, one-channel caustics, one occlusion sample
  TP A = tri(i.op, on, .1 * ts); TP B = tri(i.op, on, .43 * ts); TP C = B; TP F = B; float fk = 0.;
  if (!LEAN) { C = tri(i.op, on, 1.9 * ts); F = tri(i.op, on, 6.7 * ts); fk = ss(10., 1.5, dist) * f32(mat <= 1); }
  vec4 Wd = vec4f(.5); vec4 sk = vec4f(.5); vec4 sk2 = vec4f(.5);
  if (!LEAN || mat == 3) { Wd = textureSample(tD, sR, vec2f(i.op.x * .06, (i.op.y + i.op.z) * .7)); }
  float big = textureSample(tD, sR, i.op.xz * .013 + i.op.y * .021).a;
  float big2 = big;
  if (!LEAN) { big2 = textureSample(tD, sR, i.op.zx * .031 + i.op.y * .043 + .37).a; }
  float sgro = 0.;
  if (!LEAN || mat == 2) {
    sk = textureSample(tD, sR, vec2f((i.op.x + i.op.z) * .33, i.op.y * .035));
    sk2 = textureSample(tD, sR, vec2f((i.op.x - i.op.z) * 1.1, i.op.y * .11));
  }
  vec4 gm = textureSample(tM, sC, i.wp.xz / 384. + .5);
  vec3 ca = LEAN ? vec3f(caus2(i.wp, dist)) : caus(i.wp, dist);
  float hgt = A.h * .5 + B.h * .35 + C.h * .15;
  float bump = 1.7; float gloss = .1; vec3 alb = vec3f(0.); vec3 emi = vec3f(0.); float vao = 1.; float flu = 0.;
  float flt = ss(.72, .93, n0.y);
  if (mat <= 1) {
    // layered rock: grey / olive / brown beds, warm encrustation patches, algae on up-facing parts
    float st = i.op.y * .55 + A.h * 1.6 + big * 5. + big2 * 3.;
    float bed = hs(floor(st)); float sf = fract(st);
    alb = mix(vec3f(.11, .12, .13), vec3f(.33, .30, .25), sat(A.c * 1.5 - .25));
    alb = mix(alb, mix(vec3f(.26, .19, .10), vec3f(.20, .22, .14), bed), ss(.42, .66, big) * .7);
    alb *= mix(.72, 1.15, bed) * (1. - .45 * ss(.12, .0, sf) * (1. - abs(on.y)));
    float enc = ss(.46, .6, big2 * .6 + B.c * .5) * ss(.3, .6, hgt);
    alb = mix(alb, mix(vec3f(.34, .07, .10), vec3f(.40, .25, .07), ss(.45, .6, A.c)) * (.5 + .8 * B.h), enc * .75);
    alb = mix(alb, vec3f(.50, .50, .46) * (.5 + .7 * C.h), ss(.60, .70, B.c * .6 + C.c * .5) * .5);
    float alg = ss(-.1, .6, n0.y) * ss(.3, .52, B.c * .55 + big * .5);
    alb = mix(alb, vec3f(.035, .14, .07), alg * .8);
    alb *= (.22 + 1.3 * hgt) * mix(1., .62 + .76 * F.h, fk);
    sgro = -ss(.14, .0, sf) * (1. - abs(on.y)) * 1.2;
    if (mat == 0) {
      alb = mix(alb, vec3f(.13, .15, .14) * (.55 + .6 * B.h), flt * gm.a * .7);
      float mg = flt * sat(gm.r * 1.5 - .45 + (B.c - .5) * 1.6) * ss(.35, .6, A.h) * ss(-34., -40., i.wp.y);
      alb = mix(alb, vec3f(.20, .02, .12) * (.4 + .9 * B.h), mg * .8);
      flu = mg * .35;
      alb = mix(alb, alb * vec3f(.85, .8, 1.4) + vec3f(.015, .0, .05), gm.b * .8);
    }
  } else if (mat == 2) {
    // whale fluke: smooth pale stone with dark streaks running along its length
    alb = mix(vec3f(.42, .47, .48), vec3f(.10, .13, .15), ss(.40, .62, sk.a * .6 + sk2.b * .5)) * (.75 + .3 * B.h);
    alb = mix(alb, vec3f(.60, .64, .62), ss(.62, .75, sk2.a) * .5);
    gloss = .9; bump = .3;
  } else if (mat == 3) {
    alb = mix(vec3f(.13, .085, .05), vec3f(.36, .25, .14), Wd.b) * (.6 + .5 * B.h);
    float pk = fract(atan2(i.op.z, 2. - i.op.y) * 7.);
    alb *= .35 + .65 * ss(0., .12, min(pk, 1. - pk));
    alb = mix(alb, vec3f(.08, .22, .16), ss(.5, .7, A.c) * .6);
    gloss = .2; bump = .7;
  } else if (mat == 4) {
    float hue = fract(sd * 7.31);
    alb = mix(vec3f(.60, .17, .08), vec3f(.64, .35, .10), fract(hue * 3.));
    if (hue > .75) { alb = vec3f(.44, .18, .42); }
    alb *= (.45 + .75 * B.h) * (.7 + .3 * C.h);
    vao = i.ao * i.ao; gloss = .2; bump = 1.4; flu = .55;
  } else {
    float hue = fract(sd * 5.73);
    alb = mix(vec3f(.80, .08, .10), vec3f(.90, .22, .40), fract(hue * 4.));
    if (hue > .7) { alb = vec3f(.88, .42, .10); }
    if (hue > .9) { alb = vec3f(.55, .22, .75); }
    alb *= (.4 + .8 * B.h) * (.5 + .9 * i.ao * i.ao);
    alb = mix(alb, vec3f(1., .75, .6), ss(.8, 1., i.ao) * .35);
    emi = alb * .01; flu = .75; gloss = .25; bump = 1.5;
  }
  float rip = mat == 0 ? flt * gm.a * cos((i.wp.x * .8 + i.wp.z * .35) * 5. + A.c * 9.) * .65 : 0.;
  vec3 N = normalize(qrot(i.q, normalize(on + (A.n * .85 + B.n * .65 + C.n * .45 * ss(60., 12., dist) + F.n * .5 * fk) * bump + vec3f(.8, sgro, .35) * vec3f(rip, 1., rip))));
  vec3 L = g.sun.xyz; vec3 V = normalize(g.cam.xyz - i.wp);
  vec4 v1 = vol(i.wp + n0 * 1.5); vec4 v2 = v1;
  if (!LEAN) { v2 = vol(i.wp + n0 * 4.5); }
  float ao = (sat((v1.r - .5) * 8.) * .55 + sat((v2.r - .5) * 2.7) * .45) * vao * ss(.12, .6, hgt);
  float z = mix(g.sun.w, gm.b, .2); // zone(i.wp), from the sample already taken
  vec3 E = sunE(i.wp.y, z) * shadow9(i.wp + n0 * .35);
  float ndl = sat(dot(N, L));
  vec3 am = (amb(i.wp, N, v1.g, z) + side(i.wp, N, sat((v2.r - .5) * 2.7), z)) * ao;
  vec3 dl = E * ndl * (.10 + mix(vec3f(.33), ca, ss(.1, .45, dot(n0, L))) * 2.5);
  vec3 c = alb * (dl + am) + emi + alb * flu * dot(dl + am, vec3f(.1, .5, .5));
  vec3 H = normalize(V + L);
  c += E * (.25 + ca) * pow(sat(dot(N, H)), mix(10., 70., gloss)) * gloss * ndl * 1.8;
  if (!LEAN) { c += (amb(i.wp, reflect(-V, N), v1.g, z) + side(i.wp, reflect(-V, N), sat((v2.r - .5) * 2.7), z)) * ao * (.08 + gloss) * .6 * pow(1. - sat(dot(N, V)), 2.5); }
  oc = fin(fog(c, i.wp, z));
}
`;

// ---------------------------------------------------------------- leaves (kelp, grasses, ground cover)
const S_LEAF = `
vec2 sway(vec2 p, float h, float t) {
  float ph = dot(p, vec2f(.031, .017));
  float a = .024 * pow(max(h, 0.), 1.25);
  return a * (vec2f(sin(t * .5 + ph + h * .09), cos(t * .37 + ph * 1.3 + h * .07)) + .35 * vec2f(sin(t * 1.3 + ph * 3. + h * .3), cos(t * 1.1 + ph * 2. + h * .23)));
}
float shape2(float v) { return sin(3.14159 * sat(v)); }
vec3 pal(float h) {
  if (h < .3) { return vec3f(1., .62, .08); }
  if (h < .6) { return vec3f(.12, 1., .22); }
  if (h < .8) { return vec3f(.2, .85, 1.); }
  return vec3f(1., .3, .8);
}
`;
const V_LEAF = vary([['vec3', 'wp'], ['vec3', 'n'], ['vec2', 'uv'], ['vec3', 'col', 1], ['vec4', 'pr', 1], ['vec2', 'sd', 1], ['vec3', 'spc', 1]]);
// rows: vertex rows along the blade; far: the distance at which the blades have shrunk away
const G_LEAF_V = (rows, far = 150) => GH + `#define ROWS ${fl(rows)}\n#define FAR ${fl(far)}\n` + S_B + S_LEAF + V_LEAF.vs + `
layout(location = 0) in vec4 a_a; layout(location = 1) in vec4 a_b; layout(location = 2) in vec4 a_c;
struct LI { vec4 a; vec4 b; vec4 c; };
void main() {
  LI i = LI(a_a, a_b, a_c); VO o; int vi = gl_VertexID;
  float u = f32(vi & 1) * 2. - 1.; float v = sin(f32(vi >> 1) / (ROWS - 1.) * 1.5708);
  int ty = i32(i.c.x * 255. + .5); float s1 = i.c.y; float s2 = i.c.z;
  float t = g.cam.w;
  float len = i.a.w; float hA = i.b.w;
  float cy = cos(i.b.x); float sy = sin(i.b.x); float ct = cos(i.b.y); float st = sin(i.b.y);
  vec3 d = vec3f(st * cy, ct, st * sy); vec3 pe = vec3f(ct * cy, -st, ct * sy); vec3 sd = vec3f(-sy, 0., cy);
  // per type: x sparkle prob, y translucency, z iridescence, w emissive
  vec3 col = vec3f(0.); vec4 pr = vec4f(0.); vec3 spc = vec3f(0.); vec2 shp = vec2f(.75, .7); float wav = 1.; float fls = 1.;
  float hsel = hs(s1 * 13.7 + s2 * 71.3);
  if (ty == 0) { col = mix(vec3f(.11, .125, .022), vec3f(.04, .10, .04), s1); col = mix(col, vec3f(.25, .17, .025), step(.72, s2)); pr = vec4f(.24, .9, 0., 0.); spc = pal(hsel * .72); shp = vec2f(.5, .32); wav = 1.9; }
  else if (ty == 1) { col = vec3f(.10, .11, .035); pr = vec4f(0., .2, 0., 0.); shp = vec2f(.05, .1); wav = .3; fls = .3; }
  else if (ty == 2) { col = mix(vec3f(.05, .20, .16), vec3f(.12, .26, .22), s1); col = mix(col, vec3f(.30, .14, .24), step(.85, s2)); pr = vec4f(.05, 1.0, .25, 0.); spc = vec3f(.6, 1., .9); shp = vec2f(.45, .35); wav = 2.2; }
  else if (ty == 3) { col = mix(vec3f(.02, .05, .065), vec3f(.05, .03, .08), s1); col = mix(col, vec3f(.09, .03, .09), step(.8, s2)); pr = vec4f(.2, .85, .55, .02); spc = mix(vec3f(.5, .35, 1.), vec3f(.2, 1., .7), step(.6, hsel)); shp = vec2f(.7, .6); wav = 2.4; }
  else if (ty == 4) { col = mix(vec3f(.30, .15, .02), vec3f(.42, .25, .04), s1); pr = vec4f(.2, 1., .1, 0.); spc = vec3f(1., .85, .5); shp = vec2f(.5, .4); wav = 1.8; }
  else if (ty == 5) { col = mix(vec3f(.85, .05, .40), vec3f(.60, .10, .80), step(.7, s1)); col = mix(col, vec3f(.95, .25, .55), step(.75, s2)); pr = vec4f(.22, .8, 0., .30); spc = vec3f(1., .35, .8); shp = vec2f(.6, .6); fls = 2.; }
  else if (ty == 6) { col = mix(vec3f(.80, .16, .16), vec3f(.92, .36, .42), s1); pr = vec4f(.06, 1., 0., .10); spc = vec3f(1., .5, .5); shp = vec2f(.4, .3); wav = 2.; }
  else { col = mix(vec3f(.05, .40, .36), vec3f(.10, .52, .58), s1); pr = vec4f(.1, .9, .2, .04); spc = vec3f(.3, 1., .9); shp = vec2f(.6, .5); }
  pr.x = step(hs(s1 * 91.7 + s2 * 37.1 + i.b.x), pr.x);
  float k = (i.c.w - .3) * 2.0 + sin(t * (.8 + s1) * fls + s2 * 40. + hA * .25) * .10 * fls;
  float wph = v * (3. + 5. * s2) + s1 * 30. + t * 1.1;
  float wv = sin(wph) * .12 * wav;
  float kq = k * 1.7; float ka = abs(kq) < .06 ? .06 : kq;
  float sK = sin(ka * v); float cK = cos(ka * v);
  vec3 c = i.a.xyz + len * (d * (sK / ka) + pe * ((1. - cK) / ka + wv * v));
  float sl = sK + wv + cos(wph) * .10 * wav * v * (3. + 5. * s2);
  vec3 N = normalize(pe * cK - d * sl); vec3 T0 = normalize(d * cK + pe * sl);
  float tw = (s1 - .5) * 2.4 * v + sin(t * .9 + s2 * 20.) * .25 * v;
  vec3 S = sd * cos(tw) + N * sin(tw); vec3 N2 = N * cos(tw) - sd * sin(tw);
  float shape = pow(max(sin(3.14159 * pow(v, shp.x)), 0.), shp.y);
  bool shp_ = g.res.x == 0.;
  float cd = distance(i.a.xyz, g.cam.xyz); float far = FAR * g.mis.z;
  float nearK = shp_ ? 0. : 1. - ss(26., 40., cd);
  float farK = shp_ ? 1. : (1. - ss(far * .8, far, cd)) * ss(.6, 2.2, distance(c, g.cam.xyz)) * ss(len * 1.1 + .5, len * 2.2 + 1.2, distance(i.a.xyz + d * (len * .5), g.cam.xyz));
  float ruf = sin(v * 10. + s2 * 30. + t * .6) * i.b.z * .36 * u * shape2(v) * nearK;
  vec3 p = c + S * (u * farK * (shp_ ? (ty == 1 ? 0. : max(i.b.z * .5, .09) * shape) : i.b.z * .5 * shape));
  p += N2 * ruf;
  vec2 sw = sway(i.a.xz, hA + (p.y - i.a.y), t);
  p.x += sw.x; p.z += sw.y;
  o.cp = g.vp * vec4f(p, 1.); o.wp = p; o.n = normalize(N2 + S * u * .55 - T0 * cos(v * 10. + s2 * 30. + t * .6) * u * .7 * nearK); o.uv = vec2f(u, v);
  o.col = col; o.pr = pr; o.sd = vec2f(s1, s2); o.spc = spc;
  emit(o);
}
`;
const G_LEAF_F = GH + S_B + V_LEAF.fs + `
void main() {
  VO i = vin();
  float dist = length(i.wp - g.cam.xyz);
  float ca = caus2(i.wp, dist);
  vec3 n = normalize(i.n); if (!gl_FrontFacing) { n = -n; }
  vec3 V = normalize(g.cam.xyz - i.wp); vec3 L = g.sun.xyz;
  float z = zone(i.wp);
  vec4 lt = textureSample(tD, sR, vec2f(i.uv.x * .13 + i.sd.x * 3.7, i.uv.y * .8 + i.sd.y * 5.3));
  vec4 vv = vol(i.wp + vec3f(0., .8, 0.));
  vec3 E = sunE(i.wp.y, z) * shadow1(i.wp + L * .3);
  float ndl = dot(n, L);
  vec3 alb = i.col * (.72 + .28 * ss(0., .25, abs(i.uv.x))) * mix(.5, 1.12, i.uv.y) * (1. - .45 * ss(30., 8., dist) * ss(.6, 1., sin(i.uv.y * 40. - abs(i.uv.x) * 7. + i.sd.x * 40.))) * (.58 + .42 * ss(0., .13, abs(i.uv.x))) * (.5 + 1.0 * lt.b) * (.65 + .7 * lt.a);
  float ndv = sat(dot(n, V));
  vec3 ir = .5 + .5 * cos(TAU * (vec3f(0., .33, .67) + ndv * 1.1 + i.sd.x * .22 + i.uv.y * .5 + .55));
  alb = mix(alb, alb * .5 + ir * vec3f(.15, .13, .30), i.pr.z * (1. - ndv) * .8);
  float tr = (max(-ndl, 0.) * .85 + .15) * i.pr.y;
  vec3 trc = alb * mix(vec3f(1.), vec3f(1.5, 1.4, .75), sat(i.pr.y) * (1. - i.pr.z));
  float aov = sat((vv.r - .5) * 6.) * mix(.4, 1., i.uv.y);
  vec3 am = (amb(i.wp, n, vv.g, z) + amb(i.wp, -n, vv.g, z) * i.pr.y * .55 * vec3f(1.1, 1.15, .7) + side(i.wp, n, sat((vv.r - .5) * 4.), z) * .6) * (.3 + .7 * aov);
  vec3 c = E * (.06 + ca * 1.5) * (alb * max(ndl, 0.) + trc * tr) + alb * am;
  vec3 H = normalize(V + L);
  c += E * (pow(sat(dot(n, H)), 40.) * (.45 + ir * i.pr.z * 2.) + pow(sat(dot(n, H)), 9.) * .07) + am * ir * i.pr.z * pow(1. - ndv, 3.) * 1.5;
  c += E * trc * i.pr.y * pow(sat(dot(-V, L)), 3.) * 1.2;
  c += alb * i.pr.w * (.5 + 3. * dot(am + E * .3, vec3f(.1, .5, .5)));
  // sparkle: whole-leaf glints that twinkle slowly
  float tw = pow(.5 + .5 * sin(g.cam.w * (.5 + i.sd.y * 1.4) + i.sd.x * 90.), 5.);
  float m = ss(.2, .0, abs(i.uv.y - (.35 + .45 * i.sd.y))) * (1. - i.uv.x * i.uv.x);
  float lit = .35 + E.g * 1.2;
  c += i.spc * i.pr.x * (.1 + tw) * m * lit * .6;
  oc = fin(fog(c, i.wp, z));
}
`;
// glints: additive specks among the leaves
const V_GL = vary([['vec2', 'uv'], ['vec3', 'col', 1]]);
const G_GL_V = GH + S_B + S_LEAF + V_GL.vs + `
layout(location = 0) in vec4 a; layout(location = 1) in vec4 b;
void main() {
  VO o; int vi = gl_VertexID; vec2 q = vec2f(f32(vi & 1), f32(vi >> 1)) * 2. - 1.; float t = g.cam.w;
  o.uv = q; o.col = vec3f(0.);
  vec3 p = a.xyz; vec2 sw = sway(a.xz, a.w, t); p.x += sw.x; p.z += sw.y;
  p += .1 * vec3f(sin(t * .7 + b.x * 50.), sin(t * .9 + b.x * 70.), cos(t * .8 + b.x * 90.));
  float d = length(p - g.cam.xyz);
  if (d > 120. || dot(p - g.cam.xyz, g.fwd.xyz) < -1.) { o.cp = vec4f(0., 0., 2., 1.); emit(o); return; }
  float tw = pow(.5 + .5 * sin(t * (.35 + .9 * hs(b.x)) + b.x * 100.), 4.);
  float sz = min(max(b.z, d * .0026), d * .0045);
  vec3 w = p + (g.right.xyz * q.x + g.up.xyz * q.y) * sz;
  o.cp = g.vp * vec4f(w, 1.);
  float z = zone(p);
  float lit = .3 + 1.8 * shadow1(p) * sunE(p.y, z).g;
  float e = b.z / sz;
  o.col = pal(b.y) * (.12 + tw * 1.7) * lit * e * e * exp(-SIG.g * d) * ss(.4, 1.5, d) * 17.;
  emit(o);
}
`;
const G_GL_F = GH + S_G + V_GL.fs + `
void main() {
  VO i = vin();
  float r = dot(i.uv, i.uv);
  oc = vec4f(min(i.col * exp(-r * 7.) * (1. - ss(.7, 1., r)), vec3f(10.)), 0.);
}
`;

// ---------------------------------------------------------------- fish + mantas
const V_ANIM = vary([['vec3', 'wp'], ['vec3', 'n'], ['vec3', 'op'], ['float', 'sd', 1], ['float', 'lt']]);
const S_ANIM_V = GH + S_B + V_ANIM.vs + `
layout(location = 0) in vec3 a_p; layout(location = 1) in vec4 a_n; layout(location = 2) in vec4 a_a; layout(location = 3) in vec4 a_b;
struct VI { vec3 p; vec4 n; vec4 a; vec4 b; };
`;
const G_FISH_V = S_ANIM_V + `
void main() {
  VI i = VI(a_p, a_n, a_a, a_b); VO o;
  float s = i.b.x; vec3 h = vec3f(hs(s), hs(s + .37), hs(s + .71));
  float R = i.a.w; float t = g.cam.w;
  float ta = t * i.b.y + i.b.w * 6.3 + (h.x - .5) * (26. / R);
  float ph = i.b.w * 17.;
  vec3 P = i.a.xyz + vec3f(R * cos(ta), 2.2 * sin(3. * ta + ph), R * .6 * sin(ta));
  vec3 T = normalize(vec3f(-R * sin(ta), 6.6 * cos(3. * ta + ph), R * .6 * cos(ta))) * sign(i.b.y);
  vec3 S = normalize(cross(vec3f(0., 1., 0.), T)); vec3 Up = cross(T, S);
  vec3 off = S * ((h.y - .5) * 5. + sin(t * .6 + s * 40.) * .5) + Up * ((h.z - .5) * 3.2 + cos(t * .5 + s * 31.) * .4);
  vec3 l = i.p * i.b.z * (.75 + .5 * h.z);
  l.z += sin(t * 9. + s * 50. + l.x * 5.) * .22 * (.25 * i.b.z - l.x);
  vec3 w = P + off + T * l.x + Up * l.y + S * l.z;
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = T * i.n.x + Up * i.n.y + S * i.n.z; o.op = i.p; o.sd = s;
  o.lt = shadow1(w);
  emit(o);
}
`;
const G_FISH_F = GH + S_B + V_ANIM.fs + `
void main() {
  VO i = vin();
  vec3 n = normalize(i.n); vec3 L = g.sun.xyz; vec3 V = normalize(g.cam.xyz - i.wp);
  float z = zone(i.wp); vec4 vv = vol(i.wp);
  vec3 alb = mix(vec3f(.50, .68, .80), vec3f(.10, .22, .40), ss(-.05, .2, i.op.y));
  alb = mix(alb, vec3f(.95, .8, .3), step(.86, fract(i.sd * 7.7)) * .6);
  vec3 E = sunE(i.wp.y, z) * i.lt;
  vec3 c = alb * (E * (.25 + .75 * sat(dot(n, L))) + amb(i.wp, n, vv.g, z) * 1.3);
  c += E * pow(sat(dot(n, normalize(V + L))), 24.) * 1.6 + vec3f(.3, .6, .7) * pow(1. - sat(dot(n, V)), 3.) * .25 * vv.g;
  oc = fin(fog(c, i.wp, z));
}
`;
const G_MANTA_V = S_ANIM_V + `
void main() {
  VI i = VI(a_p, a_n, a_a, a_b); VO o;
  float t = g.cam.w; float R = i.a.w; float sz = i.b.z;
  float ta = t * i.b.y + i.b.x;
  vec3 P = i.a.xyz + vec3f(R * cos(ta), 2.5 * sin(2. * ta + i.b.w), R * .75 * sin(ta));
  vec3 T = normalize(vec3f(-R * sin(ta), 5. * cos(2. * ta + i.b.w) * 1., R * .75 * cos(ta))) * sign(i.b.y);
  vec3 S = normalize(cross(vec3f(0., 1., 0.), T)); vec3 Up = cross(T, S);
  float bank = -.28 * sign(i.b.y);
  vec3 S2 = S * cos(bank) + Up * sin(bank); Up = Up * cos(bank) - S * sin(bank); S = S2;
  float u = i.n.w; float au = abs(u);
  float fp = t * 1.25 + i.b.w * 5. - au * 1.2;
  float amp = .36 * pow(au, 1.6);
  vec3 l = i.p;
  l.y += amp * sin(fp) - .1 * sin(t * 1.25 + i.b.w * 5.);
  float tail = ss(-.5, -1.9, l.z) * step(au, .001);
  l.x += tail * sin(t * .8 + l.z * 2.) * .12;
  float sl = (.576 * pow(au, .6) * sin(fp) - .43 * pow(au, 1.6) * cos(fp)) * sign(u);
  vec3 ln = normalize(vec3f(i.n.x - sl * i.n.y, i.n.y + sl * i.n.x, i.n.z));
  vec3 w = P + (S * l.x + Up * l.y + T * l.z) * sz;
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = S * ln.x + Up * ln.y + T * ln.z; o.op = i.p; o.sd = i.b.w;
  o.lt = 1.;
  emit(o);
}
`;
const G_MANTA_F = GH + S_B + V_ANIM.fs + `
void main() {
  VO i = vin();
  float dist = length(i.wp - g.cam.xyz);
  vec3 ca = caus(i.wp, dist);
  vec4 tx = textureSample(tD, sR, i.op.xz * .9 + i.sd);
  vec3 n = normalize(i.n + (vec3f(tx.r, 0., tx.g) - vec3f(.5, 0., .5)) * .5); vec3 L = g.sun.xyz; vec3 V = normalize(g.cam.xyz - i.wp);
  float z = zone(i.wp); vec4 vv = vol(i.wp);
  float top = ss(-.2, .25, normalize(i.n).y);
  float au = abs(i.op.x);
  float gill = ss(.25, .0, abs(au - .13) * 8.) * ss(.04, .12, i.op.z) * ss(.34, .26, i.op.z) * ss(.2, .8, sin(i.op.z * 110.));
  vec3 belly = vec3f(.13, .17, .21) * (.6 + .6 * tx.b) * (1. - .7 * gill);
  belly = mix(belly, vec3f(.05, .08, .11), sat(ss(.45, .9, au + tx.a * .35) + ss(-.1, -.4, i.op.z + tx.b * .2) * .7));
  vec3 back = vec3f(.04, .065, .10) + vec3f(.10, .16, .2) * ss(.5, .75, tx.a);
  back = mix(back, vec3f(.36, .46, .52), ss(.25, .0, abs(au - .26) * 3.5 + abs(i.op.z - .12) * 5.) * .8);
  vec3 alb = mix(belly, back, top);
  vec3 E = sunE(i.wp.y, z) * shadow4(i.wp + n * .3);
  float ndv = sat(dot(n, V));
  vec3 ir = .5 + .5 * cos(TAU * (vec3f(0., .33, .67) + ndv * 1.1 + tx.a * 1.5 + .55));
  vec3 fillN = vec3f(n.x, abs(n.y) * .55 + .25, n.z);
  vec3 c = alb * (E * sat(dot(n, L)) * (.3 + ca) + amb(i.wp, fillN, vv.g, z) * 1.1 + side(i.wp, n, 1., z) * .8);
  c += ir * vec3f(.35, .16, .6) * (.07 + .22 * tx.b) * (.4 + E.g * .2 * ca.g) * (1. - top * .3);
  c += E * pow(sat(dot(n, normalize(V + L))), 30.) * .5 * (.3 + ca);
  vec3 sky = amb(i.wp, vec3f(0., 1., 0.), vv.g, z);
  c += alb * sky * ca * .45 * (1. - top) + sky * pow(1. - ndv, 3.) * .35;
  oc = fin(fog(c, i.wp, z));
}
`;

// ---------------------------------------------------------------- water surface seen from below
const V_SURF = vary([['vec3', 'wp']]);
const G_SURF_V = GH + S_B + V_SURF.vs + `
void main() {
  VO o; int i = gl_VertexID;
  vec2 p = vec2f(f32(i & 1), f32(i >> 1)) * 2. - 1.;
  o.wp = vec3f(g.cam.x + p.x * 900., 0., g.cam.z + p.y * 900.);
  o.cp = g.vp * vec4f(o.wp, 1.);
  emit(o);
}
`;
const G_SURF_F = GH + S_B + V_SURF.fs + `
void main() {
  VO i = vin();
  vec3 v = i.wp - g.cam.xyz; float d = length(v); vec3 V = v / d;
  float fl = ss(260., 60., d);
  vec2 s = (textureSample(tW, sR, i.wp.xz / 13.).ba + textureSample(tW, sR, i.wp.zx / 4.7 + .2).ba * .7 + textureSample(tW, sR, i.wp.xz / 37. + .6).ba * .8) * fl;
  vec3 n = normalize(vec3f(-s.x * .8, -1., -s.y * .8));
  float ci = sat(dot(V, -n));
  float k = 1. - 1.769 * (1. - ci * ci);
  float win = ss(0., .22, k);
  vec3 rr = refract(V, n, 1.33);
  float sd = max(dot(rr, g.sun.xyz), 0.);
  float fr = pow(1. - sqrt(max(k, 0.)), 5.);
  vec3 sky = (vec3f(.30, .78, 1.) * 1.3 * clamp(1. + 3.8 * (s.x * .6 - s.y * .8), .25, 3.) + vec3f(1., .95, .85) * (pow(sd, 60.) * 1.3 + pow(sd, 500.) * 12.)) * (1. - fr);
  float z = zone(i.wp);
  vec3 R = reflect(V, n);
  vec3 refl = fogIn(i.wp, R, 300., z, g.sun.xyz) * 1.15;
  vec3 c = mix(refl, sky, win);
  oc = fin(fog(c, i.wp, z));
}
`;
// behind everything: where no terrain is drawn (it stops at ~240 m) the water looks as it does at that distance
const G_BACK_V = GH + S_B + V_SURF.vs + `
void main() {
  VO o; int i = gl_VertexID;
  vec2 p = vec2f(f32(i & 1), f32(i >> 1)) * 2. - 1.;
  o.wp = g.cam.xyz + g.fwd.xyz + g.right.xyz * (p.x * g.right.w) + g.up.xyz * (p.y * g.up.w);
  o.cp = vec4f(p, 0., 1.); // depth 0, the cleared value: drawn with a greater-or-equal test (a tiny depth is lost on some chips)
  emit(o);
}
`;
const G_BACK_F = GH + S_B + V_SURF.fs + `
void main() {
  VO i = vin();
  vec3 p = g.cam.xyz + normalize(i.wp - g.cam.xyz) * 240.;
  oc = fin(fog(vec3f(0.), p, zone(p)));
}
`;

// ---------------------------------------------------------------- sprites: bubbles (alpha) and drifting particles (additive)
const V_SPR = vary([['vec2', 'uv'], ['vec4', 'pr', 1], ['vec3', 'wp']]);
const G_BUB_V = GH + S_B + V_SPR.vs + `
layout(location = 0) in vec4 a; layout(location = 1) in vec4 b;
void main() {
  VO o; int vi = gl_VertexID; vec2 q = vec2f(f32(vi & 1), f32(vi >> 1)) * 2. - 1.; float t = g.cam.w;
  float life = fract(t * b.y / b.z + b.x);
  float h = life * b.z;
  vec3 p = a.xyz + vec3f(0., h, 0.);
  float wob = b.w * (.3 + h * .035);
  p.x += sin(t * 1.7 + b.x * 50. + h * .6) * wob + sin(h * .13 + b.x * 9.) * b.w * 2.;
  p.z += cos(t * 1.3 + b.x * 33. + h * .5) * wob + cos(h * .11 + b.x * 7.) * b.w * 2.;
  float sz = a.w * (.55 + .7 * life) * ss(0., .03, life) * ss(0., -1.2, p.y);
  vec3 w = p + (g.right.xyz * q.x + g.up.xyz * q.y) * sz;
  o.cp = g.vp * vec4f(w, 1.); o.uv = q; o.wp = p;
  o.pr = vec4f(b.x, sz, shadow1(p), 0.);
  emit(o);
}
`;
const G_BUB_F = GH + S_B + V_SPR.fs + `
void main() {
  VO i = vin();
  float t = g.cam.w;
  float an = atan2(i.uv.y, i.uv.x + 1e-4);
  float big = ss(.04, .22, i.pr.y);
  float r = length(i.uv) / (.9 + big * .05 * sin(an * 3. + t * 5. + i.pr.x * 40.) + big * .02 * sin(an * 5. - t * 7.));
  float aa = fwidth(r) * 1.5;
  float disc = 1. - ss(1. - aa, 1., r);
  float rim = ss(.55, .98, r);
  float hl = ss(.34, .0, length(i.uv - vec2f(-.36, .42))) + .5 * ss(.2, .0, length(i.uv - vec2f(.4, -.42)));
  float z = zone(i.wp);
  vec3 E = sunE(i.wp.y, z) * (.25 + .75 * i.pr.z);
  vec3 hi = fogIn(i.wp, vec3f(0., 1., 0.), 80., z, g.sun.xyz) * 1.5;
  vec3 lo = fogIn(i.wp, vec3f(0., -1., 0.), 80., z, g.sun.xyz);
  vec3 c = mix(lo, hi, ss(-.5, .8, i.uv.y + rim * .4)) * (.5 + 1.2 * rim) + E * hl * 1.6;
  float al = disc * sat(.03 + rim * rim * rim * .9 + hl);
  vec3 v = i.wp - g.cam.xyz; float d = length(v);
  float T = exp(-SIG.g * d) * ss(1.2, 3., d);
  c = c * T + fogIn(g.cam.xyz, v / d, d, z, g.sun.xyz) * (1. - T);
  al *= mix(.35, 1., T);
  oc = vec4f(min(max(c * al, vec3f(0.)), vec3f(20.)), al);
}
`;
const G_SNOW_V = GH + S_B + V_SPR.vs + `
layout(location = 0) in vec4 a;
void main() {
  VO o; int vi = gl_VertexID; vec2 q = vec2f(f32(vi & 1), f32(vi >> 1)) * 2. - 1.; float t = g.cam.w;
  float B = 44.;
  vec3 p = a.xyz * B + vec3f(t * .22, t * .05, t * .13) + .5 * vec3f(sin(t * .3 + a.x * 60.), sin(t * .23 + a.y * 50.), cos(t * .27 + a.z * 70.));
  p = g.cam.xyz + (fract((p - g.cam.xyz) / B + .5) - .5) * B;
  float d = length(p - g.cam.xyz);
  float sz = (.012 + .045 * a.w * a.w * a.w);
  vec3 w = p + (g.right.xyz * q.x + g.up.xyz * q.y) * max(sz, d * .0011);
  o.cp = g.vp * vec4f(w, 1.); o.uv = q; o.wp = p;
  float fade = ss(B * .5, B * .32, d) * ss(.6, 2.5, d) * min(1., sz / (d * .0011)) * ss(-.3, -1.5, p.y);
  float tw = .6 + .4 * sin(t * (1. + a.w * 2.) + a.x * 100.);
  o.pr = vec4f(fade * tw, shadow1(p), a.w, d);
  emit(o);
}
`;
const G_SNOW_F = GH + S_B + V_SPR.fs + `
void main() {
  VO i = vin();
  float r = length(i.uv);
  float m = ss(1., .2, r);
  float z = zone(i.wp);
  vec3 c = (sunE(i.wp.y, z) * i.pr.y * .8 + amb(i.wp, vec3f(0., 1., 0.), 1., z) * .3) * mix(vec3f(1.), vec3f(.7, 1., .9), i.pr.z);
  oc = vec4f(min(max(c * m * m * i.pr.x * exp(-SIG.g * i.pr.w), vec3f(0.)), vec3f(8.)), 0.);
}
`;

// ---------------------------------------------------------------- volumetric light shafts (half res)
const G_RAYS = GH + S_G + `
uniform sampler2DShadow tSh;
uniform sampler2D tW;
uniform sampler2D tDp;
uniform sampler3D tV;
out vec4 oc;
void main() {
  vec4 fc = gl_FragCoord;
  float dp = texelFetch(tDp, vec2i(fc.xy) * 2, 0).r;
  vec2 uv = fc.xy * 2. * g.res.zw;
  vec2 nd = uv * 2. - 1.;
  vec3 rv = g.fwd.xyz + g.right.xyz * (nd.x * g.right.w) + g.up.xyz * (nd.y * g.up.w);
  float rl = length(rv); vec3 rd = rv / rl;
  // at most 10 km: this goes into a 16-bit float, and where only the background is behind a pixel (depth ~0) a
  // larger value overflows to infinity there, which the blur and the composite turn into black
  float zl = g.fwd.w / max(dp, 1e-5);
  float tm = min(zl * rl, 120.);
  if (rd.y > 1e-4) { tm = min(tm, -g.cam.y / rd.y); }
  vec3 ro = g.cam.xyz; vec3 sx = g.sun.xyz; vec3 k = kd(g.sun.w); vec3 sgz = sg(g.sun.w);
  float dt = tm / ${RAYN}.;
  float j = ign(fc.xy);
  vec3 acc = vec3f(0.);
  for (int n = 0; n < ${RAYN}; n++) {
    float t = (f32(n) + j) * dt;
    vec3 p = ro + rd * t;
    vec4 s = g.sm * vec4f(p, 1.);
    float vis = textureSampleCompareLevel(tSh, sS, vec2f(s.x * .5 + .5, s.y * .5 + .5), s.z - .0006);
    vec2 q = p.xz - sx.xz * (p.y / sx.y);
    float pat = ss(.3, .7, textureSampleLevel(tW, sR, q / 27., 2.5).r) * ss(.15, .6, textureSampleLevel(tW, sR, q.yx / 11. + .3, 2.).r);
    float o = textureSampleLevel(tV, sC, (p - vec3f(-192., -56., -192.)) / vec3f(384., 60., 384.), 0.).r;
    float mist = sat(1. - (o - .5) * 3.4);
    acc += exp(-sgz * t + k * (p.y / sx.y)) * (vis * (.012 + pat * 6.) * (1. + 1.2 * mist * mist));
  }
  float mu = max(dot(rd, sx), 0.);
  float ph = mix(.2 + 2.0 * mu * mu * mu, .8, g.sun.w);
  vec3 wc = mix(WCOL + vec3f(.04, .07, .05), PCOL + vec3f(.28, .16, .12), g.sun.w);
  oc = vec4f(min(acc * dt * sgz * wc * SUNC * ph * g.mis.y * (1. - .55 * g.sun.w), vec3f(20.)), zl);
}
`;
// depth-aware 3x3 blur of the half-res shafts (hides the sampling dither)
const G_RBLUR = GH + `
uniform sampler2D tR;
out vec4 oc;
void main() {
  vec4 fc = gl_FragCoord;
  vec2i p = vec2i(fc.xy); vec2i mx = textureSize(tR, 0) - 1;
  vec4 c = texelFetch(tR, p, 0);
  vec3 acc = vec3f(0.); float ws = 0.;
  for (int y = -1; y <= 1; y++) { for (int x = -1; x <= 1; x++) {
    vec4 r = texelFetch(tR, clamp(p + vec2i(x, y), vec2i(0), mx), 0);
    float w = 1. / (.03 + abs(r.a - c.a) / c.a);
    acc += r.rgb * w; ws += w;
  } }
  oc = vec4f(acc / ws, c.a);
}
`;

// ---------------------------------------------------------------- final composite
const G_POST = GH + S_G + `
uniform sampler2D tS;
uniform sampler2D tR;
uniform sampler2D tB;
uniform sampler2D tDp;
out vec4 oc;
vec3 sat3(vec3 x) { return clamp(x, vec3f(0.), vec3f(1.)); }
vec3 tmap(vec3 x) { return sat3((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14)); }
void main() {
  vec4 fc = gl_FragCoord;
  vec2i px = vec2i(fc.xy);
  vec2 uv = fc.xy * g.res.zw;
  float zf = g.fwd.w / max(texelFetch(tDp, px, 0).r, 1e-5);
  // depth-aware upsample of the half-res shafts
  vec2 h = fc.xy * .5 - .5; vec2 b = floor(h); vec2 f = h - b; vec2i bi = vec2i(b);
  vec2i mx = textureSize(tR, 0) - 1;
  vec3 acc = vec3f(0.); float ws = 0.;
  for (int k = 0; k < 4; k++) {
    vec2i o = vec2i(k & 1, k >> 1);
    vec4 r = texelFetch(tR, clamp(bi + o, vec2i(0), mx), 0);
    float bw = mix(1. - f.x, f.x, f32(o.x)) * mix(1. - f.y, f.y, f32(o.y));
    float w = (bw + .02) / (.02 + abs(r.a - zf) / zf);
    acc += r.rgb * w; ws += w;
  }
  vec3 c = texelFetch(tS, px, 0).rgb + acc / max(ws, 1e-6);
  vec3 bl = textureLod(tB, uv, 0.).rgb;
  c = mix(c, bl, .06) + bl * .03;
  c *= g.mis.x;
  vec2 q = uv - .5;
  c *= 1. - dot(q, q) * .55;
  c = tmap(c);
  float l0 = dot(c, vec3f(.2126, .7152, .0722));
  float l = mix(l0, l0 * l0 * (3. - 2. * l0), .55);
  c *= l / max(l0, 1e-4);
  c = mix(c, vec3f(l), ss(.55, 1., l) * .1);
  c = mix(vec3f(l), c, .93) + vec3f(.008, .002, 0.);
  c = pow(max(c, vec3f(0.)), vec3f(1. / 2.2));
  float n = ign(fc.xy) + ign(fc.xy + 37.) - 1.;
  oc = vec4f(c + n / 255., 1.);
}
`;

// the screen: frame A (tS) faded k of the way to frame B (tR)
const G_FADE = GH + `
uniform sampler2D tS;
uniform sampler2D tR;
uniform float k;
out vec4 oc;
void main() { ivec2 p = ivec2(gl_FragCoord.xy); oc = mix(texelFetch(tS, p, 0), texelFetch(tR, p, 0), k); }
`;

// Animated screensaver: the light rippling over the frozen background. A factor for every pixel of it (drawn with
// multiplying blend): where the sun reaches, the direct light as it would be with the ripples of now (tW) over the
// direct light with the ripples of the moment the background was drawn (tW0). The position comes from the
// background's depth; this cannot tell how much of a pixel was direct light, so it is an approximation.
const G_RIPPLE = GH + S_B + `
uniform sampler2D tDp;
uniform sampler2D tW0;
out vec4 oc;
void main() {
  float dp = texelFetch(tDp, ivec2(gl_FragCoord.xy), 0).r;
  if (dp < 1e-5) { oc = vec4(1.); return; } // the background
  vec2 nd = gl_FragCoord.xy * g.res.zw * 2. - 1.;
  vec3 rv = g.fwd.xyz + g.right.xyz * (nd.x * g.right.w) + g.up.xyz * (nd.y * g.up.w);
  float zl = g.fwd.w / dp; vec3 wp = g.cam.xyz + rv * zl; float d = length(rv) * zl;
  vec2 q = cuv(wp);
  float a = min(pow(texture(tW, q / 4.1).r, 1.4) * 2.6 * (.45 + texture(tW, q.yx / 6.9 + .37).r * 1.3), 2.6);
  float b = min(pow(texture(tW0, q / 4.1).r, 1.4) * 2.6 * (.45 + texture(tW0, q.yx / 6.9 + .37).r * 1.3), 2.6);
  float far = ss(35., 100., d);
  float f = (.10 + mix(a, .33, far) * 2.5) / (.10 + mix(b, .33, far) * 2.5);
  float lit = shadow1(wp + g.sun.xyz * .5);
  oc = vec4(vec3(mix(1., clamp(f, .5, 2.2), lit * .75)), 1.);
}
`;

// The screen, enlarged sz.w times: frame B (tR, sz.xy pixels, bilinear) through a Catmull-Rom filter (the 5 bilinear
// taps that carry nearly all of its weight), then sharpened by sz.z against the average of four taps around the
// point, limited to the range of those taps so that edges get no halo.
const G_BIG = GH + `
uniform sampler2D tR;
uniform vec4 sz;
out vec4 oc;
void main() {
  vec2 px = 1. / sz.xy, sp = gl_FragCoord.xy / sz.w, tc = floor(sp - .5) + .5, f = sp - tc;
  vec2 w0 = f * (-.5 + f * (1. - .5 * f)), w1 = 1. + f * f * (-2.5 + 1.5 * f), w2 = f * (.5 + f * (2. - 1.5 * f)), w3 = f * f * (-.5 + .5 * f);
  vec2 w12 = w1 + w2, t12 = (tc + w2 / w12) * px, t0 = (tc - 1.) * px, t3 = (tc + 2.) * px;
  vec3 c = texture(tR, t12).rgb * (w12.x * w12.y) + texture(tR, vec2(t0.x, t12.y)).rgb * (w0.x * w12.y) + texture(tR, vec2(t3.x, t12.y)).rgb * (w3.x * w12.y)
         + texture(tR, vec2(t12.x, t0.y)).rgb * (w12.x * w0.y) + texture(tR, vec2(t12.x, t3.y)).rgb * (w12.x * w3.y);
  c /= w12.x * w12.y + (w0.x + w3.x) * w12.y + w12.x * (w0.y + w3.y);
  vec2 uv = sp * px;
  vec3 a = texture(tR, uv + px * vec2(-.75, -.75)).rgb, b = texture(tR, uv + px * vec2(.75, -.75)).rgb, d = texture(tR, uv + px * vec2(-.75, .75)).rgb, e = texture(tR, uv + px * vec2(.75, .75)).rgb;
  vec3 lo = min(min(a, b), min(d, e)), hi = max(max(a, b), max(d, e));
  c = clamp(c + (c - (a + b + d + e) * .25) * sz.z, min(lo, c) - .03, max(hi, c) + .03);
  oc = vec4(c, 1.);
}
`;

// Edge smoothing (FXAA, the short form): where the brightness of the four diagonal neighbours says an edge runs
// through this pixel, blend along it. tR must be bilinear.
const G_AA = GH + `
uniform sampler2D tR;
out vec4 oc;
void main() {
  vec2 px = 1. / vec2(textureSize(tR, 0)), uv = gl_FragCoord.xy * px;
  const vec3 L = vec3(.299, .587, .114);
  float nw = dot(texture(tR, uv + vec2(-1., -1.) * px).rgb, L), ne = dot(texture(tR, uv + vec2(1., -1.) * px).rgb, L);
  float sw = dot(texture(tR, uv + vec2(-1., 1.) * px).rgb, L), se = dot(texture(tR, uv + vec2(1., 1.) * px).rgb, L);
  vec3 m = texture(tR, uv).rgb; float lm = dot(m, L);
  float lo = min(lm, min(min(nw, ne), min(sw, se))), hi = max(lm, max(max(nw, ne), max(sw, se)));
  vec2 dir = vec2(-((nw + ne) - (sw + se)), (nw + sw) - (ne + se));
  float red = max((nw + ne + sw + se) * .03125, .0078125);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + red), -8., 8.) * px;
  vec3 a = .5 * (texture(tR, uv + dir * (1. / 3. - .5)).rgb + texture(tR, uv + dir * (2. / 3. - .5)).rgb);
  vec3 b = a * .5 + .25 * (texture(tR, uv + dir * -.5).rgb + texture(tR, uv + dir * .5).rgb);
  float lb = dot(b, L);
  oc = vec4(lb < lo || lb > hi ? a : b, 1.);
}
`;

// ============================================================================
// WebGL2 renderer, camera and input (port of ../../source/src/main.js)
// ============================================================================
// World generation, the camera path and collision are the original code unchanged; the renderer talks to WebGL2
// instead of WebGPU, and the input adds a TV remote (see the input section).
const $ = (id) => document.getElementById(id);
const ceil = Math.ceil;
const canvas = $('c'), info = $('i'), body = document.body;
if (TV) document.documentElement.className = 'tv';
let loaded = 0, dead; // dead: the graphics context was lost
const stages = []; // [loading stage, when it began] for measure()
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
// loading bar: each stage glides it to `to` (the share done) over ~`ms`
const say = async (m, to, ms) => {
  if (!dead) $('s').textContent = m;
  stages.push([m, performance.now()]);
  const b = $('b'); b.style.transition = `transform ${ms}ms cubic-bezier(.3,.5,.5,1)`; b.style.transform = `scaleX(${to})`; loaded = to;
  await tick(60); // long enough for the text and the bar to be painted before this thread is busy again
};
const fail = (m) => { const e = new Error(m); e.cause = 1; throw e; }; // cause marks a message that is shown as it is
const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
if (!gl) fail('This scene needs WebGL2.');
// rendering to float textures: the HDR scene, the water texture and the terrain density all need it
const extF = gl.getExtension('EXT_color_buffer_float'), extH = gl.getExtension('EXT_color_buffer_half_float');
if (!extF && !extH) fail('This graphics driver cannot render to floating-point textures.');
const extA = gl.getExtension('EXT_texture_filter_anisotropic');
const GPUNAME = (() => { const d = gl.getExtension('WEBGL_debug_renderer_info'); return '' + gl.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : gl.RENDERER); })();
// out of memory or a driver reset: reload a level lower, or on the lowest say what happened
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  if (LV < 3) { keep('abyssalGL', LV + 1); location.reload(); }
  dead = body.className = 'l e'; $('s').textContent = 'The graphics context was lost. Restart the app to try again.';
});
const T2 = gl.TEXTURE_2D, FB = gl.FRAMEBUFFER, HDR = gl.RGBA16F, DEPTH = gl.DEPTH_COMPONENT24;

// ---------------------------------------------------------------- GL helpers
const shaders = new Map();
const shader = (type, src) => {
  let s = shaders.get(src); if (s) return s;
  s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) fail('Shader: ' + ('' + gl.getShaderInfoLog(s)).slice(0, 600));
  shaders.set(src, s); return s;
};
// every sampler name has a fixed texture unit; the G uniform block is always binding point 0
const TEXU = { tSh: 0, tW: 1, tD: 2, tV: 3, tM: 4, tDp: 5, tS: 6, tR: 7, tB: 8, t: 6, tP: 6, tW0: 8 };
const prog = (vs, fs) => {
  const p = gl.createProgram(); gl.attachShader(p, shader(gl.VERTEX_SHADER, vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) fail('Shader link: ' + ('' + gl.getProgramInfoLog(p)).slice(0, 600));
  gl.useProgram(p);
  for (const n in TEXU) { const l = gl.getUniformLocation(p, n); if (l) gl.uniform1i(l, TEXU[n]); }
  const b = gl.getUniformBlockIndex(p, 'G'); if (b !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, b, 0);
  return p;
};
const tex = (w, h, format, o = {}) => {
  const t = gl.createTexture(); gl.bindTexture(T2, t); gl.texStorage2D(T2, o.mips || 1, format, w, h);
  gl.texParameteri(T2, gl.TEXTURE_MIN_FILTER, o.min || gl.LINEAR); gl.texParameteri(T2, gl.TEXTURE_MAG_FILTER, o.mag || gl.LINEAR);
  gl.texParameteri(T2, gl.TEXTURE_WRAP_S, o.wrap || gl.CLAMP_TO_EDGE); gl.texParameteri(T2, gl.TEXTURE_WRAP_T, o.wrap || gl.CLAMP_TO_EDGE);
  if (o.aniso && extA && LV < 2) gl.texParameterf(T2, extA.TEXTURE_MAX_ANISOTROPY_EXT, min(8, gl.getParameter(extA.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  if (o.cmp) { gl.texParameteri(T2, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); gl.texParameteri(T2, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL); }
  return t;
};
const fbo = (color, depth, level) => {
  const f = gl.createFramebuffer(); gl.bindFramebuffer(FB, f);
  if (color) gl.framebufferTexture2D(FB, gl.COLOR_ATTACHMENT0, T2, color, level || 0); else { gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE); }
  if (depth) gl.framebufferTexture2D(FB, gl.DEPTH_ATTACHMENT, T2, depth, 0);
  if (gl.checkFramebufferStatus(FB) !== gl.FRAMEBUFFER_COMPLETE) fail('This graphics driver cannot render to one of the textures the scene needs.');
  return f;
};
const vbuf = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
const ibuf = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
const unit = (u, t, target) => { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(target || T2, t); };
const tri3 = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

// vertex layouts: stride, per-instance?, then location, components, type, normalized, offset for each attribute
const LAY = (stride, inst, ...a) => ({ stride, inst, a });
const L_SOLIDV = LAY(16, 0, 0, 3, gl.FLOAT, false, 0, 1, 4, gl.BYTE, true, 12);
const L_SOLIDI = LAY(48, 1, 2, 4, gl.FLOAT, false, 0, 3, 4, gl.FLOAT, false, 16, 4, 4, gl.FLOAT, false, 32);
const L_LEAF = LAY(36, 1, 0, 4, gl.FLOAT, false, 0, 1, 4, gl.FLOAT, false, 16, 2, 4, gl.UNSIGNED_BYTE, true, 32);
const L_ANIM = LAY(32, 1, 2, 4, gl.FLOAT, false, 0, 3, 4, gl.FLOAT, false, 16);
const L_BUB = LAY(32, 1, 0, 4, gl.FLOAT, false, 0, 1, 4, gl.FLOAT, false, 16);
const L_SNOW = LAY(16, 1, 0, 4, gl.FLOAT, false, 0);
// Points the layout's attributes at `buffer`, starting at element `first`. WebGL2 has no first-instance or
// base-vertex draw parameters, so a range of instances is drawn by moving the attribute pointers to its start.
function bindV(buffer, L, first) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const a = L.a, base = first * L.stride;
  for (let i = 0; i < a.length; i += 5) {
    gl.enableVertexAttribArray(a[i]); gl.vertexAttribPointer(a[i], a[i + 1], a[i + 2], a[i + 3], L.stride, a[i + 4] + base); gl.vertexAttribDivisor(a[i], L.inst);
  }
}

// ---------------------------------------------------------------- static resources
const tShadow = tex(SHADOW, SHADOW, DEPTH, { cmp: 1 });
const tWater = tex(WATER, WATER, HDR, { mips: 5, min: gl.LINEAR_MIPMAP_LINEAR, wrap: gl.REPEAT, aniso: 1 });
const tDetail = tex(1024, 1024, gl.RGBA8, { mips: 11, min: gl.LINEAR_MIPMAP_LINEAR, wrap: gl.REPEAT, aniso: 1 });
const tMap = tex(512, 512, gl.RGBA8);
const tVol = gl.createTexture();
{
  const T3 = gl.TEXTURE_3D; gl.bindTexture(T3, tVol); gl.texStorage3D(T3, 1, gl.RG8, NX / 2, NY / 2, NZ / 2);
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(T3, p, gl.LINEAR);
  for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(T3, p, gl.CLAMP_TO_EDGE);
}
const fWater = fbo(tWater), fDetail = fbo(tDetail), fShadow = fbo(null, tShadow);
// the water texture as it was when the animated screensaver's background was drawn (see liveTick())
const tWater0 = tex(WATER, WATER, HDR, { mips: 5, min: gl.LINEAR_MIPMAP_LINEAR, wrap: gl.REPEAT }), fWater0 = fbo(tWater0);

const UB = new Float32Array(64), UBS = new Float32Array(64);
const ubo = gl.createBuffer(), uboS = gl.createBuffer();
gl.bindBuffer(gl.UNIFORM_BUFFER, ubo); gl.bufferData(gl.UNIFORM_BUFFER, UB, gl.DYNAMIC_DRAW);

await say('Compiling shaders…', 0.05, 300);
const pSolid = prog(G_SOLID_V, G_SOLID_F), pSolidSh = prog(G_SOLID_V, G_NONE);
const pLeaf = prog(G_LEAF_V(9), G_LEAF_F), pLeaf5 = prog(G_LEAF_V(5), G_LEAF_F), pLeafS = prog(G_LEAF_V(3, 70), G_LEAF_F), pLeafF = prog(G_LEAF_V(3), G_LEAF_F);
const pLeafSh = prog(G_LEAF_V(3), G_NONE);
const pFish = prog(G_FISH_V, G_FISH_F), pManta = prog(G_MANTA_V, G_MANTA_F);
const pCre = prog(G_CRE_V, G_CRE_F), uCre = {}; for (const n of ['par', 'ex', 'exd', 'cA', 'cB']) uCre[n] = gl.getUniformLocation(pCre, n);
const pInk = prog(G_INK_V, G_INK_F);
const pSurf = prog(G_SURF_V, G_SURF_F), pBack = prog(G_BACK_V, G_BACK_F);
const pBub = prog(G_BUB_V, G_BUB_F), pSnow = prog(G_SNOW_V, G_SNOW_F), pGl = prog(G_GL_V, G_GL_F);
const pWater = prog(G_FSV, G_WATER), uWater = gl.getUniformLocation(pWater, 'tm');
const pDown0 = prog(G_FSV, G_DOWN0), pDown = prog(G_FSV, G_DOWN), pUp = prog(G_FSV, G_UP);
const pRays = prog(G_FSV, G_RAYS), pRB = prog(G_FSV, G_RBLUR), pPost = prog(G_FSV, G_POST);
const pFade = prog(G_FSV, G_FADE), uFade = gl.getUniformLocation(pFade, 'k'), pRipple = prog(G_FSV, G_RIPPLE);
const pBig = prog(G_FSV, G_BIG), uBig = gl.getUniformLocation(pBig, 'sz'), pAA = prog(G_FSV, G_AA);

// ---------------------------------------------------------------- sun + shadow matrix
const SUN = (() => { const v = [0.27, 1, -0.24], l = hypot(...v); return v.map((c) => c / l); })();
{
  const L = SUN, lr = [L[1], -L[0], 0], ll = hypot(...lr); lr[0] /= ll; lr[1] /= ll;
  const lu = [L[1] * lr[2] - L[2] * lr[1], L[2] * lr[0] - L[0] * lr[2], L[0] * lr[1] - L[1] * lr[0]];
  const R = 225, d0 = -175, d1 = 125, m = UBS;
  m[0] = lr[0] / R; m[4] = lr[1] / R; m[8] = lr[2] / R; m[12] = 0;
  m[1] = lu[0] / R; m[5] = lu[1] / R; m[9] = lu[2] / R; m[13] = 0;
  m[2] = -L[0] / (d1 - d0); m[6] = -L[1] / (d1 - d0); m[10] = -L[2] / (d1 - d0); m[14] = d1 / (d1 - d0);
  m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
  for (let i = 0; i < 16; i++) { UBS[16 + i] = m[i]; UB[16 + i] = m[i]; }
  for (let i = 0; i < 3; i++) { UB[48 + i] = UBS[48 + i] = SUN[i]; }
  UBS[32] = 0; UBS[33] = -20; UBS[34] = 0; UBS[35] = 0; UBS[58] = 1;
  gl.bindBuffer(gl.UNIFORM_BUFFER, uboS); gl.bufferData(gl.UNIFORM_BUFFER, UBS, gl.STATIC_DRAW);
}

// ---------------------------------------------------------------- world generation
// The slow parts of the generated world (plants, rocks, meshes, collision grid: about 35 MB) are kept in IndexedDB,
// because generating them takes over two minutes on a TV. The terrain mesh is not: it is another 32 MB, a webOS app
// gets 50 MB of storage, and it is rebuilt from the density in under 10 s. BUILD (set by build.mjs) changes with the generator's code, and with it the
// saved world; WORLDV is to be raised by hand when the generation code in this file or the density shader changes.
const WORLDV = 4;
// Each array is its own record so that saving never copies more than one at a time; the 'tree' record, written last,
// holds the structure with { $: key } where an array was and marks the save as complete.
const idb = () => new Promise((ok, no) => { const r = indexedDB.open('abyssal', 1); r.onupgradeneeded = () => r.result.createObjectStore('w'); r.onsuccess = () => ok(r.result); r.onerror = r.onblocked = () => no(r.error); });
const idbDo = (db, mode, f) => new Promise((ok, no) => { const t = db.transaction('w', mode), q = f(t.objectStore('w')); t.oncomplete = () => ok(q && q.result); t.onerror = t.onabort = () => no(t.error); });
const worldKey = BUILD + ':' + WORLDV + ':' + LV;
async function worldLoad() {
  const db = await idb();
  if (!db.objectStoreNames.contains('w')) { db.close(); indexedDB.deleteDatabase('abyssal'); return null; } // a broken leftover
  const tree = await idbDo(db, 'readonly', (s) => s.get('tree'));
  if (!tree || tree.key !== worldKey) { db.close(); return null; }
  const fill = async (o) => { for (const k in o) { const v = o[k]; if (v && typeof v === 'object') { if ('$' in v) o[k] = await idbDo(db, 'readonly', (s) => s.get(v.$)); else await fill(v); } } return o; };
  const w = await fill(tree.world); db.close(); return w;
}
async function worldSave(world) {
  const db = await idb(), leaves = []; let n = 0;
  const strip = (o) => { const r = Array.isArray(o) ? [] : {}; for (const k in o) { const v = o[k]; if (v && (ArrayBuffer.isView(v) || v instanceof ArrayBuffer)) { leaves.push(['a' + n, v]); r[k] = { $: 'a' + n++ }; } else r[k] = v && typeof v === 'object' ? strip(v) : v; } return r; };
  const tree = { key: worldKey, world: strip(world) };
  await idbDo(db, 'readwrite', (s) => s.clear());
  for (const l of leaves) await idbDo(db, 'readwrite', (s) => s.put(l[1], l[0]));
  await idbDo(db, 'readwrite', (s) => s.put(tree, 'tree')); db.close();
}
// Better still, the whole world (terrain included, about 70 MB) comes with the app as world.bin, made on a computer
// by `npm run bake`: the page is opened with ?bake, generates the world as usual and posts it to the bake server.
// The file is: the length of a JSON text (4 bytes, then 4 unused), the JSON (the tree, with { $: [offset, bytes,
// type] } where an array was), padding to a multiple of 8, then the arrays, each at a multiple of 8.
const BAKE = /[?&]bake\b/.test(location.search), pad8 = (n) => (n + 7) & ~7;
async function worldPost(world) {
  const parts = []; let off = 0;
  const strip = (o) => { const r = Array.isArray(o) ? [] : {}; for (const k in o) { const v = o[k]; if (v && (ArrayBuffer.isView(v) || v instanceof ArrayBuffer)) { const b = ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v); r[k] = { $: [off, b.length, v.constructor.name] }; parts.push(b, new Uint8Array(pad8(b.length) - b.length)); off += pad8(b.length); } else r[k] = v && typeof v === 'object' ? strip(v) : v; } return r; };
  const json = new TextEncoder().encode(JSON.stringify({ key: worldKey, world: strip(world) }));
  const r = await fetch('world', { method: 'POST', body: new Blob([Uint32Array.of(json.length, 0), json, new Uint8Array(pad8(json.length) - json.length), ...parts]) });
  if (!r.ok) throw new Error('The bake server did not take the world.');
}
async function worldFile() {
  const buf = await new Promise((ok) => { const x = new XMLHttpRequest(); x.open('GET', 'world.bin'); x.responseType = 'arraybuffer'; x.onload = () => ok(x.status === 200 || x.status === 0 ? x.response : null); x.onerror = () => ok(null); x.send(); });
  if (!buf || buf.byteLength < 16) return null;
  const n = new Uint32Array(buf, 0, 1)[0], tree = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n))), base = 8 + pad8(n);
  if (tree.key !== worldKey) return null; // made by another version of the generator
  // small arrays are copied out, so that the file's memory can go once the big ones are on the graphics card
  const fill = (o) => { for (const k in o) { const v = o[k]; if (v && typeof v === 'object') { if (v.$) { const C = v.$[2] === 'ArrayBuffer' ? Uint8Array : window[v.$[2]], a = new C(buf, base + v.$[0], v.$[1] / C.BYTES_PER_ELEMENT); o[k] = v.$[1] < 6e6 ? a.slice() : a; } else fill(v); } } return o; };
  return fill(tree.world);
}
let saved = null;
if (!BAKE) {
  try { await say('Looking for the world…', 0.04, 300); saved = await worldFile() || await worldLoad(); } catch (e) { console.warn(e); }
}

const whole = !!(saved && saved.T); // the terrain came too (world.bin): nothing is left to generate
await say(whole ? 'Unpacking the world…' : 'Sculpting the seabed…', whole ? 0.8 : saved ? 0.5 : 0.25, 1200);
// marks a load in progress (quality.js); leaving the page before it ends is not a crash
keep('abyssalGLLoad', 1);
addEventListener('pagehide', () => keep('abyssalGLLoad', ''));
let D;
if (!whole) {
  // the density grid, four z slices per draw (shaders.js: G_DENS), read back slice by slice
  const prims = primBuffer(), tP = tex(prims.length / 4, 1, gl.RGBA32F, { min: gl.NEAREST, mag: gl.NEAREST });
  gl.texSubImage2D(T2, 0, 0, 0, prims.length / 4, 1, gl.RGBA, gl.FLOAT, prims);
  const tT = tex(NX, NY, extF ? gl.RGBA32F : HDR, { min: gl.NEAREST, mag: gl.NEAREST }), f = fbo(tT);
  const p = prog(G_FSV, G_DENS()), uz = gl.getUniformLocation(p, 'z0'), SL = NX * NY, px = new Float32Array(SL * 4);
  D = new Float32Array(SL * NZ);
  unit(6, tP); gl.viewport(0, 0, NX, NY);
  for (let z = 0; z < NZ; z += 4) {
    gl.uniform1f(uz, z); tri3();
    gl.readPixels(0, 0, NX, NY, gl.RGBA, gl.FLOAT, px);
    for (let c = 0; c < 4; c++) for (let i = 0, o = SL * (z + c); i < SL; i++) D[o + i] = px[i * 4 + c];
    if ((z & 28) === 28) { await tick(); gl.bindFramebuffer(FB, f); } // let the loading bar move
  }
  if (gl.getError()) fail('This graphics driver could not compute the terrain.');
  gl.deleteFramebuffer(f); gl.deleteTexture(tT); gl.deleteTexture(tP); gl.deleteProgram(p);
  // rock connected to the seabed: each column's unbroken run up from the bottom is, and the rock above a gap
  // (overhangs, specks) is when it touches rock that is. What never connects is a speck of noise floating in
  // the water (surface nets would make it a small box), so it becomes water
  const S = NX * NY, R = new Uint8Array(D.length), O = [1, -1, NX, -NX, S, -S], b = new Uint8Array(NX), L = [];
  for (let i = 0; i < D.length;) { b.fill(1); for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++, i++) if (D[i] <= 0) b[x] = 0; else if (b[x]) R[i] = 1; else L.push(i); }
  for (let k = 1; k; L.reverse()) { k = 0; for (const i of L) if (!R[i] && O.some((o) => R[i + o])) R[i] = k = 1; }
  for (const i of L) if (!R[i]) D[i] = -D[i];
}
// Distance to the rock for collide(), in 1/127 m (> 0 in rock, clamped to ±1 m), kept only in the 4x4x4-voxel
// bricks near the surface within the camera's reach (~2 MB). CI per brick: 0 all water, 1 all rock, n brick n-2 in CG.
const CO = 52, CN = 102;
let CI = saved ? saved.CI : new Uint16Array(CN * CN * NY / 4), CG = saved ? saved.CG : new Int8Array(64 * 65534);
if (!saved) {
  let n = 0;
  for (let bz = 0; bz < CN; bz++) for (let by = 1; by < NY / 4 - 1; by++) for (let bx = 0; bx < CN; bx++) {
    if (hypot(bx - CN / 2 + 0.5, bz - CN / 2 + 0.5) > 52) continue; // more than 156 m out: never reached
    let lo = 127, hi = -127;
    for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const i = CO + bx * 4 + x + NX * (by * 4 + y + NY * (CO + bz * 4 + z)), gz = D[i + NX * NY] - D[i - NX * NY];
      const gx = D[i + 1] - D[i - 1], g = D[i + NX] - D[i - NX], l = sqrt(gx * gx + g * g + gz * gz) / 1.5;
      const q = round(clamp(D[i] / max(l, 0.05), -1, 1) * 127);
      CG[n * 64 + x + 4 * y + 16 * z] = q; if (q < lo) lo = q; if (q > hi) hi = q;
    }
    CI[bx + CN * (by + NY / 4 * bz)] = lo === hi && lo * lo === 16129 ? +(lo > 0) : (n++, n + 1);
  }
  CG = CG.slice(0, n * 64);
}
if (!whole) await say('Carving canyons…', saved ? 0.8 : 0.32, 400);
const T = whole ? saved.T : buildTerrain(D);

// preset viewpoints (position, look-at), keys 1-6; the world generator dresses the scene around them
const POSES = [
  [10, 1.3, 7, -9, -31, -10],
  [50, 1.3, 34, 58, -23, 8],
  [-26, 2.2, -100, 0, -9, -108],
  [-55, 1.5, -18, -60, -30, 8],
  [10, 1.2, -62, 6, -22, -90],
  [3, 1.6, 62, 1, -28, 100],
];
// 60 s camera path (position + look-at, Catmull-Rom): the world generator keeps it clear, dev.js flies along it
const FLY = new Float32Array([
  10, -42.2, 7, -9, -31, -10,
  7.5, -41.8, 5.5, -10, -31, -12,
  9, -40.5, 18, 17, -37, 42,
  22, -39.2, 40, 48, -36, 45,
  38, -39.2, 46, 57, -27, 18,
  50, -40.4, 35, 58, -24, 8,
  55, -39, 20, 60, -18, -10,
  58, -34, -12, 40, -26, -60,
  50, -30, -44, 10, -26, -80,
  30, -30, -70, 4, -28, -90,
  12, -38.5, -62, 6, -27, -90,
  -4, -36.5, -70, 0, -14, -100,
  -16, -37, -84, 0, -22, -108,
  -29, -38, -90, -44, -34, -60,
  -41, -38, -70, -56, -34, -40,
  -53, -38, -50, -60, -34, -20,
  -58, -38, -28, -60, -32, 0,
  -57, -38, -10, -60, -30, 16,
  -60, -38, 10, -50, -36, 40,
  -52, -37, 36, -20, -35, 44,
  -22, -38, 43, 4, -38, 52,
  -6, -39.2, 44.5, 4, -37, 70,
  3, -40.6, 53, 3, -35, 84,
  3, -41.5, 62, 1, -30, 100,
  4, -39, 76, 3, -22, 100,
]);
const FLYN = FLY.length / 6, FLYT = 60, LUTN = 1024, flyLUT = new Float32Array(LUTN + 1);
const flyPts = [];
// per-frame float state lives in one preallocated array, so the frame loop allocates no heap numbers
const F = new Float64Array(32), P6 = new Float64Array(6);
const CX = 0, CY = 1, CZ = 2, YAW = 3, PIT = 4, FX = 5, FY = 6, FZ = 7, RX = 8, RZ = 9, UX = 10, UY = 11, UZ = 12, VX = 13, VY = 14, VZ = 15, TIME = 16, FLT = 17, LAST = 18, GPU = 19, HUDT = 20, SPL = 21, MX = 22, MY = 23, MZ = 24;
// aim the camera from P6 = position + look-at point
function aim() {
  const dx = P6[3] - P6[0], dy = P6[4] - P6[1], dz = P6[5] - P6[2];
  F[CX] = P6[0]; F[CY] = P6[1]; F[CZ] = P6[2];
  F[YAW] = atan2(dx, -dz); F[PIT] = atan2(dy, sqrt(dx * dx + dz * dz));
}
const lookAt = (x, y, z, tx, ty, tz) => { P6[0] = x; P6[1] = y; P6[2] = z; P6[3] = tx; P6[4] = ty; P6[5] = tz; aim(); };
// camera spline (Catmull-Rom over position + look-at) at parameter F[SPL]
function flyRaw() {
  const s = F[SPL]; let i = floor(s) | 0; if (i > FLYN - 2) i = FLYN - 2;
  const u = s - i, i0 = (i > 0 ? i - 1 : 0) * 6, i1 = i * 6, i2 = (i + 1) * 6, i3 = (i + 2 < FLYN ? i + 2 : FLYN - 1) * 6;
  for (let o = 0; o < 6; o++) {
    const a = FLY[i0 + o], b = FLY[i1 + o], c = FLY[i2 + o], d = FLY[i3 + o];
    P6[o] = 0.5 * (2 * b + (c - a) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (3 * b - a - 3 * c + d) * u * u * u);
  }
  aim();
}
{ // arc-length table: flyLUT[k] = spline parameter at fraction k/LUTN of the total path length
  const M = 4096, len = new Float32Array(M + 1); let px = 0, py = 0, pz = 0;
  for (let k = 0; k <= M; k++) { F[SPL] = k / M * (FLYN - 1); flyRaw(); if (k) len[k] = len[k - 1] + hypot(F[CX] - px, F[CY] - py, F[CZ] - pz); px = F[CX]; py = F[CY]; pz = F[CZ]; }
  for (let k = 0, j = 0; k <= LUTN; k++) { const d = k / LUTN * len[M]; while (j < M - 1 && len[j + 1] < d) j++; flyLUT[k] = (j + (d - len[j]) / max(len[j + 1] - len[j], 1e-6)) / M * (FLYN - 1); }
}
// camera on the scripted path at time F[FLT]
function flyAt() {
  let s = F[FLT] / FLYT; s = s < 0 ? 0 : s > 1 ? 1 : s; s = s * s * (3 - 2 * s) * 0.25 + s * 0.75;
  s *= LUTN; let k = floor(s) | 0; if (k > LUTN - 1) k = LUTN - 1;
  F[SPL] = flyLUT[k] + (flyLUT[k + 1] - flyLUT[k]) * (s - k); flyRaw();
}
for (let t = 0; t <= FLYT; t += 0.1) { F[FLT] = t; flyAt(); flyPts.push([F[CX], F[CY], F[CZ]]); }
for (const p of POSES) flyPts.push([p[0], -40, p[2]]);

// TV level: the terrain again from every 2nd voxel, a quarter of the triangles, for everything past 40 m. Built like
// buildTerrain() in world.js: normals from the full-size density, quads bucketed into the culling grid.
function farTerrain(D, smp) {
  const nx = NX / 2, ny = NY / 2, nz = NZ / 2, d = new Float32Array(nx * ny * nz);
  for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) d[i] = D[2 * x + NX * (2 * y + NY * 2 * z)];
  const sn = surfaceNets(d, nx, ny, nz), nv = sn.nv, vb = new ArrayBuffer(nv * 16), vf = new Float32Array(vb), v8 = new Int8Array(vb), C2 = CELLS * CELLS;
  for (let k = 0; k < nv; k++) {
    const x = sn.pos[k * 3] * 2, y = sn.pos[k * 3 + 1] * 2, z = sn.pos[k * 3 + 2] * 2, e = 1.6;
    let ax = smp(x - e, y, z) - smp(x + e, y, z), ay = smp(x, y - e, z) - smp(x, y + e, z), az = smp(x, y, z - e) - smp(x, y, z + e);
    const l = hypot(ax, ay, az) || 1; ax /= l; ay /= l; az /= l;
    vf[k * 4] = OX + x * VS; vf[k * 4 + 1] = OY + y * VS; vf[k * 4 + 2] = OZ + z * VS;
    v8[k * 16 + 12] = round(ax * 127); v8[k * 16 + 13] = round(ay * 127); v8[k * 16 + 14] = round(az * 127); v8[k * 16 + 15] = 127;
  }
  const nq = sn.ni / 6, key = new Uint8Array(nq), start = new Uint32Array(C2 + 1), lo = new Float32Array(C2).fill(1e9), hi = new Float32Array(C2).fill(-1e9);
  for (let q = 0; q < nq; q++) {
    const a = sn.idx[q * 6] * 4, c = clamp(floor((vf[a] - OX) / CELLW), 0, CELLS - 1) + CELLS * clamp(floor((vf[a + 2] - OZ) / CELLW), 0, CELLS - 1);
    key[q] = c; start[c + 1]++;
    for (let j = 0; j < 6; j++) { const y = vf[sn.idx[q * 6 + j] * 4 + 1]; if (y < lo[c]) lo[c] = y; if (y > hi[c]) hi[c] = y; }
  }
  for (let c = 0; c < C2; c++) start[c + 1] += start[c];
  const ib = new Uint32Array(sn.ni), at = start.slice();
  for (let q = 0; q < nq; q++) { const o = at[key[q]]++ * 6; for (let j = 0; j < 6; j++) ib[o + j] = sn.idx[q * 6 + j]; }
  return { vb, ib, start, lo, hi };
}
if (LEAN && !whole) T.far = farTerrain(D, T.smp);

if (!saved) await say('Growing kelp…', 0.73, 2500);
const Wd = saved ? saved.Wd : makeWorld(D, T, flyPts, POSES);
POSES.forEach((p, i) => { p[1] = saved ? saved.poseY[i] : p[1] + Wd.gy(p[0], p[2]); });
D = Wd.gy = T.smp = null; // with gy goes the generator's working memory (about 200 MB)

if (!saved) await say('Building set pieces…', 0.94, 1200);
// mesh ids: 0-3 boulders, 4-6 sponges, 7-8 coral, 9 tube sponge, 10 whale fluke, 11 ship, 12 manta, 13 fish,
// 14-20 rock chunks + pebbles, 21-22 coral LOD, 23-25 far LOD of the large rock chunks
// the three sponges: profile, segments around, lumpiness, ribs
const LATHE = [
  [[[0, 0, 0.5], [0.34, 0, 0.6], [0.5, 0.2, 0.85], [0.6, 0.6, 1], [0.55, 0.95, 1], [0.47, 1.08, 1], [0.38, 1.1, 0.9], [0.3, 1.0, 0.45], [0.26, 0.6, 0.15], [0, 0.35, 0.05]], 18, 0.3, 9],
  [[[0, 0, 0.5], [0.2, 0, 0.6], [0.26, 0.5, 0.85], [0.4, 1.25, 1], [0.4, 1.42, 1], [0.33, 1.48, 0.9], [0.26, 1.38, 0.4], [0.18, 0.8, 0.12], [0, 0.5, 0.05]], 16, 0.35, 8],
  [[[0, 0, 0.5], [0.5, 0, 0.7], [0.72, 0.18, 1], [0.74, 0.38, 1], [0.62, 0.5, 0.9], [0.48, 0.42, 0.45], [0.4, 0.2, 0.15], [0, 0.14, 0.06]], 18, 0.25, 10],
];
const meshes = saved ? saved.meshes : [meshChunk(1, 3), meshChunk(7, 3), meshChunk(13, 3), meshChunk(22, 3),
  meshLathe(...LATHE[0]),
  meshLathe(...LATHE[1]),
  meshLathe(...LATHE[2]),
  meshCoral(0), meshCoral(1), meshTubes()].map((m) => m.build());
if (!saved) meshes.push(meshFluke(), meshShip().build(), meshManta().build(), meshFish().build(),
  meshChunk(3).build(), meshChunk(11).build(), meshChunk(29).build(), meshChunk(5, 3).build(), meshChunk(17, 3).build(), meshChunk(41, 3).build(), meshChunk(9, 1).build(), meshCoral(0, 1).build(), meshCoral(1, 1).build(), meshChunk(5, 2, 1).build(), meshChunk(17, 2, 1).build(), meshChunk(41, 2, 1).build());
if (BAKE) {
  await say('Sending the world to the bake server…', 0.96, 1500);
  await worldPost({ CI, CG, T: { vb: T.vb, ib: T.ib, start: T.start, lo: T.lo, hi: T.hi, far: T.far }, Wd, poseY: POSES.map((p) => p[1]), meshes: meshes.map((m) => ({ vb: m.vb, ib: m.ib, nv: m.nv })) });
} else if (!saved) {
  await say('Saving the world for next time…', 0.96, 1500);
  try {
    await worldSave({ CI, CG, Wd, poseY: POSES.map((p) => p[1]),
      meshes: meshes.map((m) => ({ vb: m.vb, ib: m.ib, nv: m.nv })) });
  } catch (e) { console.warn(e); try { indexedDB.deleteDatabase('abyssal'); } catch (e2) {} } // no room: generate again next time
}
// Bigger animals, built like the fish (x forward, y up, z to the side; about one unit long) and drawn by one
// shader: sharks and turtles on wide looping paths like the mantas', and squid that hang in place until the camera
// comes close, then leave a cloud of ink and dart away (frame()). A vertex's 4th value says how much it flaps
// (flippers, tentacles).
const loft = (m, X, Hh, Ww, seg, flat) => { // a body: rings of `seg` vertices at X, half-height Hh and half-width Ww (flat: a flatter underside)
  const rings = X.map((x, i) => { const r = []; for (let k = 0; k < seg; k++) { const a = k / seg * TAU, sy = sin(a); r.push(m.v(x, sy * Hh[i] * (sy < 0 ? flat : 1), cos(a) * Ww[i], 0)); } return r; });
  for (let i = 0; i + 1 < rings.length; i++) for (let k = 0; k < seg; k++) { const k2 = (k + 1) % seg; m.quad(rings[i][k], rings[i + 1][k], rings[i + 1][k2], rings[i][k2]); }
};
const fin = (m, a, b, c, fa, fb, fc) => m.tri(m.v(a[0], a[1], a[2], fa || 0), m.v(b[0], b[1], b[2], fb || 0), m.v(c[0], c[1], c[2], fc || 0));
function meshShark() {
  const m = new Mesh();
  loft(m, [0.5, 0.44, 0.3, 0.1, -0.1, -0.28, -0.42], [0.004, 0.04, 0.072, 0.085, 0.07, 0.04, 0.016], [0.004, 0.035, 0.065, 0.075, 0.06, 0.03, 0.01], 8, 0.8);
  fin(m, [0.1, 0.08, 0], [-0.1, 0.07, 0], [-0.08, 0.21, 0]); // dorsal
  fin(m, [-0.4, 0, 0], [-0.62, 0.21, 0], [-0.5, 0.01, 0]); fin(m, [-0.4, 0, 0], [-0.5, -0.01, 0], [-0.57, -0.12, 0]); // tail
  for (const z of [-1, 1]) fin(m, [0.2, -0.03, z * 0.05], [0.04, -0.05, z * 0.06], [0.02, -0.11, z * 0.25]); // pectorals
  return m.build();
}
function meshTurtle() {
  const m = new Mesh();
  loft(m, [0.3, 0.24, 0.08, -0.12, -0.28, -0.36], [0.01, 0.07, 0.12, 0.11, 0.06, 0.01], [0.02, 0.17, 0.27, 0.26, 0.16, 0.02], 10, 0.4); // shell
  loft(m, [0.5, 0.46, 0.38, 0.3], [0.01, 0.045, 0.05, 0.035], [0.01, 0.04, 0.045, 0.035], 6, 1); // head
  for (const z of [-1, 1]) { // front flippers (they flap), rear ones (a little)
    fin(m, [0.2, 0, z * 0.2], [0.06, 0, z * 0.22], [-0.06, 0, z * 0.68], 0, 0, 1); fin(m, [0.2, 0, z * 0.2], [-0.06, 0, z * 0.68], [0.1, 0, z * 0.7], 0, 1, 1);
    fin(m, [-0.24, 0, z * 0.14], [-0.34, 0, z * 0.1], [-0.5, 0, z * 0.26], 0, 0, 0.4);
  }
  return m.build();
}
function meshSquid() { // it swims mantle first: the pointed end is +x, the arms trail behind
  const m = new Mesh();
  loft(m, [0.5, 0.36, 0.14, -0.06, -0.14], [0.004, 0.05, 0.085, 0.09, 0.07], [0.004, 0.05, 0.085, 0.09, 0.07], 8, 1); // mantle
  loft(m, [-0.12, -0.18, -0.26, -0.3], [0.05, 0.065, 0.06, 0.03], [0.05, 0.065, 0.06, 0.03], 6, 1); // head
  for (const z of [-1, 1]) fin(m, [0.46, 0, z * 0.02], [0.24, 0, z * 0.07], [0.3, 0, z * 0.2]); // fins
  for (let k = 0; k < 8; k++) { // arms: thin blades, more and more loose towards their tips
    const a = k / 8 * TAU, c = cos(a), d = sin(a), w = 0.014;
    for (const [x0, r0, x1, r1, f0, f1] of [[-0.28, 0.03, -0.5, 0.06, 0, 0.5], [-0.5, 0.06, -0.78, 0.075, 0.5, 1]]) {
      const p = (x, r, e) => [x, d * r - c * w * e, c * r + d * w * e];
      fin(m, p(x0, r0, -1), p(x0, r0, 1), p(x1, r1, 0), f0, f0, f1);
    }
  }
  return m.build();
}
const CRE = [meshShark(), meshTurtle(), meshSquid()];
meshes.push(...CRE);
// TV level: far versions of the four boulders (26-29) and of the three sponges (30-32), built on every start
if (LEAN) meshes.push(meshChunk(1, 2, 1).build(), meshChunk(7, 2, 1).build(), meshChunk(13, 2, 1).build(), meshChunk(22, 2, 1).build(),
  ...LATHE.map((l) => meshLathe(l[0], 8, l[2], 0).build()));
let nV = 0, nI = 0;
for (const m of meshes) { m.v0 = nV; m.i0 = nI; nV += m.nv; nI += m.ib.length; }
const allV = new Uint8Array(nV * 16), allI = new Uint32Array(nI);
for (const m of meshes) { allV.set(new Uint8Array(m.vb), m.v0 * 16); allI.set(m.ib, m.i0); }
for (const m of meshes) for (let k = m.i0, e = k + m.ib.length; k < e; k++) allI[k] += m.v0; // no base vertex in WebGL2
const vbMesh = vbuf(allV), ibMesh = ibuf(allI);
const vbTerrain = vbuf(new Uint8Array(T.vb)), ibTerrain = ibuf(T.ib), nTerrain = T.ib.length;
const vbFar = LEAN ? vbuf(new Uint8Array(T.far.vb)) : null, ibFar = LEAN ? ibuf(T.far.ib) : null;
if (LEAN) T.far.vb = T.far.ib = 0;
const nSolid = Wd.solids.data.length / 12;
const solidData = new Float32Array((nSolid + 1) * 12); solidData.set(Wd.solids.data); solidData.set([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0], nSolid * 12);
const ibSolids = vbuf(solidData);
// ---------------------------------------------------------------- TV level: less geometry
// The TV's graphics chip is limited by triangle count before pixel count, and most of the original's triangles do
// not shrink with the draw distance. On the TV level the boulders (drawn everywhere, every frame, in the original)
// are sorted into the culling grid and get a far version, as do the sponges; small rocks, pebbles and sponges keep
// every 2nd instance, corals every 3rd, tube sponges every 4th, fish every 2nd, glints every 8th, drifting particles every
// 2nd; the terrain past 40 m is a coarser mesh (farTerrain);
// four kelp plants in ten are left out (thinPlants); rocks, sponges and corals are drawn to 3/4 and 2/3 of their
// distance (DF), sponges and corals to PROPD metres; the terrain stops at 130 m (past
// that the haze hides nearly all of it); and everything that stands on the terrain is drawn before it, so the
// terrain behind is never shaded.
const DF = LEAN ? 0.75 : 1;
// every k-th element of `a` (elements of `stride` floats)
const thin = (a, stride, k) => { const n = ceil(a.length / stride / k), o = new Float32Array(n * stride); for (let i = 0; i < n; i++) for (let j = 0; j < stride; j++) o[i * stride + j] = a[i * k * stride + j]; return o; };
// every k-th instance of each cell of a cell-sorted set (12 floats each)
const thinCells = (c, k) => {
  const st = new Uint32Array(c.start.length), o = new Float32Array(c.data.length); let n = 0;
  for (let i = 0; i + 1 < c.start.length; i++) { st[i] = n; for (let j = c.start[i]; j < c.start[i + 1]; j += k) o.set(c.data.subarray(j * 12, j * 12 + 12), n++ * 12); }
  st[c.start.length - 1] = n; c.start = st; c.data = o.subarray(0, n * 12); c.n = n;
};
// `n` instances from `first` of the set pieces, sorted into the culling grid like the rock chunks
const cellSort = (first, n) => {
  const C2 = CELLS * CELLS, cell = new Uint16Array(n), start = new Uint32Array(C2 + 1), lo = new Float32Array(C2).fill(1e9), hi = new Float32Array(C2).fill(-1e9), o = new Float32Array(n * 12);
  let mar = 0;
  for (let i = 0; i < n; i++) {
    const k = (first + i) * 12, r = solidData[k + 3] * 1.6, y = solidData[k + 1];
    const c = clamp(floor((solidData[k] - OX) / CELLW), 0, CELLS - 1) + CELLS * clamp(floor((solidData[k + 2] - OZ) / CELLW), 0, CELLS - 1);
    cell[i] = c; start[c + 1]++; if (r > mar) mar = r; if (y - r < lo[c]) lo[c] = y - r; if (y + r > hi[c]) hi[c] = y + r;
  }
  for (let c = 0; c < C2; c++) start[c + 1] += start[c];
  const at = start.slice();
  for (let i = 0; i < n; i++) o.set(solidData.subarray((first + i) * 12, (first + i) * 12 + 12), at[cell[i]]++ * 12);
  return { buf: vbuf(o), start, lo, hi, mar };
};
const boulders = LEAN ? [0, 1, 2, 3].map((i) => cellSort(Wd.solids.ranges[i][0], Wd.solids.ranges[i][1])) : null;
// Drops `part` of the plants of a cell-sorted leaf set (36 bytes a leaf), picked by a hash: whole plants go, rather
// than every plant getting thinner. Every leaf and stem piece of a plant carries its height above the plant's foot,
// so its own height less that is the height of the seabed there, which tells the plants apart (to 5 mm) however far
// a tall one leans. The same plants go from every set.
const thinPlants = (c, part) => {
  const u = c.buf instanceof ArrayBuffer ? new Uint8Array(c.buf) : c.buf, f = new Float32Array(u.buffer, u.byteOffset, c.n * 9);
  const o = new Uint8Array(c.n * 36), st = new Uint32Array(c.start.length); let n = 0;
  for (let i = 0; i + 1 < c.start.length; i++) {
    st[i] = n;
    for (let j = c.start[i]; j < c.start[i + 1]; j++) {
      const h = sin(round((f[j * 9 + 1] - f[j * 9 + 7]) * 200) * 12.9898) * 43758.5453;
      if (h - floor(h) >= part) o.set(u.subarray(j * 36, j * 36 + 36), n++ * 36);
    }
  }
  st[c.start.length - 1] = n; c.start = st; c.buf = o.subarray(0, n * 36); c.n = n;
};
if (LEAN) {
  thinPlants(Wd.big, 0.4); thinPlants(Wd.bigF, 0.4);
  for (const i of [0, 1, 2]) thinCells(Wd.props[i], 2); for (const i of [3, 4]) thinCells(Wd.props[i], 3); thinCells(Wd.props[5], 4);
  for (const i of [0, 1, 2, 6]) thinCells(Wd.chunks[i], 2);
  // rocks carry the distance at which they have shrunk away (for materials 0 and 1, the 11th float)
  for (const c of Wd.chunks) for (let k = 0; k < c.data.length; k += 12) if (c.data[k + 8] < 1.5 && c.data[k + 10] > 1.5) c.data[k + 10] *= DF;
  Wd.fish = thin(Wd.fish, 8, 2); Wd.glints = thin(Wd.glints, 8, 8); Wd.snow = thin(Wd.snow, 4, 2);
}
// is set piece i (the whale fluke, the ship) in front of the camera? They are one big mesh each, drawn whole
const ahead = (i) => { const k = Wd.solids.ranges[i][0] * 12, x = solidData[k] - RC[CX], y = solidData[k + 1] - RC[CY], z = solidData[k + 2] - RC[CZ]; return x * RC[FX] + y * RC[FY] + z * RC[FZ] > -45; };

const ibChunk = Wd.chunks.map((c) => vbuf(c.data)), ibProp = Wd.props.map((c) => vbuf(c.data));
const ibBig = vbuf(new Uint8Array(Wd.big.buf)), ibBigF = vbuf(new Uint8Array(Wd.bigF.buf)), ibSmall = vbuf(new Uint8Array(Wd.small.buf));
// ---------------------------------------------------------------- more life
// The original's fish are 30 cm long and hard to see on a TV across a room: here they are twice the size, and their
// order is shuffled so that drawing only the first part of them (the Life setting) thins every school alike.
// Each of the original's twelve big schools also becomes three smaller shoals: every 2nd and 3rd fish of it moves
// to a path of its own some 30 to 50 m away (another radius, height, direction and species), so that there are
// fewer fish in one place and more places with fish.
{
  const f = Wd.fish, n = f.length / 8, o = new Float32Array(f.length), hh = (v) => { const x = sin(v * 91.7) * 43758.5453; return x - floor(x); };
  let school = -1, k = 0, px = 1e9, pz = 1e9;
  for (let i = 0; i < n; i++) {
    const a = i * 8;
    if (f[a] !== px || f[a + 2] !== pz) { school++; k = 0; px = f[a]; pz = f[a + 2]; }
    const sub = k++ % 3;
    if (sub) {
      const id = school * 3 + sub, an = hh(id) * TAU, di = 30 + hh(id + 0.5) * 20, R = f[a + 3] * (0.7 + 0.5 * hh(id + 0.2));
      let x = f[a] + cos(an) * di, z = f[a + 2] + sin(an) * di; const l = hypot(x, z); if (l > 120) { x *= 120 / l; z *= 120 / l; }
      f[a + 5] *= f[a + 3] / R * (hh(id + 0.7) < 0.5 ? -1 : 1); f[a] = x; f[a + 2] = z; f[a + 3] = R;
      f[a + 1] = clamp(f[a + 1] + (hh(id + 0.3) - 0.5) * 16, -40, -14); f[a + 7] = hh(id + 0.9);
    }
  }
  for (let i = 0; i < n; i++) { const j = i * 7919 % n; o.set(f.subarray(j * 8, j * 8 + 8), i * 8); o[i * 8 + 6] *= 2; }
  Wd.fish = o;
}
// a path: centre, radius, phase seed, speed (rad/s, the sign is the direction), length in metres, phase
const SHARKS = new Float32Array([0, -24, 0, 72, 0.3, 0.021, 6, 0.1, -30, -17, -42, 44, 0.7, -0.03, 4.6, 0.6, 30, -27, 50, 30, 0.1, 0.04, 3.8, 0.35]);
const TURTLES = new Float32Array([10, -37, 4, 12, 0.2, 0.07, 1.5, 0.2, 50, -36, 30, 14, 0.5, -0.06, 1.3, 0.7, -52, -34, -14, 16, 0.8, 0.055, 1.6, 0.45, 6, -35, -66, 13, 0.4, -0.065, 1.4, 0.9, 2, -34, 66, 15, 0.6, 0.06, 1.2, 0.05]);
const ibFish = vbuf(Wd.fish), ibManta = vbuf(Wd.mantas), ibBubbles = vbuf(Wd.bubbles), ibSnowB = vbuf(Wd.snow);
const ibGl = vbuf(Wd.glints), nGl = Wd.glints.length / 8;
const ibShark = vbuf(SHARKS), ibTurtle = vbuf(TURTLES), ibOne = vbuf(new Float32Array([0, 0, 0, 0, 0.5, 1, 2.6, 0])), ibInk = gl.createBuffer();
const nFish = Wd.fish.length / 8, nManta = Wd.mantas.length / 8, nBub = Wd.bubbles.length / 8, nSnow = Wd.snow.length / 4;
const MANTA = meshes[12], FISH = meshes[13];
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
gl.bindTexture(gl.TEXTURE_3D, tVol); gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, NX / 2, NY / 2, NZ / 2, gl.RG, gl.UNSIGNED_BYTE, Wd.volD);
gl.bindTexture(T2, tMap); gl.texSubImage2D(T2, 0, 0, 0, 512, 512, gl.RGBA, gl.UNSIGNED_BYTE, Wd.gm);

const UI = gl.UNSIGNED_INT, TRI = gl.TRIANGLES, STRIP = gl.TRIANGLE_STRIP;
const elems = (b) => gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b);
// `n` instances of a mesh, starting at instance `first` of `ib`
let nDraw = 0, nTri = 0; // draw calls and triangles of the frame, for measure()
const drawMesh = (m, ib, L, first, n) => { nDraw++; nTri += m.ib.length / 3 * n; bindV(ib, L, first); gl.drawElementsInstanced(TRI, m.ib.length, UI, m.i0 * 4, n); };

// ---------------------------------------------------------------- one-time bakes: detail texture, shadow map
{
  gl.bindFramebuffer(FB, fDetail); gl.viewport(0, 0, 1024, 1024); gl.useProgram(prog(G_FSV, G_DETAIL)); tri3();
  gl.bindTexture(T2, tDetail); gl.generateMipmap(T2);
  gl.bindFramebuffer(FB, fShadow); gl.viewport(0, 0, SHADOW, SHADOW);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.5, 2);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, uboS);
  gl.useProgram(pSolidSh); gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT);
  bindV(vbTerrain, L_SOLIDV, 0); bindV(ibSolids, L_SOLIDI, nSolid); elems(ibTerrain); gl.drawElements(TRI, nTerrain, UI, 0);
  gl.disable(gl.CULL_FACE); bindV(vbMesh, L_SOLIDV, 0); elems(ibMesh);
  for (let i = 0; i < 12; i++) { const g = Wd.solids.ranges[i]; if (g[1]) drawMesh(meshes[i], ibSolids, L_SOLIDI, g[0], g[1]); }
  // small rocks, sponges and corals (~35M triangles) only on High
  if (!LV) for (let i = 0; i < NCHUNK; i++) drawMesh(meshes[14 + i], ibChunk[i], L_SOLIDI, 0, Wd.chunks[i].n);
  if (!LV) for (let i = 0; i < 6; i++) if (Wd.props[i].n) drawMesh(meshes[4 + i], ibProp[i], L_SOLIDI, 0, Wd.props[i].n);
  gl.useProgram(pLeafSh); bindV(ibBig, L_LEAF, 0); gl.drawArraysInstanced(STRIP, 0, 6, Wd.big.n);
  gl.disable(gl.POLYGON_OFFSET_FILL); gl.disable(gl.DEPTH_TEST);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);
}
// the GPU has its own copies now: let go of the generator's
for (const o of [Wd.big, Wd.bigF, Wd.small, ...Wd.chunks, ...Wd.props]) o.buf = o.data = 0;
Wd.glints = Wd.volD = Wd.gm = T.vb = T.ib = T.wp = T.wn = 0;
// the scene's textures stay on their units for good
unit(0, tShadow); unit(1, tWater); unit(2, tDetail); unit(3, tVol, gl.TEXTURE_3D); unit(4, tMap);

// ---------------------------------------------------------------- render targets (rebuilt on resize)
// The scene is drawn at `pix` pixels and scaled up to the window. frame() tunes it and the draw distance scale `det`
// for 60 fps; both start where the last visit left them. A TV has one known, slow graphics chip: there both are
// fixed (640x360, 40%), and only the screensavers change them.
const PIXMAX = TV ? 1280 * 720 : 2560 * 1440, PIXMIN = TV ? 13e4 : mob ? 25e4 : 5e5, DETMIN = 0.4, TF = TV ? 1000 / 30 : 1000 / 60;
let W = 0, H = 0, DW = 0, DH = 0, pix = TV ? 640 * 360 : +SV[1] || (LV > 1 ? 41e4 : mob ? 1280 * 720 : PIXMAX), det = TV ? 0.4 : +SV[2] || 1, dynN = 0, dynT = 0, dynBad = 0, dynOk = 0, dynWait = 3;
const NB = 6;
let tRes, tDp, tRay, tRay2, fScene, fRay, fRay2, tBl = [], fBl = [], targets = [], fbos = [];
// finished frames: three textures taking turns as A (the older one shown), B (the newer) and C (being drawn)
let tF = [], fF = [], fA = 0, fB = 1, fC = 2, stepI = 0, tSt = [], fSt = [], saver = 0;
// The TV's interactive picture is small (640x360). Rather than let the TV stretch it over the screen, the canvas is
// 1080 lines tall instead (UP; UPN is the factor that makes) and present() enlarges the frame onto it: first an edge-smoothing pass at the frame's own size
// (FXAA: the small picture's stair-stepped edges are what shows most when it is enlarged), then a bicubic filter
// with SHARP of sharpening.
let UP = TV ? 4 : 1, SHARP = 0.35, SMOOTH = true, UPN = 1, tAA = null, fAA = null; // UP: 1 off, more on // UPN: the factor in use (1 in the screensavers, which draw at full size)
let sceneFbo = null; // where the scene steps draw: fScene, or a background of the animated screensaver
function resize() {
  DW = max(2, round(canvas.clientWidth * devicePixelRatio)); DH = max(2, round(canvas.clientHeight * devicePixelRatio));
  const s = min(1, sqrt(pix / (DW * DH)));
  const w = max(2, round(DW * s) & ~1), h = max(2, round(DH * s) & ~1);
  if (w === W && h === H) return;
  dynN = 0; dynT = -300; // let the new size settle before measuring again
  const oldT = tF[fB], oldF = fF[fB], ow = W, oh = H; // the frame on screen: it is copied into the new frames below
  W = w; H = h; UPN = saver || UP < 2 ? 1 : max(1, 1080 / H); canvas.width = round(W * UPN); canvas.height = round(H * UPN);
  for (const t of targets) if (t !== oldT) gl.deleteTexture(t);
  for (const f of fbos) if (f !== oldF) gl.deleteFramebuffer(f);
  tRes = tex(W, H, HDR); tDp = tex(W, H, DEPTH, { min: gl.NEAREST, mag: gl.NEAREST });
  tRay = tex(W / 2, H / 2, HDR, { min: gl.NEAREST, mag: gl.NEAREST }); tRay2 = tex(W / 2, H / 2, HDR, { min: gl.NEAREST, mag: gl.NEAREST });
  tBl = []; for (let i = 0; i < NB; i++) tBl.push(tex(max(1, W >> (i + 1)), max(1, H >> (i + 1)), HDR));
  fScene = fbo(tRes, tDp); fRay = fbo(tRay); fRay2 = fbo(tRay2); fBl = tBl.map((t) => fbo(t));
  tF = [0, 1, 2].map(() => tex(W, H, gl.RGBA8)); fF = tF.map((t) => fbo(t));
  gl.clearColor(0, 0, 0, 1); for (const f of fF) { gl.bindFramebuffer(FB, f); gl.clear(gl.COLOR_BUFFER_BIT); }
  stepI = 0; sceneFbo = fScene; // a frame in progress is abandoned
  // animated screensaver: two backgrounds (colour + depth), the one on screen and the next one being drawn
  tSt = []; fSt = [];
  if (oldT) { // so that a change of size (a screensaver, sharpening a still view) shows no black frame
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, oldF);
    for (const i of [fA, fB]) { gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fF[i]); gl.blitFramebuffer(0, 0, ow, oh, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.LINEAR); }
    gl.deleteTexture(oldT); gl.deleteFramebuffer(oldF);
  }
  if (saver >= 2) for (let i = 0; i < 2; i++) { const c = tex(W, H, HDR, { min: gl.NEAREST, mag: gl.NEAREST }), d = tex(W, H, DEPTH, { min: gl.NEAREST, mag: gl.NEAREST }); tSt.push(c, d); fSt.push(fbo(c, d)); }
  unit(5, tDp);
  tAA = tex(W, H, gl.RGBA8); fAA = fbo(tAA);
  targets = [tRes, tDp, tRay, tRay2, ...tBl, ...tF, ...tSt, tAA]; fbos = [fScene, fRay, fRay2, ...fBl, ...fF, ...fSt, fAA];
  unit(5, tDp);
  UB[52] = W; UB[53] = H; UB[54] = 1 / W; UB[55] = 1 / H;
  if (oldT) present(1); // resizing the canvas blanked it: show the frame carried over at once
}
resize();
addEventListener('resize', resize);

// ---------------------------------------------------------------- frame
let hud = false, auto = false, cruise = 0, fast = 0, view = 0;
let kf = 0, kb = 0, kl = 0, kr = 0, ku = 0, kd = 0, ks = 0, kyl = 0, kyr = 0, wv = 0, pjx = 0, pjy = 0, pOn = false, pT = 0;
let mdx = 0, mdy = 0, lkx = 0, lky = 0, l2x = 0, l2y = 0, hN = 0, hMax = 0, hMin = 1e9, hPer = 1e9, hLate = 0, hTot = 0, tId = -1, tN = 0, tx0 = 0, ty0 = 0, tx = 0, ty = 0;
const TANH = 0.6, NEAR = 0.1, EXPO = 0.62;
let PROPD = 45; // TV level: sponges and corals are drawn to this many metres, shrinking away over the last quarter (on an
// LG CX 45 m costs nothing measurable over 30; at 60 m one frame in seven misses its slot)
let RAYS = TV ? 0.26 : 0.54; // strength of the light shafts (less on a TV: at its low resolution they read as haze)
// Warmth of the light, 0 (the original, quite blue) through 0.5 (a warmer white balance) to 1 (golden hour): it tints
// the sun's colour and the final grade (G_POST). WARM is where it rests; with `golden` on it drifts up to 1 and back
// every GOLD_S seconds.
let WARM = 0.5, golden = false; const GOLD_S = 300;
const warmth = () => golden ? WARM + (1 - WARM) * (0.5 - 0.5 * cos(F[TIME] * TAU / GOLD_S)) : WARM;
const rowOrd = new Uint8Array(CELLS);
const RC = new Float64Array(32); // the camera the frame in progress is drawn from: a copy of F taken when it began
// Draws the cells of a cell-sorted buffer that are in view and within [minD, maxD) (scaled by `det`, but not for the
// terrain) as merged runs, nearest rows first. indexed: 1 for the terrain's quads, a mesh for instances of it (from
// the instance buffer `ib` with layout `L`), otherwise strips of `verts` vertices per instance.
function drawCells(start, lo, hi, mar, indexed, verts, minD, maxD, ib, L) {
  const cx = RC[CX], cy = RC[CY], cz = RC[CZ], fx = RC[FX], fy = RC[FY], fz = RC[FZ], rx = RC[RX], rz = RC[RZ], ux = RC[UX], uy = RC[UY], uz = RC[UZ];
  const ds = indexed === 1 || verts < 0 ? 1 : det * det; // verts < 0: a mesh whose distances `det` leaves alone
  const tx = TANH * W / H, hw = CELLW * 0.5, ex = hw + mar, min2 = minD * minD * ds, max2 = maxD * maxD * ds;
  for (let k = 0; k < CELLS; k++) {
    const rw = rowOrd[k], row = rw * CELLS, pz = OZ + (rw + 0.5) * CELLW - cz, hz = max(abs(pz) - hw, 0);
    let run = -1;
    for (let x = 0; x <= CELLS; x++) {
      const c = row + x; let v = false;
      if (x < CELLS) {
        const l = lo[c], h = hi[c];
        if (l <= h) {
          const px = OX + (x + 0.5) * CELLW - cx, py = (l + h) * 0.5 - cy, ey = (h - l) * 0.5 + mar, hx = max(abs(px) - hw, 0), h2 = hx * hx + hz * hz;
          if (h2 < max2 && h2 >= min2) {
            const lim = px * fx + py * fy + pz * fz + ex * abs(fx) + ey * abs(fy) + ex * abs(fz);
            if (lim >= 0 && abs(px * rx + pz * rz) - ex * (abs(rx) + abs(rz)) <= lim * tx) v = abs(px * ux + py * uy + pz * uz) - ex * (abs(ux) + abs(uz)) - ey * abs(uy) <= lim * TANH;
          }
        }
      }
      if (v) { if (run < 0) run = c; } else if (run >= 0) {
        const a = start[run], n = start[c] - a;
        if (n > 0) { if (indexed === 1) { nDraw++; nTri += n * 2; gl.drawElements(TRI, n * 6, UI, a * 24); } else if (indexed) drawMesh(indexed, ib, L, a, n); else { nDraw++; nTri += (verts - 2) * n; bindV(ib, L, a); gl.drawArraysInstanced(STRIP, 0, verts, n); } }
        run = -1;
      }
    }
  }
}
const terrain = () => {
  gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
  bindV(vbTerrain, L_SOLIDV, 0); bindV(ibSolids, L_SOLIDI, nSolid); elems(ibTerrain);
  if (!SK.terrain) drawCells(T.start, T.lo, T.hi, 1.5, 1, 0, 0, LEAN ? 40 : 240);
  if (LEAN && !SK.terrain) { bindV(vbFar, L_SOLIDV, 0); elems(ibFar); drawCells(T.far.start, T.far.lo, T.far.hi, 1.5, 1, 0, 40, 130); }
};
// parts of the frame that measure() leaves out in turn
const SK = { water: 0, terrain: 0, 'set pieces': 0, rocks: 0, plants: 0, fish: 0, leaves: 0, sprites: 0, shafts: 0, bloom: 0 };
// A frame is drawn in STEPS ([rough cost in ms on the TV, what to do]): the camera and water texture, the scene
// part by part (0 to 3 what stands still, then what moves), then the post passes into frame texture C. Every step
// sets the state it needs, because the screensavers draw other things between them. render() runs them all and
// shows the result at once.
const flat = () => { gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); };
// the camera at F into the frame's uniforms and RC
// the warmth of the light into a frame's uniforms
function tint(m) { const w = warmth(); m[60] = 1 + 0.38 * w; m[61] = 1; m[62] = 1 - 0.42 * w; m[63] = w; }
function camera() {
  // camera basis (right vector is horizontal)
  // camera basis (right vector is horizontal)
  const cx = F[CX], cy = F[CY], cz = F[CZ], pitch = F[PIT], yaw = F[YAW];
  const cp = cos(pitch), fy = sin(pitch), rx = cos(yaw), rz = sin(yaw), fx = cp * rz, fz = -cp * rx;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  F[FX] = fx; F[FY] = fy; F[FZ] = fz; F[RX] = rx; F[RZ] = rz; F[UX] = ux; F[UY] = uy; F[UZ] = uz;
  const asp = W / H, sx = 1 / (TANH * asp), sy = 1 / TANH, m = UB;
  m[0] = rx * sx; m[4] = 0; m[8] = rz * sx; m[12] = -(rx * cx + rz * cz) * sx;
  m[1] = ux * sy; m[5] = uy * sy; m[9] = uz * sy; m[13] = -(ux * cx + uy * cy + uz * cz) * sy;
  m[2] = 0; m[6] = 0; m[10] = 0; m[14] = NEAR;
  m[3] = fx; m[7] = fy; m[11] = fz; m[15] = -(fx * cx + fy * cy + fz * cz);
  m[32] = cx; m[33] = cy; m[34] = cz; m[35] = F[TIME];
  m[36] = rx; m[37] = 0; m[38] = rz; m[39] = TANH * asp;
  m[40] = ux; m[41] = uy; m[42] = uz; m[43] = TANH;
  m[44] = fx; m[45] = fy; m[46] = fz; m[47] = NEAR;
  const zx = cx - PURPLE[0], zz = cz - PURPLE[1]; let zt = (44 - sqrt(zx * zx + zz * zz)) / 18; zt = zt < 0 ? 0 : zt > 1 ? 1 : zt;
  m[51] = zt * zt * (3 - 2 * zt);
  let ek = (-cy - 8) / 26; ek = ek < 0 ? 0 : ek > 1 ? 1 : ek;
  m[56] = EXPO * (0.6 + 0.4 * ek); m[57] = RAYS; m[58] = det; m[59] = PROPD;
  tint(m);
  gl.bindBuffer(gl.UNIFORM_BUFFER, ubo); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, UB);
  { let cr = floor((cz - OZ) / CELLW) | 0; cr = cr < 0 ? 0 : cr > CELLS - 1 ? CELLS - 1 : cr; let n = 0; rowOrd[n++] = cr; for (let d = 1; d < CELLS; d++) { if (cr - d >= 0) rowOrd[n++] = cr - d; if (cr + d < CELLS) rowOrd[n++] = cr + d; } }
  RC.set(F);
}
// animated water texture + mips
function waterTex() {
  if (SK.water) return;
  flat(); gl.bindFramebuffer(FB, fWater); gl.viewport(0, 0, WATER, WATER); gl.useProgram(pWater); gl.uniform4f(uWater, F[TIME], 0, 0, 0); tri3();
  unit(1, tWater); gl.generateMipmap(T2);
}
const scene = () => { gl.bindFramebuffer(FB, sceneFbo); gl.viewport(0, 0, W, H); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.GREATER); gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); };
const solids = () => { scene(); gl.useProgram(pSolid); bindV(vbMesh, L_SOLIDV, 0); elems(ibMesh); };
const STEPS = [
  [3, () => { camera(); flat(); nDraw = nTri = 0; waterTex(); scene(); gl.clearColor(0, 0, 0, 1); gl.clearDepth(0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); }],
  [7, () => { // set pieces; everything that stands on the terrain comes before it, so the terrain behind is not shaded
  solids();
  if (!SK['set pieces']) {
    for (let i = LEAN ? 4 : 0; i < 12; i++) { const g = Wd.solids.ranges[i]; if (g[1] && (i < 10 || ahead(i))) drawMesh(meshes[i], ibSolids, L_SOLIDI, g[0], g[1]); }
    if (LEAN) for (let i = 0; i < 4; i++) {
      const b = boulders[i];
      drawCells(b.start, b.lo, b.hi, b.mar, meshes[i], -1, 0, 45, b.buf, L_SOLIDI);
      drawCells(b.start, b.lo, b.hi, b.mar, meshes[26 + i], -1, 45, 200, b.buf, L_SOLIDI);
    }
  }
  }],
  [9, () => { // rocks, sponges and corals
  solids();
  if (!SK.rocks) for (let i = 0; i < NCHUNK; i++) {
    const c = Wd.chunks[i], big = i > 2 && i < 6;
    drawCells(c.start, c.lo, c.hi, 3, meshes[14 + i], 0, 0, i > 5 ? 30 * DF : big ? 40 * DF : 96 * DF, ibChunk[i], L_SOLIDI);
    if (big) drawCells(c.start, c.lo, c.hi, 3, meshes[20 + i], 0, 40 * DF, 150 * DF, ibChunk[i], L_SOLIDI);
  }
  if (!SK.plants) for (let i = 0; i < 6; i++) {
    const lod = i === 3 || i === 4, p = Wd.props[i];
    if (LEAN) { // sponges: the far version from 10 m; corals have only the one
      drawCells(p.start, p.lo, p.hi, 3, meshes[4 + i], -1, 0, i < 3 ? 10 : PROPD, ibProp[i], L_SOLIDI);
      if (i < 3) drawCells(p.start, p.lo, p.hi, 3, meshes[30 + i], -1, 10, PROPD, ibProp[i], L_SOLIDI);
      continue;
    }
    drawCells(p.start, p.lo, p.hi, 3, meshes[4 + i], 0, 0, lod ? 6 : 110, ibProp[i], L_SOLIDI);
    if (lod) drawCells(p.start, p.lo, p.hi, 3, meshes[18 + i], 0, 6, 110, ibProp[i], L_SOLIDI);
  }
  }],
  [9, () => { // terrain, and behind everything the background
  scene(); gl.useProgram(pSolid); terrain();
  gl.disable(gl.CULL_FACE); gl.useProgram(pBack); gl.depthFunc(gl.GEQUAL); gl.drawArrays(STRIP, 0, 4); gl.depthFunc(gl.GREATER);
  }],
  [8, () => { // mantas, fish, and the kelp up close: 9-row blades, 5 rows mid-range (the TV level: 5 and 3)
  scene(); bindV(vbMesh, L_SOLIDV, 0); elems(ibMesh);
  if (!SK.fish) {
    gl.useProgram(pManta); drawMesh(MANTA, ibManta, L_ANIM, 0, nManta);
    gl.useProgram(pFish); drawMesh(FISH, ibFish, L_ANIM, 0, ceil(nFish * LIFE));
    // sharks, turtles, squid: wag speed and size, flap speed and size; underside colour (+ how much it glows in its
    // own colour, as the fish do) and back colour (+ pattern scale)
    gl.useProgram(pCre); gl.uniform4f(uCre.ex, 0, 0, 0, 0);
    gl.uniform4f(uCre.par, 2.2, 0.22, 0, 0); gl.uniform4f(uCre.cA, 0.62, 0.68, 0.72, 0.15); gl.uniform4f(uCre.cB, 0.13, 0.19, 0.25, 2);
    drawMesh(CRE[0], ibShark, L_ANIM, 0, ceil(SHARKS.length / 8 * LIFE));
    gl.uniform4f(uCre.par, 0, 0, 1.7, 0.16); gl.uniform4f(uCre.cA, 0.75, 0.68, 0.4, 0.5); gl.uniform4f(uCre.cB, 0.22, 0.3, 0.08, 7);
    drawMesh(CRE[1], ibTurtle, L_ANIM, 0, ceil(TURTLES.length / 8 * LIFE));
    gl.uniform4f(uCre.par, 0, 0, 2.6, 0.07); gl.uniform4f(uCre.cA, 1, 0.62, 0.5, 1.3); gl.uniform4f(uCre.cB, 1, 0.22, 0.12, 14);
    for (let i = 0, n = ceil(SQUID.length * LIFE); i < n; i++) {
      const q = SQUID[i]; gl.uniform4f(uCre.ex, q.x, q.y, q.z, 1); gl.uniform4f(uCre.exd, q.hx, q.hy, q.hz, 0); drawMesh(CRE[2], ibOne, L_ANIM, 0, 1);
    }
  }
  if (!SK.leaves) {
    gl.useProgram(LEAN ? pLeaf5 : pLeaf); drawCells(Wd.big.start, Wd.big.lo, Wd.big.hi, 5, false, LEAN ? 10 : 18, 0, 24, ibBig, L_LEAF);
    gl.useProgram(LEAN ? pLeafF : pLeaf5); drawCells(Wd.big.start, Wd.big.lo, Wd.big.hi, 5, false, LEAN ? 6 : 10, 24, 58, ibBig, L_LEAF);
  }
  }],
  [5, () => { // kelp far away (a decimated set) and the small plants
  scene();
  if (!SK.leaves) {
    gl.useProgram(pLeafF); drawCells(Wd.bigF.start, Wd.bigF.lo, Wd.bigF.hi, 5, false, 6, 58, 150, ibBigF, L_LEAF);
    gl.useProgram(pLeafS); drawCells(Wd.small.start, Wd.small.lo, Wd.small.hi, 1.5, false, 6, 0, 70, ibSmall, L_LEAF);
  }
  }],
  [6, () => { // water surface, sprites
  scene();
  gl.useProgram(pSurf); gl.drawArrays(STRIP, 0, 4);
  if (!SK.sprites) {
    gl.enable(gl.BLEND); gl.depthMask(false); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(pBub); bindV(ibBubbles, L_BUB, 0); gl.drawArraysInstanced(STRIP, 0, 4, nBub);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(pGl); bindV(ibGl, L_BUB, 0); gl.drawArraysInstanced(STRIP, 0, 4, nGl);
    gl.useProgram(pSnow); bindV(ibSnowB, L_SNOW, 0); gl.drawArraysInstanced(STRIP, 0, 4, nSnow);
    if (nInk) { gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.useProgram(pInk); gl.bindBuffer(gl.ARRAY_BUFFER, ibInk); gl.bufferData(gl.ARRAY_BUFFER, INKB.subarray(0, nInk * 8), gl.DYNAMIC_DRAW); bindV(ibInk, L_BUB, 0); gl.drawArraysInstanced(STRIP, 0, 4, nInk); }
    gl.disable(gl.BLEND); gl.depthMask(true);
  }
  }],
  [4, () => { // light shafts (half res), then their blur
  flat();
  if (!SK.shafts) {
    gl.bindFramebuffer(FB, fRay); gl.viewport(0, 0, W / 2, H / 2); gl.useProgram(pRays); tri3();
    gl.bindFramebuffer(FB, fRay2); gl.useProgram(pRB); unit(7, tRay); tri3();
  }
  }],
  [6, () => { // bloom: res -> b0 -> ... -> b5, then back up b5 -> b4 (additive) ... -> b0; then the composite into frame C
  flat();
  if (!SK.bloom) {
    for (let i = 0; i < NB; i++) {
      gl.bindFramebuffer(FB, fBl[i]); gl.viewport(0, 0, max(1, W >> (i + 1)), max(1, H >> (i + 1)));
      gl.useProgram(i ? pDown : pDown0); unit(6, i ? tBl[i - 1] : tRes); tri3();
    }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.useProgram(pUp);
    for (let i = NB - 1; i > 0; i--) { gl.bindFramebuffer(FB, fBl[i - 1]); gl.viewport(0, 0, max(1, W >> i), max(1, H >> i)); unit(6, tBl[i]); tri3(); }
    gl.disable(gl.BLEND);
  }
  gl.bindFramebuffer(FB, fF[fC]); gl.viewport(0, 0, W, H); gl.useProgram(pPost); unit(6, tRes); unit(7, tRay2); unit(8, tBl[0]); tri3();
  }],
];
// C is finished: it becomes B, the newer of the two frames shown
const flip = () => { const a = fA; fA = fB; fB = fC; fC = a; };
// puts frame A faded k of the way to frame B on the screen
function present(k) {
  flat(); gl.bindFramebuffer(FB, null); gl.viewport(0, 0, canvas.width, canvas.height);
  if (UPN > 1) {
    if (SMOOTH) { gl.bindFramebuffer(FB, fAA); gl.viewport(0, 0, W, H); gl.useProgram(pAA); unit(7, tF[fB]); tri3(); gl.bindFramebuffer(FB, null); gl.viewport(0, 0, canvas.width, canvas.height); }
    gl.useProgram(pBig); gl.uniform4f(uBig, W, H, SHARP, UPN); unit(7, SMOOTH ? tAA : tF[fB]); tri3(); return;
  }
  gl.useProgram(pFade); gl.uniform1f(uFade, k); unit(6, tF[fA]); unit(7, tF[fB]); tri3();
}
function render() { for (const s of STEPS) s[1](); flip(); present(1); }

// CS[j] = distance to the rock (metres, < 0 in water) at the camera + CE[3j..3j+2]: the camera, then ±0.375 m on
// each axis for the gradient
const CE = new Float64Array([0, 0, 0, .375, 0, 0, -.375, 0, 0, 0, .375, 0, 0, -.375, 0, 0, 0, .375, 0, 0, -.375]), CS = new Float64Array(7);
const cv = (x, y, z) => { const b = CI[(x >> 2) + CN * ((y >> 2) + NY / 4 * (z >> 2))]; return b > 1 ? CG[b * 64 - 128 + (x & 3) + 4 * (y & 3) + 16 * (z & 3)] : b * 254 - 127; };
function sd(j) {
  const x = (F[CX] + CE[j * 3] - OX) / VS - CO, y = (F[CY] + CE[j * 3 + 1] - OY) / VS, z = (F[CZ] + CE[j * 3 + 2] - OZ) / VS - CO;
  const ix = x | 0, iy = y | 0, iz = z | 0, u = x - ix, v = y - iy, a = cv(ix, iy, iz), b = cv(ix, iy + 1, iz), c = cv(ix, iy, iz + 1), d = cv(ix, iy + 1, iz + 1);
  const p = a + (cv(ix + 1, iy, iz) - a) * u, q = b + (cv(ix + 1, iy + 1, iz) - b) * u, r = c + (cv(ix + 1, iy, iz + 1) - c) * u, s = d + (cv(ix + 1, iy + 1, iz + 1) - d) * u;
  const e = p + (q - p) * v; CS[j] = (e + (r + (s - r) * v - e) * (z - iz)) / 127;
}
// Moves the camera by F[MX..MZ] in steps shorter than its radius CR (so it can't pass through thin rock), pushing it
// back out after each step and dropping velocity into the rock, so it slides along.
const CR = 0.5;
function collide() {
  const n = floor(sqrt(F[MX] * F[MX] + F[MY] * F[MY] + F[MZ] * F[MZ]) / 0.4) + 1;
  for (let i = 0; i < n; i++) {
    F[CX] += F[MX] / n; F[CY] += F[MY] / n; F[CZ] += F[MZ] / n;
    for (let k = 0; k < 2; k++) {
      sd(0); const s = CS[0] + CR; if (s <= 0) break;
      for (let j = 1; j < 7; j++) sd(j);
      let gx = CS[1] - CS[2], gy = CS[3] - CS[4], gz = CS[5] - CS[6]; const l = sqrt(gx * gx + gy * gy + gz * gz);
      if (l < 0.075) break; // flat: deep in rock
      gx /= l; gy /= l; gz /= l; const vn = F[VX] * gx + F[VY] * gy + F[VZ] * gz;
      F[CX] -= gx * s; F[CY] -= gy * s; F[CZ] -= gz * s;
      if (vn > 0) { F[VX] -= gx * vn; F[VY] -= gy * vn; F[VZ] -= gz * vn; }
    }
  }
}

// ?bench in the address (or localStorage.abyssalDebug set, for the TV's inspector): bench(n) in the console draws n frames flat out and returns the milliseconds per frame,
// state() the camera and input state
let debug = /[?&]bench\b/.test(location.search); try { debug = debug || !!localStorage.abyssalDebug; } catch (e) {}
if (debug) { window.SK = SK; window.pace = (ms, st) => { PACE = ms; if (st !== undefined) STILL_PACE = st; ft.length = 0; }; window.frameTimes = () => ft; window.rays = (v) => { RAYS = v; }; window.life = (v) => { LIFE = v; }; window.tuning = () => ({ tune, det, tuneN, tuneSlip });
  window.fishPos = (i) => { const f = Wd.fish, a = i * 8, R = f[a + 3], hx = ((x) => x - floor(x))(sin(f[a + 4] * 127.1) * 43758.5453), ta = F[TIME] * f[a + 5] + f[a + 7] * 6.3 + (hx - 0.5) * (26 / R); return [f[a] + R * cos(ta), f[a + 1] + 2.2 * sin(3 * ta + f[a + 7] * 17), f[a + 2] + R * 0.6 * sin(ta), floor(f[a + 7] * 7)]; }; window.audio = () => ({ AC, OUT, muted }); window.look = (...a) => { saverOn(0); fly(false); lookAt(...a); }; window.squid = () => SQUID;
  window.where = (set, i) => { const a = set === 1 ? TURTLES : SHARKS, o = i * 8, R = a[o + 3], ta = F[TIME] * a[o + 5] + a[o + 7] * 6.3; return [a[o] + R * cos(ta), a[o + 1] + 1.5 * sin(2 * ta + a[o + 7] * 17), a[o + 2] + R * 0.75 * sin(ta)]; }; window.warm = (v) => { WARM = v; }; window.props = (v) => { PROPD = v; ft.length = 0; }; window.res = (w, h, d) => { pix = w * h; if (d) det = d; W = 0; resize(); ft.length = 0; }; window.upscale = (u, sh, aa) => { UP = u; SHARP = sh; SMOOTH = aa !== false; W = 0; resize(); ft.length = 0; }; }
if (debug) window.bench = (n = 30) => { const t = performance.now(); for (let i = 0; i < n; i++) render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); return (performance.now() - t) / n; }; // reading a pixel waits for the GPU

if (window.bench) window.geo = () => ({ meshTris: meshes.map((m) => m.ib.length / 3), solids: Wd.solids.ranges.map((g) => g[1]), chunks: Wd.chunks.map((c) => c.n), props: Wd.props.map((c) => c.n), big: Wd.big.n, bigF: Wd.bigF.n, small: Wd.small.n, terrainTris: nTerrain / 3, glints: nGl, fish: nFish, mantas: nManta });
if (window.bench) window.state = () => ({ x: F[CX], y: F[CY], z: F[CZ], yaw: F[YAW], pitch: F[PIT], pOn, menu, auto, cruise, fast, W, H, det, saver, svPhase, stepI, lvStep, lvHave, fadeAt, now: F[LAST], flt: F[FLT], audio: typeof AC === 'undefined' || !AC ? 'none' : AC.state, leaves: Wd.big.n });
// the scripted flight (FLY) as an autopilot: one minute through the whole world, over and over
const fly = (on) => { auto = on; F[FLT] = 0; cruise = 0; F[VX] = F[VY] = F[VZ] = 0; lkx = lky = l2x = l2y = mdx = mdy = 0; };
const goTo = (i) => { fly(false); view = i; lookAt(...POSES[i]); };

// Amount of life, 0 to 1 (a setting): the share of the fish, sharks, turtles and squid that is drawn.
let LIFE = 0.7;
// Squid hang in the water where they will be seen: one 11 m in front of viewpoints 1 and 4, and two beside the
// tour path, 9 m off it (the tour passes without disturbing them). When the camera comes within 7 m one darts off,
// three times in ten leaving a cloud of ink; half a minute later it swims back home. x, y, z; heading; speed; t: seconds of
// flight left; w: seconds until it heads home; ph: phase of its drift; ox, oy, oz: home.
const SQUID = [];
{
  const add = (x, y, z) => SQUID.push({ x, y, z, ox: x, oy: y, oz: z, hx: 1, hy: 0, hz: 0, v: 0, t: 0, w: 0, ph: SQUID.length * 2.1 });
  for (const p of [POSES[0], POSES[3]]) { const dx = p[3] - p[0], dy = p[4] - p[1], dz = p[5] - p[2], l = hypot(dx, dy, dz); add(p[0] + dx / l * 11, min(-6, p[1] + dy / l * 11 + 0.8), p[2] + dz / l * 11); }
  for (const k of [4, 19]) { const a = k * 6, dx = FLY[a + 6] - FLY[a], dz = FLY[a + 8] - FLY[a + 2], l = hypot(dx, dz) || 1; add(FLY[a] - dz / l * 9, FLY[a + 1] + 1.5, FLY[a + 2] + dx / l * 9); }
}
const INK = [], INKB = new Float32Array(64 * 8); let nInk = 0; // ink blobs: x, y, z, their drift, age, life, size
function squidTick(dt) {
  for (let i = 0, n = ceil(SQUID.length * LIFE); i < n; i++) {
    const q = SQUID[i], dx = q.x - F[CX], dy = q.y - F[CY], dz = q.z - F[CZ], d = sqrt(dx * dx + dy * dy + dz * dz);
    if (q.t <= 0 && d < 7 && !saver) { // off it goes, away from the camera and a little upwards; the ink, if any, stays where it was
      const l = sqrt(dx * dx + dz * dz) || 1; q.hx = dx / l * 0.94; q.hz = dz / l * 0.94; q.hy = 0.34; q.v = 8; q.t = 5;
      if (Math.random() < 0.3) for (let k = 0; k < 16 && INK.length < 64; k++) INK.push([q.x + rr(-0.4, 0.4), q.y + rr(-0.4, 0.4), q.z + rr(-0.4, 0.4), rr(-0.5, 0.5), rr(-0.2, 0.5), rr(-0.5, 0.5), 0, rr(7, 12), rr(0.5, 1.1)]);
    }
    const ex = q.ox - q.x, ey = q.oy - q.y, ez = q.oz - q.z, el = sqrt(ex * ex + ey * ey + ez * ez);
    if (q.t > 0) { q.t -= dt; q.v *= exp(-dt * 0.9); q.w = 30; } // fleeing
    else if ((q.w -= dt) < 0 && el > 1.5 && d > 12) { q.v = 1.4; q.hx += (ex / el - q.hx) * dt * 2; q.hy += (ey / el - q.hy) * dt * 2; q.hz += (ez / el - q.hz) * dt * 2; } // going home
    else { q.ph += dt; q.v = 0.25; const a = q.ph * 0.2; q.hx += (cos(a) - q.hx) * dt; q.hz += (sin(a) - q.hz) * dt; q.hy += (sin(q.ph * 0.5) * 0.25 - q.hy) * dt; } // hanging about
    q.x += q.hx * q.v * dt; q.y = min(-4, max(-44, q.y + q.hy * q.v * dt)); q.z += q.hz * q.v * dt;
    const r = sqrt(q.x * q.x + q.z * q.z); if (r > 140) { q.x *= 140 / r; q.z *= 140 / r; }
  }
  nInk = 0;
  for (let k = INK.length - 1; k >= 0; k--) {
    const b = INK[k]; b[6] += dt; if (b[6] > b[7]) { INK.splice(k, 1); continue; }
    const s = exp(-b[6] * 0.6); b[0] += b[3] * s * dt; b[1] += b[4] * s * dt; b[2] += b[5] * s * dt;
    const u = b[6] / b[7], o = nInk++ * 8;
    INKB[o] = b[0]; INKB[o + 1] = b[1]; INKB[o + 2] = b[2]; INKB[o + 3] = b[8] * (1 + 2.2 * (1 - s)); INKB[o + 4] = 0.7 * min(1, b[6] * 4) * (1 - u) * (1 - u); INKB[o + 5] = k;
  }
}

// Measure (the menu button, or P): times the frame as it is, then with each part left out in turn and at a quarter
// of the pixels, and lists how long each loading stage took. The numbers stay on screen until Stats is toggled.
let busy = false, fAvg = 0;
// The two screensavers. Both show views from along the tour path at full draw distance, each faded in over SAVER_FADE.
// 1, stills: 1920x1080 pictures, each drawn one step per display frame behind the one on screen, held SAVER_HOLD.
// 2, animated: 1280x720. The parts of a view that do not move (terrain, rocks, sponges, corals, set pieces, the
//    background) are drawn once into a background with its depth; every frame then starts from a copy of it and adds
//    only what moves (fish, kelp, the water surface, bubbles and specks, light shafts). The light rippling over the
//    rocks is in the background too; a pass over the copy (G_RIPPLE) rescales it from the ripples of the moment the
//    background was drawn (kept in tWater0) to those of now. A view stays for LIVE_VIEW.
// 3, a still view: not a screensaver but the same drawing as 2, of the view the camera has come to rest at (STILL, a
//    setting). frame() starts it after a second without movement and ends it at the first input.
const SAVER_FADE = 3000, SAVER_HOLD = 6000, LIVE_VIEW = 40000;
let LIVE_PIX = 1280 * 720; try { LIVE_PIX = +localStorage.abyssalLivePix || LIVE_PIX; } catch (e) {} // (the stored value: for trying other sizes)
let fadeAt = 0, hShown = 0, svPhase = 0, svPix = 0, svDet = 0, STILL = TV, idleT = 0; // phase: 0 pick the next view, 1 drawing it, 2 showing it
let lvStep = 0, lvAt = 0, lvCur = 0, lvHave = false;
const UBc = new Float32Array(64), RCc = new Float64Array(32), UBn = new Float32Array(64), RCn = new Float64Array(32); // the cameras of the view on screen and of the next
function saverOn(mode) {
  if (mode === saver || dead) return;
  const was = saver;
  if (!was) { svPix = pix; svDet = det; }
  saver = mode; svPhase = 0; lvHave = false; fadeAt = -1e9; idleT = 0;
  if (mode) { pix = min(mode > 1 ? LIVE_PIX : 1920 * 1080, DW * DH); det = 1; if (mode < 3) { fly(false); ui(false); } }
  else { pix = svPix; det = svDet; if (was < 3) lookAt(...POSES[view]); }
  body.classList.toggle('s', mode === 1 || mode === 2); resize();
}
const nextView = () => { F[FLT] = (F[FLT] + 3.7) % FLYT; flyAt(); };
function saverTick(now) {
  if (svPhase === 0) { nextView(); stepI = 0; svPhase = 1; }
  if (svPhase === 1) { STEPS[stepI++][1](); if (stepI === STEPS.length) { stepI = 0; flip(); fadeAt = now; svPhase = 2; hShown++; } }
  else if (now - fadeAt > SAVER_FADE + SAVER_HOLD) svPhase = 0;
}
const useCam = (ub, rc, d) => { UB.set(ub); RC.set(rc); UB[35] = F[TIME]; if (d) UB[58] = d; tint(UB); gl.bindBuffer(gl.UNIFORM_BUFFER, ubo); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, UB); };
function liveTick(now) {
  if (svPhase === 0) { if (saver < 3) nextView(); lvStep = 0; svPhase = 1; }
  if (svPhase === 1) { // the next view's background: steps 0 to 3, one per display frame, into the spare background
    sceneFbo = fSt[1 - lvCur];
    if (lvStep === 0) { STEPS[0][1](); UBn.set(UB); RCn.set(RC); } else { useCam(UBn, RCn); STEPS[lvStep][1](); }
    sceneFbo = fScene;
    if (++lvStep < 4) return; // (the view on screen holds still meanwhile)
    // it becomes the view on screen: the last frame of the old one stays as A, and fades into the new frames
    lvCur = 1 - lvCur; UBc.set(UBn); RCc.set(RCn); flip(); fadeAt = lvAt = now; lvHave = true; svPhase = 2;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fWater); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fWater0);
    gl.blitFramebuffer(0, 0, WATER, WATER, 0, 0, WATER, WATER, gl.COLOR_BUFFER_BIT, gl.NEAREST); unit(8, tWater0); gl.generateMipmap(T2);
  }
  if (!lvHave) return;
  // a still view draws what moves (the kelp, mostly) only as far as the moving picture did: at full distance the
  // kelp alone took a third of the frame on the TV, and the view stuttered
  const d0 = det; if (saver > 2) det = svDet;
  useCam(UBc, RCc, det); waterTex();
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fSt[lvCur]); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fScene);
  gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
  // the rippling light: multiplies the copy, reading the background's own depth
  flat(); gl.bindFramebuffer(FB, fScene); gl.viewport(0, 0, W, H); gl.enable(gl.BLEND); gl.blendFunc(gl.DST_COLOR, gl.ZERO);
  gl.useProgram(pRipple); unit(5, tSt[lvCur * 2 + 1]); unit(8, tWater0); tri3(); gl.disable(gl.BLEND); unit(5, tDp);
  for (let i = 4; i < STEPS.length; i++) STEPS[i][1]();
  det = d0;
  { const b = fB; fB = fC; fC = b; } hShown++; // the new frame is B; A is only seen during the fade
  if (saver < 3 && now - lvAt > LIVE_VIEW) svPhase = 0;
}

async function measure() {
  if (busy) return; busy = true; hud = false;
  const px = new Uint8Array(4), sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // waits for the GPU
  // [ms per frame, of which spent in this thread issuing the draw calls]
  const run = (n) => { render(); sync(); const t = performance.now(); for (let i = 0; i < n; i++) render(); const js = performance.now() - t; sync(); return [(performance.now() - t) / n, js / n]; };
  const out = [`${GPUNAME}  ·  ${['High', 'Medium', 'Low', 'TV'][LV]} detail`];
  const show = async (l) => { out.push(l); info.textContent = out.join('\n') + (busy ? '\nmeasuring…' : ''); await tick(40); };
  await show('loading: ' + stages.slice(0, -1).map((g, i) => `${g[0].replace('…', '')} ${((stages[i + 1][1] - g[1]) / 1000).toFixed(1)} s`).join(', '));
  const n = max(4, min(60, round(2000 / run(3)[0]))), full = run(n); // about 2 s a run
  await show(`${W}x${H}, draw distance ${det * 100 | 0}%: ${full[0].toFixed(1)} ms per frame (${full[1].toFixed(1)} ms issuing ${nDraw} draws, ${nTri / 1000 | 0}k triangles)  ·  on screen ${fAvg.toFixed(1)} ms`);
  for (const k in SK) { SK[k] = 1; const r = run(n); SK[k] = 0; await show(`without ${k}: ${r[0].toFixed(1)} ms (${(full[0] - r[0]).toFixed(1)} less), ${nDraw} draws, ${nTri / 1000 | 0}k triangles`); }
  const was = pix; pix = W * H / 4; resize(); const q = run(n);
  await show(`at ${W}x${H}: ${q[0].toFixed(1)} ms (${(full[0] - q[0]).toFixed(1)} less)`);
  for (const k in SK) SK[k] = 1; const bare = run(n); for (const k in SK) SK[k] = 0;
  await show(`at that size with every part left out: ${bare[0].toFixed(1)} ms`);
  pix = was; resize(); const again = run(n); busy = false;
  await show(`as it is, measured again: ${again[0].toFixed(1)} ms`);
}

// On a TV a frame takes about 75 ms at 640x360, between four and five refreshes of its 60 Hz display, so frames
// would come unevenly. PACE holds every frame for five refreshes: a steady 12 a second looks smoother. (Measured on
// an LG CX: 480x270 fits four refreshes, 15 a second; 720x405 needs six.)
let STILL_PACE = 78; // the same for a still view (5 refreshes)
let PACE = TV ? 78 : 0, tuneN = 0, tuneSlip = 0, tuneT = 0, tuneOk = 0;
const ft = []; // (debug) the last frame intervals
function frame(now) {
  requestAnimationFrame(frame);
  if (PACE && (saver ? saver > 2 && STILL_PACE : PACE) && now - F[LAST] < (saver ? STILL_PACE : PACE)) return; // too early: this refresh keeps the last frame
  const dtr = now - F[LAST]; F[LAST] = now;
  if (debug) { ft.push(dtr); if (ft.length > 400) ft.shift(); }
  // Self-tuning (a setting, on a TV): every 3 s, if more than one frame in eight came later than its slot the draw
  // distance drops 8%; after three such periods with hardly any late, it goes back up 6%.
  if (tune && PACE && !saver && !menu && dtr < 500) {
    tuneN++; if (dtr > PACE + 15) tuneSlip++;
    if ((tuneT += dtr) > 3000) {
      const f = tuneSlip / tuneN;
      if (f > 0.12) { det = max(0.25, det * 0.92); tuneOk = 0; setSave(); } else if (f < 0.03 && ++tuneOk > 2) { det = min(1, det * 1.06); tuneOk = 0; setSave(); }
      tuneN = tuneSlip = tuneT = 0;
    }
  }
  if (busy) return; // measure() is drawing
  if (dtr < 1e3) fAvg += (dtr - fAvg) * 0.05;
  let dt = dtr / 1000; if (dt > 0.1) dt = 0.1;
  // Dynamic resolution for the target frame time: every second (0.4 s behind the menu) scale the load by k
  if (!TV && !saver && dtr < 1e3 && (dynT += dtr) > 0 && (dynN++, dynT > (menu ? 400 : 1000))) {
    const a = dynT / dynN; let k = 1;
    // slow for two periods in a row means fewer pixels, and twice as long before trying to go back up
    if (a > TF * 1.055) { dynOk = 0; if (++dynBad > 1) { k = TF * 0.9 / a; dynBad = 0; dynWait = min(dynWait * 2, 60); } }
    // at the display's rate there is no telling if there is room, so try a little more now and then
    else { dynBad = 0; if (a < TF * 0.75) k = TF * 0.9 / a; else if (++dynOk > dynWait) { k = 1.17; dynOk = 0; } }
    k = k < 0.5 ? 0.5 : k > 1.7 ? 1.7 : k; const top = min(PIXMAX, DW * DH), mid = max(top / 2, PIXMIN), was = pix + det;
    // too slow: pixels down to `mid` first, then draw distance, then the remaining pixels; faster goes back the same way
    if (k < 1 ? pix > mid || det <= DETMIN : pix < mid || det >= 1) {
      const end = k < 1 ? (det > DETMIN ? mid : PIXMIN) : det < 1 ? mid : top;
      pix *= k; if (k < 1 ? pix < end : pix > end) pix = end;
    } else { det *= sqrt(k); det = det < DETMIN ? DETMIN : det > 1 ? 1 : det; }
    if (was !== pix + det) keep('abyssalGL', [LV, pix < top ? pix | 0 : '', det]); // nothing kept at full resolution
    dynN = dynT = 0; resize();
  }
  F[TIME] += dt; squidTick(dt);
  // a still view ends at the first sign of input
  if (saver === 3 && (kf || kb || kl || kr || ku || kd || kyl || kyr || cruise || auto || menu || tId >= 0 || mdx || mdy || abs(wv) > 0.05 || (pOn && (abs(pjx) > 0.2 || abs(pjy) > 0.2)))) saverOn(0);
  if (saver === 1) saverTick(now); else if (saver >= 2) liveTick(now);
  else if (auto) { F[FLT] += dt; if (F[FLT] >= FLYT) F[FLT] = 0; flyAt(); }
  else {
    // touch: holding the finger away from where it went down keeps turning, like a joystick
    if (tId >= 0) {
      const tr = 4 / (innerWidth < innerHeight ? innerWidth : innerHeight); let jx = (tx - tx0) * tr, jy = (ty - ty0) * tr;
      jx = jx > 1 ? 1 : jx < -1 ? -1 : jx; jy = jy > 1 ? 1 : jy < -1 ? -1 : jy;
      lkx += jx * 1.5 * dt; lky += jy * dt;
    }
    // TV pointer: the further from the middle of the screen, the faster the view turns that way
    if (pOn && now - pT > 6e3) pOn = false;
    if (pOn && !menu) {
      const ax = abs(pjx) - 0.2, ay = abs(pjy) - 0.2; // nothing happens in the middle 40% of the screen
      if (ax > 0) lkx += (pjx < 0 ? -1 : 1) * ax * ax * 0.9 * dt;
      if (ay > 0) lky += (pjy < 0 ? -1 : 1) * ay * ay * 0.6 * dt;
    }
    lkx += (kyr - kyl) * (TV ? 0.7 : 1.3) * dt; wv *= exp(-dt * 3);
    // mouse look through two cascaded low-pass stages
    const kq = 1 - exp(-dt * (TV ? 5 : 30)); lkx += mdx * 0.0022; // (a TV turns slowly into and out of a turn) lky += mdy * 0.0022; mdx = 0; mdy = 0;
    const ax = lkx * kq, ay = lky * kq; lkx -= ax; lky -= ay; l2x += ax; l2y += ay;
    const dyw = l2x * kq, dpt = l2y * kq; l2x -= dyw; l2y -= dpt;
    const yaw = F[YAW] + dyw; let pitch = F[PIT] - dpt; pitch = pitch < -1.55 ? -1.55 : pitch > 1.55 ? 1.55 : pitch;
    const sp = ks || fast || tN > 1 ? 26 : 7, k = 1 - exp(-dt * 4.5), mf = tId >= 0 ? 0.7 : cruise && !kb ? 1 : kf - kb, mr = kr - kl, mu = ku - kd + wv, cp = cos(pitch), sy = sin(yaw), cw = cos(yaw);
    const vx = F[VX] + ((sy * cp * mf + cw * mr) * sp - F[VX]) * k, vy = F[VY] + ((sin(pitch) * mf + mu) * sp - F[VY]) * k, vz = F[VZ] + ((-cw * cp * mf + sy * mr) * sp - F[VZ]) * k;
    let x = F[CX] + vx * dt, y = F[CY] + vy * dt, z = F[CZ] + vz * dt;
    const rad = sqrt(x * x + z * z); if (rad > 150) { x *= 150 / rad; z *= 150 / rad; }
    y = y < -52 ? -52 : y > -1.2 ? -1.2 : y;
    F[YAW] = yaw; F[PIT] = pitch; F[VX] = vx; F[VY] = vy; F[VZ] = vz; F[MX] = x - F[CX]; F[MY] = y - F[CY]; F[MZ] = z - F[CZ];
    collide();
    // at rest for over a second: the still view, sharper (see liveTick())
    idleT = abs(vx) + abs(vy) + abs(vz) > 0.03 || abs(dyw) + abs(dpt) > 1e-4 || tId >= 0 || menu ? 0 : idleT + dt;
    if (STILL && idleT > 1.2) saverOn(3);
  }
  if (saver) present(min(1, (now - fadeAt) / (saver > 2 ? 500 : SAVER_FADE)));
  else { render(); hShown++; }
  if (hud) {
    hN++; if (dtr > hMax) hMax = dtr; if (dtr < hMin) hMin = dtr; if (dtr > hPer * 1.5) { hLate++; hTot++; }
    F[HUDT] += dtr / 1000;
    // (every 2 s: on the TV each change of this text costs about one late frame)
    if (F[HUDT] > 2) { info.textContent = `${(hN / F[HUDT]).toFixed(0)} fps${saver ? ` (${saver > 2 ? 'still view' : 'screensaver'}: ${(hShown / F[HUDT]).toFixed(1)} new frames a second)` : ''}  ·  worst frame ${hMax.toFixed(1)} ms  ·  late frames ${hLate} (total ${hTot})  ·  ${W}x${H} (${W * 100 / DW | 0}%)  ·  draw distance ${det * 100 | 0}%\n${['High', 'Medium', 'Low', 'TV'][LV]} detail  ·  ${GPUNAME}`; F[HUDT] = 0; hPer = hMin; hN = 0; hMax = 0; hMin = 1e9; hLate = 0; hShown = 0; }
  }
}

// ?bench: step(n, ms) runs n frames of ms each by hand (a hidden window gets no animation frames)
if (window.bench) window.step = (n = 1, ms = 33) => { for (let t = F[LAST]; n-- > 0;) frame(t += ms); };

// ---------------------------------------------------------------- input
// Keyboard and mouse as in the original. A TV remote sends key codes (arrows, OK = 13, Back = 461, the colour buttons
// 403-406, channel up / down = 33 / 34) and, with a Magic Remote, a pointer and a scroll wheel:
//   pointer         look: the view turns towards where it points, faster further from the middle
//   up / down       swim forward / back          left / right   turn
//   OK or click     keep swimming forward (again to stop)
//   wheel, channel  up / down
//   red             the autopilot tour           green          next viewpoint
//   yellow          the light's colour           blue           swim faster
//   Back            menu (from the menu: leave the app)
// The screensavers are buttons in the menu; G (or Play on a remote) starts the animated one, T the stills.
// the sound (audio.js), if it is switched on, starts on the first key or click; it is set up after this file has run
const snd = () => { try { sound(); } catch (e) {} };
const soundOnOff = () => { try { mute(); } catch (e) {} };
const statsOnOff = () => { hud = !hud; hTot = 0; hPer = 1e9; info.textContent = ''; };
// the yellow button (L): the light's colour, cool as in the original, warm, then golden hour coming and going
let flashT = 0;
const flash = (m) => { if (hud) return; info.textContent = m; clearTimeout(flashT); flashT = setTimeout(() => { if (!hud) info.textContent = ''; }, 1800); };
const lightNext = () => { if (golden) { golden = false; WARM = 0; } else if (WARM < 0.25) WARM = 0.5; else golden = true; flash('Light: ' + (golden ? 'golden hour' : WARM < 0.25 ? 'cool' : 'warm')); setSave(); };
const held = new Uint8Array(512); // remotes repeat keydown without marking it as a repeat
const key = (e, v) => {
  const c = e.keyCode;
  switch (c) {
    case 87: case 38: kf = v; break; case 83: case 40: kb = v; if (v) cruise = 0; break;
    case 65: kl = v; break; case 68: kr = v; break; case 37: kyl = v; break; case 39: kyr = v; break;
    case 69: case 33: ku = v; break; case 81: case 34: kd = v; break; case 16: ks = v; break;
    default: if (v && !held[c & 511]) {
      if (c === 72) statsOnOff();
      else if (c === 405 || c === 76) lightNext();
      else if (c === 27 || c === 461) ui(true);
      else if (c === 13 || c === 32) cruise ^= 1;
      else if (c === 70 || c === 403) fly(!auto);
      else if (c === 404) goTo((view + 1) % 6);
      else if (c === 406) fast ^= 1;
      else if (c === 80) measure();
      else if (c === 77) soundOnOff();
      else if (c === 71 || c === 415) saverOn(2);
      else if (c === 84) saverOn(1);
      else if (c >= 49 && c <= 54) goTo(c - 49);
    }
  }
  held[c & 511] = v;
};
addEventListener('keydown', (e) => {
  const c = e.keyCode; snd();
  if (saver === 3) saverOn(0);
  if (saver) { if (c === 72 || c === 405 || c === 76) key(e, 1); else { saverOn(0); if (c === 27 || c === 461) ui(true); } e.preventDefault(); return; } // any key ends the screensaver
  if (!menu) { key(e, 1); if (TV) e.preventDefault(); return; }
  if (c === 72 || c === 80) key(e, 1); // behind the menu only the stats and measure keys work
  else if (c >= 37 && c <= 40) { // the arrows move between the menu's buttons; on a setting, left and right change it
    const a = document.activeElement, b = Array.from(document.querySelectorAll('#g button')).filter((x) => x.offsetParent), i = b.indexOf(a);
    if (a && a.dataset.i && (c === 37 || c === 39)) setStep(+a.dataset.i, c - 38); else b[(i + (c < 39 ? b.length - 1 : 1)) % b.length].focus();
    e.preventDefault();
  } else if (c === 461 && TV) { if ($('g').className) setOpen(false); else close(); }
});
addEventListener('keyup', (e) => key(e, 0));
const release = () => { kf = kb = kl = kr = ku = kd = ks = kyl = kyr = 0; tId = -1; tN = 0; pOn = false; held.fill(0); };
const capture = () => { const p = canvas.requestPointerLock({ unadjustedMovement: true }); if (p && p.catch) p.catch(() => canvas.requestPointerLock()).catch(() => 0); };
canvas.addEventListener('click', () => { snd(); if (saver === 3) saverOn(0); if (saver) saverOn(0); else if (TV) cruise ^= 1; else capture(); });
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas) { mdx += e.movementX; mdy += e.movementY; }
  else if (TV) { pjx = e.clientX / innerWidth * 2 - 1; pjy = e.clientY / innerHeight * 2 - 1; pOn = true; pT = performance.now(); }
});
// webOS says when the pointer disappears (the remote was put down)
document.addEventListener('cursorStateChange', (e) => { if (e.detail && !e.detail.visibility) pOn = false; });
document.addEventListener('mouseleave', () => { pOn = false; });
addEventListener('wheel', (e) => { if (!menu) wv = e.deltaY < 0 ? 1 : -1; });
addEventListener('blur', release);
const touch = (e) => {
  e.preventDefault(); tN = e.touches.length;
  let f = null, first = false; for (let i = 0; i < tN; i++) if (e.touches[i].identifier === tId) f = e.touches[i];
  if (!f) { tId = -1; if (tN) { f = e.touches[0]; tId = f.identifier; first = true; } }
  if (f) {
    const x = f.clientX, y = f.clientY, s = 1100 / min(innerWidth, innerHeight);
    if (first) { tx0 = x; ty0 = y; } else { mdx += (x - tx) * s; mdy += (y - ty) * s; } // the view follows the finger at once
    tx = x; ty = y;
  }
};
for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) canvas.addEventListener(n, touch, { passive: false });

// ---------------------------------------------------------------- menu
// The scene keeps rendering behind the menu. Esc / Back, losing the mouse or the corner button open it.
let menu = true;
const bDive = $('d');
const ui = (m) => {
  if (dead) return;
  menu = m; body.className = m ? 'm' : document.pointerLockElement ? 'g p' : 'g';
  // focus the dive button so Enter / OK works (delayed: it can't take focus while still hidden)
  if (m) { release(); for (const t of [100, 1000]) setTimeout(() => menu && document.activeElement === body && bDive.focus(), t); } else document.activeElement.blur();
};
const go = () => { snd(); ui(false); bDive.textContent = 'Resume'; if (!TV && !mob) capture(); };
bDive.onclick = go; $('o').onclick = () => ui(true); $('x').onclick = measure; $('v').onclick = () => { snd(); saverOn(2); }; $('u').onclick = () => { snd(); saverOn(1); }; 
// ---------------------------------------------------------------- settings
// A panel in the menu (the Settings button), one row a setting, kept in localStorage.abyssalSet. A row is a slider
// (v: its value as 0 to 1, set, n steps), a switch (on, flip) or a choice (text, step). Left and right on the
// remote change the focused row; a click changes it too, down on its left half and up on its right. tv: only on a TV.
const RESES = [[480, 270, 62, '480×270 · 15 a second'], [640, 360, 78, '640×360 · 12 a second'], [720, 405, 95, '720×405 · 10 a second']]; // size, pace (ms), name
let resI = 1, tune = false;
const applyRes = () => { pix = RESES[resI][0] * RESES[resI][1]; PACE = RESES[resI][2]; if (saver) svPix = pix; else { W = 0; resize(); } };
const SETS = [
  { label: 'Light shafts', v: () => RAYS / 0.6, set: (u) => { RAYS = u * 0.6; }, n: 15 },
  { label: 'Warmth', v: () => WARM, set: (u) => { WARM = u; }, n: 10 },
  { label: 'Golden hour', on: () => golden, flip: () => { golden = !golden; } },
  { label: 'Life', v: () => LIFE, set: (u) => { LIFE = u; }, n: 10 },
  { label: 'Sound', on: () => { try { return !muted; } catch (e) { return false; } }, flip: soundOnOff },
  { label: 'Picture', tv: 1, text: () => RESES[resI][3], step: (d) => { resI = (resI + d + 3) % 3; applyRes(); } },
  { label: 'Draw distance', tv: 1, v: () => (det - 0.25) / 0.75, set: (u) => { det = 0.25 + u * 0.75; }, n: 15 },
  { label: 'Self-tuning', tv: 1, on: () => tune, flip: () => { tune = !tune; } },
  { label: 'Sharpen when still', tv: 1, on: () => STILL, flip: () => { STILL = !STILL; } },
  { label: 'Stats line', on: () => hud, flip: statsOnOff },
].filter((r) => TV || !r.tv);
const setSave = () => keep('abyssalSet', JSON.stringify({ rays: RAYS, warm: WARM, gold: golden, life: LIFE, res: resI, det: saver ? svDet : det, tune, still: STILL, sound: (() => { try { return !muted; } catch (e) { return false; } })() }));
const setDraw = () => SETS.forEach((r, i) => { const e = $('t').children[i].lastChild; if (r.v) e.firstChild.firstChild.style.width = round(r.v() * 100) + '%'; else e.textContent = r.text ? '◀ ' + r.text() + ' ▶' : r.on() ? 'On' : 'Off'; });
// changes setting i one step down (d < 0) or up
function setStep(i, d) {
  const r = SETS[i];
  if (r.v) r.set(clamp(round(r.v() * r.n + d) / r.n, 0, 1)); else if (r.step) r.step(d); else r.flip();
  setSave(); setTimeout(setDraw, 60); // (the sound switch takes a moment to know its state)
}
const setOpen = (on) => { $('g').className = on ? 'set' : ''; $('e').textContent = on ? 'Controls' : 'Settings'; if (on) { setDraw(); $('t').firstChild.focus(); } else $('e').focus(); };
SETS.forEach((r, i) => {
  const b = document.createElement('button'); b.dataset.i = i;
  b.innerHTML = '<span></span>' + (r.v ? '<em><u><i></i></u></em>' : '<em></em>'); b.firstChild.textContent = r.label;
  b.onclick = (e) => { const q = b.getBoundingClientRect(); setStep(i, r.v || r.step ? (e.clientX && e.clientX < q.left + q.width / 2 ? -1 : 1) : 1); };
  $('t').appendChild(b);
});
$('e').onclick = () => setOpen(!$('g').className);
try {
  const o = JSON.parse(localStorage.abyssalSet || '{}');
  if (o.rays >= 0) RAYS = o.rays; if (o.warm >= 0) WARM = o.warm; if (o.gold !== undefined) golden = !!o.gold; if (o.life >= 0) LIFE = o.life;
  if (TV) { if (o.det >= 0.25) det = o.det; tune = !!o.tune; if (o.still !== undefined) STILL = !!o.still; if (o.res >= 0 && o.res < 3 && o.res !== resI) { resI = o.res; applyRes(); } }
} catch (e) {}
// detail buttons: the current level is lit, the others reload the page with theirs
$('q').querySelectorAll('button').forEach((b, i) => { if (i === 3 - LV) b.className = 'on'; else b.onclick = () => { keep('abyssalGL', 3 - i); location.reload(); }; });
document.addEventListener('pointerlockchange', () => { if (!TV && !saver) ui(!document.pointerLockElement); });

// ---------------------------------------------------------------- webOS: keep the TV's own screensaver away
// webOS asks every registered app before it starts its screensaver (after a couple of minutes without a key press);
// answering "ack: false" stops it. This scene keeps moving, so it never needs one.
{
  const Bridge = window.WebOSServiceBridge || window.PalmServiceBridge;
  if (Bridge) try {
    const name = 'com.abyssalgarden.webgl', ask = new Bridge();
    ask.onservicecallback = (m) => {
      try {
        const r = JSON.parse(m);
        if (r.timestamp) new Bridge().call('luna://com.webos.service.tvpower/power/responseScreenSaverRequest', JSON.stringify({ clientName: name, ack: false, timestamp: r.timestamp }));
      } catch (e) {}
    };
    ask.call('luna://com.webos.service.tvpower/power/registerScreenSaverRequest', JSON.stringify({ subscribe: true, clientName: name }));
    window.addEventListener('unload', () => ask.cancel && ask.cancel());
  } catch (e) { console.warn(e); }
}

// draw the first frame and wait for the GPU to finish it (programs get compiled on first use) before the reveal
lookAt(...POSES[0]);
await say('Letting the light in…', 1, 400);
render(); gl.finish();
stages.push(['', performance.now()]);
setTimeout(keep, 15e3, 'abyssalGLLoad', ''); // the load counts as survived after 15 s of frames
ui(true);
requestAnimationFrame((t) => { F[LAST] = t; requestAnimationFrame(frame); });

// ============================================================================
// quality level, chosen before anything is built (WebGL2 / webOS port)
// ============================================================================
// LV: 0 High, 1 Medium, 2 Low, 3 TV. Each level keeps every 2nd / 4th / 8th leaf, glint and pebble of the one above;
// Low and TV use coarser meshes, cheaper filtering and fewer light shaft steps. This port never anti-aliases.
// localStorage.abyssalGL = "level,pixels,detail". abyssalGLLoad is set while the world is built: still set on the
// next visit means that load crashed the app, so this one runs a level lower.
// TV: running as a webOS app (or ?tv in the address, to try the TV controls on a computer). ?lv=N forces a level.
const TV = /Web0S|webOS/i.test(navigator.userAgent) || /[?&]tv\b/.test(location.search);
const mob = !TV && matchMedia('(pointer:coarse)').matches, mem = navigator.deviceMemory;
const keep = (k, v) => { try { localStorage[k] = v; } catch (e) {} };
let SV = [], LV, bad;
try { SV = (localStorage.abyssalGL || '').split(','); bad = localStorage.abyssalGLLoad; } catch (e) {}
{ const q = /[?&]lv=(\d)/.exec(location.search); if (q) SV = [q[1]]; }
LV = SV[0] ? +SV[0] : TV ? 3 : mob ? (mem > 7 ? 1 : 2) : mem <= 4 ? 2 : 0;
if (bad && LV < 3) { SV = [++LV]; keep('abyssalGL', LV); }
const THIN = 1 << LV, SHADOW = LV ? 2048 : 4096, WATER = LV > 1 ? 256 : 512, RAYN = LV > 2 ? 8 : LV > 1 ? 12 : 34;

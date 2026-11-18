// ============================================================================
// audio: a quiet underwater ambience for the port (no sample files)
// ============================================================================
// Not the original's soundscape (../../source/src/audio.js: drone, chimes, whale calls through a long reverb), which
// stuttered on a TV and was more music than water. This one is three plain layers, and light: no reverb, a dozen
// nodes, and everything timed at least a second ahead so that a slow frame cannot interrupt it.
//   rumble   low-passed noise, steady
//   waves    the same noise, brighter, swelling and falling away every 7 to 11 s, with a little hiss at the crest
//   bubbles  now and then a few short rising blips
// Off until the Sound setting turns it on (kept in localStorage.abyssalSet).
let AC, OUT, muted = true;
try { muted = !JSON.parse(localStorage.abyssalSet || '{}').sound; } catch (e) {}
const VOL = 0.75;
function mkSound(ac) {
  const sr = ac.sampleRate, n = sr * 8 | 0, buf = ac.createBuffer(2, n, sr), R = Math.random, rnd2 = (a, b) => a + (b - a) * R();
  // 8 s of brown noise that loops without a seam (the end cross-fades into the start)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0, b = 0; i < n + 4096; i++) { b = (b + 0.02 * (R() * 2 - 1)) / 1.02; if (i < n) d[i] = b * 3.5; else { const k = (i - n) / 4096; d[i - n] = d[i - n] * k + b * 3.5 * (1 - k); } }
  }
  const gain = (v, to) => { const g = ac.createGain(); g.gain.value = v; g.connect(to); return g; };
  const filt = (type, f, q, to) => { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.connect(to); return b; };
  const noise = (rate, to) => { const s = ac.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.connect(to); s.start(); };
  const out = OUT = gain(0, ac.destination);
  noise(1, filt('lowpass', 130, 0.7, gain(0.45, out)));
  // waves: the body and the crest are the noise at other speeds, so the three loops never line up
  const body = gain(0.06, out), crest = gain(0, out);
  noise(0.71, filt('lowpass', 520, 0.5, body)); noise(1.93, filt('bandpass', 1900, 0.6, crest));
  const bub = [0, 1, 2].map(() => { const g = gain(0, out), o = ac.createOscillator(); o.connect(g); o.start(); return { o, g }; });
  let tWave = ac.currentTime + 1, tBub = ac.currentTime + 3, nb = 0;
  // every second: put the waves and bubbles of the next three seconds on the clock
  return () => {
    const lim = ac.currentTime + 3;
    while (tWave < lim) {
      const t = tWave, big = rnd2(0.6, 1);
      body.gain.setTargetAtTime(0.42 * big, t, 1.3); body.gain.setTargetAtTime(0.06, t + 3, 2.4); // in, then drawing back
      crest.gain.setTargetAtTime(0.07 * big, t + 1.8, 0.5); crest.gain.setTargetAtTime(0, t + 2.9, 1.2); // the break
      tWave = t + rnd2(7, 11);
    }
    while (tBub < lim) {
      let t = tBub;
      for (let k = 1 + (R() * R() * 5 | 0); k--;) { // smaller bubbles are higher and shorter
        const v = bub[nb++ % 3], f = rnd2(420, 1300), d = 0.05 + 40 / f;
        v.o.frequency.setValueAtTime(f, t); v.o.frequency.exponentialRampToValueAtTime(f * rnd2(1.4, 2.1), t + d);
        v.g.gain.setValueAtTime(0, t); v.g.gain.linearRampToValueAtTime(rnd2(0.02, 0.05), t + 0.008); v.g.gain.setTargetAtTime(0, t + 0.008, d / 4);
        t += rnd2(0.09, 0.25);
      }
      tBub = t + rnd2(2, 8);
    }
  };
}
// called on every click / key: starts the sound if it is switched on and the browser allows it by now
function sound() {
  if (muted) return;
  if (!AC) { AC = new AudioContext({ latencyHint: 'playback' }); const tick = mkSound(AC); tick(); setInterval(() => { if (AC.state === 'running') tick(); }, 1000); OUT.gain.setTargetAtTime(VOL, AC.currentTime, 1.5); }
  if (AC.state === 'suspended' && !document.hidden) AC.resume();
}
// the Sound setting: on / off. Off also stops the audio clock, so it costs nothing.
const mute = () => {
  muted = !muted;
  if (!muted) { sound(); OUT.gain.setTargetAtTime(VOL, AC.currentTime, 0.6); } else if (AC) { OUT.gain.setTargetAtTime(0, AC.currentTime, 0.15); setTimeout(() => { if (muted) AC.suspend(); }, 900); }
};
document.addEventListener('visibilitychange', () => { if (AC && !muted) document.hidden ? AC.suspend() : AC.resume(); });

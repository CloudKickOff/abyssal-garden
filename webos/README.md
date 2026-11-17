# Abyssal Garden for webOS TV

A WebGL2 port of [Abyssal Garden](../README.md), packaged as a webOS TV web app. It was written for an LG CX
(webOS TV 5, Chromium 68), which has WebGL2 but no WebGPU.

The world generator, camera path and collision are the original code from [`../source/src`](../source/src),
used unchanged. This folder replaces the renderer:

| File | What it is |
|---|---|
| [`src/shaders.js`](src/shaders.js) | The WGSL shaders translated to GLSL ES 3.00 |
| [`src/main.js`](src/main.js) | The WebGL2 renderer, plus TV remote input and the autopilot tour |
| [`src/quality.js`](src/quality.js) | Detail levels, with a new **TV** level below Low |
| [`template.html`](template.html) | The page, with CSS that Chromium 68 understands |

Not ported yet: the soundscape and anti-aliasing.

## Build

```bash
npm install
```

```bash
npm run build
```

This writes the app folder to `app/` and the installable package to `dist/com.abyssalgarden.webgl_0.1.0_all.ipk`.
`npm run build:readable` leaves the script unminified.

## Install on a rooted TV

Install the `.ipk` with whichever tool you already use: webOS Dev Manager, `ares-install`, or by hand over SSH.
By hand, copy it to the TV and ask the install service for it:

```bash
scp dist/com.abyssalgarden.webgl_0.1.0_all.ipk root@TV_ADDRESS:/tmp/
```

```bash
ssh root@TV_ADDRESS "luna-send -i luna://com.webos.appInstallService/dev/install '{\"id\":\"com.ares.defaultName\",\"ipkUrl\":\"/tmp/com.abyssalgarden.webgl_0.1.0_all.ipk\",\"subscribe\":true}'"
```

## Controls on the TV

| Remote | Does |
|---|---|
| Pointer | Look around: the view turns towards where you point, faster further from the middle |
| Up / Down | Swim forward / back |
| Left / Right | Turn |
| OK (or click) | Keep swimming forward; again to stop |
| Wheel, Channel up / down | Up / down |
| Red | Autopilot tour: one minute through the whole world, on a loop |
| Green | Next viewpoint |
| Yellow | Stats: frame rate, resolution, graphics chip |
| Blue | Swim faster |
| Back | Menu; from the menu, leaves the app |

## Try it on a computer

Serve `app/` from any web server and open it in Chrome. It uses keyboard and mouse as the original does
(plus `F` for the autopilot tour). Options in the address:

- `?tv` uses the TV level and the TV controls.
- `?lv=0` to `?lv=3` forces a detail level (High, Medium, Low, TV).
- `?bench` adds three console helpers: `bench(n)` draws `n` frames flat out and returns milliseconds per frame,
  `state()` returns the camera and input state, and `step(n, ms)` runs `n` frames by hand.

## How the TV level differs

It keeps one leaf, glint and pebble in eight, uses the Low level's coarser meshes and single-tap shadows, takes
8 light-shaft steps instead of 12, starts at 960×540 and aims for 30 fps rather than 60. Resolution and draw
distance still adjust themselves to hold that rate.

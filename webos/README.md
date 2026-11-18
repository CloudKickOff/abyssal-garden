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

Not ported: anti-aliasing. The soundscape is the original's, unchanged.

## Build

```bash
npm install
```

```bash
npm run build
```

This writes the app folder to `app/` and the installable package to `dist/com.abyssalgarden.webgl_0.1.0_all.ipk`.
`npm run build:readable` leaves the script unminified.

To have the TV skip world generation, generate the world on this computer first:

```bash
npm run bake
```

That opens the app in headless Chrome, saves the generated world as `world.bin` (about 70 MB) and rebuilds with it
packed in, which makes the package about 37 MB. Later `npm run build` runs keep packing it for as long as the
generator (`../source/src/math.js` and `world.js`) is unchanged.

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

The menu also has a row of buttons:

- **Screensaver** is animated. For each view along the tour path it draws everything that stands still (terrain,
  rocks, sponges, corals) once into a background, then every frame adds only what moves: kelp, fish, bubbles, the
  water surface and the light shafts, plus a pass that makes the light on the rocks ripple. On an LG CX that runs
  at about 15 frames a second at 1280×720 with full draw distance (about 9 at 1920×1080). A view stays for 40
  seconds. `Play` on the remote starts it too.
- **Stills** shows 1920×1080 pictures instead, each drawn in the background and faded in over the last (about one
  every ten seconds).

  Any key ends either one.
- **Sound** turns the soundscape on and off (`M` on a keyboard).
- **Measure speed** times the frame with each part left out in turn, and lists how long loading took.

While the app is open it tells webOS not to start its own screensaver.

## Try it on a computer

Serve `app/` from any web server and open it in Chrome. It uses keyboard and mouse as the original does
(plus `F` for the autopilot tour). Options in the address:

- `?tv` uses the TV level and the TV controls.
- `?lv=0` to `?lv=3` forces a detail level (High, Medium, Low, TV).
- `?bench` adds console helpers: `bench(n)` draws `n` frames flat out and returns milliseconds per frame,
  `state()` returns the camera and input state, and `step(n, ms)` runs `n` frames by hand.

## How the TV level differs

The LG CX has a Mali-G51 graphics chip, which is limited by triangle count as much as by pixels. The TV level:

- keeps one leaf in eight and then six kelp plants in ten, and thins rocks, sponges, corals, fish and glints further;
- sorts the boulders into the culling grid and gives them, the sponges and the far terrain coarser versions;
- uses a rock shader with 13 texture samples instead of 27, and 8 light-shaft steps instead of 12;
- renders at a fixed 640×360 with 40% draw distance, paced to a steady 12 frames a second (480×270 would hold
  15), and enlarges that picture itself onto a 1920×1080 canvas: edge smoothing (FXAA), then a bicubic filter with a little sharpening.
  The screensavers draw at 1280×720 or 1920×1080 with full draw distance instead.

Measured on the TV at 480×270, the scene takes about 55 ms a frame, down from 170 for the unmodified Low level.

## Loading

Generating the world takes nearly three minutes on the TV. There are two ways around it:

- **Baked world** (`npm run bake`, above): the whole world ships in the package and the TV only unpacks it. Measured
  on the LG CX, loading takes about 5 seconds.
- **Without it**, the app keeps the slow parts of the world it generated (plants, rocks, meshes, collision grid:
  about 35 MB) in IndexedDB after the first launch, and later launches take about 30 seconds. The terrain mesh is
  rebuilt every time, because a webOS app only gets 50 MB of storage.

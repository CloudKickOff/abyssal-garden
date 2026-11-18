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

Not ported: anti-aliasing. The sound is this port's own and off by default: a low rumble, slow waves and the odd
bubble, lighter and calmer than the original's soundscape, which stuttered on the TV.

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
| Yellow | Light colour: cool, warm, golden hour |
| Blue | Swim faster |
| Back | Menu; from the menu, leaves the app |

The menu also has a row of buttons:

- **Screensaver** is animated. For each view along the tour path it draws everything that stands still (terrain,
  rocks, sponges, corals) once into a background, then every frame adds only what moves: kelp, fish, bubbles, the
  water surface and the light shafts, plus a pass that makes the light on the rocks ripple. A view stays for 40
  seconds. `Play` on the remote starts it too.
- **Stills** shows 1920×1080 pictures instead, each drawn in the background and faded in over the last (about one
  every ten seconds). Any key ends either one.
- **Settings** opens a panel of sliders and switches, kept between launches. Left and right on the remote change
  the highlighted one:

  | Setting | What it does |
  |---|---|
  | Light shafts | Strength of the shafts of light, which also read as haze |
  | Warmth | From the original's blue towards a warmer white balance |
  | Golden hour | Lets the light drift to a warm late-afternoon colour and back every five minutes |
  | Life | How many of the fish, sharks, turtles and squid are drawn |
  | Sound | Rumble, waves and bubbles (off to begin with) |
  | Picture (TV) | 480×270 at 15 frames a second, 640×360 at 12, or 720×405 at 10 |
  | Draw distance (TV) | How far kelp and rocks are drawn |
  | Self-tuning (TV) | Lowers the draw distance when frames come late, and raises it again when they don't |
  | Sharpen when still (TV) | After a second at rest, redraws the view at 1280×720 the way the screensaver does (rocks and corals at full distance, kelp as far as before), at a steady 12 frames a second, until you move |
  | Stats line | Frame rate, resolution and graphics chip. It costs frames on a TV; leave it off except to check |

- **Measure speed** times the frame with each part left out in turn, and lists how long loading took.

## What lives there

Beyond the original's mantas and its fish (twice the size here, to be seen across a room, and each school painted as
a reef species: clownfish, yellow and blue tangs, royal gramma, parrotfish, a banded one, anthias; and each of the
original's twelve big schools split into three smaller shoals on paths of their own), this port adds sharks and
turtles on wide looping paths, and nine squid: one hanging in front of each numbered viewpoint and three beside the
tour path. Come within 7 m and one leaves a cloud of ink and darts away; half a minute later it swims back.

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
- draws sponges and corals to 45 m, shrinking away rather than popping;
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

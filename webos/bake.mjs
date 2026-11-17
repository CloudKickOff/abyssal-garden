// Generates the world on this computer and saves it as world.bin, which `npm run build` then packs into the app, so
// that the TV has nothing to generate (nearly three minutes there, a few seconds here).
//   npm run bake
// Builds the app, serves it on localhost, opens it in headless Chrome with ?tv&bake (the TV level; the page posts
// the world back, see main.js) and builds again with the world in it. Without Chrome it prints the address to open.
import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, statSync, mkdtempSync, rmSync, renameSync } from 'node:fs';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), app = path.join(here, 'app'), out = path.join(here, 'world.bin');
const build = () => execFileSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit' });
build();
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.png': 'image/png' };
let chrome, profile;
const done = (code) => { if (chrome) chrome.kill(); if (profile) rmSync(profile, { recursive: true, force: true }); server.close(); if (!code) build(); process.exit(code); };
const server = createServer((q, r) => {
  const url = q.url.split('?')[0];
  if (q.method === 'POST' && url === '/world') {
    const w = createWriteStream(out + '.part'); q.pipe(w);
    w.on('finish', () => { renameSync(out + '.part', out); r.end('ok'); console.log(`world.bin: ${(statSync(out).size / 1048576).toFixed(1)} MB`); setTimeout(done, 300, 0); });
    return;
  }
  const f = path.join(app, url === '/' ? 'index.html' : path.normalize(url).replace(/^[/\\]+/, ''));
  if (!f.startsWith(app) || !existsSync(f) || !statSync(f).isFile()) { r.writeHead(404).end(); return; }
  r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); createReadStream(f).pipe(r);
});
server.listen(0, '127.0.0.1', () => {
  const page = `http://localhost:${server.address().port}/index.html?tv&bake`;
  const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find((b) => !spawnSync('which', [b]).status);
  if (bin) {
    profile = mkdtempSync(path.join(tmpdir(), 'abyssal-bake-'));
    chrome = spawn(bin, ['--headless=new', '--no-first-run', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--user-data-dir=${profile}`, page], { stdio: 'ignore' });
    console.log(`Generating the world in headless ${bin}…`);
  } else console.log(`No Chrome found. Open this address in a WebGL2 browser on this computer to generate the world:\n  ${page}`);
  setTimeout(() => { console.error('No world arrived within 10 minutes.'); done(1); }, 6e5);
});

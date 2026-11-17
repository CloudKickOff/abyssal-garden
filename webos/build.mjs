// Builds the WebGL2 port into app/ (a webOS web app folder) and packs it as dist/<id>_<version>_all.ipk
//   npm run build            minified
//   npm run build:readable   unminified, for debugging
// The world generator, the maths and the soundscape come unchanged from ../source/src; quality, shaders and main are
// this port's.
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url)), up = path.join(here, '..', 'source', 'src');
const FILES = [path.join(here, 'src', 'quality.js'), path.join(up, 'math.js'), path.join(here, 'src', 'shaders.js'), path.join(up, 'world.js'), path.join(here, 'src', 'main.js'), path.join(up, 'audio.js')]; // order matters
const readable = process.argv.includes('--readable');
const TARGET = 'chrome68'; // the web engine of webOS TV 5

const src = FILES.map((f) => readFileSync(f, 'utf8')).join('\n');
// BUILD names the generator (math.js + world.js): the world saved on the device (main.js) is reused only by builds
// with the same one. Generation code in main.js and the density shader are covered by WORLDV in main.js instead.
const BUILD = createHash('sha1').update(readFileSync(FILES[1])).update(readFileSync(FILES[3])).digest('hex').slice(0, 12);
const js = `const BUILD = '${BUILD}';\n` + src;
const tpl = readFileSync(path.join(here, 'template.html'), 'utf8');
// everything runs inside one async function; startup errors are shown on screen
const wrap = (body) => `(async()=>{${body}\n})().catch(e=>{console.error(e);document.body.className='l e';document.getElementById('s').textContent=(e.cause?'':'Failed to start: ')+e.message});`;
const code = transformSync(wrap(js), { minify: !readable, target: TARGET, legalComments: 'none' }).code.trim();
let html = tpl;
if (!readable) html = html.replace(/<style>([^]*?)(?=<\/style>)/, (_, s) => '<style>' + transformSync(s, { loader: 'css', minify: true, target: TARGET }).code.trim()).replace(/>\s+</g, '><');
html = html.replace('/*SCRIPT*/', () => code);

const app = path.join(here, 'app'), dist = path.join(here, 'dist');
mkdirSync(app, { recursive: true }); mkdirSync(dist, { recursive: true });
writeFileSync(path.join(app, 'index.html'), html);
const PACK = ['index.html', 'appinfo.json', 'icon.png', 'largeIcon.png'];
for (const f of PACK.slice(1)) copyFileSync(path.join(here, f), path.join(app, f));
// world.bin (npm run bake): the generated world, packed too if this build's generator made it (it starts with the
// length of a JSON text whose "key" is BUILD:WORLDV:level)
rmSync(path.join(app, 'world.bin'), { force: true });
const world = path.join(here, 'world.bin');
if (existsSync(world)) {
  const fd = openSync(world, 'r'), head = Buffer.alloc(256); readSync(fd, head, 0, 256, 0); closeSync(fd);
  const key = (/"key":"([^"]*)"/.exec(head.toString('latin1', 8)) || [])[1], want = `${BUILD}:${/const WORLDV = (\d+)/.exec(src)[1]}:3`;
  if (key === want) { copyFileSync(world, path.join(app, 'world.bin')); PACK.push('world.bin'); console.log(`app/world.bin: ${(statSync(world).size / 1048576).toFixed(1)} MB`); }
  else console.log(`world.bin is from another generator (${key}, this one is ${want}): left out. Run \`npm run bake\` again.`);
}
console.log(`app/index.html: ${(html.length / 1024).toFixed(1)} kB${readable ? ' (readable)' : ''}`);

// ---------------------------------------------------------------- .ipk
// An ar archive of debian-binary, control.tar.gz and data.tar.gz, laid out the way webOS's ares-package does it:
// the app under usr/palm/applications/<id>, a packageinfo.json under usr/palm/packages/<id>.
const info = JSON.parse(readFileSync(path.join(here, 'appinfo.json'), 'utf8')), id = info.id;
const tmp = path.join(tmpdir(), `abyssal-ipk-${process.pid}`);
rmSync(tmp, { recursive: true, force: true });
const appDir = path.join(tmp, 'data', 'usr', 'palm', 'applications', id), pkgDir = path.join(tmp, 'data', 'usr', 'palm', 'packages', id);
mkdirSync(appDir, { recursive: true }); mkdirSync(pkgDir, { recursive: true }); mkdirSync(path.join(tmp, 'control'));
let size = 0;
for (const f of PACK) { copyFileSync(path.join(app, f), path.join(appDir, f)); size += statSync(path.join(app, f)).size; }
writeFileSync(path.join(pkgDir, 'packageinfo.json'), JSON.stringify({ app: id, id, loc_name: info.title, package_format_version: 2, vendor: info.vendor, version: info.version }, null, 2) + '\n');
writeFileSync(path.join(tmp, 'control', 'control'), [`Package: ${id}`, `Version: ${info.version}`, 'Section: misc', 'Priority: optional', 'Architecture: all',
  `Installed-Size: ${size}`, 'Maintainer: N/A <nobody@example.com>', 'Description: Abyssal Garden, a procedural underwater world', 'webOS-Package-Format-Version: 2', 'webOS-Packager-Version: x.y.x', ''].join('\n'));
writeFileSync(path.join(tmp, 'debian-binary'), '2.0\n');
const tar = (dir, out) => execFileSync('tar', ['--owner=0', '--group=0', '--numeric-owner', '-czf', out, '-C', dir, '.']);
tar(path.join(tmp, 'control'), path.join(tmp, 'control.tar.gz')); tar(path.join(tmp, 'data'), path.join(tmp, 'data.tar.gz'));
const parts = [Buffer.from('!<arch>\n')];
for (const n of ['debian-binary', 'control.tar.gz', 'data.tar.gz']) {
  const d = readFileSync(path.join(tmp, n));
  parts.push(Buffer.from(n.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '100644'.padEnd(8) + String(d.length).padEnd(10) + '`\n'), d);
  if (d.length & 1) parts.push(Buffer.from('\n'));
}
const ipk = path.join(dist, `${id}_${info.version}_all.ipk`);
writeFileSync(ipk, Buffer.concat(parts));
rmSync(tmp, { recursive: true, force: true });
console.log(`dist/${path.basename(ipk)}: ${(statSync(ipk).size / 1048576).toFixed(2)} MB`);

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const paths = {
  '/': ['index.html', 'text/html'], '/event.json': ['event.json', 'application/json'],
  '/style.css': ['style.css', 'text/css'], '/art.svg': ['art.svg', 'image/svg+xml'],
  '/app.mjs': ['app.mjs', 'text/javascript'], '/model.mjs': ['model.mjs', 'text/javascript'],
};
const assets = Object.fromEntries(Object.entries(paths).map(([path, [file, type]]) =>
  [path, [type, readFileSync(new URL(`./dist/${file}`, import.meta.url), 'utf8')]]));
const source = readFileSync(new URL('./site-worker.mjs', import.meta.url), 'utf8');
const dist = new URL('./dist/server/', import.meta.url);
mkdirSync(dist, { recursive: true });
writeFileSync(new URL('index.js', dist), `const assets = ${JSON.stringify(assets)};\n${source}`);

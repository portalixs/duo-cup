import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const paths = {
  '/': ['index.html', 'text/html'], '/event.json': ['event.json', 'application/json'],
  '/style.css': ['style.css', 'text/css'], '/art.svg': ['art.svg', 'image/svg+xml'],
  '/control.css': ['control.css', 'text/css'], '/archivo-black-license.txt': ['archivo-black-license.txt', 'text/plain'],
  '/app.mjs': ['app.mjs', 'text/javascript'], '/model.mjs': ['model.mjs', 'text/javascript'],
  '/control': ['control.html', 'text/html'], '/control.mjs': ['control.mjs', 'text/javascript'],
};
const assets = Object.fromEntries(Object.entries(paths).map(([path, [file, type]]) =>
  [path, [type, readFileSync(new URL(`./dist/${file}`, import.meta.url), 'utf8')]]));
for (const [file, type] of [['arena.webp', 'image/webp'], ['archivo-black.woff2', 'font/woff2']]) {
  assets[`/${file}`] = [type, readFileSync(new URL(`./dist/${file}`, import.meta.url)).toString('base64'), true];
}
const source = readFileSync(new URL('./site-worker.mjs', import.meta.url), 'utf8');
const model = readFileSync(new URL('./dist/model.mjs', import.meta.url), 'utf8');
const reducer = readFileSync(new URL('./tournament-control.mjs', import.meta.url), 'utf8').split('\n').slice(1).join('\n');
const bridge = readFileSync(new URL('./observer-bridge.mjs', import.meta.url), 'utf8').split('\n').slice(1).join('\n');
const dist = new URL('./dist/server/', import.meta.url);
mkdirSync(dist, { recursive: true });
writeFileSync(new URL('index.js', dist), `const assets = ${JSON.stringify(assets)};\n${model}\n${reducer}\n${bridge}\n${source}`);

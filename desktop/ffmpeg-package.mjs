import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const release = 'autobuild-2026-11-01-12-49';
const archiveFolder = 'ffmpeg-n9.0.2-42-gd7643a0fe3-win64-lgpl-shared-9.0';
const archiveName = `${archiveFolder}.zip`;
const archiveUrl = `https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/${release}/${archiveName}`;
const archiveHash = 'dd3d3791e1d9fe7bca2e62a4c2c916cebe6b46d21cc6b5e3706eb975a1bfe2d4';
const gplUrl = 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/d7643a0fe3f4f65516c302eba045ba884faed015/COPYING.GPLv3';
const gplHash = '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903';
const libraries = [
  'avcodec-63.dll', 'avdevice-63.dll', 'avfilter-12.dll', 'avformat-63.dll', 'avutil-61.dll',
  'swresample-7.dll', 'swscale-10.dll',
];

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(path, url, expectedHash) {
  const cached = await sha256(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (cached === expectedHash) return;
  const temporary = `${path}.${process.pid}.part`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(240_000) });
    if (!response.ok || !response.body) throw new Error(`Не удалось скачать FFmpeg. HTTP ${response.status}.`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    if (await sha256(temporary) !== expectedHash) throw new Error('Контрольная сумма файла FFmpeg не совпадает.');
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function prepareWindowsFfmpeg(cacheDir) {
  await mkdir(cacheDir, { recursive: true });
  const archive = join(cacheDir, archiveName);
  const gpl = join(cacheDir, 'FFmpeg-GPLv3.txt');
  await Promise.all([download(archive, archiveUrl, archiveHash), download(gpl, gplUrl, gplHash)]);
  const binaries = ['ffmpeg.exe', ...libraries];
  await run(join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe'), [
    '-xf', archive, '-C', cacheDir, `${archiveFolder}/LICENSE.txt`, ...binaries.map(name => `${archiveFolder}/bin/${name}`),
  ], { windowsHide: true, timeout: 30_000 });
  const unpacked = join(cacheDir, archiveFolder);
  const bin = join(unpacked, 'bin');
  const license = join(unpacked, 'LICENSE.txt');
  await Promise.all([...binaries.map(name => access(join(bin, name))), access(license)]);
  return { bin, binaries, license, gpl };
}

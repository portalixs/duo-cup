import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const seconds = milliseconds => (milliseconds / 1000).toFixed(3);

export function createReplayTrimmer({ executable, directory }) {
  return async (inputPath, { start, duration }) => {
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0) {
      throw new RangeError('Некорректные границы клипа повтора');
    }
    await mkdir(directory, { recursive: true });
    const path = join(directory, `duo-cup-replay-${randomUUID()}.mp4`);
    const cleanup = () => rm(path, { force: true, maxRetries: 3, retryDelay: 80 });
    try {
      await run(executable, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
        '-ss', seconds(start), '-i', inputPath, '-t', seconds(duration), '-map', '0:v:0',
        '-an', '-sn', '-dn', '-vf', 'setpts=PTS-STARTPTS', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-threads', '4', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path],
      { timeout: 3500, windowsHide: true, maxBuffer: 64 * 1024 });
      return { path, cleanup };
    } catch (error) {
      await cleanup().catch(() => {});
      throw error;
    }
  };
}

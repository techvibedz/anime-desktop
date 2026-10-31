import { app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ScrapeJob } from './host';

export function startWindowsBrowserJob(job: ScrapeJob, slot: number) {
  if (process.platform !== 'win32') return null;
  const executable = path.join(app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../../../build'), 'provider-browser/ProviderBrowser.exe');
  if (!fs.existsSync(executable)) return null;
  const child = spawn(executable, [job.url, path.join(app.getPath('userData'), `browser-${slot}`)], { windowsHide: true });
  child.stderr.resume();
  const promise = new Promise<unknown>((resolve, reject) => {
    // One JSON message per line: any number of {pantoufaProgress} lines, then
    // the final {pantoufaResult}.
    let buffer = '';
    let total = 0;
    let result: unknown = null;
    const onLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line);
        if (message && 'pantoufaProgress' in message) {
          try { job.onProgress?.(message.pantoufaProgress); } catch {}
        } else if (message && 'pantoufaResult' in message) result = message.pantoufaResult;
      } catch {}
    };
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      total += text.length;
      if (total > 8 * 1024 * 1024) { child.kill(); reject(Error('provider browser result too large')); return; }
      buffer += text;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.on('error', reject);
    child.on('close', () => {
      onLine(buffer);
      resolve(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(job) + '\n');
  });
  return { promise, cancel: () => child.kill() };
}

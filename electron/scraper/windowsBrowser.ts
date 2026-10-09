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
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 4 * 1024 * 1024) { child.kill(); reject(Error('provider browser result too large')); }
    });
    child.on('error', reject);
    child.on('close', () => {
      try { resolve(JSON.parse(output).pantoufaResult); } catch { resolve(null); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(job) + '\n');
  });
  return { promise, cancel: () => child.kill() };
}

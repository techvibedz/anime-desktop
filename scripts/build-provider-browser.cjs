const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

async function main() {
  if (process.platform !== 'win32') return;
  const version = '1.0.4258.31';
  const hash = '56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9';
  const cache = path.join(os.tmpdir(), `pantoufa-webview2-${version}`);
  const zip = path.join(cache, 'sdk.zip');
  fs.mkdirSync(cache, { recursive: true });
  if (!fs.existsSync(zip)) {
    const response = await fetch(`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${version}/microsoft.web.webview2.${version}.nupkg`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error(`WebView2 SDK HTTP ${response.status}`);
    fs.writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
  }
  if (createHash('sha256').update(fs.readFileSync(zip)).digest('hex') !== hash) throw Error('WebView2 SDK integrity check failed');
  const sdk = path.join(cache, 'sdk');
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  if (!fs.existsSync(path.join(sdk, 'LICENSE.txt'))) execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(sdk)} -Force`], { windowsHide: true });
  const out = path.resolve('build/provider-browser');
  fs.mkdirSync(out, { recursive: true });
  for (const file of ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll']) fs.copyFileSync(path.join(sdk, 'lib/net462', file), path.join(out, file));
  fs.copyFileSync(path.join(sdk, 'runtimes/win-x64/native/WebView2Loader.dll'), path.join(out, 'WebView2Loader.dll'));
  for (const file of ['LICENSE.txt', 'NOTICE.txt']) fs.copyFileSync(path.join(sdk, file), path.join(out, file));
  const csc = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:ProviderBrowser.exe', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', '/reference:Microsoft.Web.WebView2.Core.dll', '/reference:Microsoft.Web.WebView2.WinForms.dll', path.resolve('native/ProviderBrowser.cs')], { cwd: out, stdio: 'inherit', windowsHide: true });
  console.log('Built provider browser with the pinned Microsoft WebView2 SDK');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

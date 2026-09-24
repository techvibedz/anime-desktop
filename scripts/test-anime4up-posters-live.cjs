const assert = require('node:assert/strict');
const { app, session, BrowserWindow, protocol } = require('electron');

const paths = [
  '/wp-content/uploads/2026/07/Otome-Game-Sekai-wa-Mob-ni-Kibishii-Sekai-desu-2.jpg',
  '/wp-content/uploads/2026/04/rftfgjfgh.jpg',
  '/wp-content/uploads/2026/07/Youjo-Senki-II.png',
  '/wp-content/uploads/2026/07/Clevatess-II-Majuu-no-Ou-to-Itsuwari-no-Yuusha-Denshou.jpg',
  '/wp-content/uploads/2026/07/Sora-wa-Akai-Kawa-no-Hotori.jpg',
];
protocol.registerSchemesAsPrivileged([{ scheme: 'pantoufa-poster', privileges: { standard: true, secure: true } }]);
app.whenReady().then(async () => {
  app.configureHostResolver({
    secureDnsMode: 'secure',
    secureDnsServers: ['https://dns.google/dns-query', 'https://cloudflare-dns.com/dns-query', 'https://dns.quad9.net/dns-query'],
  });
  protocol.handle('pantoufa-poster', async (request) => {
    const path = new URL(request.url);
    const response = await fetch(`https://w1.anime4up.rest${path.pathname}${path.search}`, {
      headers: { Referer: 'https://w1.anime4up.rest/' },
      signal: AbortSignal.timeout(8000),
    });
    return new Response(response.body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'image/jpeg' } });
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const parsed = new URL(details.url);
    if (details.resourceType === 'image' && parsed.hostname === 'w1.anime4up.rest') {
      callback({ redirectURL: `pantoufa-poster://anime4up${parsed.pathname}${parsed.search}` });
      return;
    }
    callback({});
  });
  const win = new BrowserWindow({ show: false });
  try {
    await win.loadURL('about:blank');
    const results = await win.webContents.executeJavaScript(`Promise.all(${JSON.stringify(paths)}.map(path => new Promise(resolve => {
      const img = new Image();
      const t = setTimeout(() => resolve('timeout'), 10000);
      img.onload = () => { clearTimeout(t); resolve(img.naturalWidth > 0 ? 'loaded' : 'empty'); };
      img.onerror = () => { clearTimeout(t); resolve('error'); };
      img.src = 'https://w1.anime4up.rest' + path;
    })))`);
    assert.deepEqual(results, paths.map(() => 'loaded'));
    console.log(`PASS ${results.length} Anime4up posters loaded through the image route`);
  } finally {
    win.destroy();
    app.quit();
  }
}).catch((error) => { console.error(error); app.exit(1); });

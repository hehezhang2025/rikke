/* 日课 Service Worker —— 让 App 安装到桌面后离线可用 */
const CACHE = 'rikke-v5';   /* 每次改动 index.html 记得 +1，否则手机上会一直用旧缓存 */
const ASSETS = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS).catch(() => null))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   /* 只管自己的资源，不碰外部请求 */

  /* 页面：优先网络（保证能拿到新版本），断网时回退缓存 */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(ch => ch.put('./index.html', copy)).catch(() => {});
        return r;
      }).catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  /* 静态资源：缓存优先 */
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r && r.status === 200 && r.type === 'basic') {
        const copy = r.clone();
        caches.open(CACHE).then(ch => ch.put(req, copy)).catch(() => {});
      }
      return r;
    }).catch(() => hit))
  );
});

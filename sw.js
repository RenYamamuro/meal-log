// オフラインでも開けるようにするための Service Worker（LIFT LOG と同じ方式）。
// ネットワーク優先（online なら常に最新を取りに行く）＋ 失敗したらキャッシュを返す。
const CACHE = "meal-log-cache-v13";
const ASSETS = ["./", "./index.html", "./firebase-sync.js", "./photo-ai.js", "./manifest.json",
                "./fonts/nunito-latin.woff2", "./fonts/mplus.css",
                "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  // Firebase など外部ドメインへの通信には触らない（キャッシュすると認証が壊れる）
  if (new URL(event.request.url).origin !== location.origin) return;
  // GitHub Pages は max-age=600 を返すので、HTML/JS/JSON はHTTPキャッシュを迂回して取りに行く
  const path = new URL(event.request.url).pathname;
  const isCode = event.request.mode === "navigate" || /\.(html|js|json)$/.test(path) || path.endsWith("/");
  const request = isCode ? new Request(event.request, { cache: "reload" }) : event.request;

  event.respondWith(
    fetch(request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request).then(hit => hit || caches.match("./index.html")))
  );
});

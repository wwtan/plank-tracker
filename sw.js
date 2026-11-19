const CACHE = "plank-tracker-v3";
const FILES = ["./", "./index.html", "./styles.css", "./app.js", "./timer.js", "./manifest.webmanifest", "./icon.svg"];
const URLS = new Set(FILES.map(path => new URL(path, self.registration.scope).href));

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith("plank-tracker-") && key !== CACHE).map(key => caches.delete(key))
  )));
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const normalised = new URL(url.pathname, url.origin).href;
  if (!URLS.has(normalised)) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(normalised);
    return cached || fetch(event.request);
  }));
});

// Keeps SliceWatch working offline once installed. Bump VERSION when files change.
const VERSION = "slicewatch-v2.2.1";
const FILES = [
  "./", "index.html", "styles.css", "app.js", "assist.js", "scrub.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png",
  "vendor/anthropic-sdk.js", "vendor/tesseract/tesseract.min.js", "vendor/tesseract/worker.min.js",
  "vendor/tesseract/core/tesseract-core-lstm.wasm.js", "vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js",
  "vendor/tesseract/lang/eng.traineddata.gz",
];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;   // API calls go straight to the network
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});

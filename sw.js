// Service worker: offline-first app shell for the miles tracker.
//
// Strategy:
// - Navigations (index.html): network-first so a deploy is picked up on the
//   next online load, falling back to cache when offline.
// - Everything else (CSS/JS/icons/fonts): stale-while-revalidate — served
//   from cache instantly, refreshed in the background, so edits to app files
//   propagate one load later without any cache-version discipline.
const CACHE = "ascent-shell-v1";
const SHELL = [
    "./",
    "./index.html",
    "./style.css",
    "./script.js",
    "./manifest.json",
    "./icon-192.png",
    "./icon-512.png",
    "./apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;

    // Navigations: network-first, cached shell as offline fallback
    if (req.mode === "navigate") {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    const copy = res.clone();
                    caches.open(CACHE).then((cache) => cache.put("./index.html", copy));
                    return res;
                })
                .catch(() => caches.match("./index.html"))
        );
        return;
    }

    // Assets (incl. Google Fonts): stale-while-revalidate
    event.respondWith(
        caches.match(req).then((cached) => {
            const refresh = fetch(req)
                .then((res) => {
                    if (res && (res.ok || res.type === "opaque")) {
                        const copy = res.clone();
                        caches.open(CACHE).then((cache) => cache.put(req, copy));
                    }
                    return res;
                })
                .catch(() => cached);
            return cached || refresh;
        })
    );
});

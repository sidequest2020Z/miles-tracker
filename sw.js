// Self-destructing service worker. Ascent no longer uses a SW; this exists so
// browsers holding the old offline-shell worker clean it up on their next visit.
// Safe to leave deployed indefinitely.
self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
        await self.registration.unregister();
        const clients = await self.clients.matchAll({ type: "window" });
        clients.forEach((client) => client.navigate(client.url));
    })());
});

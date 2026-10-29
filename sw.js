const CACHE_NAME = "carretillas-l1-v13";
const APP_SHELL = [
  "./",
  "index.html",
  "manifest.json",
  "icon-192.png",
  "icon-512.png"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      try {
        await cache.addAll(APP_SHELL);
      } catch (err) {
        console.warn("Service worker cache error:", err);
      }
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("carretillas-l1-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;

      if (request.mode === "navigate") {
        return caches.match("./index.html");
      }

      return Response.error();
    }
  })());
});

// Avisos de cuadrante nuevo (los envía la función "cuadrante" de Supabase al publicar).
self.addEventListener("push", (event) => {
  let aviso = {};
  try {
    aviso = event.data ? event.data.json() : {};
  } catch {
    aviso = { body: event.data?.text() };
  }
  event.waitUntil(self.registration.showNotification(aviso.title || "Carretillas L1", {
    body: aviso.body || "",
    icon: "icon-192.png",
    tag: "cuadrante",
    renotify: true,
    data: { url: aviso.url || "./" }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destino = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({ type:"window", includeUncontrolled:true });
    const abierta = ventanas.find((v) => v.url.startsWith(self.registration.scope));
    if (abierta) {
      abierta.postMessage({ type:"ABRIR", url:destino });
      return abierta.focus();
    }
    return self.clients.openWindow(destino);
  })());
});

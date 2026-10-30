// Súbela en cada cambio: es la versión que se ve en el menú y la que hace que los móviles se actualicen.
const VERSION = 20;
const CACHE_NAME = `carretillas-l1-v${VERSION}`;
// Va aparte (sin el prefijo de versión) para que no se borre al actualizar la app.
const FOTOS_CACHE = "cl1-fotos-fichas";
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
  if (event.data?.type === "VERSION") event.source?.postMessage({ type:"VERSION", version:VERSION });
});

// Con mala cobertura no se hace esperar: si la red tarda más de esto, se abre con la copia guardada.
const ESPERA_RED = 2500;

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Fotos de las fichas de faena (Supabase): nunca cambian, así que se guardan la primera vez
  // y después se sirven de la copia, aunque no haya cobertura.
  if (url.hostname.endsWith(".supabase.co") && url.pathname.startsWith("/storage/v1/object/public/fichas/")) {
    event.respondWith((async () => {
      const cache = await caches.open(FOTOS_CACHE);
      const copia = await cache.match(request);
      if (copia) return copia;
      const respuesta = await fetch(request);
      if (respuesta.ok || respuesta.type === "opaque") await cache.put(request, respuesta.clone());
      return respuesta;
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Se pide siempre a la red y se guarda la copia, aunque ya se haya respondido con la guardada.
  const deRed = fetch(request).then(async (response) => {
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  });
  event.waitUntil(deRed.catch(() => {}));

  const guardada = async () => {
    const copia = await caches.match(request, { ignoreSearch: request.mode === "navigate" });
    if (copia || request.mode !== "navigate") return copia;
    return caches.match("./index.html");
  };

  event.respondWith((async () => {
    try {
      const tarde = new Promise((resolve) => setTimeout(resolve, ESPERA_RED, "tarde"));
      const primera = await Promise.race([deRed, tarde]);
      if (primera !== "tarde") return primera;
      return (await guardada()) || await deRed;
    } catch {
      return (await guardada()) || Response.error();
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

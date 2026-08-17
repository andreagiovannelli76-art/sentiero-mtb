// sw.js — service worker: mette in cache il guscio dell'app.
//
// ATTENZIONE alla procedura di release: a ogni pubblicazione va incrementato N in
// "sentiero-vN", altrimenti i dispositivi continuano a servire la versione vecchia.

const V = "sentiero-v4";

const SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/geo.js",
  "./js/gpx.js",
  "./js/db.js",
  "./js/profile.js",
  "./js/tracker.js",
  "./js/share.js",
  "./js/elevation.js",
  "./js/osm.js",
  "./manifest.webmanifest",
  // Icone e percorso demo: senza questi, al primo avvio offline mancano
  // l'icona della PWA e l'unico percorso con cui provare l'app.
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./data/monte-ascensione.gpx",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(V)
      // addAll fallisce in blocco se manca un file: si aggiunge uno per uno.
      .then((cache) => Promise.all(SHELL.map((u) => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((chiavi) => Promise.all(chiavi.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Tile della mappa, Overpass, Open-Elevation e analytics: sempre dalla rete.
  // Sono dati vivi o pesanti, non hanno senso nella cache del guscio.
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/_vercel/")) return;

  // Navigazione: prima la rete, così un aggiornamento arriva subito;
  // se si è offline si serve il guscio in cache.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((risposta) => {
          const copia = risposta.clone();
          caches.open(V).then((c) => c.put("./index.html", copia));
          return risposta;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Tutto il resto: prima la cache, poi la rete.
  e.respondWith(
    caches.match(req).then(
      (colpo) =>
        colpo ||
        fetch(req).then((risposta) => {
          if (risposta.ok && risposta.type === "basic") {
            const copia = risposta.clone();
            caches.open(V).then((c) => c.put(req, copia));
          }
          return risposta;
        })
    )
  );
});

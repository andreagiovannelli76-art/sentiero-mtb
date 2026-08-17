// osm.js — ricerca di percorsi ciclabili già mappati su OpenStreetMap, via Overpass.
// Si cercano le relazioni route=mtb e le ciclabili locali/regionali (route=bicycle, network lcn/rcn).

import { haversine, lunghezza } from "./geo.js";

// Più mirror: se il primo è sovraccarico si passa al successivo.
const ENDPOINT = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Tolleranza in metri per considerare due estremi di way come lo stesso punto.
const TOLLERANZA_GIUNZIONE = 30;

// Cerca percorsi entro `raggio` metri da (lat, lon).
// Ritorna un array di { id, nome, tipo, rete, punti, distanza, frammentato }.
export async function cercaPercorsi(lat, lon, raggio = 8000) {
  const query = `[out:json][timeout:60];
(
  relation(around:${Math.round(raggio)},${lat.toFixed(5)},${lon.toFixed(5)})["route"="mtb"];
  relation(around:${Math.round(raggio)},${lat.toFixed(5)},${lon.toFixed(5)})["route"="bicycle"]["network"~"lcn|rcn"];
);
out body geom;`;
// "body" e non "tags": tags stampa id e tag ma OMETTE i membri della relazione,
// e senza membri non arriva nessuna geometria da cui ricavare la traccia.

  const dati = await interroga(query);
  const elementi = (dati && dati.elements) || [];

  const percorsi = [];
  for (const rel of elementi) {
    if (rel.type !== "relation") continue;

    const segmenti = (rel.members || [])
      .filter((m) => m.type === "way" && Array.isArray(m.geometry) && m.geometry.length > 1)
      .map((m) => m.geometry.map((g) => ({ lat: g.lat, lon: g.lon })));

    if (!segmenti.length) continue;

    const { punti, frammentato } = concatena(segmenti);
    if (punti.length < 2) continue;

    const tags = rel.tags || {};
    percorsi.push({
      id: `osm_${rel.id}`,
      nome: tags.name || tags.ref || `Percorso OSM ${rel.id}`,
      tipo: tags.route === "mtb" ? "MTB" : "Ciclabile",
      rete: (tags.network || "").toUpperCase(),
      punti,
      distanza: lunghezza(punti),
      frammentato,
      fonte: "OpenStreetMap",
      url: `https://www.openstreetmap.org/relation/${rel.id}`,
    });
  }

  // I giri più corti in cima: sono quelli percorribili in giornata.
  return percorsi.sort((a, b) => a.distanza - b.distanza);
}

async function interroga(query) {
  let ultimoErrore = null;

  for (const url of ENDPOINT) {
    try {
      const risposta = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });

      if (risposta.status === 429 || risposta.status === 504) {
        ultimoErrore = new Error("Overpass è sovraccarico in questo momento.");
        continue;
      }
      if (!risposta.ok) {
        ultimoErrore = new Error(`Overpass ha risposto ${risposta.status}.`);
        continue;
      }
      return await risposta.json();
    } catch (e) {
      ultimoErrore = e;
    }
  }

  throw ultimoErrore || new Error("Overpass non raggiungibile.");
}

// Unisce le way di una relazione in un'unica polilinea.
// Le way arrivano in ordine arbitrario e con verso arbitrario: si concatenano
// accostando gli estremi più vicini. Se restano salti, il percorso è frammentato.
function concatena(segmenti) {
  const liberi = segmenti.map((s) => s.slice());
  let catena = liberi.shift();
  let frammentato = false;

  while (liberi.length) {
    const coda = catena[catena.length - 1];
    const testa = catena[0];

    let migliore = null;
    for (let i = 0; i < liberi.length; i++) {
      const s = liberi[i];
      const opzioni = [
        { i, d: haversine(coda, s[0]), inFondo: true, inverti: false },
        { i, d: haversine(coda, s[s.length - 1]), inFondo: true, inverti: true },
        { i, d: haversine(testa, s[s.length - 1]), inFondo: false, inverti: false },
        { i, d: haversine(testa, s[0]), inFondo: false, inverti: true },
      ];
      for (const o of opzioni) {
        if (!migliore || o.d < migliore.d) migliore = o;
      }
    }

    const s = liberi.splice(migliore.i, 1)[0];
    const pezzo = migliore.inverti ? s.slice().reverse() : s;

    if (migliore.d > TOLLERANZA_GIUNZIONE) frammentato = true;

    if (migliore.inFondo) {
      // Si evita di ripetere il punto di giunzione.
      catena = catena.concat(migliore.d <= TOLLERANZA_GIUNZIONE ? pezzo.slice(1) : pezzo);
    } else {
      const testaPezzo = migliore.d <= TOLLERANZA_GIUNZIONE ? pezzo.slice(0, -1) : pezzo;
      catena = testaPezzo.concat(catena);
    }
  }

  return { punti: catena, frammentato };
}

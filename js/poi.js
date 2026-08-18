// poi.js — cosa si incontra lungo il percorso: acqua e ricoveri.
//
// Sono dati già presenti in OpenStreetMap. Si chiedono a Overpass con un
// (around:) sulla traccia semplificata: cercare attorno a ogni punto di una
// traccia da migliaia di punti sarebbe una query che nessun servizio pubblico
// accetterebbe.

import { douglasPeucker, haversine, progressive } from "./geo.js";

const ENDPOINT = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Quanto lontano dalla traccia si accetta un punto: oltre, è una deviazione
// che in bici non fai.
const RAGGIO = 150;

const ETICHETTE = {
  drinking_water: "acqua potabile",
  water_point: "acqua",
  spring: "sorgente",
  shelter: "ricovero",
  alpine_hut: "rifugio",
  wilderness_hut: "bivacco",
  picnic_site: "area picnic",
  viewpoint: "punto panoramico",
};

// Ritorna [{ nome, tipo, lat, lon, dopo }] ordinati per posizione lungo il
// percorso: "dopo" sono i metri dalla partenza, cioè quando lo incontri.
export async function cercaPunti(punti) {
  if (!punti || punti.length < 2) return [];

  // Una traccia semplificata a 40 punti descrive comunque dove passi.
  const scheletro = campiona(douglasPeucker(punti, 60), 40);
  const linea = scheletro.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(",");

  const query = `[out:json][timeout:60];
(
  node(around:${RAGGIO},${linea})["amenity"~"^(drinking_water|water_point|shelter)$"];
  node(around:${RAGGIO},${linea})["natural"="spring"];
  node(around:${RAGGIO},${linea})["tourism"~"^(alpine_hut|wilderness_hut|picnic_site|viewpoint)$"];
);
out body;`;

  const dati = await interroga(query);
  const elementi = (dati && dati.elements) || [];

  const dist = progressive(punti);
  const trovati = [];

  for (const el of elementi) {
    if (typeof el.lat !== "number" || typeof el.lon !== "number") continue;
    const tags = el.tags || {};
    const chiave = tags.amenity || tags.natural || tags.tourism;
    const tipo = ETICHETTE[chiave];
    if (!tipo) continue;

    const vicino = puntoPiuVicino(punti, el);
    if (vicino.scarto > RAGGIO) continue;

    trovati.push({
      nome: tags.name || "",
      tipo,
      lat: el.lat,
      lon: el.lon,
      dopo: dist[vicino.indice],
      scarto: Math.round(vicino.scarto),
    });
  }

  return trovati.sort((a, b) => a.dopo - b.dopo);
}

function campiona(punti, quanti) {
  if (punti.length <= quanti) return punti;
  const passo = punti.length / quanti;
  const out = [];
  for (let i = 0; i < quanti; i++) out.push(punti[Math.floor(i * passo)]);
  return out;
}

function puntoPiuVicino(punti, p) {
  let scarto = Infinity;
  let indice = 0;
  for (let i = 0; i < punti.length; i++) {
    const d = haversine(p, punti[i]);
    if (d < scarto) {
      scarto = d;
      indice = i;
    }
  }
  return { indice, scarto };
}

async function interroga(query) {
  let ultimoStato = 0;
  for (const url of ENDPOINT) {
    try {
      const risposta = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (risposta.ok) return await risposta.json();
      ultimoStato = risposta.status;
    } catch (e) {
      /* si prova il mirror successivo */
    }
  }
  throw new Error(
    ultimoStato === 429 || ultimoStato === 504
      ? "Overpass è occupato: riprova fra un minuto."
      : "Non riesco a chiedere i punti d'appoggio a OpenStreetMap."
  );
}

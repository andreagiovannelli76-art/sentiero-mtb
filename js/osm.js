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
  // Riquadro invece di (around:): Overpass indicizza i riquadri, mentre around
  // deve calcolare la distanza relazione per relazione ed è molto più pesante.
  // Su un servizio pubblico e condiviso, una query pesante viene rifiutata.
  // Si cerca quindi nel quadrato che contiene il cerchio: qualche percorso in
  // più ai bordi, molte meno richieste respinte.
  const dLat = raggio / 111320;
  const dLon = raggio / (111320 * Math.cos((lat * Math.PI) / 180));
  const riquadro = [
    (lat - dLat).toFixed(5),
    (lon - dLon).toFixed(5),
    (lat + dLat).toFixed(5),
    (lon + dLon).toFixed(5),
  ].join(",");

  // "body" e non "tags": tags stampa id e tag ma OMETTE i membri della
  // relazione, e senza membri non arriva nessuna geometria da cui ricavare
  // la traccia. È il motivo per cui la v0.4 non trovava mai niente.
  // Le way servono due volte: con la geometria dentro le relazioni, per la
  // traccia, e con i soli tag, per sapere che fondo hanno. I tag costano
  // pochissimo rispetto alla geometria, che infatti non si richiede due volte.
  const query = `[out:json][timeout:60][bbox:${riquadro}];
(
  relation["route"="mtb"];
  relation["route"="bicycle"]["network"~"lcn|rcn"];
)->.rotte;
.rotte out body geom;
way(r.rotte);
out tags;`;

  const dati = await interroga(query);
  const elementi = (dati && dati.elements) || [];

  // Prima i tag delle way, poi le relazioni che li useranno.
  const tagWay = new Map();
  for (const el of elementi) {
    if (el.type === "way" && el.tags) tagWay.set(el.id, el.tags);
  }

  const percorsi = [];
  for (const rel of elementi) {
    if (rel.type !== "relation") continue;

    const way = (rel.members || []).filter(
      (m) => m.type === "way" && Array.isArray(m.geometry) && m.geometry.length > 1
    );
    const segmenti = way.map((m) => m.geometry.map((g) => ({ lat: g.lat, lon: g.lon })));

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
      // Quanto è lontano da dove hai cercato: il criterio con cui si ordina.
      distanzaDaTe: distanzaMinima(punti, lat, lon),
      fondo: fondoPrevalente(way, tagWay),
      frammentato,
      fonte: "OpenStreetMap",
      url: `https://www.openstreetmap.org/relation/${rel.id}`,
    });
  }

  // I più vicini in cima: da fermo davanti alla mappa interessa cosa hai
  // sotto casa, non qual è il giro più corto della provincia.
  return percorsi.sort((a, b) => a.distanzaDaTe - b.distanzaDaTe);
}

// Distanza dal punto cercato al punto più vicino del percorso. Si campiona:
// su una traccia di migliaia di punti la precisione al metro non serve a
// nessuno, e moltiplicata per tutti i risultati costerebbe.
function distanzaMinima(punti, lat, lon) {
  const centro = { lat, lon };
  const passo = Math.max(1, Math.floor(punti.length / 200));
  let minimo = Infinity;
  for (let i = 0; i < punti.length; i += passo) {
    const d = haversine(centro, punti[i]);
    if (d < minimo) minimo = d;
  }
  return minimo;
}

// Come classifichiamo i valori di surface e tracktype di OSM.
const FONDI = {
  asfalto: ["asphalt", "paved", "concrete", "paving_stones"],
  sterrato: ["unpaved", "gravel", "fine_gravel", "compacted", "dirt", "ground", "earth", "sand", "grass"],
  roccioso: ["rock", "stone", "pebblestone", "cobblestone"],
};

// Il fondo prevalente, pesato sulla lunghezza dei tratti: un chilometro di
// asfalto conta più di cento metri, anche se sono due way entrambe.
// Le way senza tag non votano: meglio non dire niente che tirare a indovinare.
function fondoPrevalente(way, tagWay) {
  const peso = { asfalto: 0, sterrato: 0, roccioso: 0 };
  let conosciuto = 0;
  let totale = 0;

  for (const m of way) {
    const punti = m.geometry.map((g) => ({ lat: g.lat, lon: g.lon }));
    const metri = lunghezza(punti);
    totale += metri;

    const tags = tagWay.get(m.ref) || {};
    const superficie = tags.surface || "";
    let categoria = Object.keys(FONDI).find((k) => FONDI[k].includes(superficie));

    // Senza surface, tracktype dice comunque quanto è battuta una sterrata.
    if (!categoria && tags.tracktype) {
      categoria = tags.tracktype === "grade1" ? "asfalto" : "sterrato";
    }

    if (categoria) {
      peso[categoria] += metri;
      conosciuto += metri;
    }
  }

  // Sotto un terzo di percorso classificato il dato non è affidabile.
  if (!totale || conosciuto < totale / 3) return null;

  const ordinati = Object.entries(peso).sort((a, b) => b[1] - a[1]);
  const [primo, valore] = ordinati[0];
  return valore > conosciuto * 0.7 ? primo : "misto";
}

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

async function interroga(query) {
  let ultimoErrore = null;
  let ultimoStato = 0;

  for (const url of ENDPOINT) {
    // Il 429 di Overpass è quasi sempre una coda momentanea: vale un secondo
    // tentativo sullo stesso mirror prima di passare al successivo.
    for (let tentativo = 0; tentativo < 2; tentativo++) {
      try {
        const risposta = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `data=${encodeURIComponent(query)}`,
        });

        if (risposta.ok) return await risposta.json();

        ultimoStato = risposta.status;

        if (risposta.status === 429) {
          if (tentativo === 0) {
            await attesa(2000);
            continue;
          }
          break;
        }

        // 504: la query non è finita in tempo. Riprovarla identica sullo stesso
        // mirror non serve a niente, si passa al prossimo.
        break;
      } catch (e) {
        ultimoErrore = e;
        break;
      }
    }
  }

  if (ultimoStato === 429) {
    throw new Error(
      "Overpass sta rifiutando le richieste: è un servizio pubblico e condiviso. Riprova fra un minuto."
    );
  }
  if (ultimoStato === 504) {
    throw new Error(
      "Overpass non ha finito in tempo: la zona è troppo ampia. Riprova con un raggio più piccolo."
    );
  }
  if (ultimoStato) {
    throw new Error(`Overpass ha risposto ${ultimoStato}.`);
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

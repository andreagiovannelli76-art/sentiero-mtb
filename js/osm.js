// osm.js — ricerca di percorsi ciclabili già mappati su OpenStreetMap, via Overpass.
// Si cercano le relazioni route=mtb e le ciclabili locali/regionali (route=bicycle, network lcn/rcn).

import { haversine, lunghezza } from "./geo.js";
import { chiediJson } from "./rete.js";

// Più mirror: se il primo è sovraccarico si passa al successivo.
const ENDPOINT = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Tolleranza in metri per considerare due estremi di way come lo stesso punto.
const TOLLERANZA_GIUNZIONE = 30;

// La ricerca avviene in due tempi, ed è la ragione per cui l'elenco compare
// subito invece che dopo mezzo minuto.
//
// Primo tempo (questa funzione): si chiedono solo i tag e il rettangolo di
// ingombro delle relazioni. Sono pochi kilobyte, arrivano in un istante, e
// bastano per scrivere l'elenco: nome, tipo, rete, quanto è lontano da te.
//
// Secondo tempo (`caricaTraccia`): la geometria, che è il novanta per cento
// del peso, si chiede solo per il percorso che si tocca. Prima si scaricava
// la traccia completa di tutti i risultati per mostrarne una riga a testa —
// e una relazione lunga arriva intera anche se la sfiori con il riquadro.

// Cerca percorsi entro `raggio` metri da (lat, lon).
// `opzioni.segnale` è un AbortSignal per annullare, `opzioni.onStato(testo)`
// riceve i cambi di passo (il secondo mirror, un'attesa) da mostrare a schermo.
// Ritorna un array di { id, idOsm, nome, tipo, rete, distanzaDaTe }.
export async function cercaPercorsi(lat, lon, raggio = 8000, opzioni = {}) {
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

  // "tags bb": i tag e il rettangolo di ingombro, niente membri e niente
  // geometria. Il timeout è basso apposta — se questa non torna in venti
  // secondi non tornerà, e tanto vale dirlo subito.
  const query = `[out:json][timeout:25][bbox:${riquadro}];
(
  relation["route"="mtb"];
  relation["route"="bicycle"]["network"~"lcn|rcn"];
);
out tags bb;`;

  const dati = await interroga(query, opzioni);
  const elementi = (dati && dati.elements) || [];

  const percorsi = [];
  for (const rel of elementi) {
    if (rel.type !== "relation") continue;
    const tags = rel.tags || {};

    percorsi.push({
      id: `osm_${rel.id}`,
      idOsm: rel.id,
      nome: tags.name || tags.ref || `Percorso OSM ${rel.id}`,
      tipo: tags.route === "mtb" ? "MTB" : "Ciclabile",
      rete: (tags.network || "").toUpperCase(),
      // Quanto è lontano da dove hai cercato: il criterio con cui si ordina.
      // Senza geometria si misura sul rettangolo di ingombro, che per un
      // percorso locale è un'ottima approssimazione. Per una ciclovia che
      // attraversa mezza Italia il rettangolo ti contiene e la distanza esce
      // zero: è comunque vero che ti passa vicino, quindi va bene in cima.
      distanzaDaTe: distanzaDalRiquadro(rel.bounds, lat, lon),
      fonte: "OpenStreetMap",
      url: `https://www.openstreetmap.org/relation/${rel.id}`,
    });
  }

  // I più vicini in cima: da fermo davanti alla mappa interessa cosa hai
  // sotto casa, non qual è il giro più corto della provincia.
  return percorsi.sort((a, b) => a.distanzaDaTe - b.distanzaDaTe);
}

// Secondo tempo: la traccia vera di una sola relazione.
// Ritorna { punti, distanza, fondo, frammentato }.
export async function caricaTraccia(idOsm, opzioni = {}) {
  // Le way servono due volte: con la geometria, per la traccia, e con i soli
  // tag, per sapere che fondo hanno. I tag costano pochissimo rispetto alla
  // geometria, che infatti non si richiede due volte.
  //
  // "body" e non "tags": tags stampa id e tag ma OMETTE i membri della
  // relazione, e senza membri non arriva nessuna geometria da cui ricavare
  // la traccia. È il motivo per cui la v0.4 non trovava mai niente.
  const query = `[out:json][timeout:60];
relation(${Number(idOsm)})->.rotta;
.rotta out body geom;
way(r.rotta);
out tags;`;

  const dati = await interroga(query, opzioni);
  const elementi = (dati && dati.elements) || [];

  // Prima i tag delle way, poi la relazione che li userà.
  const tagWay = new Map();
  for (const el of elementi) {
    if (el.type === "way" && el.tags) tagWay.set(el.id, el.tags);
  }

  const rel = elementi.find((e) => e.type === "relation");
  const way = ((rel && rel.members) || []).filter(
    (m) => m.type === "way" && Array.isArray(m.geometry) && m.geometry.length > 1
  );
  const segmenti = way.map((m) => m.geometry.map((g) => ({ lat: g.lat, lon: g.lon })));

  if (!segmenti.length) {
    throw new Error("Questo percorso non ha una traccia utilizzabile su OpenStreetMap.");
  }

  const { punti, frammentato } = concatena(segmenti);
  if (punti.length < 2) {
    throw new Error("Questo percorso non ha una traccia utilizzabile su OpenStreetMap.");
  }

  return {
    punti,
    distanza: lunghezza(punti),
    fondo: fondoPrevalente(way, tagWay),
    frammentato,
  };
}

// Distanza dal punto al rettangolo di ingombro: zero se ci sei dentro,
// altrimenti la distanza dal lato più vicino.
function distanzaDalRiquadro(bounds, lat, lon) {
  if (!bounds) return Infinity;
  const vicino = {
    lat: Math.min(Math.max(lat, bounds.minlat), bounds.maxlat),
    lon: Math.min(Math.max(lon, bounds.minlon), bounds.maxlon),
  };
  return haversine({ lat, lon }, vicino);
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

// Un'attesa che si interrompe se nel frattempo si annulla: altrimenti dopo
// "Annulla" resterebbero due secondi di nulla prima di accorgersene.
function attesa(ms, segnale) {
  return new Promise((risolvi, rifiuta) => {
    const timer = setTimeout(fine, ms);
    function fine() {
      clearTimeout(timer);
      if (segnale) segnale.removeEventListener("abort", interrompi);
      risolvi();
    }
    function interrompi() {
      clearTimeout(timer);
      if (segnale) segnale.removeEventListener("abort", interrompi);
      const e = new Error("Annullato.");
      e.annullata = true;
      rifiuta(e);
    }
    if (segnale) {
      if (segnale.aborted) return interrompi();
      segnale.addEventListener("abort", interrompi);
    }
  });
}

async function interroga(query, opzioni = {}) {
  const { segnale = null, onStato = () => {} } = opzioni;
  let ultimoErrore = null;
  let ultimoStato = 0;
  let scaduta = false;

  for (let m = 0; m < ENDPOINT.length; m++) {
    const url = ENDPOINT[m];
    if (m > 0) onStato("Il primo server non risponde: ne provo un altro…");

    // Il 429 di Overpass è quasi sempre una coda momentanea: vale un secondo
    // tentativo sullo stesso mirror prima di passare al successivo.
    for (let tentativo = 0; tentativo < 2; tentativo++) {
      try {
        const esito = await chiediJson(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `data=${encodeURIComponent(query)}`,
          segnale,
        });

        if (esito.ok) return esito.dati;

        ultimoStato = esito.stato;

        if (esito.stato === 429) {
          if (tentativo === 0) {
            onStato("Overpass è in coda: aspetto due secondi…");
            await attesa(2000, segnale);
            continue;
          }
          break;
        }

        // 504: la query non è finita in tempo. Riprovarla identica sullo stesso
        // mirror non serve a niente, si passa al prossimo.
        break;
      } catch (e) {
        // Annullata da chi ha chiesto: non si prova nient'altro.
        if (e.annullata) throw e;
        if (e.scaduta) scaduta = true;
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
  if (scaduta) {
    throw new Error(
      "OpenStreetMap non ha risposto in tempo. Controlla il campo e riprova: con poca rete conviene un raggio più piccolo."
    );
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

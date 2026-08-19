// osm.js — ricerca di percorsi ciclabili già mappati su OpenStreetMap, via Overpass.
// Si cercano le relazioni route=mtb e le ciclabili locali/regionali (route=bicycle, network lcn/rcn).

import { haversine, lunghezza } from "./geo.js";
import { chiediJson } from "./rete.js";
import { daCache, inCache } from "./db.js";
import { cercaPercorsi as cercaSuWaymarked, caricaSegmenti } from "./waymarked.js";

// Overpass è un servizio pubblico e gratuito, tenuto in piedi da volontari:
// nelle ore di punta una richiesta può restare in coda per un minuto. Non è
// rotto, è affollato — e sono mirror indipendenti, quindi quando uno arranca
// spesso un altro è libero.
const ENDPOINT = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// Dopo quanto si affianca il mirror successivo. Non si aspetta che il primo
// fallisca — aspettare tre volte trenta secondi vuol dire un minuto e mezzo
// davanti a una rotella — ma nemmeno si parte a raffica su tutti: si dà al
// primo un vantaggio di cinque secondi, che gli basta quando è in salute.
// Vince chi risponde per primo, gli altri vengono fermati subito dopo.
const ANTICIPO = 5000;

// Quanto si concede a un singolo mirror prima di considerarlo perso.
const SCADENZA_OVERPASS = 45000;

// Per quanto si tiene buona una risposta già avuta. I percorsi mappati su OSM
// non cambiano da un'ora all'altra: una settimana per gli elenchi, un mese per
// le tracce, che cambiano ancora meno. Il guadagno è enorme — la seconda
// ricerca nella stessa zona è immediata — e il rischio è vedere per qualche
// giorno un percorso aggiunto ieri.
const VALIDITA_ELENCO = 7 * 24 * 60 * 60 * 1000;
const VALIDITA_TRACCIA = 30 * 24 * 60 * 60 * 1000;

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
// riceve i cambi di passo da mostrare a schermo, `opzioni.onFonte` dice se la
// risposta viene dalla memoria del telefono o dalla rete, e
// `opzioni.ignoraCache` la richiede comunque.
// Ritorna un array di { id, idOsm, nome, tipo, rete }.
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

  // "out tags" e basta: gli identificativi e i tag delle relazioni che
  // l'indice spaziale ha già selezionato. Overpass non deve aprire niente.
  //
  // Si era provato "out tags bb", per avere anche il rettangolo di ingombro e
  // ordinare per vicinanza. Sembra leggero perché torna pochi byte, ma per
  // calcolare quel rettangolo Overpass deve risolvere tutti i membri della
  // relazione e tutti i loro nodi: il lavoro del server è lo stesso della
  // geometria completa. Si risparmiava traffico, non attesa — ed era l'attesa
  // il problema.
  // Tutto quello che si puo' percorrere: i giri MTB, le ciclovie di ogni
  // rete — dalle locali alle EuroVelo, prima si prendevano solo lcn/rcn — e
  // la rete escursionistica, hiking e foot, dove sull'Appennino si pedala
  // davvero. Il tipo li distingue in lista, e il filtro lascia scegliere.
  const query = `[out:json][timeout:25][bbox:${riquadro}];
(
  relation["route"="mtb"];
  relation["route"="bicycle"];
  relation["route"="hiking"];
  relation["route"="foot"];
);
out tags;`;

  // La chiave è il riquadro stesso: cercare due volte dallo stesso punto con
  // lo stesso raggio è la cosa più normale del mondo, e la seconda volta deve
  // essere immediata.
  // La memoria del telefono viene prima di qualunque fonte.
  const chiave = `elenco3:${riquadro}`;
  const salvato = opzioni.ignoraCache ? null : await daCache(chiave, VALIDITA_ELENCO);
  if (salvato) {
    if (opzioni.onFonte) opzioni.onFonte("memoria");
    return leggiElenco(salvato);
  }

  // Poi Waymarked Trails, che a questa domanda ha già la risposta pronta.
  // Se non risponde — è giù, non parla con noi dal browser, ha cambiato
  // formato — si scende su Overpass senza dire niente a nessuno: l'utente
  // vuole i percorsi, non sapere da quale porta sono entrati.
  // Vero se Waymarked Trails ha risposto in modo comprensibile: cambia cosa
  // fare se poi Overpass non risponde.
  let waymarkedHaParlato = false;

  try {
    const { percorsi: veloci, riconosciuto } = await cercaSuWaymarked(
      lat - dLat, lon - dLon, lat + dLat, lon + dLon, opzioni
    );

    if (riconosciuto && veloci.length) {
      if (opzioni.onFonte) opzioni.onFonte("waymarked");
      await inCache(chiave, { fonte: "waymarked", percorsi: veloci });
      return veloci;
    }


    // Elenco vuoto. Può voler dire davvero "qui non c'è niente" — sulle
    // colline picene capita spesso — oppure che la loro copertura non arriva
    // fin qui, o che il riquadro non gli è piaciuto. Dire a qualcuno "non
    // c'è niente" quando invece c'è è il modo più sicuro di fargli chiudere
    // l'app, quindi il vuoto si fa confermare da Overpass prima di
    // annunciarlo. Costa una domanda in più solo nei casi vuoti, che sono i
    // meno frequenti e i più dubbi.
    waymarkedHaParlato = riconosciuto;
  } catch (e) {
    if (e.annullata) throw e;
    console.warn("Waymarked Trails non utilizzabile, passo a Overpass:", e.message);
  }

  if (opzioni.onFonte) opzioni.onFonte("rete");

  let dati;
  try {
    dati = await interroga(query, opzioni);
  } catch (e) {
    if (e.annullata) throw e;
    // Se l'altra fonte aveva risposto, un vuoto confermato a meta' resta una
    // risposta: meglio "non c'è niente" che un errore rosso su una zona in
    // cui, molto probabilmente, davvero non c'è niente.
    if (waymarkedHaParlato) {
      if (opzioni.onFonte) opzioni.onFonte("waymarked");
      return [];
    }
    throw e;
  }

  await inCache(chiave, dati);
  return daOverpass(dati);
}

// Da una risposta di Overpass all'elenco che si mostra.
function daOverpass(dati) {
  const elementi = (dati && dati.elements) || [];

  const percorsi = [];
  for (const rel of elementi) {
    if (rel.type !== "relation") continue;
    const tags = rel.tags || {};

    percorsi.push({
      id: `osm_${rel.id}`,
      idOsm: rel.id,
      nome: tags.name || tags.ref || `Percorso OSM ${rel.id}`,
      tipo: tags.route === "mtb" ? "MTB" : tags.route === "bicycle" ? "Ciclabile" : "Sentiero",
      rete: (tags.network || "").toUpperCase(),
      fonte: "OpenStreetMap",
      url: `https://www.openstreetmap.org/relation/${rel.id}`,
    });
  }

  // Tutti i percorsi in elenco passano dentro il riquadro che hai cercato,
  // quindi sono tutti "vicini": l'ordine alfabetico è il più utile per
  // ritrovare un nome che conosci. La distanza esatta la sa solo la traccia,
  // e arriva quando ne apri uno.
  return percorsi.sort((a, b) => a.nome.localeCompare(b.nome, "it"));
}

// ------------------------------------------------------------------ il tocco

// "Cosa passa in questo punto?" — la domanda del dito sulla mappa.
//
// L'archivio veloce non sa rispondere sui riquadri piccolissimi: interrogato
// su trecento metri dice "niente" anche dove il percorso c'è. Verificato sul
// campo — prima del parallelo, il suo vuoto veniva smentito da Overpass una
// volta su una. Quindi qui si fanno DUE domande insieme, non in fila:
//
//   · a Overpass, quella precisa: "quali percorsi contengono le strade in
//     questi 150 metri". È una domanda leggera — poche way, appartenenza
//     indicizzata — il suo costo vero è la coda, non il lavoro.
//   · all'archivio veloce, quella larga: "cosa c'è nel chilometro attorno".
//     Sui riquadri da chilometro risponde bene, e risponde subito.
//
// Se la precisa arriva in tempo si usa lei. Se tarda e la larga ha trovato
// qualcosa, si mostra quello — "in zona" — invece di far scadere il velo.
// Ritorna { percorsi, precisione: "punto" | "zona" }.
const RAGGIO_PUNTO = 150;
const RAGGIO_ZONA = 1200;
const PAZIENZA_PUNTO = 12000;

export async function cosaPassaQui(lat, lon, opzioni = {}) {
  const chiave = `tocco:${lat.toFixed(4)},${lon.toFixed(4)}`;
  const salvato = await daCache(chiave, VALIDITA_ELENCO);
  if (salvato) return salvato;

  const dLat = (r) => r / 111320;
  const dLon = (r) => r / (111320 * Math.cos((lat * Math.PI) / 180));

  const riquadro = [
    (lat - dLat(RAGGIO_PUNTO)).toFixed(5),
    (lon - dLon(RAGGIO_PUNTO)).toFixed(5),
    (lat + dLat(RAGGIO_PUNTO)).toFixed(5),
    (lon + dLon(RAGGIO_PUNTO)).toFixed(5),
  ].join(",");

  const query = `[out:json][timeout:25][bbox:${riquadro}];
way["highway"];
rel(bw)["route"~"^(mtb|bicycle|hiking|foot)$"];
out tags;`;

  // Le due domande partono insieme.
  const larga = cercaSuWaymarked(
    lat - dLat(RAGGIO_ZONA), lon - dLon(RAGGIO_ZONA),
    lat + dLat(RAGGIO_ZONA), lon + dLon(RAGGIO_ZONA),
    opzioni
  ).then((r) => (r.riconosciuto ? r.percorsi : null)).catch(() => null);

  const precisa = interroga(query, opzioni).then(
    (dati) => ({ esito: "ok", percorsi: daOverpass(dati) }),
    (e) => ({ esito: "errore", errore: e })
  );

  const consegna = async (risultato) => {
    await inCache(chiave, risultato);
    return risultato;
  };

  // Prima finestra: la precisa ha PAZIENZA_PUNTO millisecondi.
  const primo = await Promise.race([precisa, attesa(PAZIENZA_PUNTO, opzioni.segnale).then(() => null)]);

  if (primo && primo.esito === "ok") {
    return consegna({ percorsi: primo.percorsi, precisione: "punto" });
  }
  if (primo && primo.esito === "errore") {
    if (primo.errore.annullata) throw primo.errore;
    const vicini = await larga;
    if (vicini) return consegna({ percorsi: vicini, precisione: "zona" });
    throw primo.errore;
  }

  // La precisa è ancora in coda: se la larga ha una risposta, basta quella.
  const vicini = await larga;
  if (vicini && vicini.length) {
    return consegna({ percorsi: vicini, precisione: "zona" });
  }

  // La larga non sa niente: tanto vale aspettare la precisa fino in fondo.
  const fine = await precisa;
  if (fine.esito === "ok") return consegna({ percorsi: fine.percorsi, precisione: "punto" });
  if (vicini) return consegna({ percorsi: [], precisione: "zona" });
  throw fine.errore;
}

// In memoria può esserci una risposta di Overpass (con "elements") oppure un
// elenco già pronto di Waymarked Trails: si riconosce da cosa c'è dentro.
function leggiElenco(salvato) {
  if (salvato && salvato.fonte === "waymarked" && Array.isArray(salvato.percorsi)) {
    return salvato.percorsi;
  }
  return daOverpass(salvato);
}

// Secondo tempo: la traccia vera di una sola relazione.
// Ritorna { punti, distanza, fondo, frammentato }.
export async function caricaTraccia(idOsm, opzioni = {}) {
  const chiave = `traccia2:${Number(idOsm)}`;

  const salvata = opzioni.ignoraCache ? null : await daCache(chiave, VALIDITA_TRACCIA);
  if (salvata && salvata.traccia) return salvata.traccia;
  // Le voci salvate col vecchio formato (la risposta grezza di Overpass)
  // restano leggibili: si riparsano e via.
  if (salvata && salvata.elements) return traccaDaOverpass(salvata);

  // Prima la geometria precalcolata: un file pronto invece di chiedere a
  // Overpass di assemblare la relazione way per way. Per un anello di paese
  // cambia poco, per un cammino nazionale e' la differenza fra aprirsi e
  // morire di timeout. Si rinuncia al fondo del sentiero — quello lo sa solo
  // Overpass, dai tag delle way — ma una scheda senza fondo e' utile, un
  // timeout non lo e'.
  try {
    const segmenti = await caricaSegmenti(idOsm, opzioni);
    const risultato = costruisci(segmenti, null);
    await inCache(chiave, { traccia: risultato });
    return risultato;
  } catch (e) {
    if (e.annullata) throw e;
    console.warn("Geometria Waymarked non disponibile, passo a Overpass:", e.message);
  }

  // Riserva: Overpass, che in cambio della lentezza ci dice anche il fondo.
  //
  // I giri lunghi su OSM sono spesso "super-percorsi": relazioni che
  // contengono altre relazioni — le tappe — e nessuna way diretta. Leggere
  // solo il primo livello trova il contenitore e dentro non vede niente:
  // "traccia non utilizzabile" su un percorso che esiste eccome. Si scende
  // quindi di un livello: la relazione chiesta piu' le sue eventuali figlie.
  const query = `[out:json][timeout:60];
relation(${Number(idOsm)})->.radice;
(.radice; relation(r.radice);)->.rotte;
.rotte out body geom;
way(r.rotte);
out tags;`;

  const dati = await interroga(query, opzioni);
  const risultato = traccaDaOverpass(dati);
  await inCache(chiave, { traccia: risultato });
  return risultato;
}

// Da una risposta Overpass completa (relazione + tag delle way) alla traccia.
function traccaDaOverpass(dati) {
  const elementi = (dati && dati.elements) || [];

  // Prima i tag delle way, poi la relazione che li userà.
  const tagWay = new Map();
  for (const el of elementi) {
    if (el.type === "way" && el.tags) tagWay.set(el.id, el.tags);
  }

  // Le way si raccolgono da TUTTE le relazioni della risposta: in un
  // super-percorso la radice non ne ha, le tappe si'.
  const way = [];
  for (const rel of elementi) {
    if (rel.type !== "relation") continue;
    for (const m of rel.members || []) {
      if (m.type === "way" && Array.isArray(m.geometry) && m.geometry.length > 1) {
        way.push(m);
      }
    }
  }
  const segmenti = way.map((m) => m.geometry.map((g) => ({ lat: g.lat, lon: g.lon })));

  return costruisci(segmenti, fondoPrevalente(way, tagWay));
}

// Concatena i segmenti e completa la scheda. `fondo` può essere null quando
// la geometria arriva già pronta e i tag delle way non ci sono.
function costruisci(segmenti, fondo) {
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
    fondo,
    frammentato,
  };
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
      rifiuta(annullata());
    }
    if (segnale) {
      if (segnale.aborted) return interrompi();
      segnale.addEventListener("abort", interrompi);
    }
  });
}

async function interroga(query, opzioni = {}) {
  const { segnale = null, onStato = () => {} } = opzioni;

  // Una corsa fra i mirror: il primo che taglia il traguardo ferma gli altri.
  const corsa = new AbortController();
  const inoltra = () => corsa.abort();
  if (segnale) {
    if (segnale.aborted) throw annullata();
    segnale.addEventListener("abort", inoltra);
  }

  // Overpass accetta la query sia nel corpo di una POST sia nell'indirizzo di
  // una GET. Le nostre query sono corte — poche centinaia di caratteri — e la
  // GET è la strada meno accidentata: qualche rete mobile e qualche proxy
  // aziendale trattano con sospetto le POST verso host non noti, e una GET
  // può anche essere messa in cache da chi sta nel mezzo.
  // Sopra una certa lunghezza l'indirizzo non è più affidabile e si torna
  // alla POST, che non ha limiti pratici.
  const inIndirizzo = query.length < 1500;
  const richiesta = inIndirizzo
    ? { segnale: corsa.signal, scadenza: SCADENZA_OVERPASS }
    : {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        segnale: corsa.signal,
        scadenza: SCADENZA_OVERPASS,
      };
  const coda = inIndirizzo ? `?data=${encodeURIComponent(query)}` : "";

  const stati = [];
  let inGara = 0;

  const tentativo = async (url, ritardo) => {
    // L'attesa si interrompe se qualcuno ha già vinto: nessuna richiesta
    // inutile a un servizio gratuito.
    if (ritardo) await attesa(ritardo, corsa.signal);

    inGara++;
    if (inGara === 2) onStato("Il primo server è lento: ne interrogo un altro in parallelo…");

    const esito = await chiediJson(url + coda, richiesta);
    if (!esito.ok) {
      stati.push(esito.stato);
      throw new Error(`stato ${esito.stato}`);
    }
    return esito.dati;
  };

  try {
    return await Promise.any(ENDPOINT.map((url, i) => tentativo(url, i * ANTICIPO)));
  } catch (e) {
    // Se l'utente ha premuto Annulla, è quello che va detto: gli altri
    // fallimenti sono conseguenza, non causa.
    if (segnale && segnale.aborted) throw annullata();

    const errori = (e && e.errors) || [e];
    throw spiegaFallimento(stati, errori);
  } finally {
    if (segnale) segnale.removeEventListener("abort", inoltra);
    // Vinta o persa, la corsa è finita: chi è ancora in volo può fermarsi.
    corsa.abort();
  }
}

function annullata() {
  const e = new Error("Annullato.");
  e.annullata = true;
  return e;
}

// Un messaggio che dice cosa è successo e cosa si può fare, non un codice.
function spiegaFallimento(stati, errori) {
  if (stati.includes(429)) {
    return new Error(
      "Overpass sta rifiutando le richieste: è un servizio pubblico e condiviso. Riprova fra un minuto."
    );
  }
  if (stati.includes(504)) {
    return new Error(
      "Overpass non ha finito in tempo: la zona è troppo ampia. Riprova con un raggio più piccolo."
    );
  }
  if (errori.some((x) => x && x.scaduta)) {
    return new Error(
      "OpenStreetMap non ha risposto in tempo: in questo momento è molto carico. Riprova fra un minuto, o con un raggio più piccolo."
    );
  }
  if (stati.length) {
    return new Error(`Overpass ha risposto ${stati[0]}.`);
  }
  return new Error("Overpass non raggiungibile: controlla la connessione.");
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

// app.js — orchestrazione: mappa, lista, dettaglio, registrazione, ricerca OSM, report.
// Nessun bundler: import ES nativi. Leaflet e pako arrivano dalla CDN come globali.

import * as db from "./db.js";
import { leggiGpx, scriviGpx, nomeFile } from "./gpx.js";
import {
  statistiche,
  douglasPeucker,
  formattaDistanza,
  formattaDurata,
  haversine,
} from "./geo.js";
import { Profilo } from "./profile.js";
import { Tracker, posizioneAttuale, osservaPosizione, tieniSchermoAcceso } from "./tracker.js";
import { Guida } from "./follow.js";
import { creaLink, leggiLink, LIMITE_URL } from "./share.js";
import { correggiQuote } from "./elevation.js";
import { cercaPercorsi, caricaTraccia } from "./osm.js";
import { cercaLuogo } from "./geocode.js";
import { previsione, puntoPiuAlto } from "./weather.js";
import { cercaPunti } from "./poi.js";
import { testo as registroRete } from "./registro.js";
import { mostraIntro, introGiaVista } from "./intro.js";

export const APP_VERSION = "0.5.21-beta";

// Numero del canale feedback beta. Pubblico nel sorgente: è una scelta consapevole.
const REPORT_WA = "393484791772";

// Ascoli Piceno: il punto di partenza naturale del progetto.
const CENTRO_PREDEFINITO = [42.854, 13.575];
const ZOOM_PREDEFINITO = 11;

const COLORE_TRACCIA = "#C88B3C"; // dust
const COLORE_REGISTRAZIONE = "#8E3B2E";

// ---------------------------------------------------------------- stato

const stato = {
  vista: "mappa",
  vistaPrecedente: "percorsi",
  percorsi: [],
  attivo: null,       // percorso mostrato nel dettaglio
  attivoSalvato: false,
  risultatiOsm: [],
  ultimoAggiornamentoLive: 0,
  guida: null,
  quoteInCorso: null,
  // Cresce a ogni percorso aperto. Le richieste lente lo catturano alla
  // partenza e lo riconfrontano all'arrivo: se e' cambiato, l'utente sta
  // guardando altro e quei dati non lo riguardano piu'.
  //
  // Non si confronta l'oggetto del percorso perche' quello viene sostituito
  // quando arrivano le quote: chi era partito prima si sarebbe creduto
  // scaduto pur essendo ancora la scheda giusta.
  apertura: 0,
};

let mappa;
let layerTraccia = null;
let marcatorePunto = null;
let layerRegistrazione = null;
let marcatorePosizione = null;
let profilo = null;
let tracker = null;
let fermaOsservazione = null;
let rilasciaSchermo = null;

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------- avvio

avvia().catch((e) => {
  console.error(e);
  // Qualunque cosa sia andata storta, il velo non deve restare su: uno
  // schermo grigio che non si toglie è peggio dell'errore stesso.
  lavoro(false);
  // Il messaggio grezzo del browser è in inglese e non dice cosa fare.
  avvisa(
    e && e.spiegato
      ? e.message
      : "Qualcosa non è partito. Ricarica la pagina; se continua, usa la bandierina in alto a destra per segnalarlo.",
    true
  );
});

async function avvia() {
  preparaMappa();
  preparaProfilo();
  preparaTracker();
  collegaEventi();
  registraServiceWorker();

  await ricaricaLista();

  // Un link condiviso ha la precedenza su tutto: è il primo contatto di chi apre.
  const condiviso = leggiLink();
  if (condiviso) {
    apriCondiviso(condiviso);
  } else {
    mostraVista("mappa");
    // Chi arriva da un link sta guardando il percorso di un amico: la guida
    // gliela si mostra un'altra volta, non davanti a quello che è venuto a vedere.
    if (!introGiaVista()) mostraIntro();
  }

  // La cache di rete non deve crescere per sempre: si butta via quello che ha
  // più di un mese. È l'ultima cosa dell'avvio, e se fallisce non importa.
  db.potaCache(30 * 24 * 60 * 60 * 1000);
}

function apriCondiviso(condiviso) {
  apriPercorso({ ...condiviso, fonte: "Link condiviso" }, false);
  avvisa("Percorso ricevuto da un link. Salvalo per tenerlo.");
}

// ---------------------------------------------------------------- mappa

function preparaMappa() {
  mappa = L.map("mappa", { zoomControl: true, attributionControl: true }).setView(
    CENTRO_PREDEFINITO,
    ZOOM_PREDEFINITO
  );

  const openTopo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17,
    attribution: "© OpenStreetMap, SRTM · stile OpenTopoMap (CC-BY-SA)",
  });

  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap",
  });

  const satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Immagini © Esri" }
  );

  const cyclosm = L.tileLayer(
    "https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png",
    { maxZoom: 19, attribution: "© OpenStreetMap · stile CyclOSM" }
  );

  const mtb = L.tileLayer("https://tile.waymarkedtrails.org/mtb/{z}/{x}/{y}.png", {
    maxZoom: 18,
    opacity: 0.8,
    attribution: "Percorsi © Waymarked Trails",
  });

  openTopo.addTo(mappa);

  L.control
    .layers(
      { OpenTopoMap: openTopo, OpenStreetMap: osm, Satellite: satellite, CyclOSM: cyclosm },
      { "Sentieri MTB": mtb },
      { collapsed: true }
    )
    .addTo(mappa);

  mappa.on("click", toccaMappa);

  // Il pannello cambia altezza: la mappa va avvisata o resta disegnata male.
  new ResizeObserver(() => mappa.invalidateSize()).observe(el("mappa"));
}

function disegnaTraccia(punti, { colore = COLORE_TRACCIA, inquadra = true } = {}) {
  puliscTraccia();
  if (!punti || punti.length < 2) return;

  // Sopra i 3000 punti il disegno diventa pesante sui telefoni: si semplifica solo la resa.
  const daDisegnare = punti.length > 3000 ? douglasPeucker(punti, 5) : punti;

  const linea = L.polyline(
    daDisegnare.map((p) => [p.lat, p.lon]),
    { color: colore, weight: 4, opacity: 0.9, lineJoin: "round" }
  );

  const partenza = L.circleMarker([punti[0].lat, punti[0].lon], {
    radius: 5,
    color: "#3F5B37",
    fillColor: "#3F5B37",
    fillOpacity: 1,
  }).bindTooltip("Partenza");

  // featureGroup e non layerGroup: serve getBounds() per inquadrare la traccia.
  layerTraccia = L.featureGroup([linea, partenza]).addTo(mappa);

  if (inquadra) mappa.fitBounds(layerTraccia.getBounds(), { padding: [24, 24] });
}

function puliscTraccia() {
  if (layerTraccia) {
    mappa.removeLayer(layerTraccia);
    layerTraccia = null;
  }
  if (marcatorePunto) {
    mappa.removeLayer(marcatorePunto);
    marcatorePunto = null;
  }
}

function evidenziaSullaMappa(punto) {
  if (!punto) {
    if (marcatorePunto) {
      mappa.removeLayer(marcatorePunto);
      marcatorePunto = null;
    }
    return;
  }
  if (!marcatorePunto) {
    marcatorePunto = L.circleMarker([punto.lat, punto.lon], {
      radius: 6,
      color: "#C88B3C",
      fillColor: "#C88B3C",
      fillOpacity: 1,
      weight: 2,
    }).addTo(mappa);
  } else {
    marcatorePunto.setLatLng([punto.lat, punto.lon]);
  }
}

// ---------------------------------------------------------------- viste

function mostraVista(nome) {
  if (nome !== "dettaglio") stato.vistaPrecedente = nome;
  stato.vista = nome;

  const viste = ["percorsi", "registra", "cerca", "dettaglio"];
  for (const v of viste) {
    el(`vista-${v}`).hidden = v !== nome;
  }
  el("pannello").hidden = nome === "mappa";

  for (const b of el("tab").querySelectorAll("button")) {
    const suo = b.dataset.vista;
    b.classList.toggle("attivo", suo === nome || (nome === "dettaglio" && suo === "percorsi"));
  }

  // Il canvas si dimensiona solo quando è visibile.
  if (nome === "dettaglio" && profilo) requestAnimationFrame(() => profilo.disegna());
  requestAnimationFrame(() => mappa.invalidateSize());
}

// ---------------------------------------------------------------- lista percorsi

async function ricaricaLista() {
  stato.percorsi = await db.tutti();
  const ul = el("lista-percorsi");
  ul.innerHTML = "";

  el("lista-vuota").hidden = stato.percorsi.length > 0;

  for (const p of stato.percorsi) {
    const s = statistiche(p.punti);
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="nome">
        ${testoSicuro(p.nome)}
        <div class="meta">${formattaDistanza(s.distanza)} · D+ ${s.dPiu} m · ${dataBreve(p.data)}</div>
      </div>
      <span class="pillola${p.fonte === "OpenStreetMap" ? " osm" : ""}">${testoSicuro(etichettaFonte(p))}</span>
    `;
    li.addEventListener("click", () => apriPercorso(p, true));
    ul.appendChild(li);
  }
}

function etichettaFonte(p) {
  if (p.fonte === "OpenStreetMap") return "OSM";
  if (p.fonte === "Registrazione") return "GPS";
  if (p.fonte === "Link condiviso") return "Link";
  return "GPX";
}

function dataBreve(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "2-digit" });
}

// ---------------------------------------------------------------- dettaglio

function apriPercorso(percorso, salvato) {
  stato.apertura++;
  stato.attivo = percorso;
  stato.attivoSalvato = !!salvato;

  el("dettaglio-nome").textContent = percorso.nome || "Percorso";
  el("btn-salva").hidden = !!salvato;
  el("btn-elimina").hidden = !salvato;

  const s = rinfrescaStatistiche();
  disegnaTraccia(percorso.punti);
  profilo.imposta(percorso.punti);
  mostraVista("dettaglio");

  // I percorsi presi da OSM arrivano senza quote. Chiederle e' l'unico modo
  // per avere dislivello e profilo, quindi si fa da soli invece di aspettare
  // che l'utente scopra il pulsante giusto.
  if (!s.haQuote) chiediQuote(percorso);

  el("appoggi").hidden = true;
  mostraMeteo(percorso);
}

function rinfrescaStatistiche() {
  const p = stato.attivo;
  if (!p) return { haQuote: true };
  const s = statistiche(p.punti);

  const voci = [
    ["Distanza", formattaDistanza(s.distanza)],
    ["D+", s.haQuote ? `${s.dPiu} m` : "—"],
    ["D−", s.haQuote ? `${s.dMeno} m` : "—"],
    ["Quota max", s.quotaMax !== null ? `${s.quotaMax} m` : "—"],
    ["Pend. max", s.pendenzaMax ? `${s.pendenzaMax}%` : "—"],
    ["Difficoltà", s.difficolta],
  ];
  if (s.durata) voci.push(["Durata", formattaDurata(s.durata)]);

  el("dettaglio-stat").innerHTML = voci
    .map(([k, v]) => `<div class="voce"><span>${k}</span><strong>${testoSicuro(v)}</strong></div>`)
    .join("");

  return s;
}

// ---------------------------------------------------------------- registrazione

function preparaTracker() {
  tracker = new Tracker({
    onPunto: (_punto, punti) => {
      if (layerRegistrazione) {
        layerRegistrazione.setLatLngs(punti.map((p) => [p.lat, p.lon]));
      }
      const ultimo = punti[punti.length - 1];
      mappa.panTo([ultimo.lat, ultimo.lon], { animate: false });
      aggiornaDatiLive(punti);
    },
    onStato: (s) => {
      el("live-punti").textContent = s.punti;
      for (const b of el("tab").querySelectorAll("button")) {
        b.classList.toggle("registrando", b.dataset.vista === "registra" && s.attivo && !s.inPausa);
      }
    },
    onErrore: (m) => avvisa(m, true),
  });
}

function aggiornaDatiLive(punti) {
  const ora = Date.now();
  if (ora - stato.ultimoAggiornamentoLive < 1000) return;
  stato.ultimoAggiornamentoLive = ora;

  const s = statistiche(punti);
  el("live-distanza").textContent = formattaDistanza(s.distanza);
  el("live-dpiu").textContent = `${s.dPiu} m`;

  const primo = punti.find((p) => p.t);
  if (primo) {
    el("live-durata").textContent = formattaDurata((ora - new Date(primo.t)) / 1000);
  }
}

async function avviaRegistrazione() {
  puliscTraccia();
  layerRegistrazione = L.polyline([], {
    color: COLORE_REGISTRAZIONE,
    weight: 5,
    opacity: 0.9,
  }).addTo(mappa);

  el("live-distanza").textContent = "0 m";
  el("live-dpiu").textContent = "0 m";
  el("live-durata").textContent = "0m 00s";
  el("live-punti").textContent = "0";

  await tracker.avvia();

  el("btn-avvia").hidden = true;
  el("btn-pausa").hidden = false;
  el("btn-ferma").hidden = false;
  el("btn-pausa").textContent = "Pausa";

  // Centrare subito la mappa aiuta a capire che il GPS ha agganciato.
  posizioneAttuale()
    .then((p) => mappa.setView([p.lat, p.lon], 15))
    .catch(() => {});

  avvisa("Registrazione avviata. Tieni l'app in primo piano.");
}

async function fermaRegistrazione() {
  const punti = tracker.ferma();

  el("btn-avvia").hidden = false;
  el("btn-pausa").hidden = true;
  el("btn-ferma").hidden = true;

  if (layerRegistrazione) {
    mappa.removeLayer(layerRegistrazione);
    layerRegistrazione = null;
  }

  if (punti.length < 2) {
    avvisa("Traccia troppo corta: nessun punto valido da salvare.", true);
    return;
  }

  const proposto = `Giro del ${new Date().toLocaleDateString("it-IT")}`;
  const nome = (prompt("Nome del giro:", proposto) || proposto).trim();

  const salvato = await db.salva({
    nome,
    punti,
    fonte: "Registrazione",
    versione: APP_VERSION,
  });

  await ricaricaLista();
  apriPercorso(salvato, true);
  avvisa("Giro salvato. Se il D+ è basso, prova «Correggi quote».");
}

// ---------------------------------------------------------------- ricerca dei luoghi

async function cercaLuoghi() {
  const testo = el("luogo").value;
  if (!testo.trim()) return;

  lavoro(true, "Cerco il luogo…");
  try {
    const luoghi = await cercaLuogo(testo);
    const ul = el("lista-luoghi");
    ul.innerHTML = "";
    ul.hidden = !luoghi.length;

    if (!luoghi.length) {
      avvisa("Nessun luogo con questo nome.", true);
      return;
    }

    for (const l of luoghi) {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="nome">
          ${testoSicuro(l.breve)}
          ${l.tipo ? `<div class="meta">${testoSicuro(l.tipo)}</div>` : ""}
        </div>
      `;
      li.addEventListener("click", () => vaiA(l));
      ul.appendChild(li);
    }
  } catch (e) {
    avvisa(e.message, true);
  } finally {
    lavoro(false);
  }
}

// Scelto il luogo, ci si sposta e si cerca subito: è quello che si voleva
// fare scrivendone il nome.
async function vaiA(luogo) {
  el("lista-luoghi").hidden = true;
  el("luogo").blur();
  mappa.setView([luogo.lat, luogo.lon], 13);
  await cerca(luogo.lat, luogo.lon);
}

// ---------------------------------------------------------------- ricerca OSM

// Premere «Cerca qui» due volte di seguito nello stesso punto vuol dire
// "riprova davvero": la seconda volta si salta la memoria e si richiede a
// OpenStreetMap. È il gesto che tutti fanno quando un risultato non convince.
let ultimaRicerca = { dove: "", quando: 0 };

// Il tipo di percorso che si sta guardando: "tutti", "MTB", "Ciclabile" o
// "Sentiero". Vive in memoria e non si salva: e' una lente, non una scelta.
let filtroOsm = "tutti";

async function cerca(lat, lon) {
  const raggio = parseInt(el("raggio").value, 10);
  const controllo = new AbortController();

  const dove = `${lat.toFixed(3)},${lon.toFixed(3)},${raggio}`;
  const insiste = ultimaRicerca.dove === dove && Date.now() - ultimaRicerca.quando < 60000;
  ultimaRicerca = { dove, quando: Date.now() };

  let fonte = "rete";
  lavoro(true, "Interrogo OpenStreetMap…", () => controllo.abort());

  try {
    const risultati = await cercaPercorsi(lat, lon, raggio, {
      segnale: controllo.signal,
      onStato: lavoroDice,
      ignoraCache: insiste,
      onFonte: (f) => { fonte = f; },
    });
    mostraRisultatiOsm(risultati);
    if (!risultati.length) {
      // "Non c'è niente" è una conclusione: si mostra da chi arriva, così
      // non resta il dubbio che sia stato qualcuno a non rispondere.
      mostraDiagnostica();
      return;
    }

    const quanti = risultati.length === 1 ? "1 percorso trovato" : `${risultati.length} percorsi trovati`;
    // Se la risposta arriva dalla memoria va detto: altrimenti un elenco
    // vecchio di giorni sembra appena controllato.
    avvisa(
      fonte === "memoria"
        ? `${quanti} (dalla memoria del telefono — ripremi «Cerca qui» per aggiornare).`
        : `${quanti}.`
    );
  } catch (e) {
    if (e.annullata) {
      avvisa("Ricerca annullata.");
    } else {
      avvisa(e.message || "Ricerca non riuscita.", true);
      // Il referto: quali server, che esito, quanti secondi. Senza questo,
      // "non funziona" resta indistinguibile fra un servizio in coda, un
      // servizio che ci rifiuta e una connessione che non esce di casa.
      mostraDiagnostica();
    }
  } finally {
    lavoro(false);
  }
}

function mostraDiagnostica() {
  const righe = registroRete(8);
  if (!righe) return;
  el("osm-registro").textContent = righe;
  el("osm-diagnostica").hidden = false;
}

// Riempie l'elenco dei risultati OSM. Serve alla ricerca per zona e al tocco
// sulla mappa, che trovano le stesse cose e le mostrano allo stesso modo.
function mostraRisultatiOsm(risultati, vuoto) {
  stato.risultatiOsm = risultati;
  el("osm-diagnostica").hidden = true;
  el("filtri-osm").hidden = !risultati.length;
  dipingiRisultatiOsm(vuoto);
}

// Ridisegna l'elenco applicando il filtro. Separato dalla ricerca perché il
// filtro cambia senza dover richiedere niente a nessuno.
function dipingiRisultatiOsm(vuoto) {
  const tutti = stato.risultatiOsm || [];
  const visibili = filtroOsm === "tutti" ? tutti : tutti.filter((r) => r.tipo === filtroOsm);

  const ul = el("lista-osm");
  ul.innerHTML = "";
  el("osm-vuota").hidden = visibili.length > 0;

  if (!visibili.length) {
    el("osm-vuota").textContent = tutti.length
      ? "Nessun percorso di questo tipo qui: prova un altro filtro."
      : vuoto ||
        "Nessun percorso mappato qui. La copertura OSM è disomogenea: sui Sibillini è ottima, sulle colline picene molto meno.";
    return;
  }

  for (const r of visibili) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="nome">
        ${testoSicuro(r.nome)}
        <div class="meta">
          ${testoSicuro(r.tipo)}${r.rete ? " · " + testoSicuro(r.rete) : ""}
          <br>tocca per vedere la traccia
        </div>
      </div>
      <span class="pillola osm">OSM</span>
    `;
    li.addEventListener("click", () => apriRisultatoOsm(r));
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------- tocco sulla mappa

// Le linee colorate dei percorsi che si vedono sulla mappa sono immagini:
// arrivano già disegnate dentro le piastrelle e non sanno di essere percorsi.
// Toccarle non può quindi "selezionarle" — ma si può chiedere che cosa passa
// nel punto toccato, ed è quello che uno si aspetta che succeda.
//
// Il raggio è stretto apposta: un dito su un telefono copre già una
// cinquantina di metri di mappa alla scala a cui si guardano i sentieri, e
// allargare vorrebbe dire tirare su mezza provincia a ogni tocco.
const RAGGIO_TOCCO = 150;

async function toccaMappa(e) {
  // Durante una registrazione o mentre si segue un percorso la mappa serve a
  // guardare dove sei: un tocco è quasi sempre una manovra, non una domanda.
  if (stato.guida || (tracker && tracker.attivo)) return;

  const { lat, lng } = e.latlng;
  const controllo = new AbortController();
  lavoro(true, "Guardo cosa passa di qui…", () => controllo.abort());

  try {
    const trovati = await cercaPercorsi(lat, lng, RAGGIO_TOCCO, {
      segnale: controllo.signal,
      onStato: lavoroDice,
    });

    if (!trovati.length) {
      avvisa("Nessun percorso mappato in questo punto. Prova a toccare sulla linea colorata.");
      return;
    }

    // Uno solo: è quello che volevi, si apre senza farti scegliere fra uno.
    if (trovati.length === 1) {
      lavoro(false);
      await apriRisultatoOsm(trovati[0]);
      return;
    }

    // Più di uno: qui passano due sentieri, e quale sia lo sai tu.
    mostraRisultatiOsm(trovati);
    mostraVista("cerca");
    avvisa(`${trovati.length} percorsi passano di qui: scegli quale.`);
  } catch (err) {
    if (err.annullata) avvisa("Annullato.");
    else avvisa(err.message || "Non riesco a guardare qui.", true);
  } finally {
    lavoro(false);
  }
}

// La traccia si scarica adesso, per questo percorso soltanto. È la parte
// pesante: quanto pesante dipende da quanto è lungo il giro, per questo si
// può annullare.
async function apriRisultatoOsm(risultato) {
  const controllo = new AbortController();
  lavoro(true, `Carico la traccia di ${risultato.nome}…`, () => controllo.abort());

  try {
    const traccia = await caricaTraccia(risultato.idOsm, {
      segnale: controllo.signal,
      onStato: lavoroDice,
    });
    apriPercorso({ ...risultato, ...traccia }, false);
  } catch (e) {
    if (e.annullata) avvisa("Caricamento annullato.");
    else avvisa(e.message || "Traccia non caricata.", true);
  } finally {
    lavoro(false);
  }
}

// ---------------------------------------------------------------- meteo e appoggi

// Il meteo si chiede da solo: e' una chiamata sola a un servizio affidabile,
// e in montagna e' l'informazione che decide se parti.
async function mostraMeteo(percorso) {
  const cima = puntoPiuAlto(percorso.punti);
  el("meteo").hidden = true;
  if (!cima) return;

  const apertura = stato.apertura;

  try {
    const giorni = await previsione(cima.lat, cima.lon);
    if (stato.apertura !== apertura) return;

    el("meteo-quota").textContent = `· ${Math.round(cima.ele)} m`;
    el("meteo-giorni").innerHTML = giorni
      .map((g) => {
        // Sopra i 2 mm di pioggia o i 35 km/h di vento la giornata cambia.
        const brutto = (g.pioggia || 0) >= 2 || (g.vento || 0) >= 35;
        return `<div class="meteo-giorno${brutto ? " brutto" : ""}">
          <span class="quando">${testoSicuro(g.giorno)}</span>
          <span class="gradi">${g.tMin ?? "—"}° / ${g.tMax ?? "—"}°</span>
          ${testoSicuro(g.cielo)}<br>
          ${g.pioggia ? `${g.pioggia} mm · ` : ""}${g.vento ?? "—"} km/h
        </div>`;
      })
      .join("");
    el("meteo").hidden = false;
  } catch (e) {
    // Il meteo e' un di piu': se non arriva, il percorso resta utilizzabile.
    console.warn("Meteo non disponibile:", e.message);
  }
}

// I punti d'appoggio invece si chiedono solo su richiesta: e' una query a
// Overpass, che e' il servizio piu' fragile fra quelli che usiamo.
async function mostraAppoggi() {
  if (!stato.attivo) return;
  const percorso = stato.attivo;
  const apertura = stato.apertura;

  lavoro(true, "Cerco fontane e ricoveri…");
  try {
    const punti = await cercaPunti(percorso.punti);
    if (stato.apertura !== apertura) return;

    const ul = el("lista-appoggi");
    ul.innerHTML = "";
    el("appoggi").hidden = false;
    el("appoggi-vuoto").hidden = punti.length > 0;

    for (const p of punti) {
      // Senza nome si usa il tipo come titolo, e allora non lo si ripete sotto.
      const titolo = p.nome || maiuscola(p.tipo);
      const sotto = [
        p.nome ? p.tipo : null,
        `dopo ${formattaDistanza(p.dopo)}`,
        p.scarto > 20 ? `${p.scarto} m fuori traccia` : null,
      ].filter(Boolean).join(" · ");

      const li = document.createElement("li");
      li.innerHTML = `
        <div class="nome">
          ${testoSicuro(titolo)}
          <div class="meta">${testoSicuro(sotto)}</div>
        </div>
      `;
      li.addEventListener("click", () => {
        mappa.setView([p.lat, p.lon], 16);
        mostraVista("mappa");
      });
      ul.appendChild(li);
    }

    avvisa(punti.length ? `${punti.length === 1 ? "1 punto trovato" : punti.length + " punti trovati"} lungo il percorso.` : "Nessuna fontana o ricovero mappato qui.");
  } catch (e) {
    avvisa(e.message, true);
  } finally {
    lavoro(false);
  }
}

// ---------------------------------------------------------------- quote

// Chiede le quote e aggiorna la scheda quando arrivano. Non blocca niente:
// mappa e distanza si vedono subito, dislivello e profilo si riempiono dopo.
async function chiediQuote(percorso, forzato = false) {
  if (stato.quoteInCorso === percorso) return;
  stato.quoteInCorso = percorso;

  const apertura = stato.apertura;
  profilo.imposta(percorso.punti, "Carico le quote…");

  try {
    const punti = await correggiQuote(percorso.punti);

    // Nel frattempo l'utente puo' aver aperto un altro percorso: in quel caso
    // questi dati non c'entrano piu' niente con quello che sta guardando.
    if (stato.apertura !== apertura) return;

    stato.attivo = { ...stato.attivo, punti, quoteCorrette: true };
    if (stato.attivoSalvato) {
      await db.salva(stato.attivo);
      await ricaricaLista();
    }

    rinfrescaStatistiche();
    profilo.imposta(stato.attivo.punti);
    mostraMeteo(stato.attivo);
    avvisa("Quote aggiunte dal modello del terreno.");
  } catch (e) {
    if (stato.apertura !== apertura) return;
    profilo.imposta(percorso.punti, "Quote non disponibili — riprova con «Correggi quote»");
    // All'apertura si resta discreti: il percorso e' comunque utilizzabile,
    // e un avviso rosso non richiesto sarebbe solo fastidio. Se invece il
    // pulsante l'hai premuto tu, meriti di sapere com'e' andata.
    if (forzato) avvisa(e.message, true);
  } finally {
    if (stato.quoteInCorso === percorso) stato.quoteInCorso = null;
  }
}

// ---------------------------------------------------------------- guida

async function avviaGuida() {
  if (!stato.attivo) return;
  fermaGuida(false);

  stato.guida = new Guida(stato.attivo);
  disegnaTraccia(stato.attivo.punti);
  el("guida").hidden = false;
  mostraVista("mappa");

  rilasciaSchermo = await tieniSchermoAcceso();
  fermaOsservazione = osservaPosizione(
    (posizione) => aggiornaGuida(posizione),
    (err) => {
      // Sotto un bosco il GPS sparisce e torna in continuazione: allarmare
      // a ogni buco renderebbe l'avviso rumore da ignorare. Si segnala solo
      // il permesso negato, che è l'unico caso in cui l'utente deve agire.
      if (err && err.code === 1) {
        avvisa("Permesso di geolocalizzazione negato: la guida non può funzionare.", true);
        fermaGuida(false);
      }
    }
  );

  avvisa(`Segui «${stato.attivo.nome}». Ti avviso se ti allontani dalla traccia.`);
}

function aggiornaGuida(posizione) {
  if (!stato.guida) return;
  const s = stato.guida.aggiorna(posizione);

  el("g-rimanente").textContent = formattaDistanza(s.rimanente);
  el("g-salita").textContent =
    s.salitaRimanente === null ? "—" : `${Math.round(s.salitaRimanente)} m`;
  el("g-scarto").textContent = `${Math.round(s.scarto)} m`;
  el("guida").classList.toggle("fuori", s.fuoriPercorso);

  mostraPosizione(posizione);
  mappa.panTo([posizione.lat, posizione.lon], { animate: false });

  // Si avvisa solo quando lo stato cambia, non a ogni lettura del GPS.
  if (s.appenaUscito) {
    avvisa("Fuori percorso: sei a più di 40 m dalla traccia.", true);
    vibra([200, 100, 200]);
  } else if (s.appenaRientrato) {
    avvisa("Di nuovo in traccia.");
    vibra(80);
  }

  if (s.arrivato) {
    avvisa("Sei in fondo al percorso.");
    fermaGuida(false);
  }
}

function fermaGuida(conAvviso = true) {
  if (fermaOsservazione) {
    fermaOsservazione();
    fermaOsservazione = null;
  }
  if (rilasciaSchermo) {
    rilasciaSchermo();
    rilasciaSchermo = null;
  }

  stato.guida = null;
  el("guida").hidden = true;
  el("guida").classList.remove("fuori");
  if (conAvviso) avvisa("Guida terminata.");
}

// Su Android vibra, su iOS no: è un di più, non un canale su cui contare.
function vibra(schema) {
  if (!navigator.vibrate) return;
  try {
    navigator.vibrate(schema);
  } catch (e) {
    /* niente: la vibrazione non è essenziale */
  }
}

// ---------------------------------------------------------------- azioni dettaglio

async function salvaAttivo() {
  if (!stato.attivo) return;
  const salvato = await db.salva({
    nome: stato.attivo.nome,
    punti: stato.attivo.punti,
    fonte: stato.attivo.fonte || "GPX",
    url: stato.attivo.url,
    versione: APP_VERSION,
  });
  stato.attivo = salvato;
  stato.attivoSalvato = true;
  el("btn-salva").hidden = true;
  el("btn-elimina").hidden = false;
  await ricaricaLista();
  avvisa("Percorso salvato sul dispositivo.");
}

async function correggiQuoteAttivo() {
  if (!stato.attivo) return;
  await chiediQuote(stato.attivo, true);
}

async function condividiAttivo() {
  if (!stato.attivo) return;

  const { url, troppoLungo, lunghezza } = creaLink(stato.attivo);

  if (troppoLungo) {
    avvisa(
      `Traccia troppo lunga per un link (${lunghezza} caratteri, limite ${LIMITE_URL}). Condividi il GPX.`,
      true
    );
    esportaAttivo();
    return;
  }

  const testo = `${stato.attivo.nome} — su SENTIERO`;

  if (navigator.share) {
    try {
      await navigator.share({ title: stato.attivo.nome, text: testo, url });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    avvisa("Link copiato negli appunti.");
  } catch (e) {
    prompt("Copia il link:", url);
  }
}

function esportaAttivo() {
  if (!stato.attivo) return;
  const testo = scriviGpx(stato.attivo);
  const blob = new Blob([testo], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = nomeFile(stato.attivo.nome);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function rinominaAttivo() {
  if (!stato.attivo) return;
  const nuovo = prompt("Nuovo nome:", stato.attivo.nome);
  if (nuovo === null) return;

  const pulito = nuovo.trim();
  if (!pulito) {
    avvisa("Il nome non può essere vuoto.", true);
    return;
  }

  stato.attivo = { ...stato.attivo, nome: pulito };
  el("dettaglio-nome").textContent = pulito;

  if (stato.attivoSalvato) {
    await db.salva(stato.attivo);
    await ricaricaLista();
  }
}

async function eliminaAttivo() {
  if (!stato.attivo || !stato.attivoSalvato) return;

  // I dati stanno solo qui: senza backend, un'eliminazione è definitiva.
  const ok = confirm(
    `Eliminare «${stato.attivo.nome}»?\n\nI percorsi sono salvati solo su questo dispositivo: l'operazione non è reversibile. Se ti serve, esporta prima il GPX.`
  );
  if (!ok) return;

  if (stato.guida) fermaGuida(false);
  await db.elimina(stato.attivo.id);
  stato.attivo = null;
  stato.attivoSalvato = false;
  puliscTraccia();
  await ricaricaLista();
  mostraVista("percorsi");
  avvisa("Percorso eliminato.");
}

// ---------------------------------------------------------------- import GPX e demo

async function importaFile(fileList) {
  const file = [...fileList];
  if (!file.length) return;

  lavoro(true, "Leggo il GPX…");
  let ultimo = null;
  let errori = 0;

  for (const f of file) {
    try {
      const testo = await f.text();
      const { nome, punti } = leggiGpx(testo);
      ultimo = await db.salva({
        nome: nome || f.name.replace(/\.gpx$/i, ""),
        punti,
        fonte: "GPX",
        versione: APP_VERSION,
      });
    } catch (e) {
      errori++;
      console.warn(f.name, e);
    }
  }

  lavoro(false);
  await ricaricaLista();

  if (errori) avvisa(`${errori} file non leggibili.`, true);
  if (ultimo) apriPercorso(ultimo, true);
}

async function caricaDemo() {
  lavoro(true, "Carico il percorso demo…");
  try {
    const risposta = await fetch("data/monte-ascensione.gpx");
    if (!risposta.ok) throw new Error("File demo non trovato.");

    const { nome, punti } = leggiGpx(await risposta.text());
    const salvato = await db.salva({ nome, punti, fonte: "GPX", versione: APP_VERSION });

    await ricaricaLista();
    apriPercorso(salvato, true);
    avvisa("Percorso demo caricato: è una traccia sintetica, serve a provare l'app.");
  } catch (e) {
    avvisa(e.message || "Demo non caricabile.", true);
  } finally {
    lavoro(false);
  }
}

// ---------------------------------------------------------------- report beta

// ---------------------------------------------------------------- fuori dall'app

// Aprire qualcosa che sta fuori — le mappe del telefono, WhatsApp — non è
// scontato come sembra.
//
// Quando SENTIERO gira nel browser, window.open apre una scheda e va bene.
// Quando invece è stato installato da icona, iOS lo esegue in un contenitore
// senza barra e senza schede: lì window.open non ha una finestra dove
// aprire, e spesso non fa assolutamente niente. Nessun errore, nessuna
// scheda: il pulsante sembra rotto.
//
// In quel caso si cambia indirizzo alla pagina stessa. iOS riconosce che
// l'indirizzo appartiene a un'altra app, la apre, e SENTIERO resta dov'era —
// tornando indietro lo si ritrova al suo posto.
function apriFuori(url) {
  const daIcona =
    navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);

  if (daIcona) {
    window.location.href = url;
    return;
  }

  const finestra = window.open(url, "_blank", "noopener");
  // Anche nel browser può capitare che il blocco pop-up dica di no.
  if (!finestra) window.location.href = url;
}

// ---------------------------------------------------------------- avvicinamento

// Il percorso comincia da qualche parte, e quella qualche parte non è casa
// tua: quasi sempre c'è un pezzo di strada da fare per arrivarci.
//
// Non lo navighiamo noi. Il telefono ha già un navigatore che conosce i sensi
// unici, i cantieri e il traffico, e sa parlare mentre guidi: gli si passa il
// punto di partenza e si toglie di mezzo. Rifarlo peggio non aiuterebbe
// nessuno — e ricalcolare un percorso stradale richiederebbe un altro
// servizio pubblico da interrogare, con le stesse code di Overpass.
function portamiAllInizio() {
  const percorso = stato.attivo;
  if (!percorso || !percorso.punti || !percorso.punti.length) return;

  const p = percorso.punti[0];
  const meta = `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;

  // Su iPhone si apre Mappe, che c'è sempre. Altrove Google Maps, che sa
  // anche le ciclabili.
  const suApple = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent);
  const url = suApple
    ? `https://maps.apple.com/?daddr=${meta}&dirflg=d`
    : `https://www.google.com/maps/dir/?api=1&destination=${meta}&travelmode=bicycling`;

  avvisa("Ti porto all'inizio del percorso con le mappe del telefono.");
  apriFuori(url);
}

function apriReport() {
  const parti = [
    "Segnalazione SENTIERO",
    `Versione: ${APP_VERSION}`,
    `Dispositivo: ${navigator.userAgent}`,
    `Schermo: ${window.innerWidth}×${window.innerHeight}`,
    `Contesto: ${stato.vista}${stato.attivo ? ` — «${stato.attivo.nome}»` : ""}`,
    `Percorsi salvati: ${stato.percorsi.length}`,
  ];

  // Le ultime chiamate alla rete: sono la differenza fra "non funziona" e
  // sapere quale server ha taciuto e per quanto.
  const rete = registroRete();
  if (rete) parti.push("", "Ultime chiamate:", rete);

  parti.push("", "Cosa è successo:", "");
  const url = `https://wa.me/${REPORT_WA}?text=${encodeURIComponent(parti.join("\n"))}`;
  apriFuori(url);
}

// ---------------------------------------------------------------- eventi

function collegaEventi() {
  for (const b of el("tab").querySelectorAll("button")) {
    b.addEventListener("click", () => mostraVista(b.dataset.vista));
  }

  for (const chip of el("filtri-osm").querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      filtroOsm = chip.dataset.tipo;
      for (const c of el("filtri-osm").querySelectorAll(".chip")) {
        c.classList.toggle("attivo", c === chip);
      }
      dipingiRisultatiOsm();
    });
  }

  el("velo-annulla").addEventListener("click", () => {
    if (annullaLavoro) annullaLavoro();
  });

  el("btn-avvicinamento").addEventListener("click", portamiAllInizio);

  el("btn-report").addEventListener("click", apriReport);
  el("btn-guida").addEventListener("click", mostraIntro);
  el("btn-indietro").addEventListener("click", () => mostraVista(stato.vistaPrecedente));

  el("btn-importa").addEventListener("click", () => el("file-gpx").click());
  el("file-gpx").addEventListener("change", (e) => {
    importaFile(e.target.files);
    e.target.value = "";
  });
  el("btn-demo").addEventListener("click", caricaDemo);

  el("btn-avvia").addEventListener("click", avviaRegistrazione);
  el("btn-ferma").addEventListener("click", fermaRegistrazione);
  el("btn-pausa").addEventListener("click", () => {
    if (tracker.inPausa) {
      tracker.riprendi();
      el("btn-pausa").textContent = "Pausa";
    } else {
      tracker.pausa();
      el("btn-pausa").textContent = "Riprendi";
    }
  });

  el("btn-vai").addEventListener("click", cercaLuoghi);
  el("luogo").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      cercaLuoghi();
    }
  });

  el("btn-cerca-qui").addEventListener("click", () => {
    const c = mappa.getCenter();
    cerca(c.lat, c.lng);
  });

  el("btn-vicino").addEventListener("click", async () => {
    lavoro(true, "Cerco la tua posizione…");
    try {
      const p = await posizioneAttuale();
      lavoro(false);
      mappa.setView([p.lat, p.lon], 13);
      mostraPosizione(p);
      await cerca(p.lat, p.lon);
    } catch (e) {
      lavoro(false);
      avvisa(e.message, true);
    }
  });

  el("btn-segui").addEventListener("click", avviaGuida);
  el("btn-esci-guida").addEventListener("click", () => fermaGuida());
  el("btn-salva").addEventListener("click", salvaAttivo);
  el("btn-quote").addEventListener("click", correggiQuoteAttivo);
  el("btn-condividi").addEventListener("click", condividiAttivo);
  el("btn-esporta").addEventListener("click", esportaAttivo);
  el("btn-appoggi").addEventListener("click", mostraAppoggi);
  el("btn-rinomina").addEventListener("click", rinominaAttivo);
  el("btn-elimina").addEventListener("click", eliminaAttivo);

  // Un link condiviso può arrivare mentre l'app è già aperta.
  window.addEventListener("hashchange", () => {
    const condiviso = leggiLink();
    if (condiviso) apriCondiviso(condiviso);
  });

  // Chiudere la scheda durante una registrazione perderebbe il giro.
  window.addEventListener("beforeunload", (e) => {
    if (tracker && tracker.attivo) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

function mostraPosizione(p) {
  if (marcatorePosizione) mappa.removeLayer(marcatorePosizione);
  marcatorePosizione = L.marker([p.lat, p.lon], {
    icon: L.divIcon({ className: "", html: '<div class="marcatore-posizione"></div>', iconSize: [14, 14] }),
  }).addTo(mappa);
}

function preparaProfilo() {
  profilo = new Profilo(el("profilo"), { onHover: evidenziaSullaMappa });
}

// ---------------------------------------------------------------- utilità UI

let timerToast = null;

function avvisa(messaggio, errore = false) {
  const t = el("toast");
  t.textContent = messaggio;
  t.classList.toggle("errore", !!errore);
  t.hidden = false;

  clearTimeout(timerToast);
  timerToast = setTimeout(() => {
    t.hidden = true;
  }, errore ? 6000 : 3500);
}

// Il velo. `suAnnulla`, se c'è, fa comparire il pulsante che interrompe.
// Un'attesa senza via d'uscita è il modo più veloce per far credere che
// l'app sia morta: se qualcosa può durare, deve poter finire quando vuoi tu.
let annullaLavoro = null;

function lavoro(attivo, testo = "Un attimo…", suAnnulla = null) {
  el("velo-testo").textContent = testo;
  el("velo").hidden = !attivo;
  annullaLavoro = attivo ? suAnnulla : null;
  el("velo-annulla").hidden = !(attivo && suAnnulla);
}

// Cambia solo la scritta, se il velo è ancora quello di prima.
function lavoroDice(testo) {
  if (!el("velo").hidden) el("velo-testo").textContent = testo;
}

function maiuscola(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function testoSicuro(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

// ---------------------------------------------------------------- service worker

function registraServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // Su file:// la registrazione fallisce: è normale in sviluppo senza server.
  if (location.protocol === "file:") return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW:", e));
  });
}

// Esposto per il debug dalla console durante la beta.
window.SENTIERO = { stato, db, statistiche, haversine, APP_VERSION };

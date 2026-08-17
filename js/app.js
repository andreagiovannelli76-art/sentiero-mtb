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
import { Tracker, posizioneAttuale } from "./tracker.js";
import { creaLink, leggiLink, LIMITE_URL } from "./share.js";
import { correggiQuote } from "./elevation.js";
import { cercaPercorsi } from "./osm.js";

export const APP_VERSION = "0.4-beta";

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
};

let mappa;
let layerTraccia = null;
let marcatorePunto = null;
let layerRegistrazione = null;
let marcatorePosizione = null;
let profilo = null;
let tracker = null;

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------- avvio

avvia().catch((e) => {
  console.error(e);
  avvisa("Errore in avvio: " + e.message, true);
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
  if (condiviso) apriCondiviso(condiviso);
  else mostraVista("mappa");
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
  stato.attivo = percorso;
  stato.attivoSalvato = !!salvato;

  el("dettaglio-nome").textContent = percorso.nome || "Percorso";
  el("btn-salva").hidden = !!salvato;
  el("btn-elimina").hidden = !salvato;

  rinfrescaStatistiche();
  disegnaTraccia(percorso.punti);
  profilo.imposta(percorso.punti);
  mostraVista("dettaglio");
}

function rinfrescaStatistiche() {
  const p = stato.attivo;
  if (!p) return;
  const s = statistiche(p.punti);

  const voci = [
    ["Distanza", formattaDistanza(s.distanza)],
    ["D+", `${s.dPiu} m`],
    ["D−", `${s.dMeno} m`],
    ["Quota max", s.quotaMax !== null ? `${s.quotaMax} m` : "—"],
    ["Pend. max", s.pendenzaMax ? `${s.pendenzaMax}%` : "—"],
    ["Difficoltà", s.difficolta],
  ];
  if (s.durata) voci.push(["Durata", formattaDurata(s.durata)]);

  el("dettaglio-stat").innerHTML = voci
    .map(([k, v]) => `<div class="voce"><span>${k}</span><strong>${testoSicuro(v)}</strong></div>`)
    .join("");
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

// ---------------------------------------------------------------- ricerca OSM

async function cerca(lat, lon) {
  const raggio = parseInt(el("raggio").value, 10);
  lavoro(true, "Interrogo OpenStreetMap…");

  try {
    const risultati = await cercaPercorsi(lat, lon, raggio);
    stato.risultatiOsm = risultati;

    const ul = el("lista-osm");
    ul.innerHTML = "";
    el("osm-vuota").hidden = risultati.length > 0;

    if (!risultati.length) {
      el("osm-vuota").textContent =
        "Nessun percorso mappato qui. La copertura OSM è disomogenea: sui Sibillini è ottima, sulle colline picene molto meno.";
      return;
    }

    for (const r of risultati) {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="nome">
          ${testoSicuro(r.nome)}
          <div class="meta">
            ${formattaDistanza(r.distanza)} · ${testoSicuro(r.tipo)}${r.rete ? " · " + testoSicuro(r.rete) : ""}${r.frammentato ? " · traccia incompleta su OSM" : ""}
          </div>
        </div>
        <span class="pillola osm">OSM</span>
      `;
      li.addEventListener("click", () => apriPercorso({ ...r }, false));
      ul.appendChild(li);
    }

    avvisa(`${risultati.length} percorsi trovati.`);
  } catch (e) {
    avvisa(e.message || "Ricerca non riuscita.", true);
  } finally {
    lavoro(false);
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
  lavoro(true, "Chiedo le quote a Open-Elevation…");

  try {
    const puntiCorretti = await correggiQuote(stato.attivo.punti, (fatti, totali) => {
      el("velo-testo").textContent = `Quote corrette: ${fatti}/${totali} blocchi…`;
    });

    stato.attivo = { ...stato.attivo, punti: puntiCorretti, quoteCorrette: true };
    if (stato.attivoSalvato) {
      await db.salva(stato.attivo);
      await ricaricaLista();
    }

    rinfrescaStatistiche();
    profilo.imposta(stato.attivo.punti);
    avvisa("Quote corrette. Il dislivello ora è calcolato sul modello del terreno.");
  } catch (e) {
    avvisa(e.message || "Correzione quote non riuscita.", true);
  } finally {
    lavoro(false);
  }
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

function apriReport() {
  const parti = [
    "Segnalazione SENTIERO",
    `Versione: ${APP_VERSION}`,
    `Dispositivo: ${navigator.userAgent}`,
    `Schermo: ${window.innerWidth}×${window.innerHeight}`,
    `Contesto: ${stato.vista}${stato.attivo ? ` — «${stato.attivo.nome}»` : ""}`,
    `Percorsi salvati: ${stato.percorsi.length}`,
    "",
    "Cosa è successo:",
    "",
  ];
  const url = `https://wa.me/${REPORT_WA}?text=${encodeURIComponent(parti.join("\n"))}`;
  window.open(url, "_blank", "noopener");
}

// ---------------------------------------------------------------- eventi

function collegaEventi() {
  for (const b of el("tab").querySelectorAll("button")) {
    b.addEventListener("click", () => mostraVista(b.dataset.vista));
  }

  el("btn-report").addEventListener("click", apriReport);
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

  el("btn-salva").addEventListener("click", salvaAttivo);
  el("btn-quote").addEventListener("click", correggiQuoteAttivo);
  el("btn-condividi").addEventListener("click", condividiAttivo);
  el("btn-esporta").addEventListener("click", esportaAttivo);
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

function lavoro(attivo, testo = "Un attimo…") {
  el("velo-testo").textContent = testo;
  el("velo").hidden = !attivo;
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

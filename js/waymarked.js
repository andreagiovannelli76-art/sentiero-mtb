// waymarked.js — l'elenco dei percorsi, chiesto a chi ha già la risposta pronta.
//
// Waymarked Trails è lo stesso progetto di cui usiamo l'overlay sulle mappe:
// prende i dati di OpenStreetMap e ne tiene un database dedicato ai soli
// percorsi segnati, aggiornato di continuo.
//
// La differenza con Overpass non è la velocità della macchina, è la domanda.
// A Overpass chiediamo "cerca in tutto OpenStreetMap le relazioni route=mtb
// dentro questo riquadro", e lui la esegue da zero, in coda dietro a tutti.
// A Waymarked Trails chiediamo "dammi i percorsi di questo riquadro", che è
// l'unica domanda a cui il loro database sa rispondere — e infatti la
// risposta è già calcolata.
//
// Non sostituisce Overpass: se questa fonte non risponde, o risponde in un
// formato che non riconosciamo, chi chiama passa all'altra. Meglio lenti che
// fermi.

import { chiediJson } from "./rete.js";

// Due discipline, due database. L'MTB ha i percorsi tecnici, il ciclismo le
// ciclabili segnate: sono elenchi diversi e li vogliamo entrambi, come già
// facevamo con le due query a Overpass.
// L'ordine conta: un percorso presente in piu' elenchi tiene la prima
// classificazione, quindi la piu' specifica va per prima.
const FONTI = [
  { url: "https://mtb.waymarkedtrails.org/api/v1/list/by_area", tipo: "MTB" },
  { url: "https://cycling.waymarkedtrails.org/api/v1/list/by_area", tipo: "Ciclabile" },
  // I sentieri numerati che si vedono in viola sulla mappa — il 7, l'8, la
  // rete CAI — sono censiti come percorsi escursionistici, non ciclabili.
  // Ma sono esattamente dove si pedala in MTB sull'Appennino: escluderli
  // vuol dire rispondere "qui non c'e' niente" davanti a un sentiero segnato.
  { url: "https://hiking.waymarkedtrails.org/api/v1/list/by_area", tipo: "Sentiero" },
];

const SCADENZA = 12000;
const QUANTI = 60;

// Cerca nel riquadro (minLat, minLon, maxLat, maxLon).
// Ritorna { percorsi, riconosciuto }:
//   percorsi     — [{ id, idOsm, nome, tipo, rete, fonte, url }]
//   riconosciuto — la risposta aveva la forma che ci aspettiamo
//
// La distinzione conta. Un elenco vuoto da una risposta riconosciuta vuol
// dire "qui non c'è niente", ed è una risposta: non serve andare a disturbare
// Overpass, e soprattutto non si deve mostrare un errore a chi ha solo cercato
// in una zona senza percorsi mappati. Un elenco vuoto da una risposta che non
// abbiamo saputo leggere, invece, non vuol dire niente.
//
// Lancia un errore se NESSUNA delle due fonti ha risposto.
export async function cercaPercorsi(minLat, minLon, maxLat, maxLon, opzioni = {}) {
  const riquadro = [minLon, minLat, maxLon, maxLat].map((n) => n.toFixed(5)).join(",");

  const risposte = await Promise.allSettled(
    FONTI.map((f) =>
      chiediJson(`${f.url}?bbox=${riquadro}&limit=${QUANTI}`, {
        headers: { Accept: "application/json" },
        scadenza: SCADENZA,
        segnale: opzioni.segnale,
      }).then((esito) => {
        if (!esito.ok) throw new Error(`stato ${esito.stato}`);
        return { tipo: f.tipo, ...estrai(esito.dati) };
      })
    )
  );

  const riuscite = risposte.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!riuscite.length) {
    throw new Error("Waymarked Trails non ha risposto.");
  }

  // Un percorso può stare in entrambi gli elenchi: si tiene il primo, che è
  // l'MTB, perché è la classificazione più specifica.
  const visti = new Set();
  const percorsi = [];

  for (const { tipo, voci } of riuscite) {
    for (const v of voci) {
      if (visti.has(v.id)) continue;
      visti.add(v.id);
      percorsi.push({
        id: `osm_${v.id}`,
        idOsm: v.id,
        nome: v.nome,
        tipo,
        rete: v.rete,
        fonte: "OpenStreetMap",
        url: `https://www.openstreetmap.org/relation/${v.id}`,
      });
    }
  }

  return {
    percorsi: percorsi.sort((a, b) => a.nome.localeCompare(b.nome, "it")),
    riconosciuto: riuscite.some((r) => r.riconosciuto),
  };
}

// Il formato è documentato ma non è nostro: se un giorno cambia, si preferisce
// restituire una lista vuota e lasciare che chi chiama passi a Overpass,
// piuttosto che rompersi su una proprietà mancante.
function estrai(dati) {
  // "Riconosciuta" vuol dire che ci abbiamo trovato la lista dove ce
  // l'aspettavamo, non che contenga qualcosa.
  const riconosciuto = Array.isArray(dati) || Array.isArray(dati && dati.results);
  const grezzi = Array.isArray(dati) ? dati : (dati && dati.results) || [];
  const voci = [];

  for (const r of grezzi) {
    if (!r || typeof r !== "object") continue;
    const id = Number(r.id);
    if (!Number.isFinite(id) || id <= 0) continue;

    const nome = testo(r.name) || testo(r.ref) || `Percorso OSM ${id}`;
    voci.push({ id, nome, rete: rete(r) });
  }

  return { voci, riconosciuto };
}

function testo(v) {
  return typeof v === "string" ? v.trim() : "";
}

// "lcn" e "rcn" sono sigle e vanno in maiuscolo. Ma qui arrivano anche nomi
// per esteso — «Gli Anelli Ascolani» — e urlarli in maiuscolo li rende
// illeggibili in una riga già stretta.
function rete(r) {
  const v = testo(r.group) || testo(r.network);
  if (!v) return "";
  return v.length <= 4 ? v.toUpperCase() : v;
}

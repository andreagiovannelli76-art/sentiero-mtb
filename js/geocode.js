// geocode.js — trovare un posto per nome, con Nominatim (OpenStreetMap).
//
// Gratuito e senza chiave, ma è un servizio offerto per cortesia: la sua
// politica d'uso chiede di non superare una richiesta al secondo e di non
// interrogarlo a ogni tasto premuto. Per questo si cerca solo su invio o sul
// pulsante, mai mentre si scrive.

import { chiediJson } from "./rete.js";

const ENDPOINT = "https://nominatim.openstreetmap.org/search";

// Un minimo di respiro fra due ricerche, anche se l'utente insiste.
const PAUSA_MINIMA = 1100;
let ultimaRichiesta = 0;

// Cerca un luogo. Ritorna [{ nome, lat, lon, tipo }], al massimo `quanti`.
export async function cercaLuogo(testo, quanti = 6) {
  const query = String(testo || "").trim();
  if (query.length < 2) return [];

  const attesa = PAUSA_MINIMA - (Date.now() - ultimaRichiesta);
  if (attesa > 0) await new Promise((r) => setTimeout(r, attesa));
  ultimaRichiesta = Date.now();

  const url =
    `${ENDPOINT}?format=jsonv2&limit=${quanti}` +
    `&accept-language=it&q=${encodeURIComponent(query)}`;

  let esito;
  try {
    esito = await chiediJson(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    throw new Error(
      e.scaduta
        ? "La ricerca dei luoghi non ha risposto in tempo. Riprova."
        : "Ricerca dei luoghi non raggiungibile. Controlla la connessione."
    );
  }

  if (esito.stato === 429) {
    throw new Error("Troppe ricerche di seguito: aspetta qualche secondo.");
  }
  if (!esito.ok) {
    throw new Error(`La ricerca dei luoghi ha risposto ${esito.stato}.`);
  }

  const dati = esito.dati;
  if (!Array.isArray(dati)) return [];

  return dati
    .filter((r) => isFinite(parseFloat(r.lat)) && isFinite(parseFloat(r.lon)))
    .map((r) => ({
      nome: r.display_name,
      breve: accorcia(r.display_name),
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      tipo: etichetta(r),
    }));
}

// Il nome completo di Nominatim arriva lunghissimo ("Amandola, Fermo, Marche,
// Italia, ..."): in lista bastano le prime voci.
function accorcia(nome) {
  return String(nome || "").split(",").slice(0, 3).join(",").trim();
}

function etichetta(r) {
  const tipi = {
    peak: "cima",
    village: "paese",
    town: "paese",
    city: "città",
    hamlet: "frazione",
    municipality: "comune",
    administrative: "comune",
    mountain_range: "gruppo montuoso",
    ridge: "cresta",
    saddle: "sella",
    water: "acqua",
    river: "fiume",
    wood: "bosco",
    forest: "bosco",
    locality: "località",
  };
  return tipi[r.type] || tipi[r.addresstype] || "";
}

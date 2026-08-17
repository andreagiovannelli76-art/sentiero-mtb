// elevation.js — correzione delle quote tramite Open-Elevation.
// Servizio pubblico e rate-limited: si procede a blocchi, con pause, e si accetta
// che su tracce molto lunghe la richiesta possa fallire.

const ENDPOINT = "https://api.open-elevation.com/api/v1/lookup";
const BLOCCO = 100;      // punti per richiesta
const PAUSA_MS = 250;    // respiro fra un blocco e il successivo

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

// Corregge le quote di una traccia.
// `onProgresso(fatti, totali)` è opzionale e serve alla barra di avanzamento.
// Ritorna un nuovo array di punti: l'originale non viene modificato.
export async function correggiQuote(punti, onProgresso) {
  if (!punti || !punti.length) return [];

  // Si interroga il servizio su una traccia campionata: le quote intermedie
  // vengono poi interpolate. Riduce di molto le richieste senza perdere il profilo.
  const passo = Math.max(1, Math.ceil(punti.length / 600));
  const indici = [];
  for (let i = 0; i < punti.length; i += passo) indici.push(i);
  if (indici[indici.length - 1] !== punti.length - 1) indici.push(punti.length - 1);

  const quote = new Map();

  for (let i = 0; i < indici.length; i += BLOCCO) {
    const fetta = indici.slice(i, i + BLOCCO);
    const locations = fetta.map((k) => ({
      latitude: punti[k].lat,
      longitude: punti[k].lon,
    }));

    const risposta = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locations }),
    });

    if (!risposta.ok) {
      throw new Error(
        risposta.status === 429
          ? "Open-Elevation ha rifiutato la richiesta: troppe chiamate, riprova fra qualche minuto."
          : `Open-Elevation non risponde (${risposta.status}).`
      );
    }

    const dati = await risposta.json();
    const risultati = dati && dati.results ? dati.results : [];
    risultati.forEach((r, j) => {
      const k = fetta[j];
      if (k !== undefined && typeof r.elevation === "number") {
        quote.set(k, r.elevation);
      }
    });

    if (onProgresso) onProgresso(Math.min(i + BLOCCO, indici.length), indici.length);
    if (i + BLOCCO < indici.length) await attesa(PAUSA_MS);
  }

  if (!quote.size) throw new Error("Open-Elevation non ha restituito quote utilizzabili.");

  return interpola(punti, indici, quote);
}

// Assegna a ogni punto la quota nota più vicina, interpolando linearmente
// fra i due indici campionati che lo racchiudono.
function interpola(punti, indici, quote) {
  const noti = indici.filter((k) => quote.has(k));
  if (!noti.length) return punti.map((p) => ({ ...p }));

  const out = punti.map((p) => ({ ...p }));
  let cursore = 0;

  for (let i = 0; i < out.length; i++) {
    while (cursore < noti.length - 1 && noti[cursore + 1] < i) cursore++;

    const a = noti[cursore];
    const b = noti[Math.min(cursore + 1, noti.length - 1)];

    if (a === b || i <= a) {
      out[i].ele = quote.get(a);
    } else if (i >= b) {
      out[i].ele = quote.get(b);
    } else {
      const t = (i - a) / (b - a);
      out[i].ele = quote.get(a) + (quote.get(b) - quote.get(a)) * t;
    }
    out[i].ele = Math.round(out[i].ele * 10) / 10;
  }

  return out;
}

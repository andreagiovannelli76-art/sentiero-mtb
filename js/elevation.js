// elevation.js — quote del terreno da fonti pubbliche e gratuite.
//
// Tre servizi in cascata: se il primo non risponde o risponde male si passa al
// successivo. Nessuno richiede una chiave e tutti accettano le chiamate dal
// browser, quindi il vincolo "niente backend" resta intatto.
//
// L'ordine non è casuale: prima il servizio più affidabile, poi quello più
// preciso sulle nostre montagne, infine quello storico come ultima rete.

const PROVIDER = [
  {
    nome: "Open-Meteo",
    // Copernicus DEM a 90 m. È il più stabile dei tre e non ha un tetto
    // giornaliero stretto: per questo apre la fila.
    blocco: 100,
    pausa: 200,
    async chiedi(punti) {
      const lat = punti.map((p) => p.lat.toFixed(6)).join(",");
      const lon = punti.map((p) => p.lon.toFixed(6)).join(",");
      const risposta = await fetch(
        `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`
      );
      if (!risposta.ok) throw new Error(`stato ${risposta.status}`);
      const dati = await risposta.json();
      if (!Array.isArray(dati.elevation)) throw new Error("risposta senza quote");
      return dati.elevation;
    },
  },
  {
    nome: "OpenTopoData",
    // EU-DEM a 25 m: la griglia più fitta sull'Appennino, quindi le quote
    // migliori. In cambio il servizio pubblico accetta una chiamata al
    // secondo e mille al giorno, ed è il motivo per cui non è il primo.
    blocco: 100,
    pausa: 1100,
    async chiedi(punti) {
      const luoghi = punti.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join("|");
      const risposta = await fetch(
        `https://api.opentopodata.org/v1/eu_dem25m?locations=${luoghi}`
      );
      if (!risposta.ok) throw new Error(`stato ${risposta.status}`);
      const dati = await risposta.json();
      if (!Array.isArray(dati.results)) throw new Error("risposta senza quote");
      return dati.results.map((r) => r.elevation);
    },
  },
  {
    nome: "Open-Elevation",
    // La fonte storica del progetto. Resta come ultima possibilità: quando
    // risponde va bene, ma è giù spesso.
    blocco: 100,
    pausa: 250,
    async chiedi(punti) {
      const risposta = await fetch("https://api.open-elevation.com/api/v1/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locations: punti.map((p) => ({ latitude: p.lat, longitude: p.lon })),
        }),
      });
      if (!risposta.ok) throw new Error(`stato ${risposta.status}`);
      const dati = await risposta.json();
      if (!Array.isArray(dati.results)) throw new Error("risposta senza quote");
      return dati.results.map((r) => r.elevation);
    },
  },
];

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

// Corregge le quote di una traccia interrogando la prima fonte che risponde.
// `onProgresso(fatti, totali, nomeFonte)` è opzionale.
// Ritorna un nuovo array di punti: l'originale non viene modificato.
export async function correggiQuote(punti, onProgresso) {
  if (!punti || !punti.length) return [];

  // Non si chiede una quota per ogni punto: si campiona la traccia e si
  // interpolano le quote intermedie. Il profilo non cambia, le chiamate sì.
  const passo = Math.max(1, Math.ceil(punti.length / 600));
  const indici = [];
  for (let i = 0; i < punti.length; i += passo) indici.push(i);
  if (indici[indici.length - 1] !== punti.length - 1) indici.push(punti.length - 1);

  let ultimoErrore = null;

  for (const fonte of PROVIDER) {
    try {
      const quote = await interroga(fonte, punti, indici, onProgresso);
      return interpola(punti, indici, quote);
    } catch (e) {
      ultimoErrore = e;
      console.warn(`Quote da ${fonte.nome} non riuscite:`, e.message);
    }
  }

  throw new Error(
    "Nessuna delle fonti di quote ha risposto. Sono servizi pubblici e gratuiti: riprova fra qualche minuto."
  );
}

async function interroga(fonte, punti, indici, onProgresso) {
  const quote = new Map();

  for (let i = 0; i < indici.length; i += fonte.blocco) {
    const fetta = indici.slice(i, i + fonte.blocco);
    const valori = await fonte.chiedi(fetta.map((k) => punti[k]));

    let validi = 0;
    valori.forEach((q, j) => {
      const k = fetta[j];
      if (k !== undefined && typeof q === "number" && isFinite(q)) {
        quote.set(k, q);
        validi++;
      }
    });

    // Fuori copertura una fonte risponde con null: meglio passare alla
    // prossima che riempire il profilo di buchi.
    if (!validi) throw new Error("nessuna quota utilizzabile nel blocco");

    if (onProgresso) onProgresso(Math.min(i + fonte.blocco, indici.length), indici.length, fonte.nome);
    if (i + fonte.blocco < indici.length) await attesa(fonte.pausa);
  }

  if (!quote.size) throw new Error("nessuna quota restituita");
  return quote;
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

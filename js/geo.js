// geo.js — calcoli geografici: distanze, statistiche di un giro, semplificazione traccia.
// Nessuna dipendenza esterna: solo matematica.

const R_TERRA = 6371000; // raggio medio terrestre, metri

const rad = (gradi) => (gradi * Math.PI) / 180;

// Distanza in metri fra due punti {lat, lon}, formula dell'emisenoverso.
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const lat1 = rad(a.lat);
  const lat2 = rad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_TERRA * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Lunghezza totale in metri di una sequenza di punti.
export function lunghezza(punti) {
  let tot = 0;
  for (let i = 1; i < punti.length; i++) tot += haversine(punti[i - 1], punti[i]);
  return tot;
}

// Distanza progressiva cumulata, in metri, un valore per punto.
export function progressive(punti) {
  const out = new Array(punti.length);
  out[0] = 0;
  for (let i = 1; i < punti.length; i++) {
    out[i] = out[i - 1] + haversine(punti[i - 1], punti[i]);
  }
  return out;
}

// Soglia in metri sotto la quale una variazione di quota è considerata rumore GPS.
const SOGLIA_QUOTA = 3;

// Lunghezza della finestra su cui si misura la pendenza massima.
// Misurarla fra due punti consecutivi è inaffidabile: un GPS che sbaglia la quota
// di 5 m su 10 m di percorso dichiara il 50%. Su 100 m lo stesso errore pesa il 5%,
// e la finestra non dipende da quanto sono fitti i punti della traccia.
const FINESTRA_PENDENZA = 100;

// Statistiche complete di un giro.
// Ritorna { distanza, dPiu, dMeno, quotaMin, quotaMax, pendenzaMax, difficolta, durata }
export function statistiche(punti) {
  const vuoto = {
    distanza: 0, dPiu: 0, dMeno: 0,
    quotaMin: null, quotaMax: null,
    pendenzaMax: 0, difficolta: "—", durata: null,
  };
  if (!punti || punti.length < 2) return vuoto;

  const dist = progressive(punti);
  const distanza = dist[dist.length - 1];

  let dPiu = 0;
  let dMeno = 0;
  let quotaMin = Infinity;
  let quotaMax = -Infinity;

  // Quota di riferimento per l'accumulo: si sposta solo quando lo scarto supera la soglia.
  let riferimento = quotaDi(punti[0]);

  for (let i = 0; i < punti.length; i++) {
    const q = quotaDi(punti[i]);
    if (q !== null) {
      if (q < quotaMin) quotaMin = q;
      if (q > quotaMax) quotaMax = q;
    }

    if (i === 0) continue;

    if (q !== null && riferimento !== null) {
      const scarto = q - riferimento;
      if (Math.abs(scarto) >= SOGLIA_QUOTA) {
        if (scarto > 0) dPiu += scarto;
        else dMeno += -scarto;
        riferimento = q;
      }
    } else if (riferimento === null) {
      riferimento = q;
    }
  }

  return {
    distanza,
    dPiu: Math.round(dPiu),
    dMeno: Math.round(dMeno),
    quotaMin: quotaMin === Infinity ? null : Math.round(quotaMin),
    quotaMax: quotaMax === -Infinity ? null : Math.round(quotaMax),
    pendenzaMax: pendenzaMassima(punti, dist),
    difficolta: difficolta(distanza / 1000, dPiu),
    durata: durata(punti),
  };
}

// Pendenza massima su finestre mobili di FINESTRA_PENDENZA metri.
// Due indici che avanzano insieme: la traccia viene percorsa una volta sola.
export function pendenzaMassima(punti, dist = progressive(punti)) {
  let max = 0;
  let j = 0;

  for (let i = 0; i < punti.length - 1; i++) {
    if (j < i) j = i;
    while (j < punti.length - 1 && dist[j] - dist[i] < FINESTRA_PENDENZA) j++;

    const d = dist[j] - dist[i];
    // La finestra non si chiude più: da qui in poi resta solo la coda della traccia.
    if (d < FINESTRA_PENDENZA) break;

    const a = quotaDi(punti[i]);
    const b = quotaDi(punti[j]);
    if (a === null || b === null) continue;

    const p = (Math.abs(b - a) / d) * 100;
    if (p > max) max = p;
  }

  // Tracce più corte della finestra: si misura la pendenza sull'intero percorso.
  if (max === 0) {
    const totale = dist[dist.length - 1];
    const a = quotaDi(punti[0]);
    const b = quotaDi(punti[punti.length - 1]);
    if (totale > 20 && a !== null && b !== null) {
      max = (Math.abs(b - a) / totale) * 100;
    }
  }

  return Math.round(max * 10) / 10;
}

function quotaDi(p) {
  return typeof p.ele === "number" && isFinite(p.ele) ? p.ele : null;
}

// Durata in secondi fra primo e ultimo punto con timestamp, null se assenti.
function durata(punti) {
  const primo = punti.find((p) => p.t);
  const ultimo = [...punti].reverse().find((p) => p.t);
  if (!primo || !ultimo || primo === ultimo) return null;
  const s = (new Date(ultimo.t) - new Date(primo.t)) / 1000;
  return s > 0 ? Math.round(s) : null;
}

// Difficoltà indicativa per MTB.
// Due fattori: la fatica complessiva (chilometri più dislivello) e la pendenza
// media. Un giro corto ma con 70 m di dislivello per chilometro è duro anche se
// dura poco: senza il secondo fattore risulterebbe "Facile".
const LIVELLI = ["Facile", "Medio", "Impegnativo", "Molto impegnativo"];

export function difficolta(km, dPiu) {
  if (!km) return "—";

  const fatica = km + dPiu / 100;
  let livello = 0;
  if (fatica >= 20) livello = 1;
  if (fatica >= 40) livello = 2;
  if (fatica >= 65) livello = 3;

  // Salita sostenuta: si sale di un gradino.
  if (dPiu / km > 60) livello = Math.min(livello + 1, LIVELLI.length - 1);

  return LIVELLI[livello];
}

// Semplificazione Douglas-Peucker, tolleranza in metri.
// Usata per il link condivisibile e per alleggerire il disegno di tracce lunghe.
export function douglasPeucker(punti, tolleranza = 8) {
  if (!punti || punti.length < 3) return punti ? [...punti] : [];

  const tieni = new Uint8Array(punti.length);
  tieni[0] = 1;
  tieni[punti.length - 1] = 1;

  // Pila esplicita: evita la ricorsione profonda su tracce da decine di migliaia di punti.
  const pila = [[0, punti.length - 1]];
  while (pila.length) {
    const [inizio, fine] = pila.pop();
    let maxDist = 0;
    let indice = -1;
    for (let i = inizio + 1; i < fine; i++) {
      const d = distanzaDaSegmento(punti[i], punti[inizio], punti[fine]);
      if (d > maxDist) {
        maxDist = d;
        indice = i;
      }
    }
    if (indice !== -1 && maxDist > tolleranza) {
      tieni[indice] = 1;
      pila.push([inizio, indice], [indice, fine]);
    }
  }

  return punti.filter((_, i) => tieni[i]);
}

// Distanza punto-segmento in metri, proiezione equirettangolare locale:
// alle scale di un giro in MTB l'errore è trascurabile.
function distanzaDaSegmento(p, a, b) {
  const k = Math.cos(rad(a.lat));
  const px = rad(p.lon - a.lon) * k * R_TERRA;
  const py = rad(p.lat - a.lat) * R_TERRA;
  const bx = rad(b.lon - a.lon) * k * R_TERRA;
  const by = rad(b.lat - a.lat) * R_TERRA;

  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);

  let t = (px * bx + py * by) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - bx * t, py - by * t);
}

// Centro geometrico di una traccia, per centrare la mappa.
export function centro(punti) {
  if (!punti || !punti.length) return null;
  let lat = 0;
  let lon = 0;
  for (const p of punti) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / punti.length, lon: lon / punti.length };
}

// Formattazioni condivise dalla UI.
export function formattaDistanza(metri) {
  if (metri < 1000) return `${Math.round(metri)} m`;
  return `${(metri / 1000).toFixed(1)} km`;
}

export function formattaDurata(secondi) {
  if (!secondi && secondi !== 0) return "—";
  const h = Math.floor(secondi / 3600);
  const m = Math.floor((secondi % 3600) / 60);
  const s = Math.floor(secondi % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

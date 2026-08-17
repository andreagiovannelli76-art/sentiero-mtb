// share.js — condivisione di un percorso dentro l'URL, senza server.
// La traccia viene semplificata, compressa con pako e messa nel frammento (#r=...),
// che il browser non invia mai a Vercel: il percorso resta fra chi condivide e chi apre.

import { douglasPeucker } from "./geo.js";

// Oltre questa lunghezza il link diventa inaffidabile su WhatsApp e su alcuni browser:
// l'app propone allora la condivisione del file GPX.
export const LIMITE_URL = 8000;

// Costruisce il link condivisibile. Ritorna { url, lunghezza, troppoLungo }.
export function creaLink(percorso, base = location.href) {
  const semplificata = douglasPeucker(percorso.punti, 12);

  const compatto = {
    n: percorso.nome || "Percorso",
    p: semplificata.map((p) => {
      const riga = [arrotonda(p.lat, 5), arrotonda(p.lon, 5)];
      if (typeof p.ele === "number" && isFinite(p.ele)) riga.push(Math.round(p.ele));
      return riga;
    }),
  };

  const grezzo = pako.deflate(JSON.stringify(compatto));
  const codificato = base64UrlDa(grezzo);

  const radice = base.split("#")[0];
  const url = `${radice}#r=${codificato}`;

  return { url, lunghezza: url.length, troppoLungo: url.length > LIMITE_URL };
}

// Legge il frammento dell'URL corrente. Ritorna { nome, punti } oppure null.
export function leggiLink(hash = location.hash) {
  if (!hash || !hash.startsWith("#r=")) return null;

  try {
    const byte = byteDaBase64Url(hash.slice(3));
    const testo = pako.inflate(byte, { to: "string" });
    const dati = JSON.parse(testo);

    if (!dati || !Array.isArray(dati.p) || !dati.p.length) return null;

    const punti = dati.p
      .filter((r) => Array.isArray(r) && r.length >= 2)
      .map((r) => {
        const p = { lat: r[0], lon: r[1] };
        if (r.length > 2) p.ele = r[2];
        return p;
      });

    if (punti.length < 2) return null;
    return { nome: dati.n || "Percorso condiviso", punti };
  } catch (e) {
    console.warn("Link non leggibile:", e);
    return null;
  }
}

function arrotonda(n, decimali) {
  const k = 10 ** decimali;
  return Math.round(n * k) / k;
}

function base64UrlDa(byte) {
  let binario = "";
  const blocco = 0x8000; // si evita di superare il limite di argomenti di apply
  for (let i = 0; i < byte.length; i += blocco) {
    binario += String.fromCharCode.apply(null, byte.subarray(i, i + blocco));
  }
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function byteDaBase64Url(s) {
  const normale = s.replace(/-/g, "+").replace(/_/g, "/");
  const pieno = normale + "=".repeat((4 - (normale.length % 4)) % 4);
  const binario = atob(pieno);
  const byte = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) byte[i] = binario.charCodeAt(i);
  return byte;
}

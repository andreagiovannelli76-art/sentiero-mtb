// weather.js — previsioni sul punto più alto del percorso, da Open-Meteo.
//
// Gratuito, senza chiave, chiamabile dal browser: la stessa fonte che già
// usiamo per le quote. In montagna il meteo a valle non dice niente, quindi
// si chiede proprio in vetta, dove si decide se la giornata è quella giusta.

import { chiediJson } from "./rete.js";

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";

// Codici WMO. Non tutti: solo quelli che capitano davvero, raggruppati come
// li direbbe una persona.
const CIELO = {
  0: "sereno", 1: "poco nuvoloso", 2: "nuvoloso a tratti", 3: "coperto",
  45: "nebbia", 48: "nebbia gelata",
  51: "pioviggine", 53: "pioviggine", 55: "pioviggine forte",
  56: "pioviggine gelata", 57: "pioviggine gelata",
  61: "pioggia debole", 63: "pioggia", 65: "pioggia forte",
  66: "pioggia gelata", 67: "pioggia gelata",
  71: "neve debole", 73: "neve", 75: "neve forte", 77: "nevischio",
  80: "rovesci", 81: "rovesci", 82: "rovesci forti",
  85: "rovesci di neve", 86: "rovesci di neve",
  95: "temporale", 96: "temporale con grandine", 99: "temporale con grandine",
};

// Il punto più alto della traccia: è lì che si gela, tira vento e cambia tutto.
export function puntoPiuAlto(punti) {
  let migliore = null;
  for (const p of punti || []) {
    if (typeof p.ele !== "number" || !isFinite(p.ele)) continue;
    if (!migliore || p.ele > migliore.ele) migliore = p;
  }
  return migliore;
}

// Previsione a tre giorni sul punto indicato.
// Ritorna [{ giorno, cielo, tMin, tMax, pioggia, vento }].
export async function previsione(lat, lon, giorni = 3) {
  const url =
    `${ENDPOINT}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max` +
    `&timezone=auto&forecast_days=${giorni}`;

  let esito;
  try {
    esito = await chiediJson(url);
  } catch (e) {
    throw new Error(
      e.scaduta ? "Le previsioni non hanno risposto in tempo." : "Previsioni non raggiungibili."
    );
  }
  if (!esito.ok) throw new Error(`Le previsioni hanno risposto ${esito.stato}.`);

  const dati = esito.dati;
  const d = dati && dati.daily;
  if (!d || !Array.isArray(d.time)) throw new Error("Previsioni non leggibili.");

  // Open-Meteo ha rinominato alcuni campi mantenendo i vecchi: si leggono
  // entrambi, così un cambio di nome non lascia la scheda vuota.
  const codici = d.weathercode || d.weather_code || [];
  const vento = d.windspeed_10m_max || d.wind_speed_10m_max || [];

  return d.time.map((giorno, i) => ({
    giorno: nomeGiorno(giorno, i),
    cielo: CIELO[codici[i]] || "—",
    tMin: arrotonda(d.temperature_2m_min && d.temperature_2m_min[i]),
    tMax: arrotonda(d.temperature_2m_max && d.temperature_2m_max[i]),
    pioggia: arrotonda(d.precipitation_sum && d.precipitation_sum[i]),
    vento: arrotonda(vento[i]),
  }));
}

function arrotonda(v) {
  return typeof v === "number" && isFinite(v) ? Math.round(v) : null;
}

function nomeGiorno(iso, indice) {
  if (indice === 0) return "oggi";
  if (indice === 1) return "domani";
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("it-IT", { weekday: "long" });
}

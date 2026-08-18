// rete.js — una fetch che non resta appesa.
//
// `fetch` non ha una scadenza propria: se la connessione si apre e poi il
// pacchetto non arriva mai — il passaggio 5G/nessun campo di una salita è il
// caso tipico — la promessa non si risolve e non si rifiuta. Mai. Chi aspetta
// resta ad aspettare, il velo "Interrogo OpenStreetMap…" non si toglie più e
// l'app sembra morta pur essendo viva.
//
// Il `[timeout:60]` scritto dentro le query Overpass non c'entra: quello dice
// al server quanto può lavorare, non a noi quanto possiamo attendere.
//
// Qui si mette la scadenza dalla parte del telefono, con un AbortController.
// Il timer copre anche la lettura del corpo, non solo l'arrivo degli header:
// una risposta che si interrompe a metà è appesa esattamente come una che non
// comincia.

// Trenta secondi sono già oltre la soglia in cui chiunque riproverebbe.
export const SCADENZA = 25000;

// Chiede JSON a `url`. Le opzioni sono quelle di fetch, più:
//   scadenza — millisecondi prima di rinunciare (default SCADENZA)
//   segnale  — un AbortSignal esterno, per annullare a mano
//
// Ritorna { ok, stato, dati }: `dati` solo se ok. Uno stato HTTP diverso da
// 2xx non è un'eccezione — chi chiama vuole distinguere un 429 da un 504 —
// mentre rete assente, scadenza e annullamento lo sono.
export async function chiediJson(url, opzioni = {}) {
  const { scadenza = SCADENZA, segnale = null, ...richiesta } = opzioni;

  const controllo = new AbortController();
  const timer = setTimeout(() => controllo.abort(), scadenza);
  const inoltra = () => controllo.abort();

  if (segnale) {
    if (segnale.aborted) inoltra();
    else segnale.addEventListener("abort", inoltra);
  }

  try {
    const risposta = await fetch(url, { ...richiesta, signal: controllo.signal });
    if (!risposta.ok) return { ok: false, stato: risposta.status };
    return { ok: true, stato: risposta.status, dati: await risposta.json() };
  } catch (e) {
    // L'annullamento voluto viene prima: anche quando scattano insieme, è
    // quello che l'utente riconosce.
    if (segnale && segnale.aborted) throw annullata();
    if (controllo.signal.aborted) throw scaduta(scadenza);
    throw e;
  } finally {
    clearTimeout(timer);
    if (segnale) segnale.removeEventListener("abort", inoltra);
  }
}

function scaduta(ms) {
  const e = new Error(`Nessuna risposta entro ${Math.round(ms / 1000)} secondi.`);
  e.scaduta = true;
  return e;
}

function annullata() {
  const e = new Error("Annullato.");
  e.annullata = true;
  return e;
}

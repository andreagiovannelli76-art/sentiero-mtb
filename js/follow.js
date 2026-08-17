// follow.js — guida lungo un percorso già scelto.
//
// Non è un navigatore: non dà indicazioni di svolta né nomi di strade, perché
// servirebbero un motore di routing e un server. Dà le tre cose che servono
// davvero mentre segui una traccia in MTB: quanto manca, quanto devi ancora
// salire, e un avviso quando ti sei allontanato dal percorso.

import { haversine, progressive, proiettaSuSegmento } from "./geo.js";

// Oltre questa distanza dalla traccia si è fuori percorso.
const FUORI = 40;
// Si rientra solo sotto questa: l'isteresi evita che l'avviso lampeggi
// avanti e indietro quando il GPS oscilla intorno alla soglia.
const RIENTRO = 25;
// Punti da esaminare attorno all'ultima posizione nota. Su una traccia da
// migliaia di punti cercare ogni volta dall'inizio sarebbe uno spreco.
const FINESTRA = 80;
// Due punti della traccia più vicini di così alla posizione sono equivalenti:
// a parità si sceglie quello che dà continuità al percorso. Serve sugli
// anelli, dove partenza e arrivo sono lo stesso punto.
const PARITA = 1;

// Dislivello positivo cumulato lungo il percorso, con la stessa soglia
// antirumore usata dalle statistiche.
function salitaCumulata(punti) {
  const out = new Array(punti.length).fill(0);
  let riferimento = quota(punti[0]);
  let somma = 0;

  for (let i = 1; i < punti.length; i++) {
    const q = quota(punti[i]);
    if (q !== null && riferimento !== null) {
      const scarto = q - riferimento;
      if (Math.abs(scarto) >= 3) {
        if (scarto > 0) somma += scarto;
        riferimento = q;
      }
    } else if (riferimento === null) {
      riferimento = q;
    }
    out[i] = somma;
  }
  return out;
}

function quota(p) {
  return typeof p.ele === "number" && isFinite(p.ele) ? p.ele : null;
}

// Confronto lessicografico fra due terne di criteri.
function minore(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

export class Guida {
  constructor(percorso) {
    this.nome = percorso.nome;
    this.punti = percorso.punti;
    this.dist = progressive(this.punti);
    this.salita = salitaCumulata(this.punti);

    this.totale = this.dist[this.dist.length - 1];
    this.salitaTotale = this.salita[this.salita.length - 1];
    this.haQuote = this.punti.some((p) => quota(p) !== null);

    this.indice = 0;
    this.fuoriPercorso = false;
    // Su un anello partenza e arrivo coincidono: senza ricordare quanto si è
    // davvero percorso, l'app annuncerebbe l'arrivo dopo tre metri.
    this.progressoMax = 0;
  }

  // Ritorna lo stato della guida per una posizione {lat, lon}.
  aggiorna(posizione) {
    const { indice, t, scarto } = this._aggancia(posizione);
    this.indice = indice;

    // Isteresi: si esce oltre FUORI, si rientra solo sotto RIENTRO.
    const eraFuori = this.fuoriPercorso;
    if (scarto > FUORI) this.fuoriPercorso = true;
    else if (scarto < RIENTRO) this.fuoriPercorso = false;

    const fatto = this._interpola(this.dist, indice, t);
    const salitaFatta = this._interpola(this.salita, indice, t);
    if (fatto > this.progressoMax) this.progressoMax = fatto;

    return {
      scarto,
      fuoriPercorso: this.fuoriPercorso,
      // true solo nell'istante in cui lo stato cambia: serve alla UI per
      // avvisare una volta sola invece che a ogni aggiornamento del GPS.
      appenaUscito: this.fuoriPercorso && !eraFuori,
      appenaRientrato: !this.fuoriPercorso && eraFuori,
      fatto,
      rimanente: Math.max(0, this.totale - fatto),
      salitaRimanente: this.haQuote ? Math.max(0, this.salitaTotale - salitaFatta) : null,
      arrivato: this.totale - fatto < 30 && this.progressoMax > this.totale * 0.4,
    };
  }

  // Punto della traccia più vicino alla posizione. Si guarda in una finestra
  // attorno all'ultimo aggancio; se il minimo cade sul bordo della finestra
  // il vero minimo può stare fuori, e allora si allarga. Così un salto
  // improvviso viene recuperato senza riscorrere tutta la traccia a ogni
  // lettura del GPS.
  _aggancia(posizione) {
    let ampiezza = FINESTRA;
    let migliore = this._cerca(posizione, ampiezza);

    while (this._sulBordo(migliore.indice, ampiezza) && ampiezza < this.punti.length) {
      ampiezza *= 4;
      migliore = this._cerca(posizione, ampiezza);
    }
    return migliore;
  }

  // Il bordo conta solo se è un limite della finestra, non della traccia:
  // alla partenza l'indice 0 è legittimamente il primo e non va inseguito.
  _sulBordo(indice, ampiezza) {
    const bassoAperto = this.indice - ampiezza > 0;
    const altoAperto = this.indice + ampiezza < this.punti.length - 2;
    return (
      (bassoAperto && indice <= this.indice - ampiezza + 1) ||
      (altoAperto && indice >= this.indice + ampiezza - 1)
    );
  }

  _cerca(posizione, ampiezza) {
    const inizio = Math.max(0, this.indice - ampiezza);
    const fine = Math.min(this.punti.length - 2, this.indice + ampiezza);

    let scarto = Infinity;
    let indice = inizio;
    let t = 0;
    let punteggio = null;

    for (let i = inizio; i <= fine; i++) {
      const pr = proiettaSuSegmento(posizione, this.punti[i], this.punti[i + 1]);
      const suo = this._punteggio(pr.distanza, i);

      if (punteggio === null || minore(suo, punteggio)) {
        punteggio = suo;
        scarto = pr.distanza;
        indice = i;
        t = pr.t;
      }
    }

    // Traccia di un solo punto: non ci sono segmenti da proiettare.
    if (scarto === Infinity) {
      return { indice: 0, t: 0, scarto: haversine(posizione, this.punti[0]) };
    }
    return { indice, t, scarto };
  }

  // Criteri in ordine: prima la vicinanza, arrotondata perché sotto il metro
  // due punti sono equivalenti; poi il verso di marcia; infine la continuità.
  //
  // Il verso conta su un percorso ad anello, dove partenza e arrivo sono lo
  // stesso punto: senza preferire chi va avanti, arrivando in fondo l'app
  // crederebbe che tu debba ancora partire.
  _punteggio(distanza, i) {
    return [
      Math.round(distanza / PARITA),
      i >= this.indice ? 0 : 1,
      Math.abs(i - this.indice),
    ];
  }

  _interpola(valori, i, t) {
    const a = valori[i];
    const b = valori[Math.min(i + 1, valori.length - 1)];
    return a + (b - a) * t;
  }
}

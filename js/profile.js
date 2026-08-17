// profile.js — profilo altimetrico su canvas, sincronizzato con la mappa.
// Muovendo il dito o il mouse sul profilo, la mappa evidenzia il punto corrispondente.

import { progressive } from "./geo.js";

const COLORE_AREA = "rgba(63, 91, 55, 0.35)"; // moss
const COLORE_LINEA = "#3F5B37";               // moss
const COLORE_GRIGLIA = "rgba(27, 38, 32, 0.12)";
const COLORE_TESTO = "#5A6A5E";
const COLORE_CURSORE = "#C88B3C";             // dust

export class Profilo {
  constructor(canvas, { onHover } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onHover = onHover || (() => {});

    this.punti = [];
    this.dist = [];
    this.indiceAttivo = null;

    this._suMuovi = (e) => this._puntaDaEvento(e);
    this._suEsci = () => {
      this.indiceAttivo = null;
      this.onHover(null);
      this.disegna();
    };

    canvas.addEventListener("mousemove", this._suMuovi);
    canvas.addEventListener("mouseleave", this._suEsci);
    canvas.addEventListener("touchmove", this._suMuovi, { passive: true });
    canvas.addEventListener("touchend", this._suEsci);

    this._ridimensiona = () => this.disegna();
    window.addEventListener("resize", this._ridimensiona);
  }

  distruggi() {
    window.removeEventListener("resize", this._ridimensiona);
  }

  imposta(punti) {
    this.punti = (punti || []).filter((p) => typeof p.ele === "number" && isFinite(p.ele));
    this.completo = punti || [];
    this.dist = this.punti.length ? progressive(this.punti) : [];
    this.indiceAttivo = null;
    this.disegna();
  }

  get haQuote() {
    return this.punti.length > 1;
  }

  evidenzia(indice) {
    this.indiceAttivo = indice;
    this.disegna();
  }

  disegna() {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const larghezza = canvas.clientWidth || 320;
    const altezza = canvas.clientHeight || 120;

    canvas.width = Math.round(larghezza * dpr);
    canvas.height = Math.round(altezza * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, larghezza, altezza);

    if (!this.haQuote) {
      ctx.fillStyle = COLORE_TESTO;
      ctx.font = "13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Nessuna quota — premi «Correggi quote»", larghezza / 2, altezza / 2);
      ctx.textAlign = "start";
      return;
    }

    const padTop = 12;
    const padBasso = 18;
    const padSx = 38;
    const padDx = 8;

    const quote = this.punti.map((p) => p.ele);
    let qMin = Math.min(...quote);
    let qMax = Math.max(...quote);
    if (qMax - qMin < 10) {
      // Profilo piatto: si allarga la scala, altrimenti si disegna una riga di rumore.
      const centro = (qMax + qMin) / 2;
      qMin = centro - 5;
      qMax = centro + 5;
    }

    const dTot = this.dist[this.dist.length - 1] || 1;
    const x = (i) => padSx + (this.dist[i] / dTot) * (larghezza - padSx - padDx);
    const y = (q) => padTop + (1 - (q - qMin) / (qMax - qMin)) * (altezza - padTop - padBasso);

    // Griglia orizzontale e scala delle quote.
    ctx.strokeStyle = COLORE_GRIGLIA;
    ctx.fillStyle = COLORE_TESTO;
    ctx.font = "10px system-ui, sans-serif";
    ctx.lineWidth = 1;
    for (let k = 0; k <= 3; k++) {
      const q = qMin + ((qMax - qMin) * k) / 3;
      const yy = Math.round(y(q)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padSx, yy);
      ctx.lineTo(larghezza - padDx, yy);
      ctx.stroke();
      ctx.fillText(`${Math.round(q)}`, 4, yy + 3);
    }

    // Area sotto il profilo.
    ctx.beginPath();
    ctx.moveTo(x(0), y(quote[0]));
    for (let i = 1; i < this.punti.length; i++) ctx.lineTo(x(i), y(quote[i]));
    ctx.lineTo(x(this.punti.length - 1), altezza - padBasso);
    ctx.lineTo(x(0), altezza - padBasso);
    ctx.closePath();
    ctx.fillStyle = COLORE_AREA;
    ctx.fill();

    // Linea del profilo.
    ctx.beginPath();
    ctx.moveTo(x(0), y(quote[0]));
    for (let i = 1; i < this.punti.length; i++) ctx.lineTo(x(i), y(quote[i]));
    ctx.strokeStyle = COLORE_LINEA;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Etichette di distanza.
    ctx.fillStyle = COLORE_TESTO;
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText("0", padSx, altezza - 5);
    const etichetta = dTot >= 1000 ? `${(dTot / 1000).toFixed(1)} km` : `${Math.round(dTot)} m`;
    ctx.textAlign = "end";
    ctx.fillText(etichetta, larghezza - padDx, altezza - 5);
    ctx.textAlign = "start";

    // Cursore sincronizzato con la mappa.
    if (this.indiceAttivo !== null && this.punti[this.indiceAttivo]) {
      const xi = x(this.indiceAttivo);
      const yi = y(quote[this.indiceAttivo]);
      ctx.strokeStyle = COLORE_CURSORE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xi, padTop);
      ctx.lineTo(xi, altezza - padBasso);
      ctx.stroke();

      ctx.fillStyle = COLORE_CURSORE;
      ctx.beginPath();
      ctx.arc(xi, yi, 3.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#1B2620";
      ctx.font = "11px system-ui, sans-serif";
      const testo = `${Math.round(quote[this.indiceAttivo])} m`;
      ctx.textAlign = xi > larghezza / 2 ? "end" : "start";
      ctx.fillText(testo, xi + (xi > larghezza / 2 ? -6 : 6), padTop + 10);
      ctx.textAlign = "start";
    }
  }

  _puntaDaEvento(e) {
    if (!this.haQuote) return;
    const rect = this.canvas.getBoundingClientRect();
    const clientX = e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX;
    const px = clientX - rect.left;

    const padSx = 38;
    const padDx = 8;
    const utile = rect.width - padSx - padDx;
    const frazione = Math.max(0, Math.min(1, (px - padSx) / utile));
    const bersaglio = frazione * (this.dist[this.dist.length - 1] || 0);

    // Ricerca binaria sulla distanza progressiva.
    let lo = 0;
    let hi = this.dist.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.dist[mid] < bersaglio) lo = mid + 1;
      else hi = mid;
    }

    this.indiceAttivo = lo;
    this.disegna();
    this.onHover(this.punti[lo]);
  }
}

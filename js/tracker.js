// tracker.js — registrazione del giro tramite geolocalizzazione, con wake lock.
//
// Limite noto e non aggirabile dal web: a schermo spento i browser sospendono
// il watch della posizione. Il wake lock tiene lo schermo acceso finché la
// scheda è in primo piano; il tracciamento in background arriverà con il
// wrapper Capacitor (v1.0).

import { haversine } from "./geo.js";

// Punti con precisione peggiore di così vengono scartati: sono salti GPS.
const PRECISIONE_MAX = 40; // metri
// Sotto questa distanza il punto è considerato fermo e non viene registrato.
const PASSO_MIN = 4; // metri

export class Tracker {
  constructor({ onPunto, onStato, onErrore } = {}) {
    this.onPunto = onPunto || (() => {});
    this.onStato = onStato || (() => {});
    this.onErrore = onErrore || (() => {});

    this.punti = [];
    this.attivo = false;
    this.inPausa = false;
    this.watchId = null;
    this.wakeLock = null;
    this.scartati = 0;

    this._suVisibilita = () => {
      // Uscendo e rientrando dall'app il wake lock viene rilasciato dal sistema.
      if (this.attivo && !this.inPausa && document.visibilityState === "visible") {
        this._acquisisciWakeLock();
      }
    };
  }

  get disponibile() {
    return "geolocation" in navigator;
  }

  async avvia() {
    if (this.attivo) return;
    if (!this.disponibile) {
      this.onErrore("Questo browser non espone la geolocalizzazione.");
      return;
    }

    this.punti = [];
    this.scartati = 0;
    this.attivo = true;
    this.inPausa = false;

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this._suPosizione(pos),
      (err) => this._suErrore(err),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );

    document.addEventListener("visibilitychange", this._suVisibilita);
    await this._acquisisciWakeLock();
    this.onStato(this.stato());
  }

  pausa() {
    if (!this.attivo || this.inPausa) return;
    this.inPausa = true;
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this._rilasciaWakeLock();
    this.onStato(this.stato());
  }

  async riprendi() {
    if (!this.attivo || !this.inPausa) return;
    this.inPausa = false;
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this._suPosizione(pos),
      (err) => this._suErrore(err),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
    await this._acquisisciWakeLock();
    this.onStato(this.stato());
  }

  // Ferma la registrazione e restituisce i punti raccolti.
  ferma() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    document.removeEventListener("visibilitychange", this._suVisibilita);
    this._rilasciaWakeLock();

    this.attivo = false;
    this.inPausa = false;
    this.onStato(this.stato());
    return this.punti;
  }

  stato() {
    return {
      attivo: this.attivo,
      inPausa: this.inPausa,
      punti: this.punti.length,
      scartati: this.scartati,
      wakeLock: !!this.wakeLock,
    };
  }

  _suPosizione(pos) {
    const c = pos.coords;

    if (typeof c.accuracy === "number" && c.accuracy > PRECISIONE_MAX) {
      this.scartati++;
      this.onStato(this.stato());
      return;
    }

    const punto = {
      lat: c.latitude,
      lon: c.longitude,
      t: new Date(pos.timestamp).toISOString(),
      acc: c.accuracy,
    };
    if (typeof c.altitude === "number" && isFinite(c.altitude)) punto.ele = c.altitude;

    const ultimo = this.punti[this.punti.length - 1];
    if (ultimo && haversine(ultimo, punto) < PASSO_MIN) return;

    this.punti.push(punto);
    this.onPunto(punto, this.punti);
    this.onStato(this.stato());
  }

  _suErrore(err) {
    const messaggi = {
      1: "Permesso di geolocalizzazione negato. Va concesso dalle impostazioni del browser.",
      2: "Posizione non disponibile: segnale GPS assente.",
      3: "Il GPS non risponde. All'aperto ci mette meno.",
    };
    this.onErrore(messaggi[err.code] || "Errore di geolocalizzazione.");
  }

  async _acquisisciWakeLock() {
    if (!("wakeLock" in navigator) || this.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
      this.wakeLock.addEventListener("release", () => {
        this.wakeLock = null;
        this.onStato(this.stato());
      });
    } catch (e) {
      // Su iOS può fallire senza conseguenze: si registra comunque.
      this.wakeLock = null;
    }
  }

  _rilasciaWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  }
}

// Posizione singola, per "percorsi vicino a me" e per centrare la mappa.
export function posizioneAttuale(opzioni = {}) {
  return new Promise((risolvi, rifiuta) => {
    if (!("geolocation" in navigator)) {
      rifiuta(new Error("Geolocalizzazione non disponibile."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => risolvi({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy }),
      () => rifiuta(new Error("Posizione non disponibile. Concedi il permesso e riprova all'aperto.")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000, ...opzioni }
    );
  });
}

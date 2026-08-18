// intro.js — le tre schermate del primo avvio.
//
// Chi apre l'app per la prima volta vede una mappa e quattro icone, e non ha
// modo di sapere che il GPS si ferma a schermo spento o che i percorsi si
// cercano per nome. Tre schermate, saltabili, mostrate una volta sola.

// La chiave porta il numero della guida, non quello dell'app: cambiando le
// schermate si può decidere di rimostrarle senza legarle a ogni release.
const CHIAVE = "sentiero:intro";
const VERSIONE = "1";

const PASSI = [
  {
    titolo: "I tuoi giri, sul tuo telefono",
    testo:
      "SENTIERO registra i percorsi in mountain bike e ti fa trovare i sentieri già mappati intorno a te." +
      "\n\nNon c'è nessun account e nessun server: i giri restano su questo telefono. Se lo cambi, te li porti via con «Esporta GPX».",
  },
  {
    titolo: "Registrare un giro",
    testo:
      "Vai su Registra e premi Avvia. Alla fine, Ferma e salva: distanza, dislivello e profilo si calcolano da soli." +
      "\n\nUna cosa da sapere: a schermo spento il telefono ferma il GPS. È un limite dei browser, non dell'app — tieni SENTIERO in primo piano mentre registri.",
  },
  {
    titolo: "Trovare un percorso",
    testo:
      "In Cerca scrivi un posto — Amandola, Monte Vettore — e trovi i percorsi già mappati lì intorno, dal più vicino, con il fondo del sentiero." +
      "\n\nAprendone uno vedi profilo, meteo in vetta e le fontane lungo la strada. Con Segui ti avviso se ti allontani dalla traccia.",
  },
];

export function introGiaVista() {
  try {
    return localStorage.getItem(CHIAVE) === VERSIONE;
  } catch (e) {
    // Navigazione privata o storage negato: si fa finta di averla già vista,
    // meglio che riproporla a ogni apertura.
    return true;
  }
}

function segnaVista() {
  try {
    localStorage.setItem(CHIAVE, VERSIONE);
  } catch (e) {
    /* senza storage la guida ricomparirà: è il male minore */
  }
}

export function mostraIntro() {
  const velo = document.getElementById("intro");
  const corpo = document.getElementById("intro-passi");
  const punti = document.getElementById("intro-punti");
  const avanti = document.getElementById("intro-avanti");
  const salta = document.getElementById("intro-salta");
  if (!velo) return;

  let passo = 0;

  function disegna() {
    const p = PASSI[passo];
    corpo.innerHTML = `<h2>${p.titolo}</h2>` +
      p.testo.split("\n\n").map((t) => `<p>${t}</p>`).join("");

    punti.innerHTML = PASSI.map(
      (_, i) => `<span class="punto${i === passo ? " attivo" : ""}"></span>`
    ).join("");

    avanti.textContent = passo === PASSI.length - 1 ? "Iniziamo" : "Avanti";
    salta.hidden = passo === PASSI.length - 1;
  }

  function chiudi() {
    segnaVista();
    velo.hidden = true;
    document.removeEventListener("keydown", suTasto);
  }

  function suTasto(e) {
    if (e.key === "Escape") chiudi();
    if (e.key === "ArrowRight" || e.key === "Enter") prosegui();
  }

  function prosegui() {
    if (passo < PASSI.length - 1) {
      passo++;
      disegna();
    } else {
      chiudi();
    }
  }

  avanti.onclick = prosegui;
  salta.onclick = chiudi;
  document.addEventListener("keydown", suTasto);

  disegna();
  velo.hidden = false;
  avanti.focus();
}

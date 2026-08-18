// db.js — persistenza locale su IndexedDB. Nessun dato lascia il dispositivo.

const NOME_DB = "sentiero";
const STORE = "percorsi";

let connessione = null;

// Un errore gia' scritto per essere letto: si puo' mostrare cosi' com'e'.
// Gli altri restano in console e all'utente si dice qualcosa di utile.
function spiegato(testo) {
  const e = new Error(testo);
  e.spiegato = true;
  return e;
}

// Si apre SENZA chiedere un numero di versione: così si prende quella che c'è
// sul dispositivo, qualunque sia. Chiedere "versione 1" a un database che nel
// frattempo è passato alla 2 fa fallire l'apertura, e il numero cresce da solo
// ogni volta che si ripara — vedi sotto.
function apriGrezzo(versione) {
  return new Promise((risolvi, rifiuta) => {
    const req = versione ? indexedDB.open(NOME_DB, versione) : indexedDB.open(NOME_DB);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("data", "data");
      }
    };

    // "blocked" non è un fallimento: dice che un'altra scheda tiene ancora
    // aperta la versione precedente. Spessissimo quella scheda molla subito
    // dopo (glielo chiediamo noi con onversionchange) e l'apertura prosegue.
    // Quindi non si rinuncia subito: si aspetta, e si parla solo se dopo
    // cinque secondi non si è sbloccato davvero.
    let pazienza = null;
    const basta = () => clearTimeout(pazienza);

    req.onsuccess = () => { basta(); risolvi(req.result); };
    req.onerror = () => { basta(); rifiuta(req.error || new Error("apertura rifiutata")); };
    req.onblocked = () => {
      basta();
      pazienza = setTimeout(
        () => rifiuta(spiegato("SENTIERO è aperto in un'altra scheda: chiudila e ricarica.")),
        5000
      );
    };
  });
}

async function apri() {
  if (connessione) return connessione;

  let db;
  try {
    db = await apriGrezzo();
  } catch (e) {
    // Safari in navigazione privata, o spazio esaurito: senza archivio locale
    // l'app non può salvare niente, e va detto in italiano.
    console.error("IndexedDB non si apre:", e);
    throw spiegato(
      "Non riesco ad aprire l'archivio sul dispositivo. Se stai navigando in privato, riapri in una scheda normale."
    );
  }

  // Il database esiste ma il contenitore dei percorsi non c'è: capita quando
  // la primissima creazione viene interrotta a metà — su iPhone basta che
  // Safari chiuda la scheda in quel mezzo secondo. Il database resta lì,
  // vuoto e senza contenitore, e da quel momento ogni lettura fallisce con
  // "object store was not found". Si sale di una versione per far scattare
  // di nuovo la creazione, che questa volta va a buon fine.
  if (!db.objectStoreNames.contains(STORE)) {
    const prossima = db.version + 1;
    db.close();
    db = await apriGrezzo(prossima);
  }

  if (!db.objectStoreNames.contains(STORE)) {
    throw spiegato("Archivio dei percorsi non disponibile su questo dispositivo.");
  }

  // Se un'altra scheda deve aggiornare il database, questa molla la presa
  // invece di bloccarla.
  db.onversionchange = () => {
    db.close();
    if (connessione === db) connessione = null;
  };
  db.onclose = () => {
    if (connessione === db) connessione = null;
  };

  connessione = db;
  return connessione;
}

function transazione(modo, azione) {
  return apri().then(
    (db) =>
      new Promise((risolvi, rifiuta) => {
        const tx = db.transaction(STORE, modo);
        const store = tx.objectStore(STORE);
        let risultato;
        try {
          risultato = azione(store);
        } catch (e) {
          rifiuta(e);
          return;
        }
        tx.oncomplete = () => risolvi(risultato && risultato.result !== undefined ? risultato.result : risultato);
        tx.onerror = () => rifiuta(tx.error);
        tx.onabort = () => rifiuta(tx.error);
      })
  );
}

export function nuovoId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Salva o sovrascrive un percorso. Ritorna il percorso salvato, completo di id e data.
export async function salva(percorso) {
  const record = {
    ...percorso,
    id: percorso.id || nuovoId(),
    data: percorso.data || new Date().toISOString(),
  };
  await transazione("readwrite", (store) => store.put(record));
  return record;
}

// Tutti i percorsi, dal più recente al più vecchio.
export async function tutti() {
  const risultato = await transazione("readonly", (store) => store.getAll());
  const lista = risultato || [];
  return lista.sort((a, b) => String(b.data).localeCompare(String(a.data)));
}

export async function leggi(id) {
  return transazione("readonly", (store) => store.get(id));
}

export async function elimina(id) {
  await transazione("readwrite", (store) => store.delete(id));
}

export async function conta() {
  const risultato = await transazione("readonly", (store) => store.count());
  return risultato || 0;
}

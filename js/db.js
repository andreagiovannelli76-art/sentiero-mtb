// db.js — persistenza locale su IndexedDB. Nessun dato lascia il dispositivo.

const NOME_DB = "sentiero";
const VERSIONE_DB = 1;
const STORE = "percorsi";

let connessione = null;

function apri() {
  if (connessione) return Promise.resolve(connessione);

  return new Promise((risolvi, rifiuta) => {
    const req = indexedDB.open(NOME_DB, VERSIONE_DB);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("data", "data");
      }
    };

    req.onsuccess = () => {
      connessione = req.result;
      risolvi(connessione);
    };
    req.onerror = () => rifiuta(req.error);
  });
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

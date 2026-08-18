// registro.js — un diario delle chiamate alla rete, tenuto in memoria.
//
// Quando qualcosa non va sul telefono di qualcun altro, "non funziona" e uno
// screenshot non bastano: servono quale server, quanto ha aspettato, cosa ha
// risposto. Senza questi tre dati si tira a indovinare, e si pubblicano
// correzioni che non correggono niente.
//
// Resta tutto nel telefono e sparisce chiudendo la pagina. Finisce nel
// messaggio solo se sei tu a premere «Segnala un problema».

const MASSIMO = 25;
const righe = [];

export function annota(url, esito, ms) {
  let dove = url;
  try {
    const u = new URL(url);
    // Basta il server: l'indirizzo intero è illeggibile e non aggiunge niente.
    dove = u.hostname.replace(/^www\./, "");
  } catch (e) {
    /* url relativo: si tiene com'è */
  }

  righe.push(`${orario()} ${dove} → ${esito} (${Math.round(ms / 100) / 10}s)`);
  if (righe.length > MASSIMO) righe.shift();
}

// Le ultime `quante` righe, dalla più recente. Stringa vuota se non c'è niente.
export function testo(quante = 12) {
  return righe.slice(-quante).join("\n");
}

function orario() {
  const d = new Date();
  const due = (n) => String(n).padStart(2, "0");
  return `${due(d.getHours())}:${due(d.getMinutes())}:${due(d.getSeconds())}`;
}

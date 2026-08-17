// gpx.js — lettura e scrittura di file GPX.
// Il formato interno di un percorso è: { nome, punti: [{ lat, lon, ele, t }], ... }

// Legge una stringa GPX e ritorna { nome, punti }.
// Accetta sia <trkpt> (tracce registrate) sia <rtept> (percorsi pianificati).
export function leggiGpx(testo) {
  const dom = new DOMParser().parseFromString(testo, "application/xml");

  const errore = dom.querySelector("parsererror");
  if (errore) throw new Error("File GPX non valido");

  let nodi = [...dom.getElementsByTagName("trkpt")];
  if (!nodi.length) nodi = [...dom.getElementsByTagName("rtept")];
  if (!nodi.length) nodi = [...dom.getElementsByTagName("wpt")];
  if (!nodi.length) throw new Error("Nessun punto trovato nel GPX");

  const punti = [];
  for (const n of nodi) {
    const lat = parseFloat(n.getAttribute("lat"));
    const lon = parseFloat(n.getAttribute("lon"));
    if (!isFinite(lat) || !isFinite(lon)) continue;

    const p = { lat, lon };
    const ele = parseFloat(testoDi(n, "ele"));
    if (isFinite(ele)) p.ele = ele;
    const t = testoDi(n, "time");
    if (t) p.t = t;
    punti.push(p);
  }

  if (!punti.length) throw new Error("Nessun punto valido nel GPX");

  const nome =
    testoDi(dom.documentElement, "name") ||
    testoDi(dom.getElementsByTagName("trk")[0], "name") ||
    "Percorso importato";

  return { nome: nome.trim(), punti };
}

function testoDi(nodo, tag) {
  if (!nodo) return "";
  const el = nodo.getElementsByTagName(tag)[0];
  return el && el.textContent ? el.textContent.trim() : "";
}

// Genera il GPX di un percorso. Le quote e i tempi sono inclusi solo se presenti.
export function scriviGpx(percorso) {
  const nome = escapeXml(percorso.nome || "Percorso");
  const righe = percorso.punti.map((p) => {
    let s = `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">`;
    if (typeof p.ele === "number" && isFinite(p.ele)) {
      s += `\n        <ele>${p.ele.toFixed(1)}</ele>`;
    }
    if (p.t) s += `\n        <time>${escapeXml(p.t)}</time>`;
    s += `\n      </trkpt>`;
    return s;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="SENTIERO" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${nome}</name>
  </metadata>
  <trk>
    <name>${nome}</name>
    <trkseg>
${righe.join("\n")}
    </trkseg>
  </trk>
</gpx>
`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Nome file sicuro a partire dal titolo del percorso.
export function nomeFile(nome) {
  const pulito = String(nome || "percorso")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${pulito || "percorso"}.gpx`;
}

# SENTIERO

Web app per percorsi in mountain bike. Registri il giro, importi un GPX, guardi il profilo
altimetrico, scopri i sentieri già mappati su OpenStreetMap. Installabile come app dal browser.

**I dati restano sul tuo dispositivo.** Non c'è un server: i percorsi stanno in IndexedDB, sul
telefono o sul computer che stai usando. È una scelta di prodotto, non una funzione mancante.

Open source, licenza MIT. Di Andrea Giovannelli, Ascoli Piceno.

Versione: **0.5.2 beta**.

---

## Cosa fa

- **Registra** un giro con il GPS, con wake lock per tenere lo schermo acceso
- **Segui un percorso**: quanto manca, quanto devi ancora salire, e un avviso quando ti allontani più di 40 m dalla traccia
- **Importa ed esporta GPX** (Garmin, Komoot, Strava e chiunque altro)
- **Statistiche**: distanza, D+ / D−, quota massima, pendenza massima, difficoltà, durata
- **Profilo altimetrico** sincronizzato con la mappa: passi il dito sul profilo, il punto si accende sulla mappa
- **Correzione delle quote** via Open-Elevation, per quando il GPS del telefono sbaglia il dislivello
- **Percorsi già mappati**: cerca su OpenStreetMap le tracce `route=mtb` e le ciclabili locali e regionali
- **Condivisione senza server**: il link contiene la traccia compressa nel frammento dell'URL
- **Quattro sfondi mappa** (OpenTopoMap, OSM, satellite Esri, CyclOSM) e l'overlay Waymarked Trails MTB

## Come si avvia in locale

Non c'è niente da compilare e niente da installare. Serve solo un server statico, perché il
GPS e il service worker non funzionano aprendo il file con un doppio clic.

```bash
cd sentiero
python3 -m http.server 8080      # oppure: npx serve .
```

Poi apri <http://localhost:8080>. Il GPS funziona su `localhost` anche senza HTTPS.

## Struttura

```
index.html            UI
css/style.css         stili
js/app.js             orchestrazione (mappa, lista, dettaglio, tracking, ricerca OSM, report)
js/geo.js             haversine, statistiche (D+/D−, pendenza, difficoltà), Douglas-Peucker
js/gpx.js             lettura e scrittura GPX
js/db.js              IndexedDB
js/profile.js         profilo altimetrico su canvas
js/tracker.js         geolocalizzazione e wake lock
js/share.js           traccia compressa nell'URL (#r=...)
js/elevation.js       Open-Elevation
js/osm.js             Overpass: relation route=mtb / route=bicycle, concatenazione delle way
js/follow.js          guida lungo un percorso: scarto dalla traccia, quanto manca, quanto sali
sw.js                 service worker (cache del guscio)
manifest.webmanifest  PWA
icons/                icon-192, icon-512, icon.svg (sorgente delle altre due)
data/                 GPX demo del Monte Ascensione (traccia sintetica, non un sentiero reale)
vercel.json           no-cache su sw.js
```

Dipendenze esterne, entrambe da CDN: **Leaflet 1.9.4** e **pako 2.1.0**. Nessun bundler,
nessun passo di build, solo ES modules nativi.

## Pubblicazione

La cartella `sentiero/` va pubblicata come radice del sito: `vercel.json` presuppone che
`sw.js` risponda su `/sw.js`.

La versione va aggiornata in **tre punti**, sempre tutti e tre:

1. `index.html` — sottotitolo (`Percorsi MTB · open source · vX.Y beta`)
2. `js/app.js` — `APP_VERSION = "X.Y-beta"`
3. `sw.js` — `V = "sentiero-vN"`, incrementando `N`

Saltare il terzo punto significa lasciare la versione vecchia sui dispositivi dei tester.

Dopo il deploy: controlla che il sottotitolo online riporti la versione giusta e **ricarica due
volte** (il service worker si aggiorna al secondo caricamento). Su iOS può servire chiudere e
riaprire la scheda.

## Limiti noti

Sono vincoli consapevoli, non bug da segnalare:

- **Niente tracciamento a schermo spento.** I browser sospendono il GPS quando lo schermo si
  spegne. Il wake lock è già attivo. Si risolve solo con un wrapper nativo.
- **Open-Elevation è un servizio pubblico e rate-limited.** Su tracce lunghe o a raffica può
  rifiutare le richieste.
- **La copertura OSM è disomogenea.** Sibillini e ciclovie sono mappati bene, le colline picene
  molto meno. È il motivo per cui serve una community, non un difetto del codice.
- **Il link condivisibile contiene la traccia semplificata.** Oltre gli 8000 caratteri l'app
  propone il GPX al posto del link.

## Beta

C'è un pulsante ⚑ in alto a destra: apre WhatsApp con versione, dispositivo e contesto già
compilati. Serve per segnalare qualsiasi cosa non torni.

Utile da provare: installazione da Home, un tracciamento di 200–300 m a piedi, la correzione
delle quote su un giro registrato, la ricerca dei percorsi nella propria zona, un link
condiviso a un amico, l'import di un GPX da Garmin o Komoot.

## Licenza

MIT — vedi [LICENSE](LICENSE).

Dati cartografici © OpenStreetMap contributors. Quote da Open-Elevation.
Percorsi MTB da Waymarked Trails.

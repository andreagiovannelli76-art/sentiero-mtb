# SENTIERO — contesto di progetto

Web app open source (MIT) per percorsi in mountain bike, di Andrea Giovannelli (Ascoli Piceno).
PWA installabile, **nessun backend**, dati in IndexedDB. Fase attuale: **beta con primi tester**.
Obiettivo di business a medio termine: community di percorsi + guide a pagamento (Sibillini, Laga, Ascensione, Marche).

**Lingua:** tutto in italiano — UI, commenti, commit, risposte. Tono UI: essenziale, sportivo.

---

## Regole non negoziabili

1. **Non cambiare l'URL di produzione.** `https://sentiero-andreagiovannelli76-arts-projects.vercel.app` è già stato comunicato ai tester. Gli alias si aggiungono, non sostituiscono.
2. **Nessuna build, nessun framework, nessun bundler.** HTML/CSS/JS vanilla con ES modules. Se una soluzione richiede un passo di build, non è la soluzione giusta per questo progetto.
3. **Niente backend fino alla v0.6.** I dati restano sul dispositivo. È una scelta di prodotto, non una mancanza.
4. **Non "risolvere" i limiti noti** elencati sotto: sono vincoli consapevoli.
5. **Chiedi ad Andrea** prima di: eliminare qualcosa, scegliere nomi pubblici, introdurre costi ricorrenti. Non improvvisare.
6. **Mai committare `.vercel/`** né token. Il `.gitignore` li esclude: verifica che ci sia prima del primo commit.

---

## Stack

- HTML/CSS/JS vanilla, ES modules
- Leaflet 1.9.4 e pako 2.1.0 via unpkg (CDN, non in locale)
- Layer mappa: OpenTopoMap (default), OSM, Esri satellite, CyclOSM · Overlay: Waymarked Trails MTB
- Dati esterni: Overpass API (percorsi OSM), Open-Elevation (correzione quote)
- Hosting: Vercel, sito statico · Analytics: `/_vercel/insights/script.js` già in `index.html`
- Palette: pine `#1B2620` · moss `#3F5B37` · dust `#C88B3C` · chalk `#EFEADF`

## Struttura

```
index.html            UI
css/style.css         stili
js/app.js             orchestrazione (mappa, lista, dettaglio, tracking, OSM search, report)
js/geo.js             haversine, stats (D+/D-, pendenza max, difficoltà), Douglas-Peucker
js/gpx.js             parser/serializer GPX
js/db.js              IndexedDB
js/profile.js         profilo altimetrico canvas sincronizzato con mappa
js/tracker.js         geolocation watch + wake lock
js/share.js           traccia compressa in URL (#r=...)
js/elevation.js       Open-Elevation
js/osm.js             Overpass: relation route=mtb / route=bicycle (lcn/rcn), chaining way
sw.js                 service worker (cache shell)
manifest.webmanifest  PWA
icons/                icon-192, icon-512, icon.svg (sorgente)
data/                 GPX demo Monte Ascensione (sintetico)
vercel.json           no-cache su sw.js
```

---

## Stato deploy

| Voce | Valore |
|---|---|
| Progetto Vercel | `sentiero` |
| Team | `andreagiovannelli76-arts-projects` |
| Team ID | `team_4FD4UulZaV36wS7WrGcXt44F` |
| URL produzione | `https://sentiero-andreagiovannelli76-arts-projects.vercel.app` |
| Repo GitHub | `sentiero-mtb` (pubblico, MIT) — **TODO: inserire qui l'URL reale** |
| Alias breve | **TODO: da assegnare** — `sentiero.vercel.app` è occupato da terzi |
| Numero WhatsApp report | `393484791772` (costante `REPORT_WA` in `js/app.js`) — pubblico nel sorgente, Andrea ne è consapevole |

### Attenzione: Deployment Protection

Sul team la **Vercel Authentication è attiva per default**: ogni progetto nuovo nasce protetto e reindirizza a `vercel.com/login`, rendendolo inaccessibile ai tester. Verificato: anche un progetto creato da zero eredita la protezione.
**Dopo ogni nuovo progetto, o se i tester segnalano un login inatteso:** controlla il livello team *e* il livello progetto in Settings → Deployment Protection.

---

## Procedura di release

La versione va aggiornata in **tre punti**, sempre tutti e tre:

1. `index.html` — sottotitolo brand (`Percorsi MTB · open source · vX.Y beta`)
2. `js/app.js` — `APP_VERSION = "X.Y-beta"`
3. `sw.js` — `V = "sentiero-vN"` (incrementa `N`: senza questo il service worker serve la versione vecchia)

Poi:

```bash
# 1. test locale — il GPS funziona su localhost
python3 -m http.server 8080      # oppure: npx serve .
# apri http://localhost:8080 e verifica a mano

# 2. commit e push
git commit -am "vX.Y: <cosa>"
git push                          # se Vercel è collegato a GitHub, pubblica da solo

# 3. se Vercel NON è ancora collegato a GitHub
npx vercel --prod
```

**Verifica post-deploy, obbligatoria:**

- il sottotitolo online riporta la versione appena rilasciata
- **ricarica due volte**: il service worker si aggiorna al secondo caricamento
- su iOS può servire chiudere e riaprire la scheda

---

## Limiti noti — NON toccare

- **Niente tracciamento a schermo spento.** Limite dei browser, non un bug. Il wake lock è già attivo. Si risolve solo con il wrapper Capacitor (v1.0).
- **Open-Elevation è pubblico e rate-limited.** Per precisione servirà un DEM server-side (Supabase Edge + SRTM/Copernicus), previsto più avanti.
- **Copertura OSM disomogenea:** Sibillini e ciclovie ottime, colline picene scarse. È il motivo per cui serve la community, non un difetto da correggere nel codice.
- **Il link condivisibile contiene la traccia semplificata.** Oltre ~8000 caratteri l'app rimanda al GPX: è il comportamento voluto.

## Debiti tecnici noti — da valutare, non urgenti

1. **Pendenza max inaffidabile.** In `js/geo.js` il calcolo filtra i segmenti con `d > 15` metri: sul GPX demo restituisce `90%`, e su tracce GPS reali con quote rumorose produrrà regolarmente valori assurdi (50–100%). I tester lo segnaleranno come bug. Ipotesi di fix: soglia a 40–50 m, oppure pendenza su finestre mobili di ~100 m.
2. **Il service worker non mette in cache icone e GPX demo.** `SHELL` in `sw.js` elenca solo HTML/CSS/JS e il manifest: al primo avvio offline mancano l'icona PWA e il percorso dimostrativo. Aggiunta a basso rischio.

---

## Roadmap

Principio: **prima i percorsi esistenti (OSM), poi la community, poi il premium.**

| Ver. | Cosa | Note |
|---|---|---|
| 0.4 ✅ | Percorsi pubblici OSM (Overpass + overlay Waymarked Trails) | pronta |
| 0.5 | Fix dai feedback tester · guida primo avvio (3 schermate) · "percorsi vicino a me" ordinati per distanza GPS | |
| 0.6 | Backend Supabase: auth, libreria pubblica condivisa, "rendi pubblico" un giro, foto, autore, like/commenti | trasforma il tool in community |
| 0.7 | Schede guida: descrizione tecnica, POI (fontane, rifugi, punti pericolosi), stagionalità | base per le guide |
| 0.8 | Guide premium: flag `premium`, Stripe, accesso a pagamento · tile offline per zona | monetizzazione |
| 1.0 | Wrapper Capacitor per tracciamento in background e store | solo se i numeri lo giustificano |

## Decisioni aperte — chiedere ad Andrea quando servono

- Login community: Google, Apple o entrambi
- Nome definitivo / dominio proprio (es. `sentiero.bike`?)
- Modello premium: abbonamento vs guida singola

---

## Fase beta

Tester: Sergio, Sandra, Giovanni + altri. Canale feedback: **WhatsApp**, tramite il pulsante ⚑ in-app che precompila versione, dispositivo e contesto.

Cosa raccogliere: bug per dispositivo/browser · confronto D+ app vs ciclocomputer sullo stesso giro · funzioni mancanti · **GPX reali dei giri** (serviranno a popolare la libreria community della v0.6).

Checklist consigliata ai tester:

1. Installazione da Home (iOS Safari / Android Chrome), icona corretta
2. Tracciamento GPS 200–300 m a piedi: distanza plausibile, traccia sulla mappa, salvataggio
3. Correggi quote su un giro registrato → il D+ diventa realistico
4. 🌐 Cerca percorsi qui nella propria zona → import → profilo/dislivello
5. Condividi link a un amico → apre l'app con il percorso importato
6. Import GPX da Garmin/Komoot/Strava

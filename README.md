<p align="center"><img src="assets/mokie-mark.svg" width="96" alt="Mokie"></p>

# Mokie モキ

Mock server per API HTTP con **stato condiviso e persistente**, **proxy passthrough** verso i backend reali,
**ispezione del traffico** e **flussi interattivi** (pagine con CTA che reindirizzano al client).

```
                 ┌─ /_admin/        UI di amministrazione
                 ├─ /_admin/api/*   API REST + eventi live (SSE)
client ──► :8080 ┼─ /__mokie/p/*    pagine interattive dei flussi
                 └─ tutto il resto  motore mock ──(nessun mock attivo)──► backend reale
                                    └─ SQLite: mock, stato, sessioni, traffico
```

Tutto passa da **una sola porta**. I prefissi `/_admin/` e `/__mokie/` sono riservati a Mokie e non vengono mai
inoltrati ai backend; ogni altro path (incluso `/api/...`) appartiene alle tue API.

## Avvio rapido

Requisiti: Node.js ≥ 24 (usa il modulo integrato `node:sqlite`).

```bash
npm install
npm run dev          # server su :8080 (con watch) + UI Vite su http://localhost:5173/_admin/
```

In produzione:

```bash
npm run build        # compila la UI in packages/ui/dist
npm start            # UI servita su http://localhost:8080/_admin/
```

Con Docker: `docker compose up --build` (dati nel volume `mokie-data`).

| Variabile | Default | Significato |
|---|---|---|
| `MOKIE_PORT` | `8080` | l'unica porta: a questa puntano i client, la UI è su `/_admin/` |
| `MOKIE_HOST` | `0.0.0.0` | interfaccia di ascolto |
| `MOKIE_DB_PATH` | `data/mokie.db` | file SQLite |
| `MOKIE_PUBLIC_URL` | — | base degli URL delle pagine di flusso (altrimenti viene ricavata dall'header `Host`) |

Per provare subito il flusso di pagamento: **Impostazioni → Importa** `examples/payment-flow.json`.

## Concetti

### Backend
Ogni richiesta senza un mock attivo viene inoltrata così com'è al backend corrispondente: prima per header `Host`,
poi per prefisso di path più lungo (con rimozione del prefisso opzionale). Se nessun backend corrisponde si risponde 404 o 502
(configurabile).

### Mock
Un mock è definito da **metodo + path** (`/orders/:id`, `/files/*`, oppure una regex che inizia con `^`), da
**condizioni** di attivazione (tutte in AND oppure almeno una in OR) e da una **risposta**.
I mock sono valutati in ordine di priorità: vince il primo che corrisponde; se nessuno corrisponde la richiesta va al backend.

Condizioni disponibili: `header`, `query`, `cookie`, `param`, `body` (JSONPath, es. `$.user.id`), `state` (percorso nello
stato condiviso, es. `orders.{{params.id}}.status`) e `script` (espressione JS). Operatori: `equals`, `notEquals`,
`contains`, `notContains`, `regex`, `exists`, `notExists`, `gt`, `lt`. Chiavi e valori accettano template.

Le **collection** raggruppano i mock in scenari attivabili/disattivabili in blocco.

### Stato condiviso
Un unico documento JSON, persistito su SQLite e condiviso da tutti i mock e dalle pagine di flusso. Si modifica con gli
**effetti** dichiarativi del mock (`set`, `merge`, `incr`, `push`, `remove`), dagli script o a mano dalla UI.
Gli effetti vengono applicati *prima* di generare la risposta, che vede quindi lo stato aggiornato.
Gli snapshot permettono di salvare e ripristinare lo stato (es. prima di una suite di test).

### Template di risposta (Handlebars, senza escaping HTML)

| | |
|---|---|
| Richiesta | `{{params.id}}` `{{query.page}}` `{{headers.authorization}}` `{{cookies.sid}}` `{{body.user.name}}` |
| Stato | `{{state.cart.total}}` · `{{json state.cart}}` · `{{get state (concat 'orders.' params.id)}}` |
| Utility | `{{uuid}}` `{{id 'order'}}` (uuid stabile per tutta la richiesta: effetti + risposta) `{{now 'iso'\|'epoch'\|'date'}}` `{{randomInt 1 100}}` `{{default x 0}}` |
| Logica | `{{#if (eq a b)}}…{{else}}…{{/if}}` `{{#each state.items}}…{{/each}}` `and` `or` `not` `gt` `lt` `add` `sub` `mul` `length` |
| Flussi | `{{flowUrl 'payment' redirectUrl=body.redirect_url orderId=body.orderId}}` |

`{"a": {{x}}}` funziona: le graffe triple vengono gestite automaticamente.

### Script (opzionale)
Per i casi complessi un mock può avere uno script JavaScript (supporta `await`):

```js
const n = state.incr('attempts.' + params.id);
if (n < 3) return respond(503, { error: 'retry later', attempt: n });

const res = await forward();          // chiama il backend reale
res.body.mocked = true;               // ...e modifica la sua risposta
return res;
```

API: `req params query headers cookies body vars`, `state.get/set/merge/incr/push/remove/all`,
`respond(status, body, headers?)`, `forward({method?, path?, headers?, body?})`, `pass()` (rinuncia al mock e va al backend),
`flow.url(slug, ctx)`, `template(str)`, `uuid()`, `sleep(ms)`, `console.log`.
Se lo script non restituisce nulla viene usata la risposta definita nella tab "Risposta".

> Gli script girano in `node:vm` con timeout: **non** è una sandbox di sicurezza. Mokie è uno strumento di sviluppo,
> da non esporre su reti non fidate.

### Traffico
Tutte le richieste che transitano (mock, proxy, flussi, errori) sono registrate e visibili in tempo reale.
Da qualunque richiesta si può fare **"Crea mock"**: l'editor si apre precompilato con metodo, path (gli id diventano
parametri, es. `/orders/123` → `/orders/:orderId`), risposta reale del backend e condizioni suggerite
(parametri, query, header rilevanti, campi del body) da aggiungere con un clic.

La tab **Prova** dell'editor ha due pulsanti:
- **Valuta**: mostra quale mock risponderebbe e l'esito di ogni condizione, senza effetti collaterali;
- **Chiama**: invia davvero la richiesta come un client sulla porta proxy (`POST /_admin/api/mocks/call`) e mostra la risposta.
  Gli effetti sullo stato vengono applicati, la richiesta compare nel Traffico e, se nessun mock corrisponde, arriva al backend.

### Flussi interattivi
Una *pagina di flusso* è una pagina web servita da Mokie con un pulsante per ogni esito (CTA). Esempio di pagamento:

1. il client chiama `POST /payments` con `{"redirect_url": "https://shop/done", "orderId": "A1"}`;
2. il mock risponde con `{"paymentUrl": "{{flowUrl 'payment' redirectUrl=body.redirect_url orderId=body.orderId}}"}`,
   che crea una sessione e restituisce `http://<mokie>:8080/__mokie/p/<token>`;
3. l'utente apre la pagina e sceglie **Paga ora**, **Fondi insufficienti**, **Carta scaduta**, …;
4. la CTA applica i suoi effetti sullo stato (es. `payments.A1.status = FAILED`) e reindirizza (303) a
   `https://shop/done?status=KO&code=INSUFFICIENT_FUNDS&orderId=A1`;
5. le chiamate successive (es. `GET /payments/A1`) rispondono in modo coerente leggendo lo stato.

Il contesto della sessione (`ctx.*`) contiene i parametri passati a `flowUrl`. Il redirect è un template
(default `{{ctx.redirectUrl}}`) e ogni CTA aggiunge i propri parametri di query. Le sessioni sono monouso e scadono
dopo un TTL configurabile.

Per i test automatici si può saltare la pagina: `GET /__mokie/p/<token>?choose=<ctaId>`.

### Import / Export
Backend, collection, mock e pagine (ed eventualmente lo stato) si esportano in un JSON versionabile in git e si
reimportano da **Impostazioni** o via `POST /_admin/api/import`.

## Sviluppo

```
packages/shared   tipi e schemi zod condivisi
packages/server   Fastify: motore (engine/), stato (state/), flussi (flows/), traffico (traffic/), API admin (admin/)
packages/ui       React + Mantine + CodeMirror
examples/         bundle importabili
```

```bash
npm test             # vitest: unit + integrazione (backend finto, flusso di pagamento end-to-end, persistenza)
npm run typecheck
```

# Remote Guru

Browser SSH desktop (Electron) per navigare server remoti, con schede multiple,
split view e funzioni avanzate sui file.

## Avvio

```bash
npm install
npm run start
```

## Build

```bash
npm run dist:mac
```

## Funzionalità

- **Pagina di configurazione** all'avvio: aggiungi / modifica / elimina connessioni
  o selezionane una per connetterti. Le connessioni sono salvate in `servers.json`.
- **Due modalità di autenticazione** per server: password oppure file PEM
  (il campo password, in modalità PEM, è usato come passphrase opzionale della chiave).
- **Schede tipo browser**: più connessioni contemporanee.
- **Split view**: trascina una scheda dentro l'area del terminale per affiancare
  due sessioni a metà schermo; il divisore centrale è ridimensionabile.
- **Terminale reale** (xterm.js + shell PTY) → compatibile con vim, htop, sudo, ecc.
- **Ricerca nel buffer del terminale** (`Cmd`/`Ctrl+Shift`+`F`): barra in alto a destra
  con contatore dei risultati, evidenziazione di tutte le occorrenze, `Invio` /
  `Maiusc+Invio` per scorrerle e interruttori per maiuscole/minuscole ed espressioni
  regolari. `Esc` chiude.
- **Zoom del carattere per sessione** (`Cmd`/`Ctrl+Shift` con `+`, `-` e `0` per
  tornare al valore base): ogni scheda tiene la propria dimensione e il terminale
  remoto viene avvisato della nuova geometria.
- **Pulsante elenco `☰`** accanto al nome server: mostra il contenuto della cartella
  corrente (come `ll`). Le **cartelle sono cliccabili** (fanno `cd` automatico).
- **Menu tasto destro su file/cartelle** (nell'elenco): nuovo file, nuova cartella,
  rinomina, copia, taglia, incolla, elimina, comprimi (`.tar.gz` / `.zip`),
  estrai (per gli archivi), scarica in locale, calcola dimensione (per le cartelle)
  e **Proprietà** (tipo, proprietario, permessi, date, target dei link).
- **Selezione multipla** nell'elenco: clic per selezionare, `cmd`/`ctrl`+clic per
  aggiungere o togliere una voce, `shift`+clic per un intervallo. Con una selezione
  attiva compare una barra con le azioni di gruppo (scarica, copia, taglia,
  comprimi, elimina) e lo stesso vale nel menu contestuale; anche il trascinamento
  porta con sé tutte le voci selezionate.
- **Taglia / incolla** per spostare (`mv`): le voci tagliate restano visibili in
  trasparenza fino all'incollo. Incollando nella stessa cartella una copia prende
  il suffisso `_copy`, in un'altra cartella conserva il nome.
- **Upload trascinando dal Finder / Esplora file**: lasciando file o cartelle sul
  pannello elenco vengono accodati come upload nella cartella su cui si rilascia.
- **Drag & drop fra file browser**: trascinando un file o una cartella dall'elenco
  di una scheda a quello di un'altra si ottiene una copia esatta nella cartella di
  destinazione (quella della riga su cui si lascia il puntatore, o quella mostrata
  se si lascia sullo sfondo del pannello). Fra due schede dello stesso server la
  copia avviene lato server (`cp`); fra macchine diverse i dati passano dal disco
  locale — download in una cartella temporanea, poi upload — e le due fasi sono
  visibili nel pannello trasferimenti, entrambe sospendibili e riprendibili.
- **Query in corso** (pulsante ⚡ sulla riga di ogni database, si apre solo da lì):
  elenco di `pg_stat_activity` filtrato su quel solo database, con lucina di stato — verde query appena partita, giallo query attiva
  da oltre 5 secondi o transazione aperta e ferma (`idle in transaction`), rosso
  query in attesa di un lock o attiva da oltre un minuto. Per ogni riga durata,
  database, utente, evento di attesa, pid che la blocca (cliccabile: evidenzia la
  riga del bloccante) e testo della query, con *Annulla* (`pg_cancel_backend`) e
  *Termina* (`pg_terminate_backend`). Si aggiorna da sé ogni 4 secondi. Richiede
  PostgreSQL 10 o superiore.
- **Menu tasto destro sul terminale**: *Incolla password* (inserisce la password
  del server presa da `servers.json`).

## Formato `servers.json`

```json
[
  {
    "nickname": "Macchina TEST [203.0.113.10]",
    "name": "user@203.0.113.10",
    "host": "203.0.113.10",
    "port": 22,
    "username": "user",
    "usePem": true,
    "pemPath": "/path/to/key.pem",
    "password": ""
  }
]
```

Vedi `servers.example.json` per altri esempi. **Nota:** le password sono salvate in
chiaro, quindi `servers.json` è escluso dal versionamento (`.gitignore`).

## Architettura

- `src/main.js` — processo main Electron: finestra, IPC, lettura/scrittura `servers.json`, dialog.
- `src/ssh.js` — gestione sessioni SSH (`ssh2`): shell PTY + canale SFTP/exec per le funzioni file.
- `src/preload.js` — bridge sicuro (contextIsolation) tra renderer e main.
- `src/transfers.js` — coda dei trasferimenti file (download, upload e copie
  server → server), con avanzamento, pausa/ripresa e stato persistito su disco.
- `src/index.html` / `src/styles.css` / `src/renderer.js` — interfaccia (config, schede, terminale).

Il menu dell'applicazione è quello predefinito di Electron senza le voci di zoom
della pagina: i loro acceleratori (`Cmd`/`Ctrl` con `+`, `-`, `0`) servono allo
zoom del carattere del terminale, e un acceleratore di menu scavalcherebbe il
renderer.

La cwd corrente viene tracciata in modo affidabile tramite un marker invisibile
(`OSC 1337;CWD=...`) emesso dalla shell dopo ogni prompt e rimosso dal flusso prima
di mostrarlo a video.

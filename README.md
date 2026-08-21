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
npm run build:mac
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
- **Pulsante elenco `☰`** accanto al nome server: mostra il contenuto della cartella
  corrente (come `ll`). Le **cartelle sono cliccabili** (fanno `cd` automatico).
- **Menu tasto destro su file/cartelle** (nell'elenco): elimina, copia, incolla,
  scarica in locale (chiede la destinazione).
- **Drag & drop fra file browser**: trascinando un file o una cartella dall'elenco
  di una scheda a quello di un'altra si ottiene una copia esatta nella cartella di
  destinazione (quella della riga su cui si lascia il puntatore, o quella mostrata
  se si lascia sullo sfondo del pannello). Fra due schede dello stesso server la
  copia avviene lato server (`cp`); fra macchine diverse i dati passano dal disco
  locale — download in una cartella temporanea, poi upload — e le due fasi sono
  visibili nel pannello trasferimenti, entrambe sospendibili e riprendibili.
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

La cwd corrente viene tracciata in modo affidabile tramite un marker invisibile
(`OSC 1337;CWD=...`) emesso dalla shell dopo ogni prompt e rimosso dal flusso prima
di mostrarlo a video.

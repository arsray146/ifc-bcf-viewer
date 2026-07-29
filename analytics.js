/* ============================================================================
   analytics.js — statistiche di visita anonime (GoatCounter)

   Perché esiste: Cloudflare conta le richieste, non le funzioni. Il viewer è
   una pagina sola, quindi senza eventi non si sa se qualcuno usi davvero QTO,
   clash, IDS o la verifica nuvola ↔ modello: si vede solo "ha aperto /viewer/".

   Cosa esce da qui, e nient'altro:
     - il path della pagina (es. /viewer/, /tools/ifc-merge/)
     - il referrer, la dimensione dello schermo, la lingua del browser
     - il nome di un evento, scelto da una lista chiusa scritta qui sotto
   Cosa NON esce MAI: nomi dei file, GUID, contenuti del modello, numero di
   elementi, coordinate, e in generale qualunque dato del progetto aperto.
   I file restano sul computer dell'utente: questa promessa non cambia.

   Nessun cookie, nessun localStorage per il tracciamento, nessun profilo,
   nessun ID persistente: GoatCounter distingue le visite con un hash effimero
   lato server. Vedi https://www.goatcounter.com/help/privacy

   Opt-out per l'utente: onora Do-Not-Track e Global Privacy Control. Chi vuole
   escludersi a mano può eseguire in console:
       localStorage.setItem('ape-no-stats', '1')

   Il file è incluso da tutte le pagine del sito con percorso assoluto
   (/analytics.js) — assoluto e non relativo perché la copia beta del viewer
   vive in una cartella a profondità diversa (vedi scripts/build-beta.mjs).
============================================================================ */
(function () {
  "use strict";

  /* Codice del sito su GoatCounter → https://<GC_SITE>.goatcounter.com */
  var GC_SITE  = "viewifc";
  var ENDPOINT = "https://" + GC_SITE + ".goatcounter.com/count";

  /* ------------------------------------------------------------- guardie ----
     Meglio nessun dato che dati sporchi: le prove in locale non devono finire
     nelle statistiche, e chi ha espresso un rifiuto va rispettato. */
  var host = location.hostname;
  if (location.protocol === "file:")                                    return;
  if (!host || host === "localhost" || host === "127.0.0.1" ||
      host === "[::1]" || /\.local$/.test(host))                        return;
  if (navigator.doNotTrack === "1" || window.doNotTrack === "1" ||
      navigator.msDoNotTrack === "1" || navigator.globalPrivacyControl) return;
  try { if (localStorage.getItem("ape-no-stats") === "1")               return; } catch (e) {}

  /* --------------------------------------------------- mappa degli eventi ----
     id del bottone → nome dell'evento. Lista CHIUSA: un click su un id non
     elencato non manda niente. Strumentare qui, con un listener delegato,
     invece che dentro le funzioni delle feature, tiene il codice del viewer
     completamente pulito: nessuna chiamata sparsa da mantenere. */
  var EVENTS = {
    /* NB: l'apertura dei file NON si misura da qui — vedi FILE_KINDS più sotto.
       Un click sul bottone conta anche chi apre il dialogo e poi annulla, e
       soprattutto non vede il drag & drop, che nel viewer è una via di
       caricamento a pieno titolo. Misurava intenzioni, non caricamenti. */
    /* viste e navigazione */
    btnAlign:        "alignment",
    btnSection:      "section",
    btnSecDraw:      "section-draw",
    btnWalk:         "walk",
    /* quantity take-off */
    btnQtoRun:       "qto-run",
    btnQtoCsv:       "qto-csv",
    /* clash detection */
    btnClashRun:     "clash-run",
    btnClashMtxRun:  "clash-matrix",
    btnClashCsv:     "clash-csv",
    btnClashBcf:     "clash-bcf",
    /* controlli IDS */
    btnIdsRun:       "ids-run",
    btnIdsExportBcf: "ids-bcf",
    /* verifica nuvola ↔ modello */
    btnC2dRun:       "cloud-distance",
    btnC2mScan:      "cloud-scan",
    /* issue e report */
    btnExportBcf:    "bcf-export",
    btnReportStats:  "report-stats",
    btnRepExport:    "report-export"
  };

  /* ------------------------------------------------------- caricamento ----- */
  var ready = false;
  var queue = [];                       /* click arrivati prima del caricamento */

  var s = document.createElement("script");
  s.async = true;
  s.src   = "https://gc.zgo.at/count.js";
  s.setAttribute("data-goatcounter", ENDPOINT);
  s.onload = function () {
    ready = true;
    for (var i = 0; i < queue.length; i++) fire(queue[i]);
    queue.length = 0;
  };
  /* Se lo script non arriva (adblocker, rete, servizio giù) il sito non se ne
     accorge nemmeno: si smette semplicemente di contare. */
  s.onerror = function () { queue.length = 0; };
  (document.head || document.documentElement).appendChild(s);

  function fire(name) {
    try {
      if (window.goatcounter && window.goatcounter.count)
        window.goatcounter.count({ path: name, title: name, event: true });
    } catch (e) {}
  }

  /* ------------------------------------------------------------- eventi ----
     Una volta sola per caricamento di pagina. Il viewer è una SPA che resta
     aperta per tutta la sessione, quindi il conteggio risponde a "in quante
     sessioni è stata usata questa funzione" — che è la domanda giusta. Contare
     ogni click premierebbe chi ripete un calcolo, non chi usa la feature. */
  var seen = Object.create(null);

  function send(name) {
    if (!name || seen[name]) return;
    seen[name] = true;
    if (ready) fire(name); else if (queue.length < 20) queue.push(name);
  }

  document.addEventListener("click", function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest("button, a") : null;
    if (el && el.id) send(EVENTS[el.id]);
  }, true);   /* capture: registra anche se un handler ferma la propagazione */

  /* ------------------------------------------------- caricamento di file ----
     Un file "aperto" è un file DAVVERO scelto, non un bottone premuto. Il
     bottone sbaglia in due modi opposti: conta chi annulla il dialogo, e non
     vede chi trascina il file nella finestra. Si è visto nei dati reali —
     l'evento `section` risultava più frequente di `ifc-open`, che è impossibile
     senza un modello caricato.

     Le due vie reali sono quindi il `change` degli input[type=file] e il `drop`
     sulla finestra. La classificazione è per estensione, con le stesse regex
     dell'handler "drop" del viewer, così i due percorsi non possono divergere. */
  var FILE_KINDS = [
    [/\.ifc$/i,              "ifc-open"],
    [/\.(bcf|bcfzip|zip)$/i, "bcf-open"],
    [/\.(xlsx|xlsm)$/i,      "report-open"],
    [/\.(las|laz|e57)$/i,    "pointcloud-open"],
    [/\.ids$/i,              "ids-open"],
    [/\.(xml|landxml)$/i,    "landxml-open"]
  ];

  /* I .csv non sono distinguibili per estensione (catalogo dei codici o matrice
     clash?), quindi per loro conta da quale campo arrivano. Non serve il ramo
     drag & drop: il viewer i .csv trascinati non li accetta. */
  var BY_INPUT = {
    fileC2mBook:  "cloud-codebook",
    fileClashMtx: "clash-matrix-load"
  };

  function classify(name) {
    for (var i = 0; i < FILE_KINDS.length; i++)
      if (FILE_KINDS[i][0].test(name)) return FILE_KINDS[i][1];
    return null;                       /* estensione ignota: non si inventa */
  }

  function countFiles(files, inputId) {
    if (!files || !files.length) return;
    var forced = inputId && BY_INPUT[inputId];
    for (var i = 0; i < files.length; i++) send(forced || classify(files[i].name));
  }

  document.addEventListener("change", function (ev) {
    var el = ev.target;
    if (el && el.type === "file") countFiles(el.files, el.id);
  }, true);

  window.addEventListener("drop", function (ev) {
    if (ev.dataTransfer) countFiles(ev.dataTransfer.files, null);
  }, true);   /* capture: gira prima dell'handler del viewer, che fa preventDefault */
})();

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
    /* apertura file */
    btnIfc:          "ifc-open",
    btnBcf:          "bcf-open",
    btnPc:           "pointcloud-open",
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
    btnC2mBook:      "cloud-codebook",
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

  document.addEventListener("click", function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest("button, a") : null;
    if (!el || !el.id) return;

    var name = EVENTS[el.id];
    if (!name || seen[name]) return;
    seen[name] = true;

    if (ready) fire(name); else if (queue.length < 20) queue.push(name);
  }, true);   /* capture: registra anche se un handler ferma la propagazione */
})();

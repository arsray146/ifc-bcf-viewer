/* ============================================================================
   c2d-worker.js — Web Worker della verifica nuvola ↔ modello (v2.9.1).

   Misura le distanze punto → superficie IFC su un blocco di punti alla volta.
   Il viewer ne avvia alcuni (metà dei core, al più 8, e meno se il modello è
   grande: ognuno tiene una copia della geometria) e si divide la nuvola fra
   loro; statistiche, soglie e colori restano sul thread principale, nello
   stesso codice di prima. Qui gira SOLO nearestBlock di clash.js, la stessa
   funzione del percorso senza worker: i numeri non possono cambiare.

   Messaggi:
     ← { type:"geom", tris, bvh:{nMin,nMax,na,nb,order,count} }   → { type:"ready" }
     ← { type:"block", id, pos, maxDist, box }                    → { type:"block", id, dist, tri }
   pos (Float32Array, xyz), dist (Float64Array), tri (Int32Array) viaggiano
   trasferiti, non copiati.

   Un worker non subisce il rallentamento dei timer delle finestre coperte, e
   lascia libero il thread principale: la vista 3D resta fluida durante il
   calcolo.

   v2.9.2 — clash.js si importa con la STESSA versione con cui il viewer ha
   caricato questo file (…/c2d-worker.js?v=2.9.2 → …/clash.js?v=2.9.2): un
   clash.js vecchio rimasto nella cache del browser non viene usato. L'import
   è dinamico perché la versione si conosce solo a runtime; il gestore dei
   messaggi è registrato subito e aspetta il modulo, così nessun messaggio
   arriva prima che ci sia chi lo ascolta.
============================================================================ */
const clash = import(new URL("./clash.js" + new URL(import.meta.url).search, import.meta.url).href);

let A = null;

self.onmessage = async (e) => {
  /* se clash.js non si carica lo si dice subito: un rifiuto asincrono in un
     worker NON arriva al viewer come evento "error", e il viewer aspetterebbe
     il "ready" fino al timeout prima di ripiegare sul thread principale */
  let nearestBlock;
  try { ({ nearestBlock } = await clash); }
  catch (err) { self.postMessage({ type: "fail", error: String(err && err.message || err) }); return; }
  const m = e.data;
  if (m.type === "geom") {
    A = { tris: m.tris, bvh: m.bvh };
    self.postMessage({ type: "ready" });
    return;
  }
  if (m.type === "block") {
    const n = m.pos.length / 3;
    const dist = new Float64Array(n), tri = new Int32Array(n);
    nearestBlock(A, m.pos, 0, n, m.maxDist, m.box, dist, tri);
    self.postMessage({ type: "block", id: m.id, dist, tri }, [dist.buffer, tri.buffer]);
  }
};

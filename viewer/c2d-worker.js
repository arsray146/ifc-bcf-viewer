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
============================================================================ */
import { nearestBlock } from "./clash.js";

let A = null;

self.onmessage = (e) => {
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

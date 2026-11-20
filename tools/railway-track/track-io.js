/* =========================================================================
   Armamento ferroviario (Railway Track) — file di progetto (tool 21, F1)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Senza DOM (si prova in Node: test/test_track_io.js). Il progetto .track è un
   JSON — la pagina lo comprime con gzip quando il browser sa farlo, come il .ocs
   della Trazione elettrica: { format: "viewifc-railway-track", v: 1,
   …intestazione (tool, saved, nomi dei binari), doc }. Il doc è lo stesso del
   salvataggio automatico: { v: 1, name, active, seq, hidden, pt, tracks, sc }.
   I numeri non finiti (Infinity dei raggi delle rette) passano come { $n: "…" }.

   tracksFromOcs: da un progetto .ocs della Trazione elettrica (tool 18) prende
   solo quello che serve qui — binari (geometria letta, profilo scelto, offset,
   polilinee e taratura dei disegni), occhi dei binari e del contesto,
   supercompattato scelto — e lascia là sostegni, valori dei pali (t.ocs),
   Pset e l'id del progetto in Revit. Lo legge ocs-io.js, con la stessa
   versione con cui lo importa la pagina (una sola istanza del modulo).
   ========================================================================= */
import { decodeProject as decodeOcs, isGzip } from "../railway-ocs/ocs-io.js?v=0.24.0";

export { isGzip };
export const PRJ_FORMAT = "viewifc-railway-track", PRJ_V = 1;

/* i numeri non finiti (Infinity dei raggi) passano come stringhe, come nel .ocs */
const numOut = (k, v) => (typeof v === "number" && !Number.isFinite(v) ? { $n: String(v) } : v);
const numIn = (k, v) => (v && typeof v === "object" && typeof v.$n === "string" && Object.keys(v).length === 1 ? Number(v.$n) : v);

export function encodeProject(doc, extra = {}) {
  return new TextEncoder().encode(JSON.stringify({ format: PRJ_FORMAT, v: PRJ_V, ...extra, doc }, numOut));
}
export function decodeProject(u8) {
  let h;
  try { h = JSON.parse(new TextDecoder().decode(u8), numIn); } catch (e) { throw new Error("not a Railway Track project"); }
  if (!h || h.format !== PRJ_FORMAT || !h.doc || !Array.isArray(h.doc.tracks)) throw new Error("not a Railway Track project");
  if (h.v > PRJ_V) throw new Error("project from a newer version (format " + h.v + ")");
  const doc = h.doc; delete h.doc;
  return { doc, header: h };
}

/* occhi che hanno senso qui: binario e sue parti (rotaie e asse, piano del ferro, asse ricevuto), contesto, supercompattato */
const HIDDEN_OK = /^(t\d+(:(rails|deck|align))?|ctx(:.*)?|sc)$/;
/* i binari di un progetto della Trazione elettrica (u8 già decompresso) → { doc, header, supports }:
   doc nella forma di questo strumento, header del .ocs (from = il suo formato), supports = sostegni lasciati là */
export function tracksFromOcs(u8) {
  const { doc: d, header } = decodeOcs(u8);              // «not a Railway OCS project» se non lo è
  const tracks = d.tracks.map(({ ocs, ...t }) => t);     // t.ocs: valori dei pali e tratti della Trazione
  const hidden = {};
  for (const [k, v] of Object.entries(d.hidden || {})) if (v && HIDDEN_OK.test(k)) hidden[k] = true;
  const sc = Array.isArray(d.sc) ? d.sc : [];
  const doc = { v: 1, name: d.name || "", active: Number.isInteger(d.active) ? d.active : 0, seq: d.seq || 1, hidden, pt: d.pt != null ? d.pt : null, tracks, sc };
  return { doc, header: { ...header, from: header.format }, supports: Array.isArray(d.supports) ? d.supports.length : 0 };
}

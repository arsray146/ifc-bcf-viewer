/* =========================================================================
   Armamento ferroviario (Railway Track) — export in solidi DXF (tool 21, 0.4.0; 0.4.1)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Senza DOM (si prova in Node: test/test_track_dxf.js; collaudo in AutoCAD
   con scripts/track-f0/acad-check.ps1). La pagina lo carica solo quando si
   esporta. Il DWG non si scrive nel browser: il DXF R2000 coi 3DSOLID si
   apre in AutoCAD e Civil 3D così com'è, «Salva con nome» lo fa DWG.
   - Stessi oggetti dell'IFC (track-core trackPieces), in coordinate vere:
     - rotaia del tratto = un 3DSOLID: le sezioni vere del profilo ai capi
       degli estrusi dell'IFC (railSegments, entro 1 mm), unite da facce piane
       (in sopraelevazione che cambia, triangoli);
     - ballast del tratto = un 3DSOLID per letto (lo stesso solido a facce
       dell'IfcCourse);
     - traverse e intasi = INSERT di un blocco per tipo (intasi: tipo e
       passo), girati nello spazio sulla posa (normale + rotazione).
   - 0.4.1: l'asse di ogni binario come POLYLINE 3D (quota della livelletta,
     entro 1 mm) coi Pset del binario; progetto e sito come due POINT
     nell'origine del sito (come l'IfcSite), solo se hanno Pset: in Civil 3D
     i property set stanno sugli oggetti, e così anche questi arrivano.
   - Layer per binario e componente («BP - Rotaie»), colori come nella vista.
   - I dati viaggiano in XDATA «VIEWIFC» su ogni oggetto: nome, classe IFC,
     poi ogni Pset del modello del progetto come { nome Pset, coppie nome →
     valore } (1000 testo, 1040 numero, 1071 intero, 1070 logico) — da lì il
     passo per Civil 3D li farà diventare property set.
   ========================================================================= */
import * as C from "../railway-ocs/ocs-core.js?v=0.24.0";
import * as K from "./track-catalog.js?v=0.5.2";
import * as TC from "./track-core.js?v=0.5.2";
import { TYPES } from "../common/pset-core.js?v=1.1.0";
import { solidSAT, dxfSolids } from "../common/dxf-solids.js?v=1.1.0";

/* nomi di partenza (la pagina li passa nella sua lingua) */
export const DXF_LABELS = {
  lRails: "Rotaie", lSleepers: "Traverse", lCribs: "Intasi", lBallast: "Ballast", lAxis: "Asse", lPrj: "Progetto e sito",   // layer
  railL: "Rotaia sinistra", railR: "Rotaia destra", sleeper: "Traversa", crib: "Intaso", ballast: "Ballast", site: "Sito",   // oggetti
  left: "S", right: "D", bSec: "sezione tipo", bSc: "supercompattato", bwSleeper: "a filo traverse", bwCrest: "alla quota della cresta",
  fallBoth: "a schiena d'asino", fallL: "a una falda verso sinistra", fallR: "a una falda verso destra",
};
/* colori ACI (R2000 non ha i colori veri): rotaie grigio chiaro, traverse quasi bianche, ballast e intasi bruni */
const ACI = { rails: 9, sleepers: 254, cribs: 37, ballast: 35, axis: 1, prj: 7 };
export const XDATA_APP = "VIEWIFC";

/**
 * job = { name, app: { name, version }, labels?, resolve?: (kind, valori) → Pset risolti (pset-core resolve),
 *         origin?: { x, y } (l'origine del sito, come nell'IFC; di partenza il primo punto del primo binario, al metro),
 *         tracks: [{ name, T, parts (track-core trackPieces) }] }
 * → { parts (DXF a pezzi), size, n: { tracks, rails, sleepers, cribs, ballast, blocks, faces, axes, points }, warn: [testi] }
 */
export function trackDxf(job) {
  const lb = { ...DXF_LABELS, ...(job.labels || {}) }, railChord = job.railChord || 0.002;
  const w = dxfSolids({ insunits: 6 });
  w.appid(XDATA_APP);
  const n = { tracks: 0, rails: 0, sleepers: 0, cribs: 0, ballast: 0, blocks: 0, faces: 0, axes: 0, points: 0 }, warn = new Set();
  const sat = (mesh, opt) => {
    const r = solidSAT(mesh, opt);
    for (const x of r.warn) warn.add(x);
    n.faces += r.nFaces;
    return r;
  };
  // XDATA: nome, classe IFC, Pset
  const xd = (name, cls, kind, vals, sets = job.resolve && kind ? job.resolve(kind, vals) : null) => {
    const items = [[1000, name], [1000, cls]];
    for (const s of sets || []) {
      if (!s.props || !s.props.length) continue;
      items.push([1000, s.name], [1002, "{"]);
      for (const p of s.props) {
        const k = (TYPES[p.type] || TYPES.label).k;
        items.push([1000, p.name], k === "s" ? [1000, p.value] : k === "b" ? [1070, p.value ? 1 : 0] : k === "i" ? [1071, p.value] : [1040, p.value]);
      }
      items.push([1002, "}"]);
    }
    return [{ app: XDATA_APP, items }];
  };
  // blocchi: traverse per tipo, intasi per tipo e passo (forme nel riferimento della posa)
  const blk = new Map();
  const sleeperBlock = (type) => {
    const key = "s|" + type;
    if (!blk.has(key)) {
      const name = w.block(`${lb.sleeper} ${K.SLEEPERS[type].label}`, [{ t: "3dsolid", sat: sat(TC.sleeperGeom(type).mesh, { origin: [0, 0, 0] }).lines, layer: "0" }]);
      blk.set(key, name); n.blocks++;
    }
    return blk.get(key);
  };
  const cribBlock = (type, G) => {
    const key = "c|" + type + "|" + G.toFixed(4);
    if (!blk.has(key)) {
      const name = w.block(`${lb.crib} ${K.SLEEPERS[type].label} ${(G * 1000).toFixed(0)}`, [{ t: "3dsolid", sat: sat(TC.cribMesh(type, G), { origin: [0, 0, 0] }).lines, layer: "0" }]);
      blk.set(key, name); n.blocks++;
    }
    return blk.get(key);
  };

  // progetto e sito (0.4.1): due punti nell'origine del sito, solo se il modello dà loro dei Pset
  const tracks = job.tracks || [];
  const O = job.origin || (tracks.length ? (() => { const f = C.trackFrame(tracks[0].T, 0); return { x: Math.round(f.x), y: Math.round(f.y) }; })() : { x: 0, y: 0 });
  const prjVals = TC.psetValues("project", tracks.map((t) => ({ name: t.name, parts: t.parts || [], L: t.T.H.length, s0: t.T.s0 || 0 })), { name: job.name || "" });
  for (const [kind, name, cls, vals] of [["project", job.name || "", "IfcProject", prjVals], ["site", lb.site, "IfcSite", TC.psetValues("site", { E: O.x, N: O.y }, { name: job.name || "" })]]) {
    const sets = job.resolve ? job.resolve(kind, vals) : null;
    if (!sets || !sets.length) continue;
    w.model.push({ t: "point", p: [O.x, O.y, 0], layer: w.layer(lb.lPrj, ACI.prj), xdata: xd(name, cls, kind, vals, sets) });
    n.points++;
  }
  for (const t of tracks) {
    const T = t.T, s0 = T.s0 || 0, Ltr = T.H.length, parts = t.parts || [], multi = parts.length > 1;
    const L = {
      rails: w.layer(`${t.name} - ${lb.lRails}`, ACI.rails), sleepers: w.layer(`${t.name} - ${lb.lSleepers}`, ACI.sleepers),
      cribs: w.layer(`${t.name} - ${lb.lCribs}`, ACI.cribs), ballast: w.layer(`${t.name} - ${lb.lBallast}`, ACI.ballast),
    };
    n.tracks++;
    // asse (0.4.1): POLYLINE 3D alla quota della livelletta, coi Pset del binario (nel DXF il binario non ha altri oggetti)
    w.model.push({ t: "polyline3d", pts: axisPoints(T), layer: w.layer(`${t.name} - ${lb.lAxis}`, ACI.axis),
      xdata: xd(t.name, "IfcRailwayPart.TRACK", "track", TC.psetValues("track", parts, { name: t.name, s0, L: Ltr, lb })) });
    n.axes++;
    for (const p of parts) {
      const tag = multi ? " " + p.i : "", ctxP = { name: t.name, s0, L: Ltr, part: p, lb };
      // rotaie: sezioni vere ai capi degli estrusi, unite da facce piane
      for (const r of p.rails) {
        if (!r.segs.length) continue;
        const pr = TC.railProfile(r.rail, r.side, railChord), us = [r.segs[0].u0, ...r.segs.map((g) => g.u1)], [ra, rb] = pr.ref;
        const rings = us.map((u) => { const R = TC.railFrame(T, u); return pr.pts.map(([a, b]) => TC.rf3(R, a + ra, b + rb)); });
        const s = sat(TC.sweepRings(rings, pr.pts));
        w.model.push({ t: "3dsolid", sat: s.lines, origin: s.origin, layer: L.rails, xdata: xd((r.side === "left" ? lb.railL : lb.railR) + tag, "IfcRail.RAIL", "rail", TC.psetValues("rail", r, ctxP)) });
        n.rails++;
      }
      // ballast: un solido per letto, coi Pset del tratto
      for (const b of p.beds) {
        const s = sat(b);
        w.model.push({ t: "3dsolid", sat: s.lines, origin: s.origin, layer: L.ballast, xdata: xd(lb.ballast + tag, "IfcCourse.BALLASTBED", "ballast", TC.psetValues("ballast", p, ctxP)) });
        n.ballast++;
      }
      for (const c of p.cribs) {
        const q = c.pose;
        w.model.push({ t: "insert", block: cribBlock(c.type, c.G), o: q.o, x: q.x, z: q.z, layer: L.cribs, xdata: xd(lb.crib + " " + c.k, "IfcCourse.BALLASTBED", null) });
        n.cribs++;
      }
      for (const s of p.sleepers) {
        const q = s.pose;
        w.model.push({ t: "insert", block: sleeperBlock(s.type), o: q.o, x: q.x, z: q.z, layer: L.sleepers, xdata: xd(lb.sleeper + " " + s.k, "IfcTrackElement.SLEEPER", "sleeper", TC.psetValues("sleeper", s, ctxP)) });
        n.sleepers++;
      }
    }
  }
  const parts = w.parts();
  return { parts, size: parts.reduce((a, p) => a + p.length, 0), n, warn: [...warn] };
}

/* punti dell'asse: le progressive del binario al metro (e i capi degli elementi), alla quota della livelletta; tolti
   quelli che la corda fra i vicini tenuti rifà entro tol (m) — in rettifilo restano i capi */
export function axisPoints(T, tol = 0.001) {
  const P = C.trackStations(T, 1).map((u) => { const f = C.trackFrame(T, u); return [f.x, f.y, f.zIn]; });
  if (P.length <= 2) return P;
  const off = (p, a, b) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2, w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const t = L2 > 0 ? Math.max(0, Math.min(1, (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / L2)) : 0;
    return Math.hypot(w[0] - t * d[0], w[1] - t * d[1], w[2] - t * d[2]);
  };
  const out = [P[0]];
  for (let i = 0; i < P.length - 1;) {
    let j = i + 1;
    while (j + 1 < P.length && j + 1 - i <= 2000) { let fit = true; for (let k = i + 1; k <= j; k++) if (off(P[k], P[i], P[j + 1]) > tol) { fit = false; break; } if (!fit) break; j++; }
    out.push(P[j]); i = j;
  }
  return out;
}

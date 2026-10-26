/* =========================================================================
   Sequenza 4D — lettura degli IFC per il 3D del tool (F1)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Niente import, niente DOM: gira nel Worker accanto a web-ifc (index.html,
   makeIfcWorker) e in Node, con un'api finta o col web-ifc 0.0.77 del viewer
   (test/test_seq_ifc.js). L'api ha la forma di web-ifc: GetLine,
   GetLineIDsWithType, StreamMeshes, GetGeometry.

   Per ogni modello:
   - georeferenziazione come il Terrain Sculptor (le funzioni sono copie di
     terrain-io.js): la geometria esce nelle coordinate del SITO del modello
     e il sistema di mappa resta a parte come frame { E, N, H, c, s, k }; più
     modelli si sovrappongono per la mappa se sono georeferenziati, altrimenti
     per le coordinate interne (discipline dello stesso progetto);
   - struttura: progetto → sito → edificio / opera → piano / parte (anche
     IfcFacility e IfcFacilityPart dell'IFC 4x3), ogni elemento al suo
     contenitore, le parti di un assieme al contenitore dell'assieme;
   - geometria per elemento in pochi blocchi: ogni vertice porta l'indice del
     suo elemento, così colore, trasparenza e visibilità di ogni elemento
     stanno in una texture (seq-3d.js) e un blocco resta un draw call;
   - proprietà al clic: attributi, Pset e quantità, anche quelli del tipo.
   ========================================================================= */

/* ======================================================================
   Georeferenziazione — copie di terrain-io.js (Terrain Sculptor, fase 2):
   stesse letture, stessi casi di Revit («Shared Coordinates» nel placement
   del sito, «Internal Origin» nel WorldCoordinateSystem del contesto).
   ====================================================================== */
/* intestazione STEP: Revit scrive la base delle coordinate nel FILE_DESCRIPTION
   ('CoordinateReference [CoordinateBase: Internal Origin, ProjectSite: MN95]') */
export function ifcHeader(text) {
  const head = String(text).slice(0, 65536);
  const desc = (/FILE_DESCRIPTION\s*\(([\s\S]*?)\)\s*;/.exec(head) || [, ""])[1];
  const cb = /CoordinateBase:\s*([^,\]']+)/i.exec(desc), ps = /ProjectSite:\s*([^,\]']+)/i.exec(desc);
  const b = cb ? cb[1].trim() : "";
  const base = !b ? null : /internal/i.test(b) ? "internal" : /shared|survey/i.test(b) ? "shared" : /project/i.test(b) ? "pbp" : "other";
  const fn = /FILE_NAME\s*\(([\s\S]*?)\)\s*;/.exec(head);
  const app = fn ? ((fn[1].match(/'([^']*)'/g) || []).map(s => s.slice(1, -1)).find(s => /revit|archicad|civil|tekla|allplan|bentley|vectorworks|rhino|navisworks|infraworks|openroads/i.test(s)) || "") : "";
  const sch = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(head);
  return { base, baseText: b, site: ps ? ps[1].trim() : null, app, schema: sch ? sch[1] : "" };
}

/* trasformazioni rigide 3×4 per righe: p' = R·p + t, [r00 r01 r02 tx, r10 … ty, r20 … tz] */
export const M_ID = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
export function mMul(A, B) {
  const R = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) R[4 * r + c] = A[4 * r] * B[c] + A[4 * r + 1] * B[4 + c] + A[4 * r + 2] * B[8 + c];
    R[4 * r + 3] = A[4 * r] * B[3] + A[4 * r + 1] * B[7] + A[4 * r + 2] * B[11] + A[4 * r + 3];
  }
  return R;
}
export function mInvRigid(A) {
  const R = [A[0], A[4], A[8], 0, A[1], A[5], A[9], 0, A[2], A[6], A[10], 0];
  for (let r = 0; r < 3; r++) R[4 * r + 3] = -(R[4 * r] * A[3] + R[4 * r + 1] * A[7] + R[4 * r + 2] * A[11]);
  return R;
}
export const mApply = (A, x, y, z) => [A[0] * x + A[1] * y + A[2] * z + A[3], A[4] * x + A[5] * y + A[6] * z + A[7], A[8] * x + A[9] * y + A[10] * z + A[11]];
/* frame { E, N, H, c, s, k } → matrice 3×4 (sito → mappa) e inversa di una similitudine */
export const frameMatrix = (F) => [F.k * F.c, -F.k * F.s, 0, F.E, F.k * F.s, F.k * F.c, 0, F.N, 0, 0, F.k, F.H];
export function mInvSim(A) {
  const k2 = A[0] * A[0] + A[4] * A[4] + A[8] * A[8];
  const R = [A[0] / k2, A[4] / k2, A[8] / k2, 0, A[1] / k2, A[5] / k2, A[9] / k2, 0, A[2] / k2, A[6] / k2, A[10] / k2, 0];
  for (let r = 0; r < 3; r++) R[4 * r + 3] = -(R[4 * r] * A[3] + R[4 * r + 1] * A[7] + R[4 * r + 2] * A[11]);
  return R;
}

function ifcTools(api, mid) {
  const ev = (x) => (x && typeof x === "object" && "value" in x ? x.value : x);
  const num = (x, d) => { const v = parseFloat(ev(x)); return isFinite(v) ? v : d; };
  const str = (x) => { const v = ev(x); return v == null ? "" : String(v); };
  const line = (id) => { if (id == null) return null; try { return api.GetLine(mid, id); } catch (e) { return null; } };
  const get = (t, inh) => { const out = []; if (t == null) return out; try { const v = api.GetLineIDsWithType(mid, t, inh); for (let i = 0; i < v.size(); i++) out.push(v.get(i)); } catch (e) {} return out; };
  const ids = (t) => get(t, false);
  const inh = (t) => get(t, true);           // con i sottotipi (IfcProduct, IfcSpatialElement…)
  const vec = (ref) => { const l = line(ev(ref)); const a = l && (l.Coordinates || l.DirectionRatios); return Array.isArray(a) ? a.map(v => num(v, 0)) : null; };
  return { ev, num, str, line, ids, inh, vec };
}
/* IfcAxis2Placement3D/2D → matrice; la traslazione nelle unità del file × u (metri) */
function axisMatrix(L, l, u) {
  if (!l) return M_ID();
  const o = L.vec(l.Location) || [0, 0, 0];
  const v3 = (v) => (v ? [v[0] || 0, v[1] || 0, v[2] || 0] : null);
  let z = o.length === 2 ? [0, 0, 1] : v3(l.Axis != null ? L.vec(l.Axis) : null) || [0, 0, 1];
  let x = v3(l.RefDirection != null ? L.vec(l.RefDirection) : null) || [1, 0, 0];
  const n = (v) => { const d = Math.hypot(v[0], v[1], v[2]); return d > 1e-12 ? v.map(c => c / d) : null; };
  z = n(z) || [0, 0, 1];
  const xz = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
  x = n([x[0] - xz * z[0], x[1] - xz * z[1], x[2] - xz * z[2]]) || n(Math.abs(z[0]) < 0.9 ? [1 - z[0] * z[0], -z[0] * z[1], -z[0] * z[2]] : [-z[1] * z[0], 1 - z[1] * z[1], -z[1] * z[2]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [x[0], y[0], z[0], o[0] * u, x[1], y[1], z[1], o[1] * u, x[2], y[2], z[2], (o[2] || 0) * u];
}
/* catena di IfcLocalPlacement → matrice assoluta (un IfcGridPlacement vale l'identità) */
function placementMatrix(L, id, u) {
  let M = M_ID(), cur = id;
  for (let k = 0; k < 64 && cur != null; k++) {
    const p = L.line(cur);
    if (!p || p.RelativePlacement == null) break;
    M = mMul(axisMatrix(L, L.line(L.ev(p.RelativePlacement)), u), M);
    cur = p.PlacementRelTo != null ? L.ev(p.PlacementRelTo) : null;
  }
  return M;
}

/**
 * Letture grezze della georeferenziazione (oggetto clonabile, esce dal Worker):
 * unità di lunghezza del progetto, placement assoluto del sito,
 * WorldCoordinateSystem e TrueNorth del contesto, IfcMapConversion.
 */
export function ifcReadGeoref(api, mid, T) {
  const L = ifcTools(api, mid), { ev, num, str, line, ids } = L;
  const en = (x) => str(x).replace(/\./g, "").toUpperCase();
  const PFX = { KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 1e-3, MICRO: 1e-6 };
  const lenFactor = (u) => {
    if (!u || en(u.UnitType) !== "LENGTHUNIT") return null;
    if (u.ConversionFactor == null) return en(u.Name) === "METRE" ? (PFX[en(u.Prefix)] || 1) : null;
    const mw = line(ev(u.ConversionFactor));
    let f = mw ? num(mw.ValueComponent, NaN) : NaN;
    if (!isFinite(f) || f <= 0) return null;
    const su = line(ev(mw.UnitComponent));
    if (su && su.Prefix != null && PFX[en(su.Prefix)]) f *= PFX[en(su.Prefix)];
    return f;
  };
  let unit = 1;
  outer: for (const ua of ids(T.IFCUNITASSIGNMENT)) {
    const l = line(ua);
    for (const h of (l && l.Units) || []) { const f = lenFactor(line(ev(h))); if (f) { unit = f; break outer; } }
  }
  const r = { unit, siteM: null, ctxM: null, ctxRef: false, trueNorth: null, mapConv: null, crs: null, site: null };
  const site = ids(T.IFCSITE).map(line).find(Boolean);
  if (site) {
    r.siteM = site.ObjectPlacement != null ? placementMatrix(L, ev(site.ObjectPlacement), unit) : M_ID();
    r.site = { name: str(site.Name), elev: site.RefElevation != null ? num(site.RefElevation, 0) * unit : null };
  }
  for (const cid of ids(T.IFCGEOMETRICREPRESENTATIONCONTEXT)) {
    const c = line(cid);
    if (!c || num(c.CoordinateSpaceDimension, 3) !== 3) continue;
    const w = line(ev(c.WorldCoordinateSystem));
    r.ctxM = axisMatrix(L, w, unit);
    r.ctxRef = !!(w && (w.RefDirection != null || w.Axis != null));
    const tn = c.TrueNorth != null ? L.vec(c.TrueNorth) : null;
    if (tn && tn.length >= 2 && Math.hypot(tn[0], tn[1]) > 1e-12) r.trueNorth = { x: tn[0], y: tn[1] };
    break;
  }
  const mc = ids(T.IFCMAPCONVERSION).map(line).find(Boolean);
  if (mc) {
    const crs = line(ev(mc.TargetCRS));
    const mapUnit = crs && crs.MapUnit != null ? lenFactor(line(ev(crs.MapUnit))) : null;
    r.mapConv = { E: num(mc.Eastings, 0), N: num(mc.Northings, 0), H: num(mc.OrthogonalHeight, 0),
      xa: num(mc.XAxisAbscissa, 1), xo: num(mc.XAxisOrdinate, 0), scale: num(mc.Scale, 1) || 1, mapUnit: mapUnit || 1 };
    if (crs) r.crs = { name: str(crs.Name), desc: str(crs.Description), vertical: str(crs.VerticalDatum) };
  }
  return r;
}

/**
 * Dal modello alle coordinate del sito e al sistema di mappa.
 * toLocal: mondo di web-ifc (metri, Z in alto) → coordinate del sito.
 * frame: sito → mappa, o null. how: "map" | "site" | "context" | null.
 */
export function ifcFrames(g, header = {}) {
  const S = g.siteM || M_ID();
  const out = { toLocal: mInvRigid(S), frame: null, how: null, base: header.base || null, crs: null, rot: 0, notes: [] };
  const big = (M) => Math.hypot(M[3], M[7]) > 1e4;
  const setFrame = (F, k, how) => {
    out.frame = { E: F[3], N: F[7], H: F[11], c: F[0] / k, s: F[4] / k, k };
    out.how = how;
    out.rot = Math.atan2(out.frame.s, out.frame.c) * 180 / Math.PI;
  };
  if (Math.abs(S[10] - 1) > 1e-9) out.notes.push("tilted");
  if (g.mapConv) {
    /* mappa = MapConversion · mondo (la geometria di web-ifc è in metri: k = Scale · unità della mappa / unità del file) */
    const m = g.mapConv, d = Math.hypot(m.xa, m.xo), ca = d > 1e-12 ? m.xa / d : 1, sa = d > 1e-12 ? m.xo / d : 0;
    const k = (m.scale * m.mapUnit) / (g.unit || 1);
    setFrame(mMul([k * ca, -k * sa, 0, m.E * m.mapUnit, k * sa, k * ca, 0, m.N * m.mapUnit, 0, 0, k, m.H * m.mapUnit], S), k, "map");
    if (big(S)) out.notes.push("doubleOffset");
  } else if (big(S)) setFrame(S, 1, "site");
  else if (g.ctxM && big(g.ctxM)) {
    /* Revit «Internal Origin»: il contesto porta E, N, H; senza RefDirection la rotazione è quella del TrueNorth (nord vero → +Y) */
    let C = g.ctxM;
    if (!g.ctxRef && g.trueNorth) {
      const d = Math.hypot(g.trueNorth.x, g.trueNorth.y), c = g.trueNorth.y / d, s = g.trueNorth.x / d;
      C = [c, -s, 0, C[3], s, c, 0, C[7], 0, 0, 1, C[11]];
    }
    setFrame(mMul(C, S), 1, "context");
  } else if (g.trueNorth && Math.abs(Math.atan2(g.trueNorth.x, g.trueNorth.y)) > 1e-6) out.notes.push("northOnly");
  if (out.base === "pbp") out.notes.push("pbp");
  out.crs = (g.crs && (g.crs.name || g.crs.desc)) || header.site || null;
  return out;
}

/**
 * Copia di ifcNeutralizeBooleans del Terrain Sculptor (a sua volta di
 * ctxModelNeutralize del tool Contesto 3D): le catene booleane di sola
 * sottrazione/intersezione si ripuntano sul solido di base e i fori si
 * staccano. Sono le «bombe» che bloccano web-ifc per minuti. Solo ripiego,
 * quando il modello intero non risponde: esce senza fori e senza tagli.
 * Modifica il modello aperto in memoria (WriteLine), mai il file.
 */
export function ifcNeutralizeBooleans(api, mid, T) {
  const ev = (x) => (x && typeof x === "object" && "value" in x ? x.value : x);
  const ids = (t) => { const out = []; if (t == null) return out; try { const v = api.GetLineIDsWithType(mid, t); for (let i = 0; i < v.size(); i++) out.push(v.get(i)); } catch (e) {} return out; };
  const line = (id) => { try { return api.GetLine(mid, id); } catch (e) { return null; } };
  const isBool = (l) => l && (l.type === T.IFCBOOLEANRESULT || l.type === T.IFCBOOLEANCLIPPINGRESULT);
  let voids = 0, bools = 0;
  for (const rid of ids(T.IFCRELVOIDSELEMENT)) {
    const l = line(rid);
    if (!l) continue;
    const op = ev(l.RelatedOpeningElement);
    l.RelatingBuildingElement = { type: 5, value: op != null ? op : rid };
    try { api.WriteLine(mid, l); voids++; } catch (e) {}
  }
  const base = new Map();
  const baseOf = (id) => {
    if (base.has(id)) return base.get(id);
    let cur = id, out = null;
    for (let k = 0; k < 500; k++) {
      const l = line(cur);
      if (!isBool(l)) { out = cur; break; }
      const op = String(ev(l.Operator) || "").replace(/\./g, "").toUpperCase();
      if (op === "UNION") break;                       // un'unione AGGIUNGE materiale: si lascia com'è
      cur = ev(l.FirstOperand);
      if (cur == null) break;
    }
    base.set(id, out);
    return out;
  };
  for (const sid of ids(T.IFCSHAPEREPRESENTATION)) {
    const sr = line(sid);
    if (!sr || !Array.isArray(sr.Items)) continue;
    let changed = false;
    for (const it of sr.Items) {
      const id = ev(it);
      if (id == null || !isBool(line(id))) continue;
      const b = baseOf(id);
      if (b != null && b !== id) { it.value = b; changed = true; bools++; }
    }
    if (changed) try { api.WriteLine(mid, sr); } catch (e) {}
  }
  return { voids, bools };
}

/**
 * Dove va un modello rispetto al riferimento della federazione (il primo
 * modello letto). refFrame / frame: ifcFrames().frame dei due, o null.
 * → { M: sito del modello → sito del riferimento, how, notes }
 * how: "ref" (è il riferimento) | "map" (per la mappa: tutti e due
 * georeferenziati) | "internal" (per le coordinate interne: discipline dello
 * stesso progetto esportate dalla stessa origine). Come refPlacement del
 * Terrain Sculptor; note «mixed» se uno solo dei due è georeferenziato.
 */
export function federate(refFrame, frame, isRef = false) {
  if (isRef) return { M: M_ID(), how: "ref", notes: [] };
  if (refFrame && frame) return { M: mMul(mInvSim(frameMatrix(refFrame)), frameMatrix(frame)), how: "map", notes: [] };
  return { M: M_ID(), how: "internal", notes: refFrame || frame ? ["mixed"] : [] };
}

/**
 * Le posizioni di un blocco nella scena: X = M·(o + p) − O, in doppia
 * precisione (p sono Float32 piccoli attorno all'origine o del modello, O è
 * l'origine della scena: l'origine del riferimento). Senza rotazione né
 * spostamento si restituisce lo stesso array.
 */
export function placePositions(P, M, o, O) {
  const id = M[0] === 1 && M[5] === 1 && M[10] === 1 && !M[1] && !M[2] && !M[4] && !M[6] && !M[8] && !M[9];
  const a = mApply(M, o[0], o[1], o[2]);
  const tx = a[0] - O[0], ty = a[1] - O[1], tz = a[2] - O[2];
  if (id && !tx && !ty && !tz) return P;
  const Q = new Float32Array(P.length);
  if (id) { for (let k = 0; k < P.length; k += 3) { Q[k] = P[k] + tx; Q[k + 1] = P[k + 1] + ty; Q[k + 2] = P[k + 2] + tz; } return Q; }
  for (let k = 0; k < P.length; k += 3) {
    const x = P[k], y = P[k + 1], z = P[k + 2];
    Q[k] = M[0] * x + M[1] * y + M[2] * z + tx;
    Q[k + 1] = M[4] * x + M[5] * y + M[6] * z + ty;
    Q[k + 2] = M[8] * x + M[9] * y + M[10] * z + tz;
  }
  return Q;
}

/* ======================================================================
   Struttura e classi
   ====================================================================== */
/* nome della classe come nello schema («IfcWallStandardCase»): web-ifc crea
   le righe con le classi dello schema; in ripiego il nome del codice */
export function clsOf(api, l) {
  if (!l) return "";
  const c = l.constructor && l.constructor.name;
  if (c && /^Ifc[A-Z]/.test(c)) return c;
  let n = "";
  try { n = api.GetNameFromTypeCode ? api.GetNameFromTypeCode(l.type) || "" : ""; } catch (e) {}
  return n || "IfcProduct";
}

/**
 * L'albero spaziale: IfcProject e i sottotipi di IfcSpatialElement (IFC4 e
 * 4x3: siti, edifici, piani, opere e loro parti, spazi) o di
 * IfcSpatialStructureElement (IFC2X3), legati da IfcRelAggregates; gli
 * elementi ci stanno per IfcRelContainedInSpatialStructure (che vince
 * sull'aggregazione), le parti di un assieme risalgono all'assieme.
 * → { nodes: [{ id, cls, name, long, parent }] (parent = indice o −1),
 *     contOf(id) → indice del contenitore o −1, wholeOf(id) → id dell'assieme o null }
 */
export function ifcStructure(api, mid, T) {
  const L = ifcTools(api, mid);
  const spatial = new Set([...L.ids(T.IFCPROJECT), ...L.inh(T.IFCSPATIALELEMENT), ...L.inh(T.IFCSPATIALSTRUCTUREELEMENT)]);
  const up = new Map();
  for (const rid of L.ids(T.IFCRELAGGREGATES)) {
    const r = L.line(rid);
    if (!r) continue;
    const p = L.ev(r.RelatingObject);
    for (const o of r.RelatedObjects || []) { const c = L.ev(o); if (c != null && p != null && !up.has(c)) up.set(c, p); }
  }
  for (const rid of L.ids(T.IFCRELCONTAINEDINSPATIALSTRUCTURE)) {
    const r = L.line(rid);
    if (!r) continue;
    const p = L.ev(r.RelatingStructure);
    for (const o of r.RelatedElements || []) { const c = L.ev(o); if (c != null && p != null) up.set(c, p); }
  }
  const anc = (id) => {           // primo antenato spaziale (catene corte: un limite contro i cicli)
    let p = up.get(id);
    for (let k = 0; k < 64 && p != null; k++) { if (spatial.has(p)) return p; p = up.get(p); }
    return null;
  };
  const nodes = [], at = new Map();
  for (const id of spatial) {
    const l = L.line(id);
    at.set(id, nodes.length);
    nodes.push({ id, cls: clsOf(api, l), name: L.str(l && l.Name), long: L.str(l && l.LongName), parent: -1 });
  }
  for (const n of nodes) { const p = anc(n.id); n.parent = p != null && p !== n.id ? at.get(p) : -1; }
  return {
    nodes,
    contOf: (id) => { const p = anc(id); return p != null ? at.get(p) : -1; },
    wholeOf: (id) => { const p = up.get(id); return p != null && !spatial.has(p) ? p : null; },
  };
}

/* ======================================================================
   Geometria per elemento
   ====================================================================== */
/* prodotti senza corpo da costruire: fori, spazi e zone, annotazioni, griglie, elementi virtuali */
const SKIP = ["IFCOPENINGELEMENT", "IFCSPACE", "IFCSPATIALZONE", "IFCANNOTATION", "IFCGRID", "IFCVIRTUALELEMENT"];

/**
 * Le mesh del modello per elemento, nelle coordinate del sito (toLocal di
 * ifcFrames) meno l'origine del modello o (il primo vertice, in doppia
 * precisione: i Float32 restano piccoli anche sulle coordinate di mappa).
 * A blocchi di prodotti con l'avanzamento, come il Terrain Sculptor: un
 * Worker fermo su un blocco si riconosce dal silenzio.
 * → { o, elements: [{ id, gid, cls, name, tag, cont, whole, tris }],
 *     boxes: Float32Array(6·n) (min, max per elemento, attorno a o),
 *     blocks: [{ P, C, E, I, e0, e1 }], triangles, bbox: { lo, hi } }
 *   P posizioni (Float32 ×3), C colore RGBA a byte per vertice, E indice
 *   dell'elemento nel modello (Float32: esatto fino a 16 milioni), I indici;
 *   e0…e1 gli elementi del blocco. Un blocco si chiude fra un elemento e
 *   l'altro oltre maxVerts vertici.
 */
export function ifcGeometry(api, mid, T, { toLocal = M_ID(), structure = null, exclude = [], chunk = 200, maxVerts = 4e6, progress = null } = {}) {
  const L = ifcTools(api, mid);
  const skip = new Set(exclude);
  for (const k of SKIP) for (const id of L.inh(T[k])) skip.add(id);
  const prods = L.inh(T.IFCPRODUCT).filter((id) => !skip.has(id));
  const els = [], box = [], pieces = [];
  let o = null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const cb = (mesh) => {
    const id = mesh.expressID, n = mesh.geometries.size();
    let k = -1;
    const a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
    for (let g = 0; g < n; g++) {
      const pg = mesh.geometries.get(g), geo = api.GetGeometry(mid, pg.geometryExpressID);
      const v = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
      const ix = api.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
      if (geo.delete) geo.delete();
      if (v.length < 18 || ix.length < 3) continue;
      if (k < 0) { k = els.length; els.push({ id, tris: 0 }); }
      /* sito ← Z-up ← mondo di web-ifc (Y-up) ← locale della mesh, in doppia precisione, una volta per mesh */
      const m = pg.flatTransformation;
      const A = mMul(toLocal, [m[0], m[4], m[8], m[12], -m[2], -m[6], -m[10], -m[14], m[1], m[5], m[9], m[13]]);
      if (!o) o = mApply(A, v[0], v[1], v[2]);
      A[3] -= o[0]; A[7] -= o[1]; A[11] -= o[2];
      const nv = v.length / 6, P = new Float32Array(nv * 3);
      for (let q = 0; q < nv; q++) {
        const x = v[6 * q], y = v[6 * q + 1], z = v[6 * q + 2];
        const X = A[0] * x + A[1] * y + A[2] * z + A[3], Y = A[4] * x + A[5] * y + A[6] * z + A[7], Z = A[8] * x + A[9] * y + A[10] * z + A[11];
        P[3 * q] = X; P[3 * q + 1] = Y; P[3 * q + 2] = Z;
        if (X < a[0]) a[0] = X; if (X > b[0]) b[0] = X;
        if (Y < a[1]) a[1] = Y; if (Y > b[1]) b[1] = Y;
        if (Z < a[2]) a[2] = Z; if (Z > b[2]) b[2] = Z;
      }
      const c = pg.color || { x: 0.8, y: 0.8, z: 0.8, w: 1 };
      const rgba = [c.x, c.y, c.z, c.w == null ? 1 : c.w].map((t) => Math.max(0, Math.min(255, Math.round(t * 255))));
      pieces.push({ k, P, I: Uint32Array.from(ix), rgba });
      els[k].tris += ix.length / 3;
    }
    if (k >= 0) {
      box.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      for (let c = 0; c < 3; c++) { if (a[c] < lo[c]) lo[c] = a[c]; if (b[c] > hi[c]) hi[c] = b[c]; }
    }
  };
  for (let p = 0; p < prods.length; p += chunk) {
    api.StreamMeshes(mid, prods.slice(p, p + chunk), cb);
    progress && progress({ done: Math.min(prods.length, p + chunk), total: prods.length });
  }
  /* chi è ogni elemento: lo si legge dopo lo streaming, una riga per elemento */
  for (const e of els) {
    const l = L.line(e.id);
    e.gid = L.str(l && l.GlobalId); e.cls = clsOf(api, l); e.name = L.str(l && l.Name); e.tag = L.str(l && l.Tag);
    e.cont = structure ? structure.contOf(e.id) : -1;
    e.whole = structure ? structure.wholeOf(e.id) : null;
  }
  /* blocchi: i pezzi arrivano già in ordine di elemento */
  const join = (list) => {
    let nv = 0, ni = 0;
    for (const q of list) { nv += q.P.length / 3; ni += q.I.length; }
    const P = new Float32Array(nv * 3), C = new Uint8Array(nv * 4), E = new Float32Array(nv), I = new Uint32Array(ni);
    let ov = 0, oi = 0;
    for (const q of list) {
      const m = q.P.length / 3;
      P.set(q.P, ov * 3);
      for (let j = 0; j < m; j++) { C.set(q.rgba, (ov + j) * 4); E[ov + j] = q.k; }
      for (let j = 0; j < q.I.length; j++) I[oi + j] = q.I[j] + ov;
      ov += m; oi += q.I.length;
    }
    return { P, C, E, I, e0: list[0].k, e1: list[list.length - 1].k + 1 };
  };
  const blocks = [];
  let cur = [], cv = 0;
  for (const q of pieces) {
    const nv = q.P.length / 3;
    if (cur.length && cv + nv > maxVerts && q.k !== cur[cur.length - 1].k) { blocks.push(join(cur)); cur = []; cv = 0; }
    cur.push(q); cv += nv;
  }
  if (cur.length) blocks.push(join(cur));
  let tris = 0;
  for (const e of els) tris += e.tris;
  return { o: o || [0, 0, 0], elements: els, boxes: Float32Array.from(box), blocks, triangles: tris, bbox: isFinite(lo[0]) ? { lo, hi } : null };
}

/* ======================================================================
   Proprietà al clic
   ====================================================================== */
/* simbolo di un'unità SI del progetto: «mm», «m²», «m³», «kg» (per le quantità) */
function unitSymbols(L, T) {
  const en = (x) => L.str(x).replace(/\./g, "").toUpperCase();
  const PFX = { KILO: "k", HECTO: "h", DECA: "da", DECI: "d", CENTI: "c", MILLI: "m", MICRO: "µ" };
  const BASE = { METRE: "m", SQUARE_METRE: "m²", CUBIC_METRE: "m³", GRAM: "g", SECOND: "s" };
  const out = {};
  for (const ua of L.ids(T.IFCUNITASSIGNMENT)) {
    const l = L.line(ua);
    for (const h of (l && l.Units) || []) {
      const u = L.line(L.ev(h));
      if (!u || u.UnitType == null) continue;
      const k = { LENGTHUNIT: "len", AREAUNIT: "area", VOLUMEUNIT: "vol", MASSUNIT: "mass", TIMEUNIT: "time" }[en(u.UnitType)];
      if (!k || out[k]) continue;
      if (u.ConversionFactor == null && BASE[en(u.Name)]) out[k] = (PFX[en(u.Prefix)] || "") + BASE[en(u.Name)];
      else if (u.Name != null) out[k] = L.str(u.Name).toLowerCase();
    }
    break;
  }
  return out;
}
/* nomi dei materiali di un'associazione: IfcMaterial, liste, strati, profili, costituenti, usi */
function materialNames(api, L, id, out = [], depth = 0) {
  const l = L.line(id);
  if (!l || depth > 6) return out;
  if (clsOf(api, l) === "IfcMaterial") { const n = L.str(l.Name); if (n && !out.includes(n)) out.push(n); return out; }
  for (const k of ["ForLayerSet", "ForProfileSet", "Material"]) if (l[k] != null) materialNames(api, L, L.ev(l[k]), out, depth + 1);
  for (const k of ["MaterialLayers", "MaterialProfiles", "MaterialConstituents", "Materials"]) for (const x of l[k] || []) materialNames(api, L, L.ev(x), out, depth + 1);
  return out;
}

/**
 * Gli indici delle proprietà, una volta per modello (al primo clic):
 * elemento → Pset, elemento → tipo, tipo → Pset, oggetto → materiali, e le
 * unità del progetto. Niente GetLine(…, true): sui tipi appiattisce anche
 * le geometrie (la trappola del viewer 2.8.4, 14–30 s su un solo tipo).
 */
export function ifcPropIndex(api, mid, T) {
  const L = ifcTools(api, mid);
  const psets = new Map(), typeOf = new Map(), typePsets = new Map(), mats = new Map();
  const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, a = []); if (!a.includes(v)) a.push(v); };
  for (const rid of L.ids(T.IFCRELDEFINESBYPROPERTIES)) {
    const r = L.line(rid);
    if (!r) continue;
    const defs = (Array.isArray(r.RelatingPropertyDefinition) ? r.RelatingPropertyDefinition : [r.RelatingPropertyDefinition]).map(L.ev).filter((x) => x != null);
    for (const o of r.RelatedObjects || []) for (const d of defs) push(psets, L.ev(o), d);
  }
  for (const rid of L.ids(T.IFCRELDEFINESBYTYPE)) {
    const r = L.line(rid);
    if (!r) continue;
    const t = L.ev(r.RelatingType);
    if (t == null) continue;
    for (const o of r.RelatedObjects || []) typeOf.set(L.ev(o), t);
    if (!typePsets.has(t)) { const tl = L.line(t); typePsets.set(t, ((tl && tl.HasPropertySets) || []).map(L.ev).filter((x) => x != null)); }
  }
  for (const rid of L.ids(T.IFCRELASSOCIATESMATERIAL)) {
    const r = L.line(rid);
    if (!r) continue;
    const names = materialNames(api, L, L.ev(r.RelatingMaterial));
    for (const o of r.RelatedObjects || []) for (const n of names) push(mats, L.ev(o), n);
  }
  return { psets, typeOf, typePsets, mats, units: unitSymbols(L, T) };
}

/* un valore IFC per il pannello: numeri come numeri, logici come true/false (IfcBoolean «T»/«F»), il resto testo */
export function ifcValue(x) {
  if (x == null) return null;
  if (Array.isArray(x)) { const a = x.map(ifcValue).filter((v) => v != null); return a.length ? a.join(", ") : null; }
  if (typeof x === "object") {
    if (!("value" in x)) return null;
    const c = x.constructor && x.constructor.name, v = x.value;
    if (c === "IfcBoolean" || c === "IfcLogical" || typeof v === "boolean") {
      const s = String(v).replace(/\./g, "").toUpperCase();
      return v === true || s === "T" || s === "TRUE" ? true : v === false || s === "F" || s === "FALSE" ? false : null;
    }
    return ifcValue(v);
  }
  if (typeof x === "number") return isFinite(x) ? x : null;
  const s = String(x);
  return s === "" ? null : s;
}
const QTY = [["LengthValue", "len"], ["AreaValue", "area"], ["VolumeValue", "vol"], ["CountValue", ""], ["WeightValue", "mass"], ["TimeValue", "time"]];
/* un Pset o una IfcElementQuantity → { name, qto, props: [[nome, valore, unità?]] } (null se vuoto) */
function readSet(L, api, id, units) {
  const s = L.line(id);
  if (!s) return null;
  const out = { name: L.str(s.Name), qto: !!s.Quantities, props: [] };
  for (const r of s.HasProperties || []) {
    const p = L.line(L.ev(r));
    if (!p) continue;
    let v = null;
    if (p.NominalValue !== undefined) v = ifcValue(p.NominalValue);
    else if (p.EnumerationValues) v = ifcValue(p.EnumerationValues);
    else if (p.ListValues) v = ifcValue(p.ListValues);
    else if (p.UpperBoundValue !== undefined || p.LowerBoundValue !== undefined) {
      const a = ifcValue(p.LowerBoundValue), b = ifcValue(p.UpperBoundValue);
      v = a == null && b == null ? null : `${a ?? "…"} – ${b ?? "…"}`;
    } else if (p.HasProperties) v = (p.HasProperties || []).map((x) => { const q = L.line(L.ev(x)); return q ? L.str(q.Name) : ""; }).filter(Boolean).join(", ") || null;
    out.props.push([L.str(p.Name), v]);
  }
  for (const r of s.Quantities || []) {
    const q = L.line(L.ev(r));
    if (!q) continue;
    let v = null, u = "";
    for (const [k, uk] of QTY) if (q[k] != null) { v = ifcValue(q[k]); u = uk ? units[uk] || "" : ""; break; }
    out.props.push(u ? [L.str(q.Name), v, u] : [L.str(q.Name), v]);
  }
  return out.props.length ? out : null;
}

/**
 * Le proprietà di un elemento per il pannello (clonabili: escono dal Worker).
 * → { id, cls, attrs: [[nome, valore]], type: { id, cls, name } | null,
 *     sets: [{ name, qto, fromType?, props }], mats: [nomi] }
 */
export function ifcProps(api, mid, T, idx, id) {
  const L = ifcTools(api, mid), l = L.line(id);
  if (!l) return null;
  const out = { id, cls: clsOf(api, l), attrs: [], type: null, sets: [], mats: [] };
  for (const k of ["GlobalId", "Name", "Description", "ObjectType", "Tag", "PredefinedType", "LongName"]) {
    const v = ifcValue(l[k]);
    if (v != null && v !== "") out.attrs.push([k, typeof v === "string" ? v.replace(/^\.|\.$/g, "") : v]);
  }
  const t = idx.typeOf.get(id);
  if (t != null) { const tl = L.line(t); out.type = { id: t, cls: clsOf(api, tl), name: L.str(tl && tl.Name) }; }
  for (const pid of idx.psets.get(id) || []) { const s = readSet(L, api, pid, idx.units); if (s) out.sets.push(s); }
  if (t != null) for (const pid of idx.typePsets.get(t) || []) { const s = readSet(L, api, pid, idx.units); if (s) { s.fromType = true; out.sets.push(s); } }
  out.mats = (idx.mats.get(id) || (t != null ? idx.mats.get(t) : null) || []).slice();
  return out;
}

/* ======================================================================
   Le proprietà di tutti gli elementi, per il collegamento (F3)
   ====================================================================== */
const ATTRS = ["Name", "Description", "ObjectType", "Tag"];
/**
 * La tabella delle proprietà di tutti gli elementi, letta una volta dopo la
 * geometria: il collegamento confronta un campo del programma con una
 * proprietà, e per proporre quale (e contare la copertura) servono i valori
 * di tutti. Per ogni proprietà semplice dei Pset (valore singolo, enumerato,
 * elenco) dell'elemento e del suo tipo — quella dell'elemento vince — e per
 * gli attributi Name, Description, ObjectType, Tag (pset ""): quali elementi
 * la hanno e con che valore, come testo. Le quantità restano fuori: non
 * portano codici. Le righe si leggono a blocchi (GetLines: un passaggio nel
 * WASM per blocco, non uno per riga) e un Pset condiviso una volta sola.
 * els: gli elementi di ifcGeometry.
 * → { keys: [[pset, nome]], dict: [valori], cols: [{ e: Int32Array, v: Int32Array }],
 *     types: Int32Array (per elemento, indice in tnames, −1 senza tipo), tnames: [nomi dei tipi] }
 *   e = indici in els, v = indici in dict: colonne sparse, valori ripetuti una volta
 */
export function ifcPropTable(api, mid, T, els, { batch = 4000, progress = null } = {}) {
  const L = ifcTools(api, mid);
  const many = (ids) => {
    const out = new Map();
    for (let p = 0; p < ids.length; p += batch) {
      const part = ids.slice(p, p + batch);
      let got = null;
      if (api.GetLines) try { got = api.GetLines(mid, part); } catch (e) { got = null; }
      if (got && got.length === part.length) part.forEach((id, i) => { if (got[i]) out.set(id, got[i]); });
      else for (const id of part) { const l = L.line(id); if (l) out.set(id, l); }
    }
    return out;
  };
  const kOf = new Map(els.map((e, k) => [e.id, k]));
  const inst = new Map(), typ = new Map(), typePs = new Map();          // elemento → Pset, elemento → tipo, tipo → Pset
  for (const r of many(L.ids(T.IFCRELDEFINESBYPROPERTIES)).values()) {
    const defs = (Array.isArray(r.RelatingPropertyDefinition) ? r.RelatingPropertyDefinition : [r.RelatingPropertyDefinition]).map(L.ev).filter((x) => x != null);
    for (const o of r.RelatedObjects || []) { const k = kOf.get(L.ev(o)); if (k == null) continue; let a = inst.get(k); if (!a) inst.set(k, (a = [])); a.push(...defs); }
  }
  for (const r of many(L.ids(T.IFCRELDEFINESBYTYPE)).values()) {
    const t = L.ev(r.RelatingType);
    if (t == null) continue;
    for (const o of r.RelatedObjects || []) { const k = kOf.get(L.ev(o)); if (k != null) typ.set(k, t); }
  }
  const tname = new Map();
  for (const [t, l] of many([...new Set(typ.values())])) {
    typePs.set(t, ((l && l.HasPropertySets) || []).map(L.ev).filter((x) => x != null));
    tname.set(t, L.str(l && l.Name) || clsOf(api, l));
  }
  progress && progress({ step: 1 });
  /* i Pset e le loro proprietà, una volta ciascuno */
  const psIds = new Set();
  for (const a of inst.values()) for (const id of a) psIds.add(id);
  for (const a of typePs.values()) for (const id of a) psIds.add(id);
  const psLines = many([...psIds]), propIds = new Set();
  for (const s of psLines.values()) for (const r of s.HasProperties || []) { const id = L.ev(r); if (id != null) propIds.add(id); }
  const text = (v) => (v == null ? "" : typeof v === "boolean" ? (v ? "true" : "false") : String(v));
  const pval = new Map();
  for (const [id, p] of many([...propIds])) {
    if (p.Name == null) continue;
    const v = p.NominalValue !== undefined ? ifcValue(p.NominalValue) : p.EnumerationValues ? ifcValue(p.EnumerationValues) : p.ListValues ? ifcValue(p.ListValues) : null;
    const s = text(v);
    if (s) pval.set(id, [L.str(p.Name), s]);
  }
  const psProps = new Map();
  for (const [id, s] of psLines) {
    if (!s.HasProperties) continue;                 // quantità e definizioni senza proprietà
    const props = [];
    for (const r of s.HasProperties) { const pv = pval.get(L.ev(r)); if (pv) props.push(pv); }
    if (props.length) psProps.set(id, [L.str(s.Name), props]);
  }
  progress && progress({ step: 2 });
  /* le colonne: attributi, poi i Pset dell'elemento, poi quelli del tipo (l'elemento vince) */
  const keyAt = new Map(), keys = [], dictAt = new Map(), dict = [], E = [], V = [];
  const elLines = many(els.map((e) => e.id));
  els.forEach((e, k) => {
    const seen = new Set();
    const put = (pset, name, s) => {
      const kk = pset + "\u0001" + name;
      let c = keyAt.get(kk);
      if (c == null) { c = keys.length; keyAt.set(kk, c); keys.push([pset, name]); E.push([]); V.push([]); }
      if (seen.has(c)) return;
      seen.add(c);
      let d = dictAt.get(s);
      if (d == null) { d = dict.length; dictAt.set(s, d); dict.push(s); }
      E[c].push(k); V[c].push(d);
    };
    const l = elLines.get(e.id);
    if (l) for (const a of ATTRS) { const s = text(ifcValue(l[a])); if (s) put("", a, s); }
    for (const id of [...(inst.get(k) || []), ...(typ.has(k) ? typePs.get(typ.get(k)) || [] : [])]) {
      const ps = psProps.get(id);
      if (ps) for (const [n, s] of ps[1]) put(ps[0], n, s);
    }
  });
  /* il tipo di ogni elemento, per la selezione simile (0.6.2): indice in tnames, −1 = senza tipo */
  const tnames = [], tAt = new Map(), types = new Int32Array(els.length).fill(-1);
  for (const [k, t] of typ) {
    const s = tname.get(t);
    if (!s) continue;
    let j = tAt.get(s);
    if (j == null) { j = tnames.length; tAt.set(s, j); tnames.push(s); }
    types[k] = j;
  }
  return { keys, dict, cols: E.map((a, c) => ({ e: Int32Array.from(a), v: Int32Array.from(V[c]) })), types, tnames };
}

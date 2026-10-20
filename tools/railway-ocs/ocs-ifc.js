/* =========================================================================
   Trazione elettrica (Railway OCS) — export IFC 4x3 (tool 18, F6, 0.10.0)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Senza DOM (si prova in Node: test/test_ocs_ifc.js, e con IfcOpenShell).
   La pagina lo carica solo quando si esporta. Scelte (PIANO §10 e §20):
   - coordinate del file = coordinate dei binari (quelle del federato), niente
     IfcMapConversion; IfcSite nell'origine della scena (metri tondi), gli
     IfcAlignment in coordinate ASSOLUTE con placement nell'origine del mondo
     (come Sviluppo profili: il viewer ignora il placement dell'asse);
   - struttura: IfcProject → IfcSite → IfcRailway → un IfcRailwayPart
     .ABOVETRACK. per binario coi suoi sostegni e le fondazioni; gli assi nel
     sito; le rotaie (se chieste) nella IfcRailway;
   - sostegni: IfcLocalPlacement CARTESIANO già ruotato sulla tangente (il
     web-ifc 0.0.77 del viewer sbaglia l'IfcLinearPlacement in curva, F0
     §10.1); palo = IfcElementAssembly .MAST. (fusto IfcColumn .STANDCOLUMN.,
     piastra IfcPlate .BASE_PLATE., mensola IfcMember .MEMBER., tiranti
     .TIEBAR., sospensioni .SUSPENDER., trafo IfcTransformer .VOLTAGE.,
     sezionatore IfcSwitchingDevice .SWITCHDISCONNECTOR.); portale =
     IfcElementAssembly .SUPPORTINGASSEMBLY. (montanti IfcColumn, trave
     IfcBeam .BEAM., pendoli IfcMember .SUSPENDER.); fondazione = IfcFooting
     .PAD_FOOTING. a parte, col suo Pset. Il Pset del sostegno sta sull'assieme
     E sulle sue parti (stessa IfcPropertySet): nel viewer si clicca una
     parte, l'assieme non ha geometria;
   - geometria condivisa (IfcTypeProduct + IfcRepresentationMap +
     IfcMappedItem): fusto per tipo di palo e dettaglio, piastra, mensola per
     lunghezza, fondazione per tipo e pilastrino, trave per tipo. Tiranti,
     pendoli e piloni PO (stirati) hanno la loro geometria. Solidi = estrusi
     rettangolari / circolari / rettangolari cavi;
   - famiglie RFI (0.17.0, ocs-rfi.js, PIANO §23): i sostegni che hanno la
     famiglia del catalogo Revit escono coi pezzi della famiglia al posto delle
     parti semplificate, un tipo per pezzo col nome della famiglia Revit
     (RFI_Palo_LSU16b, RFI_Plinto_LSU P4, RFI_Mensola_D76x5 768-427_L3800,
     RFI_Pilone_E65041, RFI_TraveMEC_C_CL2…): palo = IfcColumn (piastra,
     fusto, traliccio, tirafondi), attacchi IfcDiscreteAccessory .BRACKET.,
     mensola IfcMember, tiranti 24 × 24 IfcMember .TIEBAR., plinti e
     fondazioni dei portali IfcFooting, piloni IfcColumn, travi IfcBeam (un
     elemento per tratto). Solidi: estrusi di contorni qualsiasi (anche coi
     fori), tondi e tubi, tondi piegati IfcSweptDiskSolid;
   - assi: logica di progetto (pianta LINE / CIRCULARARC / CLOTHOID, profilo
     CONSTANTGRADIENT / CIRCULARARC / PARABOLICARC, sopraelevazione
     CONSTANTCANT / LINEARTRANSITION) + geometria di pianta e profilo
     (IfcCompositeCurve, IfcGradientCurve) + referente con Pset_Stationing
     per la progressiva iniziale. Con l'offset l'IfcAlignment è l'asse
     RICEVUTO (l'offset sta nella descrizione); i sostegni e le rotaie
     stanno sul binario vero.
   ========================================================================= */
import * as C from "./ocs-core.js?v=0.22.1";
import * as RFI from "./ocs-rfi.js?v=0.22.1";
import { writeStep } from "../common/pset-core.js?v=1.1.0";
import { ifcGuid, stepStr, stepReal, chainage } from "../profile-sweep/profile-io.js?v=0.22.0";

/* nomi di partenza (la pagina li passa nella sua lingua) */
export const IFC_LABELS = {
  site: "Sito", railway: "Trazione elettrica", mast: "Palo", portal: "Portale", stem: "Fusto", plate: "Piastra", mens: "Mensola",
  tie: "Tirante", susp: "Sospensione", pend: "Pendolo", found: "Fondazione", beam: "Trave", pole: "Pilone", trafo: "Trasformatore",
  sez: "Sezionatore", att: "Attacco mensola", attTie: "Attacco tirante", attBeam: "Attacco trave", railL: "Rotaia sinistra", railR: "Rotaia destra", steel: "Acciaio", concrete: "Calcestruzzo", offset: "Offset dall'asse ricevuto",
};
export const LODS = ["box", "upn", "lattice"];
/* rotaia semplice (rettangolo sotto il piano del ferro, fuori dal bordo interno) e aste dei tiranti/pendoli */
export const RAIL = { w: 0.072, h: 0.172 };
export const ROD_R = 0.012;
const MENS_SEC = 0.06;                                   // = la scatola della mensola in ocs-core supportParts

/**
 * job = {
 *   name (progetto), fileName?, app: { name, version }, date?, guid?: () → GlobalId (test),
 *   origin: { x, y } (E, N dell'IfcSite: l'origine della scena), lod ("box" | "upn" | "lattice"),
 *   labels?: { …IFC_LABELS nella lingua della pagina },
 *   tracks: [{ name, T (binario del motore), gauge (RailHeadDistance), align (scrivere l'IfcAlignment),
 *              rails (scrivere le rotaie), sups: [{ s (sostegno), R (risolto), own: Pset risolti del palo/portale,
 *              found: Pset risolti della fondazione }] }],
 *   railStep (passo delle rotaie, m)
 * } → { text (STEP), n: { masts, portals, footings, types, aligns, rails, parts } }
 */
export function ocsIfc(job) {
  const L = [];
  let id = 0;
  const e = (s) => { L.push("#" + ++id + "=" + s + ";"); return "#" + id; };
  const G = () => "'" + (job.guid ? job.guid() : ifcGuid()) + "'";
  const R = (x, d = 6) => stepReal(x, d), S = stepStr, lb = { ...IFC_LABELS, ...(job.labels || {}) };
  const O = job.origin || { x: 0, y: 0 }, lod = LODS.includes(job.lod) ? job.lod : "lattice";
  const date = job.date || new Date();
  const n = { masts: 0, portals: 0, footings: 0, types: 0, aligns: 0, rails: 0, parts: 0 };

  // --- progetto (come Sviluppo profili)
  const org = e(`IFCORGANIZATION($,'viewifc.com',$,$,$)`);
  const pao = e(`IFCPERSONANDORGANIZATION(${e("IFCPERSON($,$,$,$,$,$,$,$)")},${org},$)`);
  const app = e(`IFCAPPLICATION(${org},${S(job.app.version)},${S(job.app.name)},'viewifc-railway-ocs')`);
  const oh = e(`IFCOWNERHISTORY(${pao},${app},$,.ADDED.,$,$,$,${Math.floor(date.getTime() / 1000)})`);
  const U = [e("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)"), e("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)"), e("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)"), e("IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)")];
  const ua = e(`IFCUNITASSIGNMENT((${U.join(",")}))`);
  const o3 = e("IFCCARTESIANPOINT((0.,0.,0.))");
  const DIRS = new Map();
  const D3 = (x, y, z) => { const k = [x, y, z].map((v) => R(v, 12)).join(","); if (!DIRS.has(k)) DIRS.set(k, e(`IFCDIRECTION((${k}))`)); return DIRS.get(k); };
  const Z = D3(0, 0, 1);
  const wcs = e(`IFCAXIS2PLACEMENT3D(${o3},${Z},${D3(1, 0, 0)})`);
  const ctx = e(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${wcs},$)`);
  const body = e(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const axisCtx = e(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const proj = e(`IFCPROJECT(${G()},${oh},${S(job.name || "")},$,$,$,$,(${ctx}),${ua})`);
  const P3 = (x, y, z) => e(`IFCCARTESIANPOINT((${R(x, 4)},${R(y, 4)},${R(z, 4)}))`);
  const A3 = (p, ax, rd) => e(`IFCAXIS2PLACEMENT3D(${p},${ax || "$"},${rd || "$"})`);
  const LP = (rel, a) => e(`IFCLOCALPLACEMENT(${rel || "$"},${a})`);
  const a0 = A3(o3);                                     // identità (placement figli, origine delle mappe)
  const sitePl = LP(null, A3(P3(O.x, O.y, 0)));
  const site = e(`IFCSITE(${G()},${oh},${S(lb.site)},$,$,${sitePl},$,$,.ELEMENT.,$,$,0.,$,$)`);
  e(`IFCRELAGGREGATES(${G()},${oh},$,$,${proj},(${site}))`);
  const railPl = LP(sitePl, a0);
  const railway = e(`IFCRAILWAY(${G()},${oh},${S(job.name || lb.railway)},${S(lb.railway)},$,${railPl},$,$,.ELEMENT.,$)`);
  e(`IFCRELAGGREGATES(${G()},${oh},$,$,${site},(${railway}))`);
  const inSite = [], inRailway = [], parts = [], steel = [], conc = [];

  // --- stili
  const style = (rgb, name) => e(`IFCSURFACESTYLE(${S(name)},.BOTH.,(${e(`IFCSURFACESTYLESHADING(${e(`IFCCOLOURRGB($,${R(rgb[0], 3)},${R(rgb[1], 3)},${R(rgb[2], 3)})`)},0.)`)}))`);
  const ST = {}, st = (k) => ST[k] || (ST[k] = style(
    { steel: [0.6, 0.64, 0.67], dark: [0.42, 0.46, 0.5], conc: [0.66, 0.64, 0.58], equip: [0.88, 0.65, 0.23], rail: [0.33, 0.33, 0.35] }[k], k));
  const styled = (items, k) => { const s = st(k); for (const it of items) e(`IFCSTYLEDITEM(${it},(${s}),$)`); return items; };

  // --- solidi (coordinate del sistema dell'oggetto)
  // profili col Position esplicito: facoltativo nello schema, ma il web-ifc 0.0.77 del viewer senza scrive un errore in
  // console per ogni solido (migliaia col traliccio; provato in Node)
  let p2o = null;
  const P2O = () => p2o || (p2o = e(`IFCAXIS2PLACEMENT2D(${e("IFCCARTESIANPOINT((0.,0.))")},$)`));
  const PROF = new Map(), prof = (k, make) => PROF.get(k) || (PROF.set(k, make()), PROF.get(k));
  const rect = (x, y) => prof("r" + R(x, 5) + "x" + R(y, 5), () => e(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${P2O()},${R(x, 5)},${R(y, 5)})`));
  const circ = (r) => prof("c" + R(r, 5), () => e(`IFCCIRCLEPROFILEDEF(.AREA.,$,${P2O()},${R(r, 5)})`));
  const hollow = (x, y, t) => prof("h" + [x, y, t].map((v) => R(v, 5)).join("x"), () => e(`IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,${P2O()},${R(x, 5)},${R(y, 5)},${R(t, 5)},$,$)`));
  const ext = (pr, base, w, u, depth) => {
    const ident = Math.abs(w[2] - 1) < 1e-12 && Math.abs(u[0] - 1) < 1e-12;
    return e(`IFCEXTRUDEDAREASOLID(${pr},${A3(P3(...base), ident ? null : D3(...w), ident ? null : D3(...u))},${Z},${R(depth, 5)})`);
  };
  /* scatola { c, h (semilati), ax: [u, v, w] } come mastSolids/beamSolids */
  const boxSolid = (b, dz = 0) => {
    const [u, , w] = b.ax || [[1, 0, 0], [0, 1, 0], [0, 0, 1]], c = b.c, h = b.h;
    return ext(rect(2 * h[0], 2 * h[1]), [c[0] - h[2] * w[0], c[1] - h[2] * w[1], c[2] - h[2] * w[2] + dz], w, u, 2 * h[2]);
  };
  const aBox = (cx, cy, cz, sx, sy, sz) => boxSolid({ c: [cx, cy, cz], h: [sx / 2, sy / 2, sz / 2] });
  /* asta da a a b (circolare, raggio r; o col profilo pr) */
  const rod = (a, b, r = ROD_R, pr = null) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = Math.hypot(...d);
    if (!(len > 1e-6)) return null;
    const w = d.map((v) => v / len);
    const h = Math.abs(w[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], c = [h[1] * w[2] - h[2] * w[1], h[2] * w[0] - h[0] * w[2], h[0] * w[1] - h[1] * w[0]];
    const lc = Math.hypot(...c), u = c.map((v) => v / lc);   // perpendicolare all'asta
    return ext(pr || circ(r), a, w, u, len);
  };
  const shape = (items, kind = "SweptSolid") => e(`IFCPRODUCTDEFINITIONSHAPE($,$,(${e(`IFCSHAPEREPRESENTATION(${body},'Body','${kind}',(${items.join(",")}))`)}))`);

  // --- solidi delle famiglie RFI (0.17.0, ocs-rfi.js: metri, nel riferimento del pezzo)
  const ring = (r, t) => prof("o" + R(r, 5) + "x" + R(t, 5), () => e(`IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,$,${P2O()},${R(r, 5)},${R(t, 5)})`));
  const P2r = (u, v) => e(`IFCCARTESIANPOINT((${R(u, 5)},${R(v, 5)}))`);
  const loopProf = (s) => prof("p" + s.loop.map(([u, v]) => R(u, 5) + "," + R(v, 5)).join(";") + "|" + s.holes.map((h) => h.map((v) => R(v, 5)).join(",")).join(";"), () => {
    const pts = s.loop.map(([u, v]) => P2r(u, v)), outer = e(`IFCPOLYLINE((${[...pts, pts[0]].join(",")}))`);
    if (!s.holes.length) return e(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${outer})`);
    const voids = s.holes.map(([u, v, r]) => e(`IFCCIRCLE(${e(`IFCAXIS2PLACEMENT2D(${P2r(u, v)},$)`)},${R(r, 5)})`));
    return e(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,${outer},(${voids.join(",")}))`);
  });
  const rfiItem = (s) => {
    if (s.t === "ext") return ext(loopProf(s), s.o, s.n, s.u, s.d);
    if (s.t === "bar") return rod(s.a, s.b, s.r, s.ri > 0 ? ring(s.r, s.r - s.ri) : null);
    return e(`IFCSWEPTDISKSOLID(${e(`IFCPOLYLINE((${s.pts.map((p) => P3(...p)).join(",")}))`)},${R(s.r, 5)},$,$,$)`);
  };
  /* i tondi piegati non sono IfcSweptAreaSolid: con loro la rappresentazione è 'AdvancedSweptSolid' */
  const repKind = (solids) => (solids.some((s) => s.t === "sweep") ? "AdvancedSweptSolid" : "SweptSolid");

  // --- tipi condivisi
  const TYPES = new Map();
  const CTO = e(`IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,${o3},1.,$)`);
  const typeOf = (key, cls, predef, name, mk, sk, kind = "SweptSolid") => {
    let T = TYPES.get(key);
    if (!T) {
      const items = styled(mk(), sk);
      const map = e(`IFCREPRESENTATIONMAP(${a0},${e(`IFCSHAPEREPRESENTATION(${body},'Body','${kind}',(${items.join(",")}))`)})`);
      T = { ty: e(`${cls}(${G()},${oh},${S(name)},$,$,$,(${map}),$,$,.${predef}.)`), map, occ: [] };
      TYPES.set(key, T); n.types++;
    }
    return T;
  };
  const mastLabel = (Rs) => (Rs.mast ? (Rs.dbl ? "2×" : "") + Rs.mast.id : Rs.pole ? Rs.pole.id : "PO");   // = ocs-catalog mastLabel
  const mapped = (T) => e(`IFCPRODUCTDEFINITIONSHAPE($,$,(${e(`IFCSHAPEREPRESENTATION(${body},'Body','MappedRepresentation',(${e(`IFCMAPPEDITEM(${T.map},${CTO})`)}))`)}))`);
  const mastType = (M) => typeOf("mast|" + M.id + "|" + lod, "IFCCOLUMNTYPE", "STANDCOLUMN", M.id, () => C.mastSolids(M, lod).map((b) => boxSolid(b, M.H / 2)), "steel");
  // piastra (0.12.0: per taglia del palo, E 66013 c): sl lungo il binario, st trasversale, t spessore
  const mm = (v) => Math.round(v * 1000);
  const plateType = (sl, st, t) => typeOf("plate|" + sl + "|" + st + "|" + t, "IFCPLATETYPE", "BASE_PLATE", lb.plate + " " + (mm(sl) === mm(st) ? mm(st) : mm(st) + "×" + mm(sl)) + "×" + mm(t), () => [aBox(0, 0, t / 2, sl, st, t)], "steel");
  const mensType = (mens) => typeOf("mens|" + mens.L, "IFCMEMBERTYPE", "MEMBER", lb.mens + " " + mens.code + " L " + R(mens.L, 3), () => [aBox(0, mens.L / 2, 0, MENS_SEC, mens.L, MENS_SEC)], "dark");
  // trave dei portali a coordinate (0.11.0): lunga quanto la distanza fra i montanti, un tipo per lunghezza
  const beamType = (B, fix) => typeOf("beam|" + B.id + "|" + B.L.toFixed(3) + "|" + lod, "IFCBEAMTYPE", "BEAM", B.id + (fix ? " L " + R(B.L, 3) : ""), () => C.beamSolids(B, lod).map((b) => boxSolid(b)), "dark");
  /* fondazione: origine sulla testa del pilastrino, asse del palo; +y = verso cui il blocco B è eccentrico */
  const footType = (Fd, c1) => typeOf("found|" + Fd.id + "|" + Math.round(c1 * 1000), "IFCFOOTINGTYPE", "PAD_FOOTING", Fd.id + (c1 !== 0.25 ? " C1 " + R(c1, 3) : ""), () => [
    aBox(0, 0, -c1 / 2, Fd.B1, Fd.A1, c1),
    aBox(0, Fd.A2 != null ? Fd.A / 2 - Fd.A2 : 0, -c1 - Fd.C / 2, Fd.B, Fd.A, Fd.C),
  ], "conc");

  // --- assi
  const P2 = (x, y) => e(`IFCCARTESIANPOINT((${R(x)},${R(y)}))`);
  const D2 = (a) => e(`IFCDIRECTION((${R(Math.cos(a), 12)},${R(Math.sin(a), 12)}))`);
  const line0 = () => e(`IFCLINE(${e("IFCCARTESIANPOINT((0.,0.))")},${e(`IFCVECTOR(${e("IFCDIRECTION((1.,0.))")},1.)`)})`);
  const circle0 = (sgn, r) => e(`IFCCIRCLE(${e(`IFCAXIS2PLACEMENT2D(${e(`IFCCARTESIANPOINT((0.,${R(sgn * r)}))`)},${e(`IFCDIRECTION((0.,${sgn > 0 ? "-1." : "1."}))`)})`)},${R(r)})`);
  const writeAlign = (t) => {
    const T = t.T, H = T.H, segs = H.segs, hCurve = [], hBiz = [];
    segs.forEach((g, i) => {
      const nx = segs[i + 1], end = C.hEval(g, g.len);
      const kink = nx ? Math.abs(Math.atan2(Math.sin(nx.th0 - end.th), Math.cos(nx.th0 - end.th))) : 0;
      const trans = !nx ? ".DISCONTINUOUS." : kink < 1e-6 ? ".CONTSAMEGRADIENT." : ".CONTINUOUS.";
      const pl = e(`IFCAXIS2PLACEMENT2D(${P2(g.x0, g.y0)},${D2(g.th0)})`);
      const rad = (k) => (Math.abs(k) > 1e-15 ? 1 / k : 0);
      let type, parent, s0 = 0, len = g.len;
      const dk = (g.k1 - g.k0) / g.len;
      if (g.t === "L" || (Math.abs(g.k0) < 1e-15 && Math.abs(g.k1) < 1e-15)) { type = "LINE"; parent = line0(); }
      else if (g.t === "A" || Math.abs(dk) < 1e-15) { type = "CIRCULARARC"; const sg = Math.sign(g.k0); parent = circle0(sg, 1 / Math.abs(g.k0)); len = sg * g.len; }
      else {                                              // clotoide come il tool 11 LandXML → IFC: κ(s) = s / (A·|A|)
        type = "CLOTHOID";
        const A = Math.sign(dk) * Math.sqrt(1 / Math.abs(dk));
        s0 = g.k0 * A * Math.abs(A);
        parent = e(`IFCCLOTHOID(${e(`IFCAXIS2PLACEMENT2D(${e("IFCCARTESIANPOINT((0.,0.))")},${e("IFCDIRECTION((1.,0.))")})`)},${R(A, 6)})`);
      }
      hCurve.push(e(`IFCCURVESEGMENT(${trans},${pl},IFCLENGTHMEASURE(${R(s0)}),IFCLENGTHMEASURE(${R(len)}),${parent})`));
      const r0 = type === "LINE" ? 0 : rad(g.k0), r1 = type === "LINE" ? 0 : type === "CIRCULARARC" ? r0 : rad(g.k1);
      hBiz.push(e(`IFCALIGNMENTSEGMENT(${G()},${oh},'H${i + 1}',$,$,$,$,${e(`IFCALIGNMENTHORIZONTALSEGMENT($,$,${P2(g.x0, g.y0)},${R(g.th0, 12)},${R(r0)},${R(r1)},${R(g.len)},$,.${type}.)`)})`));
    });
    const comp = e(`IFCCOMPOSITECURVE((${hCurve.join(",")}),.F.)`);
    const reps = [e(`IFCSHAPEREPRESENTATION(${axisCtx},'FootPrint','Curve2D',(${comp}))`)];
    const vs = (T.V && T.V.segs) || [], vCurve = [], vBiz = [];
    vs.forEach((v, i) => {
      if (!(v.len > 1e-9)) return;
      const nv = Math.hypot(1, v.g0), nx = vs[i + 1];
      const trans = !nx ? ".DISCONTINUOUS." : Math.abs(nx.g0 - v.g1) < 1e-9 ? ".CONTSAMEGRADIENT." : ".CONTINUOUS.";
      const pl = e(`IFCAXIS2PLACEMENT2D(${e(`IFCCARTESIANPOINT((${R(v.u0)},${R(v.z0)}))`)},${e(`IFCDIRECTION((${R(1 / nv, 12)},${R(v.g0 / nv, 12)}))`)})`);
      const bend = v.R && Math.abs(v.g1 - v.g0) > 1e-12;
      if (bend && v.circ) {
        // raccordo circolare: il cerchio del motore (raggio R, tangente all'inizio) nella forma che scrive IfcOpenShell
        // (_map_circular_arc: centro rispetto al punto d'inizio, parametro = R · angolo del raggio). La forma «cerchio
        // con l'inizio nell'origine», giusta in pianta, il kernel la prolunga oltre la fine nel profilo (provato)
        const r = Math.abs(v.R), sg = Math.sign(v.g1 - v.g0), a0v = Math.atan(v.g0);
        const a1v = Math.asin(Math.max(-1, Math.min(1, Math.sin(a0v) + sg * v.len / r)));
        const sh = sg > 0 ? 1.5 * Math.PI : 0.5 * Math.PI, cx = -sg * r * Math.sin(a0v), cy = sg * r * Math.cos(a0v);
        const cir = e(`IFCCIRCLE(${e(`IFCAXIS2PLACEMENT2D(${e(`IFCCARTESIANPOINT((${R(cx)},${R(cy)}))`)},${e("IFCDIRECTION((1.,0.))")})`)},${R(r)})`);
        vCurve.push(e(`IFCCURVESEGMENT(${trans},${pl},IFCLENGTHMEASURE(${R(r * (a0v + sh))}),IFCLENGTHMEASURE(${R(r * (a1v - a0v))}),${cir})`));
        vBiz.push(e(`IFCALIGNMENTSEGMENT(${G()},${oh},'V${i + 1}',$,$,$,$,${e(`IFCALIGNMENTVERTICALSEGMENT($,$,${R(v.u0)},${R(v.len)},${R(v.z0)},${R(v.g0, 9)},${R(v.g1, 9)},${R(v.R)},.CIRCULARARC.)`)})`));
      } else if (bend) {                                  // parabolico: come Sviluppo profili (verificato con IfcOpenShell)
        const c2 = (v.g1 - v.g0) / (2 * v.len);
        const par = e(`IFCPOLYNOMIALCURVE(${e(`IFCAXIS2PLACEMENT2D(${e("IFCCARTESIANPOINT((0.,0.))")},${e("IFCDIRECTION((1.,0.))")})`)},(0.,1.),(0.,${R(v.g0, 9)},${R(c2, 12)}),$)`);
        vCurve.push(e(`IFCCURVESEGMENT(${trans},${pl},IFCPARAMETERVALUE(0.),IFCPARAMETERVALUE(${R(v.len)}),${par})`));
        vBiz.push(e(`IFCALIGNMENTSEGMENT(${G()},${oh},'V${i + 1}',$,$,$,$,${e(`IFCALIGNMENTVERTICALSEGMENT($,$,${R(v.u0)},${R(v.len)},${R(v.z0)},${R(v.g0, 9)},${R(v.g1, 9)},${R(v.len / (v.g1 - v.g0))},.PARABOLICARC.)`)})`));
      } else {
        vCurve.push(e(`IFCCURVESEGMENT(${trans},${pl},IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(${R(v.len * nv)}),${line0()})`));
        vBiz.push(e(`IFCALIGNMENTSEGMENT(${G()},${oh},'V${i + 1}',$,$,$,$,${e(`IFCALIGNMENTVERTICALSEGMENT($,$,${R(v.u0)},${R(v.len)},${R(v.z0)},${R(v.g0, 9)},${R(v.g0, 9)},$,.CONSTANTGRADIENT.)`)})`));
      }
    });
    if (vCurve.length) reps.push(e(`IFCSHAPEREPRESENTATION(${axisCtx},'Axis','Curve3D',(${e(`IFCGRADIENTCURVE((${vCurve.join(",")}),.F.,${comp},$)`)}))`));
    // sopraelevazione (solo logica di progetto): la rotaia interna resta sul profilo, l'esterna sale di c
    const cs = (T.cant || []).slice().sort((p, q) => p.u - q.u), cBiz = [];
    if (cs.some((c) => c.c > 0)) {
      const lr = (c, dir) => (dir > 0 ? [0, c] : dir < 0 ? [c, 0] : [0, 0]);
      for (let i = 0; i + 1 < cs.length; i++) {
        const a = cs[i], b = cs[i + 1], len = b.u - a.u;
        if (!(len > 1e-6)) continue;
        const dir = a.dir || b.dir, [l0, r0] = lr(a.c, a.dir || dir), [l1, r1] = lr(b.c, b.dir || dir);
        const same = Math.abs(l0 - l1) < 1e-9 && Math.abs(r0 - r1) < 1e-9;
        cBiz.push(e(`IFCALIGNMENTSEGMENT(${G()},${oh},'C${cBiz.length + 1}',$,$,$,$,${e(`IFCALIGNMENTCANTSEGMENT($,$,${R(a.u)},${R(len)},${R(l0, 5)},${R(l1, 5)},${R(r0, 5)},${R(r1, 5)},.${same ? "CONSTANTCANT" : "LINEARTRANSITION"}.)`)})`));
      }
    }
    const off = T.off || {}, hasOff = !!(off.h || off.v || (off.rows && off.rows.length));
    const desc = hasOff ? S(lb.offset + ": " + R(off.h || 0, 3) + " / " + R(off.v || 0, 3) + (off.rows && off.rows.length ? " (+" + off.rows.length + ")" : "")) : "$";
    const align = e(`IFCALIGNMENT(${G()},${oh},${S(t.name)},${desc},$,${LP(null, A3(o3))},${e(`IFCPRODUCTDEFINITIONSHAPE($,$,(${reps.join(",")}))`)},$)`);
    const hor = e(`IFCALIGNMENTHORIZONTAL(${G()},${oh},$,$,$,$,$)`);
    e(`IFCRELNESTS(${G()},${oh},$,$,${hor},(${hBiz.join(",")}))`);
    const nested = [hor];
    if (vBiz.length) { const ver = e(`IFCALIGNMENTVERTICAL(${G()},${oh},$,$,$,$,$)`); e(`IFCRELNESTS(${G()},${oh},$,$,${ver},(${vBiz.join(",")}))`); nested.push(ver); }
    if (cBiz.length) { const can = e(`IFCALIGNMENTCANT(${G()},${oh},$,$,$,$,$,${R(t.gauge || 1.5, 5)})`); e(`IFCRELNESTS(${G()},${oh},$,$,${can},(${cBiz.join(",")}))`); nested.push(can); }
    // progressiva iniziale (lettore del tool: referente all'inizio dell'asse con Pset_Stationing)
    const s0 = T.s0 || 0, g0 = segs[0];
    const ref = e(`IFCREFERENT(${G()},${oh},${S(chainage(s0))},$,$,${LP(null, A3(P3(g0.x0, g0.y0, 0)))},$,.STATION.)`);
    const pst = e(`IFCPROPERTYSET(${G()},${oh},'Pset_Stationing',$,(${e(`IFCPROPERTYSINGLEVALUE('Station',$,IFCLENGTHMEASURE(${R(s0)}),$)`)}))`);
    e(`IFCRELDEFINESBYPROPERTIES(${G()},${oh},$,$,(${ref}),${pst})`);
    nested.push(ref);
    e(`IFCRELNESTS(${G()},${oh},$,$,${align},(${nested.join(",")}))`);
    inSite.push(align); n.aligns++;
  };

  // --- sostegni
  const psw = { e, G, S, R: (x) => R(x, 4), oh };
  const elem = (cls, name, ot, pl, pds, tag, predef) => e(`${cls}(${G()},${oh},${S(name)},$,${ot ? S(ot) : "$"},${pl},${pds},${tag ? S(tag) : "$"},.${predef}.)`);
  const writeSupport = (t, part, x) => {
    const { s, R: Rs } = x, T = t.T, portal = Rs && Rs.kind === "portal";
    const F = C.supportFrame(T, s.u, portal ? 1 : s.side);
    if (!F) return null;
    // portale: riferimento della trave (0.11.0: obliqua se i montanti sono sfalsati lungo il binario)
    const PF = portal ? C.portalFrame(T, s, Rs) : null;
    const f = F.f, sg = F.s, tx = PF ? PF.tx : f.tx, ty = PF ? PF.ty : f.ty, nx = -ty, ny = tx;
    const P = portal ? C.portalParts(T, s, Rs) : C.supportParts(T, s, Rs);
    const qc = portal ? 0 : sg * (Rs.dr + C.GAUGE_HALF + Rs.mast.w / 2);
    const zO = portal ? f.z : f.z + Rs.baseDz;
    const W = portal ? PF.at(0, 0, zO) : F.at(0, qc, zO);
    const loc = (p) => { const dx = p.x - W.x, dy = p.y - W.y; return [dx * tx + dy * ty, dx * nx + dy * ny, p.z - W.z]; };
    const num = s.num != null ? String(s.num) : "";
    const kindName = portal ? lb.portal : lb.mast, ot = portal ? mastLabel(Rs) + " · " + Rs.beam.id : mastLabel(Rs);
    const asmPl = LP(part.pl, A3(P3(W.x - O.x, W.y - O.y, W.z), Z, D3(tx, ty, 0)));
    const asm = e(`IFCELEMENTASSEMBLY(${G()},${oh},${S((kindName + " " + num).trim())},${S(t.name + " " + chainage((T.s0 || 0) + s.u))},${S(ot)},${asmPl},$,${num ? S(num) : "$"},.SITE.,.${portal ? "SUPPORTINGASSEMBLY" : "MAST"}.)`);
    const kids = [];
    const childPl = (l, rd) => LP(asmPl, A3(P3(...l), rd ? Z : null, rd || null));
    const add = (el, isSteel = true) => { kids.push(el); if (isSteel) steel.push(el); n.parts++; return el; };
    const occ = (T2, el) => { T2.occ.push(el); return el; };
    const sfx = (k) => { const m = /(\d+)$/.exec(k); return m ? +m[1] - 1 : 0; };
    const suspType = (i) => (portal ? (Rs.susp[i] && Rs.susp[i].type) || "" : i === 0 ? Rs.sosp || "" : (Rs.susp[i - 1] && Rs.susp[i - 1].type) || "");
    let sezItems = null, attItems = null;
    const RP = RFI.rfiPlaced(T, s, Rs);                    // famiglia RFI (0.17.0): i suoi pezzi al posto delle parti semplificate
    for (const p of P) {
      const k = p.k;
      if (RP && RFI.replaces(k)) continue;
      if (p.sz) {
        const c = loc(p.c), [sl, stv, sv] = p.sz;
        if (k === "mast") { const Tm = mastType(Rs.mast); add(occ(Tm, elem("IFCCOLUMN", lb.stem + " " + Rs.mast.id, Rs.mast.id, childPl([c[0], c[1], c[2] - sv / 2]), mapped(Tm), num, "STANDCOLUMN"))); }
        else if (k === "plate") { const Tp = plateType(sl, stv, sv); add(occ(Tp, elem("IFCPLATE", lb.plate, null, childPl([c[0], c[1], c[2] - sv / 2]), mapped(Tp), num, "BASE_PLATE"))); }
        else if (k === "pole") { const Pp = Rs.pole; add(elem("IFCCOLUMN", lb.pole + " " + Pp.id, Pp.id, childPl([c[0], c[1], c[2] - sv / 2]), shape(styled([ext(hollow(Pp.d, Pp.w, Pp.wall), [0, 0, 0], [0, 0, 1], [1, 0, 0], sv)], "steel")), num, "STANDCOLUMN")); }
        else if (k === "mens") {                        // la mensola parte dal palo e va verso il binario (−sg)
          const Tm = mensType(Rs.mens);
          add(occ(Tm, elem("IFCMEMBER", lb.mens + " " + Rs.mens.code + " L " + R(Rs.mens.L, 3), Rs.mens.code, childPl([c[0], c[1] + sg * stv / 2, c[2]], D3(-sg, 0, 0)), mapped(Tm), num, "MEMBER")));
        } else if (k === "beam") { const Tb = beamType(Rs.beam, Rs.fixed); add(occ(Tb, elem("IFCBEAM", lb.beam + " " + Rs.beam.id, Rs.beam.id, childPl(c), mapped(Tb), num, "BEAM"))); }
        else if (k === "trafo") add(elem("IFCTRANSFORMER", lb.trafo, null, childPl([0, 0, 0]), shape(styled([aBox(c[0], c[1], c[2], sl, stv, sv)], "equip")), num, "VOLTAGE"), false);
        else if (k === "att") { (attItems = attItems || []).push(aBox(c[0], c[1], c[2], sl, stv, sv)); }
        else if (k === "sez") { sezItems = [aBox(c[0], c[1], c[2], sl, stv, sv), ...(sezItems || [])]; }
        // pil / block: fondazioni, sotto
      } else if (p.a && (k.startsWith("tir") || k.startsWith("arm") || k === "rod")) {
        const r = rod(loc(p.a), loc(p.b));
        if (!r) continue;
        if (k === "rod") { (sezItems = sezItems || []).push(r); continue; }
        const isTie = k.startsWith("tir"), ty2 = isTie ? "" : suspType(sfx(k));
        add(elem("IFCMEMBER", (isTie ? lb.tie : portal ? lb.pend : lb.susp) + (ty2 ? " " + ty2 : ""), ty2 || null, childPl([0, 0, 0]), shape(styled([r], isTie ? "dark" : "steel")), num, isTie ? "TIEBAR" : "SUSPENDER"));
      }
    }
    if (attItems) add(elem("IFCDISCRETEACCESSORY", lb.att || "Attacco mensola", null, childPl([0, 0, 0]), shape(styled(attItems, "steel")), num, "BRACKET"));
    if (sezItems) add(elem("IFCSWITCHINGDEVICE", lb.sez, null, childPl([0, 0, 0]), shape(styled(sezItems, "equip")), num, "SWITCHDISCONNECTOR"), false);
    // pezzi della famiglia RFI: un tipo per pezzo condiviso (nome della famiglia Revit), i tiranti con la loro geometria
    const dirOf = (th) => { const c = Math.cos(th), sn = Math.sin(th); return [c * tx + sn * ty, c * nx + sn * ny]; };
    const rfiShape = (pc, cls, predef, tname, sk) => {
      const sol = RFI.solidsOf(pc, lod);
      if (!sol.length) return null;
      if (pc.own) return { pds: shape(styled(sol.map(rfiItem).filter(Boolean), sk), repKind(sol)) };
      const Tr = typeOf("rfi|" + pc.key + "|" + lod, cls + "TYPE", predef, tname, () => sol.map(rfiItem).filter(Boolean), sk, repKind(sol));
      return { pds: mapped(Tr), T: Tr };
    };
    const rfiName = (pc) => {
      const short = (pre) => pc.fam.replace(pre, "");
      if (pc.k === "palo") return lb.mast + " " + Rs.mast.id;
      if (pc.k === "att") return lb.att || "Attacco mensola";
      if (pc.k === "staffa") return lb.attTie || "Attacco tirante";
      if (pc.k === "mens") return lb.mens + " " + Rs.mens.code + " L " + R(Rs.mens.L, 3);
      if (pc.k.startsWith("tir")) return lb.tie;
      if (pc.k === "pilone") return lb.pole + " " + short("RFI_Pilone_");
      if (pc.k === "attTrave") return lb.attBeam || "Attacco trave";
      return lb.beam + " " + short(/^RFI_Trave(MEC_C_|Ormeggio_|Tralicciata_)/);
    };
    const rfiTypeName = (pc) => (pc.k === "plinto" ? pc.fam + " " + pc.type + (Math.abs(Rs.c1 - 0.25) > 1e-9 ? " C1 " + R(Rs.c1, 3) : "")
      : pc.k === "mens" ? pc.fam + " " + (pc.type || "L " + R(Rs.mens.L, 3)) : pc.fam + (pc.type ? " " + pc.type : ""));
    const rfiFeet = [];
    if (RP) for (const pc of RP.pieces) {
      if (pc.k === "plinto" || pc.k === "fond") { rfiFeet.push(pc); continue; }   // fondazioni: sotto, come le altre
      const [cls, predef] = pc.ifc, tname = rfiTypeName(pc), sk = pc.k === "mens" || pc.k.startsWith("tir") ? "dark" : "steel";
      const sh = rfiShape(pc, cls, predef, tname, sk);
      if (!sh) continue;
      const el = elem(cls, rfiName(pc), tname, childPl(loc(pc.w), D3(...dirOf(pc.th), 0)), sh.pds, num, predef);
      add(sh.T ? occ(sh.T, el) : el);
    }
    if (kids.length) e(`IFCRELAGGREGATES(${G()},${oh},$,$,${asm},(${kids.join(",")}))`);
    if (x.own && x.own.length) writeStep(x.own, psw, [asm, ...kids]);   // anche sulle parti: nel viewer si clicca una parte, l'assieme non ha geometria
    // fondazioni: una per palo, due per il portale (B eccentrici: palo → lontano dal binario, portale → verso i binari)
    const footing = (fp, pds, Tf) => {
      const el = elem("IFCFOOTING", (lb.found + " " + num).trim(), Rs.found.id, fp, pds, num, "PAD_FOOTING");
      if (Tf) occ(Tf, el);
      conc.push(el); n.footings++;
      e(`IFCRELDEFINESBYPROPERTIES(${G()},${oh},$,$,(${el}),${e(`IFCELEMENTQUANTITY(${G()},${oh},'Qto_FootingBaseQuantities',$,$,(${e(`IFCQUANTITYVOLUME('GrossVolume',$,$,${R(portal ? Rs.vol / 2 : Rs.vol, 4)},$)`)}))`)})`);
      return el;
    };
    const feet = RP ? [] : portal
      ? [{ p: PF.at(0, PF.half, f.z + Rs.zBaseL), k: -1 }, { p: PF.at(0, -PF.half, f.z + Rs.zBaseR), k: 1 }]
      : [{ p: F.at(0, qc, zO), k: sg }];
    const foots = feet.map((ft) => {
      const Tf = footType(Rs.found, Rs.c1), p = ft.p;
      return footing(LP(part.pl, A3(P3(p.x - O.x, p.y - O.y, p.z), Z, D3(ft.k * tx, ft.k * ty, 0))), mapped(Tf), Tf);
    });
    for (const pc of rfiFeet) {
      const sh = rfiShape(pc, "IFCFOOTING", "PAD_FOOTING", rfiTypeName(pc), "conc");
      if (sh) foots.push(footing(LP(part.pl, A3(P3(pc.w.x - O.x, pc.w.y - O.y, pc.w.z), Z, D3(Math.cos(pc.th), Math.sin(pc.th), 0))), sh.pds, sh.T));
    }
    if (x.found && x.found.length) writeStep(x.found, psw, foots);
    if (portal) n.portals++; else n.masts++;
    return [asm, ...foots];
  };

  // --- rotaie semplici (a scelta): rettangolo largo RAIL.w, alto RAIL.h, sotto il piano del ferro della rotaia
  const writeRails = (t) => {
    const T = t.T, us = C.trackStations(T, job.railStep || 1), out = [];
    for (const side of [1, -1]) {
      const q0 = side * C.GAUGE_HALF, q1 = side * (C.GAUGE_HALF + RAIL.w), pts = [];
      for (const u of us) {
        const f = C.trackFrame(T, u), cn = { c: f.cant, dir: f.dir };
        for (const [q, top] of [[q0, 1], [q1, 1], [q1, 0], [q0, 0]]) {
          const z = C.pfAt(f.zIn, cn, q) - (top ? 0 : RAIL.h);
          pts.push(`(${R(f.x + q * f.nx - O.x, 4)},${R(f.y + q * f.ny - O.y, 4)},${R(z, 4)})`);
        }
      }
      const m = us.length, idx = [];
      for (let i = 0; i + 1 < m; i++) for (let j = 0; j < 4; j++) {
        const a = 4 * i + j + 1, b = 4 * i + ((j + 1) % 4) + 1, c = a + 4, d = b + 4;
        idx.push(`(${a},${c},${d})`, `(${a},${d},${b})`);
      }
      const cap = (o, flip) => idx.push(flip ? `(${o + 1},${o + 3},${o + 2})` : `(${o + 1},${o + 2},${o + 3})`, flip ? `(${o + 1},${o + 4},${o + 3})` : `(${o + 1},${o + 3},${o + 4})`);
      cap(0, false); cap(4 * (m - 1), true);
      const item = e(`IFCTRIANGULATEDFACESET(${e(`IFCCARTESIANPOINTLIST3D((${pts.join(",")}),$)`)},$,$,(${idx.join(",")}),$)`);
      styled([item], "rail");
      const el = e(`IFCRAIL(${G()},${oh},${S((side > 0 ? lb.railL : lb.railR) + " - " + t.name)},$,$,${LP(railPl, a0)},${shape([item], "Tessellation")},$,.RAIL.)`);
      out.push(el); steel.push(el); n.rails++;
    }
    return out;
  };

  for (const t of job.tracks || []) {
    if (t.align !== false) writeAlign(t);
    if (t.rails) inRailway.push(...writeRails(t));
    if (!t.sups || !t.sups.length) continue;
    const pl = LP(railPl, a0);
    const rp = e(`IFCRAILWAYPART(${G()},${oh},${S(t.name)},${S(lb.railway)},$,${pl},$,$,.ELEMENT.,.LONGITUDINAL.,.ABOVETRACK.)`);
    parts.push(rp);
    const part = { pl }, inPart = [];
    for (const x of t.sups) { const r = writeSupport(t, part, x); if (r) inPart.push(...r); }
    if (inPart.length) e(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${G()},${oh},$,$,(${inPart.join(",")}),${rp})`);
  }
  if (parts.length) e(`IFCRELAGGREGATES(${G()},${oh},$,$,${railway},(${parts.join(",")}))`);
  for (const T of TYPES.values()) if (T.occ.length) e(`IFCRELDEFINESBYTYPE(${G()},${oh},$,$,(${T.occ.join(",")}),${T.ty})`);
  const mat = (list, name, cat) => { if (list.length) e(`IFCRELASSOCIATESMATERIAL(${G()},${oh},$,$,(${list.join(",")}),${e(`IFCMATERIAL(${S(name)},$,${S(cat)})`)})`); };
  mat(steel, lb.steel, "Steel");
  mat(conc, lb.concrete, "Concrete");
  if (inSite.length) e(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${G()},${oh},$,$,(${inSite.join(",")}),${site})`);
  if (inRailway.length) e(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${G()},${oh},$,$,(${inRailway.join(",")}),${railway})`);

  const iso = date.toISOString().slice(0, 19);
  const text = [
    "ISO-10303-21;", "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    `FILE_NAME(${S((job.fileName || job.name || "railway-ocs") + ".ifc")},'${iso}',(''),('viewifc.com'),${S(job.app.name + " " + job.app.version)},'viewifc.com','');`,
    "FILE_SCHEMA(('IFC4X3_ADD2'));", "ENDSEC;", "DATA;", ...L, "ENDSEC;", "END-ISO-10303-21;", "",
  ].join("\n");
  return { text, n };
}

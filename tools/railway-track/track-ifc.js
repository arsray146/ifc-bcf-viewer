/* =========================================================================
   Armamento ferroviario (Railway Track) — export IFC 4x3 (tool 21, F3)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Senza DOM (si prova in Node: test/test_track_ifc.js, col web-ifc del viewer
   e con IfcOpenShell). La pagina lo carica solo quando si esporta.
   - Coordinate del file = coordinate dei binari (quelle del federato), niente
     IfcMapConversion; IfcSite nell'origine della scena (metri tondi); gli
     IfcAlignment in coordinate ASSOLUTE (come la Trazione elettrica: stessa
     scrittura di ocs-ifc.js 0.24.0, verificata con IfcOpenShell).
   - Struttura: IfcProject → IfcSite → IfcRailway → un IfcRailwayPart .TRACK.
     per binario (IFC4X3_ADD2: TRACK, non TRACKSTRUCTURE delle bozze), che
     contiene rotaie, traverse e ballast; gli assi nel sito.
   - Rotaie: IfcRail .RAIL. per tratto e lato, tipo IfcRailType per profilo;
     geometria = estrusi del profilo vero (IfcArbitraryClosedProfileDef, uno
     per tipo e lato) lungo la spezzata della rotaia (track-core railSegments:
     entro 1 mm dalla linea vera, rollio compreso). Leggeri e leggibili da tutti
     (niente IfcSectionedSolidHorizontal, che il web-ifc del viewer ignora).
   - Traverse: IfcTrackElement .SLEEPER. una per una, tipo IfcTrackElementType
     .SLEEPER. con la forma in un IfcRepresentationMap; un solo
     IfcProductDefinitionShape per tipo (lo schema lo ammette, F0 §6.5);
     placement cartesiano girato sulla tangente e sul rollio.
   - Ballast: IfcCourse .BALLASTBED. per tratto = il letto sotto le traverse
     (a facce; sezioni tolte dove l'interpolazione le rifà entro 5 mm), che
     aggrega gli intasi fra le traverse: IfcCourse .BALLASTBED. «Intaso k»
     (fra la traversa k e la k+1) con la forma condivisa per tipo di traversa
     e passo, come le traverse. Qto_CourseBaseQuantities del tratto: lunghezza
     e volume (letto + intasi). Prima gli intasi erano IfcMappedItem dentro il
     letto: il web-ifc li leggeva bene, IfcOpenShell li rifaceva uno per uno
     (22 ms l'uno, 19 s per 482 m di binario).
   - Pset: job.resolve(kind, valori) → Pset risolti (modulo comune
     pset-core.js col modello del progetto); valori da track-core psetValues.
     I valori uguali si scrivono una volta (IfcPropertySingleValue e
     IfcPropertySet condivisi): con 16 000 traverse il file non raddoppia.
     Dalla 0.4.1 anche IfcProject (somme dei binari esportati) e IfcSite
     (origine E, N).
   ========================================================================= */
import * as C from "../railway-ocs/ocs-core.js?v=0.24.0";
import * as K from "./track-catalog.js?v=0.5.2";
import * as TC from "./track-core.js?v=0.5.2";
import { stepValue } from "../common/pset-core.js?v=1.1.0";
import { ifcGuid, stepStr, stepReal, chainage } from "../profile-sweep/profile-io.js?v=0.23.2";

/* nomi di partenza (la pagina li passa nella sua lingua) */
export const IFC_LABELS = {
  site: "Sito", railway: "Armamento ferroviario", track: "Binario", railL: "Rotaia sinistra", railR: "Rotaia destra", sleeper: "Traversa", ballast: "Ballast", crib: "Intaso",
  part: "tratto", steel: "Acciaio", concrete: "Calcestruzzo armato precompresso", stone: "Pietrisco", offset: "Offset dall'asse ricevuto",
  left: "S", right: "D", bSec: "sezione tipo", bSc: "supercompattato", bwSleeper: "a filo traverse", bwCrest: "alla quota della cresta", fallBoth: "a schiena d'asino", fallL: "a una falda verso sinistra", fallR: "a una falda verso destra",
};
/* colori come nella vista (rotaie grigio chiaro, traverse chiare, ballast scuro) */
const RGB = { rail: [0.706, 0.729, 0.753], sleeper: [0.933, 0.918, 0.878], ballast: [0.486, 0.439, 0.384] };

/**
 * job = {
 *   name (progetto), fileName?, app: { name, version }, date?, guid?: () → GlobalId (test),
 *   origin: { x, y } (E, N dell'IfcSite: l'origine della scena), labels?: { …IFC_LABELS nella lingua della pagina },
 *   resolve?: (kind, valori) → [{ name, props: [{ name, type, value }] }]  (senza: niente Pset propri),
 *   tracks: [{ name, T (binario del motore), gauge, align (scrivere l'IfcAlignment), parts (track-core trackPieces) }]
 * } → { text (STEP), n: { tracks, rails, sleepers, ballast, cribs, aligns, segs, psets } }
 */
export function trackIfc(job) {
  const L = [];
  let id = 0;
  const e = (s) => { L.push("#" + ++id + "=" + s + ";"); return "#" + id; };
  const G = () => "'" + (job.guid ? job.guid() : ifcGuid()) + "'";
  const R = (x, d = 6) => stepReal(x, d), S = stepStr, lb = { ...IFC_LABELS, ...(job.labels || {}) };
  const O = job.origin || { x: 0, y: 0 };
  const date = job.date || new Date();
  const n = { tracks: 0, rails: 0, sleepers: 0, ballast: 0, cribs: 0, aligns: 0, segs: 0, psets: 0 };

  // --- progetto (come la Trazione elettrica)
  const org = e(`IFCORGANIZATION($,'viewifc.com',$,$,$)`);
  const pao = e(`IFCPERSONANDORGANIZATION(${e("IFCPERSON($,$,$,$,$,$,$,$)")},${org},$)`);
  const app = e(`IFCAPPLICATION(${org},${S(job.app.version)},${S(job.app.name)},'viewifc-railway-track')`);
  const oh = e(`IFCOWNERHISTORY(${pao},${app},$,.ADDED.,$,$,$,${Math.floor(date.getTime() / 1000)})`);
  const U = [e("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)"), e("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)"), e("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)"), e("IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)")];
  const ua = e(`IFCUNITASSIGNMENT((${U.join(",")}))`);
  const o3 = e("IFCCARTESIANPOINT((0.,0.,0.))");
  const DIRS = new Map();
  const D3 = (x, y, z) => { const k = [x, y, z].map((v) => R(v, 9)).join(","); if (!DIRS.has(k)) DIRS.set(k, e(`IFCDIRECTION((${k}))`)); return DIRS.get(k); };
  const Z = D3(0, 0, 1);
  const wcs = e(`IFCAXIS2PLACEMENT3D(${o3},${Z},${D3(1, 0, 0)})`);
  const ctx = e(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${wcs},$)`);
  const body = e(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const axisCtx = e(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const proj = e(`IFCPROJECT(${G()},${oh},${S(job.name || "")},$,$,$,$,(${ctx}),${ua})`);
  const P3 = (x, y, z, d = 4) => e(`IFCCARTESIANPOINT((${R(x, d)},${R(y, d)},${R(z, d)}))`);
  const A3 = (p, ax, rd) => e(`IFCAXIS2PLACEMENT3D(${p},${ax || "$"},${rd || "$"})`);
  const LP = (rel, a) => e(`IFCLOCALPLACEMENT(${rel || "$"},${a})`);
  const a0 = A3(o3);
  const sitePl = LP(null, A3(P3(O.x, O.y, 0)));
  const site = e(`IFCSITE(${G()},${oh},${S(lb.site)},$,$,${sitePl},$,$,.ELEMENT.,$,$,0.,$,$)`);
  e(`IFCRELAGGREGATES(${G()},${oh},$,$,${proj},(${site}))`);
  const railPl = LP(sitePl, a0);
  const railway = e(`IFCRAILWAY(${G()},${oh},${S(job.name || lb.railway)},${S(lb.railway)},$,${railPl},$,$,.ELEMENT.,$)`);
  e(`IFCRELAGGREGATES(${G()},${oh},$,$,${site},(${railway}))`);
  const inSite = [], partsOut = [], mats = { steel: [], concrete: [], stone: [] };

  // --- stili
  const ST = {};
  const st = (k) => ST[k] || (ST[k] = e(`IFCSURFACESTYLE(${S(k)},.BOTH.,(${e(`IFCSURFACESTYLESHADING(${e(`IFCCOLOURRGB($,${RGB[k].map((v) => R(v, 3)).join(",")})`)},0.)`)}))`));
  const styled = (item, k) => { e(`IFCSTYLEDITEM(${item},(${st(k)}),$)`); return item; };

  // --- Pset: valori uguali scritti una volta (IfcPropertySingleValue e IfcPropertySet condivisi), un rel per set
  const PV = new Map(), PSETS = new Map();
  const psetsOf = (kind, vals, target) => {
    if (!job.resolve) return;
    for (const s of job.resolve(kind, vals) || []) {
      if (!s.props || !s.props.length) continue;
      const refs = s.props.map((p) => {
        const v = stepValue(p.type, p.value, S, (x, d) => R(x, d)), k = p.name + "\u0000" + v;
        if (!PV.has(k)) PV.set(k, e(`IFCPROPERTYSINGLEVALUE(${S(p.name)},$,${v},$)`));
        return PV.get(k);
      });
      const key = s.name + "\u0000" + refs.join(",");
      if (!PSETS.has(key)) { PSETS.set(key, { ref: e(`IFCPROPERTYSET(${G()},${oh},${S(s.name)},$,(${refs.join(",")}))`), targets: [] }); n.psets++; }
      PSETS.get(key).targets.push(target);
    }
  };

  // --- tipi
  const RAILTYPES = new Map(), SLTYPES = new Map(), PROFILES = new Map(), CRIBMAPS = new Map();
  const railType = (rail) => RAILTYPES.get(rail) || (RAILTYPES.set(rail, { ty: e(`IFCRAILTYPE(${G()},${oh},${S(rail)},${S(K.RAILS[rail].label + " · " + K.RAILS[rail].std)},$,$,$,$,$,.RAIL.)`), occ: [] }), RAILTYPES.get(rail));
  const P2 = (u, v) => `(${R(u, 6)},${R(v, 6)})`;
  const profileOf = (rail, side, pr) => {
    const k = rail + "|" + side;
    if (!PROFILES.has(k)) {
      // poligono chiuso dagli indici (1 … n, 1): il contorno del catalogo non ripete il primo punto
      const pts = e(`IFCCARTESIANPOINTLIST2D((${pr.pts.map(([u, v]) => P2(u, v)).join(",")}),$)`);
      const curve = e(`IFCINDEXEDPOLYCURVE(${pts},(IFCLINEINDEX((${[...pr.pts.keys()].map((i) => i + 1).join(",")},1))),.F.)`);
      PROFILES.set(k, e(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,${S(rail + " " + (side === "left" ? lb.left : lb.right))},${curve})`));
    }
    return PROFILES.get(k);
  };
  const faceSet = (pos, idx, dx = 0, dy = 0, d = 4) => {
    const pts = [];
    for (let i = 0; i < pos.length; i += 3) pts.push(`(${R(pos[i] - dx, d)},${R(pos[i + 1] - dy, d)},${R(pos[i + 2], d)})`);
    const tri = [];
    for (let i = 0; i < idx.length; i += 3) tri.push(`(${idx[i] + 1},${idx[i + 1] + 1},${idx[i + 2] + 1})`);
    return e(`IFCTRIANGULATEDFACESET(${e(`IFCCARTESIANPOINTLIST3D((${pts.join(",")}),$)`)},$,.T.,(${tri.join(",")}),$)`);
  };
  const shapeRep = (items, kind) => e(`IFCSHAPEREPRESENTATION(${body},'Body','${kind}',(${items.join(",")}))`);
  const CTO0 = e(`IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,${o3},1.,$)`);
  const sleeperType = (type) => {
    if (SLTYPES.has(type)) return SLTYPES.get(type);
    const m = K.sleeperMesh(type), item = styled(faceSet(m.pos, m.idx), "sleeper");
    const map = e(`IFCREPRESENTATIONMAP(${a0},${shapeRep([item], "Tessellation")})`);
    const ty = e(`IFCTRACKELEMENTTYPE(${G()},${oh},${S(K.SLEEPERS[type].label)},${S(K.SLEEPERS[type].std)},$,$,(${map}),$,$,.SLEEPER.)`);
    const pds = e(`IFCPRODUCTDEFINITIONSHAPE($,$,(${shapeRep([e(`IFCMAPPEDITEM(${map},${CTO0})`)], "MappedRepresentation")}))`);
    const T = { ty, map, pds, occ: [] };
    SLTYPES.set(type, T);
    return T;
  };
  const cribPds = (type, Gp) => {
    const k = type + "|" + Gp;
    if (!CRIBMAPS.has(k)) {
      const m = TC.cribMesh(type, Gp), map = e(`IFCREPRESENTATIONMAP(${a0},${shapeRep([styled(faceSet(m.pos, m.idx, 0, 0, 5), "ballast")], "Tessellation")})`);
      CRIBMAPS.set(k, e(`IFCPRODUCTDEFINITIONSHAPE($,$,(${shapeRep([e(`IFCMAPPEDITEM(${map},${CTO0})`)], "MappedRepresentation")}))`));
    }
    return CRIBMAPS.get(k);
  };

  // --- assi (stessa scrittura di ocs-ifc.js 0.24.0 writeAlign: pianta, profilo, sopraelevazione, progressiva)
  const P2e = (x, y) => e(`IFCCARTESIANPOINT((${R(x)},${R(y)}))`);
  const D2 = (a) => e(`IFCDIRECTION((${R(Math.cos(a), 12)},${R(Math.sin(a), 12)}))`);
  const line0 = () => e(`IFCLINE(${e("IFCCARTESIANPOINT((0.,0.))")},${e(`IFCVECTOR(${e("IFCDIRECTION((1.,0.))")},1.)`)})`);
  const circle0 = (sgn, r) => e(`IFCCIRCLE(${e(`IFCAXIS2PLACEMENT2D(${e(`IFCCARTESIANPOINT((0.,${R(sgn * r)}))`)},${e(`IFCDIRECTION((0.,${sgn > 0 ? "-1." : "1."}))`)})`)},${R(r)})`);
  const writeAlign = (t) => {
    const T = t.T, segs = T.H.segs, hCurve = [], hBiz = [];
    segs.forEach((g, i) => {
      const nx = segs[i + 1], end = C.hEval(g, g.len);
      const kink = nx ? Math.abs(Math.atan2(Math.sin(nx.th0 - end.th), Math.cos(nx.th0 - end.th))) : 0;
      const trans = !nx ? ".DISCONTINUOUS." : kink < 1e-6 ? ".CONTSAMEGRADIENT." : ".CONTINUOUS.";
      const pl = e(`IFCAXIS2PLACEMENT2D(${P2e(g.x0, g.y0)},${D2(g.th0)})`);
      const rad = (k) => (Math.abs(k) > 1e-15 ? 1 / k : 0);
      let type, parent, s0 = 0, len = g.len;
      const dk = (g.k1 - g.k0) / g.len;
      if (g.t === "L" || (Math.abs(g.k0) < 1e-15 && Math.abs(g.k1) < 1e-15)) { type = "LINE"; parent = line0(); }
      else if (g.t === "A" || Math.abs(dk) < 1e-15) { type = "CIRCULARARC"; const sg = Math.sign(g.k0); parent = circle0(sg, 1 / Math.abs(g.k0)); len = sg * g.len; }
      else {
        type = "CLOTHOID";
        const A = Math.sign(dk) * Math.sqrt(1 / Math.abs(dk));
        s0 = g.k0 * A * Math.abs(A);
        parent = e(`IFCCLOTHOID(${e(`IFCAXIS2PLACEMENT2D(${e("IFCCARTESIANPOINT((0.,0.))")},${e("IFCDIRECTION((1.,0.))")})`)},${R(A, 6)})`);
      }
      hCurve.push(e(`IFCCURVESEGMENT(${trans},${pl},IFCLENGTHMEASURE(${R(s0)}),IFCLENGTHMEASURE(${R(len)}),${parent})`));
      const r0 = type === "LINE" ? 0 : rad(g.k0), r1 = type === "LINE" ? 0 : type === "CIRCULARARC" ? r0 : rad(g.k1);
      hBiz.push(e(`IFCALIGNMENTSEGMENT(${G()},${oh},'H${i + 1}',$,$,$,$,${e(`IFCALIGNMENTHORIZONTALSEGMENT($,$,${P2e(g.x0, g.y0)},${R(g.th0, 12)},${R(r0)},${R(r1)},${R(g.len)},$,.${type}.)`)})`));
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
        const r = Math.abs(v.R), sg = Math.sign(v.g1 - v.g0), a0v = Math.atan(v.g0);
        const a1v = Math.asin(Math.max(-1, Math.min(1, Math.sin(a0v) + sg * v.len / r)));
        const sh = sg > 0 ? 1.5 * Math.PI : 0.5 * Math.PI, cx = -sg * r * Math.sin(a0v), cy = sg * r * Math.cos(a0v);
        const cir = e(`IFCCIRCLE(${e(`IFCAXIS2PLACEMENT2D(${e(`IFCCARTESIANPOINT((${R(cx)},${R(cy)}))`)},${e("IFCDIRECTION((1.,0.))")})`)},${R(r)})`);
        vCurve.push(e(`IFCCURVESEGMENT(${trans},${pl},IFCLENGTHMEASURE(${R(r * (a0v + sh))}),IFCLENGTHMEASURE(${R(r * (a1v - a0v))}),${cir})`));
        vBiz.push(e(`IFCALIGNMENTSEGMENT(${G()},${oh},'V${i + 1}',$,$,$,$,${e(`IFCALIGNMENTVERTICALSEGMENT($,$,${R(v.u0)},${R(v.len)},${R(v.z0)},${R(v.g0, 9)},${R(v.g1, 9)},${R(v.R)},.CIRCULARARC.)`)})`));
      } else if (bend) {
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
    const s0 = T.s0 || 0, g0 = segs[0];
    const ref = e(`IFCREFERENT(${G()},${oh},${S(chainage(s0))},$,$,${LP(null, A3(P3(g0.x0, g0.y0, 0)))},$,.STATION.)`);
    const pst = e(`IFCPROPERTYSET(${G()},${oh},'Pset_Stationing',$,(${e(`IFCPROPERTYSINGLEVALUE('Station',$,IFCLENGTHMEASURE(${R(s0)}),$)`)}))`);
    e(`IFCRELDEFINESBYPROPERTIES(${G()},${oh},$,$,(${ref}),${pst})`);
    nested.push(ref);
    e(`IFCRELNESTS(${G()},${oh},$,$,${align},(${nested.join(",")}))`);
    inSite.push(align); n.aligns++;
    return align;
  };

  // --- binari
  const qto = (el, name, list) => e(`IFCRELDEFINESBYPROPERTIES(${G()},${oh},$,$,(${el}),${e(`IFCELEMENTQUANTITY(${G()},${oh},${S(name)},$,$,(${list.map(([t, nm, v]) => e(`${t}(${S(nm)},$,$,${R(v, 4)},$)`)).join(",")}))`)})`);
  for (const t of job.tracks || []) {
    const T = t.T, s0 = T.s0 || 0, Ltr = T.H.length, parts = t.parts || [], multi = parts.length > 1;
    if (t.align !== false) writeAlign(t);
    const pl = LP(railPl, a0);
    const rp = e(`IFCRAILWAYPART(${G()},${oh},${S(t.name)},${S(chainage(s0) + " – " + chainage(s0 + Ltr))},${S(lb.track)},${pl},$,$,.ELEMENT.,.LONGITUDINAL.,.TRACK.)`);
    partsOut.push(rp); n.tracks++;
    psetsOf("track", TC.psetValues("track", parts, { name: t.name, s0, L: Ltr, lb }), rp);
    const inPart = [];
    const range = (p) => chainage(s0 + p.u0) + " – " + chainage(s0 + p.u1);
    for (const p of parts) {
      const tag = multi ? " " + p.i : "", ctxP = { name: t.name, s0, L: Ltr, part: p, lb };
      // rotaie: estrusi del profilo lungo la spezzata
      for (const r of p.rails) {
        if (!r.segs.length) continue;
        const prof = profileOf(r.rail, r.side, r.prof), items = [];
        for (const g of r.segs) items.push(styled(e(`IFCEXTRUDEDAREASOLID(${prof},${A3(P3(g.o[0] - O.x, g.o[1] - O.y, g.o[2]), D3(...g.z), D3(...g.x))},${Z},${R(g.len, 4)})`), "rail"));
        n.segs += items.length;
        const el = e(`IFCRAIL(${G()},${oh},${S((r.side === "left" ? lb.railL : lb.railR) + tag)},${S(range(p))},${S(K.RAILS[r.rail].label)},${LP(pl, a0)},${e(`IFCPRODUCTDEFINITIONSHAPE($,$,(${shapeRep(items, "SweptSolid")}))`)},$,.RAIL.)`);
        railType(r.rail).occ.push(el); mats.steel.push(el); inPart.push(el); n.rails++;
        psetsOf("rail", TC.psetValues("rail", r, ctxP), el);
      }
      // ballast: il letto del tratto (a facce) che aggrega gli intasi; un intaso = un oggetto con la forma condivisa
      // per tipo di traversa e passo (IfcOpenShell e gli altri lo istanziano: come IfcMappedItem dentro il letto
      // IfcOpenShell rifaceva ogni intaso, 22 ms l'uno, minuti per binario)
      if (p.beds.length || p.cribs.length) {
        const items = p.beds.map((b) => styled(faceSet(b.pos, b.idx, O.x, O.y, 3), "ballast"));
        const bpl = LP(pl, a0);
        const el = e(`IFCCOURSE(${G()},${oh},${S(lb.ballast + tag)},${S(range(p))},${S(lb.stone)},${bpl},${items.length ? e(`IFCPRODUCTDEFINITIONSHAPE($,$,(${shapeRep(items, "Tessellation")}))`) : "$"},$,.BALLASTBED.)`);
        mats.stone.push(el); inPart.push(el); n.ballast++;
        qto(el, "Qto_CourseBaseQuantities", [["IFCQUANTITYLENGTH", "Length", p.u1 - p.u0], ["IFCQUANTITYVOLUME", "Volume", p.vol]]);
        psetsOf("ballast", TC.psetValues("ballast", p, ctxP), el);
        const kids = [];
        for (const c of p.cribs) {
          const q = c.pose, cpl = LP(bpl, A3(P3(q.o[0] - O.x, q.o[1] - O.y, q.o[2]), D3(...q.z), D3(...q.x)));
          const ce = e(`IFCCOURSE(${G()},${oh},${S(lb.crib + " " + c.k)},${S(chainage(s0 + c.u))},${S(lb.crib)},${cpl},${cribPds(c.type, c.G)},${S(String(c.k))},.BALLASTBED.)`);
          kids.push(ce); mats.stone.push(ce); n.cribs++;
        }
        if (kids.length) e(`IFCRELAGGREGATES(${G()},${oh},$,$,${el},(${kids.join(",")}))`);
      }
      // traverse una per una
      for (const s of p.sleepers) {
        const Ty = sleeperType(s.type), q = s.pose;
        const spl = LP(pl, A3(P3(q.o[0] - O.x, q.o[1] - O.y, q.o[2]), D3(...q.z), D3(...q.x)));
        const el = e(`IFCTRACKELEMENT(${G()},${oh},${S(lb.sleeper + " " + s.k)},${S(chainage(s0 + s.u))},${S(K.SLEEPERS[s.type].label)},${spl},${Ty.pds},${S(String(s.k))},.SLEEPER.)`);
        Ty.occ.push(el); mats.concrete.push(el); inPart.push(el); n.sleepers++;
        psetsOf("sleeper", TC.psetValues("sleeper", s, ctxP), el);
      }
    }
    if (inPart.length) e(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${G()},${oh},$,$,(${inPart.join(",")}),${rp})`);
  }
  if (partsOut.length) e(`IFCRELAGGREGATES(${G()},${oh},$,$,${railway},(${partsOut.join(",")}))`);
  for (const T of [...RAILTYPES.values(), ...SLTYPES.values()]) if (T.occ.length) e(`IFCRELDEFINESBYTYPE(${G()},${oh},$,$,(${T.occ.join(",")}),${T.ty})`);
  for (const [k, cat] of [["steel", "Steel"], ["concrete", "Concrete"], ["stone", "Aggregate"]]) if (mats[k].length) e(`IFCRELASSOCIATESMATERIAL(${G()},${oh},$,$,(${mats[k].join(",")}),${e(`IFCMATERIAL(${S(lb[k])},$,${S(cat)})`)})`);
  // 0.4.1: Pset del progetto (i binari esportati) e del sito (la sua origine)
  psetsOf("project", TC.psetValues("project", (job.tracks || []).map((t) => ({ name: t.name, parts: t.parts || [], L: t.T.H.length, s0: t.T.s0 || 0 })), { name: job.name || "" }), proj);
  psetsOf("site", TC.psetValues("site", { E: O.x, N: O.y }, { name: job.name || "" }), site);
  for (const P of PSETS.values()) e(`IFCRELDEFINESBYPROPERTIES(${G()},${oh},$,$,(${P.targets.join(",")}),${P.ref})`);
  if (inSite.length) e(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${G()},${oh},$,$,(${inSite.join(",")}),${site})`);

  const iso = date.toISOString().slice(0, 19);
  const text = [
    "ISO-10303-21;", "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    `FILE_NAME(${S((job.fileName || job.name || "railway-track") + ".ifc")},'${iso}',(''),('viewifc.com'),${S(job.app.name + " " + job.app.version)},'viewifc.com','');`,
    "FILE_SCHEMA(('IFC4X3_ADD2'));", "ENDSEC;", "DATA;", ...L, "ENDSEC;", "END-ISO-10303-21;", "",
  ].join("\n");
  return { text, n };
}

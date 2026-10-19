/* =========================================================================
   Trazione elettrica (Railway OCS) — lettura dei file (tool 18, F1)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Senza DOM (si prova in Node: test/test_ocs_io.js). LandXML 1.2 degli assi
   ferroviari (Civil 3D, OpenRail, SierraSoft): pianta (rette, archi,
   clotoidi), profili (si sceglie per nome: il PRIMO ProfAlign di un file vero
   era un fosso, F0 §10.2), sopraelevazione (CantStation) e velocità.
   Le coppie di coordinate sono «Nord Est» come vuole la specifica; si
   prova anche l'ordine scambiato e si tiene quello che chiude le giunzioni.
   ========================================================================= */
import { hAlign, hJunctions, profileV, projectOn, nearestTracks, drFromAxis, trackFrame, GAUGE_HALF } from "./ocs-core.js?v=0.22.0";

/* ---- XML minimo: elementi, attributi, testo (niente DTD, niente namespace) ---- */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decEnt = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m));
export function parseXML(text) {
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!(?:[^>"']|"[^"]*"|'[^']*')*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const el = { name: m[3].replace(/^.*:/, ""), attrs: {}, children: [], text: "" };
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) el.attrs[a[1].replace(/^.*:/, "")] = decEnt(a[2] ?? a[3]);
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] != null) top.text += decEnt(m[6]);
  }
  return root;
}
const kids = (el, name) => el.children.filter((c) => c.name === name);
const kid = (el, name) => el.children.find((c) => c.name === name) || null;
function all(el, name, out = []) { for (const c of el.children) { if (c.name === name) out.push(c); all(c, name, out); } return out; }
const nums = (s) => String(s || "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
const num = (s, d = NaN) => { const v = parseFloat(s); return Number.isFinite(v) ? v : d; };
const LIN = { meter: 1, metre: 1, millimeter: 0.001, millimetre: 0.001, centimeter: 0.01, centimetre: 0.01, kilometer: 1000, kilometre: 1000, foot: 0.3048, USSurveyFoot: 1200 / 3937, footUS: 1200 / 3937 };

/* ---- LandXML → assi ------------------------------------------------------- */
/* una coppia «a b» → [x, y] = [Est, Nord]: swap = false legge a = Nord, b = Est (la specifica) */
const pair = (el, swap, uf) => { if (!el) return null; const v = nums(el.text); if (v.length < 2) return null; return swap ? [v[0] * uf, v[1] * uf] : [v[1] * uf, v[0] * uf]; };
const radius = (s, uf) => { const t = String(s ?? "").trim().toUpperCase(); if (!t || t === "INF" || t === "INFINITY") return Infinity; const v = parseFloat(t); return Number.isFinite(v) && v > 0 ? v * uf : Infinity; };
/* elementi di pianta di un CoordGeom nel formato del motore */
function planElems(cg, swap, uf) {
  const out = [], warn = [];
  for (const el of cg.children) {
    const S = pair(kid(el, "Start"), swap, uf);
    if (el.name === "Line") {
      const E = pair(kid(el, "End"), swap, uf);
      if (!S || !E) continue;
      const len = Math.hypot(E[0] - S[0], E[1] - S[1]);
      out.push({ t: "L", x0: S[0], y0: S[1], th0: Math.atan2(E[1] - S[1], E[0] - S[0]), len, k0: 0, k1: 0 });
    } else if (el.name === "Curve") {
      const Cc = pair(kid(el, "Center"), swap, uf), E = pair(kid(el, "End"), swap, uf);
      if (!S || !Cc) continue;
      const sg = /^\s*cw\s*$/i.test(el.attrs.rot || "") ? -1 : 1;
      const R = num(el.attrs.radius) * uf || Math.hypot(S[0] - Cc[0], S[1] - Cc[1]);
      const a0 = Math.atan2(S[1] - Cc[1], S[0] - Cc[0]);
      let len = num(el.attrs.length) * uf;
      if (!(len > 0) && E) { let d = sg * (Math.atan2(E[1] - Cc[1], E[0] - Cc[0]) - a0); d = ((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); len = R * d; }
      out.push({ t: "A", x0: S[0], y0: S[1], th0: a0 + sg * Math.PI / 2, len, k0: sg / R, k1: sg / R });
    } else if (el.name === "Spiral") {
      const PI = pair(kid(el, "PI"), swap, uf);
      if (!S || !PI) continue;
      const st = (el.attrs.spiType || "clothoid").toLowerCase();
      if (st !== "clothoid") warn.push(st);
      const sg = /^\s*cw\s*$/i.test(el.attrs.rot || "") ? -1 : 1;
      const r0 = radius(el.attrs.radiusStart, uf), r1 = radius(el.attrs.radiusEnd, uf);
      out.push({ t: "C", x0: S[0], y0: S[1], th0: Math.atan2(PI[1] - S[1], PI[0] - S[0]), len: num(el.attrs.length) * uf, k0: Number.isFinite(r0) ? sg / r0 : 0, k1: Number.isFinite(r1) ? sg / r1 : 0 });
    } else if (el.name === "IrregularLine") {
      const pl = kid(el, "PntList2D"), v = nums(pl && pl.text), pts = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push(swap ? [v[i] * uf, v[i + 1] * uf] : [v[i + 1] * uf, v[i] * uf]);
      for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i], b = pts[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len > 1e-9) out.push({ t: "L", x0: a[0], y0: a[1], th0: Math.atan2(b[1] - a[1], b[0] - a[0]), len, k0: 0, k1: 0 }); }
    }
  }
  return { elems: out, warn };
}
/* il profilo proposto: la livelletta di progetto per nome, altrimenti il primo */
export const designProfile = (names) => {
  const i = names.findIndex((n) => /livellett|progett|design|pgl|grade|top.?rail|piano.?ferro/i.test(n));
  return i >= 0 ? i : 0;
};
/* un ProfAlign → vertici [{ u, z, L, R }] con u = progressiva del file − s0 */
function profAlign(pa, s0, uf) {
  const out = [];
  for (const el of pa.children) {
    const v = nums(el.text);
    if (v.length < 2 || !Number.isFinite(v[0]) || !Number.isFinite(v[1])) continue;
    const u = v[0] * uf - s0, z = v[1] * uf;
    if (el.name === "PVI") out.push({ u, z, L: 0, R: 0 });
    else if (el.name === "CircCurve") out.push({ u, z, L: num(el.attrs.length, 0) * uf, R: num(el.attrs.radius, 0) * uf });
    else if (el.name === "ParaCurve") out.push({ u, z, L: num(el.attrs.length, 0) * uf, R: 0 });
    else if (el.name === "UnsymParaCurve") out.push({ u, z, L: (num(el.attrs.lengthIn, 0) + num(el.attrs.lengthOut, 0)) * uf, R: 0 });
  }
  return out;
}
/* sopraelevazione: appliedCant in mm (Civil 3D; il LandXML 1.2 non dice l'unità), verso dalla curvatura */
function cantStations(al, s0, uf) {
  const c = kid(al, "Cant");
  if (!c) return { gauge: null, rot: null, st: [] };
  const st = kids(c, "CantStation").map((e) => ({ u: num(e.attrs.station) * uf - s0, c: num(e.attrs.appliedCant, 0) / 1000, dir: /^\s*cw\s*$/i.test(e.attrs.curvature || "") ? -1 : /ccw/i.test(e.attrs.curvature || "") ? 1 : 0 }))
    .filter((x) => Number.isFinite(x.u)).sort((a, b) => a.u - b.u);
  return { gauge: num(c.attrs.gauge, NaN) * uf, rot: c.attrs.rotationPoint || null, st };
}
/* legge un LandXML: { units, project, app, aligns: [{ name, desc, s0, length, H, junc, swap, profiles: [{ name, pvi }], prof, cant, speeds, warn }] } */
export function readLandXML(text) {
  const root = parseXML(text), lx = kid(root, "LandXML");
  if (!lx) throw new Error("not LandXML");
  const met = lx && all(lx, "Metric")[0], imp = lx && all(lx, "Imperial")[0];
  const unitName = (met && met.attrs.linearUnit) || (imp && imp.attrs.linearUnit) || "meter";
  const uf = LIN[unitName] || 1;
  const prj = kid(lx, "Project"), app = kid(lx, "Application");
  const aligns = [];
  for (const al of all(lx, "Alignment")) {
    const cg = kid(al, "CoordGeom");
    if (!cg) continue;
    const s0 = num(al.attrs.staStart, 0) * uf;
    // ordine delle coppie: quello con le giunzioni più strette
    let best = null;
    for (const swap of [false, true]) {
      const { elems, warn } = planElems(cg, swap, uf);
      if (!elems.length) continue;
      const H = hAlign(elems), junc = hJunctions(H), worst = junc.reduce((w, j) => Math.max(w, j.dPos), 0);
      if (!best || worst < best.worst - 1e-6) best = { swap, H, junc, worst, warn };
    }
    if (!best) continue;
    const profiles = [];
    for (const pr of kids(al, "Profile")) for (const pa of kids(pr, "ProfAlign")) profiles.push({ name: pa.attrs.name || "ProfAlign " + (profiles.length + 1), pvi: profAlign(pa, s0, uf) });
    const ground = [];
    for (const pr of kids(al, "Profile")) for (const ps of kids(pr, "ProfSurf")) {
      const pl = kid(ps, "PntList2D"), v = nums(pl && pl.text), pts = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push({ u: v[i] * uf - s0, z: v[i + 1] * uf });
      if (pts.length > 1) ground.push({ name: ps.attrs.name || "ProfSurf", pts });
    }
    const prof = profiles.length ? designProfile(profiles.map((p) => p.name)) : -1;
    const cant = cantStations(al, s0, uf);
    const speeds = all(al, "SpeedStation").map((e) => ({ u: num(e.attrs.station) * uf - s0, v: num(e.attrs.speed) })).filter((x) => Number.isFinite(x.u) && Number.isFinite(x.v));
    const dedup = [];
    for (const s of speeds.sort((a, b) => a.u - b.u)) if (!dedup.some((d) => Math.abs(d.u - s.u) < 1e-6 && d.v === s.v)) dedup.push(s);
    aligns.push({ name: al.attrs.name || "Alignment " + (aligns.length + 1), desc: al.attrs.desc || "", s0, lengthDecl: num(al.attrs.length) * uf,
      H: best.H, junc: best.junc, worstJunction: best.worst, swap: best.swap, profiles, prof, ground, cant, speeds: dedup, warn: best.warn });
  }
  return { unitName, project: prj ? prj.attrs.name || "" : "", app: app ? [app.attrs.name, app.attrs.version].filter(Boolean).join(" ") : "", aligns };
}
/* ---- file di progetto .ocs: JSON (compresso con gzip dalla pagina) ---------------------------------- */
export const PRJ_FORMAT = "viewifc-railway-ocs", PRJ_V = 1;
export const isGzip = (u8) => u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b;
/* i numeri non finiti (Infinity dei raggi) passano come stringhe */
const numOut = (k, v) => (typeof v === "number" && !Number.isFinite(v) ? { $n: String(v) } : v);
const numIn = (k, v) => (v && typeof v === "object" && typeof v.$n === "string" && Object.keys(v).length === 1 ? Number(v.$n) : v);
export function encodeProject(doc, extra = {}) {
  return new TextEncoder().encode(JSON.stringify({ format: PRJ_FORMAT, v: PRJ_V, ...extra, doc }, numOut));
}
export function decodeProject(u8) {
  let h;
  try { h = JSON.parse(new TextDecoder().decode(u8), numIn); } catch (e) { throw new Error("not a Railway OCS project"); }
  if (!h || h.format !== PRJ_FORMAT || !h.doc || !Array.isArray(h.doc.tracks)) throw new Error("not a Railway OCS project");
  if (h.v > PRJ_V) throw new Error("project from a newer version (format " + h.v + ")");
  const doc = h.doc; delete h.doc;
  return { doc, header: h };
}

/* un asse letto → binario del motore: { H, V, cant, s0 } col profilo scelto */
export function trackFromAlign(a, profIndex = a.prof) {
  const p = a.profiles[profIndex];
  return { H: a.H, V: profileV(p), cant: a.cant.st, s0: a.s0 };
}

/* ---- IFC 4x3: assi da IfcAlignment ------------------------------------------------------------------
   Si legge la «logica di progetto» (business logic) dello standard, non la geometria di rappresentazione:
   IfcAlignment → (IfcRelNests) IfcAlignmentHorizontal / Vertical / Cant → IfcAlignmentSegment →
   DesignParameters. Come il viewer: si seguono anche gli IfcRelAggregates (export SierraSoft).
   - pianta: LINE, CIRCULARARC, CLOTHOID (le altre transizioni si leggono come clotoidi, con avviso);
     raggio positivo = curva a sinistra; StartDirection nell'unità d'angolo del file;
   - profilo: CONSTANTGRADIENT, CIRCULARARC (cerchio esatto), PARABOLICARC; i segmenti stanno già
     nella forma del motore (niente PVI);
   - sopraelevazione: |cant destra − cant sinistra| a ogni capo di segmento; la rotaia più alta è
     l'esterna della curva (destra più alta → curva a sinistra);
   - coordinate: catena di IfcLocalPlacement dell'asse (rotazione nel piano + traslazione), poi
     IfcMapConversion (Eastings, Northings, OrthogonalHeight, asse X, scala) → coordinate di mappa,
     come i LandXML; unità di lunghezza del file (anche millimetri);
   - progressiva iniziale: Station del Pset_Stationing dell'IfcReferent all'inizio dell'asse (tool 11).
   Gli schemi IFC2X3 e IFC4 non hanno IfcAlignment: si dice (il tool 13 IFC Schema Change non lo crea). */
const IFC_WANT = new Set(["IFCALIGNMENT", "IFCRELNESTS", "IFCRELAGGREGATES", "IFCALIGNMENTHORIZONTAL", "IFCALIGNMENTVERTICAL", "IFCALIGNMENTCANT",
  "IFCALIGNMENTSEGMENT", "IFCALIGNMENTHORIZONTALSEGMENT", "IFCALIGNMENTVERTICALSEGMENT", "IFCALIGNMENTCANTSEGMENT", "IFCCARTESIANPOINT", "IFCDIRECTION",
  "IFCLOCALPLACEMENT", "IFCAXIS2PLACEMENT3D", "IFCAXIS2PLACEMENT2D", "IFCMAPCONVERSION", "IFCSIUNIT", "IFCCONVERSIONBASEDUNIT", "IFCMEASUREWITHUNIT",
  "IFCREFERENT", "IFCRELDEFINESBYPROPERTIES", "IFCPROPERTYSET", "IFCPROPERTYSINGLEVALUE", "IFCPROJECT", "IFCAPPLICATION"]);
/* le entità che servono: #id → { t, raw } (argomenti grezzi, si spezzano quando servono) */
export function stepEntities(text, want = IFC_WANT) {
  const ents = new Map(), re = /#(\d+)\s*=\s*([A-Za-z0-9_]+)\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    let i = re.lastIndex, depth = 1, str = false;
    for (; i < text.length && depth; i++) {
      const c = text.charCodeAt(i);
      if (str) { if (c === 39) { if (text.charCodeAt(i + 1) === 39) i++; else str = false; } }
      else if (c === 39) str = true;
      else if (c === 40) depth++;
      else if (c === 41) depth--;
    }
    const t = m[2].toUpperCase();
    if (want.has(t)) ents.set(+m[1], { t, raw: text.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return ents;
}
export function stepSplit(s) {
  const out = [];
  let depth = 0, str = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (str) { cur += ch; if (ch === "'") { if (s[i + 1] === "'") { cur += "'"; i++; } else str = false; } }
    else if (ch === "'") { str = true; cur += ch; }
    else if (ch === "(") { depth++; cur += ch; }
    else if (ch === ")") { depth--; cur += ch; }
    else if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}
const sArgs = (e) => e.args || (e.args = stepSplit(e.raw));
const sRef = (a) => (a && a[0] === "#" ? +a.slice(1) : null);
const sStr = (a) => (a && a.length >= 2 && a[0] === "'" ? a.slice(1, -1).replace(/''/g, "'") : null);
const sEnum = (a) => { const m = /^\.([^.]*)\.$/.exec(a || ""); return m ? m[1].toUpperCase() : null; };
/* numero STEP: «12.5», «213000.», «1.E-05» o tipizzato «IFCLENGTHMEASURE(12.5)» */
const sNum = (a, d = NaN) => {
  if (a == null) return d;
  const t = String(a).trim(), m = /^[A-Z][A-Z0-9_]*\(\s*([^()]*?)\s*\)$/i.exec(t), v = Number(m ? m[1] : t);
  return t !== "" && t !== "$" && t !== "*" && Number.isFinite(v) ? v : d;
};
const sList = (a) => (a && a[0] === "(" ? stepSplit(a.slice(1, -1)) : []);
export function ifcSchema(text) {
  const m = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(text.slice(0, 8192));
  return m ? m[1].toUpperCase() : null;
}
export function readIfcAlignments(text) {
  const schema = ifcSchema(text);
  const E = stepEntities(text);
  const get = (id) => (id == null ? null : E.get(id) || null);
  // unità: lunghezza (prefisso SI) e angolo (radianti o gradi)
  let uf = 1, af = 1;
  for (const e of E.values()) {
    if (e.t === "IFCSIUNIT") {
      const a = sArgs(e), type = sEnum(a[1]), pre = sEnum(a[2]), name = sEnum(a[3]);
      const pf = { MILLI: 1e-3, CENTI: 1e-2, DECI: 0.1, KILO: 1e3 }[pre] || 1;
      if (type === "LENGTHUNIT" && name === "METRE") uf = pf;
      if (type === "PLANEANGLEUNIT" && name === "RADIAN") af = 1;
    } else if (e.t === "IFCCONVERSIONBASEDUNIT") {
      const a = sArgs(e);
      if (sEnum(a[1]) !== "PLANEANGLEUNIT") continue;
      const mw = get(sRef(a[3]));
      const f = mw ? sNum(sArgs(mw)[0]) : NaN;
      af = Number.isFinite(f) && f > 0 ? f : /DEG/i.test(sStr(a[2]) || "") ? Math.PI / 180 : af;
    }
  }
  // georeferenziazione
  let map = null;
  for (const e of E.values()) if (e.t === "IFCMAPCONVERSION") {
    const a = sArgs(e);
    const xa = sNum(a[5], 1), xo = sNum(a[6], 0), sc = sNum(a[7], NaN);
    map = { E: sNum(a[2], 0), N: sNum(a[3], 0), H: sNum(a[4], 0), rot: Math.atan2(xo, xa), scale: Number.isFinite(sc) ? sc : uf };
    break;
  }
  const S = map ? map.scale : uf;                        // unità del file → metri di mappa
  const pt = (id) => { const e = get(id); if (!e) return null; const c = sList(sArgs(e)[0]).map((v) => sNum(v, 0)); return { x: c[0] || 0, y: c[1] || 0, z: c[2] || 0 }; };
  const dirAng = (id) => { const e = get(id); if (!e) return 0; const c = sList(sArgs(e)[0]).map((v) => sNum(v, 0)); return c.length >= 2 ? Math.atan2(c[1], c[0]) : 0; };
  /* catena dei piazzamenti → trasformazione nel piano { rot, x, y, z } in unità del file */
  const placement = (id, depth = 0) => {
    const e = get(id);
    if (!e || e.t !== "IFCLOCALPLACEMENT" || depth > 20) return { rot: 0, x: 0, y: 0, z: 0 };
    const a = sArgs(e), up = placement(sRef(a[0]), depth + 1), ax = get(sRef(a[1]));
    let r = 0, p = { x: 0, y: 0, z: 0 };
    if (ax) { const b = sArgs(ax); p = pt(sRef(b[0])) || p; const rd = ax.t === "IFCAXIS2PLACEMENT3D" ? sRef(b[2]) : sRef(b[1]); if (rd != null) r = dirAng(rd); }
    const c = Math.cos(up.rot), s = Math.sin(up.rot);
    return { rot: up.rot + r, x: up.x + c * p.x - s * p.y, y: up.y + s * p.x + c * p.y, z: up.z + p.z };
  };
  const toMap = (P, x, y) => {
    const c = Math.cos(P.rot), s = Math.sin(P.rot), lx = P.x + c * x - s * y, ly = P.y + s * x + c * y;
    if (!map) return [lx * uf, ly * uf];
    const cr = Math.cos(map.rot), sr = Math.sin(map.rot);
    return [map.E + S * (cr * lx - sr * ly), map.N + S * (sr * lx + cr * ly)];
  };
  const angMap = (P, th) => th + P.rot + (map ? map.rot : 0);
  const zMap = (P, z) => (map ? map.H + S * (z + P.z) : uf * (z + P.z));
  // annidamenti (IfcRelNests e IfcRelAggregates), in ordine
  const nest = new Map();
  for (const e of E.values()) {
    if (e.t !== "IFCRELNESTS" && e.t !== "IFCRELAGGREGATES") continue;
    const a = sArgs(e), r = sRef(a[4]);
    if (r == null) continue;
    nest.set(r, (nest.get(r) || []).concat(sList(a[5]).map(sRef).filter((x) => x != null)));
  }
  const segsOf = (layout, want) => {
    const out = [];
    for (const sid of nest.get(layout) || []) {
      const s = get(sid);
      if (!s) continue;
      if (s.t === "IFCALIGNMENTSEGMENT") { const dp = get(sRef(sArgs(s)[7])); if (dp && dp.t === want) out.push(dp); }
      else if (s.t === want) out.push(s);
    }
    return out;
  };
  // Pset_Stationing dei referenti: Station (senza IncomingStation)
  const station = new Map();
  for (const e of E.values()) {
    if (e.t !== "IFCRELDEFINESBYPROPERTIES") continue;
    const a = sArgs(e), ps = get(sRef(a[5]));
    if (!ps || ps.t !== "IFCPROPERTYSET" || sStr(sArgs(ps)[2]) !== "Pset_Stationing") continue;
    let st = NaN, inc = false;
    for (const pid of sList(sArgs(ps)[4]).map(sRef)) {
      const p = get(pid);
      if (!p) continue;
      const pa = sArgs(p), nm = sStr(pa[0]);
      if (nm === "Station") st = sNum(pa[2]);
      if (nm === "IncomingStation") inc = true;
    }
    if (Number.isFinite(st) && !inc) for (const r of sList(a[4]).map(sRef)) station.set(r, st);
  }
  const prj = [...E.values()].find((e) => e.t === "IFCPROJECT"), app = [...E.values()].find((e) => e.t === "IFCAPPLICATION");
  const aligns = [];
  for (const [id, e] of E) {
    if (e.t !== "IFCALIGNMENT") continue;
    const a = sArgs(e), name = sStr(a[2]) || "IfcAlignment #" + id, P = placement(sRef(a[5]));
    const kidsA = (nest.get(id) || []).map((k) => [k, get(k)]).filter(([, x]) => x);
    const hor = kidsA.find(([, x]) => x.t === "IFCALIGNMENTHORIZONTAL"), ver = kidsA.find(([, x]) => x.t === "IFCALIGNMENTVERTICAL"), can = kidsA.find(([, x]) => x.t === "IFCALIGNMENTCANT");
    if (!hor) continue;
    const elems = [], warn = [];
    for (const dp of segsOf(hor[0], "IFCALIGNMENTHORIZONTALSEGMENT")) {
      const b = sArgs(dp), p0 = pt(sRef(b[2]));
      if (!p0) continue;
      const [x0, y0] = toMap(P, p0.x, p0.y), th0 = angMap(P, sNum(b[3], 0) * af);
      const r0 = sNum(b[4], 0), r1 = sNum(b[5], 0), len = sNum(b[6], 0) * S, type = sEnum(b[8]) || "LINE";
      const k = (r) => (r ? 1 / (r * S) : 0);
      if (!(len > 1e-9)) continue;
      if (type === "LINE") elems.push({ t: "L", x0, y0, th0, len, k0: 0, k1: 0 });
      else if (type === "CIRCULARARC") { const kk = k(r0 || r1); elems.push({ t: "A", x0, y0, th0, len, k0: kk, k1: kk }); }
      else { if (type !== "CLOTHOID") warn.push(type.toLowerCase()); elems.push({ t: "C", x0, y0, th0, len, k0: k(r0), k1: k(r1) }); }
    }
    if (!elems.length) continue;
    const H = hAlign(elems), junc = hJunctions(H), worst = junc.reduce((w, j) => Math.max(w, j.dPos), 0);
    const profiles = [];
    if (ver) {
      const segs = [];
      for (const dp of segsOf(ver[0], "IFCALIGNMENTVERTICALSEGMENT")) {
        const b = sArgs(dp), u0 = sNum(b[2], 0) * S, len = sNum(b[3], 0) * S, z0 = zMap(P, sNum(b[4], 0)), g0 = sNum(b[5], 0), g1 = sNum(b[6], g0), type = sEnum(b[8]) || "CONSTANTGRADIENT";
        if (!(len > 1e-9)) continue;
        if (type === "CONSTANTGRADIENT" || Math.abs(g1 - g0) < 1e-12) segs.push({ u0, len, z0, g0, g1: g0, R: 0 });
        else if (type === "CIRCULARARC") { const Rv = Math.abs(sNum(b[7], NaN)) * S; segs.push({ u0, len, z0, g0, g1, R: Math.sign(g1 - g0) * (Rv > 0 ? Rv : len / Math.abs(g1 - g0)), circ: true }); }
        else segs.push({ u0, len, z0, g0, g1, R: len / (g1 - g0) });
      }
      segs.sort((p, q) => p.u0 - q.u0);
      if (segs.length) profiles.push({ name: sStr(sArgs(ver[1])[2]) || "IfcAlignmentVertical", segs });
    }
    const st = [];
    if (can) for (const dp of segsOf(can[0], "IFCALIGNMENTCANTSEGMENT")) {
      const b = sArgs(dp), u0 = sNum(b[2], 0) * S, len = sNum(b[3], 0) * S;
      const L0 = sNum(b[4], 0), L1 = sNum(b[5], L0), R0 = sNum(b[6], 0), R1 = sNum(b[7], R0);
      const at = (u, l, r) => ({ u, c: Math.abs(r - l) * S, dir: r > l + 1e-9 ? 1 : l > r + 1e-9 ? -1 : 0 });
      st.push(at(u0, L0, R0), at(u0 + len, L1, R1));
    }
    st.sort((p, q) => p.u - q.u);
    const cant = { gauge: can ? sNum(sArgs(can[1])[7], NaN) * S : null, rot: can ? "insideRail" : null, st: st.filter((x, i) => !i || Math.abs(x.u - st[i - 1].u) > 1e-6 || x.c !== st[i - 1].c) };
    // progressiva iniziale: il referente all'inizio dell'asse
    let s0 = 0;
    for (const [rid, r] of kidsA) {
      if (r.t !== "IFCREFERENT" || !station.has(rid)) continue;
      const RP = placement(sRef(sArgs(r)[5]));
      const [rx, ry] = toMap({ rot: 0, x: 0, y: 0, z: 0 }, RP.x, RP.y);
      if (Math.hypot(rx - H.segs[0].x0, ry - H.segs[0].y0) < 0.01) { s0 = station.get(rid) * S; break; }
    }
    aligns.push({ name, desc: sStr(a[3]) || "", s0, lengthDecl: H.length, H, junc, worstJunction: worst, swap: false,
      profiles, prof: profiles.length ? 0 : -1, ground: [], cant, speeds: [], warn });
  }
  const appName = app ? [sStr(sArgs(app)[2]), sStr(sArgs(app)[1])].filter(Boolean).join(" ") : "";
  return { schema, unitFactor: uf, map, project: prj ? sStr(sArgs(prj)[2]) || "" : "", app: appName, aligns };
}

/* ---- disegni CAD (DWG/DXF letti col lettore di Sviluppo profili) → binario ---------------------------
   La pianta arriva come asse di profile-core (planAxis: rette e archi dai bulge); le clotoidi nei disegni
   sono già spezzate in polilinee (restano rette corte). Il profilo arriva come punti (s, z) già tarati
   (profileLine): livellette a spigolo vivo fra i vertici, i raccordi disegnati restano i loro vertici. */
export function elemsFromPlanAxis(axis) {
  const out = [];
  for (const g of axis.segs) {
    if (!(g.len > 1e-9)) continue;
    if (g.t === "A") { const sg = g.sweep >= 0 ? 1 : -1; out.push({ t: "A", x0: g.x0, y0: g.y0, th0: g.a0 + sg * Math.PI / 2, len: g.len, k0: sg / g.r, k1: sg / g.r }); }
    else out.push({ t: "L", x0: g.x0, y0: g.y0, th0: Math.atan2(g.uy, g.ux), len: g.len, k0: 0, k1: 0 });
  }
  return out;
}
/* punti (s, z) del profilo tarato → vertici del motore con u = s − progressiva iniziale; i vertici doppi
   (salti verticali, stessa progressiva) tengono l'ultimo */
export function pviFromPoints(pts, s0 = 0) {
  const out = [];
  for (const p of pts) {
    const u = p.s - s0;
    if (!Number.isFinite(u) || !Number.isFinite(p.z)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(u - last.u) < 1e-6) { last.z = p.z; continue; }
    out.push({ u, z: p.z, L: 0, R: 0 });
  }
  return out.sort((a, b) => a.u - b.u);
}

/* ---- tabella di picchettamento (CSV o XLSX) -------------------------------------------------------
   Una riga per sostegno; le colonne si riconoscono dall'intestazione (quella del Cartiglio_A3 dei fogli
   Satferr compresa: NUMERO_SOSTEGNO, TIPO_PALO, L_MENSOLA, L_TIRANTE, TIPO_SOSP, TIPO_TIRANTINI,
   TIPO_BLOCCO) e si possono correggere nella pagina. Le righe di titolo sopra l'intestazione si saltano
   (si cerca la riga che riconosce più colonne, come l'IDS Editor). Le colonne che il tool non usa restano
   sul palo come attributi (attrs): serviranno al modulo Pset (F3). */
export function parseCSV(text) {
  const t = String(text).replace(/^﻿/, "");
  const head = t.split(/\r?\n/).slice(0, 10).join("\n");
  const cnt = (c) => (head.match(new RegExp(c === "\t" ? "\t" : "\\" + c, "g")) || []).length;
  const sep = [";", "\t", ","].sort((a, b) => cnt(b) - cnt(a))[0];
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"' && cur === "") q = true;
    else if (ch === sep) { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && t[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}
/* XLSX: zip (directory centrale) + DecompressionStream("deflate-raw"), fogli con le stringhe condivise */
function zipEntries(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 66000; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip");
  const n = dv.getUint16(eocd + 10, true), dec = new TextDecoder(), out = [];
  let off = dv.getUint32(eocd + 16, true);
  for (let i = 0; i < n && off + 46 <= bytes.length; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const nlen = dv.getUint16(off + 28, true), elen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
    out.push({ name: dec.decode(bytes.subarray(off + 46, off + 46 + nlen)), method: dv.getUint16(off + 10, true), csize: dv.getUint32(off + 20, true), lho: dv.getUint32(off + 42, true) });
    off += 46 + nlen + elen + clen;
  }
  for (const e of out) {
    if (dv.getUint32(e.lho, true) !== 0x04034b50) { e.data = null; continue; }
    const start = e.lho + 30 + dv.getUint16(e.lho + 26, true) + dv.getUint16(e.lho + 28, true);
    e.data = bytes.subarray(start, start + e.csize);
  }
  return out;
}
async function inflate(e) {
  if (!e.data) return new Uint8Array(0);
  if (e.method === 0) return e.data;
  if (e.method !== 8) throw new Error("zip method " + e.method);
  const ds = new DecompressionStream("deflate-raw");
  return new Uint8Array(await new Response(new Blob([e.data]).stream().pipeThrough(ds)).arrayBuffer());
}
const xmlDec = (s) => String(s).replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const colNum = (L) => { let n = 0; for (const c of L) n = n * 26 + c.charCodeAt(0) - 64; return n - 1; };
export async function readXlsx(bytes) {
  const files = new Map(), dec = new TextDecoder();
  for (const e of zipEntries(bytes)) if (/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(e.name)) files.set(e.name, dec.decode(await inflate(e)));
  const shared = [];
  for (const m of (files.get("xl/sharedStrings.xml") || "").matchAll(/<si(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    let s = "";
    for (const t of (m[1] || "").matchAll(/<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g)) s += t[1] == null ? "" : xmlDec(t[1]);
    shared.push(s);
  }
  const rels = new Map();
  for (const m of (files.get("xl/_rels/workbook.xml.rels") || "").matchAll(/<Relationship\s[^>]*>/g)) {
    const id = (m[0].match(/Id="([^"]+)"/) || [])[1], tg = (m[0].match(/Target="([^"]+)"/) || [])[1];
    if (id && tg) rels.set(id, "xl/" + tg.replace(/^\/?xl\//, "").replace(/^\.\//, ""));
  }
  const sheets = [];
  let i = 0;
  for (const m of (files.get("xl/workbook.xml") || "").matchAll(/<sheet\s[^>]*\/?>/g)) {
    const rid = (m[0].match(/r:id="([^"]+)"/) || [])[1];
    let p = rid && rels.get(rid);
    if (!p || !files.has(p)) p = "xl/worksheets/sheet" + (i + 1) + ".xml";
    sheets.push({ name: xmlDec((m[0].match(/name="([^"]*)"/) || [])[1] || "Foglio" + (i + 1)), path: p });
    i++;
  }
  if (!sheets.length) for (const k of files.keys()) if (/^xl\/worksheets\//.test(k)) sheets.push({ name: k, path: k });
  return sheets.filter((s) => files.has(s.path)).map((s) => {
    const rows = [];
    for (const r of files.get(s.path).matchAll(/<row(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells = [];
      let auto = 0;
      for (const c of (r[1] || "").matchAll(/<c(\s[^>]*)?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attr = c[1] || "", body = c[2] || "", rm = attr.match(/r="([A-Z]+)\d+"/), col = rm ? colNum(rm[1]) : auto;
        auto = col + 1;
        const t = (attr.match(/t="([^"]+)"/) || [])[1] || "n";
        let v = null;
        if (t === "inlineStr") { const im = body.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/); v = im ? xmlDec(im[1]) : ""; }
        else { const vm = body.match(/<v>([\s\S]*?)<\/v>/); if (vm) v = t === "s" ? shared[+vm[1]] || "" : xmlDec(vm[1]); }
        if (v != null) { while (cells.length < col) cells.push(""); cells[col] = v; }
      }
      rows.push(cells);
    }
    return { name: s.name, rows: rows.filter((x) => x.some((c) => String(c).trim() !== "")) };
  });
}
export const isZip = (u8) => u8.length > 3 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 3 && u8[3] === 4;
/* qualunque tabella → fogli [{ name, rows }] */
export async function readTable(bytes, name = "") {
  if (isZip(bytes)) return readXlsx(bytes);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) { text = new TextDecoder("windows-1252").decode(bytes); }
  return [{ name: name || "CSV", rows: parseCSV(text) }];
}
/* intestazione → campo del tool */
/* «N. picchetto» = «n picchetto»: il punto delle abbreviazioni vale uno spazio (0.9.0) */
const hnorm = (h) => String(h == null ? "" : h).trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\.(?=\s)/g, " ").replace(/[_\s]+/g, " ").replace(/[.:]+$/, "").trim();
/* L2 / sosp2 (L_MENSOLA_2, TIPO_SOSP_2 del Cartiglio Satferr) = la SECONDA SOSPENSIONE sulla stessa mensola
   (palo su due binari, PIANO §14.1), non una seconda mensola: lunghezza della mensola che la porta e tipo */
/* E / N (0.9.0) = coordinate dell'ASSE DEL FUSTO, nelle coordinate dei binari: con quelle valgono la posizione,
   il lato e la DR ricalcolati; progressiva e DR della tabella restano per il controllo */
/* portali (0.11.0): E2 / N2 = asse del SECONDO montante («Est_palo sotto», «Est montante 2»; E / N è il primo,
   «… sopra»): una riga con le due coppie è un portale, con una sola un palo. num2 = numero del secondo montante
   (il portale si chiama «num / num2»), block = nome del blocco («Blocco» quando c'è anche una colonna della
   fondazione), ptype = tipologia («TIPO C 18÷27 - (2+2) x LSU22»), found2 = fondazione del secondo montante,
   Lb = lunghezza della trave scritta (controllo) */
export const TABLE_FIELDS = ["num", "num2", "sta", "E", "N", "E2", "N2", "side", "dr", "mast", "block", "ptype", "L", "sosp", "L2", "sosp2", "found", "found2", "Lb", "hw", "stag", "track"];
const HDR = [
  ["L2", /^(l mensola 2|lunghezza mensola 2|mensola 2|2a mensola|seconda mensola|cantilever 2)$/],
  ["sosp2", /^(tipo sosp 2|tipo sospensione 2|sospensione 2|seconda sospensione|suspension 2|suspension type 2)$/],
  ["sosp", /^(tipo sosp|tipo sospensione|sospensione|suspension|suspension type)$/],
  ["num2", /^((n|n°|no|nr|num|numero)( montante)? (sotto|2)|numero 2)$/],
  ["num", /^(n|n°|no|nr|num|numero|numero sostegno|n sostegno|sostegno|picchetto|n picchetto|numero picchetto|palo n|id|mast no|support|support no|number|(n|n°|numero)( montante)? (sopra|1))$/],
  ["found2", /^(fondazione|blocco fondazione|tipo blocco|plinto) (sotto|2)$/],
  ["found", /^(fondazione|blocco fondazione|tipo blocco|plinto) (sopra|1)$/],
  ["ptype", /^(tipologia|tipologia portale|tipo portale|tipo trave)$/],
  ["Lb", /^(l trave|lunghezza trave|luce trave|luce|beam length|span)$/],
  ["sta", /^(progressiva|prog|pk|progr|km|chilometrica|kilometrica|progressiva km|station|chainage|sta|progressiva \(m\))$/],
  ["side", /^(lato|side|lato binario|posizione|sx\/dx|s\/d)$/],
  ["dr", /^(dr|d r|distanza palo rotaia|distanza palo-rotaia|dr palo|distanza|dr \(mm\)|dr \(m\))$/],
  ["mast", /^(tipo palo|palo|tipo sostegno|tipo|mast|mast type|sostegno tipo)$/],
  ["L", /^(l mensola|lunghezza mensola|mensola|cantilever|l mensola \(mm\)|l mensola \(m\))$/],
  ["found", /^(tipo blocco|blocco fondazione|blocco|fondazione|tipo fondazione|plinto|foundation|blocco di fondazione)$/],
  ["hw", /^(altezza filo|h filo|hfilo|altezza fdc|altezza filo di contatto|contact wire height|wire height)$/],
  ["stag", /^(poligonazione|stagger|poligonazione \(mm\))$/],
  ["track", /^(binario|track|asse|alignment)$/],
  // dopo «num»: una colonna «N» da sola è il numero; accanto a una colonna Est è il Nord (tableHeader)
  ["E2", /^((coord(inata)?\.? ?)?(e|est|x)( (palo|fusto|sostegno|montante))? (sotto|2)( \(m\))?|e2|est2|x2)$/],
  ["N2", /^((coord(inata)?\.? ?)?(nord|y)( (palo|fusto|sostegno|montante))? (sotto|2)( \(m\))?|nord2|y2)$/],
  ["E", /^((coord(inata)?\.? ?)?(e|est|x)( (palo|fusto|sostegno|montante))?( (sopra|1))?( \(m\))?|easting|east)$/],
  ["N", /^((coord(inata)?\.? ?)?(nord|y)( (palo|fusto|sostegno|montante))?( (sopra|1))?( \(m\))?|coord(inata)?\.? ?n|n \(m\)|northing|north)$/],
];
const PALO_XY = / (palo|fusto|sostegno|montante)( |$)/;
export function headerKey(h) { const t = hnorm(h); for (const [k, re] of HDR) if (re.test(t)) return k; return null; }
/* la riga d'intestazione (fra le prime 25) e la proposta di colonne: { row, map: { campo: colonna } } */
export function tableHeader(rows) {
  let best = { row: 0, n: -1, map: {} };
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const map = {};
    rows[r].forEach((h, c) => { const k = headerKey(h); if (k && map[k] == null) map[k] = c; });
    if (map.E != null && map.N == null) {                // «E» e «N»: la N più vicina alla E è il Nord, il numero sta in un'altra colonna
      const cs = rows[r].map((h, j) => (hnorm(h) === "n" ? j : -1)).filter((j) => j >= 0).sort((a, b) => Math.abs(a - map.E) - Math.abs(b - map.E));
      const c = cs.length ? cs[0] : -1;
      if (c >= 0) {
        map.N = c;
        if (map.num === c) { delete map.num; const o = rows[r].findIndex((h, j) => j !== c && headerKey(h) === "num"); if (o >= 0) map.num = o; }
      }
    }
    // «Est» ed «Est_palo» insieme (estrazione dal DWG Satferr: inserimento del blocco sull'asse del binario e centro
    // del palo): valgono le coordinate del palo, quelle che il tool vuole (0.10.0)
    for (const k of ["E", "N"]) { const c = rows[r].findIndex((h) => headerKey(h) === k && PALO_XY.test(hnorm(h))); if (c >= 0) map[k] = c; }
    // «Blocco» accanto a un'altra colonna della fondazione (estrazione Satferr: nome del blocco del DWG): è il
    // nome del blocco, la fondazione è l'altra (0.11.0)
    const isBlk = (c) => hnorm(rows[r][c]) === "blocco";
    if (map.found != null && isBlk(map.found)) {
      const o = rows[r].findIndex((h, j) => j !== map.found && headerKey(h) === "found");
      if (o >= 0 || map.found2 != null) { map.block = map.found; if (o >= 0) map.found = o; else delete map.found; }
    }
    const n = Object.keys(map).length;
    if (n > best.n) best = { row: r, n, map };
  }
  return best;
}
/* valori: numeri con la virgola, millimetri riconosciuti dalla grandezza */
/* «2,25» «2.25» «1.234,5» «2250»: con la virgola, i punti sono migliaia */
const numOf = (v) => { const t = String(v == null ? "" : v).trim().replace(/\s/g, ""); if (!t) return NaN; return Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t); };
const meters = (v, mmOver) => { const x = numOf(v); return Number.isFinite(x) ? (Math.abs(x) > mmOver ? x / 1000 : x) : NaN; };
export function staOf(v) {
  const t = String(v == null ? "" : v).trim().replace(/\s/g, "");
  const m = t.match(/^(-?)(\d+)\+(\d+(?:[.,]\d*)?)$/);
  if (m) return (m[1] ? -1 : 1) * (+m[2] * 1000 + +m[3].replace(",", "."));
  return numOf(t);
}
export function sideOf(v) {
  const t = hnorm(v);
  if (/^(s|sx|sin|sinistra|sinistro|l|left|lt|\+1|1)$/.test(t)) return 1;
  if (/^(d|dx|des|destra|destro|r|right|rt|-1)$/.test(t)) return -1;
  return 0;
}
export function mastOf(v) { const m = String(v == null ? "" : v).match(/LSU\s*-?\s*(\d{2})\s*([abc])/i); return m ? "LSU" + m[1] + m[2].toLowerCase() : null; }
/* un portale nella colonna del tipo (pilone PO, travi MEC, «portale»; blocchi Satferr PO_… / TRAVE_MEC …) */
export const isPortalText = (v) => /portal|pilone|(^|[^a-z0-9])PO([^a-z0-9]|$)|\bMEC\b|TRAVE[ _]MEC/i.test(String(v == null ? "" : v));
/* che sostegno dice il testo (blocco, tipologia, tipo di palo) di un portale o di un palo (0.11.0):
   { up: "PO" | "MEC" | "LSU" | null, mast: "LSU22b" | null (senza altezza: b), dbl: pali doppi }.
   PO_… (blocchi Satferr PO_1_BIN, PO_2_BIN, PO_VARIABILE) → pilone PO; «PILONE» (MEC) → pilone MEC; LSUnn →
   pali LSU, doppi con «(2+2)», «2x LSU», «doppio», singoli con «(1+1)» (vince sulla «2x» del tipo di palo:
   «TIPO TN 18÷26 - (1+1) LSU22-TN» col tipo «2xLSU22-TN» = un palo per parte) */
export function portalSpec(text) {
  const t = String(text == null ? "" : text);
  const lsu = /LSU\s*-?\s*(\d{2})\s*([abc])?(?![0-9])/i.exec(t);
  const one = /\(\s*1\s*\+\s*1\s*\)/.test(t), dbl = !one && /\(\s*2\s*\+\s*2\s*\)|(^|[^0-9])2\s*x\s*LSU|doppi/i.test(t);
  const up = /(^|[^a-z0-9])PO([^a-z0-9]|$)/i.test(t) ? "PO" : /pilone/i.test(t) ? "MEC" : lsu ? "LSU" : null;
  return { up, mast: lsu ? "LSU" + lsu[1] + (lsu[2] || "b").toLowerCase() : null, dbl: up === "LSU" && dbl };
}
/* righe → sostegni: { row, num, num2, sta, E, N, xy, E2, N2, xy2, side, dr, mast, dbl, portal, spec, Lb, L, L2,
   found, hw, stag, track, attrs, warn: [] }. portal = due coppie di coordinate (o, senza, un tipo da portale: si
   salta). opt.masts / opt.founds = codici del catalogo (il modulo non lo importa); opt.swap = E e N scambiate */
export function tableRecords(rows, head, map, opt = {}) {
  const masts = new Set(opt.masts || []), founds = new Map((opt.founds || []).map((f) => [f.toUpperCase(), f]));
  const used = new Set(Object.values(map).filter((c) => c != null && c >= 0));
  const hdr = rows[head] || [], out = [];
  for (let r = head + 1; r < rows.length; r++) {
    const row = rows[r], cell = (k) => (map[k] != null && map[k] >= 0 ? row[map[k]] : "");
    const warn = [], rec = { row: r + 1, num: String(cell("num") ?? "").trim(), num2: String(cell("num2") ?? "").trim(), sta: staOf(cell("sta")), side: sideOf(cell("side")), attrs: {}, warn };
    const e = numOf(cell("E")), n = numOf(cell("N")), e2 = numOf(cell("E2")), n2 = numOf(cell("N2"));
    rec.E = opt.swap ? n : e; rec.N = opt.swap ? e : n; rec.E2 = opt.swap ? n2 : e2; rec.N2 = opt.swap ? e2 : n2;
    rec.xy = Number.isFinite(rec.E) && Number.isFinite(rec.N);
    rec.xy2 = rec.xy && Number.isFinite(rec.E2) && Number.isFinite(rec.N2);
    if (!Number.isFinite(rec.sta) && !rec.xy) continue;     // righe senza progressiva né coordinate: titoli, totali, vuote
    rec.dr = meters(cell("dr"), 20);
    const ms = String(cell("mast") || "").trim(), blk = String(cell("block") || "").trim(), pt = String(cell("ptype") || "").trim();
    // il testo del tipo: blocco, tipologia, tipo di palo e le altre colonne «tipo …» non scelte («Tipo_palo doppio»)
    const more = row.map((v, c) => (!used.has(c) && /tipo/i.test(String(hdr[c] || "")) ? String(v).trim() : "")).filter(Boolean);
    const kind = [blk, pt, ms, ...more].filter(Boolean).join(" | ");
    rec.spec = portalSpec(kind);
    rec.mast = ms ? mastOf(ms) : null;
    rec.portal = rec.xy2 || (!rec.mast && isPortalText(kind));
    rec.dbl = !rec.portal && rec.spec.dbl;                  // palo doppio («PALO_DOPPIO_2xLSU», «2xLSU24»)
    if (!rec.portal && !rec.mast && rec.spec.up === "LSU" && (rec.dbl || !ms) && masts.has(rec.spec.mast)) rec.mast = rec.spec.mast;
    if (ms && !rec.portal && !(rec.mast && masts.has(rec.mast))) { warn.push("mast"); rec.mast = null; rec.attrs[hdr[map.mast] || "mast"] = ms; }
    if (blk) rec.attrs[String(hdr[map.block] || "").trim() || "block"] = blk;
    if (pt) rec.attrs[String(hdr[map.ptype] || "").trim() || "ptype"] = pt;
    if (rec.portal && ms) rec.attrs[String(hdr[map.mast] || "").trim() || "mast"] = ms;
    rec.L = meters(cell("L"), 100); rec.L2 = meters(cell("L2"), 100); rec.Lb = meters(cell("Lb"), 100);
    rec.sosp = String(cell("sosp") ?? "").trim(); rec.sosp2 = String(cell("sosp2") ?? "").trim();
    // fondazione: del primo montante, se non c'è (o non è del catalogo) del secondo; i testi restano negli attributi
    const fs = String(cell("found") || "").trim(), fs2 = String(cell("found2") || "").trim();
    rec.found = (fs && founds.get(fs.toUpperCase())) || (fs2 && founds.get(fs2.toUpperCase())) || null;
    if ((fs || fs2) && !rec.found) warn.push("found");
    if (fs && rec.found !== founds.get(fs.toUpperCase())) rec.attrs[hdr[map.found] || "found"] = fs;
    if (fs2 && rec.found !== founds.get(fs2.toUpperCase())) rec.attrs[hdr[map.found2] || "found2"] = fs2;
    rec.hw = meters(cell("hw"), 50); rec.stag = meters(cell("stag"), 5);
    rec.track = String(cell("track") ?? "").trim();
    row.forEach((v, c) => { if (!used.has(c) && String(v).trim() !== "" && String(hdr[c] || "").trim()) rec.attrs[String(hdr[c]).trim()] = String(v).trim(); });
    out.push(rec);
  }
  return out;
}
/* ---- dove vanno le righe (0.9.0) ----------------------------------------------------------------------------
   tracks = [{ name, s0, length, ix (ocs-core trackIndex) }]; opt = { track (indice del binario per le righe senza
   binario né coordinate), mastW(i, u, rec) → larghezza del fusto trasversale, e le tolleranze di XY_DEFAULTS }.
   Con le coordinate (asse del fusto): il binario della colonna o il più vicino, progressiva, lato e DR dalla
   proiezione; progressiva, DR e lato della tabella si confrontano. Senza: la progressiva sul binario della colonna
   o su quello scelto, come prima.
   → { ok: [{ i, rec, u, side, dr, xy, lat, warn }], skip: [{ rec, why, t, d }] }
   why: noTrack (binario della colonna sconosciuto), out (fuori dal binario), far (oltre maxD dal binario più
   vicino), portal (tipo da portale senza le due coppie di coordinate), between (portale senza binari caricati fra
   i montanti); warn: amb (un altro binario quasi alla stessa distanza), staDiff, drDiff, sideDiff, drRange.
   Portali (0.11.0, rec.xy2): { portal: true, i (binario di riferimento), u, side 1, fix: { qL, aL, qR, aR },
   span, drL, drR, served (indici dei binari fra i montanti), dr (la minore) }; warn in più: skew (montanti
   sfalsati lungo il binario oltre skewTol), spanDiff (luce diversa dalla «L trave» scritta oltre spanTol); la
   DR fuori misura conta solo sotto drMin (oltre i binari caricati il portale può scavalcarne altri).
   opt.portalW(rec) = larghezza dei montanti trasversale (di partenza 0,31 del pilone) */
export const XY_DEFAULTS = { maxD: 15, drMin: 1.5, drMax: 4.5, staTol: 0.5, drTol: 0.05, ambTol: 0.5, skewTol: 0.25, spanTol: 0.05 };
/* un portale dalle coordinate dei due montanti: binario di riferimento = fra quelli che passano FRA i due montanti,
   il più vicino al punto medio (o quello della colonna); progressiva = proiezione del punto medio; montanti nel
   riferimento del binario lì (q scostamento, a lungo il binario: la trave può essere obliqua) */
function placePortal(rec, tracks, ixs, named, o) {
  const A = [rec.E, rec.N], B = [rec.E2, rec.N2], M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
  const cand = [];
  ixs.forEach((ix, i) => {
    const pa = projectOn(ix, ...A), pb = projectOn(ix, ...B), pm = projectOn(ix, ...M);
    if (Math.abs(pm.along) <= 2 && Math.abs(pa.along) <= 2 && Math.abs(pb.along) <= 2 && Math.sign(pa.lat) !== Math.sign(pb.lat)) cand.push({ i, pm });
  });
  if (named >= 0 && !cand.some((c) => c.i === named)) return { skip: { rec, why: "out", t: tracks[named].name } };
  if (!cand.length) {
    const nt = nearestTracks(ixs, ...M)[0];
    return { skip: nt && Math.abs(nt.lat) <= o.maxD ? { rec, why: "between", t: tracks[nt.i].name } : { rec, why: "far", t: nt ? tracks[nt.i].name : "", d: nt ? Math.abs(nt.lat) : null } };
  }
  const ref = named >= 0 ? cand.find((c) => c.i === named) : cand.slice().sort((a, b) => Math.abs(a.pm.lat) - Math.abs(b.pm.lat))[0];
  const u = ref.pm.u, f = trackFrame(ixs[ref.i].T, u);
  const loc = (p) => ({ a: (p[0] - f.x) * f.tx + (p[1] - f.y) * f.ty, q: (p[0] - f.x) * f.nx + (p[1] - f.y) * f.ny });
  let L = loc(A), R = loc(B);
  if (L.q < R.q) [L, R] = [R, L];
  // i binari serviti nel riferimento del portale: il punto del binario sotto il punto medio
  const qs = cand.map((c) => { const g = trackFrame(ixs[c.i].T, c.pm.u); return (g.x - f.x) * f.nx + (g.y - f.y) * f.ny; });
  const w = o.portalW ? o.portalW(rec) : 0.31, top = Math.max(...qs), bot = Math.min(...qs);
  const drL = L.q - w / 2 - GAUGE_HALF - top, drR = bot - GAUGE_HALF - (R.q + w / 2), span = Math.hypot(L.q - R.q, L.a - R.a), warn = [];
  if (Math.abs(L.a - R.a) > o.skewTol) warn.push("skew");
  if (Number.isFinite(rec.Lb) && Math.abs(span - rec.Lb) > o.spanTol) warn.push("spanDiff");
  if (Number.isFinite(rec.sta) && Math.abs((tracks[ref.i].s0 || 0) + u - rec.sta) > o.staTol) warn.push("staDiff");
  if (Math.min(drL, drR) < o.drMin) warn.push("drRange");
  return { ok: { portal: true, i: ref.i, rec, u, side: 1, fix: { qL: L.q, aL: L.a, qR: R.q, aR: R.a }, span, drL, drR, dr: Math.min(drL, drR),
    served: cand.map((c) => c.i), xy: true, lat: null, warn } };
}
/* ---- i binari della tabella (0.21.0) ------------------------------------------------------------------------
   Richiesta dell'utente (2026-10-19): la tabella ha i pali di più binari, e si sceglie quali importare e su quale
   binario caricato va ciascuno. I valori della colonna del binario in ordine di comparsa: [{ k (minuscolo), v, n
   (righe), i (binario proposto o -1) }]; v "" = righe senza binario. Proposto: stesso nome, poi stesso nome senza
   separatori («PSPB1» = «PSP_B1»), poi l'unico binario il cui nome finisce coi pezzi del valore («B1» → «PSP_B1») */
const nameToks = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
export function trackGuess(v, tracks) {
  const lv = String(v).trim().toLowerCase(), a = nameToks(v);
  if (!lv) return -1;
  let i = tracks.findIndex((t) => t.name.toLowerCase() === lv);
  if (i < 0 && a.length) i = tracks.findIndex((t) => nameToks(t.name).join("") === a.join(""));
  if (i >= 0 || !a.length) return i;
  const hit = tracks.map((t, j) => { const b = nameToks(t.name); return b.length > a.length && a.every((x, k) => b[b.length - a.length + k] === x) ? j : -1; }).filter((j) => j >= 0);
  return hit.length === 1 ? hit[0] : -1;
}
export function tableTracks(recs, tracks) {
  const by = new Map();
  for (const r of recs) { const k = String(r.track || "").toLowerCase(), e = by.get(k); if (e) e.n++; else by.set(k, { k, v: r.track || "", n: 1 }); }
  return [...by.values()].map((e) => ({ ...e, i: trackGuess(e.v, tracks) }));
}
/* opt.trackMap = Map(k → scelta) per i valori della colonna del binario: indice del binario, -1 = non importare
   (why: off), -2 = come senza colonna (il più vicino dalle coordinate, altrimenti opt.track); valori assenti = il
   binario con quel nome, come prima */
export function placeRecords(recs, tracks, opt = {}) {
  const o = { ...XY_DEFAULTS, ...opt }, ok = [], skip = [], ixs = tracks.map((t) => t.ix);
  for (const rec of recs) {
    const pick = o.trackMap ? o.trackMap.get(String(rec.track || "").toLowerCase()) : undefined;
    if (pick === -1) { skip.push({ rec, why: "off", t: rec.track }); continue; }
    const named = pick >= 0 ? pick : pick === -2 ? -1 : rec.track ? tracks.findIndex((t) => t.name.toLowerCase() === rec.track.toLowerCase()) : -1;
    if (pick == null && rec.track && named < 0) { skip.push({ rec, why: "noTrack", t: rec.track }); continue; }
    if (rec.portal) {
      if (!rec.xy2) { skip.push({ rec, why: "portal" }); continue; }
      const r = placePortal(rec, tracks, ixs, named, o);
      if (r.skip) skip.push(r.skip); else ok.push(r.ok);
      continue;
    }
    if (!rec.xy) {
      const i = named >= 0 ? named : o.track, t = tracks[i];
      if (!t) { skip.push({ rec, why: "noTrack", t: rec.track || "" }); continue; }
      const u = rec.sta - t.s0;
      if (u < -0.01 || u > t.length + 0.01) { skip.push({ rec, why: "out", t: t.name }); continue; }
      ok.push({ i, rec, u: Math.max(0, Math.min(t.length, u)), side: rec.side, dr: rec.dr, xy: false, lat: null, warn: [] });
      continue;
    }
    let near = null, p;
    if (named >= 0) { const q = projectOn(ixs[named], rec.E, rec.N); p = Math.abs(q.along) <= 2 ? { i: named, ...q } : null; }
    else { near = nearestTracks(ixs, rec.E, rec.N); p = near[0] || null; }
    if (!p) { skip.push(named >= 0 ? { rec, why: "out", t: tracks[named].name } : { rec, why: "far", t: "", d: null }); continue; }
    const t = tracks[p.i], a = Math.abs(p.lat);
    if (a > o.maxD) { skip.push({ rec, why: "far", t: t.name, d: a }); continue; }
    const side = p.lat >= 0 ? 1 : -1, dr = drFromAxis(p.lat, o.mastW ? o.mastW(p.i, p.u, rec) : 0.4), warn = [];
    if (near && near[1] && Math.abs(near[1].lat) - a < o.ambTol) warn.push("amb");
    if (Number.isFinite(rec.sta) && Math.abs((t.s0 || 0) + p.u - rec.sta) > o.staTol) warn.push("staDiff");
    if (Number.isFinite(rec.dr) && Math.abs(dr - rec.dr) > o.drTol) warn.push("drDiff");
    if (rec.side && rec.side !== side) warn.push("sideDiff");
    if (dr < o.drMin || dr > o.drMax) warn.push("drRange");
    ok.push({ i: p.i, rec, u: p.u, side, dr, xy: true, lat: p.lat, warn });
  }
  return { ok, skip };
}
/* quante righe con le coordinate cadono entro maxD da un binario (al più le prime n): serve a capire se le
   colonne E e N sono scambiate */
export function countNear(recs, ixs, maxD = XY_DEFAULTS.maxD, n = 60) {
  let k = 0;
  for (const r of recs.filter((x) => x.xy).slice(0, n)) { const p = nearestTracks(ixs, r.E, r.N)[0]; if (p && Math.abs(p.lat) <= maxD) k++; }
  return k;
}

/* ---- IFC di contesto: gli elementi «uguali» per scegliere il supercompattato (0.7.0) -------------------------
   info di un elemento (letta dal Worker della pagina) = { id, cls, name, ot (ObjectType), layer, type (nome del
   tipo), props: { "Pset.Proprietà": valore } }. Un criterio = { k: "name" | "ot" | "layer" | "type" | "p:Pset.Prop",
   v }; «uguali» = stessa classe IFC e stesso valore. Negli IFC di Civil 3D del federato BG-PSP il nome è vuoto e
   il supercompattato si riconosce dai Pset («Materiale», «Nome») o dal layer: si propone il criterio il cui
   valore parla di supercompattato, e fra quelli il più largo */
export const stripRevitId = (s) => String(s == null ? "" : s).replace(/:\d+$/, "").trim();   // «Famiglia:Tipo:123456»
const critVal = (info, k) => (k === "name" ? stripRevitId(info.name) : k === "ot" ? stripRevitId(info.ot) : k === "layer" ? String(info.layer || "").trim()
  : k === "type" ? stripRevitId(info.type) : k.startsWith("p:") ? String((info.props || {})[k.slice(2)] ?? "").trim() : "");
/* i criteri possibili per un elemento: i campi non vuoti, nell'ordine nome, tipo, ObjectType, layer, poi i Pset */
export function elemCriteria(info) {
  if (!info) return [];
  const out = [];
  for (const k of ["name", "type", "ot", "layer", ...Object.keys(info.props || {}).map((p) => "p:" + p)]) { const v = critVal(info, k); if (v) out.push({ k, v }); }
  return out;
}
export const sameAs = (info, crit, cls) => !!info && !!crit && info.cls === cls && critVal(info, crit.k) === crit.v;
/* gli id degli elementi uguali a quello dato (lui compreso) in un elenco di info */
export const sameIds = (all, info, crit) => all.filter((x) => sameAs(x, crit, info.cls)).map((x) => x.id);
/* il criterio proposto: fra quelli che parlano di supercompattato il più largo (più elementi), altrimenti il
   primo che prende più di un elemento ma non tutti quelli della classe, altrimenti il primo */
export const SC_WORD = /supercompatt|super[\s_-]?compatt/i;
export function proposeCriterion(info, all) {
  const cs = elemCriteria(info);
  if (!cs.length) return null;
  const n = (c) => all.reduce((a, x) => a + (sameAs(x, c, info.cls) ? 1 : 0), 0), nCls = all.filter((x) => x.cls === info.cls).length;
  const sc = cs.filter((c) => SC_WORD.test(c.v));
  if (sc.length) return sc.map((c) => ({ c, n: n(c) })).sort((a, b) => b.n - a.n)[0].c;
  return cs.find((c) => { const m = n(c); return m > 1 && m < nCls; }) || cs[0];
}

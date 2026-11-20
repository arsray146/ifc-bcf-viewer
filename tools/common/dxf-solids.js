/* =========================================================================
   Solidi in DXF — modulo comune (1.1.0)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Il DWG non si scrive nel browser (LibreDWG del vendor è compilato senza
   scrittura): si scrive un DXF R2000 (AC1015) con SOLIDI VERI (3DSOLID), che
   AutoCAD e Civil 3D aprono così come sono; «Salva con nome» lo fa DWG.
   - Un 3DSOLID porta il corpo in SAT ACIS 4.0 (testo cifrato carattere per
     carattere, 159 − codice; «^» si scrive «^ »), come lo scrive AutoCAD 2027
     in un DXF R2000: body → lump → shell → face → loop → coedge → edge →
     vertex → point, superfici plane-surface e lati straight-curve. Geometria
     attorno al centro del solido + transform (come AutoCAD per i solidi
     lontani dall'origine: le coordinate di mappa non mangiano le cifre).
   - solidSAT: da una mesh chiusa (triangoli o poligoni piani, antiorari visti
     da fuori) a un corpo a facce piane; triangoli complanari vicini uniti in
     un poligono (anche coi buchi), triangoli degeneri (tre punti in fila,
     dai tappi) assorbiti dalla faccia oltre il loro lato lungo.
   - dxfSolids: layer, blocchi (definizioni con solidi), entità 3DSOLID e
     INSERT orientati nello spazio (normale + rotazione: algoritmo dell'asse
     arbitrario), XDATA per i dati (Pset) su ogni oggetto; dalla 1.1.0 anche
     POINT e POLYLINE 3D (assi, oggetti che portano solo dati: progetto, sito).
   Collaudo (2026-11-16, AutoCAD 2027 via accoreconsole): rotaie, traverse,
   intasi e ballast «valid ShapeManager solid», volumi di MASSPROP uguali al
   motore, AUDIT senza errori, salvataggio in DWG 2018.
   ========================================================================= */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const n = norm(a); return [a[0] / n, a[1] / n, a[2] / n]; };

/**
 * Corpo SAT (ACIS 4.0) di un solido chiuso a facce piane.
 * mesh = { pos: [x, y, z, …] piatto, idx?: triangoli piatti, faces?: [[i, …], …] poligoni piani } (antiorari visti
 * da fuori); opt.origin = [x, y, z] (di partenza il centro del riquadro, in metri tondi); opt.tolPlane (m).
 * → { lines (righe SAT in chiaro), nFaces, nRec, warn: [testi], origin, vol (dalle facce) }
 */
export function solidSAT(mesh, opt = {}) {
  const pos = mesh.pos, tolPlane = opt.tolPlane || 5e-7;
  // 1. punti saldati (stessa posizione entro 1e-7)
  const map = new Map(), P = [], remap = new Int32Array(pos.length / 3);
  for (let i = 0; i < pos.length / 3; i++) {
    const k = Math.round(pos[3 * i] * 1e7) + "," + Math.round(pos[3 * i + 1] * 1e7) + "," + Math.round(pos[3 * i + 2] * 1e7);
    let j = map.get(k);
    if (j == null) { j = P.length; map.set(k, j); P.push([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]); }
    remap[i] = j;
  }
  let F = [];
  if (mesh.faces) F = mesh.faces.map((f) => Array.from(f, (i) => remap[i]));
  else for (let i = 0; i < mesh.idx.length; i += 3) F.push([remap[mesh.idx[i]], remap[mesh.idx[i + 1]], remap[mesh.idx[i + 2]]]);
  F = F.map((f) => f.filter((v, k) => v !== f[(k + 1) % f.length])).filter((f) => f.length >= 3);
  let O = opt.origin;
  if (!O) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of P) for (let j = 0; j < 3; j++) { if (p[j] < lo[j]) lo[j] = p[j]; if (p[j] > hi[j]) hi[j] = p[j]; }
    O = lo.map((v, j) => Math.round((v + hi[j]) / 2));
  }
  const Q = P.map((p) => sub(p, O));
  const warn = new Set();
  // 2. normale (Newell) e area delle facce
  const newell = (f) => {
    const n = [0, 0, 0];
    for (let k = 0; k < f.length; k++) {
      const a = Q[f[k]], b = Q[f[(k + 1) % f.length]];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return n;
  };
  const N = F.map(newell);
  const longest = (f) => { let L = 0, k0 = 0; for (let k = 0; k < f.length; k++) { const l = norm(sub(Q[f[k]], Q[f[(k + 1) % f.length]])); if (l > L) { L = l; k0 = k; } } return { L, k: k0 }; };
  const deg = F.map((f, i) => norm(N[i]) / 2 < 1e-9 * Math.max(longest(f).L, 1e-9));
  // 3. lato orientato → faccia
  const ek = (a, b) => a * 1048576 * 64 + b;   // fino a 64 M vertici
  const edgeFace = new Map();
  F.forEach((f, i) => { for (let k = 0; k < f.length; k++) { const e = ek(f[k], f[(k + 1) % f.length]); if (edgeFace.has(e)) warn.add("lato doppio"); edgeFace.set(e, i); } });
  for (const e of edgeFace.keys()) { const a = Math.floor(e / (1048576 * 64)), b = e - a * 1048576 * 64; if (!edgeFace.has(ek(b, a))) { warn.add("mesh aperta"); break; } }
  // 4. gruppi complanari: le facce vere si allargano ai vicini sullo stesso piano; i degeneri vanno col vicino oltre
  //    il loro lato più lungo (lì il contorno guadagna il punto in mezzo: resta un poligono semplice)
  const grp = new Int32Array(F.length).fill(-1);
  for (let s = 0; s < F.length; s++) {
    if (grp[s] >= 0 || deg[s]) continue;
    grp[s] = s;
    const n0 = unit(N[s]), p0 = Q[F[s][0]], stack = [s];
    while (stack.length) {
      const f = F[stack.pop()];
      for (let k = 0; k < f.length; k++) {
        const j = edgeFace.get(ek(f[(k + 1) % f.length], f[k]));
        if (j == null || grp[j] >= 0 || deg[j]) continue;
        if (dot(n0, unit(N[j])) > 1 - 1e-10 && F[j].every((v) => Math.abs(dot(sub(Q[v], p0), n0)) < tolPlane)) { grp[j] = s; stack.push(j); }
      }
    }
  }
  for (let pass = 0, left = 1; left && pass < 20; pass++) {
    left = 0;
    F.forEach((f, i) => {
      if (!deg[i] || grp[i] >= 0) return;
      const { k } = longest(f), j = edgeFace.get(ek(f[(k + 1) % f.length], f[k]));
      if (j == null) return;
      if (grp[j] < 0) { left++; return; }
      grp[i] = grp[j];
    });
  }
  // 5. contorni dei gruppi: i lati di bordo concatenati; esterno antiorario, buchi orari
  const groups = new Map();
  F.forEach((_, i) => { if (grp[i] < 0) { warn.add("faccia degenere isolata"); return; } if (!groups.has(grp[i])) groups.set(grp[i], []); groups.get(grp[i]).push(i); });
  const faces = [];   // { n, loops }
  for (const [g, members] of groups) {
    const n = unit(N[g]);
    if (members.length === 1) { faces.push({ n, loops: [F[g]] }); continue; }
    const inG = new Set(members), next = new Map();
    let bad = false;
    for (const i of members) {
      const f = F[i];
      for (let k = 0; k < f.length; k++) {
        const a = f[k], b = f[(k + 1) % f.length], j = edgeFace.get(ek(b, a));
        if (j != null && inG.has(j)) continue;
        if (next.has(a)) bad = true;
        next.set(a, b);
      }
    }
    const loops = [], used = new Set();
    if (!bad) for (const a0 of next.keys()) {
      if (used.has(a0)) continue;
      const L = [];
      let a = a0;
      while (a != null && !used.has(a)) { used.add(a); L.push(a); a = next.get(a); }
      if (a !== a0) { bad = true; break; }
      loops.push(L);
    }
    const area = (L) => dot(newell(L), n) / 2;
    if (!bad && loops.filter((L) => area(L) > 0).length === 1) { loops.sort((a, b) => area(b) - area(a)); faces.push({ n, loops }); continue; }
    // contorno pizzicato o ambiguo: le facce del gruppo una per una (i degeneri si perdono: lo dice warn)
    warn.add("gruppo lasciato a triangoli");
    for (const i of members) if (!deg[i]) faces.push({ n: unit(N[i]), loops: [F[i]] }); else warn.add("faccia degenere persa");
  }
  // 6. record SAT (i puntatori sono indici dei record)
  const R = [];
  const rec = (s = null) => { R.push(s); return R.length - 1; };
  // numeri corti (il SAT è quasi tutto numeri): punti a 1e-8 m (attorno all'origine del solido), direzioni a 1e-12 —
  // ben dentro la tolleranza di ACIS (1e-6); niente esponenti
  const fmt = (v, d) => { const r = Math.round(v * 10 ** d) / 10 ** d; if (r === 0) return "0"; const s = String(r); return s.includes("e") ? r.toFixed(d).replace(/\.?0+$/, "") : s; };
  const v3 = (p) => fmt(p[0], 8) + " " + fmt(p[1], 8) + " " + fmt(p[2], 8);
  const d3 = (p) => fmt(p[0], 12) + " " + fmt(p[1], 12) + " " + fmt(p[2], 12);
  const body = rec(), lump = rec(), tr = rec(), shell = rec();
  const vtx = new Map(), edges = new Map(), faceRecs = [];
  let vol = 0;
  for (const f of faces) {
    const face = rec(), surf = rec(), L0 = f.loops[0];
    let u = sub(Q[L0[1]], Q[L0[0]]);
    u = unit(sub(u, f.n.map((c) => c * dot(u, f.n))));
    // radice del piano: la media dei punti del contorno esterno portata sul piano (per il primo punto, normale n)
    const c = [0, 0, 0];
    for (const v of L0) for (let j = 0; j < 3; j++) c[j] += Q[v][j] / L0.length;
    const off = dot(sub(c, Q[L0[0]]), f.n);
    for (let j = 0; j < 3; j++) c[j] -= off * f.n[j];
    R[surf] = `plane-surface $-1 ${v3(c)} ${d3(f.n)} ${d3(u)} forward_v I I I I #`;
    const lr = [];
    for (const L of f.loops) {
      vol += dot(c, f.n) * dot(newell(L), f.n) / 2 / 3;   // divergenza: Σ (c·n) A / 3
      const loop = rec(), co = [];
      for (let k = 0; k < L.length; k++) {
        const a = L[k], b = L[(k + 1) % L.length], ce = rec(), lo = Math.min(a, b), hi = Math.max(a, b), kk = lo * 1048576 * 64 + hi;
        let E = edges.get(kk);
        if (!E) edges.set(kk, (E = { rec: rec(), a: lo, b: hi, co: [] }));
        E.co.push(ce);
        co.push({ ce, E, sense: a === lo ? "forward" : "reversed", loop });
      }
      lr.push({ loop, co });
    }
    lr.forEach((l, k) => { R[l.loop] = `loop $-1 $${k + 1 < lr.length ? lr[k + 1].loop : -1} $${l.co[0].ce} $${face} #`; });
    faceRecs.push({ face, lr });
  }
  const partner = new Map();
  for (const E of edges.values()) {
    if (E.co.length !== 2) warn.add("lato con " + E.co.length + " facce");
    partner.set(E.co[0], E.co[1] != null ? E.co[1] : -1); if (E.co[1] != null) partner.set(E.co[1], E.co[0]);
  }
  for (const f of faceRecs) for (const l of f.lr) l.co.forEach((x, k) => {
    const nx = l.co[(k + 1) % l.co.length].ce, pv = l.co[(k - 1 + l.co.length) % l.co.length].ce;
    R[x.ce] = `coedge $-1 $${nx} $${pv} $${partner.get(x.ce)} $${x.E.rec} ${x.sense} $${x.loop} $-1 #`;
  });
  const vRec = (v, e) => {
    let r = vtx.get(v);
    if (r == null) { r = rec(); const p = rec(`point $-1 ${v3(Q[v])} #`); R[r] = `vertex $-1 $${e} $${p} #`; vtx.set(v, r); }
    return r;
  };
  for (const E of edges.values()) {
    const va = vRec(E.a, E.rec), vb = vRec(E.b, E.rec);
    const cv = rec(`straight-curve $-1 ${v3(Q[E.a])} ${d3(unit(sub(Q[E.b], Q[E.a])))} I I #`);
    R[E.rec] = `edge $-1 $${va} $${vb} $${E.co[0]} $${cv} forward #`;
  }
  // (la superficie è il record subito dopo la faccia)
  faceRecs.forEach((f, k) => { R[f.face] = `face $-1 $${k + 1 < faceRecs.length ? faceRecs[k + 1].face : -1} $${f.lr[0].loop} $${shell} $-1 $${f.face + 1} forward single #`; });
  R[body] = `body $-1 $${lump} $-1 $${tr} #`;
  R[lump] = `lump $-1 $-1 $${shell} $${body} #`;
  R[tr] = `transform $-1 1 0 0 0 1 0 0 0 1 ${v3(O)} 1 no_rotate no_reflect no_shear #`;
  R[shell] = `shell $-1 $-1 $-1 $${faceRecs.length ? faceRecs[0].face : -1} $-1 $${lump} #`;
  const prod = "viewifc.com", ver = "ACIS 4.0 NT";
  const lines = [`400 ${R.length} 1 0`, `${prod.length} ${prod} ${ver.length} ${ver} 0`, "1 9.9999999999999995e-07 1e-10", ...R];
  return { lines, nFaces: faces.length, nRec: R.length, warn: [...warn], origin: O, vol };
}

/** righe SAT → coppie [codice, testo] del DXF: 1 = riga, 3 = seguito oltre 255 caratteri; cifrate come AutoCAD */
export function satGroups(lines) {
  const out = [];
  for (const line of lines) {
    let cur = "", first = true;
    for (const ch of line) {
      let t = ch === " " ? " " : String.fromCharCode(159 - ch.charCodeAt(0));
      if (t === "^") t = "^ ";
      if (cur.length + t.length > 255) { out.push([first ? 1 : 3, cur]); first = false; cur = ""; }
      cur += t;
    }
    out.push([first ? 1 : 3, cur]);
  }
  return out;
}
/** il contrario (per i test): coppie DXF di un 3DSOLID → righe SAT in chiaro */
export function satDecode(groups) {
  const lines = [];
  for (const [c, v] of groups) {
    let s = "";
    for (let i = 0; i < v.length; i++) {
      const ch = v[i];
      if (ch === "^" && v[i + 1] === " ") { s += "A"; i++; continue; }
      s += ch === " " ? " " : String.fromCharCode(159 - ch.charCodeAt(0));
    }
    if (+c === 1) lines.push(s); else lines[lines.length - 1] += s;
  }
  return lines;
}

/* testo DXF R2000 (non UTF-8): i caratteri fuori dall'ASCII diventano \U+XXXX */
export const dxfText = (s) => String(s).replace(/[^\x20-\x7e]/g, (c) => "\\U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"));
/* nome di layer o blocco: niente caratteri vietati da AutoCAD */
export const dxfName = (s) => dxfText(String(s).replace(/[<>/\\":;?*|=,`]/g, "_").trim() || "_");
const full = (v) => { const r = Math.abs(v) < 1e-14 ? 0 : v; return Number.isInteger(r) ? r.toFixed(1) : String(r); };

/* OCS di una normale (algoritmo dell'asse arbitrario di AutoCAD) */
export function ocsAxes(n) {
  const N = unit(n), Ax = unit(Math.abs(N[0]) < 1 / 64 && Math.abs(N[1]) < 1 / 64 ? cross([0, 1, 0], N) : cross([0, 0, 1], N));
  return { N, Ax, Ay: cross(N, Ax) };
}

/**
 * DXF R2000 coi solidi. w = dxfSolids({ insunits }) →
 *   w.layer(name, color ACI) · w.appid(name) · w.block(name, ents) (entità nel riferimento del blocco)
 *   w.model.push(entità) · w.toString()
 * entità: { t: "3dsolid", sat: righe SAT, layer, color?, xdata? }
 *         { t: "insert", block, o: [x, y, z], x: asse x del blocco, z: asse z (unitari, ortogonali), layer, xdata? }
 *         { t: "point", p: [x, y, z], layer, xdata? } · { t: "polyline3d", pts: [[x, y, z], …], layer, xdata? } (1.1.0)
 * xdata: [{ app, items: [[codice, valore], …] }] (1000 testo, 1002 «{»/«}», 1040 reale, 1070 / 1071 interi)
 */
export function dxfSolids({ insunits = 6 } = {}) {
  const layers = [{ name: "0", color: 7 }], apps = ["ACAD"], blocks = [], model = [];
  return {
    model,
    layer(name, color = 7) { const n = dxfName(name); if (!layers.some((l) => l.name === n)) layers.push({ name: n, color }); return n; },
    appid(name) { if (!apps.includes(name)) apps.push(name); return name; },
    block(name, ents) { const n = dxfName(name); if (!blocks.some((b) => b.name === n)) blocks.push({ name: n, ents }); return n; },
    /* il DXF a pezzi (stringhe da ~1 MB, per un Blob: un file da centinaia di MB non sta in una stringa sola) */
    parts() { return emit(); },
    toString() { return emit().join(""); },
  };

  function emit() {
    let hnd = 0x20;
    const H = () => (hnd++).toString(16).toUpperCase();
    let out = [];
    const chunks = [], flush = () => { if (out.length) chunks.push(out.join("\r\n") + "\r\n"); out = []; };
    const g = (c, v) => { out.push(String(c), typeof v === "number" ? full(v) : String(v)); if (out.length > 100000) flush(); };
    const gi = (c, v) => { out.push(String(c), String(Math.round(v))); };
    const hRoot = H(), hGroups = H(), hLayouts = H(), hPsn = H(), hNormal = H();
    const hTbl = {};
    for (const t of ["VPORT", "LTYPE", "LAYER", "STYLE", "VIEW", "UCS", "APPID", "DIMSTYLE", "BLOCK_RECORD"]) hTbl[t] = H();
    const spaces = [{ name: "*Model_Space", layout: "Model", ents: model }, { name: "*Paper_Space", layout: "Layout1", ents: [], ps: true }];
    for (const b of [...spaces, ...blocks]) { b.hRec = H(); b.hBlk = H(); b.hEnd = H(); if (b.layout) b.hLay = H(); }
    // riquadro del modello (origini dei solidi e punti d'inserimento) per la vista d'apertura
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const e of model) for (const p of e.t === "insert" ? [e.o] : e.t === "point" ? [e.p] : e.t === "polyline3d" ? e.pts : [e.origin]) if (p) for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], p[j]); hi[j] = Math.max(hi[j], p[j]); }
    if (!(lo[0] <= hi[0])) { lo.fill(0); hi.fill(100); }

    g(0, "SECTION"); g(2, "HEADER");
    g(9, "$ACADVER"); g(1, "AC1015"); g(9, "$ACADMAINTVER"); gi(70, 6); g(9, "$DWGCODEPAGE"); g(3, "ANSI_1252");
    g(9, "$INSBASE"); g(10, 0); g(20, 0); g(30, 0);
    g(9, "$EXTMIN"); g(10, lo[0]); g(20, lo[1]); g(30, lo[2]); g(9, "$EXTMAX"); g(10, hi[0]); g(20, hi[1]); g(30, hi[2]);
    g(9, "$CLAYER"); g(8, "0"); g(9, "$INSUNITS"); gi(70, insunits); g(9, "$MEASUREMENT"); gi(70, 1);
    g(9, "$HANDSEED"); g(5, "~HANDSEED~");
    g(0, "ENDSEC");
    g(0, "SECTION"); g(2, "CLASSES"); g(0, "ENDSEC");

    g(0, "SECTION"); g(2, "TABLES");
    const table = (name, n, body, dim = false) => {
      g(0, "TABLE"); g(2, name); g(5, hTbl[name]); g(330, "0"); g(100, "AcDbSymbolTable"); gi(70, n);
      if (dim) g(100, "AcDbDimStyleTable");
      body(); g(0, "ENDTAB");
    };
    const rec = (type, sub, name, codeH = 5) => { g(0, type); g(codeH, H()); g(330, hTbl[type]); g(100, "AcDbSymbolTableRecord"); g(100, sub); g(2, name); gi(70, 0); };
    table("VPORT", 1, () => {
      rec("VPORT", "AcDbViewportTableRecord", "*Active");
      g(10, 0); g(20, 0); g(11, 1); g(21, 1); g(12, (lo[0] + hi[0]) / 2); g(22, (lo[1] + hi[1]) / 2);
      g(13, 0); g(23, 0); g(14, 1); g(24, 1); g(15, 10); g(25, 10); g(16, 0); g(26, 0); g(36, 1); g(17, 0); g(27, 0); g(37, 0);
      g(40, Math.max(hi[1] - lo[1], (hi[0] - lo[0]) / 1.8, 10) * 1.1); g(41, 1.8); g(42, 50); g(43, 0); g(44, 0); g(50, 0); g(51, 0);
      gi(71, 0); gi(72, 1000); gi(73, 1); gi(74, 3); gi(75, 0); gi(76, 0); gi(77, 0); gi(78, 0);
      gi(281, 0); gi(65, 1); g(110, 0); g(120, 0); g(130, 0); g(111, 1); g(121, 0); g(131, 0); g(112, 0); g(122, 1); g(132, 0); gi(79, 0); g(146, 0);
    });
    table("LTYPE", 3, () => {
      for (const [n, d] of [["ByBlock", ""], ["ByLayer", ""], ["Continuous", "Solid line"]]) { rec("LTYPE", "AcDbLinetypeTableRecord", n); g(3, d); gi(72, 65); gi(73, 0); g(40, 0); }
    });
    table("LAYER", layers.length, () => {
      for (const l of layers) { rec("LAYER", "AcDbLayerTableRecord", l.name); gi(62, l.color); g(6, "Continuous"); gi(370, -3); g(390, hNormal); }
    });
    table("STYLE", 1, () => { rec("STYLE", "AcDbTextStyleTableRecord", "Standard"); g(40, 0); g(41, 1); g(50, 0); gi(71, 0); g(42, 2.5); g(3, "txt"); g(4, ""); });
    table("VIEW", 0, () => {});
    table("UCS", 0, () => {});
    table("APPID", apps.length, () => { for (const a of apps) rec("APPID", "AcDbRegAppTableRecord", a); });
    table("DIMSTYLE", 1, () => rec("DIMSTYLE", "AcDbDimStyleTableRecord", "Standard", 105), true);
    table("BLOCK_RECORD", spaces.length + blocks.length, () => {
      for (const b of [...spaces, ...blocks]) {
        g(0, "BLOCK_RECORD"); g(5, b.hRec); g(330, hTbl.BLOCK_RECORD); g(100, "AcDbSymbolTableRecord"); g(100, "AcDbBlockTableRecord");
        g(2, b.name); g(340, b.hLay || "0"); gi(70, b.layout ? 0 : insunits); gi(280, 1); gi(281, 0);
      }
    });
    g(0, "ENDSEC");

    g(0, "SECTION"); g(2, "BLOCKS");
    for (const b of [...spaces, ...blocks]) {
      g(0, "BLOCK"); g(5, b.hBlk); g(330, b.hRec); g(100, "AcDbEntity"); if (b.ps) gi(67, 1); g(8, "0"); g(100, "AcDbBlockBegin");
      g(2, b.name); gi(70, 0); g(10, 0); g(20, 0); g(30, 0); g(3, b.name); g(1, "");
      if (!b.layout) for (const e of b.ents) entity(e, b);
      g(0, "ENDBLK"); g(5, b.hEnd); g(330, b.hRec); g(100, "AcDbEntity"); if (b.ps) gi(67, 1); g(8, "0"); g(100, "AcDbBlockEnd");
    }
    g(0, "ENDSEC");
    g(0, "SECTION"); g(2, "ENTITIES");
    for (const e of model) entity(e, spaces[0]);
    g(0, "ENDSEC");

    g(0, "SECTION"); g(2, "OBJECTS");
    g(0, "DICTIONARY"); g(5, hRoot); g(330, "0"); g(100, "AcDbDictionary"); gi(281, 1);
    g(3, "ACAD_GROUP"); g(350, hGroups); g(3, "ACAD_LAYOUT"); g(350, hLayouts); g(3, "ACAD_PLOTSTYLENAME"); g(350, hPsn);
    const sub = (h) => { g(0, "DICTIONARY"); g(5, h); g(102, "{ACAD_REACTORS"); g(330, hRoot); g(102, "}"); g(330, hRoot); g(100, "AcDbDictionary"); gi(281, 1); };
    sub(hGroups);
    sub(hLayouts); for (const b of spaces) { g(3, b.layout); g(350, b.hLay); }
    g(0, "ACDBDICTIONARYWDFLT"); g(5, hPsn); g(102, "{ACAD_REACTORS"); g(330, hRoot); g(102, "}"); g(330, hRoot); g(100, "AcDbDictionary"); gi(281, 1);
    g(3, "Normal"); g(350, hNormal); g(100, "AcDbDictionaryWithDefault"); g(340, hNormal);
    g(0, "ACDBPLACEHOLDER"); g(5, hNormal); g(102, "{ACAD_REACTORS"); g(330, hPsn); g(102, "}"); g(330, hPsn);
    spaces.forEach((b, i) => {
      g(0, "LAYOUT"); g(5, b.hLay); g(102, "{ACAD_REACTORS"); g(330, hLayouts); g(102, "}"); g(330, hLayouts);
      g(100, "AcDbPlotSettings"); g(1, ""); g(2, "none_device"); g(4, ""); g(6, "");
      g(40, 0); g(41, 0); g(42, 0); g(43, 0); g(44, 420); g(45, 297); g(46, 0); g(47, 0); g(48, 0); g(49, 0); g(140, 0); g(141, 0);
      g(142, 1); g(143, 1); gi(70, b.ps ? 640 : 1712); gi(72, 1); gi(73, 0); gi(74, b.ps ? 5 : 0); g(7, ""); gi(75, b.ps ? 16 : 0); g(147, 1); g(148, 0); g(149, 0);
      g(100, "AcDbLayout"); g(1, b.layout); gi(70, 0); gi(71, i);
      g(10, 0); g(20, 0); g(11, 420); g(21, 297); g(12, 0); g(22, 0); g(32, 0);
      g(14, 0); g(24, 0); g(34, 0); g(15, 420); g(25, 297); g(35, 0); g(146, 0);
      g(13, 0); g(23, 0); g(33, 0); g(16, 1); g(26, 0); g(36, 0); g(17, 0); g(27, 1); g(37, 0); gi(76, 0);
      g(330, b.hRec);
    });
    g(0, "ENDSEC");
    g(0, "EOF");
    flush();
    chunks[0] = chunks[0].replace("~HANDSEED~", (hnd + 0x100).toString(16).toUpperCase());   // l'intestazione sta nel primo pezzo
    return chunks;

    function head(type, e, b, subclass) {
      const h = H();
      g(0, type); g(5, h); g(330, b.hRec); g(100, "AcDbEntity"); g(8, e.layer || "0");
      if (e.color != null) gi(62, e.color);
      g(100, subclass);
      return h;
    }
    function xdata(e) {
      for (const x of e.xdata || []) {
        g(1001, x.app);
        for (const [c, v] of x.items) {
          if (c === 1000) g(1000, dxfText(String(v)).slice(0, 255));
          else if (c === 1002) g(1002, v);
          else if (c === 1070 || c === 1071) gi(c, v);
          else g(c, v);
        }
      }
    }
    function entity(e, b) {
      if (e.t === "3dsolid") {
        head("3DSOLID", e, b, "AcDbModelerGeometry"); gi(70, 1);
        for (const [c, v] of satGroups(e.sat)) g(c, v);
      } else if (e.t === "insert") {
        const { N, Ax, Ay } = ocsAxes(e.z), rot = Math.atan2(dot(e.x, Ay), dot(e.x, Ax)) * 180 / Math.PI;
        head("INSERT", e, b, "AcDbBlockReference"); g(2, dxfName(e.block));
        g(10, dot(e.o, Ax)); g(20, dot(e.o, Ay)); g(30, dot(e.o, N));
        if (e.s) { g(41, e.s[0]); g(42, e.s[1]); g(43, e.s[2]); }
        if (Math.abs(rot) > 1e-12) g(50, rot);
        g(210, N[0]); g(220, N[1]); g(230, N[2]);
      } else if (e.t === "point") {
        head("POINT", e, b, "AcDbPoint"); g(10, e.p[0]); g(20, e.p[1]); g(30, e.p[2]);
      } else if (e.t === "polyline3d") {
        // POLYLINE 3D: i dati sulla polilinea (prima dei VERTEX), poi i vertici e SEQEND posseduti da lei
        const h = head("POLYLINE", e, b, "AcDb3dPolyline"); gi(66, 1); g(10, 0); g(20, 0); g(30, 0); gi(70, 8);
        xdata(e);
        for (const p of e.pts) {
          g(0, "VERTEX"); g(5, H()); g(330, h); g(100, "AcDbEntity"); g(8, e.layer || "0"); g(100, "AcDbVertex"); g(100, "AcDb3dPolylineVertex");
          g(10, p[0]); g(20, p[1]); g(30, p[2]); gi(70, 32);
        }
        g(0, "SEQEND"); g(5, H()); g(330, h); g(100, "AcDbEntity"); g(8, e.layer || "0");
        return;
      }
      xdata(e);
    }
  }
}

/* =========================================================================
   Trazione elettrica (Railway OCS) — famiglie RFI del catalogo Revit (tool 18, 0.17.0)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   La geometria delle famiglie Revit del catalogo RFI dell'utente, rifatta in JS dagli
   STESSI generatori (sessione 18: 18.REVIT MCP\famiglie\…\genera.py e _lib_rfi.py,
   commit a58f2f2 del 2026-10-15) con le stesse tabelle e le stesse forme, così la
   vista 3D e l'IFC del sito coincidono con quello che l'add-in ViewIFC piazza in
   Revit (PIANO_Trazione_Elettrica.md §23). Scelte dell'utente (2026-10-15):
   generatori in JS, tutto pubblico, forma dalle famiglie e quote dal tool.
   - pali: RFI_Sostegno_LSU14-16 / _LSU18-22 = plinto RFI_Plinto_LSU (tipo = la
     fondazione del tool, C1 del tool), palo RFI_Palo_LSUnnx (piastra 90 mm sopra
     il pilastrino, 2 UPN, fazzoletti, traliccio di tondi piegati, tirafondi e
     dima), attacco della mensola RFI_AttaccoMensola_E66013_<serie>, staffa del
     tirante RFI_AttaccoTirante_E66013_<serie>, mensola RFI_Mensola_D76x5 (tubo
     76,1 × 5) e tiranti RFI_Tirante_D24 (barra 24 × 24); quota della mensola,
     dislivello e attacco dei tiranti, lunghezza della mensola: quelli del tool;
   - portali: RFI_Portale_MEC_C19/20/21 (piloni E 65041, attacchi E 65110, trave
     MEC tipo C = CL2 + CCn + CL2, fondazioni P2MEC), RFI_Portale_Tralicciato
     (piloni E 65018 H9586, trave tralicciata 1BIN / 2BIN, fondazioni POT) e
     RFI_Portale_Ormeggio (stessi piloni, trave E 65109 = nL + nC + nL): la famiglia
     e il tipo che sceglie il catalogo (ocs-catalog rfiPortalOf, come l'add-in).
   Tre livelli di dettaglio come il fusto del tool: «box» (fusti e travi pieni),
   «upn» (profili senza traliccio, controventi, tirafondi) e «lattice» (tutto).
   Niente DOM; importa solo il motore. Misure dei generatori in mm (come nei .py,
   per confrontarli riga per riga), solidi in uscita in METRI:
     { t: "ext", o, u, n, loop: [[u, v]…], holes: [[u, v, r]…], d }  contorno sul piano per o
       (u lungo u, v lungo n × u) estruso per d lungo n (prism, plane_extrusion, angle);
     { t: "bar", a, b, r, ri }  tondo pieno (ri = 0) o tubo da a a b (round_bar);
     { t: "sweep", pts, r, len }  tondo di raggio r lungo la spezzata pts (tondi piegati:
       rette + archi a punti), len = lunghezza vera del percorso (rette + archi);
   ognuno con sub (sottocategoria della famiglia) e l = [da, a] livelli (0 box, 1 upn,
   2 lattice) in cui c'è.
   ========================================================================= */
import * as C from "./ocs-core.js?v=0.22.0";

export const LOD_INDEX = { box: 0, upn: 1, lattice: 2 };
const ALL = [0, 2], BOX = [0, 0], DET = [1, 2], LAT = [2, 2];
export const STEEL_KG_M3 = 7850;

/* ---- vettori ---------------------------------------------------------------------------------------- */
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => mul(a, 1 / norm(a));
const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
const rect = (x0, x1, y0, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/* ---- primitive di _lib_rfi.py (mm) ------------------------------------------------------------------------ */
function builder() {
  const out = [];
  let cur = { sub: "", l: ALL };
  const B = {
    out,
    set(s, l = ALL) { cur = { sub: s, l }; return B; },
    /* plane_extrusion: contorno (u, v) sul piano per o, u lungo xd, v lungo n × xd, estruso per d lungo n */
    ext(o, xd, n, loop, d, holes = []) { out.push({ t: "ext", o, u: xd, n, loop, holes, d, sub: cur.sub, l: cur.l }); return B; },
    /* prism: estrusione verticale da z0 a z1 */
    prism(loop, z0, z1, holes = []) { return B.ext([0, 0, z0], X, Z, loop, z1 - z0, holes); },
    /* round_bar: tondo (o tubo con ri) da a a b */
    bar(a, b, r, ri = 0) { out.push({ t: "bar", a, b, r, ri, sub: cur.sub, l: cur.l }); return B; },
    /* angle: angolare L l1 × l2 × t dritto da a a b, allungato di ext ai due capi; il tallone sulla linea a-b, la
       prima ala lungo u1 (resa ⟂ all'asse), la seconda lungo asse × u1 */
    angle(a, b, l1, l2, t, u1, ext = 0) {
      const d = unit(sub(b, a)), u = unit(sub(u1, mul(d, dot(u1, d))));
      const L = norm(sub(b, a)) + 2 * ext;
      return B.ext(sub(a, mul(d, ext)), u, d, [[0, 0], [l1, 0], [l1, t], [t, t], [t, l2], [0, l2]], L);
    },
    sweep(pts, r, len) { out.push({ t: "sweep", pts, r, len, sub: cur.sub, l: cur.l }); return B; },
  };
  return B;
}
const toM = (s) => {
  const m = (v) => v.map((x) => x / 1000);
  if (s.t === "ext") return { ...s, o: m(s.o), loop: s.loop.map(m), holes: s.holes.map(m), d: s.d / 1000 };
  if (s.t === "bar") return { ...s, a: m(s.a), b: m(s.b), r: s.r / 1000, ri: s.ri / 1000 };
  return { ...s, pts: s.pts.map(m), r: s.r / 1000, len: s.len / 1000 };
};

/* ---- sostegni su pali LSU (sostegni_LSU/genera.py) ------------------------------------------------------- */
/* Riferimento dei pezzi del palo: origine sull'asse del palo alla TESTA DEL PILASTRINO (nella famiglia Z_PIL =
   250 sul supercompattato; qui 0, perché il tool la mette dove vuole: supercompattato + pilOut), X lungo il binario,
   Y via dal binario (il binario sta verso −Y), Z in alto */
const Z_PIASTRA = 90;            // piastra del palo 90 sopra la testa del pilastrino (E 66013 c)
export const GROUT = Z_PIASTRA / 1000;
const SBALZO = 115;              // dalla faccia del palo al perno dell'attacco della mensola (E 66013 c f.70-71)
const SPORGENZA_STAFFA = 40;     // dalla faccia del palo al bullone del tirante sulla staffa (E 66013 c f.78)
const PASSO = 266;               // traliccio: distanza verticale fra due incroci
/* serie di pali (E 66013 c): semilarghezza, UPN (h, b, tw, tf), piastra, raggio dei fori, fazzoletti, tondi,
   tirafondi (raggio), dima (ala, spessore) */
export const SERIE = {
  LSU14: { w2: 150, upn: [140, 60, 7, 10], piastra: 25, foro: 30, gx: [-52, 52], gw: 120, r_tondo: 10, r_piega: 75, r_tf: 21, dima: [120, 12] },
  LSU16: { w2: 150, upn: [160, 65, 7.5, 10.5], piastra: 30, foro: 30, gx: [-62, 62], gw: 120, r_tondo: 10, r_piega: 75, r_tf: 21, dima: [120, 12] },
  LSU18: { w2: 200, upn: [180, 70, 8, 11], piastra: 35, foro: 32, gx: [-84, 0, 84], gw: 80, r_tondo: 11, r_piega: 75, r_tf: 22.5, dima: [150, 15] },
  LSU20: { w2: 200, upn: [200, 75, 8.5, 11.5], piastra: 40, foro: 35, gx: [-94, 0, 94], gw: 80, r_tondo: 11, r_piega: 85, r_tf: 26, dima: [150, 15] },
  LSU22: { w2: 200, upn: [220, 80, 9, 12.5], piastra: 40, foro: 35, gx: [-104, 0, 104], gw: 80, r_tondo: 12, r_piega: 90, r_tf: 26, dima: [150, 15] },
};
export const PALI_L = { a: 8200, b: 9600, c: 12000 };
/* attacchi per mensola in acciaio (E 66013 c f.68-78): px, H, X max dei bulloni, a, b, c (pos. 13 di LSU22 ASSUNTA) */
export const ATTACCHI = {
  LSU14: { px: 180, H: 118, xmax: 80, a: 174, b: 115, c: 158 },
  LSU16: { px: 180, H: 118, xmax: 80, a: 194, b: 120, c: 178 },
  LSU18: { px: 220, H: 129, xmax: 100, a: 214, b: 125, c: 198 },
  LSU20: { px: 220, H: 129, xmax: 100, a: 234, b: 130, c: 218 },
  LSU22: { px: 240, H: 129, xmax: 118, a: 254, b: 135, c: 238 },
};
export const MENS_R = [38.05, 33.05];         // tubo 76,1 × 5 (E 13619 o)
export const TIE_SIDE = 24;                    // tirante: barra 24 × 24

/* UPN (h, b, tw, tf) con l'anima sulla faccia Y = s·w2 e le ali verso l'interno */
function upnPts(s, upn, w2) {
  const h = upn[0] / 2, b = upn[1], tw = upn[2], tf = upn[3];
  const pts = [[-h, -w2], [h, -w2], [h, -w2 + b], [h - tf, -w2 + b], [h - tf, -w2 + tw], [-h + tf, -w2 + tw], [-h + tf, -w2 + b], [-h, -w2 + b]];
  return s > 0 ? pts.slice().reverse().map(([x, y]) => [x, -y]) : pts;
}
/* scostamento dei vertici e angolo tali che il raccordo di raggio rp abbia l'asse del tondo a y_piega */
function waveGeometry(yp, rp) {
  let a = yp + 20;
  for (let i = 0; i < 50; i++) { const al = Math.atan(PASSO / (2 * a)); a = yp + rp * (1 / Math.sin(al) - 1); }
  return [a, Math.atan(PASSO / (2 * a))];
}
const ARC_STEP = Math.PI / 8;                 // archi dei tondi piegati a punti ogni 22,5°
/* tondo piegato a onda nel piano X = xs: rette + archi di raggio rp (wave_bar) */
function waveBar(B, xs, phase, z0, n, yp, r, rp) {
  const [a, al] = waveGeometry(yp, rp);
  const vert = (k) => [xs, phase * (k % 2 === 0 ? 1 : -1) * a, z0 + k * PASSO];
  const t = rp / Math.tan(al), dc = rp / Math.sin(al), turn = Math.PI - 2 * al, na = Math.max(2, Math.ceil(turn / ARC_STEP - 1e-9));
  const pts = [vert(0)];
  let cur = vert(0), len = 0;
  for (let k = 1; k < n; k++) {
    const V = vert(k), dA = unit(sub(vert(k - 1), V)), dC = unit(sub(vert(k + 1), V));
    const T1 = add(V, mul(dA, t)), T2 = add(V, mul(dC, t)), c = add(V, mul(unit(add(dA, dC)), dc));
    const e1 = unit(sub(T1, c)), w = sub(T2, c), e2 = unit(sub(w, mul(e1, dot(w, e1))));
    len += norm(sub(T1, cur)) + rp * turn;
    pts.push(T1);
    for (let j = 1; j < na; j++) { const th = (turn * j) / na; pts.push(add(c, add(mul(e1, rp * Math.cos(th)), mul(e2, rp * Math.sin(th))))); }
    pts.push(T2);
    cur = T2;
  }
  len += norm(sub(vert(n), cur));
  pts.push(vert(n));
  B.sweep(pts, r, len);
}
/* palo LSU alto Lp con piastra, fazzoletti, traliccio e ancoraggio (build_palo); z = 0 sulla testa del pilastrino */
function paloSolids(se, Lp) {
  const sr = SERIE[se], B = builder(), upn = sr.upn, w2 = sr.w2, r = sr.r_tondo;
  const z_f0 = Z_PIASTRA + sr.piastra, z_f1 = z_f0 + Lp;
  const luce = w2 - upn[1], y_piega = luce - r, x_tondi = upn[0] / 2 - r;
  B.set("Piastra base").prism(rect(-290, 290, -290, 290), Z_PIASTRA, z_f0, [-200, 200].flatMap((x) => [-200, 200].map((y) => [x, y, sr.foro])));
  B.set("Fusto UPN", BOX).prism(rect(-upn[0] / 2, upn[0] / 2, -w2, w2), z_f0, z_f1);
  B.set("Fusto UPN", DET);
  for (const s of [-1, 1]) B.prism(upnPts(s, upn, w2), z_f0, z_f1);
  const gw = sr.gw, gusset = [[0, 30], [30, 0], [gw, 0], [gw, 50], [30, 200], [0, 200]];
  B.set("Piastra base", LAT);
  for (const s of [-1, 1]) for (const xc of sr.gx) B.ext([xc - 6 * s, s * w2, z_f0], [0, s, 0], [s, 0, 0], gusset, 12);
  const z0 = z_f0 + 40, nseg = Math.floor((z_f1 - 21 - 40 - z0) / PASSO);
  B.set("Traliccio", LAT);
  for (const xs of [-x_tondi, x_tondi]) {
    for (const phase of [-1, 1]) waveBar(B, xs, phase, z0, nseg, y_piega, r, sr.r_piega);
    B.bar([xs, -luce, z_f1 - 21], [xs, luce, z_f1 - 21], r);
  }
  // ancoraggio: 4 tirafondi L 1200 su 400 × 400 (290 sopra il pilastrino, 910 sotto) e dima di 4 profili L
  const z_tf0 = -910, z_tf1 = 290;
  B.set("Tirafondi", LAT);
  for (const x of [-200, 200]) for (const y of [-200, 200]) B.bar([x, y, z_tf0], [x, y, z_tf1], sr.r_tf);
  const [la, ta] = sr.dima, zc = z_tf0 + 150;
  for (const s of [-1, 1]) {
    const yi = s * (200 - la / 2), ye = s * (200 + la / 2);
    B.prism(rect(-290, 290, Math.min(yi, ye), Math.max(yi, ye)), zc, zc + ta);
    B.prism(rect(-290, 290, Math.min(ye, ye - s * ta), Math.max(ye, ye - s * ta)), zc + ta, zc + la);
    B.prism(rect(Math.min(yi, ye), Math.max(yi, ye), -290, 290), zc - ta, zc);
    B.prism(rect(Math.min(ye, ye - s * ta), Math.max(ye, ye - s * ta), -290, 290), zc - la, zc - ta);
  }
  return B.out;
}
/* attacco della mensola (pos. 1 / 12): piastra a X sulla faccia del palo, 4 bulloni a gancio M16, corpo, forcella e
   perno a SBALZO dalla faccia (build_attacco); z = 0 sull'asse della mensola */
function attaccoSolids(se) {
  const sr = SERIE[se], a = ATTACCHI[se], B = builder().set("Attacco mensola");
  const yf = -sr.w2, upn = sr.upn, hz = a.H / 2, xb = Math.min(upn[0] / 2 + 8, a.xmax), org = [0, yf, 0];
  const w = 30, e = a.px / 2 - xb;
  const arm = (x0, z0, x1, z1) => {
    const dx = x1 - x0, dz = z1 - z0, Lb = Math.hypot(dx, dz), ux = dx / Lb, uz = dz / Lb, nx = (-uz * w) / 2, nz = (ux * w) / 2;
    return [[x0 - ux * e + nx, z0 - uz * e + nz], [x1 + ux * e + nx, z1 + uz * e + nz], [x1 + ux * e - nx, z1 + uz * e - nz], [x0 - ux * e - nx, z0 - uz * e - nz]];
  };
  for (const loop of [arm(-xb, -hz, xb, hz), arm(-xb, hz, xb, -hz)]) B.ext(org, X, [0, -1, 0], loop, 15);
  const y_ali = yf + upn[1];
  for (const x of [-xb, xb]) for (const dz of [-hz, hz]) {
    B.bar([x, yf - 15 - 25, dz], [x, y_ali + 10, dz], 8);
    B.bar([x, y_ali + 10, dz], [x - Math.sign(x) * 25, y_ali + 10, dz], 8);
  }
  const y_p = yf - SBALZO;
  B.ext([0, yf - 15, 0], X, [0, -1, 0], rect(-25, 25, -40, 40), SBALZO - 46 - 15);
  for (const s of [-1, 1]) { const z0 = s * 62.5; B.prism(rect(-20, 20, y_p - 15, yf - SBALZO + 46), Math.min(z0, z0 - s * 15), Math.max(z0, z0 - s * 15)); }
  B.bar([0, y_p, -72], [0, y_p, 72], 7);
  return B.out;
}
/* staffa del tirante (f.77-78): angolare L 80 × 10, 2 orecchie con il bullone M16 a SPORGENZA_STAFFA dalla faccia,
   collare a U Ø16 (build_staffa); z = 0 alla quota dell'attacco del tirante sul palo */
function staffaSolids(se) {
  const sr = SERIE[se], a = ATTACCHI[se], B = builder().set("Attacco tirante"), yf = -sr.w2, ha = a.a / 2;
  B.prism(rect(-ha, ha, yf - 10, yf), -40, 40);
  B.prism(rect(-ha, ha, yf - 45, yf - 10), 30, 40);
  for (const xs of [-17.5, 17.5]) B.prism(rect(xs - 5, xs + 5, yf - 10 - 50, yf - 10), -35, 35);
  B.bar([-30, yf - SPORGENZA_STAFFA, 0], [30, yf - SPORGENZA_STAFFA, 0], 8);
  const hc = a.c / 2, yb = yf - 10 + a.b;
  for (const xs of [-hc, hc]) B.bar([xs, yf - 30, 0], [xs, yb, 0], 8);
  B.bar([-hc, yb, 0], [hc, yb, 0], 8);
  return B.out;
}
/* mensola 76,1 × 5 lunga L mm, dall'inizio (origine, perno dell'attacco) verso il binario (−Y) */
const mensolaSolids = (L) => builder().set("Mensola").bar([0, 0, 0], [0, -L, 0], MENS_R[0], MENS_R[1]).out;
/* plinto (E 64865 f, RFI_Plinto_LSU): pilastrino B1 × A1 alto c1 sotto l'origine, blocco B × A × C sotto; i B
   eccentrici: A2 dall'asse al bordo verso il binario (−Y) */
function plintoSolids(Fd, c1) {
  const mm = (v) => v * 1000, A = mm(Fd.A), Bb = mm(Fd.B), C1 = mm(c1), A2 = Fd.A2 != null ? mm(Fd.A2) : A / 2;
  const B = builder().set("Plinto");
  B.prism(rect(-mm(Fd.B1) / 2, mm(Fd.B1) / 2, -mm(Fd.A1) / 2, mm(Fd.A1) / 2), -C1, 0);
  B.prism(rect(-Bb / 2, Bb / 2, -A2, A - A2), -C1 - mm(Fd.C), -C1);
  return B.out;
}
/* tirante 24 × 24 (RFI_Tirante_D24, d'istanza): dalla staffa (a SPORGENZA_STAFFA dalla faccia, zt) al punto della
   mensola a xt dal suo inizio (zm); estremità verticali; mm nel riferimento del palo */
function tiranteSolids(w2, zm, zt, xt) {
  const y_fa = -(w2 + SPORGENZA_STAFFA), y_att = -(w2 + SBALZO + xt), h = TIE_SIDE / 2;
  return builder().set("Tirante").ext([-h, 0, 0], Y, X, [[y_fa, zt + h], [y_fa, zt - h], [y_att, zm - h], [y_att, zm + h]], TIE_SIDE).out;
}

/* ---- portali MEC tipo C (portali_MEC_C/genera.py e genera_parametrico.py) ---------------------------------- */
/* Riferimento dei portali: origine sull'asse del pilone 1 sul SUPERCOMPATTATO, X lungo il binario, Y lungo la trave
   verso il pilone 2, Z in alto (come le famiglie) */
const MEC = { Z_FOND: 100, Z_PIASTRA0: 106, Z_COL0: 156, H_COL: 9500, X_COL: 680, H_TRAVE: 1000, B_TRAVE: 750 };
MEC.Z_COL1 = MEC.Z_COL0 + MEC.H_COL;
MEC.Z_TRAVE = MEC.Z_COL0 + (MEC.H_COL - 1340) + 200;          // ASSUNTO: 200 sopra l'ultimo traverso del pilone
const FOND_MEC = { A: 2100, B: 4000, C: 2500, A1: 1000, B1: 2360, C1: 250 };
const IPE = [400, 180, 8.6, 13.5];
/* elementi della trave MEC tipo C (E 64923): lunghezza, campi della fiancata, zona d'appoggio */
export const MEC_ELEMENTI = { CL2: { L: 7290, campi: 8, appoggio: 1000 }, CC3: { L: 6990, campi: 7, appoggio: 0 }, CC4: { L: 5990, campi: 6, appoggio: 0 }, CC5: { L: 4990, campi: 5, appoggio: 0 } };
export const MEC_CENTRALE = { C21: "CC3", C20: "CC4", C19: "CC5" };
const plateHoles = (cx) => [-250, 0, 250].flatMap((dx) => [-330, 0, 330].filter((dy) => dx || dy).map((dy) => [cx + dx, dy]));
function fondMecSolids() {
  const d = FOND_MEC, B = builder().set("Fondazione"), z_bl = MEC.Z_FOND - d.C1;
  B.prism(rect(-d.B1 / 2, d.B1 / 2, -d.A1 / 2, d.A1 / 2), z_bl, MEC.Z_FOND);
  B.prism(rect(-d.B / 2, d.B / 2, -d.A / 2, d.A / 2), z_bl - d.C, z_bl);
  B.set("Tirafondi", LAT);
  for (const cx of [-MEC.X_COL, MEC.X_COL]) for (const [x, y] of plateHoles(cx)) B.bar([x, y, MEC.Z_FOND - 980], [x, y, MEC.Z_FOND + 220], 21);
  return B.out;
}
function ipePts(cx) {
  const h = IPE[0] / 2, b = IPE[1] / 2, tw = IPE[2] / 2, tf = IPE[3];
  return [[cx - b, -h], [cx + b, -h], [cx + b, -h + tf], [cx + tw, -h + tf], [cx + tw, h - tf], [cx + b, h - tf], [cx + b, h], [cx - b, h], [cx - b, h - tf], [cx - tw, h - tf], [cx - tw, -h + tf], [cx - b, -h + tf]];
}
function piloneMecSolids() {
  const B = builder(), { Z_COL0, Z_COL1, Z_PIASTRA0, X_COL, H_COL } = MEC;
  for (const cx of [-X_COL, X_COL]) {
    B.set("Colonne IPE").prism(ipePts(cx), Z_COL0, Z_COL1);
    B.set("Piastre base").prism(rect(cx - 350, cx + 350, -430, 430), Z_PIASTRA0, Z_COL0, plateHoles(cx).map(([x, y]) => [x, y, 26.5]));
    B.set("Piastre base", LAT);
    const g6 = [[0, 30], [30, 0], [240, 0], [240, 75], [75, 400], [0, 400]];
    for (const sy of [-1, 1]) for (const sx of [-1, 1]) B.ext([cx + (sx * IPE[1]) / 2, sy * 194 + 6 * sx, Z_COL0], [sx, 0, 0], [0, -sx, 0], g6, 12);
    const g7 = [[0, 30], [30, 0], [210, 0], [210, 75], [75, 320], [0, 320]];
    for (const sy of [-1, 1]) for (const dx of [-176, -74, 74, 176]) B.ext([cx + dx - 6 * sy, (sy * IPE[0]) / 2, Z_COL0], [0, sy, 0], [sy, 0, 0], g7, 12);
  }
  // controventi L 70 × 70 × 8 sulle due facce: sotto 6 diagonali a zig-zag, sopra 7 traversi e 6 diagonali
  const z_h0 = Z_COL0 + H_COL - 1340 - 6 * 500;
  B.set("Controventi", LAT);
  for (const sy of [-1, 1]) {
    const yf = (sy * IPE[0]) / 2, out = [0, sy, 0], first = sy > 0 ? -1 : 1;
    for (let k = 0; k < 6; k++) {
      const s = k % 2 === 0 ? first : -first, za = z_h0 - (6 - k) * 761, zb = z_h0 - (5 - k) * 761;
      B.angle([s * 608, yf, za], [-s * 608, yf, zb], 70, 70, 8, out, 40);
    }
    for (let j = 0; j < 7; j++) {
      const z = z_h0 + j * 500;
      B.angle([-620, yf, z], [620, yf, z], 70, 70, 8, out, 30);
      if (j < 6) { const s = j % 2 === 0 ? first : -first; B.angle([s * 620, yf, z + 78], [-s * 620, yf, z + 422], 70, 70, 8, out, 35); }
    }
  }
  return B.out;
}
/* attacco della trave sul pilone (E 65110, ASSUNTO): due angolari L 100 × 100 × 10 per lato, sotto e sopra la trave */
function attMecSolids() {
  const B = builder().set("Attacco trave", DET);
  for (const sy of [-1, 1]) {
    const y0 = (sy * IPE[0]) / 2, out = [0, sy, 0];
    for (const [z, su] of [[MEC.Z_TRAVE, -1], [MEC.Z_TRAVE + 1056, 1]]) {
      let a = [-MEC.X_COL - 90, y0, z], b = [MEC.X_COL + 90, y0, z];
      if (sy * su < 0) [a, b] = [b, a];
      B.angle(a, b, 100, 100, 10, out);
    }
  }
  return B.out;
}
/* 4 correnti a L agli spigoli della sezione hx × (z0…z1), da y0 a y1, ali verso l'interno */
function correnti(B, hx, z0, z1, y0, y1, leg, t) {
  for (const sx of [-1, 1]) for (const [zc, sz] of [[z0, 1], [z1, -1]]) {
    let a = [sx * hx, y0, zc], b = [sx * hx, y1, zc];
    const u1 = [-sx, 0, 0];
    if (dot(cross(Y, u1), mul(Z, sz)) < 0) [a, b] = [b, a];
    B.angle(a, b, leg, leg, t, u1);
  }
}
/* tratto di trave MEC 750 × 1000 lungo L, da y = 0 a y = L (build_trave) */
function traveMecSolids(key) {
  const { L, campi, appoggio } = MEC_ELEMENTI[key], B = builder(), hx = MEC.B_TRAVE / 2, z0 = MEC.Z_TRAVE, z1 = MEC.Z_TRAVE + MEC.H_TRAVE;
  B.set("Correnti", BOX).prism(rect(-hx, hx, 0, L), z0, z1);
  correnti(B.set("Correnti", DET), hx, z0, z1, 0, L, 100, 12);
  const zl = z0 + 50, zh = z1 - 50, passo = L / campi;
  B.set("Fiancate", LAT);
  for (let k = 0; k < campi; k++) {
    const [za, zb] = k % 2 === 0 ? [zl, zh] : [zh, zl];
    for (const sx of [-1, 1]) B.angle([sx * (hx - 12), k * passo, za], [sx * (hx - 12), (k + 1) * passo, zb], 50, 50, 5, [-sx, 0, 0]);
  }
  let nodi = Array.from({ length: campi + 1 }, (_, j) => j * passo);
  if (appoggio) nodi = [...new Set([...nodi.filter((y) => y > appoggio), ...Array.from({ length: Math.floor(appoggio / 250) + 1 }, (_, j) => j * 250)])].sort((a, b) => a - b);
  const xs = hx - 35;
  B.set("Controventi trave", LAT);
  for (const [zp, sz] of [[z0 + 12, 1], [z1 - 12, -1]]) nodi.forEach((y, j) => {
    B.angle([-xs, y, zp], [xs, y, zp], 45, 45, 4.5, mul(Z, sz));
    if (j + 1 < nodi.length) { const s = j % 2 === 0 ? 1 : -1; B.angle([-s * xs, y, zp], [s * xs, nodi[j + 1], zp], 45, 45, 4.5, mul(Z, sz)); }
  });
  return B.out;
}

/* ---- portali coi piloni E 65018 (portali_ormeggio/genera.py, portali_tralicciati/genera.py) ------------------ */
const POT = { Z_FOND: 350, H_PIL: 9586, H_TRAVE: 800, B_TRAVE: 1280 };
POT.Z_COL0 = POT.Z_FOND + 50; POT.Z_COL1 = POT.Z_FOND + POT.H_PIL; POT.Z_RASTR = POT.Z_COL0 + 6556;
POT.Z_TRAVE = POT.Z_COL1 - 150 - POT.H_TRAVE;                // ASSUNTO: filo superiore 150 sotto la testa del pilone
const HEA = [310, 300, 9, 15.5], X_BASE = 1927.5 / 2 - 150, X_TOP = 1327.5 / 2 - 150;
/* travi E 65109 (luce asse-asse dei piloni): elemento laterale nL e centrale nC; nel catalogo dell'add-in T-6, T-9, T-25 */
export const ORM_TRAVI = { "T-6": [14400, 1, 5], "T-7": [14400, 2, 3], "T-8": [14400, 3, 1], "T-9": [15600, 1, 6], "T-10": [15600, 2, 4], "T-11": [15600, 3, 2], "T-25": [20400, 1, 10], "T-26": [20400, 2, 8], "T-27": [20400, 3, 6], "T-28": [20400, 4, 4], "T-29": [20400, 5, 2] };
export const lenL = (n) => 4595 + 1200 * (n - 1);
export const lenC = (n) => 1200 * n - 790;
/* travi tralicciate (E 65018 a): luce, campi (laterale, centrale, n. centrali) */
export const TRAL_TRAVI = { "1BIN_L6400": ["1BIN", 6400, [581.7, 661.7, 6]], "2BIN_L10300": ["2BIN", 10300, [581.7, 773.7, 10]] };
const SPORTO = 440;
function fondPotSolids() {
  const B = builder().set("Fondazione");
  B.prism(rect(-3000, 3000, -1250, 1250), POT.Z_FOND - 2200, POT.Z_FOND);
  B.set("Tirafondi", LAT);
  for (const xc of [-X_BASE, X_BASE]) for (const dx of [-200, 200]) for (const dy of [-300, 300]) B.bar([xc + dx, dy, POT.Z_FOND - 1000], [xc + dx, dy, POT.Z_FOND + 200], 18);
  return B.out;
}
function heaPts() {
  const h = HEA[0] / 2, b = HEA[1] / 2, tw = HEA[2] / 2, tf = HEA[3];
  return [[-b, -h], [b, -h], [b, -h + tf], [tw, -h + tf], [tw, h - tf], [b, h - tf], [b, h], [-b, h], [-b, h - tf], [-tw, h - tf], [-tw, -h + tf], [-b, -h + tf]];
}
/* HEA320 lungo il segmento a-b nel piano Y = 0 (ali parallele al piano XZ) */
function column(B, a, b) {
  const d = unit(sub(b, a));
  B.ext(a, [d[2], 0, -d[0]], d, heaPts(), norm(sub(b, a)));
}
function pilonePotSolids() {
  const B = builder(), { Z_FOND, Z_COL0, Z_COL1, Z_RASTR, Z_TRAVE } = POT;
  for (const s of [-1, 1]) {
    B.set("Piastre base").prism(rect(s * X_BASE - 300, s * X_BASE + 300, -400, 400), Z_FOND, Z_COL0);
    B.set("Colonne HEA");
    column(B, [s * X_BASE, 0, Z_COL0], [s * X_TOP, 0, Z_RASTR]);
    column(B, [s * X_TOP, 0, Z_RASTR], [s * X_TOP, 0, Z_COL1]);
  }
  const xc = (z) => X_BASE + ((X_TOP - X_BASE) * (z - Z_COL0)) / (Z_RASTR - Z_COL0);
  const nodi = [Z_COL0 + 300, Z_COL0 + 2300, Z_COL0 + 4400, Z_RASTR];
  B.set("Controventi", LAT);
  for (const sy of [-1, 1]) {
    const y = (sy * HEA[0]) / 2, out = [0, sy, 0];
    for (let i = 0; i + 1 < nodi.length; i++) {
      const z0 = nodi[i], z1 = nodi[i + 1];
      B.angle([-xc(z0), y, z0], [xc(z1), y, z1], 90, 90, 10, out);
      B.angle([xc(z0), y, z0], [-xc(z1), y, z1], 90, 90, 10, out);
    }
    for (const z of [...nodi, Z_TRAVE - 100]) { const x = z <= Z_RASTR ? xc(z) : X_TOP; B.angle([-x, y, z], [x, y, z], 90, 90, 10, out); }
    B.angle([-X_TOP, y, Z_RASTR], [X_TOP, y, Z_TRAVE - 100], 90, 90, 10, out);
  }
  return B.out;
}
/* tratto di trave E 65109 1280 × 800 lungo Lg da y = 0 (build_trave); laterale: + attacco al pilone (lat_builder) */
function traveOrmSolids(Lg, lat) {
  const B = builder(), hx = POT.B_TRAVE / 2, z0 = POT.Z_TRAVE, z1 = POT.Z_TRAVE + POT.H_TRAVE;
  B.set("Correnti", BOX).prism(rect(-hx, hx, 0, Lg), z0, z1);
  correnti(B.set("Correnti", DET), hx, z0, z1, 0, Lg, 150, 15);
  const campi = Math.max(1, Math.round(Lg / 1200)), passo = Lg / campi, zl = z0 + 75, zh = z1 - 75;
  B.set("Fiancate", LAT);
  for (let k = 0; k < campi; k++) {
    const [za, zb] = k % 2 === 0 ? [zl, zh] : [zh, zl];
    for (const sx of [-1, 1]) B.angle([sx * (hx - 15), k * passo, za], [sx * (hx - 15), (k + 1) * passo, zb], 80, 80, 10, [-sx, 0, 0]);
  }
  for (let k = 0; k <= campi; k++) for (const sx of [-1, 1]) B.angle([sx * (hx - 15), k * passo, z0 + 15], [sx * (hx - 15), k * passo, z1 - 15], 80, 80, 10, [-sx, 0, 0]);
  const xs = hx - 75;
  B.set("Controventi trave", LAT);
  for (const [zp, sz] of [[z0 + 15, 1], [z1 - 15, -1]]) for (let j = 0; j <= campi; j++) {
    B.angle([-xs, j * passo, zp], [xs, j * passo, zp], 80, 80, 10, mul(Z, sz));
    if (j < campi) { const s = j % 2 === 0 ? 1 : -1; B.angle([-s * xs, j * passo, zp], [s * xs, (j + 1) * passo, zp], 80, 80, 10, mul(Z, sz)); }
  }
  if (lat) {
    B.set("Attacco al pilone");
    for (const sx of [-1, 1]) {
      const x0 = sx * (hx + 18);
      B.prism(rect(Math.min(x0, x0 - sx * 18), Math.max(x0, x0 - sx * 18), -375, 375), z0, z1);
      for (const zc of [z0 - 30, z1]) B.prism(rect(sx * hx - 300, sx * hx + 300, -300, 300), zc, zc + 30);
    }
  }
  return B.out;
}
/* ascisse dei traversi della trave tralicciata: primo e ultimo a 390 dalle estremità, campi scalati sulla lunghezza */
function nodiTral(luce, [lat, cen, n]) {
  const passi = [lat, lat, ...Array(n).fill(cen), lat, lat], s = (luce + 2 * SPORTO - 780) / passi.reduce((a, b) => a + b, 0), ys = [390 - SPORTO];
  for (const p of passi) ys.push(ys[ys.length - 1] + p * s);
  return ys;
}
/* trave tralicciata 1280 × 800 da −SPORTO a luce + SPORTO (build_trave_t); origine sull'asse del pilone 1 */
function traveTralSolids(luce, campi) {
  const B = builder(), hx = POT.B_TRAVE / 2, z0 = POT.Z_TRAVE, z1 = POT.Z_TRAVE + POT.H_TRAVE, y0 = -SPORTO, y1 = luce + SPORTO;
  B.set("Correnti", BOX).prism(rect(-hx, hx, y0, y1), z0, z1);
  correnti(B.set("Correnti", DET), hx, z0, z1, y0, y1, 150, 15);
  const ys = nodiTral(luce, campi), xs = hx - 75;
  B.set("Controventi trave", LAT);
  for (const [zp, sz, verso] of [[z0 + 15, 1, -1], [z1 - 15, -1, 1]]) ys.forEach((y, j) => {
    B.angle([-xs, y, zp], [xs, y, zp], 80, 80, 10, mul(Z, sz));
    if (j < ys.length - 1) B.angle([-verso * xs, y, zp], [verso * xs, ys[j + 1], zp], 80, 80, 10, mul(Z, sz));
  });
  const zl = z0 + 75, zh = z1 - 75, xf = hx - 15;
  B.set("Fiancate", LAT);
  for (const sx of [-1, 1]) {
    for (let j = 0; j < ys.length - 1; j++) { const [za, zb] = j % 2 === 0 ? [zh, zl] : [zl, zh]; B.angle([sx * xf, ys[j], za], [sx * xf, ys[j + 1], zb], 50, 50, 6, [-sx, 0, 0]); }
    for (let j = 0; j < ys.length; j += 2) B.angle([sx * xf, ys[j], z0 + 15], [sx * xf, ys[j], z1 - 15], 50, 50, 6, [-sx, 0, 0]);
  }
  B.set("Controventi trave", LAT);
  for (const j of [0, Math.floor(ys.length / 2), ys.length - 1]) B.angle([-xs, ys[j] + 40, z0 + 75], [xs, ys[j] + 40, z1 - 75], 50, 50, 6, Y);
  B.set("Attacco al pilone");
  for (const yp of [0, luce]) for (const sx of [-1, 1]) { const xa = sx * (hx + 18); B.prism(rect(Math.min(xa, sx * hx), Math.max(xa, sx * hx), yp - 290, yp + 290), z0, z1); }
  return B.out;
}

/* ---- pezzi condivisi (una geometria per chiave) -------------------------------------------------------------- */
const MAKERS = {
  palo: (id) => { const m = /^LSU(\d\d)([abc])$/.exec(id); return paloSolids("LSU" + m[1], PALI_L[m[2]]); },
  att: (se) => attaccoSolids(se),
  staffa: (se) => staffaSolids(se),
  mens: (L) => mensolaSolids(+L),
  fondMEC: () => fondMecSolids(), pilMEC: () => piloneMecSolids(), attMEC: () => attMecSolids(), trMEC: (k) => traveMecSolids(k),
  fondPOT: () => fondPotSolids(), pilPOT: () => pilonePotSolids(),
  trORM: (k) => { const lat = k[0] === "L", n = +k.slice(1); return traveOrmSolids(lat ? lenL(n) : lenC(n), lat); },
  trTRAL: (k) => { const [, luce, campi] = TRAL_TRAVI[k]; return traveTralSolids(luce, campi); },
};
const CACHE = new Map();
/* i solidi (metri) del pezzo condiviso key = «tipo|argomento» (plinto: «plinto|id|c1» con la fondazione passata),
   filtrati sul livello di dettaglio lod */
export function pieceSolids(key, lod = "lattice", Fd = null) {
  let all = CACHE.get(key);
  if (!all) {
    const [k, arg, c1] = key.split("|");
    all = (k === "plinto" ? plintoSolids(Fd, +c1) : MAKERS[k](arg)).map(toM);
    CACHE.set(key, all);
  }
  return atLod(all, lod);
}
export const atLod = (solids, lod = "lattice") => { const i = LOD_INDEX[lod] != null ? LOD_INDEX[lod] : 2; return solids.filter((s) => s.l[0] <= i && i <= s.l[1]); };

/* ---- sostegni → pezzi nel riferimento della famiglia ------------------------------------------------------------
   Un pezzo: { k (parte del tool: plinto, palo, att, staffa, mens, tir, fond, pilone, attTrave, trave), key (geometria
   condivisa) o own (solidi suoi, metri), fam (famiglia Revit), type (tipo), o: [x, y, z] (m), rot (0 | π attorno a Z),
   ifc: [classe, tipo predefinito] }.
   R = sostegno risolto dal catalogo con R.rfi (ocs-catalog: resolveSupport / resolvePortal); null se la famiglia non
   c'è (LSU24, pali doppi, portali su pali LSU, luci fuori dai tipi) → il chiamante disegna la geometria semplificata */
const PI = Math.PI;
const SE_OF = (M) => "LSU" + M.size;
export function rfiPieces(R) {
  if (!R || !R.rfi) return null;
  if (R.kind === "portal") return portalPieces(R);
  const M = R.mast, se = SE_OF(M);
  if (!SERIE[se]) return null;
  const w2 = SERIE[se].w2, zm = R.hm - R.baseDz, mens = R.mens.L;
  const ties = R.ties && R.ties.length ? R.ties : [R.tir];
  const fid = R.found.id, c1 = Math.round(R.c1 * 1000) / 1000;
  const out = [
    { k: "plinto", key: "plinto|" + fid + "|" + c1, Fd: R.found, fam: "RFI_Plinto_LSU", type: fid, o: [0, 0, 0], rot: 0, ifc: ["IFCFOOTING", "PAD_FOOTING"] },
    { k: "palo", key: "palo|" + M.id, fam: "RFI_Palo_" + M.id, type: "", o: [0, 0, 0], rot: 0, ifc: ["IFCCOLUMN", "STANDCOLUMN"] },
    { k: "att", key: "att|" + se, fam: "RFI_AttaccoMensola_E66013_" + se, type: "", o: [0, 0, zm], rot: 0, ifc: ["IFCDISCRETEACCESSORY", "BRACKET"] },
    { k: "staffa", key: "staffa|" + se, fam: "RFI_AttaccoTirante_E66013_" + se, type: "", o: [0, 0, zm + ties[0].dh], rot: 0, ifc: ["IFCDISCRETEACCESSORY", "BRACKET"] },
    { k: "mens", key: "mens|" + Math.round(mens * 1000), fam: "RFI_Mensola_D76x5", type: R.rfi.mens || "", o: [0, -(w2 + SBALZO) / 1000, zm], rot: 0, ifc: ["IFCMEMBER", "MEMBER"] },
  ];
  ties.forEach((t, i) => out.push({ k: "tir" + (i ? String(i + 1) : ""), own: tiranteSolids(w2, zm * 1000, (zm + t.dh) * 1000, t.xt * 1000).map(toM), fam: "RFI_Tirante_D24", type: "", o: [0, 0, 0], rot: 0, ifc: ["IFCMEMBER", "TIEBAR"] }));
  return out;
}
function portalPieces(R) {
  const rf = R.rfi, out = [];
  const P = (k, key, fam, type, y, rot, ifc) => out.push({ k, key, fam, type, o: [0, y / 1000, 0], rot, ifc });
  const F = ["IFCFOOTING", "PAD_FOOTING"], COL = ["IFCCOLUMN", "STANDCOLUMN"], BR = ["IFCDISCRETEACCESSORY", "BRACKET"], BM = ["IFCBEAM", "BEAM"];
  const luce = Math.round(rf.luce * 1000);
  if (rf.kind === "MEC") {
    for (const y of [0, luce]) {
      P("fond", "fondMEC", "RFI_Fondazione_P2MEC", "", y, 0, F);
      P("pilone", "pilMEC", "RFI_Pilone_E65041", "", y, 0, COL);
      P("attTrave", "attMEC", "RFI_Attacco_TraveMEC_E65110", "", y, 0, BR);
    }
    const cc = MEC_CENTRALE[rf.type], Lcl = MEC_ELEMENTI.CL2.L, Ltot = 2 * Lcl + MEC_ELEMENTI[cc].L, y0 = luce / 2 - Ltot / 2;
    P("trave", "trMEC|CL2", "RFI_TraveMEC_C_CL2", "", y0, 0, BM);
    P("trave", "trMEC|" + cc, "RFI_TraveMEC_C_" + cc, "", y0 + Lcl, 0, BM);
    P("trave", "trMEC|CL2", "RFI_TraveMEC_C_CL2", "", luce / 2 + Ltot / 2, PI, BM);
    return out;
  }
  for (const [y, rot] of [[0, 0], [luce, PI]]) {
    P("fond", "fondPOT", "RFI_Fondazione_POT", "", y, rot, F);
    P("pilone", "pilPOT", "RFI_Pilone_E65018_H9586", "", y, rot, COL);
  }
  if (rf.kind === "TRAL") { const k = TRAL_TRAVI[rf.type][0]; P("trave", "trTRAL|" + rf.type, "RFI_TraveTralicciata_" + k, "", 0, 0, BM); return out; }
  const [, nl, nc] = ORM_TRAVI[rf.type];
  P("trave", "trORM|L" + nl, "RFI_TraveOrmeggio_" + nl + "L", "", 0, 0, BM);
  P("trave", "trORM|C" + nc, "RFI_TraveOrmeggio_" + nc + "C", "", lenL(nl), 0, BM);
  P("trave", "trORM|L" + nl, "RFI_TraveOrmeggio_" + nl + "L", "", luce, PI, BM);
  return out;
}
/* le parti del tool (supportParts / portalParts) che la famiglia sostituisce: le altre (sospensioni, pendoli, filo,
   assi dei binari, trasformatore, sezionatore) restano */
export const replaces = (k) => /^(pil|block|plate|mast|pole|mens|att|beam|tir\d*)$/.test(k);

/* riferimento della famiglia nel mondo (coordinate dei binari) → { o: {x, y, z}, X: [x, y], Y: [x, y], th (angolo di X) }
   palo: asse del palo alla testa del pilastrino, X = s·tangente, Y via dal binario (come revitFrame, ma alla testa del
   pilastrino invece che al supercompattato: pilOut più su); portale: asse del pilone 1 (montante destro) sul
   supercompattato (= revitFrame), X = tangente della trave, Y verso il pilone 2 */
export function rfiFrame(T, s, R) {
  if (!R || !R.rfi) return null;
  if (R.kind === "portal") {
    const W = C.portalFrame(T, s, R);
    if (!W) return null;
    const o = W.at(0, -W.half, W.f.z + R.zBaseR - R.pilOut), X0 = [W.tx, W.ty];
    return { o, X: X0, Y: [-X0[1], X0[0]], th: Math.atan2(X0[1], X0[0]) };
  }
  const F = C.supportFrame(T, s.u, s.side);
  if (!F) return null;
  const { f, s: sg, at } = F, qc = sg * (R.dr + C.GAUGE_HALF + R.mast.w / 2);
  const X0 = [sg * f.tx, sg * f.ty];
  return { o: at(0, qc, f.z + R.baseDz), X: X0, Y: [-X0[1], X0[0]], th: Math.atan2(X0[1], X0[0]) };
}
/* i pezzi della famiglia nel mondo: { frame, pieces: [{ …pezzo, w: {x, y, z} origine nel mondo, th: angolo della sua X }] }
   o null (niente famiglia) */
export function rfiPlaced(T, s, R) {
  const pieces = rfiPieces(R), fr = pieces && rfiFrame(T, s, R);
  if (!fr) return null;
  return {
    frame: fr,
    pieces: pieces.map((p) => ({
      ...p,
      w: { x: fr.o.x + p.o[0] * fr.X[0] + p.o[1] * fr.Y[0], y: fr.o.y + p.o[0] * fr.X[1] + p.o[1] * fr.Y[1], z: fr.o.z + p.o[2] },
      th: fr.th + p.rot,
    })),
  };
}
/* i solidi di un pezzo (condiviso o suo) al livello lod */
export const solidsOf = (p, lod = "lattice") => (p.own ? atLod(p.own, lod) : pieceSolids(p.key, lod, p.Fd));

/* ---- misure (per i test contro le verifiche della sessione 18) -------------------------------------------------- */
const loopArea = (lp) => { let a = 0; for (let i = 0; i < lp.length; i++) { const p = lp[i], q = lp[(i + 1) % lp.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; };
/* volume di un solido (m³): estrusione = area (meno i fori) × profondità; tondo = π (r² − ri²) × lunghezza; tondo piegato
   = π r² × lunghezza vera del percorso. I solidi sovrapposti contano due volte, come la somma dei volumi in Revit */
export function solidVolume(s) {
  if (s.t === "ext") return (loopArea(s.loop) - s.holes.reduce((a, h) => a + Math.PI * h[2] * h[2], 0)) * s.d;
  if (s.t === "bar") return Math.PI * (s.r * s.r - s.ri * s.ri) * norm(sub(s.b, s.a));
  return Math.PI * s.r * s.r * s.len;
}
export const volumeOf = (solids, keep = () => true) => solids.filter(keep).reduce((a, s) => a + solidVolume(s), 0);

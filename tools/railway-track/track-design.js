/* =========================================================================
   Armamento ferroviario (Railway Track) — il tracciato da zero (tool 21, F4)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Niente DOM: si prova in Node (test/test_track_design.js). Unità: metri,
   radianti, sopraelevazione in mm nel progetto (in m nel motore, come i
   LandXML letti), velocità in km/h.

   Un tracciato disegnato (t.design) è:
   { v, s0, pis: [{ E, N, R, L1, L2, h, cc }], pvi: [{ s, z, Rv }], speeds: [{ s, V }], rules }
   - pianta a VERTICI (poligonale d'asse): primo e ultimo solo E/N; ogni vertice
     intermedio ha raggio R, clotoide d'ingresso L1 e d'uscita L2, sopraelevazione
     h (mm). L1, L2, h vuoti (null) = proposti dal tool; R vuoto = spigolo (errore);
   - curva composta (0.5.1): cc = [{ Lc, Lt, R, h }] = altri archi dallo stesso lato:
     «dopo Lc m di arco, una clotoide di raccordo di Lt m porta al raggio R», con la
     sua sopraelevazione h e la rampa sul raccordo; l'ultimo arco prende la
     deviazione che resta. Lt e h vuoti = proposti (Lt dalla minima per Δh e ΔI);
   - la curva sta fra i due lati: la forma rigida clotoide + arco + clotoide si
     calcola col motore (hEval) e le tangenti T1, T2 si ricavano risolvendo
     T1·u_in + T2·u_out = corda della forma (esatto, niente formule di scostamento);
   - livelletta a PVI (progressive assolute) con raccordi verticali circolari Rv;
   - velocità a tratti: V dalla progressiva s in poi;
   - sopraelevazione teorica h_eq = 11,8·V²/R (mm), quella dei LandXML Civil 3D;
     proposta h = k·V²/R a passi di hStep (k 7,5 e 10 mm: i file BG-PSP della
     commessa sulla linea principale), alzata se l'insufficienza supera I max,
     non oltre h max; rampa lineare sulle clotoidi, rotaia interna ferma.
   designTrack(d) → i campi di un binario come quelli letti dai LandXML (elems,
   length, profiles, prof, cant, speeds) + curve, lati e controlli.
   designFromTrack(t) → il progetto a vertici di un binario letto (rettifili e
   curve con clotoidi, anche composte; non i tracciati che finiscono in curva).
   trackLandXML(…) → LandXML 1.2 come i file Civil 3D (Line, Spiral, Curve,
   ProfAlign con CircCurve, Cant con CantStation e SpeedStation).
   ========================================================================= */
import * as C from "../railway-ocs/ocs-core.js?v=0.24.0";

export const DESIGN_V = 1;
export const HEQ_K = 11.8;                 // sopraelevazione teorica: 11,8·V²/R con 1 500 mm fra gli assi delle rotaie
/* valori di partenza, modificabili e salvati col progetto (0.5.2: quelli della norma RFI TCAR IT AR 01 001 «Norme
   tecniche per la progettazione dei tracciati ferroviari», rete fino a 200 km/h, traffico viaggiatori, come li applica
   il tabulato delle verifiche cinematiche di un progetto esecutivo RFI a 100 km/h; h max anche MdP Sez. IV §4.6.3; PIANO §11.8):
   V velocità di progetto, R raggio dei vertici nuovi; k e hStep la proposta della sopraelevazione; hMax, Imax (mm:
   Imax 92 = accelerazione non compensata 0,6 m/s²); Vmin e Emax l'eccesso di sopraelevazione alla velocità minima;
   dhdt, dIdt (mm/s), dhds (mm/m) la clotoide minima; lStep il passo delle clotoidi proposte; tMin (s) la lunghezza
   minima di rettifili e archi (V·tMin); iMax pendenza (‰); tPv (s) la lunghezza minima delle livellette;
   rvK il raccordo verticale minimo Rv = rvK·V², lvMin (m) il suo sviluppo minimo */
export const RULES = Object.freeze({ V: 100, R: 1000, k: 7.5, hStep: 10, hMax: 160, Imax: 92, Vmin: 80, Emax: 110, dhdt: 54, dIdt: 38, dhds: 2.25, lStep: 5, tMin: 1.2, iMax: 12, tPv: 2, rvK: 0.35, lvMin: 20 });
export const RULE_KEYS = Object.keys(RULES);
export const rulesOf = (r) => {
  const o = { ...RULES };
  for (const k of RULE_KEYS) if (r && Number.isFinite(r[k]) && r[k] >= 0) o[k] = r[k];
  return o;
};
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const cross = (ax, ay, bx, by) => ax * by - ay * bx;

/* ---- velocità e sopraelevazione ------------------------------------------ */
export const hEq = (V, R) => (R > 0 && V > 0 ? HEQ_K * V * V / R : 0);        // mm
/* velocità a tratti, ordinate per s; vuote → una sola, quella di partenza */
export function normSpeeds(speeds, s0 = 0, V = RULES.V) {
  const a = (speeds || []).filter((x) => x && isNum(x.s) && isNum(x.V) && x.V > 0).map((x) => ({ s: x.s, V: x.V })).sort((p, q) => p.s - q.s);
  if (!a.length) return [{ s: s0, V }];
  return a;
}
export function speedAt(speeds, s) {
  if (!speeds || !speeds.length) return NaN;
  let v = speeds[0].V;
  for (const r of speeds) { if (r.s <= s + 1e-9) v = r.V; else break; }
  return v;
}
/* la velocità più alta su [a, b] */
export function speedMax(speeds, a, b) {
  let v = speedAt(speeds, a);
  for (const r of speeds || []) if (r.s > a + 1e-9 && r.s < b - 1e-9) v = Math.max(v, r.V);
  return v;
}
/* la sopraelevazione proposta (mm) */
export function cantPropose(V, R, rules) {
  const r = rulesOf(rules), he = hEq(V, R), st = r.hStep > 0 ? r.hStep : 1;
  if (!(he > 0)) return 0;
  let h = Math.max(0, Math.round(r.k * V * V / R / st) * st);
  if (he - h > r.Imax) h = Math.ceil((he - r.Imax) / st - 1e-9) * st;
  return Math.min(h, Math.floor(r.hMax / st + 1e-9) * st);   // oltre h max l'insufficienza resta alta: lo dice il controllo
}
/* lunghezza minima (m) di un elemento percorso in t secondi a V km/h (rettifili e archi 1,2 s, livellette 2 s) */
export const lenMin = (V, t) => (V > 0 && t > 0 ? V / 3.6 * t : 0);
/* clotoide minima (m) per sopraelevazione h e insufficienza I a velocità V: dh/dt, dI/dt, dh/ds */
export function spiralMin(V, h, I, rules) {
  const r = rulesOf(rules), v = Math.max(0, V) / 3.6;
  return Math.max(r.dhdt > 0 ? h * v / r.dhdt : 0, r.dIdt > 0 ? Math.abs(I) * v / r.dIdt : 0, r.dhds > 0 ? h / r.dhds : 0);
}

/* ---- curve composte --------------------------------------------------------- */
/* gli archi di un vertice: il primo col raggio del vertice, poi quelli di p.cc = [{ Lc, Lt, R, h }]:
   «dopo Lc m di arco, una clotoide di raccordo di Lt m porta al raggio R (sopraelevazione h)».
   L'ultimo arco non ha lunghezza propria: prende la deviazione che resta. Lt vuoto = proposto */
export function arcsOf(p) {
  const out = [{ R: p.R, h: p.h, Lt: 0, ltSet: true, Lc: NaN }];
  for (const c of (p && Array.isArray(p.cc) ? p.cc : [])) {
    out[out.length - 1].Lc = c && isNum(c.Lc) ? Math.max(0, c.Lc) : 0;
    out.push({ R: c ? c.R : null, h: c ? c.h : null, Lt: c && isNum(c.Lt) ? Math.max(0, c.Lt) : null, ltSet: !!(c && isNum(c.Lt)), Lc: NaN });
  }
  return out;
}

/* ---- pianta dai vertici --------------------------------------------------- */
/* pis: [{ E, N, R, cc }], Ls: [{ L1, L2, arcs? }] già risolti (arcs: [{ R, Lc, Lt }], Lc NaN sull'ultimo) → { H, legs, curves, errs }
   curves: [{ i, sg, R, L1, L2, Lc, delta, T1, T2, uTS, uSC, uCS, uST, arcs: [{ R, Lt, Lc, u0, u1 }] }];
   sg +1 curva a sinistra, −1 a destra; R e Lc del primo arco e della somma degli archi */
export function planFromPIs(pis, Ls) {
  const n = pis.length, errs = [], legs = [];
  const P = pis.map((p) => [p.E, p.N]);
  for (let j = 0; j + 1 < n; j++) {
    const dx = P[j + 1][0] - P[j][0], dy = P[j + 1][1] - P[j][1], len = Math.hypot(dx, dy);
    legs.push({ len, th: Math.atan2(dy, dx) });
    if (!(len > 1e-6)) errs.push({ code: "same", at: "pi", i: j + 1 });
  }
  const cv = new Array(n).fill(null);
  for (let i = 1; i + 1 < n; i++) {
    const a = legs[i - 1], b = legs[i];
    if (!(a.len > 1e-6) || !(b.len > 1e-6)) continue;
    const d = wrap(b.th - a.th);
    if (Math.abs(d) < 1e-9) continue;                                   // vertice sulla retta: niente curva
    const R = pis[i].R;
    if (!(R > 0)) { errs.push({ code: "noR", at: "pi", i }); continue; }   // spigolo
    if (Math.abs(d) > Math.PI - 1e-6) { errs.push({ code: "back", at: "pi", i }); continue; }
    const arcs = (Ls[i].arcs && Ls[i].arcs.length ? Ls[i].arcs : [{ R, Lt: 0, Lc: NaN }]).map((x) => ({ R: x.R, Lt: Math.max(0, x.Lt || 0), Lc: x.Lc }));
    const badArc = arcs.findIndex((x) => !(x.R > 0));
    if (badArc > 0) { errs.push({ code: "noR", at: "pi", i, j: badArc }); continue; }
    const n1 = arcs.length - 1, L1 = Math.max(0, Ls[i].L1 || 0), L2 = Math.max(0, Ls[i].L2 || 0), sg = Math.sign(d);
    // deviazione presa da clotoidi, archi fissi e raccordi; l'ultimo arco prende il resto
    let used = L1 / (2 * arcs[0].R) + L2 / (2 * arcs[n1].R);
    for (let j = 0; j <= n1; j++) {
      if (j < n1) used += Math.max(0, arcs[j].Lc || 0) / arcs[j].R;
      if (j > 0) used += arcs[j].Lt * (1 / arcs[j - 1].R + 1 / arcs[j].R) / 2;
    }
    const alpha = Math.abs(d) - used;
    if (alpha < -1e-12) { errs.push({ code: "spiral", at: "pi", i, need: used, got: Math.abs(d) }); continue; }
    arcs[n1].Lc = arcs[n1].R * Math.max(0, alpha);
    // la forma da (0, 0) con la direzione del lato d'ingresso
    const shape = [];
    let x = 0, y = 0, th = a.th, u = 0;
    const add = (t, len, k0, k1) => {
      if (!(len > 1e-9)) return;
      const e = { t, x0: x, y0: y, th0: th, len, k0, k1 };
      shape.push(e);
      const f = C.hEval(e, len); x = f.x; y = f.y; th = f.th;
      u += len;
    };
    add("C", L1, 0, sg / arcs[0].R);
    for (let j = 0; j <= n1; j++) {
      const k = sg / arcs[j].R;
      if (j > 0) add("C", arcs[j].Lt, sg / arcs[j - 1].R, k);
      arcs[j].u0 = u; add("A", Math.max(0, arcs[j].Lc), k, k); arcs[j].u1 = u;
    }
    add("C", L2, sg / arcs[n1].R, 0);
    const s = Math.sin(d), uix = Math.cos(a.th), uiy = Math.sin(a.th), uox = Math.cos(b.th), uoy = Math.sin(b.th);
    const T1 = cross(x, y, uox, uoy) / s, T2 = cross(uix, uiy, x, y) / s;
    cv[i] = { i, sg, R, L1, L2, Lc: arcs.reduce((t, x) => t + Math.max(0, x.Lc), 0), delta: Math.abs(d), T1, T2, shape, arcs };
  }
  /* curve che non ci stanno sul lato: errore, e si sospende la curva che non ci sta (resta lo spigolo della poligonale,
     come per gli altri errori di geometria) invece di disegnarle sovrapposte: con raggi grandi e deviazione cresciuta le
     tangenti diventano chilometri e il tracciato «impazzirebbe». Si toglie una curva alla volta, quella con la tangente
     più lunga sui lati sbagliati, finché i lati tornano a posto: le curve sane vicine restano */
  const free = (j) => legs[j].len - (cv[j] ? cv[j].T2 : 0) - (cv[j + 1] ? cv[j + 1].T1 : 0);
  const bad = () => legs.map((_, j) => j).filter((j) => legs[j].len > 1e-6 && free(j) < -1e-6);
  for (const j of bad()) errs.push({ code: "overlap", at: "leg", i: j, need: legs[j].len - free(j), got: legs[j].len });
  for (let b = bad(); b.length; b = bad()) {
    let worst = -1, wT = -1;
    for (const j of b) for (const [i, T] of [[j, cv[j] ? cv[j].T2 : -1], [j + 1, cv[j + 1] ? cv[j + 1].T1 : -1]]) if (T > wT) { wT = T; worst = i; }
    if (worst < 0) break;
    cv[worst] = null;
  }
  for (let j = 0; j < legs.length; j++) legs[j].tan = free(j);
  const elems = [], curves = [];
  let u = 0;
  for (let j = 0; j < legs.length; j++) {
    const lg = legs[j], a = cv[j] ? cv[j].T2 : 0, tl = lg.tan;
    lg.u0 = u;                                                         // progressiva (dal capo) dell'inizio del rettifilo
    if (tl > 1e-9) {
      elems.push({ t: "L", x0: P[j][0] + a * Math.cos(lg.th), y0: P[j][1] + a * Math.sin(lg.th), th0: lg.th, len: tl, k0: 0, k1: 0 });
      u += tl;
    }
    const c = cv[j + 1];
    if (!c) continue;
    let x = P[j + 1][0] - c.T1 * Math.cos(lg.th), y = P[j + 1][1] - c.T1 * Math.sin(lg.th), th = lg.th;
    const { shape, ...rec } = c;
    rec.arcs = c.arcs.map((x) => ({ ...x, u0: u + x.u0, u1: u + x.u1 }));
    rec.uTS = u; rec.uSC = u + c.L1; rec.uCS = rec.arcs[rec.arcs.length - 1].u1; rec.uST = rec.uCS + c.L2;
    for (const e of shape) {
      const g = { ...e, x0: x, y0: y, th0: th };
      elems.push(g);
      const f = C.hEval(g, g.len); x = f.x; y = f.y; th = f.th;
      u += g.len;
    }
    curves.push(rec);
  }
  return { H: C.hAlign(elems), legs, curves, errs };
}

/* ---- tracciato disegnato → binario ---------------------------------------- */
/* i valori di ogni vertice: V, h_eq, h, I, clotoide minima, L1, L2 (proposti dove vuoti), e per ogni arco
   (curve composte) R, h_eq, h, I, Lc e il raccordo Lt dal precedente, con la sua minima per Δh e ΔI.
   I campi del vertice (he, h, I, Lmin) sono del primo arco; Lmin2 quella della clotoide d'uscita (ultimo arco) */
const ceilStep = (v, st) => (v > 1e-9 ? Math.ceil(v / (st || 1) - 1e-9) * (st || 1) : 0);
function resolve(pis, Vof, r, s0, speeds) {
  return pis.map((p, i) => {
    if (i === 0 || i === pis.length - 1 || !(p.R > 0)) return { V: NaN, he: 0, h: 0, I: 0, Lmin: 0, Lmin2: 0, L1: 0, L2: 0, hAuto: false, L1Auto: false, L2Auto: false, arcs: [] };
    const V = Vof.has(i) ? Vof.get(i) : speedAt(speeds, s0);
    const arcs = arcsOf(p).map((a) => {
      const ok = a.R > 0, he = ok ? hEq(V, a.R) : 0, h = isNum(a.h) ? Math.max(0, a.h) : ok ? cantPropose(V, a.R, r) : 0;
      return { R: a.R, Lc: a.Lc, Lt: a.Lt, LtAuto: !a.ltSet, he, h, I: he - h, hAuto: !isNum(a.h) };
    });
    for (let j = 1; j < arcs.length; j++) {
      const a = arcs[j], b = arcs[j - 1];
      a.LtMin = spiralMin(V, Math.abs(a.h - b.h), Math.abs(a.I - b.I), r);
      if (a.LtAuto) a.Lt = ceilStep(a.LtMin, r.lStep);
    }
    const f = arcs[0], z = arcs[arcs.length - 1];
    const Lmin = spiralMin(V, f.h, f.I, r), Lmin2 = spiralMin(V, z.h, z.I, r);
    return { V, he: f.he, h: f.h, I: f.I, Lmin, Lmin2, L1: isNum(p.L1) ? Math.max(0, p.L1) : ceilStep(Lmin, r.lStep), L2: isNum(p.L2) ? Math.max(0, p.L2) : ceilStep(Lmin2, r.lStep), hAuto: f.hAuto, L1Auto: !isNum(p.L1), L2Auto: !isNum(p.L2), arcs };
  });
}
/* le clotoidi proposte non devono mangiarsi la curva: sulle deviazioni piccole si accorciano (il controllo lo dice).
   Nelle curve composte la deviazione libera è quella che resta dopo archi fissi e raccordi */
function fitAuto(pis, res) {
  const n = pis.length;
  for (let i = 1; i + 1 < n; i++) {
    const x = res[i], p = pis[i];
    if (!(p.R > 0) || !(x.L1Auto || x.L2Auto) || x.arcs.some((a) => !(a.R > 0))) continue;
    const a = [pis[i - 1].E, pis[i - 1].N], b = [p.E, p.N], c = [pis[i + 1].E, pis[i + 1].N];
    const d = Math.abs(wrap(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0])));
    const A = x.arcs, R1 = A[0].R, Rn = A[A.length - 1].R;
    let fixed = (x.L1Auto ? 0 : x.L1 / (2 * R1)) + (x.L2Auto ? 0 : x.L2 / (2 * Rn));
    for (let j = 0; j < A.length; j++) {
      if (j + 1 < A.length) fixed += Math.max(0, A[j].Lc || 0) / A[j].R;
      if (j > 0) fixed += A[j].Lt * (1 / A[j - 1].R + 1 / A[j].R) / 2;
    }
    const room = d - fixed, want = (x.L1Auto ? x.L1 / (2 * R1) : 0) + (x.L2Auto ? x.L2 / (2 * Rn) : 0);
    if (want > room && want > 0) {
      const f = Math.max(0, room) / want;
      if (x.L1Auto) x.L1 *= f;
      if (x.L2Auto) x.L2 *= f;
      x.fit = true;
    }
  }
}
export function designTrack(d) {
  const r = rulesOf(d && d.rules), s0 = (d && isNum(d.s0)) ? d.s0 : 0, pis = (d && d.pis) || [];
  const speeds = normSpeeds(d && d.speeds, s0, r.V);
  const checks = [];
  if (pis.length < 2) checks.push({ lvl: "err", code: "few" });
  // velocità delle curve dalla loro estensione: si ricalcola finché non cambia (2-3 giri)
  let Vof = new Map(), res = null, pl = null;
  for (let it = 0; it < 4; it++) {
    res = resolve(pis, Vof, r, s0, speeds); fitAuto(pis, res);
    pl = pis.length >= 2 ? planFromPIs(pis, res) : { H: C.hAlign([]), legs: [], curves: [], errs: [] };
    const nv = new Map(pl.curves.map((c) => [c.i, speedMax(speeds, s0 + c.uTS, s0 + c.uST)]));
    const same = nv.size === Vof.size && [...nv].every(([k, v]) => Vof.get(k) === v);
    Vof = nv;
    if (same && it > 0) break;
  }
  for (const e of pl.errs) checks.push({ lvl: "err", ...e });
  const L = pl.H.length;
  // sopraelevazione: rampe lineari sulle clotoidi
  const st = [{ u: 0, c: 0, dir: 0 }];
  const curves = pl.curves.map((c) => {
    const x = res[c.i], n1 = c.arcs.length - 1;
    // per ogni arco i valori risolti (h, I, raccordo) con la posizione della pianta
    const arcs = c.arcs.map((g, j) => ({ ...g, he: x.arcs[j].he, h: x.arcs[j].h, I: x.arcs[j].I, hAuto: x.arcs[j].hAuto, LtAuto: x.arcs[j].LtAuto, LtMin: j > 0 ? x.arcs[j].LtMin : 0 }));
    const out = { ...c, arcs, V: x.V, he: x.he, h: Math.max(...arcs.map((g) => g.h)), I: x.I, Lmin: x.Lmin, Lmin2: x.Lmin2, hAuto: x.hAuto, L1Auto: x.L1Auto, L2Auto: x.L2Auto, fit: !!x.fit };
    const sub = (j) => (n1 > 0 ? { j } : {});                // nelle curve composte i controlli dicono anche l'arco
    if (arcs.some((g) => g.h > 0) && ((arcs[0].h > 0 && c.L1 <= 1e-9) || (arcs[n1].h > 0 && c.L2 <= 1e-9))) {
      checks.push({ lvl: "err", code: "ramp", at: "pi", i: c.i }); out.hOff = true;
    } else if (arcs.some((g) => g.h > 0)) {
      // rampe lineari sulle clotoidi d'ingresso, di raccordo e d'uscita; senza raccordo il salto di h è un errore (resta, si vede)
      st.push({ u: c.uTS, c: 0, dir: c.sg });
      arcs.forEach((g, j) => {
        if (j > 0 && g.Lt <= 1e-9 && Math.abs(g.h - arcs[j - 1].h) > 1e-9) checks.push({ lvl: "err", code: "step", at: "pi", i: c.i, j, need: arcs[j - 1].h, got: g.h });
        st.push({ u: g.u0, c: g.h / 1000, dir: c.sg }, { u: g.u1, c: g.h / 1000, dir: c.sg });
      });
      st.push({ u: c.uST, c: 0, dir: c.sg });
    }
    // raggio minimo 11,8·V²/(h max + I max), eccesso di sopraelevazione alla velocità minima, arco lungo almeno V·tMin
    const rMin = x.V > 0 ? HEQ_K * x.V * x.V / Math.max(1e-9, r.hMax + r.Imax) : 0, Ve = Math.min(r.Vmin, x.V), aMin = lenMin(x.V, r.tMin);
    arcs.forEach((g, j) => {
      if (g.h > r.hMax + 1e-9) checks.push({ lvl: "warn", code: "hMax", at: "pi", i: c.i, ...sub(j), need: r.hMax, got: g.h });
      if (g.I > r.Imax + 1e-9) checks.push({ lvl: "warn", code: "iMax", at: "pi", i: c.i, ...sub(j), need: r.Imax, got: g.I });
      if (j > 0 && g.Lt > 1e-9 && g.Lt < g.LtMin - 1e-6) checks.push({ lvl: "warn", code: "Lt", at: "pi", i: c.i, j, need: g.LtMin, got: g.Lt });
      if (g.R < rMin - 1e-6) checks.push({ lvl: "warn", code: "rMin", at: "pi", i: c.i, ...sub(j), need: rMin, got: g.R });
      const E = g.h - hEq(Ve, g.R);
      if (Ve > 0 && E > r.Emax + 1e-9) checks.push({ lvl: "warn", code: "eMax", at: "pi", i: c.i, ...sub(j), need: r.Emax, got: E, v: Ve });
      if (g.Lc < aMin - 1e-6) checks.push({ lvl: "warn", code: "lenA", at: "pi", i: c.i, ...sub(j), need: aMin, got: Math.max(0, g.Lc) });
    });
    if (c.L1 < x.Lmin - 1e-6) checks.push({ lvl: "warn", code: "L1", at: "pi", i: c.i, need: x.Lmin, got: c.L1 });
    if (c.L2 < x.Lmin2 - 1e-6) checks.push({ lvl: "warn", code: "L2", at: "pi", i: c.i, need: x.Lmin2, got: c.L2 });
    return out;
  });
  st.push({ u: L, c: 0, dir: 0 });
  st.sort((a, b) => a.u - b.u);
  // rettifili fra due curve lunghi almeno V·tMin (non i capi del tracciato; rettifilo 0 = curve di seguito, ammesso)
  pl.legs.forEach((lg, j) => {
    if (j === 0 || j === pl.legs.length - 1 || !(lg.tan > 1e-6)) return;
    const need = lenMin(speedMax(speeds, s0 + lg.u0, s0 + lg.u0 + lg.tan), r.tMin);
    if (lg.tan < need - 1e-6) checks.push({ lvl: "warn", code: "lenL", at: "leg", i: j, need, got: lg.tan });
  });
  // livelletta
  const pv = ((d && d.pvi) || []).filter((p) => p && isNum(p.s) && isNum(p.z)).slice().sort((a, b) => a.s - b.s);
  if (pv.length < 2) checks.push({ lvl: "err", code: "pvFew" });
  const g = [];
  for (let i = 0; i + 1 < pv.length; i++) {
    const ds = pv[i + 1].s - pv[i].s;
    if (!(ds > 1e-6)) { checks.push({ lvl: "err", code: "pvSame", at: "pvi", i: i + 1 }); g.push(0); continue; }
    g.push((pv[i + 1].z - pv[i].z) / ds);
    if (Math.abs(g[i]) * 1000 > r.iMax + 1e-9) checks.push({ lvl: "warn", code: "grade", at: "pvl", i, need: r.iMax, got: Math.abs(g[i]) * 1000 });
  }
  const Lv = pv.map((p, i) => (i > 0 && i + 1 < pv.length && p.Rv > 0 ? p.Rv * Math.abs(g[i] - g[i - 1]) : 0));
  for (let i = 1; i + 1 < pv.length; i++) {
    const dg = Math.abs(g[i] - g[i - 1]), V = speedAt(speeds, pv[i].s), rvMin = r.rvK * V * V;
    if (pv[i].Rv > 0) { if (pv[i].Rv < rvMin - 1e-6) checks.push({ lvl: "warn", code: "rvMin", at: "pvi", i, need: rvMin, got: pv[i].Rv }); }
    else if (dg > 1e-6) checks.push({ lvl: "warn", code: "rvNone", at: "pvi", i });
  }
  for (let i = 0; i + 1 < pv.length; i++) {
    const room = pv[i + 1].s - pv[i].s, need = Lv[i] / 2 + Lv[i + 1] / 2;
    if (need > room + 1e-6) { checks.push({ lvl: "err", code: "rvOverlap", at: "pvl", i, need, got: room }); continue; }
    // livelletta (fra i raccordi) lunga almeno V·tPv
    const a = pv[i].s + Lv[i] / 2, b = pv[i + 1].s - Lv[i + 1] / 2, lm = lenMin(speedMax(speeds, a, b), r.tPv);
    if (b - a < lm - 1e-6) checks.push({ lvl: "warn", code: "lenPv", at: "pvl", i, need: lm, got: b - a });
  }
  for (let i = 1; i + 1 < pv.length; i++) if (Lv[i] > 1e-9 && Lv[i] < r.lvMin - 1e-6) checks.push({ lvl: "warn", code: "lvMin", at: "pvi", i, need: r.lvMin, got: Lv[i] });
  if (pv.length >= 2 && L > 0 && (pv[0].s > s0 + 1e-3 || pv[pv.length - 1].s < s0 + L - 1e-3)) checks.push({ lvl: "warn", code: "pvShort", need: L, got: pv[pv.length - 1].s - pv[0].s });
  const prof = { name: (d && d.profName) || "Livelletta", pvi: pv.map((p, i) => ({ u: p.s - s0, z: p.z, L: 0, R: i > 0 && i + 1 < pv.length && p.Rv > 0 ? p.Rv : 0 })) };
  return {
    H: pl.H, elems: pl.H.segs, length: L, legs: pl.legs, curves,
    profiles: [prof], prof: 0, cant: { gauge: 1.5, rot: "insideRail", st }, speeds: speeds.map((x) => ({ u: x.s - s0, v: x.V })),
    vcurves: pv.map((p, i) => ({ i, s: p.s, z: p.z, Rv: p.Rv > 0 ? p.Rv : 0, Lv: Lv[i], g0: i > 0 ? g[i - 1] : NaN, g1: i < g.length ? g[i] : NaN })),
    checks, rules: r, s0,
  };
}
/* un tracciato nuovo dai punti cliccati: vertici intermedi col raggio di partenza, livelletta piana a quota z.
   Dove le curve non ci stanno sul lato (vertici vicini), il raggio dei due vertici scende a passi del 15 % (a 10 m,
   non sotto 10 m): il tracciato nasce senza errori di geometria; gli avvisi su h e I restano, a dire che è stretto */
export function newDesign(points, opt = {}) {
  const r = rulesOf(opt.rules), s0 = isNum(opt.s0) ? opt.s0 : 0;
  const pis = points.map((p, i) => ({ E: p[0], N: p[1], R: i > 0 && i + 1 < points.length ? r.R : null, L1: null, L2: null, h: null }));
  const d = { v: DESIGN_V, s0, pis, pvi: [], speeds: [{ s: s0, V: r.V }], rules: opt.rules ? { ...opt.rules } : {} };
  for (let it = 0; it < 80; it++) {
    const bad = new Set();
    for (const c of designTrack(d).checks) if (c.code === "overlap") { bad.add(c.i); bad.add(c.i + 1); }
    const fix = [...bad].filter((i) => i > 0 && i + 1 < pis.length && pis[i].R > 10);
    if (!fix.length) break;
    for (const i of fix) pis[i].R = Math.max(10, Math.floor(pis[i].R * 0.85 / 10) * 10);
  }
  const L = designTrack(d).length, z = isNum(opt.z) ? opt.z : 0;
  d.pvi = [{ s: s0, z, Rv: null }, { s: s0 + L, z, Rv: null }];
  return d;
}

/* il raggio del vertice i scende (passi del 15 %, a 10 m, non sotto 10 m) finché le curve ci stanno sui suoi due lati:
   per un vertice aggiunto in mezzo a un lato. Cambia d sul posto e lo ritorna */
export function fitRadius(d, i) {
  const p = d.pis[i];
  if (!p || i <= 0 || i >= d.pis.length - 1 || !(p.R > 0)) return d;
  for (let it = 0; it < 80 && p.R > 10; it++) {
    if (!designTrack(d).checks.some((c) => c.code === "overlap" && (c.i === i - 1 || c.i === i))) break;
    p.R = Math.max(10, Math.floor(p.R * 0.85 / 10) * 10);
  }
  return d;
}

/* ---- binario letto → vertici ---------------------------------------------- */
const isLineSeg = (e) => e.t === "L" || (Math.abs(e.k0) < 1e-12 && Math.abs(e.k1) < 1e-12);
const zero = (k) => Math.abs(k) < 1e-12;
/* stessa curvatura ai capi di due elementi: i LandXML scrivono i raggi arrotondati (Bin2: clotoide fino a 649,1, arco
   649,2), quindi 1/1000 relativo; la geometria si rifà dai raggi degli archi e lo scarto lo dice la conversione */
const nearK = (a, b) => Math.abs(a - b) <= 1e-3 * Math.max(Math.abs(a), Math.abs(b), 1e-12) + 1e-15;
/* t: { elems (segmenti di pianta), s0, cant: { st }, speeds: [{ u, v }], profiles, prof }
   → { design, issues: [{ code, u }] }; design = null se la pianta non si può fare a vertici */
export function designFromTrack(t, rules) {
  const segs = t.elems || [], s0 = t.s0 || 0, issues = [];
  if (!segs.length) return { design: null, issues: [{ code: "empty", u: 0 }] };
  // gruppi: rettifili e curve (una curva si chiude dove una clotoide arriva a curvatura 0 e la dopo riparte da 0)
  const groups = [];
  let cur = null;
  for (let k = 0; k < segs.length; k++) {
    const e = segs[k];
    if (isLineSeg(e)) { if (cur) groups.push(cur); cur = null; groups.push({ line: true, a: k, b: k }); continue; }
    if (cur && zero(segs[cur.b].k1) && zero(e.k0)) { groups.push(cur); cur = null; }
    if (!cur) cur = { line: false, a: k, b: k }; else cur.b = k;
  }
  if (cur) groups.push(cur);
  if (!groups[0].line) issues.push({ code: "startCurve", u: 0 });
  if (!groups[groups.length - 1].line) issues.push({ code: "endCurve", u: segs[segs.length - 1].u0 + segs[segs.length - 1].len });
  const end = (e) => C.hEval(e, e.len);
  const pis = [{ E: segs[0].x0, N: segs[0].y0, R: null, L1: null, L2: null, h: null }];
  const cantSt = (t.cant && t.cant.st) || [];
  let prevLine = null;
  for (const gr of groups) {
    if (gr.line) {
      const e = segs[gr.a];
      if (prevLine) {                                              // due rettifili di seguito: spigolo o stessa retta
        const d = wrap(e.th0 - prevLine.th0);
        if (Math.abs(d) > 1e-9) { pis.push({ E: e.x0, N: e.y0, R: null, L1: null, L2: null, h: null }); issues.push({ code: "kink", u: e.u0 }); }
      }
      prevLine = e;
      continue;
    }
    prevLine = null;
    const E = segs.slice(gr.a, gr.b + 1);
    // forma ammessa: [clotoide 0 → k1] arco k1 ([clotoide k1 → k2] arco k2 …) [clotoide kn → 0], archi dallo stesso lato;
    // anche senza archi (clotoide 0 → k → 0). Fra due archi la clotoide di raccordo può mancare (salto di raggio)
    let L1 = 0, L2 = 0, kEnd = NaN, ok = true, q = 0, Lt = null;
    const arcs = [];                                               // [{ k, Lc, Lt, u0 }]
    if (E[q] && E[q].t === "C" && zero(E[q].k0)) { L1 = E[q].len; kEnd = E[q].k1; q++; }
    for (; q < E.length && ok; q++) {
      const e = E[q];
      if (e.t === "A") {
        if (!Number.isNaN(kEnd) && !(arcs.length && Lt === null)) ok = nearK(e.k0, kEnd);
        arcs.push({ k: e.k0, Lc: e.len, Lt: Lt || 0, u0: e.u0 });
        Lt = null; kEnd = e.k0;
      } else if (e.t === "C" && zero(e.k1)) {
        ok = Lt === null && (Number.isNaN(kEnd) || nearK(e.k0, kEnd));
        if (Number.isNaN(kEnd)) kEnd = e.k0;
        L2 = e.len; q++; break;
      } else if (e.t === "C" && arcs.length && Lt === null && nearK(e.k0, kEnd)) { Lt = e.len; kEnd = e.k1; }
      else ok = false;
    }
    if (!arcs.length && !Number.isNaN(kEnd)) arcs.push({ k: kEnd, Lc: 0, Lt: 0, u0: E[0].u0 + L1 });
    const sg = arcs.length ? Math.sign(arcs[0].k) : 0;
    if (q !== E.length || !ok || Lt !== null || !arcs.length || arcs.some((x) => !(Math.abs(x.k) > 0) || Math.sign(x.k) !== sg)) { issues.push({ code: "compound", u: E[0].u0 }); return { design: null, issues }; }
    const a = E[0], z = end(E[E.length - 1]);
    const ux = Math.cos(a.th0), uy = Math.sin(a.th0), vx = Math.cos(z.th), vy = Math.sin(z.th), den = cross(ux, uy, vx, vy);
    if (!(Math.abs(den) > 1e-12)) { issues.push({ code: "flat", u: a.u0 }); return { design: null, issues }; }
    const T1 = cross(z.x - a.x0, z.y - a.y0, vx, vy) / den;
    const hOf = (x) => Math.round(C.cantAt(cantSt, x.u0 + x.Lc / 2).c * 1000 * 1e6) / 1e6;
    const pi = { E: a.x0 + T1 * ux, N: a.y0 + T1 * uy, R: 1 / Math.abs(arcs[0].k), L1, L2, h: hOf(arcs[0]) };
    if (arcs.length > 1) pi.cc = arcs.slice(1).map((x, j) => ({ Lc: arcs[j].Lc, Lt: x.Lt, R: 1 / Math.abs(x.k), h: hOf(x) }));
    pis.push(pi);
  }
  const last = segs[segs.length - 1], ze = end(last);
  pis.push({ E: ze.x, N: ze.y, R: null, L1: null, L2: null, h: null });
  // velocità: punti (u, v) del file → tratti
  const speeds = [];
  for (const p of (t.speeds || []).slice().sort((a, b) => a.u - b.u)) if (!speeds.length || speeds[speeds.length - 1].V !== p.v) speeds.push({ s: s0 + p.u, V: p.v });
  if (speeds.length) speeds[0].s = Math.min(speeds[0].s, s0);
  // livelletta: raccordi parabolici resi circolari con lo stesso Rv medio
  const pr = t.profiles && t.prof >= 0 ? t.profiles[t.prof] : null, src = pr ? pr.pvi.slice().sort((a, b) => a.u - b.u) : [];
  const pvi = src.map((p, i) => {
    let Rv = p.R > 0 ? p.R : 0;
    if (!Rv && p.L > 0 && i > 0 && i + 1 < src.length) {
      const g0 = (p.z - src[i - 1].z) / (p.u - src[i - 1].u), g1 = (src[i + 1].z - p.z) / (src[i + 1].u - p.u);
      if (Math.abs(g1 - g0) > 1e-12) { Rv = p.L / Math.abs(g1 - g0); issues.push({ code: "para", u: p.u }); }
    }
    return { s: s0 + p.u, z: p.z, Rv: Rv || null };
  });
  const design = { v: DESIGN_V, s0, pis, pvi, speeds, rules: rules ? { ...rules } : {}, profName: pr ? pr.name : "" };
  return { design, issues };
}

/* ---- LandXML 1.2 ----------------------------------------------------------- */
const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fx = (v, n = 9) => { const s = (Math.abs(v) < 0.5 * Math.pow(10, -n) ? 0 : v).toFixed(n); return s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, ".0") : s; };
const NE = (x, y) => `${fx(y, 9)} ${fx(x, 9)}`;
const deg = (a) => { let d = (a * 180 / Math.PI) % 360; if (d < 0) d += 360; return d; };   // da Est, antiorario (i file Civil 3D BG-PSP)
const rot = (k) => (k < 0 ? "cw" : "ccw");
/* gli elementi di pianta in LandXML */
function coordGeom(segs, I) {
  const out = [];
  for (const e of segs) {
    const z = C.hEval(e, e.len);
    if (isLineSeg(e)) {
      out.push(`${I}<Line dir="${fx(deg(e.th0))}" length="${fx(e.len)}">`, `${I}\t<Start>${NE(e.x0, e.y0)}</Start>`, `${I}\t<End>${NE(z.x, z.y)}</End>`, `${I}</Line>`);
    } else if (e.t === "A") {
      const R = 1 / Math.abs(e.k0), D = Math.abs(e.k0) * e.len, cx = e.x0 - Math.sin(e.th0) / e.k0, cy = e.y0 + Math.cos(e.th0) / e.k0, T = R * Math.tan(D / 2);
      out.push(`${I}<Curve rot="${rot(e.k0)}" chord="${fx(2 * R * Math.sin(D / 2))}" crvType="arc" delta="${fx(D * 180 / Math.PI)}" dirEnd="${fx(deg(z.th))}" dirStart="${fx(deg(e.th0))}" external="${fx(R * (1 / Math.cos(D / 2) - 1))}" length="${fx(e.len)}" midOrd="${fx(R * (1 - Math.cos(D / 2)))}" radius="${fx(R)}" tangent="${fx(T)}">`,
        `${I}\t<Start>${NE(e.x0, e.y0)}</Start>`, `${I}\t<Center>${NE(cx, cy)}</Center>`, `${I}\t<End>${NE(z.x, z.y)}</End>`, `${I}\t<PI>${NE(e.x0 + T * Math.cos(e.th0), e.y0 + T * Math.sin(e.th0))}</PI>`, `${I}</Curve>`);
    } else {
      // clotoide: PI = incontro delle tangenti ai capi; totalX/Y e tanLong/Short dal capo a curvatura minore
      const ux = Math.cos(e.th0), uy = Math.sin(e.th0), vx = Math.cos(z.th), vy = Math.sin(z.th), den = cross(ux, uy, vx, vy);
      const t1 = Math.abs(den) > 1e-12 ? cross(z.x - e.x0, z.y - e.y0, vx, vy) / den : e.len * 2 / 3;
      const pix = e.x0 + t1 * ux, piy = e.y0 + t1 * uy;
      const dS = Math.hypot(pix - e.x0, piy - e.y0), dE = Math.hypot(z.x - pix, z.y - piy), inward = Math.abs(e.k0) <= Math.abs(e.k1);
      let X, Y;
      if (inward) { const dx = z.x - e.x0, dy = z.y - e.y0; X = dx * ux + dy * uy; Y = Math.abs(cross(ux, uy, dx, dy)); }
      else { const dx = e.x0 - z.x, dy = e.y0 - z.y; X = -(dx * vx + dy * vy); Y = Math.abs(cross(vx, vy, dx, dy)); }
      const rs = zero(e.k0) ? "INF" : fx(1 / Math.abs(e.k0)), re = zero(e.k1) ? "INF" : fx(1 / Math.abs(e.k1)), kk = zero(e.k1) ? e.k0 : e.k1;
      out.push(`${I}<Spiral length="${fx(e.len)}" radiusEnd="${re}" radiusStart="${rs}" rot="${rot(kk)}" spiType="clothoid" theta="${fx(Math.abs(z.th - e.th0) * 180 / Math.PI)}" totalY="${fx(Y)}" totalX="${fx(X)}" tanLong="${fx(inward ? dS : dE)}" tanShort="${fx(inward ? dE : dS)}">`,
        `${I}\t<Start>${NE(e.x0, e.y0)}</Start>`, `${I}\t<PI>${NE(pix, piy)}</PI>`, `${I}\t<End>${NE(z.x, z.y)}</End>`, `${I}</Spiral>`);
    }
  }
  return out;
}
/* alignments: [{ name, desc, s0, elems, length, pvi (del motore: u, z, L, R), profName, cant: { gauge, rot, st }, speeds: [{ u, v }] }]
   stamp: { date: "AAAA-MM-GG", time: "hh:mm:ss" } */
export function trackLandXML({ alignments, stamp, project = "", app = "viewifc.com — Armamento ferroviario" }) {
  const T = "\t", body = [], seen = new Set();
  for (const a of alignments) {
    let nm = String(a.name || "Asse"), n = 2;
    while (seen.has(nm)) nm = `${a.name} (${n++})`;
    seen.add(nm);
    const s0 = a.s0 || 0, L = a.length != null ? a.length : a.elems.reduce((s, e) => s + e.len, 0), H = { segs: a.elems, length: L };
    body.push(`${T}${T}<Alignment name="${xmlEsc(nm)}" length="${fx(L)}" staStart="${fx(s0)}"${a.desc ? ` desc="${xmlEsc(a.desc)}"` : ""}>`, `${T}${T}${T}<CoordGeom>`, ...coordGeom(a.elems, T.repeat(4)), `${T}${T}${T}</CoordGeom>`);
    const pv = (a.pvi || []).slice().sort((p, q) => p.u - q.u);
    if (pv.length >= 2) {
      const pn = xmlEsc(a.profName || nm);
      body.push(`${T}${T}${T}<Profile name="${xmlEsc(nm)}">`, `${T}${T}${T}${T}<ProfAlign name="${pn}">`);
      pv.forEach((p, i) => {
        const sz = `${fx(s0 + p.u)} ${fx(p.z)}`;
        if (i > 0 && i + 1 < pv.length && (p.R > 0 || p.L > 0)) {
          const g0 = (p.z - pv[i - 1].z) / (p.u - pv[i - 1].u), g1 = (pv[i + 1].z - p.z) / (pv[i + 1].u - p.u), dg = Math.abs(g1 - g0);
          if (dg > 1e-12 && p.R > 0) { body.push(`${T}${T}${T}${T}${T}<CircCurve length="${fx(p.R * dg)}" radius="${fx(p.R)}">${sz}</CircCurve>`); return; }
          if (dg > 1e-12 && p.L > 0) { body.push(`${T}${T}${T}${T}${T}<ParaCurve length="${fx(p.L)}">${sz}</ParaCurve>`); return; }
        }
        body.push(`${T}${T}${T}${T}${T}<PVI>${sz}</PVI>`);
      });
      body.push(`${T}${T}${T}${T}</ProfAlign>`, `${T}${T}${T}</Profile>`);
    }
    const st = ((a.cant && a.cant.st) || []).slice().sort((p, q) => p.u - q.u), sp = (a.speeds || []).slice().sort((p, q) => p.u - q.u);
    if (st.length || sp.length) {
      const vAt = (u) => { let v = sp.length ? sp[0].v : NaN; for (const x of sp) { if (x.u <= u + 1e-9) v = x.v; else break; } return v; };
      body.push(`${T}${T}${T}<Cant name="${xmlEsc(nm)}" gauge="${fx((a.cant && a.cant.gauge) || 1.5)}" rotationPoint="${xmlEsc((a.cant && a.cant.rot) || "insideRail")}">`);
      st.forEach((c, i) => {
        const V = vAt(c.u), hk = C.hAt(H, Math.max(0, Math.min(L, c.u))), k = hk ? Math.abs(hk.k) : 0, he = Number.isFinite(V) ? HEQ_K * V * V * k : NaN;
        const grad = i > 0 && c.u - st[i - 1].u > 1e-9 ? (c.c - st[i - 1].c) / (c.u - st[i - 1].u) : 0, cur = c.dir > 0 ? "ccw" : c.dir < 0 ? "cw" : hk && hk.k ? rot(hk.k) : "";
        const ex = Number.isFinite(he) ? ` equilibriumCant="${fx(he)}" appliedCant="${fx(c.c * 1000)}" cantDeficiency="${fx(he - c.c * 1000)}" cantGradient="${fx(grad)}" speed="${fx(V)}"` : ` appliedCant="${fx(c.c * 1000)}" cantGradient="${fx(grad)}"`;
        body.push(`${T}${T}${T}${T}<CantStation station="${fx(s0 + c.u)}"${ex}${cur ? ` curvature="${cur}"` : ""}></CantStation>`);
      });
      for (const x of sp) body.push(`${T}${T}${T}${T}<SpeedStation station="${fx(s0 + x.u)}" speed="${fx(x.v)}"></SpeedStation>`);
      body.push(`${T}${T}${T}</Cant>`);
    }
    body.push(`${T}${T}</Alignment>`);
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.landxml.org/schema/LandXML-1.2 http://www.landxml.org/schema/LandXML-1.2/LandXML-1.2.xsd" date="${stamp.date}" time="${stamp.time}" version="1.2">`,
    `${T}<Units>`,
    `${T}${T}<Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="milliBars" diameterUnit="millimeter" angularUnit="decimal degrees" directionUnit="decimal degrees"></Metric>`,
    `${T}</Units>`,
    ...(project ? [`${T}<Project name="${xmlEsc(project)}"></Project>`] : []),
    `${T}<Application name="${xmlEsc(app)}" manufacturer="viewifc.com"></Application>`,
    `${T}<Alignments>`,
    ...body,
    `${T}</Alignments>`,
    "</LandXML>",
    "",
  ].join("\n");
}

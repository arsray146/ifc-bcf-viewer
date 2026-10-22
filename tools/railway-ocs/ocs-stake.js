/* =========================================================================
   Trazione elettrica (Railway OCS) — picchettamento automatico (tool 18, F4)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Niente DOM: si prova in Node (test/test_ocs_stake.js). Importa solo il motore.

   Regole (scelte dell'utente 2026-10-12; il TE 210 RFI non c'è → parametri):
   - campata massima dal raggio: TABELLA dove c'è — di partenza quella RFI
     E 65061 a (0.12.0, PIANO §22.4) letta «da R in su: campata L» (fra due raggi
     vale il più piccolo; sotto il primo, il minore fra la prima riga e la regola); le tabelle scritte
     prima della 0.12.0 restano «fino a R: campata L» (tableMode «upTo») —
     altrimenti la regola geometrica: in curva il filo
     sta poligonato verso l'esterno di a al palo e a metà campata si sposta
     verso l'interno della freccia L²/8R; ammesso b oltre l'asse →
     L = √(8·R·(a + b)) (a = b = 0,20 → R 1000: 56,6 m; R 500: 40 m);
     mai oltre Lmax (60 m in retta);
   - campate vicine: rapporto massimo (ratio) → il limite si «spiana» con
     pendenza al più ratio − 1 (in una campata lunga L cresce di (ratio−1)·L);
   - fra due punti fermi (pali fissi, punti obbligati, capi, bordi delle zone
     escluse) il minimo numero di campate che rispetta L*, distribuite in
     proporzione al limite locale (capacità ∫ du / L*);
   - poligonazione: in curva sotto Rout tutta verso l'esterno, altrove
     alternata (anche rispetto ai pali fissi vicini);
   - pali appaiati: le stesse sezioni sul binario parallelo (projectStations).
   ========================================================================= */
import { trackFrame, crossOffset } from "./ocs-core.js?v=0.23.0";

/* E 65061 a, fogli 3–6: raggio di curva (m) → campata massima (m); da 1400 in su 60 (= Lmax) */
export const RFI_SPANS = [[250, 26], [300, 30], [400, 34], [500, 39], [600, 43.5], [700, 47], [800, 50], [900, 52], [1000, 53.5], [1100, 55.5], [1200, 57], [1300, 58.5], [1400, 60]].map(([R, L]) => ({ R, L }));
export const AUTO_DEFAULTS = { Lmax: 60, a: 0.2, b: 0.2, ratio: 1.25, Rout: 1500, ends: true, side: 1, table: RFI_SPANS, tableMode: "from", excl: [], must: [], follow: null };
const STEP = 1;                                           // campionamento del limite (m)
const num = (v) => (v == null || v === "" ? NaN : +v);

/* la campata massima per un raggio (R con segno o Infinity in retta) */
export const geomSpan = (R, a, b) => Math.sqrt(8 * Math.abs(R) * (a + b));
export function spanLimit(R, p = {}) {
  const P = { ...AUTO_DEFAULTS, ...p }, r = Math.abs(R);
  if (!(r > 0) || !Number.isFinite(r)) return P.Lmax;
  const tab = cleanTable(P.table);
  let row;
  const mode = p.tableMode || (p.table != null ? "upTo" : P.tableMode);          // tabella data senza modo = «fino a R» (prima della 0.12.0)
  if (mode === "from") row = tab.length ? [...tab].reverse().find((x) => r >= x.R - 1e-9) || { L: Math.min(tab[0].L, geomSpan(r, P.a, P.b)) } : null;   // sotto il primo raggio: il minore fra la prima riga e la regola
  else row = tab.find((x) => r <= x.R + 1e-9);
  const L = row ? row.L : geomSpan(r, P.a, P.b);
  return Math.max(1, Math.min(P.Lmax, L));
}
export const cleanTable = (t) => (t || []).map((x) => ({ R: num(x.R), L: num(x.L) })).filter((x) => x.R > 0 && x.L > 0).sort((x, y) => x.R - y.R);

/* il limite campionato da u0 a u1 (passo 1 m), già spianato col rapporto fra campate vicine */
export function limitProfile(T, u0, u1, p = {}) {
  const P = { ...AUTO_DEFAULTS, ...p }, n = Math.max(1, Math.ceil((u1 - u0) / STEP)), us = [], raw = [], R = [];
  for (let i = 0; i <= n; i++) {
    const u = u0 + ((u1 - u0) * i) / n, f = trackFrame(T, u), r = f && f.k ? 1 / f.k : Infinity;
    us.push(u); R.push(r); raw.push(spanLimit(r, P));
  }
  // spianatura: in una campata lunga L il limite cresce al più di (ratio − 1)·L → pendenza massima ratio − 1
  // (inviluppo a pendenza limitata, un passaggio avanti e uno indietro)
  const L = raw.slice(), h = (u1 - u0) / n, g = Math.max(0, (+P.ratio || 1) - 1) * h;
  if (+P.ratio < 50) {
    for (let i = 1; i <= n; i++) L[i] = Math.min(L[i], L[i - 1] + g);
    for (let i = n - 1; i >= 0; i--) L[i] = Math.min(L[i], L[i + 1] + g);
  }
  return { us, L, R, at: (u) => sampleAt(us, L, u), minOn: (a, b) => minOn(us, L, a, b), rAt: (u) => sampleAt(us, R.map((x) => (Number.isFinite(x) ? x : 1e12)), u) };
}
function sampleAt(us, v, u) {
  if (u <= us[0]) return v[0];
  if (u >= us[us.length - 1]) return v[v.length - 1];
  const h = (us[us.length - 1] - us[0]) / (us.length - 1), i = Math.min(us.length - 2, Math.floor((u - us[0]) / h)), t = (u - us[i]) / h;
  return v[i] + (v[i + 1] - v[i]) * t;
}
function minOn(us, v, a, b) {
  let m = Math.min(sampleAt(us, v, a), sampleAt(us, v, b));
  for (let i = 0; i < us.length; i++) if (us[i] > a && us[i] < b && v[i] < m) m = v[i];
  return m;
}

/* fra a e b (pali agli estremi) le posizioni dei pali in mezzo: minimo numero di campate col limite LP */
export function fillBetween(a, b, LP) {
  if (b - a < 1e-6) return [];
  const m = Math.max(2, Math.ceil((b - a) / STEP)), xs = [], cap = [0];
  for (let i = 0; i <= m; i++) xs.push(a + ((b - a) * i) / m);
  for (let i = 1; i <= m; i++) cap.push(cap[i - 1] + (xs[i] - xs[i - 1]) * 0.5 * (1 / LP.at(xs[i - 1]) + 1 / LP.at(xs[i])));
  const tot = cap[m];
  for (let n = Math.max(1, Math.ceil(tot - 1e-6)); n < Math.ceil(tot) + 40; n++) {
    const out = [];
    for (let k = 1; k < n; k++) {
      const c = (tot * k) / n;
      let i = 1; while (i < m && cap[i] < c) i++;
      const t = (c - cap[i - 1]) / (cap[i] - cap[i - 1] || 1);
      out.push(xs[i - 1] + (xs[i] - xs[i - 1]) * t);
    }
    const all = [a, ...out, b];
    if (all.every((x, i) => !i || x - all[i - 1] <= LP.minOn(all[i - 1], x) + 1e-6)) return out;
  }
  return [];
}

/* la proposta su un binario. o = { u0, u1 (campo, di partenza tutto il binario), p (regole), fixed: [u] (pali che
   restano), must: [u] (punti obbligati: pali nuovi), excl: [{ u0, u1 }] (zone senza pali; ai bordi un palo) }.
   → { items: [{ u, why: "end" | "must" | "edge" | "fill" }] (solo i pali nuovi), spans: [{ a, b, L, lim, over }],
       warn: [{ code: "over" | "ratio" | "short", u, v }], LP } */
export function propose(T, o = {}) {
  const P = { ...AUTO_DEFAULTS, ...(o.p || {}) }, len = T.H.length;
  const u0 = Math.max(0, Number.isFinite(o.u0) ? o.u0 : 0), u1 = Math.min(len, Number.isFinite(o.u1) ? o.u1 : len);
  if (!(u1 - u0 > 1)) return { items: [], spans: [], warn: [], LP: null };
  const LP = limitProfile(T, u0, u1, P);
  const excl = (o.excl || []).map((z) => ({ u0: Math.max(u0, Math.min(z.u0, z.u1)), u1: Math.min(u1, Math.max(z.u0, z.u1)) })).filter((z) => z.u1 - z.u0 > 1e-6);
  const inside = (u) => excl.some((z) => u > z.u0 + 1e-6 && u < z.u1 - 1e-6);
  const anchors = [];                                     // { u, fixed, why }
  for (const u of o.fixed || []) if (u >= u0 - 1e-6 && u <= u1 + 1e-6) anchors.push({ u, fixed: true });
  const add = (u, why) => { if (u >= u0 - 1e-6 && u <= u1 + 1e-6 && !inside(u) && !anchors.some((x) => Math.abs(x.u - u) < 1)) anchors.push({ u, fixed: false, why }); };
  for (const u of o.must || []) add(u, "must");
  for (const z of excl) { add(z.u0, "edge"); add(z.u1, "edge"); }
  if (P.ends) { add(u0, "end"); add(u1, "end"); }
  else for (const u of [u0, u1]) if (!anchors.some((x) => Math.abs(x.u - u) < 1)) anchors.push({ u, fixed: false, virtual: true });   // capi senza palo
  anchors.sort((x, y) => x.u - y.u);
  const items = anchors.filter((x) => !x.fixed && !x.virtual).map((x) => ({ u: x.u, why: x.why }));
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1].u, b = anchors[i].u;
    if (excl.some((z) => (a + b) / 2 > z.u0 && (a + b) / 2 < z.u1)) continue;   // tratto escluso
    for (const u of fillBetween(a, b, LP)) items.push({ u, why: "fill" });
  }
  items.sort((x, y) => x.u - y.u);
  // campate e controlli (pali fissi compresi; non attraverso le zone escluse)
  const all = [...anchors.filter((x) => x.fixed).map((x) => x.u), ...items.map((x) => x.u)].sort((x, y) => x - y);
  const spans = [], warn = [];
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1], b = all[i];
    if (excl.some((z) => (a + b) / 2 > z.u0 && (a + b) / 2 < z.u1)) continue;
    const lim = LP.minOn(a, b), L = b - a, over = L > lim + 1e-6;
    spans.push({ a, b, L, lim, over });
    if (over) warn.push({ code: "over", u: a, v: b });
  }
  for (let i = 1; i < spans.length; i++) {
    const s0 = spans[i - 1], s1 = spans[i];
    if (Math.abs(s0.b - s1.a) < 1e-6 && Math.max(s0.L, s1.L) / Math.min(s0.L, s1.L) > P.ratio + 1e-6) warn.push({ code: "ratio", u: s0.a, v: s1.b });
  }
  for (const s of spans) if (s.L < 5) warn.push({ code: "short", u: s.a, v: s.b });
  return { items, spans, warn, LP };
}

/* poligonazione dei pali nuovi (stag con la convenzione dei sostegni: + verso il palo; il filo sta a side·stag
   dall'asse). list = tutti i pali del binario in ordine [{ u, side, stag (dei fissi), fresh }]: in curva con R < Rout
   il filo va verso l'esterno; altrove alterna rispetto al palo prima (fisso o nuovo) */
export function staggers(T, list, p = {}) {
  const P = { ...AUTO_DEFAULTS, ...p }, a = Math.abs(+P.a || 0.2), out = new Map();
  let prev = 0;                                           // segno del filo al palo prima (+ a sinistra dell'asse)
  for (const m of [...list].sort((x, y) => x.u - y.u)) {
    if (!m.fresh) { const w = Math.sign(m.side * (m.stag || 0)); if (w) prev = w; continue; }
    const f = trackFrame(T, m.u), R = f && f.k ? 1 / Math.abs(f.k) : Infinity;
    const w = R < P.Rout && f.k ? -Math.sign(f.k) : prev ? -prev : 1;
    out.set(m, w * m.side * a);
    prev = w;
  }
  return out;
}

/* pali appaiati: le sezioni dei pali del binario guida (Tl, progressive us) sul binario parallelo Tf, dove la
   normale lo taglia entro reach → progressive su Tf (ordinate, senza doppioni) */
export function projectStations(Tl, us, Tf, reach = 15) {
  const out = [];
  for (const u of us) {
    const x = crossOffset(Tl, u, 1, Tf);
    if (x && Math.abs(x.off) <= reach && !out.some((v) => Math.abs(v - x.u2) < 0.5)) out.push(x.u2);
  }
  return out.sort((x, y) => x - y);
}

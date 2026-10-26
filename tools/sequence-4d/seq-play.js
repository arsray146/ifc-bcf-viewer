/* =========================================================================
   Sequenza 4D — il lotto alla data, elemento per elemento (tool 19, F4)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Puro, senza import né DOM (si prova in Node: test/test_seq_play.js).

   Gli elementi di tutti i modelli sono numerati di seguito (g = inizio del
   modello + indice nel modello). Ogni attività collegata, non «fuori dal
   modello», porta i suoi elementi in un ordine che è il suo modo di
   comparire (design 19, PIANO §1):
   - tutto insieme: tutti in corso per tutta l'attività;
   - dal basso: un piano orizzontale sale dalla quota più bassa degli
     elementi dell'attività alla più alta, in proporzione all'avanzamento;
     l'elemento che il piano attraversa si vede tagliato al piano (cresce:
     i pali di una palificata, che partono tutti dalla stessa quota, salgono
     insieme), quello che il piano ha superato è intero (0.6.1: prima erano
     fasce di 10 cm della quota più bassa, e i pali comparivano in un colpo);
   - lungo l'asse: lo stesso con un piano verticale ⟂ all'asse del lotto,
     cioè la direzione principale in pianta di tutti gli elementi, verso est
     (o nord se il lotto corre nord-sud), finché non c'è l'asse vero (F6):
     un tubo lungo un solo elemento compare un pezzo alla volta;
   Una demolizione col fronte va al contrario: il piano scende dall'alto
   (o torna indietro lungo l'asse) e quello che ha passato non c'è più.
   Senza i riquadri degli elementi (prepare senza box) dal basso e lungo
   l'asse tornano a gruppi, come per campata;
   - per campata: a gruppi — lo stesso codice d'elemento, se l'attività ne
     ha più d'uno (VI03.TRV.C1, C2…, presi dal ramo VI03.TRV), altrimenti
     lo stesso posto della struttura — e i gruppi in fila lungo l'asse.
     Il gruppo j di m entra quando l'avanzamento dell'attività passa j/m e
     resta «in corso» fino a (j+1)/m + BAND, poi è fatto: si vede un fronte
     che avanza, non un elemento alla volta.
   Lo stato di un elemento alla data lo decide l'ultima delle sue attività
   cominciata per lui: costruzione in corso → fatta; provvisoria in corso →
   in opera; demolizione in corso → via. Prima che ne cominci una: se la
   prima delle sue attività è una demolizione l'elemento c'è già (lo stato
   di fatto), altrimenti non c'è ancora. Così una provvisoria tolta dalla sua
   rimozione, o un muro demolito e rifatto, seguono l'ordine delle date.
   ========================================================================= */

export const FREE = 0;   // senza attività (o solo «fuori dal modello»): il contesto
export const TODO = 1;   // non c'è ancora
export const RUN = 2;    // in corso (costruzione, provvisoria o demolizione)
export const DONE = 3;   // fatto: costruito, provvisoria in opera
export const GONE = 4;   // demolito, provvisoria tolta
export const EXIST = 5;  // c'è già: lo stato di fatto, da demolire
export const BAND = 0.06;
export const MODES = ["all", "axis", "span", "up"];
export const CUT_Z = 1, CUT_AXIS = 2;   // il fronte: piano orizzontale (quota) o ⟂ all'asse

/* la direzione principale in pianta dei punti (x, y di pos, 3 per elemento):
   l'autovettore maggiore della covarianza, con la componente più grande
   positiva (verso est, o verso nord) */
export function lotAxis(pos, n) {
  let mx = 0, my = 0, c = 0;
  for (let g = 0; g < n; g++) { const x = pos[3 * g], y = pos[3 * g + 1]; if (!Number.isFinite(x) || !Number.isFinite(y)) continue; mx += x; my += y; c++; }
  if (!c) return [1, 0];
  mx /= c; my /= c;
  let sxx = 0, sxy = 0, syy = 0;
  for (let g = 0; g < n; g++) {
    const x = pos[3 * g], y = pos[3 * g + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const dx = x - mx, dy = y - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ux = Math.cos(th), uy = Math.sin(th);
  if ((Math.abs(ux) >= Math.abs(uy) ? ux : uy) < 0) { ux = -ux; uy = -uy; }
  return [ux, uy];
}

/**
 * L'ordine in cui compaiono gli elementi di un'attività.
 * els: gli elementi (g); mode: MODES; pos: Float32Array(3n) x, y, quota più
 * bassa; axis: [ux, uy]; grps: chiavi di gruppo per «per campata», per
 * elemento (Int32Array, −1 = nessuna), la prima che fa almeno due gruppi.
 * opt.box: Float32Array(6n) riquadro di ogni elemento nella scena (x, y, z
 * più bassi, poi più alti): con questo dal basso e lungo l'asse sono un fronte
 * continuo (frontAct); opt.demo: l'attività demolisce (il fronte va indietro).
 * → { els: Int32Array in ordine, r0, r1: Float32Array (l'avanzamento in cui
 *     il suo gruppo entra e finisce), m: quanti gruppi, cut: il fronte o null }
 */
export function orderAct(els, mode, pos, axis, grps = [], opt = {}) {
  const n = els.length, r0 = new Float32Array(n), r1 = new Float32Array(n);
  if (!MODES.includes(mode) || mode === "all" || n < 1) { r1.fill(1); return { els: Int32Array.from(els), r0, r1, m: n ? 1 : 0, cut: null }; }
  if (opt.box && (mode === "up" || mode === "axis")) return frontAct(els, mode, axis, opt.box, !!opt.demo);
  if (n <= 1) { r1.fill(1); return { els: Int32Array.from(els), r0, r1, m: 1, cut: null }; }
  const [ux, uy] = axis;
  const fin = (v) => (Number.isFinite(v) ? v : 0);
  const along = (g) => fin(pos[3 * g] * ux + pos[3 * g + 1] * uy);
  let gid = null, gval = null;
  if (mode === "span") {
    for (const grp of grps) {
      if (!grp) continue;
      const acc = new Map();
      for (const g of els) { const k = grp[g]; let a = acc.get(k); if (!a) acc.set(k, (a = [0, 0])); a[0] += along(g); a[1]++; }
      if (acc.size < 2) continue;
      gid = (g) => grp[g];
      gval = (g) => { const a = acc.get(grp[g]); return a[0] / a[1]; };
      break;
    }
    if (!gid) mode = "axis";            // un gruppo solo: elemento per elemento lungo l'asse
  }
  if (mode === "up") gid = gval = (g) => Math.round(fin(pos[3 * g + 2]) * 10);
  else if (mode === "axis") gid = gval = (g) => Math.round(along(g) * 100);
  const items = Array.from(els, (g) => ({ g, v: gval(g), id: gid(g) }));
  items.sort((a, b) => a.v - b.v || a.g - b.g);
  const rank = new Map();
  for (const it of items) if (!rank.has(it.id)) rank.set(it.id, rank.size);
  const m = rank.size, out = new Int32Array(n);
  items.forEach((it, j) => { out[j] = it.g; const q = rank.get(it.id); r0[j] = q / m; r1[j] = (q + 1) / m; });
  return { els: out, r0, r1, m, cut: null };
}

/* il fronte continuo: l'attività occupa [lo, hi] sulla direzione del fronte
   (la quota, o la posizione lungo l'asse); all'avanzamento p il piano sta a
   lo + p (hi − lo), e per una demolizione a hi − p (hi − lo). Un elemento
   entra quando il piano lo raggiunge (r0) ed è intero quando lo ha passato
   (r1); in mezzo si vede la parte sotto il piano. Gli elementi senza
   riquadro valgono per tutta l'attività, senza taglio (ok = 0) */
function frontAct(els, mode, axis, box, demo) {
  const n = els.length, [ux, uy] = axis, lo = new Float64Array(n), hi = new Float64Array(n), ok = new Uint8Array(n);
  let L = Infinity, H = -Infinity;
  for (let j = 0; j < n; j++) {
    const o = 6 * els[j];
    let a, b;
    if (mode === "up") { a = box[o + 2]; b = box[o + 5]; }
    else {
      const x0 = box[o] * ux, x1 = box[o + 3] * ux, y0 = box[o + 1] * uy, y1 = box[o + 4] * uy;
      a = Math.min(x0, x1) + Math.min(y0, y1); b = Math.max(x0, x1) + Math.max(y0, y1);
    }
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
    lo[j] = a; hi[j] = b; ok[j] = 1;
    if (a < L) L = a;
    if (b > H) H = b;
  }
  const span = H - L, r0 = new Float32Array(n), r1 = new Float32Array(n).fill(1);
  if (!(span > 1e-6)) return { els: Int32Array.from(els), r0, r1, m: 1, cut: null };     // tutto alla stessa quota: tutto insieme
  for (let j = 0; j < n; j++) {
    if (!ok[j]) continue;
    r0[j] = demo ? (H - hi[j]) / span : (lo[j] - L) / span;
    r1[j] = demo ? (H - lo[j]) / span : (hi[j] - L) / span;
  }
  const ord = Array.from({ length: n }, (_, j) => j).sort((p, q) => r0[p] - r0[q] || els[p] - els[q]);
  return {
    els: Int32Array.from(ord, (j) => els[j]), r0: Float32Array.from(ord, (j) => r0[j]), r1: Float32Array.from(ord, (j) => r1[j]), m: n,
    cut: { dir: mode === "up" ? CUT_Z : CUT_AXIS, lo: L, hi: H, down: demo, ok: Uint8Array.from(ord, (j) => ok[j]) },
  };
}

/**
 * Prepara la sequenza: si rifà solo quando cambia il collegamento (attività,
 * elementi, tipi, modi) o i modelli.
 * n: elementi in tutto; acts: [{ i (indice dell'attività), type ("build" |
 * "temp" | "demo"; «none» si scarta), mode, start (inizio effettivo o
 * corrente, ms), els: Int32Array }]; pos, grps come orderAct; axis: se manca,
 * quello del lotto; box: i riquadri nella scena (Float32Array 6n) per i fronti.
 * → { n, axis, acts: [{ i, type, start, els, r0, r1, m, cut }], first: Uint8Array(n)
 *     — com'è l'elemento prima delle sue attività: 0 nessuna attività, 1 non
 *     c'è ancora, 2 c'è già (la prima è una demolizione) —, range: per
 *     direzione del fronte [min, max] dei piani possibili (la pagina ci scala
 *     il taglio di ogni elemento a 16 bit) }
 */
export function prepare({ n, acts, pos, grps = [], axis = null, box = null }) {
  axis = axis || lotAxis(pos, n);
  const first = new Uint8Array(n), firstT = new Float64Array(n).fill(Infinity);
  const out = [], range = { [CUT_Z]: [Infinity, -Infinity], [CUT_AXIS]: [Infinity, -Infinity] };
  for (const a of acts) {
    if (a.type === "none" || !a.els || !a.els.length) continue;
    const demo = a.type === "demo", o = orderAct(a.els, a.mode, pos, axis, grps, { box, demo });
    for (const g of a.els) {
      /* la prima attività dell'elemento; a pari data la demolizione (lo stato di fatto viene prima) */
      if (a.start < firstT[g] || (a.start === firstT[g] && demo)) { firstT[g] = a.start; first[g] = demo ? 2 : 1; }
    }
    if (o.cut) { const r = range[o.cut.dir]; r[0] = Math.min(r[0], o.cut.lo); r[1] = Math.max(r[1], o.cut.hi); }
    out.push({ i: a.i, type: a.type, start: a.start, ...o });
  }
  return { n, axis, acts: out, first, range };
}

/**
 * Lo stato di ogni elemento alla data.
 * st(i) → { ph: 0 da fare | 1 in corso | 2 fatta, p: avanzamento 0…1 } per
 * l'attività i (seq-core.stateAt, TODO/RUN/DONE = 0/1/2).
 * out: il risultato di prima, si riusa (nessuna allocazione a ogni giorno).
 * → { code: Uint8Array(n) FREE…EXIST, act: Int32Array(n) — l'attività di
 *     plan.acts che lo decide, −1 se nessuna è cominciata —, cutK: Uint8Array(n)
 *     0 intero | CUT_Z | CUT_AXIS, cut: Float32Array(n) il piano del fronte:
 *     dell'elemento si vede solo la parte sotto (quota, o posizione lungo l'asse) }
 */
export function frame(plan, st, out) {
  const n = plan.n;
  if (!out || out.code.length !== n) out = { code: new Uint8Array(n), act: new Int32Array(n), ph: new Uint8Array(n), t: new Float64Array(n), cutK: new Uint8Array(n), cut: new Float32Array(n) };
  const { code, act, ph, t, cutK, cut } = out;
  act.fill(-1); t.fill(-Infinity); cutK.fill(0);
  plan.acts.forEach((a, ai) => {
    const s = st(a.i);
    if (!s || !s.ph) return;
    const done = s.ph === 2, p = s.p || 0, { els, r0, r1 } = a, F = a.cut;
    const at = F ? (F.down ? F.hi - p * (F.hi - F.lo) : F.lo + p * (F.hi - F.lo)) : 0;
    for (let j = 0; j < els.length; j++) {
      let e;
      if (done) e = 2;
      else if (p < r0[j]) continue;                       // il suo gruppo (o il fronte) non è ancora arrivato
      else if (F) e = F.ok[j] && p >= r1[j] ? 2 : 1;      // il fronte l'ha passato: intero (o, se demolisce, via)
      else e = r1[j] < 1 && p >= r1[j] + BAND ? 2 : 1;
      const g = els[j];
      /* l'ultima attività cominciata per lui decide (a pari inizio: quella che viene dopo nell'elenco) */
      if (a.start >= t[g]) {
        t[g] = a.start; act[g] = ai; ph[g] = e;
        if (F && e === 1 && F.ok[j]) { cutK[g] = F.dir; cut[g] = at; } else cutK[g] = 0;
      }
    }
  });
  for (let g = 0; g < n; g++) {
    const k = act[g];
    if (k < 0) { const f = plan.first[g]; code[g] = f === 0 ? FREE : f === 2 ? EXIST : TODO; continue; }
    const demo = plan.acts[k].type === "demo";
    code[g] = ph[g] === 1 ? RUN : demo ? GONE : DONE;
  }
  return out;
}

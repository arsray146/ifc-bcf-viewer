/* =========================================================================
   Sequenza 4D — le statistiche del programma (tool 19, 0.8.0)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Senza import e senza DOM (si prova in Node: test/test_seq_stats.js). Il
   motore lo passa chi chiama: E = { ...seq-core, ...seq-cost } (stateAt,
   finishVar, sCurve, curveAt, curveDelay, frac, monthStart…). Così la pagina
   e i test usano gli stessi moduli con la loro versione (?v=) e qui non si
   rifà niente, come fv in seq-cost.

   Le parole:
   - attività: né riepilogo né inattiva; foglia: un'attività che non è un
     cardine;
   - avanzamento fisico: la % completamento delle foglie pesata sulla loro
     durata, come la % del progetto in Project. Il programmato alla data è la
     stessa durata distribuita sulle date della baseline in tempo lavorativo:
     la curva S delle durate (sCurve con l'importo = la durata);
   - in ritardo: la fine effettiva o prevista dopo quella della baseline
     (seq-core finishVar, giorni di calendario), come il filtro della
     Pianificazione;
   - aperta: non finita alla data di stato (senza data di stato: tutte).
   I controlli della qualità seguono i 14 punti della DCMA (Defense Contract
   Management Agency) con le soglie usuali: aiutano a leggere il programma,
   non lo correggono (Project resta il master, PIANO §4).
   ========================================================================= */

const DAY = 86400000, WEEK = 7 * DAY;
const dayFloor = (ms) => Math.floor(ms / DAY) * DAY;
const days = (a, b) => Math.round((dayFloor(a) - dayFloor(b)) / DAY);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const isTask = (t) => !t.summary && t.active !== false;
const isLeaf = (t) => isTask(t) && !t.milestone;
const wOf = (t) => (isLeaf(t) ? Math.max(0, t.dur || 0) : null);
/* il legame k-esimo di un'attività verso il predecessore j (predIdx salta gli UID che non ci sono: si cerca per UID) */
const linkOf = (T, t, j, k) => t.preds.find((l) => l.uid === T[j].uid) || t.preds[k] || {};

/* la curva S delle durate: l'avanzamento fisico nel tempo (programmato, maturato, previsione) */
export function durCurve(P, E, { sd = null, working = null } = {}) {
  return E.sCurve(P, { amt: wOf, done: (t) => { const w = wOf(t); return w == null ? null : w * (t.pct || 0) / 100; }, sd, working });
}

/**
 * L'avanzamento alla data at (la data di stato, o la data scelta senza).
 * sd: la data di stato se il programma ha l'avanzamento (altrimenti null:
 * solo previsto). cv: la curva delle durate (durCurve).
 * → { n: { leaves, done, run, todo, late, overdue, notStarted }, ms: { n, done, late },
 *     w: { plan, val, kind, delay } | null, start, finish: { base, cur }, slip, elapsed, bei: { due, done } | null }
 */
export function progress(P, E, { at, sd = null, cv = null }) {
  const n = { leaves: 0, done: 0, run: 0, todo: 0, late: 0, overdue: 0, notStarted: 0 }, ms = { n: 0, done: 0, late: 0 };
  let bS = Infinity, bF = -Infinity, cS = Infinity, cF = -Infinity, due = 0, fin = 0;
  for (const t of P.tasks) {
    if (!isTask(t)) continue;
    const s = E.stateAt(t, at, sd), v = E.finishVar(t);
    if (t.bStart != null) bS = Math.min(bS, t.bStart);
    if (t.bFinish != null) bF = Math.max(bF, t.bFinish);
    cS = Math.min(cS, t.aStart ?? t.start); cF = Math.max(cF, t.aFinish ?? t.finish);
    if (sd != null && t.bFinish != null && t.bFinish <= sd) due++;
    if (sd != null && t.aFinish != null && t.aFinish <= sd) fin++;
    if (t.milestone) { ms.n++; if (s.ph === E.DONE) ms.done++; if (v != null && v > 0) ms.late++; continue; }
    n.leaves++;
    if (s.ph === E.DONE) n.done++; else if (s.ph === E.RUN) n.run++; else n.todo++;
    if (v != null && v > 0) n.late++;
    if (s.ph !== E.DONE && t.bFinish != null && t.bFinish <= at) n.overdue++;            // doveva essere finita
    if (s.ph === E.TODO && t.bStart != null && t.bStart <= at) n.notStarted++;           // doveva essere cominciata
  }
  let w = null;
  if (cv && cv.total > 0) { const a = E.curveAt(cv, at); w = { plan: a.plan / cv.total, val: a.val / cv.total, kind: a.kind, delay: E.curveDelay(cv, at) }; }
  const base = Number.isFinite(bF);
  return {
    at, sd, n, ms, w,
    start: { base: Number.isFinite(bS) ? bS : null, cur: Number.isFinite(cS) ? cS : null },
    finish: { base: base ? bF : null, cur: Number.isFinite(cF) ? cF : null },
    slip: base && Number.isFinite(cF) ? days(cF, bF) : null,
    elapsed: cF > cS ? clamp01((at - cS) / (cF - cS)) : null,
    /* l'indice di esecuzione della baseline (DCMA 14): finite su quelle che la baseline voleva finite */
    bei: sd != null && P.hasBaseline ? { due, done: fin } : null,
  };
}

/* il livello della WBS da mostrare: le radici, o sotto l'unico riepilogo in testa (quello del progetto) */
export function branchLevel(P) {
  let lev = [];
  P.tasks.forEach((t, i) => { if (t.parent < 0) lev.push(i); });
  for (let g = 0; lev.length === 1 && P.tasks[lev[0]].summary && g < 16; g++) lev = P.tasks[lev[0]].children;
  return lev;
}
/**
 * L'avanzamento per ramo della WBS: attività, stati, avanzamento fisico
 * effettivo (o previsto, senza data di stato) e programmato alla data, la
 * fine del ramo contro la baseline. clock: l'orologio lavorativo della curva.
 * → [{ i, n, done, run, todo, late, val, plan, slip }]
 */
export function branches(P, E, { at, sd = null, clock = null }) {
  const lev = branchLevel(P), row = new Map(), ck = clock || ((ms) => ms);
  for (const i of lev) row.set(i, { i, n: 0, done: 0, run: 0, todo: 0, late: 0, w: 0, wv: 0, wp: 0, bF: -Infinity, cF: -Infinity });
  P.tasks.forEach((t, i) => {
    if (!isTask(t)) return;
    let b = i;
    for (let g = 0; b >= 0 && !row.has(b) && g < 64; g++) b = P.tasks[b].parent;
    const r = row.get(b);
    if (!r) return;
    if (t.bFinish != null) r.bF = Math.max(r.bF, t.bFinish);
    r.cF = Math.max(r.cF, t.aFinish ?? t.finish);
    if (t.milestone) return;
    const s = E.stateAt(t, at, sd), v = E.finishVar(t), w = wOf(t), pb = t.bStart != null && t.bFinish != null;
    r.n++;
    if (s.ph === E.DONE) r.done++; else if (s.ph === E.RUN) r.run++; else r.todo++;
    if (v != null && v > 0) r.late++;
    r.w += w;
    r.wv += sd != null ? w * (t.pct || 0) / 100 : w * E.frac(t.start, t.finish, at, ck);
    r.wp += w * E.frac(pb ? t.bStart : t.start, pb ? t.bFinish : t.finish, at, ck);
  });
  return lev.map((i) => {
    const r = row.get(i);
    return { i, n: r.n, done: r.done, run: r.run, todo: r.todo, late: r.late, val: r.w ? r.wv / r.w : null, plan: r.w ? r.wp / r.w : null,
      slip: Number.isFinite(r.bF) && Number.isFinite(r.cF) ? days(r.cF, r.bF) : null };
  });
}

/* gli scostamenti della fine a classi, in giorni di calendario (come la colonna Scostamento) */
export const BINS = [["early", -Infinity, -1], ["ok", 0, 0], ["d5", 1, 5], ["d20", 6, 20], ["d60", 21, 60], ["over", 61, Infinity]];
/* → { n (con baseline), noBase, bins: [{ k, n }], late (quante), top: [{ i, v }] le più in ritardo } */
export function variance(P, E, { top = 10 } = {}) {
  const bins = BINS.map(([k]) => ({ k, n: 0 })), late = [];
  let n = 0, noBase = 0;
  P.tasks.forEach((t, i) => {
    if (!isTask(t)) return;
    const v = E.finishVar(t);
    if (v == null) { noBase++; return; }
    n++;
    bins[BINS.findIndex(([, a, b]) => v >= a && v <= b)].n++;
    if (v > 0) late.push({ i, v });
  });
  late.sort((a, b) => b.v - a.v || P.tasks[a.i].finish - P.tasks[b.i].finish);
  return { n, noBase, bins, late: late.length, top: late.slice(0, top) };
}

/* le prossime settimane da from: chi deve cominciare, chi deve finire, i cardini (le date previste di Project) */
export function lookahead(P, { from, weeks = 4 }) {
  const to = from + weeks * WEEK, inside = (d) => d != null && d >= from && d < to, out = [];
  P.tasks.forEach((t, i) => {
    if (!isTask(t)) return;
    const done = t.aFinish != null || (t.pct || 0) >= 100;
    if (t.milestone) { if (!done && inside(t.finish)) out.push({ i, kind: "ms", d: t.finish }); return; }
    if (t.aStart == null && !(t.pct > 0) && inside(t.start)) out.push({ i, kind: "start", d: t.start });
    if (!done && inside(t.finish)) out.push({ i, kind: "finish", d: t.finish });
  });
  return out.sort((a, b) => a.d - b.d || a.i - b.i);
}

/**
 * La produzione per periodo da una curva S (le durate o gli importi): il
 * programmato, il maturato fino alla data di stato, la previsione dopo; il
 * periodo a cavallo della data di stato ha l'uno e l'altra. Mesi, o
 * trimestri oltre i 48 mesi. → { by (mesi per periodo), periods: [{ t0, t1, plan, earn, fc }], total }
 */
export function production(cv, E, { by = 0 } = {}) {
  if (!cv || !(Math.abs(cv.total) > 0)) return null;
  const end = cv.from + (cv.n - 1) * DAY;
  let months = 0;
  for (let m = E.monthStart(cv.from); m <= end && months < 2400; m = E.addMonths(m, 1)) months++;
  by = by || (months > 48 ? 3 : 1);
  const m0 = new Date(E.monthStart(cv.from)), start = Date.UTC(m0.getUTCFullYear(), m0.getUTCMonth() - (m0.getUTCMonth() % by), 1);
  const val = (D) => E.curveAt(cv, D), sd = cv.sd, periods = [];
  for (let a = start; a <= end && periods.length < 2400; a = E.addMonths(a, by)) {
    const b = E.addMonths(a, by), A = val(a), B = val(b), p = { t0: a, t1: b, plan: B.plan - A.plan, earn: 0, fc: 0 };
    if (sd == null) p.fc = B.val - A.val;
    else {
      if (a < sd) p.earn = val(Math.min(b, sd)).val - A.val;
      if (b > sd) p.fc = B.val - val(Math.max(a, sd)).val;
    }
    periods.push(p);
  }
  return { by, periods, total: cv.total };
}

/**
 * Le attività in corso settimana per settimana: sulla baseline (senza: sulle
 * date correnti) e sulle date effettive fino alla data di stato, previste
 * dopo. Differenziali per settimana: O(attività + settimane).
 * → { w0 (il lunedì della prima), plan: [], cur: [], peak: { plan, cur } } | null
 */
export function running(P, E) {
  const L = [];
  let lo = Infinity, hi = -Infinity;
  for (const t of P.tasks) {
    if (!isLeaf(t)) continue;
    const pb = t.bStart != null && t.bFinish != null;
    const p = [pb ? t.bStart : t.start, pb ? t.bFinish : t.finish], c = [t.aStart ?? t.start, t.aFinish ?? t.finish];
    L.push([p, c]);
    lo = Math.min(lo, p[0], c[0]); hi = Math.max(hi, p[1], c[1]);
  }
  if (!L.length || !Number.isFinite(lo)) return null;
  const w0 = E.weekStart(lo), n = Math.max(1, Math.ceil((hi - w0) / WEEK));
  const dp = new Int32Array(n + 1), dc = new Int32Array(n + 1);
  const add = (d, [a, b]) => {
    if (!(b > a)) return;
    const ia = Math.max(0, Math.floor((a - w0) / WEEK)), ib = Math.min(n, Math.ceil((b - w0) / WEEK));
    if (ib > ia) { d[ia]++; d[ib]--; }
  };
  for (const [p, c] of L) { add(dp, p); add(dc, c); }
  const plan = [], cur = [];
  let a = 0, b = 0;
  for (let k = 0; k < n; k++) { a += dp[k]; b += dc[k]; plan.push(a); cur.push(b); }
  return { w0, plan, cur, peak: { plan: Math.max(...plan), cur: Math.max(...cur) } };
}

/* i vincoli rigidi di Project: deve iniziare il, deve finire il, iniziare non oltre il, finire non oltre il */
export const HARD = new Set([2, 3, 5, 7]);
/**
 * La qualità del programma: i controlli della DCMA che si fanno con quello che
 * il programma porta (non il 12 e il 13: servono un ricalcolo e una scadenza
 * contrattuale), più tre di pratica. Ognuno: { k, dcma, n, of, lim, ok, items }
 * (lim: la quota ammessa, null = solo da sapere; ok null = da sapere) o
 * { k, na } quando non si può fare (na: "sd" senza data di stato, "base"
 * senza baseline, "res" senza risorse). items: [{ i, … }] le attività.
 * mpd: minuti per giorno (le soglie di 44 giorni lavorativi).
 */
export function quality(P, E, { sd = null, mpd = 480 } = {}) {
  const T = P.tasks, D44 = 44 * mpd, out = [];
  const open = (t) => sd == null || (t.aFinish == null && (t.pct || 0) < 100);
  const all = [], tasks = [], leaves = [];
  T.forEach((t, i) => { if (!isTask(t)) return; all.push(i); if (!open(t)) return; tasks.push(i); if (!t.milestone) leaves.push(i); });
  const chk = (k, dcma, of, items, lim) => out.push({ k, dcma, n: items.length, of, lim, items,
    ok: lim == null ? null : !of || items.length / of <= lim + 1e-9 });
  const na = (k, dcma, why) => out.push({ k, dcma, na: why });

  /* 1. logica: aperte senza predecessori o senza successori */
  const logic = [];
  for (const i of tasks) {
    const t = T[i], p = (t.predIdx || []).length, s = (t.succIdx || []).length;
    if (!p || !s) logic.push({ i, why: !p && !s ? "both" : !p ? "pred" : "succ" });
  }
  chk("logic", 1, tasks.length, logic, 0.05);
  /* 2–4. i legami verso le aperte: lead, lag, tipo diverso da fine-inizio */
  const links = [];
  for (const i of tasks) { const t = T[i]; (t.predIdx || []).forEach((j, k) => links.push({ i, j, l: linkOf(T, t, j, k) })); }
  chk("leads", 2, links.length, links.filter((x) => (x.l.lag || 0) < 0).map((x) => ({ i: x.i, j: x.j, lag: x.l.lag })), 0);
  chk("lags", 3, links.length, links.filter((x) => (x.l.lag || 0) > 0).map((x) => ({ i: x.i, j: x.j, lag: x.l.lag })), 0.05);
  chk("rel", 4, links.length, links.filter((x) => (x.l.type || "FS") !== "FS").map((x) => ({ i: x.i, j: x.j, type: x.l.type })), 0.1);
  /* 5. vincoli rigidi */
  chk("hard", 5, tasks.length, tasks.filter((i) => HARD.has(T[i].ctype)).map((i) => ({ i, c: T[i].ctype, d: T[i].cdate ?? null })), 0.05);
  /* 6–7. margine totale oltre 44 giorni lavorativi, margine negativo */
  const sl = leaves.filter((i) => T[i].slack != null);
  chk("float", 6, sl.length, sl.filter((i) => T[i].slack > D44).map((i) => ({ i, v: T[i].slack / mpd })), 0.05);
  chk("negFloat", 7, sl.length, sl.filter((i) => T[i].slack < 0).map((i) => ({ i, v: T[i].slack / mpd })), 0);
  /* 8. durate oltre 44 giorni lavorativi (della baseline; senza, quella corrente) */
  chk("dur", 8, leaves.length, leaves.filter((i) => (T[i].bDur ?? T[i].dur) > D44).map((i) => ({ i, v: (T[i].bDur ?? T[i].dur) / mpd })), 0.05);
  /* 9. date non valide: effettive dopo la data di stato, previste prima per quello che non è cominciato o finito */
  if (sd != null) {
    const s0 = dayFloor(sd), bad = [];
    for (const i of all) {
      const t = T[i], started = t.aStart != null || t.pct > 0, done = t.aFinish != null || (t.pct || 0) >= 100;
      const why = t.aStart != null && dayFloor(t.aStart) > s0 ? "aStart" : t.aFinish != null && dayFloor(t.aFinish) > s0 ? "aFinish"
        : !started && dayFloor(t.start) < s0 ? "start" : !done && dayFloor(t.finish) < s0 ? "finish" : null;
      if (why) bad.push({ i, why });
    }
    chk("dates", 9, all.length, bad, 0);
  } else na("dates", 9, "sd");
  /* 10. risorse: le aperte di almeno un giorno senza assegnazioni (se il programma ne ha) */
  if ((P.assignments || []).length) {
    const has = new Set(P.assignments.map((a) => a.task)), long = leaves.filter((i) => (T[i].dur || 0) >= mpd);
    chk("res", 10, long.length, long.filter((i) => !has.has(T[i].uid)).map((i) => ({ i })), 0);
  } else na("res", 10, "res");
  /* 11. mancate e 14. BEI: quelle che la baseline voleva finite alla data di stato */
  if (sd != null && P.hasBaseline) {
    const due = [], missed = [];
    let fin = 0;
    for (const i of all) {
      const t = T[i];
      if (t.aFinish != null && t.aFinish <= sd) fin++;
      if (t.bFinish == null || t.bFinish > sd) continue;
      due.push(i);
      if (t.aFinish == null || dayFloor(t.aFinish) > dayFloor(t.bFinish)) missed.push({ i, v: E.finishVar(t) });
    }
    chk("missed", 11, due.length, missed, 0.05);
    out.push({ k: "bei", dcma: 14, n: fin, of: due.length, ratio: due.length ? fin / due.length : null, lim: 0.95, ok: !due.length || fin / due.length >= 0.95,
      items: due.filter((i) => T[i].aFinish == null).map((i) => ({ i, v: E.finishVar(T[i]) })) });
  } else { const why = sd == null ? "sd" : "base"; na("missed", 11, why); na("bei", 14, why); }
  /* di pratica: senza baseline, fuori sequenza, legami sui riepiloghi */
  if (P.hasBaseline) chk("noBase", 0, all.length, all.filter((i) => T[i].bFinish == null).map((i) => ({ i })), 0);
  else na("noBase", 0, "base");
  if (sd != null) {
    const st = all.filter((i) => T[i].aStart != null), oos = [];
    for (const i of st) {
      const t = T[i];
      const j = (t.predIdx || []).find((j, k) => !T[j].summary && (linkOf(T, t, j, k).type || "FS") === "FS" && (T[j].aFinish == null || dayFloor(T[j].aFinish) > dayFloor(t.aStart)));
      if (j != null) oos.push({ i, j });
    }
    chk("oos", 0, st.length, oos, null);
  } else na("oos", 0, "sd");
  const sums = [];
  T.forEach((t, i) => { if (t.summary && t.active !== false) sums.push(i); });
  chk("sumLinks", 0, sums.length, sums.filter((i) => (T[i].predIdx || []).length || (T[i].succIdx || []).length).map((i) => ({ i })), null);
  return out;
}

/**
 * I modelli e il collegamento: per modello gli elementi a codice, a mano,
 * contesi e senza attività; per classe IFC quanti e quanti collegati (le
 * prime top, le altre insieme). cov: seq-link coverage (stati FREE 0,
 * LINKED 1, CONTESTED 2, HAND 3); models: [{ key, name, n, els: [{ cls }] }].
 */
export function modelStats(cov, models, { top = 12 } = {}) {
  const per = [], cls = new Map();
  for (const M of models) {
    const st = cov.state.get(M.key), r = { key: M.key, name: M.name, n: M.n, code: 0, hand: 0, contested: 0, free: 0 };
    for (let k = 0; k < M.n; k++) {
      const s = st ? st[k] : 0;
      if (s === 1) r.code++; else if (s === 3) r.hand++; else if (s === 2) r.contested++; else r.free++;
      const c = (M.els[k] && M.els[k].cls) || "—";
      let o = cls.get(c);
      if (!o) cls.set(c, (o = { cls: c, n: 0, linked: 0 }));
      o.n++;
      if (s) o.linked++;
    }
    per.push(r);
  }
  const list = [...cls.values()].sort((a, b) => b.n - a.n || (a.cls < b.cls ? -1 : 1)), rest = list.slice(top);
  return {
    models: per, classes: list.slice(0, top),
    rest: rest.length ? { k: rest.length, n: rest.reduce((s, x) => s + x.n, 0), linked: rest.reduce((s, x) => s + x.linked, 0) } : null,
    acts: cov.acts,
  };
}

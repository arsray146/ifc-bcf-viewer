/* =========================================================================
   Sequenza 4D — i costi del programma (tool 19, F7 passi C1 e C2)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Senza import e senza DOM (si prova in Node: test/test_seq_cost.js). Gli
   importi vengono dal programma (decisione dell'utente, PIANO §13): il costo
   di ogni attività (varianti comprese), quello della baseline, l'effettivo,
   il fisso; le risorse e le loro assegnazioni (C1). Per la curva S e il SAL
   (C2) la colonna dell'importo e quella del maturato si scelgono: il costo di
   Project o un campo del programma. Project resta il master: qui non si
   corregge niente, si dice quello che non torna.

   Le parole (come in un SAL):
   - importo: il costo dell'attività in Project;
   - maturato: quanto ne è stato eseguito alla data di stato. È il costo
     effettivo di Project (con i costi effettivi calcolati da Project = importo
     × % completamento); senza, importo × %;
   - previsto alla data: il costo della baseline distribuito sul suo periodo,
     in tempo lavorativo (il BCWS di Project);
   - valore guadagnato: baseline × % completamento (il BCWP di Project).
   Voce del contratto: una risorsa materiale senza unità di misura (una voce a
   corpo): la sua tariffa è l'importo, le unità assegnate sono le quote, che
   insieme devono fare il 100 %.
   ========================================================================= */

const DAY = 86400000;
const dayFloor = (ms) => Math.floor(ms / DAY) * DAY;
export const EPS = 0.005;                                   // mezzo punto percentuale sulle quote

const leaf = (t) => !t.summary;
const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
/* uguali al centesimo, o allo 0,1 % per gli importi grandi (Project arrotonda le % ) */
export const same = (a, b) => a != null && b != null && Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.001);

/* orologio del tempo lavorativo: ms lavorativi fra t0 e ms (giorni interi del
   calendario, working(ms) → giorno lavorativo sì/no come seq-core makeCalendar).
   Somme cumulate per giorno: una data costa O(1) */
export function workClock(working, t0, t1) {
  const d0 = dayFloor(t0), n = Math.max(1, Math.ceil((t1 - d0) / DAY) + 2);
  const cum = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) cum[k + 1] = cum[k] + (working(d0 + k * DAY) ? DAY : 0);
  return (ms) => {
    const x = (ms - d0) / DAY;
    if (x <= 0) return 0;
    if (x >= n) return cum[n];
    const k = Math.floor(x);
    return cum[k] + (cum[k + 1] - cum[k]) * (x - k);
  };
}
/* frazione del periodo [a, b] passata alla data d, in tempo lavorativo */
export function frac(a, b, d, clock) {
  if (a == null || b == null) return 0;
  if (d >= b) return 1;
  if (d <= a) return 0;
  const wa = clock(a), wb = clock(b);
  return wb > wa ? (clock(d) - wa) / (wb - wa) : (d - a) / (b - a);
}

/* maturato di un'attività alla data di stato */
export const earnedAtSd = (t) => (t.aCost != null ? t.aCost : (t.cost || 0) * (t.pct || 0) / 100);

/* indice: assegnazioni per attività e per risorsa */
export function costIndex(P) {
  const res = new Map((P.resources || []).map((r) => [r.uid, r]));
  const byTask = new Map(), byRes = new Map();
  for (const a of P.assignments || []) {
    if (!byTask.has(a.task)) byTask.set(a.task, []);
    byTask.get(a.task).push(a);
    if (!byRes.has(a.res)) byRes.set(a.res, []);
    byRes.get(a.res).push(a);
  }
  return { res, byTask, byRes };
}
/* una voce a corpo: risorsa materiale senza unità di misura */
export const isLumpSum = (r) => r.type === "material" && !String(r.label || "").trim() && !r.budget;

/* =========================================================================
   Il controllo dei costi (C1): totali, quote, costi fissi negativi, varianti,
   e il confronto con l'earned value scritto da Project
   sd: data di stato; working: calendario del progetto (seq-core makeCalendar)
   ========================================================================= */
export function costCheck(P, sd, working) {
  const L = P.tasks.filter(leaf), X = costIndex(P);
  const has = !!P.hasCosts;
  const span = L.reduce((s, t) => [Math.min(s[0], t.bStart ?? t.start, t.start), Math.max(s[1], t.bFinish ?? t.finish, t.finish)], [Infinity, -Infinity]);
  const clock = working && Number.isFinite(span[0]) ? workClock(working, Math.min(span[0], sd ?? span[0]), Math.max(span[1], sd ?? span[1])) : (ms) => ms;
  const planned = (t) => (t.bCost != null && sd != null ? t.bCost * frac(t.bStart, t.bFinish, sd, clock) : null);
  const ev = (t) => (t.bCost != null ? t.bCost * (t.pct || 0) / 100 : null);

  /* voci del contratto: importo (tariffa), quote assegnate, costo nelle attività */
  const voci = (P.resources || []).filter(isLumpSum).map((r) => {
    const as = X.byRes.get(r.uid) || [];
    return { uid: r.uid, name: r.name, rate: r.rate, share: sum(as, (a) => a.units), cost: sum(as, (a) => a.cost), n: as.length, tasks: as.map((a) => a.task) };
  });
  const over = voci.filter((v) => v.n && Math.abs(v.share - 1) > EPS).sort((a, b) => Math.abs(b.cost - b.rate) - Math.abs(a.cost - a.rate));
  const unused = voci.filter((v) => !v.n && v.rate);

  const negFixed = L.filter((t) => (t.fixedCost || 0) < -0.005).map((t) => ({ uid: t.uid, fixed: t.fixedCost })).sort((a, b) => a.fixed - b.fixed);
  /* il costo è cambiato rispetto alla baseline (varianti o errori): i più grandi prima */
  const changed = L.filter((t) => t.bCost != null && t.cost != null && Math.abs(t.cost - t.bCost) > Math.max(1, Math.abs(t.bCost) * 0.001))
    .map((t) => ({ uid: t.uid, cost: t.cost, bCost: t.bCost })).sort((a, b) => Math.abs(b.cost - b.bCost) - Math.abs(a.cost - a.bCost));
  const noBase = L.filter((t) => t.bCost == null && t.cost).map((t) => t.uid);

  /* confronto con Project, attività per attività (dove Project ha scritto i suoi numeri) */
  const cmp = (tool, pj) => {
    const out = { n: 0, ok: 0, bad: [] };
    for (const t of L) {
      const p = pj(t), v = tool(t);
      if (p == null || v == null) continue;
      out.n++;
      if (same(v, p)) out.ok++; else out.bad.push({ uid: t.uid, tool: v, pj: p });
    }
    out.bad.sort((a, b) => Math.abs(b.tool - b.pj) - Math.abs(a.tool - a.pj));
    return out;
  };
  const pj = {
    earned: cmp(earnedAtSd, (t) => (t.pj ? t.pj.acwp : null)),    // maturato ↔ ACWP
    ev: cmp(ev, (t) => (t.pj ? t.pj.bcwp : null)),                 // valore guadagnato ↔ BCWP
    planned: cmp(planned, (t) => (t.pj ? t.pj.bcws : null)),       // previsto alla data ↔ BCWS
  };

  const tot = {
    cost: sum(L, (t) => t.cost), bCost: sum(L, (t) => t.bCost), earned: sum(L, earnedAtSd), planned: sum(L, planned), ev: sum(L, ev),
    fixed: sum(L, (t) => t.fixedCost), asg: sum(P.assignments || [], (a) => a.cost),
    voci: sum(voci, (v) => v.rate), vociIn: sum(voci, (v) => v.cost),
  };
  /* i conti tornano? voci (importo del contratto) contro attività, quando le voci ci sono.
     issues: le cose da guardare nel programma; pjBad: dove Project calcola diverso
     (i suoi conti interni: costi fissi maturati, % delle assegnazioni) */
  const vociGap = voci.length ? tot.cost - tot.voci : 0;
  const gapBad = voci.length > 0 && Math.abs(vociGap) > Math.max(1, tot.voci * 0.001);
  const issues = over.length + unused.length + negFixed.length + (gapBad ? 1 : 0);
  const pjBad = pj.earned.bad.length + pj.ev.bad.length + pj.planned.bad.length;
  return { has, tot, voci, over, unused, negFixed, changed, noBase, pj, vociGap, gapBad, issues, pjBad, sd };
}

/* le voci di un'attività: nome, quota, importo (nell'ordine dell'importo) */
export function taskVoci(P, X, uid) {
  return (X.byTask.get(uid) || []).map((a) => {
    const r = X.res.get(a.res);
    return { res: a.res, name: r ? r.name : "#" + a.res, lump: !!(r && isLumpSum(r)), units: a.units, cost: a.cost, aCost: a.aCost };
  }).sort((a, b) => (b.cost || 0) - (a.cost || 0));
}

/* =========================================================================
   C2: le fonti dei costi, la curva S, il SAL alla data
   Da un progetto all'altro gli importi stanno in posti diversi: il tool lo
   usano anche altri (l'utente, 2026-10-24), quindi la colonna dell'importo e
   quella del maturato si scelgono, programma per programma. Una fonte è una
   chiave:
   - "pj": il costo di Project (per il maturato: il costo effettivo);
   - "base": il costo della baseline (solo come importo);
   - "pct": importo × % completamento (solo come maturato);
   - un numero: il FieldID di un campo di costo o numerico (Cost1…, Number1…).
   fv(type, raw): il valore di un campo personalizzato (seq-io fieldValue,
   passato da chi chiama: questo modulo resta senza import).
   ========================================================================= */
const fieldOf = (P, key) => (P.fields || []).find((f) => f.id === key);
/* l'importo di un'attività secondo la fonte; null = l'attività non ha valore */
export function amountFn(P, key, fv) {
  if (key === "pj") return (t) => (t.cost == null ? null : t.cost);
  if (key === "base") return (t) => (t.bCost == null ? null : t.bCost);
  const f = fieldOf(P, key);
  if (!f) return () => null;
  return (t) => { const v = fv(f.type, t.ext ? t.ext[f.id] : null); return Number.isFinite(v) ? v : null; };
}
/* il maturato alla data di stato secondo la fonte */
export function doneFn(P, key, amt, fv) {
  if (key === "pct") return (t) => { const a = amt(t); return a == null ? null : a * (t.pct || 0) / 100; };
  if (key === "pj") return (t) => (t.aCost == null ? null : t.aCost);
  return amountFn(P, key, fv);
}
/* le colonne che possono portare gli importi, con quello che serve per
   sceglierle: su quante attività c'è un valore diverso da zero, il totale, un
   esempio. Il costo di Project, la baseline e il costo effettivo solo se il
   programma li ha. La proposta è il costo di Project quando c'è (l'unica
   colonna col senso fisso); senza, nessuna: sceglie l'utente.
   → { leaves, amt: [{ key, n, tot, ex }], done: [...], propose: { amt, done } } */
export function costSources(P, fv) {
  const L = P.tasks.filter((t) => !t.summary && !t.milestone);
  const stat = (fn) => {
    let n = 0, tot = 0, ex = null;
    for (const t of L) { const v = fn(t); if (v == null || Math.abs(v) < 0.005) continue; n++; tot += v; if (ex == null) ex = v; }
    return { n, tot, ex };
  };
  const amt = [], done = [{ key: "pct", n: null, tot: null, ex: null }];
  const pj = stat((t) => t.cost), base = stat((t) => t.bCost), act = stat((t) => t.aCost);
  if (pj.n) amt.push({ key: "pj", ...pj });
  if (base.n) amt.push({ key: "base", ...base });
  if (act.n) done.push({ key: "pj", ...act });
  for (const f of P.fields || []) {
    if (f.type !== "cost" && f.type !== "num") continue;
    const s = stat(amountFn(P, f.id, fv));
    amt.push({ key: f.id, ...s }); done.push({ key: f.id, ...s });
  }
  return { leaves: L.length, amt, done, propose: { amt: pj.n ? "pj" : null, done: "pct" } };
}
/* una fonte salvata vale ancora per questo programma? (una revisione può non avere più quel campo) */
export function sourceOk(P, key, kind) {
  if (key == null) return false;
  if (kind === "amt" && (key === "pj" || key === "base")) return true;
  if (kind === "done" && (key === "pct" || key === "pj")) return true;
  const f = fieldOf(P, key);
  return !!(f && (f.type === "cost" || f.type === "num"));
}

/**
 * La curva S: un valore per giorno, a mezzanotte, dal primo giorno del
 * programma all'ultimo (date di baseline, correnti ed effettive):
 * - plan: l'importo distribuito sulle date della baseline (un'attività senza
 *   baseline: sulle sue date correnti), in tempo lavorativo;
 * - earn, fino alla data di stato: il maturato distribuito fra l'inizio
 *   effettivo e la fine effettiva, o la data di stato. Project conosce solo la
 *   % di oggi: il passato è una stima lineare, come fa Project col costo;
 * - fc, dalla data di stato: il maturato più il residuo (importo − maturato,
 *   se positivo) sulle date previste. Senza data di stato: l'importo sulle
 *   date correnti, dall'inizio.
 * Un'attività senza valore conta zero: missing la dice (i cardini no). sums:
 * i riepiloghi con un valore loro diverso dalla somma delle loro attività
 * (serve t.parent: seq-core buildTree).
 * amt(t), done(t): le fonti scelte (amountFn, doneFn); working: il calendario.
 */
export function sCurve(P, { amt, done, sd = null, working = null }) {
  const L = P.tasks.filter((t) => !t.summary);
  let lo = Infinity, hi = -Infinity;
  for (const t of L) for (const v of [t.bStart, t.bFinish, t.start, t.finish, t.aStart, t.aFinish]) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!Number.isFinite(lo)) return null;
  if (sd != null) { lo = Math.min(lo, sd); hi = Math.max(hi, sd); }
  const from = dayFloor(lo), n = Math.ceil((hi - from) / DAY) + 2;
  const clock = working ? workClock(working, from, from + n * DAY) : (ms) => ms - from;
  const ck = new Float64Array(n);
  for (let k = 0; k < n; k++) ck[k] = clock(from + k * DAY);

  /* ogni attività è una rampa [a, b] → v; le rampe si sommano coi differenziali (O(attività + giorni)) */
  const items = { plan: [], earn: [], fc: [] };
  const missing = [];
  let total = 0, earned = 0;
  for (const t of L) {
    const v = amt(t);
    if (v == null) { if (!t.milestone) missing.push(t.uid); continue; }
    total += v;
    const pb = t.bStart != null && t.bFinish != null;
    items.plan.push({ uid: t.uid, a: pb ? t.bStart : t.start, b: pb ? t.bFinish : t.finish, v });
    if (sd == null) { items.fc.push({ uid: t.uid, a: t.start, b: t.finish, v }); continue; }
    const e = done(t) || 0;
    if (e) {
      const b = Math.min(t.aFinish ?? sd, sd), a = Math.min(t.aStart ?? t.start ?? b, b);
      items.earn.push({ uid: t.uid, a, b, v: e });
      earned += e;
    }
    const rest = v - e;
    if (rest > 0.005 && t.aFinish == null) { const a = Math.max(sd, t.start ?? sd); items.fc.push({ uid: t.uid, a, b: Math.max(a, t.finish ?? a), v: rest }); }
  }
  const series = (list, base = 0) => {
    const A = new Float64Array(n + 1), A2 = new Float64Array(n + 1), B = new Float64Array(n + 1), Cc = new Float64Array(n + 1);
    for (const { a, b: b0, v } of list) {
      if (!v || a == null || b0 == null) continue;
      const b = Math.max(a, b0);
      const ib = Math.min(n, Math.max(0, Math.ceil((b - from) / DAY)));         // dal primo giorno con t ≥ b: il valore intero
      Cc[ib] += v;
      const ia = Math.min(n, Math.max(0, Math.floor((a - from) / DAY) + 1));    // dal primo giorno con t > a: la rampa
      if (ia >= ib) continue;
      const ca = clock(a), cb = clock(b);
      if (cb > ca) { const s = v / (cb - ca); A[ia] += s; A[ib] -= s; B[ia] -= s * ca; B[ib] += s * ca; }
      else { const s = v / (b - a); A2[ia] += s; A2[ib] -= s; B[ia] -= s * (a - from); B[ib] += s * (a - from); }   // tutta in giorni non lavorativi: tempo di calendario
    }
    const out = new Float64Array(n);
    let a1 = 0, a2 = 0, bb = 0, cc = 0;
    for (let k = 0; k < n; k++) { a1 += A[k]; a2 += A2[k]; bb += B[k]; cc += Cc[k]; out[k] = base + a1 * ck[k] + a2 * k * DAY + bb + cc; }
    return out;
  };
  /* i riepiloghi con un valore loro (un campo scritto anche sulle righe di riepilogo) che non torna con le foglie */
  const sums = [];
  const acc = new Map();
  P.tasks.forEach((t, i) => {
    if (t.summary) return;
    const v = amt(t);
    if (v == null) return;
    for (let p = t.parent, g = 0; p != null && p >= 0 && g < 64; p = P.tasks[p].parent, g++) acc.set(p, (acc.get(p) || 0) + v);
  });
  P.tasks.forEach((t, i) => {
    if (!t.summary) return;
    const own = amt(t), s = acc.get(i) || 0;
    if (own != null && Math.abs(own - s) > Math.max(1, Math.abs(own) * 0.001)) sums.push({ uid: t.uid, own, sum: s });
  });
  return {
    from, n, sd, clock, items, total, earned, missing, sums,
    plan: series(items.plan), earn: sd != null ? series(items.earn) : null, fc: series(items.fc, sd != null ? earned : 0),
  };
}
/* il valore esatto di una serie alla data D (non dai campioni: dalle rampe) */
const rampsAt = (cv, list, D) => list.reduce((s, it) => s + it.v * frac(it.a, Math.max(it.a, it.b), D, cv.clock), 0);
/* alla data D: il programmato e il valore della curva (maturato fino alla data di stato, previsione dopo) */
export function curveAt(cv, D) {
  const plan = rampsAt(cv, cv.items.plan, D);
  if (cv.sd == null) return { plan, val: rampsAt(cv, cv.items.fc, D), kind: "fc" };
  if (D <= cv.sd) return { plan, val: rampsAt(cv, cv.items.earn, D), kind: "earn" };
  return { plan, val: cv.earned + rampsAt(cv, cv.items.fc, D), kind: "fc" };
}
/* di quanti giorni la curva è indietro (+) o avanti (−) sul programmato: la
   data in cui il programmato valeva quanto la curva vale a D. null se il
   programmato non ci arriva mai, o la curva è a zero */
export function curveDelay(cv, D) {
  const { val } = curveAt(cv, D);
  if (!(val > 0.005)) return null;
  const P = cv.plan;
  let k = 0;
  while (k < cv.n && P[k] < val - 0.005) k++;
  if (k >= cv.n) return null;
  let T = cv.from + k * DAY;
  if (k > 0 && P[k] > P[k - 1]) T -= (P[k] - val) / (P[k] - P[k - 1]) * DAY;
  return Math.round((D - T) / DAY);
}

/**
 * Il SAL alla data di stato, attività per attività e per riepilogo (WBS):
 * importo, maturato al SAL precedente, maturato a questo SAL, del periodo,
 * %, residuo. prev: Map(uid → maturato) di un SAL registrato; un numero (una
 * data: stimato dalla curva, fra inizio e fine effettivi); null (nessuno).
 * I riepiloghi sommano le loro foglie (serve t.parent).
 * → { rows: [{ i, sum, amt, prev, now, delta, pct, rest }], tot }
 */
export function salTable(P, cv, { amt, done, prev = null }) {
  const est = typeof prev === "number" ? new Map() : null;
  if (est) for (const it of cv.items.earn) est.set(it.uid, it.v * frac(it.a, Math.max(it.a, it.b), prev, cv.clock));
  const rows = P.tasks.map((t, i) => ({ i, sum: !!t.summary, amt: 0, prev: 0, now: 0, has: false }));
  const tot = { amt: 0, prev: 0, now: 0 };
  P.tasks.forEach((t, i) => {
    if (t.summary) return;
    const a = amt(t);
    if (a == null && !done(t)) return;
    const now = cv.sd != null ? done(t) || 0 : 0, pv = est ? est.get(t.uid) || 0 : prev ? prev.get(t.uid) || 0 : 0;
    for (let p = i, g = 0; p != null && p >= 0 && g < 64; p = P.tasks[p].parent, g++) {
      const r = rows[p];
      r.amt += a || 0; r.prev += pv; r.now += now; r.has = true;
    }
    tot.amt += a || 0; tot.prev += pv; tot.now += now;
  });
  const fin = (r) => ({ ...r, delta: r.now - r.prev, pct: r.amt ? r.now / r.amt : null, rest: r.amt - r.now });
  return { rows: rows.filter((r) => r.has).map(fin), tot: fin(tot) };
}
/* lo stesso SAL per voce di Project (risorsa): ogni attività divide importo e
   maturato fra le sue assegnazioni in proporzione al loro costo, e il resto
   (il costo fisso) va in una riga sua. Ha senso con l'importo dal costo di
   Project. → [{ res (uid o null = costo fisso), amt, prev, now, delta, pct, rest }] */
export function salByRes(P, X, sal) {
  const out = new Map();
  const add = (key, f, r) => {
    let o = out.get(key);
    if (!o) out.set(key, (o = { res: key, amt: 0, prev: 0, now: 0 }));
    o.amt += r.amt * f; o.prev += r.prev * f; o.now += r.now * f;
  };
  for (const r of sal.rows) {
    if (r.sum) continue;
    const t = P.tasks[r.i], base = t.cost;
    if (!base) { add(null, 1, r); continue; }
    let used = 0;
    for (const a of X.byTask.get(t.uid) || []) { const f = (a.cost || 0) / base; used += f; add(a.res, f, r); }
    if (Math.abs(1 - used) > 1e-9) add(null, 1 - used, r);
  }
  return [...out.values()].map((o) => ({ ...o, delta: o.now - o.prev, pct: o.amt ? o.now / o.amt : null, rest: o.amt - o.now }));
}
/* il maturato di questo SAL da registrare: uid → valore (le attività con un maturato) */
export function salRecord(P, done) {
  const v = {};
  for (const t of P.tasks) { if (t.summary) continue; const x = done(t); if (x) v[t.uid] = x; }      // senza arrotondare: rifatto sugli stessi dati, il periodo viene zero
  return v;
}

/* =========================================================================
   Sequenza 4D — motore del programma (tool 19, F0)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Puro, senza import né DOM (si prova in Node: test/test_seq_core.js).
   Lavora sul programma letto da seq-io.js (readMSPDI): albero WBS, righe
   visibili, calendario lavorativo, stato di un'attività a una data,
   scostamento dalla baseline, catena del ritardo lungo i legami, scala dei
   tempi del Gantt.

   Date «ingenue»: millisecondi come se l'ora del file fosse UTC. L'XML di
   Project non porta il fuso, e così l'ora legale non sposta niente: un giorno
   è sempre DAY millisecondi e i getUTC* danno l'ora scritta nel file.

   Le tre date di un'attività (decisione dell'utente 2026-10-23: Project è il
   master, il tool non ripianifica):
     programmato = baseline 0 (bStart, bFinish)  — quello firmato;
     previsto    = Start/Finish correnti          — il ricalcolo di Project;
     effettivo   = ActualStart/ActualFinish      — il cantiere al SAL.
   La data di stato (sd) separa le ultime due: prima vale l'effettivo, dopo
   il previsto (PIANO_Sequenza_4D.md §4).
   ========================================================================= */

export const DAY = 86400000;
export const dayFloor = (ms) => Math.floor(ms / DAY) * DAY;
export const dow = (ms) => new Date(ms).getUTCDay();                 // 0 = domenica
export const ymd = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/* settimana ISO 8601 (lunedì primo giorno, la settimana 1 contiene il 4 gennaio) */
export function isoWeek(ms) {
  const d = new Date(dayFloor(ms));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));            // il giovedì della stessa settimana
  const y = d.getUTCFullYear();
  return { year: y, week: Math.ceil(((d.getTime() - Date.UTC(y, 0, 1)) / DAY + 1) / 7) };
}
export const monthStart = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
export const addMonths = (ms, n) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1); };
export const weekStart = (ms) => dayFloor(ms) - ((dow(ms) + 6) % 7) * DAY;   // lunedì

/* =========================================================================
   Albero WBS
   ========================================================================= */

/* parent/children/depth dall'OutlineLevel (le attività arrivano in ordine di
   struttura, come le scrive Project). Restituisce gli indici delle radici. */
export function buildTree(tasks) {
  const stack = [];   // [livello, indice]
  const roots = [];
  tasks.forEach((t, i) => {
    t.children = [];
    while (stack.length && stack[stack.length - 1][0] >= t.level) stack.pop();
    t.parent = stack.length ? stack[stack.length - 1][1] : -1;
    t.depth = stack.length;
    if (t.parent >= 0) tasks[t.parent].children.push(i); else roots.push(i);
    stack.push([t.level, i]);
  });
  return roots;
}

/* righe da mostrare: i figli dei riepiloghi chiusi spariscono. Con un filtro
   (predicato sulle attività) restano le attività che passano e i loro
   antenati, così la struttura si legge sempre. */
export function visibleRows(tasks, collapsed, keep = null) {
  let pass = null;
  if (keep) {
    pass = new Uint8Array(tasks.length);
    tasks.forEach((t, i) => {
      if (!keep(t, i)) return;
      for (let j = i; j >= 0 && !pass[j]; j = tasks[j].parent) pass[j] = 1;
    });
  }
  const out = [];
  let skip = Infinity;
  tasks.forEach((t, i) => {
    if (t.depth > skip) return;
    skip = Infinity;
    if (pass && !pass[i]) return;
    out.push(i);
    if (t.summary && collapsed && collapsed.has(t.uid)) skip = t.depth;
  });
  return out;
}

/* successori: l'inverso dei PredecessorLink, per indice */
export function linkIndex(tasks) {
  const byUid = new Map(tasks.map((t, i) => [t.uid, i]));
  const succ = tasks.map(() => []);
  tasks.forEach((t, i) => {
    t.predIdx = [];
    for (const p of t.preds) {
      const j = byUid.get(p.uid);
      if (j == null) continue;
      t.predIdx.push(j);
      succ[j].push(i);
    }
  });
  tasks.forEach((t, i) => { t.succIdx = succ[i]; });
  return byUid;
}

/* =========================================================================
   Calendario lavorativo
   ========================================================================= */

/* calendari di seq-io: { uid, base, week[7] (null = eredita), exc[] }.
   Senza calendari: lunedì–venerdì. */
export function makeCalendar(cals, uid) {
  const byUid = new Map((cals || []).map((c) => [c.uid, c]));
  const chain = [];
  for (let c = byUid.get(uid), n = 0; c && n < 8; c = byUid.get(c.base), n++) chain.push(c);
  const cache = new Map();
  return function working(ms) {
    const d = dayFloor(ms);
    let v = cache.get(d);
    if (v != null) return v;
    v = null;
    for (const c of chain) {
      for (const e of c.exc) if (d >= e.from && d <= e.to) { v = e.working; break; }
      if (v != null) break;
    }
    if (v == null) {
      const wd = dow(d);
      for (const c of chain) if (c.week && c.week[wd] != null) { v = c.week[wd]; break; }
    }
    if (v == null) v = dow(d) !== 0 && dow(d) !== 6;
    cache.set(d, v);
    return v;
  };
}

/* il giorno lavorativo successivo (o lo stesso se lo è), entro un anno */
export function nextWorking(working, ms, dir = 1) {
  let d = dayFloor(ms);
  for (let n = 0; n < 370 && !working(d); n++) d += dir * DAY;
  return d;
}

/* =========================================================================
   Stato alla data
   ========================================================================= */

export const TODO = 0, RUN = 1, DONE = 2;

/* { ph: TODO|RUN|DONE, p: 0..1, act: true se la data cade nell'effettivo }.
   Prima della data di stato contano le date effettive (l'avanzamento in corso
   va da ActualStart a 0 % fino alla data di stato al PercentComplete, o fino
   ad ActualFinish al 100 %); dopo, le date correnti di Project, ripartendo
   dall'avanzamento alla data di stato. Senza data di stato: solo previsto
   (la pagina passa sd = null anche per un programma senza date effettive:
   mai aggiornato, l'effettivo non esiste e il tool lo dice). */
export function stateAt(t, D, sd) {
  if (sd != null && D <= sd) {
    if (t.aFinish != null && t.aFinish <= D) return { ph: DONE, p: 1, act: true };
    if (t.aStart != null && t.aStart <= D) {
      const end = t.aFinish != null ? t.aFinish : sd, pe = t.aFinish != null ? 1 : t.pct / 100;
      const p = end > t.aStart ? pe * (D - t.aStart) / (end - t.aStart) : pe;
      return { ph: p >= 1 ? DONE : RUN, p: clamp01(p), act: true };
    }
    return { ph: TODO, p: 0, act: true };
  }
  if (sd != null && (t.aStart != null || t.pct > 0)) {
    const s0 = stateAt(t, sd, sd);
    if (s0.ph === DONE) return { ph: DONE, p: 1, act: false };
    if (s0.ph === RUN) {
      if (D >= t.finish) return { ph: DONE, p: 1, act: false };
      const p = s0.p + (1 - s0.p) * (t.finish > sd ? (D - sd) / (t.finish - sd) : 1);
      return { ph: RUN, p: clamp01(p), act: false };
    }
  }
  return planState(t, D, false);
}
function planState(t, D, act) {
  if (t.finish <= t.start) return D >= t.start ? { ph: DONE, p: 1, act } : { ph: TODO, p: 0, act };
  if (D >= t.finish) return { ph: DONE, p: 1, act };
  if (D <= t.start) return { ph: TODO, p: 0, act };
  return { ph: RUN, p: clamp01((D - t.start) / (t.finish - t.start)), act };
}

/* scostamento della fine, in giorni di calendario: (effettiva o prevista) −
   programmata. null senza baseline. Positivo = in ritardo. */
export function finishVar(t) {
  if (t.bFinish == null) return null;
  const f = t.aFinish != null ? t.aFinish : t.finish;
  return Math.round((dayFloor(f) - dayFloor(t.bFinish)) / DAY);
}
export function startVar(t) {
  if (t.bStart == null) return null;
  const s = t.aStart != null ? t.aStart : t.start;
  return Math.round((dayFloor(s) - dayFloor(t.bStart)) / DAY);
}

/* catena del ritardo («da dove viene», design 19b): dall'attività scelta si
   risale, fra i predecessori in ritardo, quello TRAINANTE — il legame più
   stretto, cioè il minor margine fra la sua data e quella dell'attività che
   segue (un predecessore in ritardo ma con mesi di margine non sposta
   niente: il collaudo +28 gg non è ciò che fa slittare l'apertura) — finché
   il ritardo c'è. Ogni anello dice quanto ritardo porta, quanto ne ha
   assorbito il margine (ritardo del predecessore − ritardo di chi segue) o
   quanto se n'è aggiunto lungo il legame (il contrario: lì il ritardo nasce,
   come nel primo programma vero dell'utente, +110 → +164 gg).
   mpd = minuti per giorno, per portare il ritardo dei legami in giorni. */
function linkGap(p, s, l, mpd) {
  const a = l.type === "SS" || l.type === "SF" ? p.start : p.finish;
  const b = l.type === "FF" || l.type === "SF" ? s.finish : s.start;
  return (dayFloor(b) - dayFloor(a)) / DAY - (l.lag || 0) / mpd;
}
export function delayChain(tasks, i, max = 12, mpd = 480) {
  const out = [];
  const seen = new Set([i]);
  let cur = i;
  for (let n = 0; n < max; n++) {
    const t = tasks[cur];
    let best = -1, bv = 0, bg = Infinity;
    (t.predIdx || []).forEach((j) => {
      if (seen.has(j) || tasks[j].summary) return;
      const v = finishVar(tasks[j]);
      if (v == null || v <= 0) return;
      const g = linkGap(tasks[j], t, t.preds.find((l) => l.uid === tasks[j].uid) || {}, mpd);
      if (g < bg - 0.5 || (Math.abs(g - bg) <= 0.5 && v > bv)) { best = j; bv = v; bg = g; }
    });
    if (best < 0) break;
    const vCur = finishVar(tasks[cur]);
    out.push({ i: best, v: bv, absorbed: vCur != null && bv > vCur ? bv - vCur : 0, added: vCur != null && vCur > bv ? vCur - bv : 0 });
    seen.add(best);
    cur = best;
  }
  return out;
}

/* conteggi alla data sulle attività foglia (né riepiloghi né cardini) */
export function tally(tasks, D, sd) {
  const n = { done: 0, run: 0, todo: 0, late: 0 };
  for (const t of tasks) {
    if (t.summary || t.milestone) continue;
    const s = stateAt(t, D, sd);
    if (s.ph === DONE) n.done++; else if (s.ph === RUN) n.run++; else n.todo++;
    const v = finishVar(t);
    if (v != null && v > 0) n.late++;
  }
  return n;
}

/* =========================================================================
   Scala dei tempi del Gantt
   ========================================================================= */

/* due livelli come in Project, scelti dai pixel per giorno */
export function scaleUnits(pxPerDay) {
  if (pxPerDay >= 18) return { top: "week", bottom: "day" };
  if (pxPerDay >= 4.5) return { top: "month", bottom: "week" };
  if (pxPerDay >= 1.1) return { top: "year", bottom: "month" };
  if (pxPerDay >= 0.32) return { top: "year", bottom: "quarter" };
  return { top: null, bottom: "year" };
}
/* istanti d'inizio di ogni unità che tocca [t0, t1] (il primo può stare prima di t0) */
export function unitTicks(unit, t0, t1, max = 4000) {
  const out = [];
  let t;
  if (unit === "day") t = dayFloor(t0);
  else if (unit === "week") t = weekStart(t0);
  else if (unit === "month") t = monthStart(t0);
  else if (unit === "quarter") { const d = new Date(t0); t = Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1); }
  else { t = Date.UTC(new Date(t0).getUTCFullYear(), 0, 1); }
  while (t <= t1 && out.length < max) {
    out.push(t);
    if (unit === "day") t += DAY;
    else if (unit === "week") t += 7 * DAY;
    else if (unit === "month") t = addMonths(t, 1);
    else if (unit === "quarter") t = addMonths(t, 3);
    else t = addMonths(t, 12);
  }
  return out;
}

/* estremi del programma: dal primo inizio all'ultima fine fra tutte le date
   note (programmate, previste, effettive) */
export function span(tasks) {
  let a = Infinity, b = -Infinity;
  for (const t of tasks) {
    for (const v of [t.start, t.bStart, t.aStart]) if (v != null && v < a) a = v;
    for (const v of [t.finish, t.bFinish, t.aFinish]) if (v != null && v > b) b = v;
  }
  return a <= b ? { from: a, to: b } : null;
}

/* =========================================================================
   Tipo 4D di un'attività (design 19: costruzione, provvisoria, demolizione)
   ========================================================================= */

export const TYPES = ["build", "temp", "demo", "none"];
/* proposta dal nome, finché l'utente non sceglie: riepiloghi e cardini non
   toccano elementi; «demoli…» e «provvisori…» si riconoscono in IT ed EN, e
   così le attività che nel modello non hanno elementi (F3: nella copertura
   sono attese, non da collegare): forniture (ma «fornitura e posa» è una
   costruzione), collaudi e prove, progettazione e approvazioni */
export function guessType(t) {
  if (t.summary || t.milestone) return "none";
  const n = String(t.name || "").toLowerCase();
  if (/fornitur|supply|procurement/.test(n) && !/posa|install|montag|in opera|erection/.test(n)) return "none";
  if (/collaud|prove di carico|load test|commissioning|progettazion|approvazion/.test(n)) return "none";
  if (/demoli|smantell|rimozion|demolish|dismantl|removal/.test(n)) return "demo";
  if (/provvisor|temporane|temporary|deviazion|by-?pass/.test(n)) return "temp";
  return "build";
}

/* tipo scritto in un campo del programma, come lo tiene Navisworks TimeLiner
   («Costruzione», «Demolizione», «Temporaneo», e i tipi personalizzati come
   «Costruzione Involucro» del primo programma vero dell'utente, 2026-10-23).
   null se il valore non dice niente: allora vale il nome. */
export function typeFromValue(v) {
  const s = String(v ?? "").toLowerCase();
  if (!s) return null;
  if (/demol|smantell|rimozion|demolish|dismantl|remov/.test(s)) return "demo";
  if (/tempor|provvis/.test(s)) return "temp";
  if (/costru|construct|build|montag|install/.test(s)) return "build";
  return null;
}

/* quale campo di testo del programma porta il tipo 4D: quello in cui almeno 3
   attività foglia e il 60 % dei valori sono tipi riconosciuti */
export function pickTypeField(tasks, fields) {
  let best = null, bn = 0;
  for (const f of fields) {
    if (f.type && f.type !== "text") continue;
    let n = 0, ok = 0;
    for (const t of tasks) { if (t.summary || t.milestone || !t.ext[f.id]) continue; n++; if (typeFromValue(t.ext[f.id])) ok++; }
    if (ok >= 3 && ok >= 0.6 * n && ok > bn) { best = f.id; bn = ok; }
  }
  return best;
}

/* quale campo porta il codice che lega l'attività al modello: un campo di testo
   con un nome che lo dice (codice, WBS, attività, set, selezione), altrimenti
   quello con più valori diversi sulle foglie (i nomi dei set di selezione di
   TimeLiner: «Selezione 1.1.2»…), altrimenti la WBS di Project */
export function pickCodeField(tasks, fields, skip = null) {
  const text = fields.filter((f) => (!f.type || f.type === "text") && f.id !== skip);
  const named = text.find((f) => /wbs|codic|code|attivit|activity|\b4d\b|selez|select|\bset\b/i.test(f.alias || ""));
  if (named) return named.id;
  let best = "wbs", bd = 0;
  for (const f of text) {
    const vals = new Set();
    let n = 0;
    for (const t of tasks) { if (t.summary || t.milestone || !t.ext[f.id]) continue; n++; vals.add(t.ext[f.id]); }
    if (vals.size >= 3 && vals.size >= 0.3 * n && vals.size > bd) { best = f.id; bd = vals.size; }
  }
  return best;
}

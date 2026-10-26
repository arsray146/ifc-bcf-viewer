/* =========================================================================
   Sequenza 4D — lettura del cronoprogramma (tool 19, F0)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Senza DOM (si prova in Node: test/test_seq_io.js). Microsoft Project XML
   (MSPDI, «Salva con nome → XML»): progetto, attività, legami, baseline,
   date effettive, campi personalizzati, calendari. Il .mpp è binario e nel
   browser non si legge; Primavera (.xer, XML P6) si riconosce per dirlo
   chiaro invece di fallire muti. Formato in PIANO_Sequenza_4D.md §3.
   ========================================================================= */

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
const kids = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);
const kid = (el, name) => (el ? el.children.find((c) => c.name === name) || null : null);
const txt = (el, name) => { const k = kid(el, name); return k ? k.text.trim() : ""; };
const int = (el, name, d = 0) => { const v = parseInt(txt(el, name), 10); return Number.isFinite(v) ? v : d; };
const flt = (el, name, d = 0) => { const v = parseFloat(txt(el, name)); return Number.isFinite(v) ? v : d; };
const bool = (el, name) => { const v = txt(el, name).toLowerCase(); return v === "1" || v === "true"; };
/* importo: nell'XML di Project i costi sono in centesimi (le tariffe no); assente → null */
const money = (el, name) => { const k = kid(el, name); if (!k) return null; const v = parseFloat(k.text); return Number.isFinite(v) ? v / 100 : null; };
const baseOf = (el) => kids(el, "Baseline").find((b) => int(b, "Number", 0) === 0) || null;

/* data ingenua: «2026-01-07T08:00:00» → ms come se fosse UTC (seq-core.js) */
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || "").trim());
  if (!m) return null;
  const y = +m[1];
  if (y < 1984 || y > 2149) return null;     // Project scrive «NA» come 1984 o 2049-12-31 in certi campi vuoti: fuori scala → nulla
  return Date.UTC(y, +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}
const date = (el, name) => parseDate(txt(el, name));

/* durata ISO 8601 di Project («PT160H0M0S», «-PT8H0M0S», «P2DT4H0M0S») → minuti */
export function parseDur(s) {
  const m = /^(-)?P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s || "").trim());
  if (!m) return 0;
  const v = (+(m[2] || 0)) * 1440 + (+(m[3] || 0)) * 60 + (+(m[4] || 0)) + (+(m[5] || 0)) / 60;
  return m[1] ? -v : v;
}

/* formato della durata (DurationFormat / LagFormat): +32 = stimata («?») */
export function durUnit(fmt) {
  const f = fmt >= 35 ? fmt - 32 : fmt;
  return ({ 3: "m", 4: "em", 5: "h", 6: "eh", 7: "d", 8: "ed", 9: "w", 10: "ew", 11: "mo", 12: "emo", 19: "%", 20: "e%" })[f] || "d";
}

/* Testo1…Testo30: FieldID di Project, per i file che non scrivono la
   definizione in <ExtendedAttributes> */
const TEXT_IDS = [188743731, 188743734, 188743737, 188743740, 188743743, 188743746, 188743747, 188743748, 188743749, 188743750];
for (let k = 11; k <= 30; k++) TEXT_IDS.push(188743997 + k - 11);
export const FIELD_NAME = Object.fromEntries(TEXT_IDS.map((id, k) => [id, "Text" + (k + 1)]));

/* tipo di un campo personalizzato dal suo nome di Project (Start1, Duration1, Cost1, Number2, Flag3, Text4…) */
export function fieldType(name) {
  const n = String(name);
  if (/^(Start|Finish|Date)\d+$/i.test(n)) return "date";
  if (/^Duration\d+$/i.test(n)) return "dur";
  if (/^Cost\d+$/i.test(n)) return "cost";
  if (/^Number\d+$/i.test(n)) return "num";
  if (/^Flag\d+$/i.test(n)) return "flag";
  return "text";
}
/* valore di un campo personalizzato: date ingenue, durate in minuti, costi in valuta
   (nell'XML di Project i costi sono in centesimi, come in MPXJ), numeri, sì/no, testo */
export function fieldValue(type, raw) {
  if (raw == null || raw === "") return null;
  if (type === "date") return parseDate(raw);
  if (type === "dur") return parseDur(raw);
  if (type === "cost") { const v = parseFloat(raw); return Number.isFinite(v) ? v / 100 : null; }
  if (type === "num") { const v = parseFloat(raw); return Number.isFinite(v) ? v : null; }
  if (type === "flag") return raw === "1" || String(raw).toLowerCase() === "true";
  return String(raw);
}

const LINK = { 0: "FF", 1: "FS", 2: "SF", 3: "SS" };

/* che cosa è il file: «mspdi» | «p6xml» | «xer» | «mpp» | null */
export function sniff(head) {
  if (head instanceof Uint8Array) {
    if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return "mpp";   // contenitore OLE: .mpp
    head = new TextDecoder().decode(head.subarray(0, 4096));
  }
  const s = String(head).replace(/^﻿/, "").slice(0, 4096);
  if (/^ERMHDR/.test(s)) return "xer";
  if (/<APIBusinessObjects[\s>]/.test(s)) return "p6xml";
  if (/<Project[\s>]/.test(s) && /schemas\.microsoft\.com\/project|<Tasks[\s>]|<SaveVersion>/.test(s)) return "mspdi";
  if (/<Project[\s>]/.test(s)) return "mspdi";
  return null;
}

/* ---- calendari ---------------------------------------------------------- */
function readCalendar(c) {
  const cal = { uid: int(c, "UID", -1), name: txt(c, "Name"), base: int(c, "BaseCalendarUID", -1), week: [null, null, null, null, null, null, null], exc: [] };
  for (const w of kids(kid(c, "WeekDays"), "WeekDay")) {
    const dt = int(w, "DayType", -1), working = bool(w, "DayWorking");
    if (dt >= 1 && dt <= 7) cal.week[dt - 1] = working;               // 1 = domenica
    else if (dt === 0) {                                               // eccezione nel formato vecchio
      const tp = kid(w, "TimePeriod"), from = date(tp, "FromDate"), to = date(tp, "ToDate");
      if (from != null && to != null) cal.exc.push({ from: Math.floor(from / 864e5) * 864e5, to: Math.floor(to / 864e5) * 864e5, working, name: "" });
    }
  }
  for (const e of kids(kid(c, "Exceptions"), "Exception")) {
    const tp = kid(e, "TimePeriod"), from = date(tp, "FromDate"), to = date(tp, "ToDate");
    if (from == null || to == null) continue;
    const ex = { from: Math.floor(from / 864e5) * 864e5, to: Math.floor(to / 864e5) * 864e5, working: bool(e, "DayWorking"), name: txt(e, "Name") };
    /* il formato vecchio e quello nuovo descrivono gli stessi giorni: si tiene il nome */
    const dup = cal.exc.find((x) => x.from === ex.from && x.to === ex.to);
    if (dup) { dup.name = ex.name; dup.working = ex.working; } else cal.exc.push(ex);
  }
  return cal;
}

/* =========================================================================
   Microsoft Project XML → programma
   ========================================================================= */
export function readMSPDI(text) {
  const kind = sniff(text);
  if (kind && kind !== "mspdi") { const e = new Error(kind); e.code = kind; throw e; }
  const doc = parseXML(String(text).replace(/^﻿/, ""));
  const P = kid(doc, "Project");
  const T = kid(P, "Tasks");
  if (!P || !T) { const e = new Error("notProject"); e.code = "notProject"; throw e; }

  const mpd = flt(P, "MinutesPerDay", 480) || 480;
  const out = {
    name: txt(P, "Title") || txt(P, "Name"),
    file: txt(P, "Name"),
    start: date(P, "StartDate"), finish: date(P, "FinishDate"),
    statusDate: date(P, "StatusDate"), currentDate: date(P, "CurrentDate"),
    minutesPerDay: mpd, minutesPerWeek: flt(P, "MinutesPerWeek", mpd * 5), daysPerMonth: flt(P, "DaysPerMonth", 20),
    calendarUID: int(P, "CalendarUID", 1),
    saveVersion: int(P, "SaveVersion", 0),
    currency: txt(P, "CurrencySymbol"),
    calendars: kids(kid(P, "Calendars"), "Calendar").map(readCalendar),
    fields: [], tasks: [], warnings: [],
  };

  /* campi personalizzati: definizioni (nome di Project e alias dell'utente) */
  const fdef = new Map();
  for (const f of kids(kid(P, "ExtendedAttributes"), "ExtendedAttribute")) {
    const id = int(f, "FieldID", 0);
    if (id) fdef.set(id, { id, name: txt(f, "FieldName") || FIELD_NAME[id] || String(id), alias: txt(f, "Alias") });
  }

  const used = new Map();   // FieldID → numero di attività con un valore
  for (const el of kids(T, "Task")) {
    if (bool(el, "IsNull")) continue;                       // righe vuote del Gantt
    const level = int(el, "OutlineLevel", 1);
    if (level === 0) continue;                              // riepilogo del progetto (riga 0)
    const start = date(el, "Start"), finish = date(el, "Finish");
    if (start == null || finish == null) { out.warnings.push({ k: "noDates", uid: int(el, "UID", -1), name: txt(el, "Name") }); continue; }
    const base = baseOf(el);
    const ext = {};
    for (const x of kids(el, "ExtendedAttribute")) {
      const id = int(x, "FieldID", 0), v = txt(x, "Value");
      if (!id || v === "") continue;
      ext[id] = v;
      used.set(id, (used.get(id) || 0) + 1);
    }
    out.tasks.push({
      uid: int(el, "UID", -1), id: int(el, "ID", 0), guid: txt(el, "GUID"),
      name: txt(el, "Name"), wbs: txt(el, "WBS"), outline: txt(el, "OutlineNumber"), level,
      summary: bool(el, "Summary"), milestone: bool(el, "Milestone"), critical: bool(el, "Critical"),
      active: kid(el, "Active") ? bool(el, "Active") : true,
      start, finish,
      dur: parseDur(txt(el, "Duration")), durFmt: int(el, "DurationFormat", 7),
      pct: Math.max(0, Math.min(100, flt(el, "PercentComplete", 0))),
      aStart: date(el, "ActualStart"), aFinish: date(el, "ActualFinish"),
      bStart: base ? date(base, "Start") : null, bFinish: base ? date(base, "Finish") : null,
      bDur: base ? parseDur(txt(base, "Duration")) : null,
      slack: kid(el, "TotalSlack") ? flt(el, "TotalSlack", 0) / 10 : null,   // decimi di minuto
      /* vincolo (0.8.0): 0 il prima possibile, 1 il più tardi possibile, 2 deve iniziare il, 3 deve finire il,
         4 iniziare non prima del, 5 non oltre il, 6 finire non prima del, 7 non oltre il; la data solo dal 2 in su */
      ctype: int(el, "ConstraintType", 0), cdate: int(el, "ConstraintType", 0) > 1 ? date(el, "ConstraintDate") : null,
      calendarUID: int(el, "CalendarUID", -1),
      notes: txt(el, "Notes"),
      preds: kids(el, "PredecessorLink").map((l) => ({
        uid: int(l, "PredecessorUID", -1), type: LINK[int(l, "Type", 1)] || "FS",
        lag: flt(l, "LinkLag", 0) / 10, lagFmt: int(l, "LagFormat", 7),            // decimi di minuto → minuti
      })).filter((l) => l.uid >= 0),
      ext,
      /* costi (F7, PIANO §13): costo con le varianti, della baseline, effettivo, fisso,
         e l'earned value come l'ha calcolato Project (per il collaudo) */
      cost: money(el, "Cost"), bCost: base ? money(base, "Cost") ?? 0 : null, aCost: money(el, "ActualCost"), fixedCost: money(el, "FixedCost"),
      pj: { bcws: money(el, "BCWS"), bcwp: money(el, "BCWP"), acwp: money(el, "ACWP") },
    });
  }
  /* risorse (le voci del contratto, quando sono materiali senza unità) e assegnazioni */
  const RTYPE = { 0: "material", 1: "work", 2: "cost" };
  out.resources = kids(kid(P, "Resources"), "Resource").filter((r) => !bool(r, "IsNull") && int(r, "UID", 0) > 0).map((r) => ({
    uid: int(r, "UID", -1), id: int(r, "ID", 0), name: txt(r, "Name"),
    type: bool(r, "IsCostResource") ? "cost" : RTYPE[int(r, "Type", 1)] || "work",
    rate: flt(r, "StandardRate", 0), label: txt(r, "MaterialLabel"), budget: bool(r, "IsBudget"),
  }));
  out.assignments = kids(kid(P, "Assignments"), "Assignment").map((a) => {
    const base = baseOf(a);
    return { uid: int(a, "UID", -1), task: int(a, "TaskUID", -1), res: int(a, "ResourceUID", -1), units: flt(a, "Units", 0),
      cost: money(a, "Cost"), aCost: money(a, "ActualCost"), bCost: base ? money(base, "Cost") : null };
  }).filter((a) => a.task >= 0 && a.res > 0);                // −65535 = nessuna risorsa
  for (const [id, n] of used) {
    const d = fdef.get(id) || { id, name: FIELD_NAME[id] || String(id), alias: "" };
    out.fields.push({ ...d, type: fieldType(d.name), count: n });
  }
  out.fields.sort((a, b) => a.id - b.id);
  out.hasBaseline = out.tasks.some((t) => t.bFinish != null);
  out.hasActuals = out.tasks.some((t) => t.aStart != null);
  out.hasCosts = out.tasks.some((t) => t.cost) || out.assignments.some((a) => a.cost);
  if (!out.tasks.length) { const e = new Error("noTasks"); e.code = "noTasks"; throw e; }
  return out;
}

/* =========================================================================
   Modulo Pset comune — modelli di Property Set configurabili (tool 18 Trazione
   elettrica, F3; pensato anche per Sviluppo profili, che lo collega a parte)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Niente import, niente DOM: si prova in Node (test/test_pset_core.js).

   Un MODELLO dice quali Pset scrivere su quali oggetti e da dove viene ogni
   proprietà:
     { v: 1, sets: [{ name, kinds: ["mast", …], props: [{ name, src, key, type }] }] }
   - kinds = i tipi di oggetto del tool a cui si applica il Pset (il tool li
     elenca: per la Trazione elettrica palo, portale, fondazione);
   - src «field» = un campo del tool (key = nome del campo, il tool dà i valori),
     «const» = un valore fisso (key = il valore), «attr» = una colonna della
     tabella importata rimasta sull'oggetto (key = intestazione della colonna);
   - type = tipo IFC del valore (TYPES).
   Le proprietà senza valore non si scrivono; un Pset senza proprietà neppure.
   La scrittura STEP usa lo scrittore del tool chiamante (e, G, S, R, oh: le
   stesse funzioni di profile-io ifcDitch) → stesse righe che scrive oggi
   Sviluppo profili col suo props().
   Un modello si salva nel progetto e si esporta in .json per riusarlo.
   ========================================================================= */

export const PSET_VERSION = "1.0.0";
export const FORMAT = "viewifc-pset";
export const SOURCES = ["field", "const", "attr"];
/* tipo → entità IFC del valore e natura (testo, numero, intero, logico) */
export const TYPES = {
  label: { ifc: "IFCLABEL", k: "s" }, text: { ifc: "IFCTEXT", k: "s" }, identifier: { ifc: "IFCIDENTIFIER", k: "s" },
  length: { ifc: "IFCLENGTHMEASURE", k: "n" }, area: { ifc: "IFCAREAMEASURE", k: "n" }, volume: { ifc: "IFCVOLUMEMEASURE", k: "n" },
  angle: { ifc: "IFCPLANEANGLEMEASURE", k: "n" }, real: { ifc: "IFCREAL", k: "n" }, int: { ifc: "IFCINTEGER", k: "i" },
  bool: { ifc: "IFCBOOLEAN", k: "b" },
};
const str = (v) => (v == null ? "" : String(v)).trim();

/* un modello pulito: nomi senza spazi ai capi, sorgenti e tipi validi (altrimenti campo / testo), niente
   proprietà senza nome; accetta anche il file .json esportato ({ format, v, sets }) */
export function normalize(tpl) {
  const src = tpl && Array.isArray(tpl.sets) ? tpl.sets : [];
  return {
    v: 1,
    sets: src.map((s) => ({
      name: str(s && s.name),
      kinds: Array.isArray(s && s.kinds) ? [...new Set(s.kinds.map(str).filter(Boolean))] : [],
      props: (Array.isArray(s && s.props) ? s.props : []).map((p) => ({
        name: str(p && p.name),
        src: SOURCES.includes(p && p.src) ? p.src : "field",
        key: str(p && p.key),
        type: TYPES[p && p.type] ? p.type : "label",
      })).filter((p) => p.name),
    })),
  };
}

/* numeri anche con la virgola («2,25», «1.234,5»); logici da sì/no, true/false, 1/0 */
export function numberOf(v) {
  if (typeof v === "number") return v;
  const t = str(v).replace(/\s/g, "");
  if (!t) return NaN;
  return Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
}
export function boolOf(v) {
  if (typeof v === "boolean") return v;
  const t = str(v).toLowerCase();
  if (/^(si|sì|s|yes|y|true|vero|v|1|x)$/.test(t)) return true;
  if (/^(no|n|false|falso|f|0)$/.test(t)) return false;
  return null;
}
/* il valore tipizzato o null (niente proprietà) */
export function typed(type, v) {
  const T = TYPES[type] || TYPES.label;
  if (v == null || (typeof v === "string" && !v.trim())) return null;
  if (T.k === "s") return str(v);
  if (T.k === "b") return boolOf(v);
  const x = numberOf(v);
  if (!Number.isFinite(x)) return null;
  return T.k === "i" ? Math.round(x) : x;
}

/* i Pset di un oggetto del tipo kind: [{ name, props: [{ name, type, value }] }].
   ctx.field(key) = valore di un campo del tool; ctx.attr(key) = colonna della tabella sull'oggetto */
export function resolve(tpl, kind, ctx = {}) {
  const out = [];
  for (const s of normalize(tpl).sets) {
    if (!s.name || !s.kinds.includes(kind)) continue;
    const props = [];
    for (const p of s.props) {
      const raw = p.src === "const" ? p.key : p.src === "attr" ? (ctx.attr ? ctx.attr(p.key) : null) : ctx.field ? ctx.field(p.key) : null;
      const value = typed(p.type, raw);
      if (value != null) props.push({ name: p.name, type: p.type, value });
    }
    if (props.length) out.push({ name: s.name, props });
  }
  return out;
}

/* avvisi sul modello: { set, prop, code } — code: «noName» (Pset senza nome), «stdPrefix» (i nomi Pset_ sono
   di buildingSMART: un Pset proprio non li usa), «noKinds» (non si applica a nessun oggetto), «dupSet» (stesso
   nome per lo stesso tipo di oggetto), «dupProp» (proprietà ripetuta), «noKey» (campo o colonna non scelti),
   «badConst» (valore fisso che non è del tipo) */
export function warnings(tpl, opt = {}) {
  const w = [], seen = new Map(), fields = opt.fields ? new Set(opt.fields) : null;
  normalize(tpl).sets.forEach((s, i) => {
    if (!s.name) w.push({ set: i, prop: -1, code: "noName" });
    else if (/^(pset|qto)_/i.test(s.name)) w.push({ set: i, prop: -1, code: "stdPrefix" });
    if (!s.kinds.length) w.push({ set: i, prop: -1, code: "noKinds" });
    for (const k of s.kinds) { const key = k + "\u0000" + s.name.toLowerCase(); if (s.name && seen.has(key)) w.push({ set: i, prop: -1, code: "dupSet" }); seen.set(key, i); }
    const names = new Set();
    s.props.forEach((p, j) => {
      if (names.has(p.name.toLowerCase())) w.push({ set: i, prop: j, code: "dupProp" });
      names.add(p.name.toLowerCase());
      if (p.src !== "const" && !p.key) w.push({ set: i, prop: j, code: "noKey" });
      else if (p.src === "field" && fields && !fields.has(p.key)) w.push({ set: i, prop: j, code: "noKey" });
      if (p.src === "const" && p.key && typed(p.type, p.key) == null) w.push({ set: i, prop: j, code: "badConst" });
    });
  });
  return w;
}

/* il valore in STEP: S = stringa STEP (con gli apici), R = numero (v, cifre) */
export function stepValue(type, value, S, R) {
  const T = TYPES[type] || TYPES.label;
  if (T.k === "s") return `${T.ifc}(${S(value)})`;
  if (T.k === "b") return `${T.ifc}(${value ? ".T." : ".F."})`;
  if (T.k === "i") return `${T.ifc}(${Math.round(value)})`;
  return `${T.ifc}(${R(value, 6)})`;
}
/* scrive i Pset risolti su uno o più oggetti (targets = riferimenti «#n»): una IfcPropertySet per Pset e la sua
   IfcRelDefinesByProperties. w = { e(riga) → «#n», G() → GlobalId, S(testo) → stringa STEP, R(numero, cifre),
   oh = owner history («$» se non c'è) }. Ritorna i riferimenti dei Pset scritti */
export function writeStep(sets, w, targets) {
  const tg = (Array.isArray(targets) ? targets : [targets]).join(","), oh = w.oh || "$", out = [];
  for (const s of sets || []) {
    if (!s.props || !s.props.length) continue;
    const ps = s.props.map((p) => w.e(`IFCPROPERTYSINGLEVALUE(${w.S(p.name)},$,${stepValue(p.type, p.value, w.S, w.R)},$)`));
    const ref = w.e(`IFCPROPERTYSET(${w.G()},${oh},${w.S(s.name)},$,(${ps.join(",")}))`);
    w.e(`IFCRELDEFINESBYPROPERTIES(${w.G()},${oh},$,$,(${tg}),${ref})`);
    out.push(ref);
  }
  return out;
}

/* file .json del modello (per riusarlo in un altro progetto o nell'altro tool) */
export function toJSON(tpl, meta = {}) {
  return JSON.stringify({ format: FORMAT, v: 1, ...meta, sets: normalize(tpl).sets }, null, 2);
}
export function fromJSON(text) {
  let o;
  try { o = JSON.parse(String(text).replace(/^﻿/, "")); } catch (e) { throw new Error("json"); }
  if (!o || (o.format && o.format !== FORMAT) || !Array.isArray(o.sets)) throw new Error("format");
  return normalize(o);
}

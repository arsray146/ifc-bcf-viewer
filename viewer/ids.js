/* ============================================================================
   IDS parser + valutatore — puro, senza dipendenze (browser + Node).
   Feature "Controlli IDS" (branch feature/ids-checks).

   IDS = buildingSMART Information Delivery Specification (XML, schema 1.0).
   Definisce requisiti informativi verificabili su un modello IFC. Un IDS ha
   un blocco <ids:info> e una lista di <ids:specification>; ogni specifica ha:
     - <ids:applicability>  : i facet che selezionano GLI ELEMENTI da verificare
     - <ids:requirements>   : i facet che quegli elementi DEVONO soddisfare

   Sei tipi di facet (usabili in entrambe le sezioni):
     entity · attribute · classification · property · material · partOf

   Questo modulo è VOLUTAMENTE generico e data-driven: nessun aggancio a pset o
   proprietà specifici. Tutta la logica dipendente da web-ifc (lettura del
   modello) sta in viewer/index.html, che costruisce una "vista" normalizzata
   dell'elemento (vedi shape sotto) e la passa a evaluateSpec/evaluateIds.

   Element view (costruita dall'adapter in index.html):
     {
       ifcType,            // classe IFC in MAIUSCOLO, es. "IFCWALL"
       predefinedType,     // stringa o ""
       name, globalId,     // attributi comodi
       attributes:  { [Nome]: valore },                 // attributi IFC diretti
       psets:       { [pset]: { [prop]: {value, dataType} } },  // istanza + Type
       classifications: [ {system, value} ],
       materials:   [ nome, ... ],
       partOf:      [ {relation, wholeType, wholePredefinedType} ]
     }

   API principali:
     parseIds(xmlText)            -> { info, specs:[spec] }
     evaluateSpec(spec, views)    -> { spec, applicable[], passed[], failed[] }
     evaluateIds(idsDoc, views)   -> { info, specs:[result], summary }
     matchFacet(facet, view, opts)-> boolean
     matchValue(matcher, actual)  -> boolean

   NOTE / semplificazioni MVP (documentate, non bloccanti):
     - property.dataType: viene letto ma NON è imposto nel match (la derivazione
       del tipo lato viewer non è sempre affidabile → si evitano falsi negativi).
     - relazioni partOf esotiche e material set molto annidati: coperti i casi
       comuni, il resto si rifinisce dopo la QA.
============================================================================ */

const FACET_TYPES = new Set(["entity", "attribute", "classification", "property", "material", "partOf"]);

/* ------------------------------------------------------------------ *
 * 1) Mini-parser XML — namespace-aware, con decodifica entità.        *
 *    Stesso approccio di viewer/e57.js: nessun DOMParser, così gira    *
 *    identico in browser e nei test Node. Scansione slice-based per    *
 *    reggere IDS grandi (il file ANAS di studio è ~1.5 MB).            *
 * ------------------------------------------------------------------ */
function decodeEntities(s) {
  if (!s || s.indexOf("&") === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === "#") {
      const cp = (e[1] === "x" || e[1] === "X") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return isNaN(cp) ? m : String.fromCodePoint(cp);
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e] || m;
  });
}

function parseXML(str) {
  let i = 0;
  const n = str.length;
  const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13;
  const skipWs = () => { while (i < n && isWs(str.charCodeAt(i))) i++; };

  function parseNode() {
    // salta dichiarazioni / commenti / DOCTYPE / PI
    while (i < n) {
      if (str.startsWith("<?", i)) { const e = str.indexOf("?>", i); i = e < 0 ? n : e + 2; skipWs(); continue; }
      if (str.startsWith("<!--", i)) { const e = str.indexOf("-->", i); i = e < 0 ? n : e + 3; skipWs(); continue; }
      if (str.startsWith("<!", i)) { const e = str.indexOf(">", i); i = e < 0 ? n : e + 1; skipWs(); continue; }
      break;
    }
    if (str[i] !== "<") return null;
    i++; // '<'
    let start = i;
    while (i < n) { const c = str.charCodeAt(i); if (isWs(c) || c === 47 || c === 62) break; i++; } // ws / '/' / '>'
    const node = { name: str.slice(start, i), attrs: null, children: [], text: "" };

    // attributi
    while (i < n) {
      skipWs();
      const c = str[i];
      if (c === "/" || c === ">") break;
      start = i;
      while (i < n) { const cc = str.charCodeAt(i); if (isWs(cc) || cc === 61 || cc === 47 || cc === 62) break; i++; } // ws / '=' / '/' / '>'
      const an = str.slice(start, i);
      skipWs();
      if (str[i] === "=") {
        i++; skipWs();
        const q = str[i++]; start = i;
        while (i < n && str[i] !== q) i++;
        const av = str.slice(start, i); i++; // chiusura quote
        (node.attrs || (node.attrs = {}))[an] = decodeEntities(av);
      } else if (an) { (node.attrs || (node.attrs = {}))[an] = ""; }
    }
    if (str[i] === "/") { i += 2; node.attrs = node.attrs || {}; return node; } // '/>'
    i++; // '>'

    // contenuto
    let text = "";
    while (i < n) {
      if (str.startsWith("<![CDATA[", i)) { const e = str.indexOf("]]>", i); text += str.slice(i + 9, e < 0 ? n : e); i = e < 0 ? n : e + 3; continue; }
      if (str.startsWith("<!--", i)) { const e = str.indexOf("-->", i); i = e < 0 ? n : e + 3; continue; }
      if (str.startsWith("</", i)) { const e = str.indexOf(">", i); i = e < 0 ? n : e + 1; break; } // chiusura tag
      if (str[i] === "<") { const ch = parseNode(); if (ch) node.children.push(ch); continue; }
      start = i; while (i < n && str[i] !== "<") i++; text += str.slice(start, i);
    }
    node.attrs = node.attrs || {};
    node.text = decodeEntities(text).trim();
    return node;
  }
  skipWs();
  return parseNode();
}

/* localName: ignora il prefisso di namespace (ids:, xs:) */
const lname = (node) => { const nm = node.name; const k = nm.indexOf(":"); return k < 0 ? nm : nm.slice(k + 1); };
const child = (node, ln) => node ? (node.children.find(c => lname(c) === ln) || null) : null;
const children = (node, ln) => node ? node.children.filter(c => lname(c) === ln) : [];

/* ------------------------------------------------------------------ *
 * 2) Matcher di valore — <ids:simpleValue> oppure <xs:restriction>.   *
 * ------------------------------------------------------------------ */
function parseRestriction(rest) {
  const m = { kind: "restriction", base: (rest.attrs && rest.attrs.base) || "xs:string" };
  for (const c of rest.children) {
    const v = c.attrs ? c.attrs.value : undefined;
    switch (lname(c)) {
      case "enumeration": (m.enumeration || (m.enumeration = [])).push(v); break;
      case "pattern": m.pattern = v; break;
      case "minInclusive": m.minInclusive = Number(v); break;
      case "maxInclusive": m.maxInclusive = Number(v); break;
      case "minExclusive": m.minExclusive = Number(v); break;
      case "maxExclusive": m.maxExclusive = Number(v); break;
      case "length": m.length = Number(v); break;
      case "minLength": m.minLength = Number(v); break;
      case "maxLength": m.maxLength = Number(v); break;
      /* whiteSpace / totalDigits / fractionDigits: ignorati (soft) */
    }
  }
  return m;
}

/* Nodo contenitore (value/name/system/propertySet/baseName) -> matcher | null */
function parseMatcher(container) {
  if (!container) return null;
  const sv = child(container, "simpleValue");
  if (sv) return { kind: "simple", value: sv.text };
  const rest = child(container, "restriction");
  if (rest) return parseRestriction(rest);
  return null;
}

/* Il matcher impone davvero un valore, o vincola solo la presenza? */
function hasValueConstraint(m) {
  if (!m) return false;
  if (m.kind === "simple") return true;
  return !!(m.enumeration || m.pattern != null || m.length != null || m.minLength != null || m.maxLength != null ||
            m.minInclusive != null || m.maxInclusive != null || m.minExclusive != null || m.maxExclusive != null);
}

/* Un valore effettivo soddisfa il matcher? (null = nessun vincolo → true) */
function matchValue(matcher, actual) {
  if (matcher == null) return true;
  const s = actual == null ? "" : String(actual);
  if (matcher.kind === "simple") {
    if (s === matcher.value) return true;
    const a = Number(s), b = Number(matcher.value);          // fallback numerico ("0.30" ~ "0.3")
    return (s !== "" && matcher.value !== "" && !isNaN(a) && !isNaN(b) && a === b);
  }
  const m = matcher;
  if (m.enumeration) {
    let ok = m.enumeration.includes(s);
    if (!ok) { const a = Number(s); if (s !== "" && !isNaN(a)) ok = m.enumeration.some(e => Number(e) === a); }
    if (!ok) return false;
  }
  if (m.pattern != null) {
    let re = null; try { re = new RegExp("^(?:" + m.pattern + ")$"); } catch (e) { re = null; }
    if (re && !re.test(s)) return false;
  }
  if (m.length != null && s.length !== m.length) return false;
  if (m.minLength != null && s.length < m.minLength) return false;
  if (m.maxLength != null && s.length > m.maxLength) return false;
  if (m.minInclusive != null || m.maxInclusive != null || m.minExclusive != null || m.maxExclusive != null) {
    const a = Number(s); if (s === "" || isNaN(a)) return false;
    if (m.minInclusive != null && a < m.minInclusive) return false;
    if (m.maxInclusive != null && a > m.maxInclusive) return false;
    if (m.minExclusive != null && a <= m.minExclusive) return false;
    if (m.maxExclusive != null && a >= m.maxExclusive) return false;
  }
  return true;
}

/* Descrizione neutra (identificatori/valori) del vincolo, per i motivi. */
function describeMatcher(m) {
  if (!m) return "";
  if (m.kind === "simple") return m.value;
  const p = [];
  if (m.enumeration) p.push(m.enumeration.join(" | "));
  if (m.pattern != null) p.push("pattern: " + m.pattern);
  if (m.length != null) p.push("length=" + m.length);
  if (m.minLength != null) p.push("minLength=" + m.minLength);
  if (m.maxLength != null) p.push("maxLength=" + m.maxLength);
  if (m.minInclusive != null) p.push("≥" + m.minInclusive);
  if (m.maxInclusive != null) p.push("≤" + m.maxInclusive);
  if (m.minExclusive != null) p.push(">" + m.minExclusive);
  if (m.maxExclusive != null) p.push("<" + m.maxExclusive);
  return p.join(", ");
}

/* Maiuscola i letterali di un matcher (per i nomi di classe IFC). */
function upperMatcher(m) {
  if (!m) return m;
  if (m.kind === "simple") return { kind: "simple", value: (m.value || "").toUpperCase() };
  if (m.enumeration) return Object.assign({}, m, { enumeration: m.enumeration.map(x => (x || "").toUpperCase()) });
  return m;
}

/* ------------------------------------------------------------------ *
 * 3) Parsing dei facet e delle specifiche.                            *
 * ------------------------------------------------------------------ */
function parseFacet(node) {
  const t = lname(node);
  const a = node.attrs || {};
  const f = { type: t, cardinality: a.cardinality || null, instructions: a.instructions || "" };
  switch (t) {
    case "entity":
      f.name = upperMatcher(parseMatcher(child(node, "name")));
      f.predefinedType = parseMatcher(child(node, "predefinedType"));
      break;
    case "attribute":
      f.attrName = parseMatcher(child(node, "name"));
      f.value = parseMatcher(child(node, "value"));
      break;
    case "classification":
      f.system = parseMatcher(child(node, "system"));
      f.value = parseMatcher(child(node, "value"));
      f.uri = a.uri || null;
      break;
    case "property":
      f.propertySet = parseMatcher(child(node, "propertySet"));
      f.baseName = parseMatcher(child(node, "baseName"));
      f.value = parseMatcher(child(node, "value"));
      f.dataType = a.dataType || null;
      break;
    case "material":
      f.value = parseMatcher(child(node, "value"));
      f.uri = a.uri || null;
      break;
    case "partOf": {
      f.relation = (a.relation || "").toUpperCase() || null;
      const ent = child(node, "entity");
      f.entity = ent ? { name: upperMatcher(parseMatcher(child(ent, "name"))), predefinedType: parseMatcher(child(ent, "predefinedType")) } : null;
      break;
    }
  }
  return f;
}

function parseFacetList(sectionNode) {
  const out = [];
  if (!sectionNode) return out;
  for (const c of sectionNode.children) if (FACET_TYPES.has(lname(c))) out.push(parseFacet(c));
  return out;
}

function parseIds(xmlText) {
  const root = parseXML(xmlText);
  if (!root || lname(root) !== "ids") throw new Error("Non è un file IDS (radice <ids:ids> assente).");

  const info = {};
  const infoNode = child(root, "info");
  if (infoNode) for (const k of ["title", "description", "author", "date", "version", "copyright", "milestone", "purpose"]) {
    const c = child(infoNode, k); if (c) info[k] = c.text;
  }

  const specs = [];
  const specsNode = child(root, "specifications");
  if (specsNode) for (const sp of children(specsNode, "specification")) {
    const a = sp.attrs || {};
    const app = child(sp, "applicability");
    const req = child(sp, "requirements");
    specs.push({
      name: a.name || "",
      identifier: a.identifier || "",
      ifcVersion: a.ifcVersion || "",
      description: (child(sp, "description") || {}).text || a.description || "",
      instructions: a.instructions || "",
      applicability: {
        minOccurs: app && app.attrs ? app.attrs.minOccurs : undefined,
        maxOccurs: app && app.attrs ? app.attrs.maxOccurs : undefined,
        facets: parseFacetList(app)
      },
      requirements: { facets: parseFacetList(req) }
    });
  }
  return { info, specs };
}

/* ------------------------------------------------------------------ *
 * 4) Matching di un facet contro una vista elemento.                  *
 *    opts.ignoreValue = valuta solo la PRESENZA del soggetto          *
 *    (serve per la semantica di cardinality "optional"/"required").   *
 * ------------------------------------------------------------------ */
function matchingKeys(matcher, obj) {
  const keys = Object.keys(obj || {});
  if (!matcher) return keys;
  if (matcher.kind === "simple") return keys.filter(k => k === matcher.value);
  return keys.filter(k => matchValue(matcher, k));
}

function matchFacet(facet, view, opts) {
  opts = opts || {};
  switch (facet.type) {
    case "entity": {
      if (!matchValue(facet.name, view.ifcType)) return false;
      if (!opts.ignoreValue && hasValueConstraint(facet.predefinedType)) return matchValue(facet.predefinedType, view.predefinedType);
      return true;
    }
    case "attribute": {
      const attrs = view.attributes || {};
      const names = matchingKeys(facet.attrName, attrs);
      if (opts.ignoreValue) return names.length > 0;
      if (!names.length) return false;
      if (!hasValueConstraint(facet.value)) return names.some(nm => attrs[nm] != null && String(attrs[nm]) !== "");
      return names.some(nm => attrs[nm] != null && String(attrs[nm]) !== "" && matchValue(facet.value, attrs[nm]));
    }
    case "classification": {
      const refs = view.classifications || [];
      const sel = refs.filter(r => !hasValueConstraint(facet.system) || matchValue(facet.system, r.system));
      if (opts.ignoreValue) return sel.length > 0;
      if (!sel.length) return false;
      if (!hasValueConstraint(facet.value)) return true;
      return sel.some(r => matchValue(facet.value, r.value));
    }
    case "property": {
      const psets = view.psets || {};
      let exists = false, ok = false;
      for (const ps of matchingKeys(facet.propertySet, psets)) {
        const props = psets[ps] || {};
        for (const pr of matchingKeys(facet.baseName, props)) {
          exists = true;
          const cell = props[pr];
          const present = cell && cell.value != null && String(cell.value) !== "";
          if (!opts.ignoreValue) {
            if (!hasValueConstraint(facet.value)) { if (present) ok = true; }
            else if (present && matchValue(facet.value, cell.value)) ok = true;
          }
        }
      }
      return opts.ignoreValue ? exists : ok;
    }
    case "material": {
      const mats = view.materials || [];
      if (opts.ignoreValue) return mats.length > 0;
      if (!mats.length) return false;
      if (!hasValueConstraint(facet.value)) return true;
      return mats.some(nm => matchValue(facet.value, nm));
    }
    case "partOf": {
      const rels = view.partOf || [];
      const sel = rels.filter(r => !facet.relation || (r.relation || "").toUpperCase() === facet.relation);
      if (opts.ignoreValue) return sel.length > 0;
      if (!sel.length) return false;
      if (!facet.entity) return true;
      return sel.some(r => matchValue(facet.entity.name, r.wholeType) &&
        (!hasValueConstraint(facet.entity.predefinedType) || matchValue(facet.entity.predefinedType, r.wholePredefinedType)));
    }
    default:
      return true; // tipo non gestito: non deve generare falsi negativi
  }
}

/* ------------------------------------------------------------------ *
 * 5) Motivi di non conformità (strutturati, i18n a carico della UI).  *
 * ------------------------------------------------------------------ */
function facetLabel(f) {
  switch (f.type) {
    case "entity": return "IFC " + describeMatcher(f.name);
    case "attribute": return describeMatcher(f.attrName) || "(attributo)";
    case "classification": return hasValueConstraint(f.system) ? describeMatcher(f.system) : "(classificazione)";
    case "property": return describeMatcher(f.propertySet) + "." + describeMatcher(f.baseName);
    case "material": return "(materiale)";
    case "partOf": return "partOf" + (f.relation ? " " + f.relation : "");
    default: return f.type;
  }
}
function facetExpected(f) {
  if (f.type === "entity") return describeMatcher(f.name);
  if (f.type === "partOf") return f.entity ? describeMatcher(f.entity.name) : "";
  if (f.type === "classification") return describeMatcher(f.value) || describeMatcher(f.system);
  return describeMatcher(f.value);
}
function actualValue(f, view) {
  if (!view) return "";
  switch (f.type) {
    case "entity": return view.ifcType || "";
    case "attribute": {
      for (const nm of matchingKeys(f.attrName, view.attributes)) {
        const v = (view.attributes || {})[nm];
        if (v != null && String(v) !== "") return String(v);
      }
      return "";
    }
    case "property": {
      const psets = view.psets || {};
      for (const ps of matchingKeys(f.propertySet, psets))
        for (const pr of matchingKeys(f.baseName, psets[ps])) {
          const cell = psets[ps][pr];
          if (cell && cell.value != null && String(cell.value) !== "") return String(cell.value);
        }
      return "";
    }
    case "classification": {
      for (const r of (view.classifications || [])) if (!hasValueConstraint(f.system) || matchValue(f.system, r.system)) return r.value || "";
      return "";
    }
    case "material": return (view.materials || []).join(", ");
    default: return "";
  }
}
function makeReason(code, f, view) {
  return { code, facetType: f.type, label: facetLabel(f), expected: facetExpected(f), got: actualValue(f, view) };
}

/* ------------------------------------------------------------------ *
 * 6) Valutazione di una specifica e dell'intero IDS.                  *
 * ------------------------------------------------------------------ */
function isApplicable(spec, view) {
  const fs = spec.applicability.facets;
  if (!fs.length) return false;                 // senza facet non si applica a nulla (niente falsi positivi di massa)
  return fs.every(f => matchFacet(f, view));
}

function evaluateSpec(spec, views) {
  const applicable = [], passed = [], failed = [];
  for (const v of views) {
    if (!isApplicable(spec, v)) continue;
    applicable.push(v);
    const reasons = [];
    for (const f of spec.requirements.facets) {
      const card = f.cardinality || "required";
      if (card === "prohibited") {
        if (matchFacet(f, v)) reasons.push(makeReason("prohibited", f, v));
      } else if (card === "optional") {
        if (matchFacet(f, v, { ignoreValue: true }) && !matchFacet(f, v)) reasons.push(makeReason("badValue", f, v));
      } else { // required
        if (!matchFacet(f, v, { ignoreValue: true })) reasons.push(makeReason("missing", f, v));
        else if (!matchFacet(f, v)) reasons.push(makeReason("badValue", f, v));
      }
    }
    if (reasons.length) failed.push({ view: v, reasons }); else passed.push(v);
  }
  return { spec, applicable, passed, failed };
}

function evaluateIds(idsDoc, views) {
  const specs = idsDoc.specs.map(s => evaluateSpec(s, views));
  let applicable = 0, passed = 0, failed = 0;
  for (const r of specs) { applicable += r.applicable.length; passed += r.passed.length; failed += r.failed.length; }
  return { info: idsDoc.info, specs, summary: { specs: specs.length, applicable, passed, failed } };
}

export {
  parseIds, evaluateIds, evaluateSpec, isApplicable,
  matchFacet, matchValue, hasValueConstraint, describeMatcher,
  parseXML, FACET_TYPES
};

/* =========================================================================
   Sviluppo profili (Profile Sweep) — lettori e scrittori, tool 17 di viewifc.com
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Lettori: DXF ASCII (parser nostro) e DWG (LibreDWG in WebAssembly, nel
   vendor, caricato solo quando serve). Tutti e due danno lo stesso
   «disegno»: { insunits, polys: [{ layer, pts: [{ x, y, b }], closed, src }],
   counts, inserts, skipped }. Linee e archi sciolti dello stesso layer si
   concatenano in polilinee (un profilo a volte arriva così).

   Scrittori: polilinea 3D in DXF (R12, la apre qualunque CAD), LandXML 1.2
   (asse con Line/Curve + profilo a PVI, come il tool Alignment → LandXML:
   coordinate «Nord Est», azimut da nord).

   Fatti misurati sui DWG dell'utente (2026-10-04): AC1032, INSUNITS = 4
   (millimetri) ma coordinate in METRI → l'unità dichiarata non si usa mai
   da sola per scalare: la pagina la mostra e lascia decidere.
   ========================================================================= */

/* -------------------------------------------------------------------------
   DXF ASCII
   ------------------------------------------------------------------------- */

/** Testo di un DXF da byte: UTF-8 se valido (DXF 2007+), altrimenti Windows-1252. */
export function decodeDXF(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (e) { return new TextDecoder("windows-1252").decode(bytes); }
}

/**
 * DXF ASCII → disegno. Legge LWPOLYLINE, POLYLINE (2D e 3D; le mesh no),
 * LINE e ARC della sezione ENTITIES; i blocchi (INSERT) si contano e basta.
 * OCS: si gestisce il caso comune dell'estrusione (0,0,−1) (specchiato in X).
 */
export function parseDXF(text) {
  if (text.startsWith("AutoCAD Binary DXF")) throw new Error("DXF_BINARY");
  const L = text.split(/\r\n|\r|\n/);
  const out = { insunits: null, acadver: null, polys: [], counts: {}, inserts: 0, skipped: 0 };
  const segs = [];
  let i = 0, section = null;
  const code = () => parseInt(L[i], 10);
  // ciclo a coppie (codice, valore)
  while (i + 1 < L.length) {
    const c = code(), v = L[i + 1].trim();
    if (c === 0 && v === "SECTION") { section = (L[i + 3] || "").trim(); i += 4; continue; }
    if (c === 0 && v === "ENDSEC") { section = null; i += 2; continue; }
    if (c === 0 && v === "EOF") break;
    if (section === "HEADER" && c === 9) {
      if (v === "$INSUNITS") out.insunits = parseInt(L[i + 3], 10);
      if (v === "$ACADVER") out.acadver = (L[i + 3] || "").trim();
      i += 2; continue;
    }
    if (section === "ENTITIES" && c === 0) {
      const type = v;
      out.counts[type] = (out.counts[type] || 0) + 1;
      i += 2;
      // raccogli i gruppi dell'entità fino al prossimo 0
      const g = [];
      while (i + 1 < L.length && code() !== 0) { g.push([code(), L[i + 1]]); i += 2; }
      const get = (k, d) => { for (const [a, b] of g) if (a === k) return b; return d; };
      const layer = String(get(8, "0")).trim();
      const mir = Number(get(230, 1)) < 0;              // estrusione (0,0,−1): X specchiata
      if (type === "LWPOLYLINE") {
        const pts = [];
        for (const [a, b] of g) {
          if (a === 10) pts.push({ x: Number(b) * (mir ? -1 : 1), y: 0, b: 0 });
          else if (a === 20 && pts.length) pts[pts.length - 1].y = Number(b);
          else if (a === 42 && pts.length) pts[pts.length - 1].b = Number(b) * (mir ? -1 : 1);
        }
        const closed = (parseInt(get(70, "0"), 10) & 1) === 1;
        if (pts.length >= 2) out.polys.push({ layer, pts, closed, src: "LWPOLYLINE", z: Number(get(38, 0)) });
      } else if (type === "POLYLINE") {
        const flags = parseInt(get(70, "0"), 10);
        const pts = [];
        // VERTEX … SEQEND
        while (i + 1 < L.length) {
          const vt = L[i + 1].trim();
          if (code() !== 0) { i += 2; continue; }
          if (vt === "SEQEND") { i += 2; while (i + 1 < L.length && code() !== 0) i += 2; break; }
          if (vt !== "VERTEX") break;
          i += 2;
          const vg = [];
          while (i + 1 < L.length && code() !== 0) { vg.push([code(), L[i + 1]]); i += 2; }
          const vget = (k, d) => { for (const [a, b] of vg) if (a === k) return b; return d; };
          const vf = parseInt(vget(70, "0"), 10);
          if (vf & 16) continue;                          // punto di controllo di una spline
          pts.push({ x: Number(vget(10, 0)), y: Number(vget(20, 0)), z: Number(vget(30, 0)), b: Number(vget(42, 0)) });
        }
        if (flags & (16 | 64)) { out.skipped++; continue; }   // mesh e polyface: non sono linee
        if (pts.length >= 2) out.polys.push({ layer, pts, closed: (flags & 1) === 1, src: flags & 8 ? "POLYLINE3D" : "POLYLINE" });
      } else if (type === "LINE") {
        segs.push({ layer, x0: Number(get(10, 0)), y0: Number(get(20, 0)), x1: Number(get(11, 0)), y1: Number(get(21, 0)), b: 0 });
      } else if (type === "ARC") {
        const cx = Number(get(10, 0)) * (mir ? -1 : 1), cy = Number(get(20, 0)), r = Number(get(40, 0));
        let a0 = Number(get(50, 0)) * Math.PI / 180, a1 = Number(get(51, 0)) * Math.PI / 180;
        if (mir) { const t = Math.PI - a1; a1 = Math.PI - a0; a0 = t; }
        segs.push(arcSeg(layer, cx, cy, r, a0, a1, mir));
      } else if (type === "INSERT") out.inserts++;
      continue;
    }
    i += 2;
  }
  out.polys.push(...chainSegments(segs));
  return out;
}

/** Arco (centro, raggio, angoli antiorari a0 → a1) come lato con bulge. */
function arcSeg(layer, cx, cy, r, a0, a1, flip = false) {
  let sw = a1 - a0;
  while (sw <= 0) sw += 2 * Math.PI;
  const s = { layer, x0: cx + r * Math.cos(a0), y0: cy + r * Math.sin(a0), x1: cx + r * Math.cos(a1), y1: cy + r * Math.sin(a1), b: Math.tan(sw / 4) };
  if (flip) return { layer, x0: s.x1, y0: s.y1, x1: s.x0, y1: s.y0, b: -s.b };
  return s;
}

/**
 * Linee e archi sciolti → polilinee, layer per layer, unendo i capi che
 * coincidono (entro tol). Un lato percorso al contrario cambia segno al bulge.
 */
export function chainSegments(segs, tol = 1e-3) {
  const byLayer = new Map();
  for (const s of segs) { if (!byLayer.has(s.layer)) byLayer.set(s.layer, []); byLayer.get(s.layer).push(s); }
  const out = [];
  const key = (x, y) => Math.round(x / tol) + "," + Math.round(y / tol);
  for (const [layer, list] of byLayer) {
    const ends = new Map();                              // capo → [indice del lato]
    const add = (k, idx) => { if (!ends.has(k)) ends.set(k, []); ends.get(k).push(idx); };
    list.forEach((s, idx) => { add(key(s.x0, s.y0), idx); add(key(s.x1, s.y1), idx); });
    const used = new Uint8Array(list.length);
    const other = (k, idx) => (ends.get(k) || []).find((j) => j !== idx && !used[j]);
    // parti da un capo libero (grado 1) se c'è, così la catena non nasce a metà
    const order = list.map((_, idx) => idx).sort((a, b) => {
      const da = Math.min(ends.get(key(list[a].x0, list[a].y0)).length, ends.get(key(list[a].x1, list[a].y1)).length);
      const db = Math.min(ends.get(key(list[b].x0, list[b].y0)).length, ends.get(key(list[b].x1, list[b].y1)).length);
      return da - db;
    });
    for (const start of order) {
      if (used[start]) continue;
      used[start] = 1;
      let s = list[start];
      if ((ends.get(key(s.x0, s.y0)) || []).some((j) => j !== start && !used[j]) && !(ends.get(key(s.x1, s.y1)) || []).some((j) => j !== start && !used[j])) {
        s = { ...s, x0: s.x1, y0: s.y1, x1: s.x0, y1: s.y0, b: -s.b };      // il capo libero davanti
      }
      const pts = [{ x: s.x0, y: s.y0, b: s.b }, { x: s.x1, y: s.y1, b: 0 }];
      // avanti
      for (;;) {
        const tail = pts[pts.length - 1], k = key(tail.x, tail.y), j = other(k, -1);
        if (j === undefined) break;
        used[j] = 1;
        let t = list[j];
        if (key(t.x0, t.y0) !== k) t = { ...t, x0: t.x1, y0: t.y1, x1: t.x0, y1: t.y0, b: -t.b };
        tail.b = t.b;
        pts.push({ x: t.x1, y: t.y1, b: 0 });
      }
      const closed = pts.length > 2 && key(pts[0].x, pts[0].y) === key(pts[pts.length - 1].x, pts[pts.length - 1].y);
      out.push({ layer, pts, closed, src: "LINE/ARC" });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------
   DWG (LibreDWG in WebAssembly)
   ------------------------------------------------------------------------- */

let dwgLib = null;                                       // { mod, wasmBinary }

/**
 * DWG → disegno. base = URL della cartella vendor/libredwg-web/ (con la
 * barra finale). Il .wasm si scarica una volta; per ogni file un'istanza
 * nuova (vedi README del vendor). In Node si può passare { wasmBinary }.
 */
export async function readDWG(bytes, { base, wasmBinary } = {}) {
  if (!dwgLib) {
    const mod = await import(new URL("dist/libredwg-web.js", base).href);
    const bin = wasmBinary || new Uint8Array(await (await fetch(new URL("wasm/libredwg-web.wasm", base))).arrayBuffer());
    dwgLib = { mod, wasmBinary: bin };
  }
  const { mod, wasmBinary: bin } = dwgLib;
  const inst = await mod.createModule({ wasmBinary: bin });
  const lib = mod.LibreDwg.createByWasmInstance(inst);
  const dwg = lib.dwg_read_data(bytes, mod.Dwg_File_Type.DWG);
  if (!dwg) throw new Error("DWG_READ");
  const db = lib.convert(dwg);
  return dwgToDrawing(db);
}

/** Database convertito da libredwg-web → disegno (stessa forma di parseDXF). */
export function dwgToDrawing(db) {
  const out = { insunits: db.header ? db.header.INSUNITS ?? null : null, acadver: null, polys: [], counts: {}, inserts: 0, skipped: 0 };
  const segs = [];
  for (const e of db.entities || []) {
    out.counts[e.type] = (out.counts[e.type] || 0) + 1;
    const layer = String(e.layer ?? "0");
    const mir = e.extrusionDirection && e.extrusionDirection.z < 0;
    if (e.type === "LWPOLYLINE") {
      const pts = (e.vertices || []).map((v) => ({ x: v.x * (mir ? -1 : 1), y: v.y, b: (v.bulge || 0) * (mir ? -1 : 1) }));
      if (pts.length >= 2) out.polys.push({ layer, pts, closed: (e.flag & 512) !== 0, src: "LWPOLYLINE", z: e.elevation || 0 });
    } else if (e.type === "POLYLINE2D" || e.type === "POLYLINE3D") {
      if (e.flag & (16 | 64)) { out.skipped++; continue; }
      const pts = (e.vertices || []).filter((v) => !(v.flag & 16)).map((v) => ({ x: v.x, y: v.y, z: v.z || 0, b: v.bulge || 0 }));
      if (pts.length >= 2) out.polys.push({ layer, pts, closed: (e.flag & 1) !== 0, src: e.type === "POLYLINE3D" ? "POLYLINE3D" : "POLYLINE" });
    } else if (e.type === "LINE") {
      segs.push({ layer, x0: e.startPoint.x, y0: e.startPoint.y, x1: e.endPoint.x, y1: e.endPoint.y, b: 0 });
    } else if (e.type === "ARC") {
      const cx = e.center.x * (mir ? -1 : 1);
      let a0 = e.startAngle, a1 = e.endAngle;
      if (mir) { const t = Math.PI - a1; a1 = Math.PI - a0; a0 = t; }
      segs.push(arcSeg(layer, cx, e.center.y, e.radius, a0, a1, mir));
    } else if (e.type === "INSERT") out.inserts++;
  }
  out.polys.push(...chainSegments(segs));
  return out;
}

/** Disegno da byte, riconoscendo il formato dalla firma: DWG «AC10…», altrimenti DXF. */
export async function readDrawing(bytes, opts = {}) {
  const sig = String.fromCharCode(...bytes.subarray(0, 6));
  if (/^AC1\d{3}$/.test(sig)) return { ...(await readDWG(bytes, opts)), format: "DWG", version: sig };
  const d = parseDXF(decodeDXF(bytes));
  return { ...d, format: "DXF", version: d.acadver };
}

/**
 * Riepilogo per layer: [{ layer, n (polilinee), verts, length, arcs, closed, bbox }]
 * ordinato per nome. Serve alla pagina per proporre la polilinea giusta.
 */
export function layerSummary(drawing, polyLength) {
  const m = new Map();
  for (const p of drawing.polys) {
    let r = m.get(p.layer);
    if (!r) m.set(p.layer, r = { layer: p.layer, n: 0, verts: 0, length: 0, arcs: 0, closed: 0, bbox: [Infinity, Infinity, -Infinity, -Infinity] });
    r.n++; r.verts += p.pts.length; r.length += polyLength(p); if (p.closed) r.closed++;
    for (const q of p.pts) {
      if (q.b) r.arcs++;
      if (q.x < r.bbox[0]) r.bbox[0] = q.x; if (q.y < r.bbox[1]) r.bbox[1] = q.y;
      if (q.x > r.bbox[2]) r.bbox[2] = q.x; if (q.y > r.bbox[3]) r.bbox[3] = q.y;
    }
  }
  return [...m.values()].sort((a, b) => a.layer.localeCompare(b.layer));
}

/**
 * Layer proposto per ogni ruolo dai nomi (PLANIMETRICO / ASSE; CONDOTTA /
 * SCORRIMENTO / PROGETTO… / QUOTE; TERRENO). Fuori i layer della tabella sotto
 * il profilo (cartiglio, testi, linee delle sezioni: Roads li mette in
 * P_CART*, P_SEZIONI-*). Fra più candidati: prima la parola più forte, poi la
 * linea fatta di meno pezzi e più vertici (il terreno vero, non 36 trattini).
 * «IDR MDL quote» (inalveazione 400X250) è la linea di progetto: QUOTE è la
 * parola più debole, la vince qualunque nome più chiaro.
 */
const NOT_LINE = /SEZION|CART|TXT|TEST|QUOTA[-_ ]?RIF|GRIGLI|GRID|CHITARR|TABELL/i;
export function guessLayers(summary) {
  const before = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
  const pick = (res, not) => {
    let best = null, bk = null;
    for (const r of summary) {
      if (NOT_LINE.test(r.layer) || (not && not.test(r.layer))) continue;
      const w = res.findIndex((re) => re.test(r.layer));
      if (w < 0) continue;
      const k = [w, r.n, -r.verts / r.n];          // parola più forte, meno pezzi, più vertici per pezzo
      if (!bk || before(k, bk)) { best = r; bk = k; }
    }
    return best;
  };
  return {
    plan: pick([/PLANIM|PIANTA|TRACCIAT|ALIGN/i, /ASSE/i]),
    design: pick([/SCORR|CONDOTT|FONDO|LIVELLETT/i, /PROGETT|TUBAZ|FOSSO|CANAL|INALVEAZ/i, /\bQUOT[AE]\b/i], /TERREN|GROUND/i),
    ground: pick([/TERREN|GROUND|ESISTENT/i]),
  };
}

/**
 * Ruolo di un disegno appena aperto. Prima le COORDINATE: la pianta sta in
 * coordinate cartografiche (Gauss-Boaga, UTM: numeri > 10 000), il profilo in
 * coordinate piccole (progressive, quote). Poi il NOME DEL FILE (PLANIMETRICO /
 * ALTIMETRICO / PROFILO) e solo alla fine i nomi dei layer: nel fosso VI02
 * «asse» sta nei layer di tutti e due i disegni («asse profilo» in pianta,
 * «quote scorrimento asse» nel profilo).
 * Ritorna { plan, design, ground, sum } (nomi di layer o null).
 */
export function classifyDrawing(drawing, fileName, polyLength) {
  const sum = layerSummary(drawing, polyLength);
  const big = (a, b) => Math.min(Math.abs(a), Math.abs(b)) > 10000;
  const cart = (r) => big(r.bbox[0], r.bbox[2]) && big(r.bbox[1], r.bbox[3]);
  const planL = sum.filter(cart), profL = sum.filter((r) => !cart(r));
  const longest = (rows) => rows.slice().sort((a, b) => b.length - a.length)[0] || null;
  const out = { plan: null, design: null, ground: null, sum };
  const fn = String(fileName || "").replace(/\.[^.]+$/, "");
  const nameKind = /PLANIMETR|PIANTA|TRACCIAT/i.test(fn) ? "plan" : /ALTIMETR|PROFIL|LONGITUDIN/i.test(fn) ? "prof" : null;
  if (planL.length) out.plan = (guessLayers(planL).plan || longest(planL)).layer;
  if (profL.length) {
    const g = guessLayers(profL);
    out.design = g.design ? g.design.layer : null;
    out.ground = g.ground ? g.ground.layer : null;
    // nessun nome utile in un disegno tutto in coordinate piccole: la linea più lunga
    if (!planL.length && !out.design && !out.ground) {
      if (nameKind === "plan") out.plan = (g.plan || longest(profL)).layer;
      else out.design = longest(profL).layer;
    } else if (!planL.length && nameKind === "plan" && g.plan) {
      out.plan = g.plan.layer; out.design = null; out.ground = null;      // pianta in coordinate locali
    } else if (!out.design && out.ground) {
      // il terreno c'è ma il progetto ha un nome che non diciamo: la linea in meno pezzi che copre
      // almeno metà delle progressive del terreno, fuori dalla tabella
      const gr = profL.find((r) => r.layer === out.ground), span = (r) => r.bbox[2] - r.bbox[0];
      const cand = profL.filter((r) => r !== gr && !NOT_LINE.test(r.layer) && r.n <= 3 && span(r) >= 0.5 * span(gr))
        .sort((a, b) => a.n - b.n || b.length - a.length);
      if (cand.length) out.design = cand[0].layer;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------
   Più opere nello stesso progetto (scelte dell'utente 2026-10-04): il nome
   dell'opera viene dal file della pianta ripulito dalle parole di servizio;
   quando arrivano più piante e più profili, un profilo va alla pianta che gli
   somiglia nel nome (file + layer) e nella lunghezza (scala delle distanze
   compresa) — nella pagina si corregge da un menu.
   ------------------------------------------------------------------------- */
const SERVICE = "profil[oi]|profile|planimetric[oaie]|planimetri[ae]|altimetric[oaie]|altimetri[ae]|pianta|plan|asse|axis|alignment|longitudinale|tracciato";
const SERVICE_RE = new RegExp(`(^|[\\s_\\-–.]+)(${SERVICE})(?=$|[\\s_\\-–.]+)`, "gi");
const EDGE_SEP = /^[\s_\-–.]+|[\s_\-–.]+$/g;

/** «Asse Planimetria Sud fosso VI02 TO02.dwg» → «Sud fosso VI02 TO02»; se non resta nulla, il nome del file. */
export function workName(fileName) {
  const base = String(fileName || "").replace(/\.[^.\\/]+$/, "").trim();
  const s = base.replace(SERVICE_RE, " ").replace(EDGE_SEP, "").replace(/\s{2,}/g, " ").trim();
  return s || base;
}

/**
 * Tipo di sezione dai nomi di file e layer: «inalveazione … 400X250» o
 * «canale 400x250» → canale a U con interno 4,00 × 2,50 (numeri grandi =
 * centimetri); «fosso» → fosso trapezio. Il «50x50x50» di un fosso (tre
 * misure) non è una U; «scatolare» → scatolare (0.9). Ritorna { type: "channel"|"box", B?, H? } | { type: "ditch" } | null.
 */
export function guessSection(...names) {
  const s = names.filter(Boolean).join(" ");
  if (/INALVEAZ|CANAL|SCATOLAR|CULVERT/i.test(s)) {
    const out = { type: /SCATOLAR|CULVERT/i.test(s) ? "box" : "channel" };            // scatolare (0.9): il canale chiuso
    const m = /(?<![\d.,x×])(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)(?!\d|[.,]\d|\s*[x×]\s*\d)/i.exec(s);
    if (m) {
      let a = parseFloat(m[1].replace(",", ".")), b = parseFloat(m[2].replace(",", "."));
      if (a >= 20 && b >= 20) { a /= 100; b /= 100; }
      if (a > 0.2 && a < 30 && b > 0.2 && b < 30) { out.B = a; out.H = b; }
    }
    return out;
  }
  if (/FOSS[OI]|CUNETT/i.test(s)) return { type: "ditch" };
  return null;
}

const STOP = new Set(["idr", "mdl", "quote", "quota", "scorrimento", "layer", "di", "del", "della", "dei", "il", "la", "lo", "e", "the", "of", "and", "dwg", "dxf"]);
const nameTokens = (...ss) => {
  const out = new Set();
  for (const t of ss.join(" ").replace(SERVICE_RE, " ").toLowerCase().split(/[^0-9a-zà-ÿ]+/)) if (t && !STOP.has(t) && !/^0+$/.test(t)) out.add(t);
  return out;
};

/**
 * Abbina i profili alle piante. plans [{ name (file), layer, length }],
 * profs [{ name (file), layer (progetto), span (estensione in X nel disegno) }],
 * scaleOf(lunghezza pianta, span) → scala delle distanze (core.distanceScale).
 * Punteggio = somiglianza dei nomi (Jaccard sulle parole) + 0,6 se le lunghezze
 * tornano entro il 2 % (0,3 entro il 10 %). Si prende la coppia migliore, poi
 * la seguente fra le libere; un solo profilo e una sola pianta rimasti si
 * abbinano comunque. Ritorna, per ogni profilo, l'indice della pianta o −1.
 */
export function matchProfiles(plans, profs, scaleOf = () => 1) {
  const A = plans.map((p) => nameTokens(String(p.name || "").replace(/\.[^.\\/]+$/, ""), p.layer || ""));
  const B = profs.map((p) => nameTokens(String(p.name || "").replace(/\.[^.\\/]+$/, ""), p.layer || ""));
  const lenScore = (L, span) => {
    if (!(L > 0) || !(span > 0)) return 0;
    const e = Math.abs(L / (span * scaleOf(L, span)) - 1);
    return e < 0.02 ? 1 : e < 0.1 ? 0.5 : 0;
  };
  const cand = [];
  plans.forEach((p, i) => profs.forEach((q, j) => {
    let inter = 0;
    for (const t of A[i]) if (B[j].has(t)) inter++;
    const uni = A[i].size + B[j].size - inter;
    cand.push({ i, j, s: (uni ? inter / uni : 0) + 0.6 * lenScore(p.length, q.span) });
  }));
  cand.sort((a, b) => b.s - a.s || a.i - b.i || a.j - b.j);
  const pick = profs.map(() => -1), used = new Set();
  for (const { i, j, s } of cand) if (s > 0 && pick[j] < 0 && !used.has(i)) { pick[j] = i; used.add(i); }
  const freeP = plans.map((_, i) => i).filter((i) => !used.has(i)), freeQ = profs.map((_, j) => j).filter((j) => pick[j] < 0);
  if (freeP.length === 1 && freeQ.length === 1) pick[freeQ[0]] = freeP[0];
  return pick;
}

/**
 * Pezzi di una polilinea di PIANTA da unire in un solo asse: si concatenano
 * per capi vicini (girandoli se serve); i buchi restano come lati dritti e si
 * contano. Ritorna { poly, gaps: [{ at, len }] }.
 */
export function joinPlanPieces(polys) {
  if (polys.length === 1) return { poly: polys[0], gaps: [] };
  const rev = (p) => {
    const q = p.pts, out = [];
    for (let i = q.length - 1; i >= 0; i--) out.push({ x: q[i].x, y: q[i].y, b: i > 0 ? -(q[i - 1].b || 0) : 0 });
    return { ...p, pts: out };
  };
  const left = polys.slice(1);
  let cur = { ...polys[0], pts: polys[0].pts.map((p) => ({ ...p })) };
  const gaps = [];
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  while (left.length) {
    const h = cur.pts[0], t = cur.pts[cur.pts.length - 1];
    let best = null;
    left.forEach((p, idx) => {
      const a = p.pts[0], b = p.pts[p.pts.length - 1];
      for (const [dist, where, flip] of [[d(t, a), "tail", false], [d(t, b), "tail", true], [d(h, b), "head", false], [d(h, a), "head", true]])
        if (!best || dist < best.dist) best = { dist, where, flip, idx };
    });
    const p0 = left.splice(best.idx, 1)[0], p = best.flip ? rev(p0) : p0;
    if (best.where === "tail") {
      if (best.dist > 1e-3) gaps.push({ len: best.dist });
      cur.pts[cur.pts.length - 1].b = 0;
      cur.pts.push(...p.pts.slice(best.dist > 1e-3 ? 0 : 1).map((q) => ({ ...q })));
    } else {
      if (best.dist > 1e-3) gaps.push({ len: best.dist });
      const head = p.pts.map((q) => ({ ...q }));
      if (best.dist <= 1e-3) head.pop();
      head[head.length - 1].b = head[head.length - 1].b || 0;
      cur.pts = head.concat(cur.pts);
    }
  }
  return { poly: cur, gaps };
}

/* -------------------------------------------------------------------------
   Scrittori
   ------------------------------------------------------------------------- */

const f4 = (v) => (Math.round(v * 1e4) / 1e4).toFixed(4);

/**
 * Polilinee 3D in DXF R12 (AC1009): HEADER minimo + una POLYLINE con flag 8
 * per asse, coi suoi VERTEX (flag 32), ognuna sul suo layer. Coordinate al
 * decimo di millimetro. list = [{ pts: [{ x, y, z }], layer }].
 */
export function dxf3DPolylines(list) {
  const ln = [];
  const g = (c, v) => { ln.push(String(c), String(v)); };
  const layers = [...new Set(list.map((a) => a.layer))];
  g(0, "SECTION"); g(2, "HEADER"); g(9, "$ACADVER"); g(1, "AC1009"); g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "TABLES");
  g(0, "TABLE"); g(2, "LAYER"); g(70, layers.length);
  layers.forEach((l, i) => { g(0, "LAYER"); g(2, l); g(70, 0); g(62, 1 + (i % 6)); g(6, "CONTINUOUS"); });
  g(0, "ENDTAB"); g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "ENTITIES");
  for (const { pts, layer } of list) {
    g(0, "POLYLINE"); g(8, layer); g(66, 1); g(10, "0.0"); g(20, "0.0"); g(30, "0.0"); g(70, 8);
    for (const p of pts) { g(0, "VERTEX"); g(8, layer); g(10, f4(p.x)); g(20, f4(p.y)); g(30, f4(p.z)); g(70, 32); }
    g(0, "SEQEND"); g(8, layer);
  }
  g(0, "ENDSEC"); g(0, "EOF");
  return ln.join("\r\n") + "\r\n";
}
/** Una sola polilinea 3D (l'asse di un'opera). */
export function dxf3DPolyline(pts, { layer = "ASSE_3D" } = {}) { return dxf3DPolylines([{ pts, layer }]); }

/**
 * DXF R12 con le piante (0.11, scelta dell'utente: «DXF 2D della pianta», da riportare nel CAD):
 * una POLYLINE 2D per opera nel suo layer, vertici in coordinate assolute col bulge degli archi
 * (gruppo 42, come le LWPOLYLINE da cui vengono). list: [{ pts: [{ x, y, b }], layer }].
 */
export function dxfPolylines2D(list) {
  const ln = [];
  const g = (c, v) => { ln.push(String(c), String(v)); };
  const layers = [...new Set(list.map((a) => a.layer))];
  g(0, "SECTION"); g(2, "HEADER"); g(9, "$ACADVER"); g(1, "AC1009"); g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "TABLES");
  g(0, "TABLE"); g(2, "LAYER"); g(70, layers.length);
  layers.forEach((l, i) => { g(0, "LAYER"); g(2, l); g(70, 0); g(62, 1 + (i % 6)); g(6, "CONTINUOUS"); });
  g(0, "ENDTAB"); g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "ENTITIES");
  for (const { pts, layer } of list) {
    g(0, "POLYLINE"); g(8, layer); g(66, 1); g(10, "0.0"); g(20, "0.0"); g(30, "0.0"); g(70, 0);
    pts.forEach((p, i) => {
      g(0, "VERTEX"); g(8, layer); g(10, f4(p.x)); g(20, f4(p.y)); g(30, "0.0");
      if (i < pts.length - 1 && p.b) g(42, p.b.toFixed(9));
    });
    g(0, "SEQEND"); g(8, layer);
  }
  g(0, "ENDSEC"); g(0, "EOF");
  return ln.join("\r\n") + "\r\n";
}

/**
 * Nomi di layer validi in R12 per gli assi delle opere: lettere, cifre, $ - _,
 * al massimo 31 caratteri, tutti diversi. «Sud fosso VI02 TO02» → «ASSE_3D_SUD_FOSSO_VI02_TO02».
 */
export function dxfLayerNames(names, prefix = "ASSE_3D") {
  const seen = new Set();
  return names.map((n) => {
    const clean = String(n || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9$_-]+/g, "_").replace(/^_+|_+$/g, "");
    let base = (clean ? prefix + "_" + clean : prefix).slice(0, 31), out = base, k = 2;
    while (seen.has(out)) { const suf = "_" + k++; out = base.slice(0, 31 - suf.length) + suf; }
    seen.add(out);
    return out;
  });
}

const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f6 = (v) => v.toFixed(6);
const ne = (x, y) => f6(y) + " " + f6(x);                // LandXML: Nord Est
const azimuth = (dx, dy) => { const a = Math.atan2(dx, dy); return a < 0 ? a + 2 * Math.PI : a; };   // da nord, orario

/**
 * PVI del profilo dall'asse 3D, togliendo quelli allineati (stessa
 * livelletta). Un salto verticale (due quote alla stessa progressiva) in
 * LandXML non si scrive: la quota a monte va 1 mm prima, quella a valle
 * resta sulla progressiva. Ritorna [{ s, z }].
 */
export function profilePVI(pts3d, eps = 1e-4, curves = []) {      // allineati entro 0,1 mm
  // raccordi parabolici (0.12): curves [{ p, z, L }] in progressiva di pianta. I punti dell'asse dentro un
  // raccordo (i suoi campioni e i capi) si tolgono; al loro posto il PVI col raccordo (L), che resta sempre
  let src = pts3d;
  if (curves.length) {
    const inside = (p) => curves.some((c) => p > c.p - c.L / 2 - 1e-6 && p < c.p + c.L / 2 + 1e-6);
    src = pts3d.filter((q) => !inside(q.p)).concat(curves.map((c) => ({ p: c.p, z: c.z, L: c.L }))).sort((a, b) => a.p - b.p);
  }
  const raw = [];
  for (const p of src) {
    const last = raw[raw.length - 1];
    if (last && p.p - last.s < 1e-6) {
      const prev = raw[raw.length - 2];
      if (!prev || last.s - 0.001 > prev.s + 1e-6) last.s -= 0.001; else raw.pop();
      raw.push({ s: p.p, z: p.z, L: p.L || 0 });
      continue;
    }
    raw.push({ s: p.p, z: p.z, L: p.L || 0 });
  }
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (i > 0 && i < raw.length - 1 && !(raw[i].L > 0)) {
      const a = out[out.length - 1], b = raw[i], c = raw[i + 1];
      const zLin = a.z + (c.z - a.z) * (b.s - a.s) / (c.s - a.s);
      if (Math.abs(zLin - b.z) <= eps) continue;
    }
    out.push(raw[i].L > 0 ? { s: raw[i].s, z: raw[i].z, L: raw[i].L } : { s: raw[i].s, z: raw[i].z });
  }
  return out;
}

/**
 * Segmenti verticali dai PVI (L > 0 = raccordo parabolico centrato sul PVI, come i
 * ParaCurve di LandXML): [{ s, L, z, g0, g1, t: "CONSTANTGRADIENT"|"PARABOLICARC" }],
 * la stessa catena del tool LandXML → IFC (lxVsegs).
 */
export function verticalSegments(pvi) {
  const out = [];
  if (pvi.length < 2) return out;
  let cur = pvi[0].s, curZ = pvi[0].z;
  for (let i = 1; i < pvi.length; i++) {
    const g = (pvi[i].z - pvi[i - 1].z) / ((pvi[i].s - pvi[i - 1].s) || 1), last = i === pvi.length - 1;
    let gN = g, Lc = 0;
    if (!last && pvi[i].L > 0) { gN = (pvi[i + 1].z - pvi[i].z) / ((pvi[i + 1].s - pvi[i].s) || 1); Lc = pvi[i].L; }
    const tEnd = pvi[i].s - Lc / 2;
    if (tEnd - cur > 1e-9) out.push({ s: cur, L: tEnd - cur, z: curZ, g0: g, g1: g, t: "CONSTANTGRADIENT" });
    curZ += g * (tEnd - cur); cur = tEnd;
    if (Lc > 0) { out.push({ s: cur, L: Lc, z: curZ, g0: g, g1: gN, t: "PARABOLICARC" }); curZ += (g + gN) / 2 * Lc; cur += Lc; }
    if (!(Lc > 0) || last) curZ = pvi[i].z;                 // sul PVI la quota esatta (niente somme che derivano)
  }
  return out;
}

/**
 * LandXML 1.2: un Alignment per asse con CoordGeom (Line / Curve dai lati
 * dell'asse in pianta) e Profile/ProfAlign coi PVI. Un asse solo ({ name,
 * axis, pvi }) o più (alignments: [{ name, axis, pvi }], nomi resi unici come
 * vuole lo schema). stamp = { date: "AAAA-MM-GG", time: "hh:mm:ss" }.
 */
export function landXML({ name, axis, pvi, alignments, stamp, app = "viewifc.com — Sviluppo profili" }) {
  const I = "        ";
  const list = alignments || [{ name, axis, pvi }];
  const seen = new Set();
  const body = [];
  for (const a of list) {
    let nm = String(a.name || "Asse"), k = 2;
    while (seen.has(nm)) nm = `${a.name} (${k++})`;
    seen.add(nm);
    const geo = [];
    for (const g of a.axis.segs) {
      if (g.t === "L") {
        geo.push(I + `<Line staStart="${f6(g.s0)}" dir="${f6(azimuth(g.ux, g.uy))}" length="${f6(g.len)}">`,
          I + `  <Start>${ne(g.x0, g.y0)}</Start>`, I + `  <End>${ne(g.x1, g.y1)}</End>`, I + "</Line>");
      } else {
        const dir = Math.sign(g.sweep), t0 = g.a0, t1 = g.a0 + g.sweep;
        const d0 = azimuth(-Math.sin(t0) * dir, Math.cos(t0) * dir), d1 = azimuth(-Math.sin(t1) * dir, Math.cos(t1) * dir);
        geo.push(I + `<Curve rot="${dir > 0 ? "ccw" : "cw"}" staStart="${f6(g.s0)}" dirStart="${f6(d0)}" dirEnd="${f6(d1)}" radius="${f6(g.r)}" length="${f6(g.len)}">`,
          I + `  <Start>${ne(g.x0, g.y0)}</Start>`, I + `  <Center>${ne(g.cx, g.cy)}</Center>`, I + `  <End>${ne(g.x1, g.y1)}</End>`, I + "</Curve>");
      }
    }
    const prof = a.pvi && a.pvi.length >= 2
      ? ["      <Profile>", `        <ProfAlign name="${xmlEsc(nm)}">`, ...a.pvi.map((p) => (p.L > 0 ? `          <ParaCurve length="${f6(p.L)}">${f6(p.s)} ${f6(p.z)}</ParaCurve>` : `          <PVI>${f6(p.s)} ${f6(p.z)}</PVI>`)), "        </ProfAlign>", "      </Profile>"]
      : [];
    body.push(`    <Alignment name="${xmlEsc(nm)}" staStart="0.000000" length="${f6(a.axis.length)}">`, "      <CoordGeom>", ...geo, "      </CoordGeom>", ...prof, "    </Alignment>");
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.landxml.org/schema/LandXML-1.2 http://www.landxml.org/schema/LandXML-1.2/LandXML-1.2.xsd" date="${stamp.date}" time="${stamp.time}" version="1.2">`,
    "  <Units>",
    '    <Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="HPA" angularUnit="radians" directionUnit="radians"/>',
    "  </Units>",
    `  <Application name="${xmlEsc(app)}" manufacturer="viewifc.com"/>`,
    "  <Alignments>",
    ...body,
    "  </Alignments>",
    "</LandXML>",
    "",
  ].join("\n");
}

/* -------------------------------------------------------------------------
   IFC 4x3 (IFC4X3_ADD2) del fosso
   Coordinate come il DTM di Revit dell'utente: l'origine (E, N arrotondati)
   sta nel placement dell'IfcSite, la geometria è in metri locali — i due file
   si federano senza conti in viewer, Navisworks e Revit. Niente
   IfcMapConversion (il sistema di riferimento dei disegni non è dichiarato).
   - IfcAlignment: rette e archi veri in pianta (IfcCompositeCurve +
     segmenti di progetto), livellette a pendenza costante fra i PVI
     (IfcGradientCurve). Curve madri canoniche (retta lungo +x) e la
     direzione nel placement del segmento. L'asse NON segue il sito: placement
     nell'origine del mondo e punti in coordinate assolute, perché c'è chi
     (il viewer) legge gli StartPoint come coordinate di mappa e ignora il
     placement — così torna in entrambi i casi.
   - Per ogni tratto: rivestimento = IfcCourse .PROTECTION., scavo =
     IfcEarthworksCut .CUT., riporto = IfcEarthworksFill .EMBANKMENT. (scelte
     dell'utente). Lo scavo è una sottrazione: lo schema vuole un elemento da
     forare (VoidsElements 1:1) → un IfcGeographicElement .TERRAIN. SENZA
     geometria ("terreno esistente": il DTM vero è il file dell'utente).
   - Geometria a mesh esplicita (IfcTriangulatedFaceSet), quantità nei Qto
     standard e progressive/sezione in un pset del tool.
   - Canale a U (inalveazione, 0.4 — scelte dell'utente): per tratto il canale
     = IfcPipeSegment .GUTTER. (U + muro di testa e dente del salto in fondo),
     magrone = IfcSlab .USERDEFINED. «Magrone», cuneo in misto cementato e
     rinterro = IfcEarthworksFill .BACKFILL. (materiali diversi), scavo come
     nel fosso. Il volume del canale sta nel pset (il Qto dei tubi non ha
     volumi): nei Qto la sezione lorda e netta.
   ------------------------------------------------------------------------- */
const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
/** GlobalId IFC (22 caratteri) da 16 byte casuali, o da rnd(i) → byte nei test. */
export function ifcGuid(rnd = null) {
  const b = new Uint8Array(16);
  if (rnd) for (let i = 0; i < 16; i++) b[i] = rnd(i) & 255;
  else if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const chunk = (v, n) => { let s = ""; for (let i = n - 1; i >= 0; i--) s += B64[Math.floor(v / 64 ** i) % 64]; return s; };
  let out = chunk(b[0], 2);
  for (let i = 1; i < 16; i += 3) out += chunk((b[i] << 16) + (b[i + 1] << 8) + b[i + 2], 4);
  return out;
}
/** Stringa STEP: apici raddoppiati, barre raddoppiate, fuori dall'ASCII \X2\hhhh\X0\ (ISO 10303-21). */
export function stepStr(s) {
  let out = "";
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === "'") out += "''";
    else if (ch === "\\") out += "\\\\";
    else if (c >= 32 && c <= 126) out += ch;
    else { let h = ""; for (const u of ch.split("")) h += u.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"); out += "\\X2\\" + h + "\\X0\\"; }
  }
  return "'" + out + "'";
}
/** Reale STEP: punto sempre presente, niente zeri in coda, niente −0. */
export function stepReal(x, dec = 6) {
  if (!Number.isFinite(x)) x = 0;
  let s = x.toFixed(dec);
  if (s.indexOf(".") < 0) s += ".";
  s = s.replace(/(\.\d*?)0+$/, "$1");
  return s === "-0." ? "0." : s;
}

/**
 * job = {
 *   name (progetto), origin: { x, y } (E, N dell'IfcSite),
 *   works: [{ name, axis (planAxis), pvi [{ s, z }], section: { b, h, m, t, berm, cut, fill } (fosso)
 *               o { type: "channel", B, H, tw, ts, tm, om, se, cut, berm, fill, hw, key, wedge, ref } (canale),
 *             parts: [{ name, p0, p1, length, mesh: { lining, cut, fill (+ lean, mix) } (coordinate locali),
 *                       vol: { lining, cut, fill (+ lean, mix) }, drops? [{ dz }],
 *                       section? (0.9: la sezione del tratto, se diversa da quella dell'opera; scatolare =
 *                       { type: "box", …canale, tt, ch, cover } → IfcPipeSegment .CULVERT.), blendNote? (raccordo),
 *                       bridge? (0.15: tratto a ponte { id, name, p0, p1, length, hMax } — senza terre, mesh.void = spazio
 *                       riservato sotto l'opera → IfcBridge col tratto dentro e un IfcBuildingElementProxy .PROVISIONFORSPACE.) }] }]
 *     — oppure un'opera sola coi campi axis, pvi, section, parts direttamente nel job (nome = name);
 *   labels: { … nomi dei pset/proprietà nella lingua della pagina },
 *   app: { name, version }, date (Date), guid?: () => stringa (test)
 * } → testo STEP. Un IFC unico per tutte le opere (scelta dell'utente): un
 * IfcAlignment per opera, i tratti col nome dell'opera davanti e la proprietà
 * «Opera» nel pset; tutti gli scavi forano lo stesso terreno.
 */
export function ifcDitch(job) {
  const L = [];
  let id = 0;
  const e = (s) => { L.push("#" + ++id + "=" + s + ";"); return "#" + id; };
  const G = () => "'" + (job.guid ? job.guid() : ifcGuid()) + "'";
  const R = (x, d = 6) => stepReal(x, d), S = stepStr, lb = job.labels || {};
  const O = job.origin || { x: 0, y: 0 };
  const date = job.date || new Date();
  const works = job.works || [{ name: job.name, axis: job.axis, pvi: job.pvi, section: job.section, parts: job.parts }];
  // --- progetto
  const org = e(`IFCORGANIZATION($,'viewifc.com',$,$,$)`);
  const pao = e(`IFCPERSONANDORGANIZATION(${e("IFCPERSON($,$,$,$,$,$,$,$)")},${org},$)`);
  const app = e(`IFCAPPLICATION(${org},${S(job.app.version)},${S(job.app.name)},'viewifc-profile-sweep')`);
  const oh = e(`IFCOWNERHISTORY(${pao},${app},$,.ADDED.,$,$,$,${Math.floor(date.getTime() / 1000)})`);
  const U = [e("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)"), e("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)"), e("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)"), e("IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)")];
  const ua = e(`IFCUNITASSIGNMENT((${U.join(",")}))`);
  const o3 = e("IFCCARTESIANPOINT((0.,0.,0.))");
  const wcs = e(`IFCAXIS2PLACEMENT3D(${o3},${e("IFCDIRECTION((0.,0.,1.))")},${e("IFCDIRECTION((1.,0.,0.))")})`);
  const ctx = e(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${wcs},$)`);
  const body = e(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const axisCtx = e(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const proj = e(`IFCPROJECT(${G()},${oh},${S(job.name)},$,$,$,$,(${ctx}),${ua})`);
  const sitePl = e(`IFCLOCALPLACEMENT($,${e(`IFCAXIS2PLACEMENT3D(${e(`IFCCARTESIANPOINT((${R(O.x, 4)},${R(O.y, 4)},0.))`)},$,$)`)})`);
  const site = e(`IFCSITE(${G()},${oh},${S(lb.site || "Sito")},$,$,${sitePl},$,$,.ELEMENT.,$,$,0.,$,$)`);
  e(`IFCRELAGGREGATES(${G()},${oh},$,$,${proj},(${site}))`);
  const here = () => e(`IFCLOCALPLACEMENT(${sitePl},${e(`IFCAXIS2PLACEMENT3D(${o3},$,$)`)})`);
  const contained = [];

  // --- asse: IfcAlignment in coordinate ASSOLUTE (E, N), placement nell'origine del mondo:
  //     chi legge gli StartPoint come coordinate di mappa (il viewer) e chi applica il
  //     placement trovano lo stesso asse, sopra le mesh (relative al sito)
  const P2 = (x, y) => e(`IFCCARTESIANPOINT((${R(x)},${R(y)}))`);
  const D2 = (a) => e(`IFCDIRECTION((${R(Math.cos(a), 12)},${R(Math.sin(a), 12)}))`);
  const dirAt = (g, end) => (g.t === "L" ? Math.atan2(g.uy, g.ux) : g.a0 + (end ? g.sweep : 0) + Math.sign(g.sweep) * Math.PI / 2);
  for (const w of works) {
    const ax = w.axis;
    const alnPl = e(`IFCLOCALPLACEMENT($,${e(`IFCAXIS2PLACEMENT3D(${o3},$,$)`)})`);   // uno per asse
    const hCurve = [], hBiz = [];
    ax.segs.forEach((g, i) => {
      const next = ax.segs[i + 1];
      const kink = next ? Math.abs(Math.atan2(Math.sin(dirAt(next, false) - dirAt(g, true)), Math.cos(dirAt(next, false) - dirAt(g, true)))) : 0;
      const trans = !next ? ".DISCONTINUOUS." : kink < 1e-6 ? ".CONTSAMEGRADIENT." : ".CONTINUOUS.";       // polilinea con angoli: solo continuità di posizione
      if (g.t === "L") {
        const th = Math.atan2(g.uy, g.ux);
        const line = e(`IFCLINE(${e("IFCCARTESIANPOINT((0.,0.))")},${e(`IFCVECTOR(${e("IFCDIRECTION((1.,0.))")},1.)`)})`);
        hCurve.push(e(`IFCCURVESEGMENT(${trans},${e(`IFCAXIS2PLACEMENT2D(${P2(g.x0, g.y0)},${D2(th)})`)},IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(${R(g.len)}),${line})`));
        hBiz.push(e(`IFCALIGNMENTSEGMENT(${G()},${oh},'H${i + 1}',$,$,$,$,${e(`IFCALIGNMENTHORIZONTALSEGMENT($,$,${P2(g.x0, g.y0)},${R(th, 12)},0.,0.,${R(g.len)},$,.LINE.)`)})`));
      } else {
        const sgn = Math.sign(g.sweep), th = g.a0 + sgn * Math.PI / 2;           // tangente all'inizio dell'arco
        const circle = e(`IFCCIRCLE(${e(`IFCAXIS2PLACEMENT2D(${e(`IFCCARTESIANPOINT((0.,${R(sgn * g.r)}))`)},${e(`IFCDIRECTION((0.,${sgn > 0 ? "-1." : "1."}))`)})`)},${R(g.r)})`);
        hCurve.push(e(`IFCCURVESEGMENT(${trans},${e(`IFCAXIS2PLACEMENT2D(${P2(g.x0, g.y0)},${D2(th)})`)},IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(${R(sgn * g.len)}),${circle})`));
        hBiz.push(e(`IFCALIGNMENTSEGMENT(${G()},${oh},'H${i + 1}',$,$,$,$,${e(`IFCALIGNMENTHORIZONTALSEGMENT($,$,${P2(g.x0, g.y0)},${R(th, 12)},${R(sgn * g.r)},${R(sgn * g.r)},${R(g.len)},$,.CIRCULARARC.)`)})`));
      }
    });
    const comp = e(`IFCCOMPOSITECURVE((${hCurve.join(",")}),.F.)`);
    const reps = [e(`IFCSHAPEREPRESENTATION(${axisCtx},'FootPrint','Curve2D',(${comp}))`)];
    const pvi = w.pvi || [];
    const vCurve = [], vBiz = [];
    if (pvi.some((p) => p.L > 0)) {
      // raccordi parabolici (0.12): la forma del tool LandXML → IFC (verificata col kernel di IfcOpenShell: in ADD2
      // l'IfcCurveSegment ri-ancora la curva madre su Location/RefDirection) — parabola = IfcPolynomialCurve (0, g0, c2)
      const vs = verticalSegments(pvi);
      vs.forEach((v, i) => {
        const n = Math.hypot(1, v.g0), nx = vs[i + 1];
        const trans = !nx ? ".DISCONTINUOUS." : Math.abs(nx.g0 - v.g1) < 1e-9 ? ".CONTSAMEGRADIENT." : ".CONTINUOUS.";
        const pl = e(`IFCAXIS2PLACEMENT2D(${e(`IFCCARTESIANPOINT((${R(v.s)},${R(v.z)}))`)},${e(`IFCDIRECTION((${R(1 / n, 12)},${R(v.g0 / n, 12)}))`)})`);
        if (v.t === "PARABOLICARC") {
          const c2 = (v.g1 - v.g0) / (2 * v.L);
          const par = e(`IFCPOLYNOMIALCURVE(${e(`IFCAXIS2PLACEMENT2D(${e("IFCCARTESIANPOINT((0.,0.))")},${e("IFCDIRECTION((1.,0.))")})`)},(0.,1.),(0.,${R(v.g0, 9)},${R(c2, 12)}),$)`);
          vCurve.push(e(`IFCCURVESEGMENT(${trans},${pl},IFCPARAMETERVALUE(0.),IFCPARAMETERVALUE(${R(v.L)}),${par})`));
          vBiz.push(e(`IFCALIGNMENTSEGMENT(${G()},${oh},'V${i + 1}',$,$,$,$,${e(`IFCALIGNMENTVERTICALSEGMENT($,$,${R(v.s)},${R(v.L)},${R(v.z)},${R(v.g0, 9)},${R(v.g1, 9)},${R(v.L / (v.g1 - v.g0))},.PARABOLICARC.)`)})`));
        } else {
          const line = e(`IFCLINE(${e("IFCCARTESIANPOINT((0.,0.))")},${e(`IFCVECTOR(${e("IFCDIRECTION((1.,0.))")},1.)`)})`);
          vCurve.push(e(`IFCCURVESEGMENT(${trans},${pl},IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(${R(v.L * n)}),${line})`));
          vBiz.push(e(`IFCALIGNMENTSEGMENT(${G()},${oh},'V${i + 1}',$,$,$,$,${e(`IFCALIGNMENTVERTICALSEGMENT($,$,${R(v.s)},${R(v.L)},${R(v.z)},${R(v.g0, 9)},${R(v.g0, 9)},$,.CONSTANTGRADIENT.)`)})`));
        }
      });
    } else for (let i = 0; i + 1 < pvi.length; i++) {
      const a = pvi[i], b = pvi[i + 1], Lh = b.s - a.s;
      if (!(Lh > 0)) continue;
      const g = (b.z - a.z) / Lh, n = Math.hypot(1, g), last = i + 2 === pvi.length;
      const line = e(`IFCLINE(${e("IFCCARTESIANPOINT((0.,0.))")},${e(`IFCVECTOR(${e("IFCDIRECTION((1.,0.))")},1.)`)})`);
      const pl = e(`IFCAXIS2PLACEMENT2D(${e(`IFCCARTESIANPOINT((${R(a.s)},${R(a.z)}))`)},${e(`IFCDIRECTION((${R(1 / n, 12)},${R(g / n, 12)}))`)})`);
      vCurve.push(e(`IFCCURVESEGMENT(${last ? ".DISCONTINUOUS." : ".CONTINUOUS."},${pl},IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(${R(Lh * n)}),${line})`));
      vBiz.push(e(`IFCALIGNMENTSEGMENT(${G()},${oh},'V${i + 1}',$,$,$,$,${e(`IFCALIGNMENTVERTICALSEGMENT($,$,${R(a.s)},${R(Lh)},${R(a.z)},${R(g, 9)},${R(g, 9)},$,.CONSTANTGRADIENT.)`)})`));
    }
    if (vCurve.length) reps.push(e(`IFCSHAPEREPRESENTATION(${axisCtx},'Axis','Curve3D',(${e(`IFCGRADIENTCURVE((${vCurve.join(",")}),.F.,${comp},$)`)}))`));
    const align = e(`IFCALIGNMENT(${G()},${oh},${S(w.name)},$,$,${alnPl},${e(`IFCPRODUCTDEFINITIONSHAPE($,$,(${reps.join(",")}))`)},$)`);
    const hor = e(`IFCALIGNMENTHORIZONTAL(${G()},${oh},$,$,$,$,$)`);
    e(`IFCRELNESTS(${G()},${oh},$,$,${hor},(${hBiz.join(",")}))`);
    const nested = [hor];
    if (vBiz.length) { const ver = e(`IFCALIGNMENTVERTICAL(${G()},${oh},$,$,$,$,$)`); e(`IFCRELNESTS(${G()},${oh},$,$,${ver},(${vBiz.join(",")}))`); nested.push(ver); }
    e(`IFCRELNESTS(${G()},${oh},$,$,${align},(${nested.join(",")}))`);
    contained.push(align);
  }

  // --- stili, materiale, terreno da forare
  const style = (rgb, name, tr = 0) => {
    const c = e(`IFCCOLOURRGB($,${R(rgb[0], 3)},${R(rgb[1], 3)},${R(rgb[2], 3)})`);
    return e(`IFCSURFACESTYLE(${S(name)},.BOTH.,(${e(`IFCSURFACESTYLESHADING(${c},${R(tr, 2)})`)}))`);
  };
  const stLin = style([0.72, 0.72, 0.7], lb.lining || "cls"), stCut = style([0.66, 0.5, 0.33], lb.cut || "scavo", 0.5), stFill = style([0.55, 0.62, 0.4], lb.fill || "riporto", 0.4);
  // la sezione di un tratto: la sua (opere con sezioni diverse, 0.9) o quella dell'opera
  const secOf = (w, p) => p.section || w.section;
  const anyCh = works.some((w) => w.parts.some((p) => { const s = secOf(w, p); return s && (s.type === "channel" || s.type === "box"); }));
  const stLean = anyCh ? style([0.84, 0.84, 0.8], lb.lean || "magrone") : null, stMix = anyCh ? style([0.62, 0.58, 0.5], lb.mix || "misto cementato") : null;
  const stBack = anyCh ? style([0.78, 0.68, 0.48], lb.backfill || "rinterro", 0.4) : null;
  const terrain = e(`IFCGEOGRAPHICELEMENT(${G()},${oh},${S(lb.terrain || "Terreno esistente")},$,$,${here()},$,$,.TERRAIN.)`);
  contained.push(terrain);
  const shape = (m, st) => {
    const n = m.positions.length / 3, pts = new Array(n), idx = new Array(m.index.length / 3);
    for (let i = 0; i < n; i++) pts[i] = `(${R(m.positions[3 * i], 4)},${R(m.positions[3 * i + 1], 4)},${R(m.positions[3 * i + 2], 4)})`;
    for (let t = 0; t < m.index.length; t += 3) idx[t / 3] = `(${m.index[t] + 1},${m.index[t + 1] + 1},${m.index[t + 2] + 1})`;
    const item = e(`IFCTRIANGULATEDFACESET(${e(`IFCCARTESIANPOINTLIST3D((${pts.join(",")}),$)`)},$,.T.,(${idx.join(",")}),$)`);
    e(`IFCSTYLEDITEM(${item},(${st}),$)`);
    return e(`IFCPRODUCTDEFINITIONSHAPE($,$,(${e(`IFCSHAPEREPRESENTATION(${body},'Body','Tessellation',(${item}))`)}))`);
  };
  const props = (target, name, list) => {
    const ps = list.map(([n, v]) => e(`IFCPROPERTYSINGLEVALUE(${S(n)},$,${v},$)`));
    e(`IFCRELDEFINESBYPROPERTIES(${G()},${oh},$,$,(${target}),${e(`IFCPROPERTYSET(${G()},${oh},${S(name)},$,(${ps.join(",")}))`)})`);
  };
  const qto = (target, name, list) => {
    const qs = list.map(([t, n, v]) => e(`${t}(${S(n)},$,$,${R(v, 4)},$)`));
    e(`IFCRELDEFINESBYPROPERTIES(${G()},${oh},$,$,(${target}),${e(`IFCELEMENTQUANTITY(${G()},${oh},${S(name)},$,$,(${qs.join(",")}))`)})`);
  };
  const len = (v) => `IFCLENGTHMEASURE(${R(v, 4)})`, rat = (v) => `IFCPOSITIVERATIOMEASURE(${R(v, 4)})`;
  const courses = [], pipes = [], slabs = [], mixes = [], backs = [];
  // tubo in trincea: colore e materiale del tubo per catalogo, uno stile per strato (creati solo se servono)
  const pipeMats = [], layerMats = {}, styles = {};
  const once = (k, make) => styles[k] || (styles[k] = make());
  const PIPE_RGB = { pvc: [0.78, 0.42, 0.22], pe: [0.22, 0.22, 0.22], cls: [0.72, 0.72, 0.7], ghisa: [0.3, 0.3, 0.33], acciaio: [0.45, 0.5, 0.56] };
  const LAYER_RGB = { bed: [0.86, 0.8, 0.6], surround: [0.9, 0.85, 0.68], cover: [0.82, 0.76, 0.58], fill: [0.78, 0.68, 0.48], restore: [0.3, 0.3, 0.3] };
  const pipeStyle = (mat) => once("pipe:" + mat, () => style(PIPE_RGB[mat] || [0.6, 0.6, 0.6], lb.pipe || "tubo"));
  const layerStyle = (k) => once("layer:" + k, () => style(LAYER_RGB[k], k, k === "restore" ? 0 : 0.4));
  const psName = lb.pset || "ViewIFC_SviluppoProfili";
  const bridges = new Map();
  const bridgeOf = (w, part) => {
    const key = (w.name || "") + "\u0000" + part.bridge.id;
    if (!bridges.has(key)) {
      const br = part.bridge, name = (w.name ? w.name + " - " : "") + (br.name || lb.bridge || "Ponte");
      const ent = e(`IFCBRIDGE(${G()},${oh},${S(name)},${S(lb.bridgeNote || "Da progettare: segnaposto")},$,${here()},$,$,.ELEMENT.,.NOTDEFINED.)`);
      props(ent, psName, [[lb.work || "Opera", `IFCLABEL(${S(w.name || "")})`], [lb.p0 || "Progressiva iniziale", len(br.p0)], [lb.p1 || "Progressiva finale", len(br.p1)],
        [lb.length || "Lunghezza", len(br.length)], ...(Number.isFinite(br.hMax) ? [[lb.bridgeH || "Altezza massima sul terreno", len(br.hMax)]] : [])]);
      bridges.set(key, { ent, list: [] });
    }
    return bridges.get(key);
  };
  for (const w of works) for (const part0 of w.parts) {
    const sec = secOf(w, part0), part = { ...part0, name: (w.name ? w.name + " - " : "") + part0.name };
    const put = (x) => { if (part.bridge) bridgeOf(w, part).list.push(x); else contained.push(x); };
    if (part.bridge && part.mesh.void && part.mesh.void.index.length) {      // lo spazio riservato al ponte (0.15)
      const v = e(`IFCBUILDINGELEMENTPROXY(${G()},${oh},${S(part.name + " - " + (lb.bridgeSpace || "spazio riservato al ponte"))},$,${S(lb.bridgeSpaceType || "Spazio riservato al ponte")},${here()},${shape(part.mesh.void, once("void", () => style([0.45, 0.66, 0.9], lb.bridgeSpace || "spazio riservato al ponte", 0.6)))},$,.PROVISIONFORSPACE.)`);
      put(v);
      props(v, psName, [[lb.work || "Opera", `IFCLABEL(${S(w.name || "")})`], [lb.bridge || "Ponte", `IFCLABEL(${S(part.bridge.name || "")})`], [lb.p0 || "Progressiva iniziale", len(part.p0)], [lb.p1 || "Progressiva finale", len(part.p1)], [lb.length || "Lunghezza", len(part.length)]]);
      qto(v, "Qto_BuildingElementProxyQuantities", [["IFCQUANTITYVOLUME", "NetVolume", part.vol.void || 0]]);
    }
    const common = [[lb.work || "Opera", `IFCLABEL(${S(w.name || "")})`], [lb.p0 || "Progressiva iniziale", len(part.p0)], [lb.p1 || "Progressiva finale", len(part.p1)], [lb.length || "Lunghezza", len(part.length)],
      ...(part.blendNote ? [[lb.blend || "Raccordo", `IFCLABEL(${S(part.blendNote)})`]] : [])];
    if (sec.type === "pipe") {
      // tubo in trincea: IfcPipeSegment rigido, strati IfcEarthworksFill, ripristino IfcCourse, scavo a trincea
      const refName = sec.ref === "axis" ? lb.refAxis || "Asse del tubo" : sec.ref === "bottom" ? lb.refBottom || "Generatrice inferiore esterna" : sec.ref === "trench" ? lb.refTrench || "Fondo scavo" : lb.refInvert || "Fondo interno";
      const Di = sec.De - 2 * sec.s, bed = sec.bed != null ? sec.bed : 0.1 + sec.dn / 10000;
      const pipeProps = [[lb.section || "Sezione", `IFCLABEL(${S(lb.pipeName || "Tubo circolare")})`], [lb.pipeMat || "Materiale", `IFCLABEL(${S(sec.matName || sec.mat || "")})`],
        ...(sec.norm ? [[lb.norm || "Norma", `IFCLABEL(${S(sec.norm)})`]] : []), [lb.dn || "DN", `IFCLABEL(${S(String(sec.dn))})`],
        [lb.De || "Diametro esterno", len(sec.De)], [lb.s || "Spessore", len(sec.s)], [lb.Di || "Diametro interno", len(Di)], [lb.ref || "Linea del profilo", `IFCLABEL(${S(refName)})`]];
      const trench = [[lb.width || "Larghezza al fondo", len(part.width)], [lb.bed || "Letto di posa", len(bed)], [lb.cover || "Ricoprimento sopra l'estradosso", len(sec.cover)],
        ...(sec.restore > 0 ? [[lb.restore || "Ripristino", len(sec.restore)]] : [])];
      const p = e(`IFCPIPESEGMENT(${G()},${oh},${S(part.name + " - " + (lb.pipe || "tubo"))},$,$,${here()},${shape(part.mesh.pipe, pipeStyle(sec.mat))},$,.RIGIDSEGMENT.)`);
      put(p); pipeMats.push([p, sec]);
      props(p, psName, [...common, ...pipeProps]);
      qto(p, "Qto_PipeSegmentBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYAREA", "GrossCrossSectionArea", Math.PI * sec.De ** 2 / 4], ["IFCQUANTITYAREA", "NetCrossSectionArea", Math.PI * (sec.De ** 2 - Di ** 2) / 4]]);
      for (const [key, name, mname] of [["bed", lb.bedL || "letto di posa", lb.bedMat || "Materiale del letto di posa"], ["surround", lb.surround || "rinfianco", lb.surroundMat || "Materiale di rinfianco"],
        ["cover", lb.coverL || "ricoprimento", lb.coverMat || "Materiale di ricoprimento"], ["fill", lb.backfill || "reinterro", lb.fillMat || "Materiale di reinterro"]]) {
        if (!(part.vol[key] > 0.01) || !part.mesh[key] || !part.mesh[key].index.length) continue;
        const f = e(`IFCEARTHWORKSFILL(${G()},${oh},${S(part.name + " - " + name)},$,$,${here()},${shape(part.mesh[key], layerStyle(key))},$,.BACKFILL.)`);
        put(f); (layerMats[mname] ||= []).push(f);
        props(f, psName, common);
        qto(f, "Qto_EarthworksFillBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYVOLUME", "CompactedVolume", part.vol[key]]]);
      }
      if (part.vol.restore > 0.01 && part.mesh.restore && part.mesh.restore.index.length) {
        const c = e(`IFCCOURSE(${G()},${oh},${S(part.name + " - " + (lb.restoreL || "ripristino"))},$,$,${here()},${shape(part.mesh.restore, layerStyle("restore"))},$,.PAVEMENT.)`);
        put(c);
        props(c, psName, common);
        qto(c, "Qto_CourseBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYLENGTH", "Thickness", sec.restore], ["IFCQUANTITYVOLUME", "Volume", part.vol.restore]]);
      }
      if (part.vol.emb > 0.01 && part.mesh.emb && part.mesh.emb.index.length) {      // rilevato di protezione dove il tubo esce dal terreno (0.7.1)
        const f = e(`IFCEARTHWORKSFILL(${G()},${oh},${S(part.name + " - " + (lb.emb || "rilevato"))},$,$,${here()},${shape(part.mesh.emb, stFill)},$,.EMBANKMENT.)`);
        put(f); (layerMats[lb.embMat || "Materiale per rilevato"] ||= []).push(f);
        const bank = (part.bank || []).reduce((a, r) => a + r.p1 - r.p0, 0);
        props(f, psName, [...common, [lb.berm || "Banchina", len(sec.berm != null ? sec.berm : 0.5)], [lb.fillSlope || "Scarpa in riporto", rat(sec.bank || 1.5)], [lb.embLen || "Lunghezza in rilevato", len(bank)]]);
        qto(f, "Qto_EarthworksFillBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYVOLUME", "CompactedVolume", part.vol.emb]]);
      }
      if (part.vol.cut > 0.01 && part.mesh.cut.index.length) {
        const k = e(`IFCEARTHWORKSCUT(${G()},${oh},${S(part.name + " - " + (lb.cut || "scavo"))},$,$,${here()},${shape(part.mesh.cut, stCut)},$,.TRENCH.)`);
        e(`IFCRELVOIDSELEMENT(${G()},${oh},$,$,${terrain},${k})`);
        props(k, psName, [...common, ...trench, [lb.wallsV || "Pareti verticali", len(part.walls ? part.walls.vertical : 0)], [lb.wallsS || "Pareti a scarpa", len(part.walls ? part.walls.slope : 0)],
          [lb.shore || "Pareti da blindare", `IFCAREAMEASURE(${R(part.shore || 0, 4)})`]]);
        qto(k, "Qto_EarthworksCutBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYLENGTH", "Width", part.width], ["IFCQUANTITYVOLUME", "UndisturbedVolume", part.vol.cut]]);
      }
      continue;
    }
    if (sec.type === "channel" || sec.type === "box") {
      // canale a U: tubo «gutter» (U + muro di testa), magrone, cuneo, scavo, rinterro; scatolare (0.9): tubo
      // «culvert» (U + soletta + muro di testa), il resto come il canale
      const box = sec.type === "box", m = sec.m || 0, ch = sec.ch || 0, tt = box ? sec.tt || 0 : 0;
      const refName = sec.ref === "top" ? (box ? lb.refTopB || "Estradosso della soletta" : lb.refTop || "Cielo") : sec.ref === "base" ? lb.refBase || "Piano di posa" : lb.refInvert || "Fondo interno";
      const secProps = [[lb.section || "Sezione", `IFCLABEL(${S(box ? lb.boxName || "Scatolare" : lb.channelName || "Canale a U")})`], [lb.B || "Larghezza interna", len(sec.B)], [lb.H || "Altezza interna", len(sec.H)],
        [lb.tw || "Spessore pareti", len(sec.tw)], [box ? lb.tsB || "Spessore platea" : lb.ts || "Spessore soletta", len(sec.ts)],
        ...(box ? [[lb.tt || "Spessore soletta superiore", len(tt)], [lb.coverB || "Ricoprimento minimo", len(sec.cover || 0)]] : []),
        ...(m > 0 ? [[lb.mW || "Scarpa delle pareti", rat(m)]] : []), ...(ch > 0 ? [[lb.ch || "Smussi", len(ch)]] : []),
        [lb.tm || "Spessore magrone", len(sec.tm)], [lb.berm || "Banchina", len(sec.berm)],
        [lb.cutSlope || "Scarpa in sterro", rat(sec.cut)], [lb.backSlope || "Scarpa del rinterro", rat(sec.fill)], [lb.hw || "Muro di testa", len(sec.hw)], [lb.key || "Dente", len(sec.key)],
        [lb.ref || "Linea del profilo", `IFCLABEL(${S(refName)})`]];
      const drops = (part.drops || []).map((d) => [lb.drop || "Salto", len(d.dz)]).slice(0, 1);
      // sezione lorda: trapezio esterno (pareti a scarpa) + soletta; netta = lorda − luce (smussi tolti)
      const off = sec.tw * Math.hypot(1, m), uo = sec.B / 2 - m * sec.ts + off, uoT = sec.B / 2 + m * sec.H + off;
      const gross = (uo + uoT) * (sec.H + sec.ts) + 2 * uoT * tt, water = (sec.B + m * sec.H) * sec.H - ch * ch * (box ? 2 : 1);
      const p = e(`IFCPIPESEGMENT(${G()},${oh},${S(part.name + " - " + (box ? lb.box || "scatolare" : lb.channel || "canale"))},$,$,${here()},${shape(part.mesh.lining, stLin)},$,${box ? ".CULVERT." : ".GUTTER."})`);
      pipes.push(p); put(p);
      props(p, psName, [...common, ...secProps, ...drops, [lb.volume || "Volume calcestruzzo", `IFCVOLUMEMEASURE(${R(part.vol.lining, 4)})`]]);
      qto(p, "Qto_PipeSegmentBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYAREA", "GrossCrossSectionArea", gross], ["IFCQUANTITYAREA", "NetCrossSectionArea", gross - water]]);
      if (part.mesh.lean && part.mesh.lean.index.length) {
        const s = e(`IFCSLAB(${G()},${oh},${S(part.name + " - " + (lb.lean || "magrone"))},$,${S(lb.leanType || "Magrone")},${here()},${shape(part.mesh.lean, stLean)},$,.USERDEFINED.)`);
        slabs.push(s); put(s);
        props(s, psName, common);
        qto(s, "Qto_SlabBaseQuantities", [["IFCQUANTITYLENGTH", "Width", sec.tm], ["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYVOLUME", "NetVolume", part.vol.lean]]);
      }
      if (part.vol.mix > 0.01 && part.mesh.mix && part.mesh.mix.index.length) {
        const f = e(`IFCEARTHWORKSFILL(${G()},${oh},${S(part.name + " - " + (lb.mix || "misto cementato"))},$,$,${here()},${shape(part.mesh.mix, stMix)},$,.BACKFILL.)`);
        mixes.push(f); put(f);
        props(f, psName, common);
        qto(f, "Qto_EarthworksFillBaseQuantities", [["IFCQUANTITYVOLUME", "CompactedVolume", part.vol.mix]]);
      }
      if (part.vol.cut > 0.01 && part.mesh.cut.index.length) {
        const k = e(`IFCEARTHWORKSCUT(${G()},${oh},${S(part.name + " - " + (lb.cut || "scavo"))},$,$,${here()},${shape(part.mesh.cut, stCut)},$,.CUT.)`);
        e(`IFCRELVOIDSELEMENT(${G()},${oh},$,$,${terrain},${k})`);
        props(k, psName, common);
        qto(k, "Qto_EarthworksCutBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYVOLUME", "UndisturbedVolume", part.vol.cut]]);
      }
      if (part.vol.fill > 0.01 && part.mesh.fill.index.length) {
        const f = e(`IFCEARTHWORKSFILL(${G()},${oh},${S(part.name + " - " + (lb.backfill || "rinterro"))},$,$,${here()},${shape(part.mesh.fill, stBack)},$,.BACKFILL.)`);
        backs.push(f); put(f);
        props(f, psName, common);
        qto(f, "Qto_EarthworksFillBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYVOLUME", "CompactedVolume", part.vol.fill]]);
      }
      continue;
    }
    const secProps = [[lb.section || "Sezione", `IFCLABEL(${S(lb.sectionName || "Fosso trapezio")})`], [lb.b || "Fondo", len(sec.b)], [lb.h || "Altezza", len(sec.h)], [lb.m || "Scarpa sponde", rat(sec.m)], [lb.t || "Spessore rivestimento", len(sec.t)], [lb.berm || "Banchina", len(sec.berm)], [lb.cutSlope || "Scarpa in sterro", rat(sec.cut)], [lb.fillSlope || "Scarpa in riporto", rat(sec.fill)]];
    const c = e(`IFCCOURSE(${G()},${oh},${S(part.name + " - " + (lb.lining || "rivestimento"))},$,$,${here()},${shape(part.mesh.lining, stLin)},$,.PROTECTION.)`);
    courses.push(c); put(c);
    props(c, psName, [...common, ...secProps]);
    qto(c, "Qto_CourseBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYLENGTH", "Thickness", sec.t], ["IFCQUANTITYVOLUME", "Volume", part.vol.lining]]);
    if (part.vol.cut > 0.01 && part.mesh.cut.index.length) {
      const k = e(`IFCEARTHWORKSCUT(${G()},${oh},${S(part.name + " - " + (lb.cut || "scavo"))},$,$,${here()},${shape(part.mesh.cut, stCut)},$,.CUT.)`);
      e(`IFCRELVOIDSELEMENT(${G()},${oh},$,$,${terrain},${k})`);
      props(k, psName, common);
      qto(k, "Qto_EarthworksCutBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYVOLUME", "UndisturbedVolume", part.vol.cut]]);
    }
    if (part.vol.fill > 0.01 && part.mesh.fill.index.length) {                // sotto i 10 litri non è un riporto
      const f = e(`IFCEARTHWORKSFILL(${G()},${oh},${S(part.name + " - " + (lb.fill || "riporto"))},$,$,${here()},${shape(part.mesh.fill, stFill)},$,.EMBANKMENT.)`);
      put(f);
      props(f, psName, common);
      qto(f, "Qto_EarthworksFillBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYVOLUME", "CompactedVolume", part.vol.fill]]);
    }
  }
  if (courses.length || pipes.length) e(`IFCRELASSOCIATESMATERIAL(${G()},${oh},$,$,(${[...courses, ...pipes].join(",")}),${e(`IFCMATERIAL(${S(lb.concrete || "Calcestruzzo")},$,'Concrete')`)})`);   // solo se c'è calcestruzzo
  const mat = (list, name, cat) => { if (list.length) e(`IFCRELASSOCIATESMATERIAL(${G()},${oh},$,$,(${list.join(",")}),${e(`IFCMATERIAL(${S(name)},$,${S(cat)})`)})`); };
  mat(slabs, lb.leanMat || "Calcestruzzo magro", "Concrete");
  mat(mixes, lb.mixMat || "Misto cementato", "Soil");
  mat(backs, lb.backMat || "Materiale per rilevato stradale", "Soil");
  const byName = new Map();
  for (const [p, sec] of pipeMats) { const n = sec.matName || sec.mat || "Tubo"; if (!byName.has(n)) byName.set(n, { cat: sec.mat === "cls" ? "Concrete" : sec.mat === "ghisa" || sec.mat === "acciaio" ? "Metal" : "Plastic", list: [] }); byName.get(n).list.push(p); }
  for (const [n, x] of byName) mat(x.list, n, x.cat);
  for (const [n, list] of Object.entries(layerMats)) mat(list, n, "Soil");
  e(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${G()},${oh},$,$,(${contained.join(",")}),${site})`);
  if (bridges.size) {                                     // i ponti (0.15) sotto il sito, coi loro tratti dentro
    e(`IFCRELAGGREGATES(${G()},${oh},$,$,${site},(${[...bridges.values()].map((x) => x.ent).join(",")}))`);
    for (const x of bridges.values()) if (x.list.length) e(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${G()},${oh},$,$,(${x.list.join(",")}),${x.ent})`);
  }

  const iso = date.toISOString().slice(0, 19);
  return [
    "ISO-10303-21;", "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    `FILE_NAME(${S((job.fileName || job.name) + ".ifc")},'${iso}',(''),('viewifc.com'),${S(job.app.name + " " + job.app.version)},'viewifc.com','');`,
    "FILE_SCHEMA(('IFC4X3_ADD2'));", "ENDSEC;", "DATA;", ...L, "ENDSEC;", "END-ISO-10303-21;", "",
  ].join("\n");
}

/**
 * Computo per tratto in CSV (separatore ;, decimali con la virgola o col punto).
 * work: true → prima colonna = opera (p.work), come nell'IFC unico di più opere.
 * cols = volumi in colonna, nell'ordine (fosso: cls, scavo, riporto; canale:
 * cls, magrone, misto cementato, scavo, rinterro); quelli che un tratto non ha valgono 0.
 * sec: true → dopo il tratto la colonna «Sezione» (p.sec), per le opere con sezioni diverse (0.9).
 */
export function ditchCSV(parts, { head, total = "TOTALE", comma = true, work = false, cols = ["lining", "cut", "fill"], sec = false } = {}) {
  const n = (v, d) => { const s = (v || 0).toFixed(d); return comma ? s.replace(".", ",") : s; };
  const q = (s) => (/[;"\n]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s));
  const rows = [head.map(q).join(";")];
  const tot = { length: 0 };
  for (const k of cols) tot[k] = 0;
  const pre = (v) => (work ? [v] : []);
  for (const p of parts) {
    rows.push([...pre(q(p.work || "")), q(p.name), ...(sec ? [q(p.sec || "")] : []), n(p.p0, 3), n(p.p1, 3), n(p.length, 3), ...cols.map((k) => n(p.vol[k], 3))].join(";"));
    tot.length += p.length;
    for (const k of cols) tot[k] += p.vol[k] || 0;
  }
  if (parts.length > 1) rows.push([...pre(q(total)), work ? "" : q(total), ...(sec ? [""] : []), "", "", n(tot.length, 3), ...cols.map((k) => n(tot[k], 3))].join(";"));
  return "﻿" + rows.join("\r\n") + "\r\n";
}

/* -------------------------------------------------------------------------
   File di progetto .profiles (0.5): lo snapshot del salvataggio automatico
   (documento v: 2 della pagina: opere, disegni una volta per did, DTM,
   occhi) su disco, per portarlo su un altro PC o tenerne più versioni.
   Binario e SENZA perdite, come il .terrain del Terrain Sculptor:
     "PSWEEP01" · uint32 LE lunghezza dell'intestazione · intestazione JSON
     (UTF-8) · zeri fino a multiplo di 8 · blocchi, ognuno allineato a 8
   L'intestazione porta { format, v, ...extra, doc, blocks }: doc è lo
   snapshot con i DTM che rimandano ai blocchi ({ blk: i }); i numeri non
   finiti (NaN, ±Infinity) passano come { $num: "…" } (il JSON li farebbe null).
   Blocchi del DTM: punti a componenti separate (tutte le x, le y, le quote)
   e a «piani di byte»; triangoli a differenze (uint32 che si avvolge) e a
   piani di byte: cifre alte che si ripetono, e il gzip le schiaccia. Il gzip
   lo fa chi chiama (CompressionStream nel browser). Il DTM è facoltativo:
   chi non lo mette lo lascia in doc.dtmRefs (nome, percorso) da ricaricare.
   IFC di contesto (0.14), facoltativo come il DTM (fuori: doc.ctxRefs): per
   file le parti per classe (ctxAssemble del motore) coi blocchi P (Float32 a
   componenti separate e a piani), C (r, g, b a piani), I ed E (a differenze).
   Un progetto senza contesto resta identico byte per byte; chi apre con una
   versione di prima non lo vede (i blocchi in più si ignorano).
   ------------------------------------------------------------------------- */
const PRJ_MAGIC = "PSWEEP01", PRJ_FORMAT = "profile-sweep-project", PRJ_V = 1;
const pad8 = (n) => (8 - (n % 8)) % 8;
function bytePlanes(u8, size) {                          // n elementi da size byte → size piani
  const n = u8.length / size, out = new Uint8Array(u8.length);
  for (let k = 0; k < size; k++) { const o = k * n; for (let i = 0; i < n; i++) out[o + i] = u8[size * i + k]; }
  return out;
}
function unBytePlanes(u8, size) {
  const n = u8.length / size, out = new Uint8Array(u8.length);
  for (let k = 0; k < size; k++) { const o = k * n; for (let i = 0; i < n; i++) out[size * i + k] = u8[o + i]; }
  return out;
}
function encPoints(p) {                                  // x,y,z,x,y,z… → x… y… z… → piani
  const n = p.length / 3, c = new Float64Array(p.length);
  for (let i = 0; i < n; i++) { c[i] = p[3 * i]; c[n + i] = p[3 * i + 1]; c[2 * n + i] = p[3 * i + 2]; }
  return bytePlanes(new Uint8Array(c.buffer), 8);
}
function encF32xyz(p) {                                 // come encPoints, in Float32 (le mesh del contesto)
  const n = p.length / 3, c = new Float32Array(p.length);
  for (let i = 0; i < n; i++) { c[i] = p[3 * i]; c[n + i] = p[3 * i + 1]; c[2 * n + i] = p[3 * i + 2]; }
  return bytePlanes(new Uint8Array(c.buffer), 4);
}
function decF32xyz(u8) {
  const c = new Float32Array(unBytePlanes(u8, 4).buffer), n = c.length / 3, p = new Float32Array(c.length);
  for (let i = 0; i < n; i++) { p[3 * i] = c[i]; p[3 * i + 1] = c[n + i]; p[3 * i + 2] = c[2 * n + i]; }
  return p;
}
const encRGB = (c) => bytePlanes(c, 3), decRGB = (u8) => unBytePlanes(u8, 3);
function decPoints(u8) {
  const c = new Float64Array(unBytePlanes(u8, 8).buffer), n = c.length / 3, p = new Float64Array(c.length);
  for (let i = 0; i < n; i++) { p[3 * i] = c[i]; p[3 * i + 1] = c[n + i]; p[3 * i + 2] = c[2 * n + i]; }
  return p;
}
function encFaces(f) {
  const d = new Uint32Array(f.length);
  let prev = 0;
  for (let i = 0; i < f.length; i++) { d[i] = (f[i] - prev) >>> 0; prev = f[i]; }
  return bytePlanes(new Uint8Array(d.buffer), 4);
}
function decFaces(u8) {
  const d = new Uint32Array(unBytePlanes(u8, 4).buffer), f = new Uint32Array(d.length);
  let prev = 0;
  for (let i = 0; i < d.length; i++) { prev = (prev + d[i]) >>> 0; f[i] = prev; }
  return f;
}
const numOut = (k, v) => (typeof v === "number" && !Number.isFinite(v) ? { $num: String(v) } : v);
const numIn = (k, v) => (v && typeof v === "object" && typeof v.$num === "string" && Object.keys(v).length === 1 ? Number(v.$num) : v);

/** È un gzip? (i primi due byte) — il file si salva compresso, ma si apre anche com'è. */
export const isGzip = (u8) => u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b;

/**
 * snapshot della pagina (v: 2) → byte del file (da comprimere).
 * extra va nell'intestazione (versione del tool, data, riassunto per chi apre).
 */
export function encodeProject(doc, extra = {}) {
  const blocks = [];
  const dtms = (doc.dtms || []).map((t) => {
    const P = t.points instanceof Float64Array ? t.points : Float64Array.from(t.points);
    const F = t.faces instanceof Uint32Array ? t.faces : Uint32Array.from(t.faces);
    if (P.length % 3 || F.length % 3) throw new Error(`DTM ${t.name}: punti o triangoli non a terne`);
    blocks.push({ name: t.name + ":points", enc: "f64-xyz-planes", data: encPoints(P) });
    blocks.push({ name: t.name + ":faces", enc: "u32-delta-planes", data: encFaces(F) });
    return { ...t, points: { blk: blocks.length - 2 }, faces: { blk: blocks.length - 1 } };
  });
  const ctx = (doc.ctx || []).map((m) => ({ ...m, parts: m.parts.map((p, j) => {
    if (p.P.length % 3 || p.C.length !== p.P.length || p.I.length % 3 || p.E.length % 5) throw new Error(`contesto ${m.name}: parte ${j} non valida`);
    const at = blocks.length;
    blocks.push({ name: `${m.name}:${j}:P`, enc: "f32-xyz-planes", data: encF32xyz(p.P instanceof Float32Array ? p.P : Float32Array.from(p.P)) });
    blocks.push({ name: `${m.name}:${j}:C`, enc: "u8-rgb-planes", data: encRGB(p.C instanceof Uint8Array ? p.C : Uint8Array.from(p.C)) });
    blocks.push({ name: `${m.name}:${j}:I`, enc: "u32-delta-planes", data: encFaces(p.I instanceof Uint32Array ? p.I : Uint32Array.from(p.I)) });
    blocks.push({ name: `${m.name}:${j}:E`, enc: "u32-delta-planes", data: encFaces(p.E instanceof Uint32Array ? p.E : Uint32Array.from(p.E)) });
    return { ...p, P: { blk: at }, C: { blk: at + 1 }, I: { blk: at + 2 }, E: { blk: at + 3 } };
  }) }));
  const header = { format: PRJ_FORMAT, v: PRJ_V, ...extra, doc: { ...doc, dtms, ...(doc.ctx ? { ctx } : {}) },
    blocks: blocks.map((b) => ({ name: b.name, enc: b.enc, length: b.data.length })) };
  const hb = new TextEncoder().encode(JSON.stringify(header, numOut));
  let size = 12 + hb.length + pad8(12 + hb.length);
  for (const b of blocks) size += b.data.length + pad8(b.data.length);
  const out = new Uint8Array(size);
  for (let i = 0; i < 8; i++) out[i] = PRJ_MAGIC.charCodeAt(i);
  new DataView(out.buffer).setUint32(8, hb.length, true);
  out.set(hb, 12);
  let o = 12 + hb.length + pad8(12 + hb.length);
  for (const b of blocks) { out.set(b.data, o); o += b.data.length + pad8(b.data.length); }
  return out;
}

/** byte del file (già decompressi) → { doc, header } — errori in italiano, li mostra la pagina */
export function decodeProject(u8) {
  const bad = (m) => { throw new Error(m); };
  if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
  if (u8.length < 12 || String.fromCharCode(...u8.subarray(0, 8)) !== PRJ_MAGIC) bad("non è un progetto di Sviluppo profili");
  const hl = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(8, true);
  if (12 + hl > u8.length) bad("file di progetto troncato");
  let h;
  try { h = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + hl)), numIn); } catch (e) { bad("intestazione del progetto illeggibile"); }
  if (!h || h.format !== PRJ_FORMAT) bad("non è un progetto di Sviluppo profili");
  if (!(h.v >= 1)) bad("versione del progetto non valida");
  if (h.v > PRJ_V) bad(`progetto di una versione più recente (formato ${h.v}): aggiorna la pagina`);
  const doc = h.doc;
  if (!doc || (doc.v !== 1 && doc.v !== 2) || (doc.v === 2 && !Array.isArray(doc.works))) bad("contenuto del progetto non valido");
  let o = 12 + hl + pad8(12 + hl);
  const got = [];
  for (const b of h.blocks || []) {
    if (!(b.length >= 0) || o + b.length > u8.length) bad("file di progetto troncato");
    got.push({ enc: b.enc, data: u8.slice(o, o + b.length) });
    o += b.length + pad8(b.length);
  }
  const blk = (r, enc, size) => {
    const b = r && got[r.blk];
    if (!b || b.enc !== enc || b.data.length % size) bad("DTM del progetto danneggiato");
    return b.data;
  };
  if (doc.v === 2) doc.dtms = (doc.dtms || []).map((t) => {
    const points = decPoints(blk(t.points, "f64-xyz-planes", 24)), faces = decFaces(blk(t.faces, "u32-delta-planes", 12));
    const n = points.length / 3;
    for (let i = 0; i < faces.length; i++) if (faces[i] >= n) bad("DTM del progetto danneggiato");
    return { ...t, points, faces };
  });
  const cblk = (r, enc, size) => {
    const b = r && got[r.blk];
    if (!b || b.enc !== enc || b.data.length % size) bad("contesto del progetto danneggiato");
    return b.data;
  };
  if (doc.v === 2 && Array.isArray(doc.ctx)) doc.ctx = doc.ctx.map((m) => ({ ...m, parts: (m.parts || []).map((p) => {
    const P = decF32xyz(cblk(p.P, "f32-xyz-planes", 12)), C = decRGB(cblk(p.C, "u8-rgb-planes", 3));
    const I = decFaces(cblk(p.I, "u32-delta-planes", 12)), E = decFaces(cblk(p.E, "u32-delta-planes", 20));
    const n = P.length / 3;
    if (C.length !== P.length) bad("contesto del progetto danneggiato");
    for (let i = 0; i < I.length; i++) if (I[i] >= n) bad("contesto del progetto danneggiato");
    for (let e = 0; e < E.length; e += 5) if (E[e] > E[e + 1] || E[e + 1] > n || E[e + 2] > E[e + 3] || E[e + 3] > I.length) bad("contesto del progetto danneggiato");
    return { ...p, P, C, I, E };
  }) }));
  delete h.doc;
  return { doc, header: h };
}

/* -------------------------------------------------------------------------
   DTM da punti x,y,z (0.6): CSV, TXT, XYZ, PTS — le regole del Terrain
   Sculptor (parsePoints): separatore virgola, tab o spazi, oppure «;» con la
   virgola decimale; una prima colonna intera progressiva (numero di punto)
   si salta; righe senza 3 numeri (intestazione, note) si contano e basta.
   A pezzi, perché il rilievo intero è 183 MB e 6 M punti: le righe si
   leggono man mano (push del testo come arriva, anche a metà riga) e si
   tengono solo i punti dentro il riquadro, se c'è (il corridoio delle opere).
   Il modo (separatore, colonna del numero) si decide sulle prime 50 righe.
   ------------------------------------------------------------------------- */
export function pointsReader({ bbox = null } = {}) {
  let rest = "", sample = [], mode = null, n = 0, read = 0, skipped = 0, out = 0;
  let P = new Float64Array(3 * 65536);
  const keep = (x, y, z) => {
    read++;
    if (bbox && (x < bbox.x0 || x > bbox.x1 || y < bbox.y0 || y > bbox.y1)) { out++; return; }
    if (3 * n + 3 > P.length) { const Q = new Float64Array(P.length * 2); Q.set(P); P = Q; }
    P[3 * n] = x; P[3 * n + 1] = y; P[3 * n + 2] = z; n++;
  };
  const nums = (l, semi) => {
    const toks = semi ? l.split(";") : l.split(/[,\t ]+/), v = [];
    for (const s of toks) { const t = s.trim(); if (!t) continue; const x = +(semi ? t.replace(",", ".") : t); if (Number.isFinite(x)) v.push(x); }
    return v;
  };
  const decide = () => {
    const semi = sample.filter((l) => l.includes(";")).length > sample.length / 2;
    const rows = sample.map((l) => nums(l, semi)).filter((r) => r.length >= 3);
    let id = false;
    if (rows.length > 1 && rows.filter((r) => r.length >= 4).length > rows.length * 0.9) {
      let prog = 0;
      for (let r = 1; r < rows.length; r++) if (Number.isInteger(rows[r][0]) && rows[r][0] > rows[r - 1][0]) prog++;
      id = prog > (rows.length - 1) * 0.9;
    }
    mode = { semi, o: id ? 1 : 0 };
    const s = sample; sample = null;
    for (const l of s) line(l);
  };
  const line = (l) => {
    const v = nums(l, mode.semi);
    if (v.length < 3 + mode.o) { skipped++; return; }
    keep(v[mode.o], v[mode.o + 1], v[mode.o + 2]);
  };
  const feed = (l) => {
    l = l.trim();
    if (!l) return;
    if (mode) line(l);
    else { sample.push(l); if (sample.length >= 50) decide(); }
  };
  return {
    push(text) {
      const s = rest + text, parts = s.split(/\r?\n|\r/);
      rest = parts.pop();
      for (const l of parts) feed(l);
    },
    end() {
      if (rest) feed(rest);
      rest = "";
      if (!mode) decide();
      if (read < 3) throw new Error("servono almeno 3 punti x,y,z");
      return { points: P.slice(0, 3 * n), count: n, read, skipped, outside: out, idColumn: mode.o === 1 };
    },
  };
}

/* -------------------------------------------------------------------------
   Rhino .3dm (0.8) — rhino3dm iniettato (quello del Terrain Sculptor).
   Scelte dell'utente (2026-10-05): coordinate attorno all'ORIGINE LOCALE del
   progetto (la stessa delle mesh dell'IFC; scritta nel documento e segnata
   da un TextDot sul layer «Origine»); layer «Opera > classe» (un padre per
   opera, un sottolayer per classe, un oggetto per tratto); asse 3D e DTM del
   corridoio; spigoli vivi oltre 30°. Le mesh di rhino3dm sono in float:
   vicino all'origine il centesimo di millimetro, a 4,6 milioni di metri
   mezzo metro — per questo l'origine locale.
   ------------------------------------------------------------------------- */

/**
 * Spigoli vivi: ogni vertice si divide fra i gruppi di facce che lo usano
 * con normali entro deg l'una dall'altra (rispetto alla prima del gruppo);
 * oltre, vertici propri. Rhino media le normali sui vertici condivisi: senza
 * divisione una parete e un fondo a 90° si sfumano a fasce. Il tubo a 48
 * lati (7,5° fra due facce) resta liscio. Le posizioni non cambiano: la mesh
 * resta chiusa (Rhino unisce i vertici coincidenti nella topologia).
 * Ritorna { positions: Float64Array, index: Uint32Array }.
 */
export function sharpEdges({ positions: P, index: I }, deg = 30) {
  const nV = P.length / 3, nF = I.length / 3, cos = Math.cos(deg * Math.PI / 180);
  const N = new Float64Array(nF * 3), ok = new Uint8Array(nF);
  for (let f = 0; f < nF; f++) {
    const a = 3 * I[3 * f], b = 3 * I[3 * f + 1], c = 3 * I[3 * f + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const x = uy * wz - uz * wy, y = uz * wx - ux * wz, z = ux * wy - uy * wx, l = Math.hypot(x, y, z);
    if (l > 1e-12) { N[3 * f] = x / l; N[3 * f + 1] = y / l; N[3 * f + 2] = z / l; ok[f] = 1; }
  }
  // facce di ogni vertice (CSR)
  const deg0 = new Uint32Array(nV + 1);
  for (let k = 0; k < I.length; k++) deg0[I[k] + 1]++;
  for (let v = 0; v < nV; v++) deg0[v + 1] += deg0[v];
  const fill = deg0.slice(0, nV), inc = new Uint32Array(I.length);
  for (let k = 0; k < I.length; k++) inc[fill[I[k]]++] = k;               // k = posizione nell'indice (faccia k / 3)
  const out = [], idx = new Uint32Array(I.length);
  for (let v = 0; v < nV; v++) {
    const seeds = [];                                                       // { f: faccia che fa da normale (−1 = degenere), v: nuovo vertice }
    for (let q = deg0[v]; q < deg0[v + 1]; q++) {
      const k = inc[q], f = (k / 3) | 0;
      let g = null;
      if (!ok[f]) g = seeds[0] || null;                                     // faccia degenere (area nulla): col primo gruppo
      else for (const s of seeds) if (s.f >= 0 && N[3 * s.f] * N[3 * f] + N[3 * s.f + 1] * N[3 * f + 1] + N[3 * s.f + 2] * N[3 * f + 2] >= cos) { g = s; break; }
      if (!g) {
        g = { f: ok[f] ? f : -1, v: out.length / 3 };
        seeds.push(g);
        out.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]);
      }
      idx[k] = g.v;
    }
  }
  return { positions: Float64Array.from(out), index: idx };
}

const RHINO_NAMES = { origin: "Origine", originDot: "Origine E {x} · N {y}", axis: "Asse 3D", dtm: "Terreno (DTM)" };

/* mesh in blocco (come il Terrain Sculptor): createFromThreejsJSON parla three.js (Y in alto), Rhino (X, Y, Z) → (X, Z, −Y) */
function rhinoMesh(rhino, P, I) {
  const n = P.length / 3, pos = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) { pos[3 * k] = P[3 * k]; pos[3 * k + 1] = P[3 * k + 2]; pos[3 * k + 2] = -P[3 * k + 1]; }
  const me = rhino.Mesh.createFromThreejsJSON({ data: { attributes: { position: { itemSize: 3, type: "Float32Array", array: pos } }, index: { array: I instanceof Uint32Array ? I : Uint32Array.from(I) } } });
  me.normals().computeNormals(); me.compact();
  return me;
}

/**
 * .3dm (Rhino 7 e 8, metri). job = {
 *   origin: { x, y } (le mesh sono già in coordinate locali; asse e DTM assoluti, li sposta lo scrittore),
 *   works: [{ name, rgb, axis: [{ x, y, z }…] assoluti, classes: [{ key, label, rgb, objects: [{ name, mesh }] }] }],
 *   dtm: { name, positions (assoluti), index } o una lista (un oggetto per file), names, splitDeg (30), version (7) }.
 * Layer: «Origine» (TextDot nell'origine), per opera un padre con i sottolayer «Asse 3D» e uno per classe
 * (solo se ha oggetti), «Terreno (DTM)». Ritorna { bytes, report: { objects, closed, open: [nomi], layers } }.
 */
export function build3dm(rhino, { origin = { x: 0, y: 0 }, works = [], dtm = null, names = {}, splitDeg = 30, version = 7 } = {}) {
  const NM = { ...RHINO_NAMES, ...names };
  const doc = new rhino.File3dm();
  doc.settings().modelUnitSystem = rhino.UnitSystem.Meters;
  doc.strings().set("viewifc.origine", `${origin.x};${origin.y}`);
  const report = { objects: 0, closed: 0, open: [], layers: [] };
  const layer = (name, rgb, parent = null) => {
    const l = new rhino.Layer();
    l.name = name; l.color = { r: rgb[0], g: rgb[1], b: rgb[2], a: 255 };
    if (parent) l.parentLayerId = parent;
    const i = doc.layers().add(l);
    report.layers.push(parent ? null : name);
    return { index: i, id: doc.layers().get(i).id };
  };
  const attr = (li, name) => { const a = new rhino.ObjectAttributes(); a.layerIndex = li; if (name) a.name = name; return a; };
  const fmt = (v) => String(Math.round(v * 1000) / 1000);
  const lo = layer(NM.origin, [191, 215, 48]);
  doc.objects().add(new rhino.TextDot(NM.originDot.replace("{x}", fmt(origin.x)).replace("{y}", fmt(origin.y)), [0, 0, 0]), attr(lo.index, NM.origin));
  const used = new Map();
  for (const w of works) {
    let name = w.name || "—";                                      // nomi dei padri unici (Rhino non vuole due layer uguali allo stesso livello)
    const n = (used.get(name) || 0) + 1; used.set(name, n);
    if (n > 1) name += ` (${n})`;
    const top = layer(name, w.rgb || [120, 120, 120]);
    if (w.axis && w.axis.length > 1) {
      const la = layer(NM.axis, [111, 138, 0], top.id), pl = new rhino.Polyline(w.axis.length);
      for (const p of w.axis) pl.add(p.x - origin.x, p.y - origin.y, p.z);
      doc.objects().addPolyline(pl, attr(la.index, `${name} - ${NM.axis}`));
    }
    for (const c of w.classes || []) {
      const objs = (c.objects || []).filter((o) => o.mesh && o.mesh.index.length);
      if (!objs.length) continue;
      const lc = layer(c.label, c.rgb || [150, 150, 150], top.id);
      for (const o of objs) {
        const m = splitDeg > 0 ? sharpEdges(o.mesh, splitDeg) : o.mesh, me = rhinoMesh(rhino, m.positions, m.index);
        report.objects++;
        if (me.isClosed) report.closed++; else report.open.push(o.name);
        doc.objects().addMesh(me, attr(lc.index, o.name));
      }
    }
  }
  const dtms = (Array.isArray(dtm) ? dtm : dtm ? [dtm] : []).filter((t) => t && t.index && t.index.length);
  if (dtms.length) {
    const ld = layer(NM.dtm, [140, 132, 112]);
    for (const t of dtms) {
      const P = t.positions, Q = new Float64Array(P.length);
      for (let k = 0; k < P.length; k += 3) { Q[k] = P[k] - origin.x; Q[k + 1] = P[k + 1] - origin.y; Q[k + 2] = P[k + 2]; }
      doc.objects().addMesh(rhinoMesh(rhino, Q, t.index), attr(ld.index, t.name || NM.dtm));
    }
  }
  report.layers = report.layers.filter(Boolean);
  const opt = new rhino.File3dmWriteOptions();
  opt.version = version;
  const bytes = doc.toByteArrayOptions(opt);
  doc.delete && doc.delete();
  return { bytes, report };
}

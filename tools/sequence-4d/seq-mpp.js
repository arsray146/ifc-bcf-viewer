/* =========================================================================
   Sequenza 4D — lettura del .mpp di Microsoft Project (tool 19, F2)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Senza DOM e senza import (si prova in Node: test/test_seq_mpp.js). Solo il
   formato di Project 2010 e successivi (MPP14). Due strati:
   - il contenitore OLE2 (Compound File Binary, specifica [MS-CFB]);
   - le tabelle interne di Project, lette seguendo MPXJ di Jon Iles
     (Packwood Software, LGPL 2.1, https://www.mpxj.org): Props, la mappa dei
     campi che Project scrive nel file stesso, dati fissi e variabili delle
     attività, legami, calendari, alias dei campi personalizzati.
   readMPP() restituisce lo stesso oggetto di readMSPDI (seq-io.js): albero,
   Gantt e sequenza non cambiano. Quello che non torna si dice (warnings o
   errore «mppBroken»), mai un programma letto male in silenzio.
   Formato e collaudo: PIANO_Sequenza_4D.md §3 bis e §10.
   ========================================================================= */

const fail = (code) => { const e = new Error(code); e.code = code; return e; };

/* ---- byte: little-endian, come Project ---------------------------------- */
const U8 = (a, o) => a[o];
const U16 = (a, o) => a[o] | (a[o + 1] << 8);
const I32 = (a, o) => a[o] | (a[o + 1] << 8) | (a[o + 2] << 16) | (a[o + 3] << 24);
const F64 = (a, o) => { const v = new DataView(a.buffer, a.byteOffset + o, 8).getFloat64(0, true); return Number.isNaN(v) ? 0 : v; };
const ok = (a, o, n) => a != null && o >= 0 && o + n <= a.length;
/* importi e unità: double ×100 (MPXJ: sotto 0,1 vale zero) */
const money = (x) => (Math.abs(x) < 0.1 ? 0 : x / 100);
const u16 = (a, o) => (ok(a, o, 2) ? U16(a, o) : 0);
const i32 = (a, o) => (ok(a, o, 4) ? I32(a, o) : 0);
const UTF16 = new TextDecoder("utf-16le");
/* stringa UTF-16 fino al doppio zero */
function ustr(a, o = 0) {
  if (!a || o >= a.length) return "";
  let e = o;
  while (e + 1 < a.length && (a[e] || a[e + 1])) e += 2;
  if (e + 1 >= a.length) e = a.length - ((a.length - o) & 1);
  return UTF16.decode(a.subarray(o, e));
}
/* stringa a un byte fino allo zero (le note RTF) */
function astr(a, o = 0) {
  let s = "";
  for (let k = o; k < a.length && a[k]; k++) s += String.fromCharCode(a[k]);
  return s;
}

/* =========================================================================
   Contenitore OLE2 ([MS-CFB])
   ========================================================================= */
const FREE = 0xfffffffa;   // da qui in su: fine catena, settore libero, FAT, DIFAT
export function readCFB(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (b.length < 512 || SIG.some((x, k) => b[k] !== x)) throw fail("notOle");
  const ss = U16(b, 30), mss = U16(b, 32);
  if ((ss !== 9 && ss !== 12) || mss !== 6) throw fail("mppBroken");
  const SS = 1 << ss, MSS = 64, nSec = Math.floor((b.length - SS) / SS);
  const nFat = I32(b, 44) >>> 0, dir0 = I32(b, 48) >>> 0, cutoff = I32(b, 56) >>> 0;
  const mfat0 = I32(b, 60) >>> 0, difat0 = I32(b, 68) >>> 0, nDifat = I32(b, 72) >>> 0;
  const at = (s) => { if (s >= nSec) throw fail("mppBroken"); return (s + 1) * SS; };
  const fatSecs = [];
  for (let k = 0; k < 109 && fatSecs.length < nFat; k++) fatSecs.push(I32(b, 76 + k * 4) >>> 0);
  for (let s = difat0, n = 0; n < nDifat && s < FREE; n++) {
    const o = at(s);
    for (let k = 0; k < SS / 4 - 1 && fatSecs.length < nFat; k++) fatSecs.push(I32(b, o + k * 4) >>> 0);
    s = I32(b, o + SS - 4) >>> 0;
  }
  const per = SS / 4, fat = new Uint32Array(fatSecs.length * per);
  fatSecs.forEach((s, k) => { const o = at(s); for (let i = 0; i < per; i++) fat[k * per + i] = I32(b, o + i * 4) >>> 0; });
  /* catena di settori → byte (con la guardia contro i cicli) */
  const chain = (s, size = -1) => {
    const list = [];
    while (s < FREE) { if (s >= fat.length || list.length > fat.length) throw fail("mppBroken"); list.push(s); s = fat[s]; }
    const out = new Uint8Array(list.length * SS);
    list.forEach((x, k) => out.set(b.subarray(at(x), at(x) + SS), k * SS));
    return size >= 0 ? out.subarray(0, Math.min(size, out.length)) : out;
  };
  const dir = chain(dir0), E = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nl = U16(dir, o + 64);
    E.push(nl >= 2 && nl <= 64 ? {
      name: UTF16.decode(dir.subarray(o, o + nl - 2)), type: dir[o + 66],
      l: I32(dir, o + 68), r: I32(dir, o + 72), c: I32(dir, o + 76),
      start: I32(dir, o + 116) >>> 0, size: I32(dir, o + 120) >>> 0,   // v3: i 4 byte alti della dimensione non contano
    } : null);
  }
  if (!E[0] || E[0].type !== 5) throw fail("mppBroken");
  const mini = chain(E[0].start, E[0].size);
  const mfatB = mfat0 < FREE ? chain(mfat0) : new Uint8Array(0), mfat = new Uint32Array(mfatB.length >> 2);
  for (let k = 0; k < mfat.length; k++) mfat[k] = I32(mfatB, k * 4) >>> 0;
  const streams = new Map(), seen = new Set();
  const walk = (id, pre) => {
    if (id < 0 || id >= E.length || !E[id] || seen.has(id)) return;
    seen.add(id);
    const e = E[id];
    walk(e.l, pre);
    if (e.type === 2) streams.set(pre + e.name, e);
    else if (e.type === 1) walk(e.c, pre + e.name + "/");
    walk(e.r, pre);
  };
  walk(E[0].c, "");
  const read = (e) => {
    if (e.size >= cutoff) return chain(e.start, e.size);
    const out = new Uint8Array(e.size);
    for (let s = e.start, k = 0; k < e.size; k += MSS) {
      if (s >= mfat.length || (s + 1) * MSS > mini.length) throw fail("mppBroken");
      out.set(mini.subarray(s * MSS, s * MSS + Math.min(MSS, e.size - k)), k);
      s = mfat[s];
    }
    return out;
  };
  return {
    has: (p) => streams.has(p),
    get: (p) => { const e = streams.get(p); return e ? read(e) : null; },
    names: () => [...streams.keys()],
  };
}

/* =========================================================================
   Strutture di Project (MPXJ: Props14, FixedMeta, FixedData, VarMeta12, Var2Data)
   ========================================================================= */
/* Props14: elenco di (chiave → byte) */
function readProps(a) {
  const m = new Map();
  if (!a || a.length < 16) return m;
  const n = U16(a, 12);
  for (let k = 0, o = 16; k < n && o + 12 <= a.length; k++) {
    const size = I32(a, o), key = I32(a, o + 4);
    o += 12;
    if (size < 1 || o + size > a.length) break;
    m.set(key, a.subarray(o, o + size));
    o += size + (size & 1);
  }
  return m;
}
const MAGIC = 0xfadfadba | 0;
/* FixedMeta: un'intestazione di 16 byte e voci di dimensione fissa */
function fixedMeta(a, sizeOf) {
  if (!a || a.length < 16 || I32(a, 0) !== MAGIC) throw fail("mppBroken");
  const count = I32(a, 8), size = typeof sizeOf === "number" ? sizeOf : sizeOf(a.length, count);
  const items = [];
  for (let k = 0, n = Math.floor((a.length - 16) / size); k < n; k++) items.push(a.subarray(16 + k * size, 16 + (k + 1) * size));
  return { count, items };
}
/* Fixed2Meta: la dimensione delle voci si sceglie fra alcune, quella che torna col numero dei FixedData */
const fixedMetaSizes = (others, sizes) => (fileSize, count) => {
  let size = sizes[0], dist = -Infinity;
  const avail = fileSize - 16;
  for (const s of sizes) {
    if (avail % s) continue;
    if (avail / s === others) return s;
    const d = count * s - avail;
    if (d <= 0 && d > dist) { size = s; dist = d; }
  }
  return size;
};
/* FixedData: ogni voce comincia dove dice il suo FixedMeta e finisce dove comincia la successiva */
function fixedData(meta, a, maxSize = 0, minSize = 0) {
  const n = meta.items.length, items = new Array(n).fill(null), offs = new Array(n).fill(-1);
  if (!a) return { items, offs };
  for (let k = 0; k < n; k++) {
    const off = I32(meta.items[k], 4);
    if (off < 0 || off > a.length) continue;
    let size = k + 1 === n ? a.length - off : I32(meta.items[k + 1], 4) - off;
    if (size === 0) size = minSize;
    const avail = a.length - off;
    if (size < 0 || size > avail) size = maxSize ? Math.min(maxSize, avail) : avail;
    if (maxSize && size > maxSize) size = maxSize;
    if (size > 0) { items[k] = a.subarray(off, off + size); offs[k] = off; }
  }
  return { items, offs };
}
/* FixedData a voci di dimensione nota (i legami) */
function fixedDataSized(meta, size, a) {
  const n = meta.items.length, items = new Array(n).fill(null), offs = new Array(n).fill(-1);
  for (let k = 0; a && k < n; k++) {
    const off = I32(meta.items[k], 4);
    if (off < 0 || off > a.length) continue;
    items[k] = a.subarray(off, off + Math.min(size, a.length - off));
    offs[k] = off;
  }
  return { items, offs };
}
/* VarMeta12 + Var2Data: per ogni UID, (chiave del campo → byte) */
function varData(meta, data) {
  const table = new Map(), blobs = new Map();
  if (!meta || meta.length < 24) return { table, get: () => null, has: () => false };
  const m0 = I32(meta, 0);
  if (m0 !== 0 && m0 !== MAGIC) throw fail("mppBroken");
  const count = I32(meta, 8);
  for (let k = 0, o = 24; k < count && o + 12 <= meta.length; k++, o += 12) {
    const uid = I32(meta, o), off = I32(meta, o + 4), type = U16(meta, o + 8);
    let t = table.get(uid);
    if (!t) table.set(uid, (t = new Map()));
    t.set(type, off);
  }
  const blob = (off) => {
    if (blobs.has(off)) return blobs.get(off);
    let v = null;
    if (data && off >= 0 && off + 4 <= data.length) {
      const size = I32(data, off);
      if (size >= 0 && off + 4 + size <= data.length) v = data.subarray(off + 4, off + 4 + size);
    }
    blobs.set(off, v);
    return v;
  };
  return {
    table,
    has: (uid) => table.has(uid),
    get: (uid, type) => { const t = table.get(uid), off = t && t.get(type); return off == null ? null : blob(off); },
  };
}

/* ---- date e durate: minuti di Project dal 31/12/1983 -------------------- */
const EPOCH = Date.UTC(1983, 11, 31);
const Y1984 = Date.UTC(1984, 0, 1), Y2150 = Date.UTC(2150, 0, 1);
/* data con l'ora: giorni (2 byte) + decimi di minuto (2 byte); fuori scala → nulla, come parseDate */
function stamp(a, o) {
  if (!ok(a, o, 4)) return null;
  const days = U16(a, o + 2);
  if (days <= 1 || days === 65535) return null;
  let t = U16(a, o);
  if (t === 65535) t = 0;
  if (days < 100 && (t * 6) % 60) return null;
  const ms = EPOCH + days * 864e5 + t * 6000;
  return ms < Y1984 || ms >= Y2150 ? null : ms;
}
const day = (a, o) => { const d = u16(a, o); return d === 65535 ? null : EPOCH + d * 864e5; };
/* ora del giorno: decimi di minuto → minuti */
const tod = (a, o) => (u16(a, o) / 10) % 1440;
const pad = (n, w = 2) => String(n).padStart(w, "0");
const isoDate = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
/* durata in decimi di minuto → «PT7584H0M0S» come nell'XML */
const isoDur = (tenths) => { const neg = tenths < 0, s = Math.round(Math.abs(tenths) * 6); return `${neg ? "-" : ""}PT${Math.floor(s / 3600)}H${Math.floor((s % 3600) / 60)}M${s % 60}S`; };
const numStr = (v) => (Number.isInteger(v) ? String(v) : String(+v.toPrecision(15)));
const guid = (a, o) => {
  if (!ok(a, o, 16)) return "";
  const h = (k) => pad(a[o + k].toString(16));
  const s = h(3) + h(2) + h(1) + h(0) + "-" + h(5) + h(4) + "-" + h(7) + h(6) + "-" + h(8) + h(9) + "-" + h(10) + h(11) + h(12) + h(13) + h(14) + h(15);
  return /^[0-]+$/.test(s) ? "" : s.toUpperCase();
};

/* RTF delle note → testo semplice */
export function rtfText(rtf) {
  const s = String(rtf || "");
  if (!/^\s*\{\\rtf/.test(s)) return s.trim();
  let out = "", depth = 0, skip = -1, uc = 1, pend = 0;
  const SKIP = /^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|listtable|listoverridetable|generator|themedata|colorschememapping|datastore|latentstyles|rsidtbl|xmlnstbl|mmathPr)$/;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "{") { depth++; continue; }
    if (c === "}") { if (depth === skip) skip = -1; depth--; continue; }
    if (c === "\\") {
      const m = /^\\(?:([a-zA-Z]+)(-?\d+)? ?|'([0-9a-fA-F]{2})|(\*)|([\\{}~\-_]))/.exec(s.slice(k, k + 40));
      if (!m) continue;
      k += m[0].length - 1;
      if (skip >= 0) continue;
      if (m[4]) { skip = depth; continue; }
      if (m[5]) { out += m[5] === "~" ? " " : m[5] === "-" || m[5] === "_" ? "" : m[5]; continue; }
      if (m[3]) { if (pend > 0) { pend--; continue; } out += String.fromCharCode(parseInt(m[3], 16)); continue; }
      const w = m[1], n = m[2] == null ? null : +m[2];
      if (SKIP.test(w)) { skip = depth; continue; }
      if (w === "par" || w === "line") out += "\n";
      else if (w === "tab") out += "\t";
      else if (w === "uc") uc = n ?? 1;
      else if (w === "u" && n != null) { out += String.fromCharCode(n < 0 ? n + 65536 : n); pend = uc; }
      continue;
    }
    if (skip >= 0 || c === "\r" || c === "\n") continue;
    if (pend > 0) { pend--; continue; }
    out += c;
  }
  return out.replace(/\n+$/, "").trim();
}

/* =========================================================================
   I campi delle attività (indice MPP = FieldID di Project & 0xFFFF)
   ========================================================================= */
/* dimensione dei campi nei dati fissi, per tipo (da TaskField di MPXJ): serve a
   sapere quanto è lunga una voce completa. Intervalli in base 36: «a-b» = da a per b+1 */
const SIZES = {
  2: "h,j,o-1,w-2,1z-b,2d,2k,2q,31-2,3k-1,3o,48,4y-1,51,53-2,5k,5m,68-1,6g,6u,6x-4,84-9,9d-6,b0,b3,b7-a,dk,dv,e6,eh,es,ez-1,fa,fl,fw,g7,gi,i1-t,nb-9,qx-j,v3,v6,wd,wl,ws,wz,x6,xd,xk,xr,xy,y5,yc,yj,yq,zj,zl-1,zt,zz-2,110,12d-3",
  4: "3,i,k-3,r-4,z-b,1g-1,1j-1,1m-1,1p-1,1s-1,2e,2l,2r-2,2v-2,3b,4g,4j,4m,6q,73,7d-q,a0,a9-1,ac,ar,b5,bl,bn,bp,br,bt,bv,bx,bz,c1,c3,c5-2,cq,de-1,dj,dp-1,du,e0-1,e5,eb-1,eg,em-1,er,f4-1,f9,ff-1,fk,fq-1,fv,g1-1,g6,gc-1,gh,gx-13,nv-13,w0-1,wm-1,wt-1,x0-1,x7-1,xe-1,xl-1,xs-1,xz-1,y6-1,yd-1,yk-1,zn-1,zs,103-w,116-2,136-3",
  8: "0-2,4-9,2b,2y-2,3c,4k-1,4o-2,76-6,c9,dc,dg-1,dl,dr-1,dw,e2-1,e7,ed-1,ei,eo-1,et,f1,f6-1,fb,fh-1,fm,fs-1,fx,g3-1,g8,ge-1,gj,gn-9,nl-9,vn-1,wj-1,wo-1,wv-1,x2-1,x9-1,xg-1,xn-1,xu-1,y1-1,y8-1,yf-1,ym-1,113",
  16: "vr-1,vu,wh",
};
const FIX_SIZE = new Map();
for (const [size, list] of Object.entries(SIZES))
  for (const r of list.split(",")) { const [a, n] = r.split("-"); const s = parseInt(a, 36); for (let k = 0; k <= (n ? parseInt(n, 36) : 0); k++) FIX_SIZE.set(s + k, +size); }

/* i campi che servono al 4D. Nel formato MPP14 alcuni indici cambiano senso
   (MPXJ mapMpp14): 35/36/29 sono le date e la durata *programmate*, l'inizio e la
   fine dell'attività stanno a 1283/1284, la baseline a 1299–1301. Dove un campo ha
   due indici vale l'ultimo della mappa, come in MPXJ */
const F = {
  NAME: [14], NOTES: [15], WBS: [16], TOTAL_SLACK: [22], ID: [23], PCT: [32],
  START: [1283], FINISH: [1284], SSTART: [35, 1338], SFINISH: [36, 1339], SDUR: [29, 1340],
  ASTART: [41], AFINISH: [42], BSTART: [1299], BFINISH: [1300], BDUR: [1301], BSTART0: [43], BFINISH0: [44], BDUR0: [27],
  LEVEL: [85, 249], UID: [86], CREATED: [93], PARENT: [160], DUR_U: [181], BDUR_U: [179],
  CAL: [401], START_SLACK: [438], FINISH_SLACK: [439], GUID: [1143], MDUR: [1288], MDUR_U: [1289],
  CTYPE: [17], CDATE: [18],     // il vincolo (0.8.0), numerato come nell'XML
  /* costi (F7): in centesimi, come nell'XML */
  COST: [5], BCOST: [6], ACOST: [7], FIXED: [8], BCWP: [11], BCWS: [12], ACWP: [120],
};
/* campi personalizzati: indice → [nome di Project, tipo di seq-io] */
const CUSTOM = new Map();
{
  const add = (name, type, ids) => ids.forEach((id, k) => CUSTOM.set(id, [name + (k + 1), type]));
  const seq = (a, n) => Array.from({ length: n }, (_, k) => a + k);
  add("Text", "text", [51, 54, 57, 60, 63, 66, 67, 68, 69, 70, ...seq(317, 20)]);
  add("Start", "date", [52, 55, 58, 61, 64, 282, 284, 286, 288, 290]);
  add("Finish", "date", [53, 56, 59, 62, 65, 283, 285, 287, 289, 291]);
  add("Number", "num", [...seq(87, 5), ...seq(302, 15)]);
  add("Duration", "dur", [103, 104, 105, ...seq(275, 7)]);
  add("Cost", "cost", [106, 107, 108, ...seq(258, 7)]);
  add("Date", "date", seq(265, 10));
  add("Flag", "flag", [...seq(72, 10), ...seq(292, 10)]);
}
const TASK_BASE = 0x0b400000;

/* la mappa dei campi delle attività: dove sta ogni campo (dati fissi 0/1, offset; dati variabili, chiave) */
function taskFieldMap(projProps) {
  const fm = projProps.get(131092) || projProps.get(50331668);
  if (!fm) throw fail("mppBroken");
  const map = new Map(), max = [0, 0];
  let last = 0, blk = 0;
  for (let o = 0; o + 28 <= fm.length; o += 28) {
    const type = I32(fm, o + 12) >>> 0, off = U16(fm, o + 4), cat = U16(fm, o + 20), idx = type & 0xffff;
    if ((type & 0xffff0000) >>> 0 !== TASK_BASE) continue;
    let item;
    if (cat === 0x0b || cat === 0x64) item = { loc: "meta" };
    else if (off !== 65535) {
      if (off < last) blk++;
      last = off;
      if (blk > 1) throw fail("mppBroken");
      const size = FIX_SIZE.get(idx) || 0;
      if (off + size > max[blk]) max[blk] = off + size;
      item = { loc: "fixed", blk, off };
    } else item = idx ? { loc: "var", key: idx } : { loc: "?" };
    map.set(idx, item);
  }
  /* per i campi doppi si tiene quello che compare per ultimo nella mappa */
  const order = new Map();
  for (let o = 0, k = 0; o + 28 <= fm.length; o += 28, k++) order.set(I32(fm, o + 12) & 0xffff, k);
  const pick = (ids) => { let best = null, bk = -1; for (const id of ids) if (map.has(id) && order.get(id) > bk) { best = map.get(id); bk = order.get(id); } return best; };
  const loc = {};
  for (const [k, ids] of Object.entries(F)) loc[k] = pick(ids);
  return { map, max, loc };
}

/* =========================================================================
   Microsoft Project .mpp → programma (stessa forma di readMSPDI)
   ========================================================================= */
export function readMPP(input, opt = {}) {
  const cfb = readCFB(input);
  /* versione: CompObj dice chi l'ha scritto e in che formato */
  const comp = cfb.get("\x01CompObj");
  const compTxt = comp ? new TextDecoder("latin1").decode(comp) : "";
  const fmt = (/MSProject\.(MPP\d+)/.exec(compTxt) || [])[1] || "";
  const app = +((/Microsoft\.Project (\d+)\.\d/.exec(compTxt) || [])[1] || 0);
  if (!fmt && !cfb.has("   114/Props")) {
    if (cfb.has("   1/Props") || cfb.has("   19/Props") || cfb.has("   112/Props")) throw fail("mppOld");
    throw fail("notMpp");
  }
  if (fmt && fmt !== "MPP14") throw fail(/^MPP(8|9|12)$/.test(fmt) ? "mppOld" : "mppUnknown");
  if (!cfb.has("   114/Props") || !cfb.has("   114/TBkndTask/FixedData")) throw fail("mppBroken");

  /* password: con quella di lettura il file è cifrato davvero; con quella di sola
     scrittura alcune tabelle sono solo mascherate (XOR di un byte) */
  const P14 = readProps(cfb.get("Props14"));
  const pw = (P14.get(893386752) || [0])[0] || 0;
  if ((pw & 1) && P14.has(893386756)) throw fail("mppPassword");
  const code = (P14.get(893386759) || [0])[0] || 0, mask = pw ? (code ? 0xff - code : 0) : 0;
  const getX = (p) => { const a = cfb.get(p); if (!a || !mask) return a; const o = new Uint8Array(a.length); for (let k = 0; k < a.length; k++) o[k] = a[k] ^ mask; return o; };
  const PP = readProps(getX("   114/Props"));

  /* ---- progetto ---- */
  const pInt = (k, d = 0) => { const v = PP.get(k); return v && v.length >= 4 ? I32(v, 0) : v && v.length >= 2 ? U16(v, 0) : d; };
  const pStr = (k) => { const v = PP.get(k); return v ? ustr(v, 0) : ""; };
  const pDate = (k) => stamp(PP.get(k), 0);
  const mpd = pInt(37748765, 480) || 480;
  const out = {
    name: summaryTitle(cfb.get("\x05SummaryInformation")) || pStr(37748744) || String(opt.name || "").replace(/\.mpp$/i, ""),
    file: String(opt.name || ""),
    start: pDate(37748738), finish: pDate(37748739),
    statusDate: pDate(37748805), currentDate: null,
    minutesPerDay: mpd, minutesPerWeek: pInt(37748766, mpd * 5) || mpd * 5, daysPerMonth: u16(PP.get(37753743), 0) || 20,
    calendarUID: 1,
    saveVersion: 14,
    currency: pStr(37748752),
    calendars: [],
    fields: [], tasks: [], warnings: [],
    source: { format: "MPP14", app },
  };
  /* la data corrente non sta nel .mpp: Project la rimette a oggi a ogni apertura, all'ora d'inizio predefinita */
  if (opt.today != null) { const t = PP.get(37748764); out.currentDate = opt.today + (t && t.length >= 2 ? Math.round(U16(t, 0) / 10) % 1440 : 480) * 60000; }

  /* ---- calendari ---- */
  const resCals = [];
  out.calendars = readCalendars(cfb, getX, PP, app, { resCals });
  out.source.resourceCalendars = resCals.length;
  const calName = pStr(37748750);
  const pc = out.calendars.find((c) => c.name === calName && c.base < 0) || out.calendars.find((c) => c.name === calName);
  if (pc) out.calendarUID = pc.uid;

  /* ---- attività ---- */
  const { map: fmap, max, loc } = taskFieldMap(PP);
  const T = "   114/TBkndTask/";
  const vd = varData(cfb.get(T + "VarMeta"), cfb.get(T + "Var2Data"));
  const fMeta = fixedMeta(cfb.get(T + "FixedMeta"), 47);
  const fData = fixedData(fMeta, cfb.get(T + "FixedData"), max[0]);
  const f2Meta = fixedMeta(cfb.get(T + "Fixed2Meta"), fixedMetaSizes(fData.items.length, [92, 93, 94, 95, 96]));
  const f2Data = fixedData(f2Meta, cfb.get(T + "Fixed2Data"));
  if (!loc.UID || loc.UID.loc !== "fixed" || !loc.ID) throw fail("mppBroken");

  /* bit nei metadati (MPXJ, per versione di Project) */
  const v2010 = app && app <= 14;
  const BIT = v2010
    ? { milestone: [8, 0x20], active: [8, 0x04], manual: [8, 0x08], flag: (k) => [35, 0x40 << k] }
    : { milestone: [10, 0x02], active: [8, 0x40], manual: [8, 0x80], flag: (k) => (k < 10 ? [24, 0x2 << k] : [33, 0x2 << (k - 10)]) };
  const bit = (m, [o, b]) => !!m && ok(m, o, 1) && (i32(m, o) & b) !== 0;

  /* quale voce dei dati fissi è quale attività (MPXJ createTaskMap): dal fondo,
     perché dei doppioni vale l'ultimo; voci cancellate, righe vuote, voci monche */
  const taskMap = new Map();
  for (let k = fMeta.items.length - 1; k > 2; k--) {
    const d = fData.items[k], d2 = f2Data.items[k];
    if (!d || !d2) continue;
    const flags = i32(fMeta.items[k], 0);
    if (flags & 0x02) { const u = u16(d, 0); if (!taskMap.has(u)) taskMap.set(u, null); continue; }
    if (d.length === 16) { const u = i32(d, 0); if (!taskMap.has(u)) taskMap.set(u, k); continue; }
    if (max[0] && (d.length * 100) / max[0] <= 75) continue;
    const u = i32(d, loc.UID.off);
    if (!taskMap.has(u) || vd.has(u)) if (!taskMap.has(u) || (flags & 0x04) === 0) taskMap.set(u, k);
  }

  const rd = (key, d, d2) => {
    const it = loc[key];
    if (!it) return null;
    if (it.loc === "fixed") return { a: it.blk ? d2 : d, o: it.off };
    if (it.loc === "var") return { v: it.key };
    return null;
  };
  const get = {
    int: (key, uid, d, d2) => { const r = rd(key, d, d2); if (!r) return null; if (r.a !== undefined) return ok(r.a, r.o, 4) ? I32(r.a, r.o) : null; const v = vd.get(uid, r.v); return v && v.length >= 4 ? I32(v, 0) : null; },
    short: (key, uid, d, d2) => { const r = rd(key, d, d2); if (!r) return null; if (r.a !== undefined) return ok(r.a, r.o, 2) ? U16(r.a, r.o) : null; const v = vd.get(uid, r.v); return v && v.length >= 2 ? U16(v, 0) : null; },
    date: (key, uid, d, d2) => { const r = rd(key, d, d2); if (!r) return null; if (r.a !== undefined) return stamp(r.a, r.o); return varDate(vd.get(uid, r.v)); },
    str: (key, uid) => { const r = rd(key); if (!r || r.v === undefined) return null; const v = vd.get(uid, r.v); return v ? ustr(v, 0) : null; },
    /* importo: double in centesimi (MPXJ FieldMap, CURRENCY); il campo assente nella mappa → null */
    cur: (key, uid, d, d2) => { const r = rd(key, d, d2); if (!r) return null; if (r.a !== undefined) return ok(r.a, r.o, 8) ? money(F64(r.a, r.o)) : null; const v = vd.get(uid, r.v); return v && v.length >= 8 ? money(F64(v, 0)) : null; },
  };

  const lists = readValueLists(cfb, app), lost = new Set();
  const recs = [], nulls = [], order = [], byId = new Map();
  const uids = [...taskMap.keys()].sort((a, b) => a - b);
  for (const uid of uids) {
    const k = taskMap.get(uid);
    if (k == null || k < 0 || k >= fData.items.length) continue;
    let d = fData.items[k];
    const meta = fMeta.items[k], meta2 = f2Meta.items[k] || null, d2 = f2Data.items[k];
    if (d.length === 16) { nulls.push({ id: i32(d, 4), uid: i32(d, 0) }); continue; }
    if (d.length < max[0]) { const p = new Uint8Array(max[0] + 8); p.set(d); d = p; }
    const id = get.int("ID", uid, d, d2);
    const prev = byId.get(id);
    if (prev) {
      if (!vd.has(uid)) continue;                      // attività fantasma sullo stesso ID
      if (prev.name == null) { recs.splice(recs.indexOf(prev), 1); byId.delete(id); }
    }
    const manual = bit(meta2, BIT.manual);
    const durU = get.short("DUR_U", uid, d, d2);
    const r = {
      uid, id, k, d, d2, meta, meta2, manual,
      name: get.str("NAME", uid),
      wbs: get.str("WBS", uid),
      level: get.short("LEVEL", uid, d, d2),
      parent: get.int("PARENT", uid, d, d2),
      start: get.date("START", uid, d, d2), finish: get.date("FINISH", uid, d, d2),
      dur: null, durU,
      mdur: get.int("MDUR", uid, d, d2),
      pct: get.short("PCT", uid, d, d2),
      aStart: get.date("ASTART", uid, d, d2), aFinish: get.date("AFINISH", uid, d, d2),
      /* baseline: nei campi del 2010 (1299–1301) o, se lì non c'è, in quelli di prima (43, 44, 27) */
      bStart: get.date("BSTART", uid, d, d2) ?? get.date("BSTART0", uid, d, d2),
      bFinish: get.date("BFINISH", uid, d, d2) ?? get.date("BFINISH0", uid, d, d2),
      bDur: get.int("BDUR", uid, d, d2) ?? get.int("BDUR0", uid, d, d2),
      startSlack: get.int("START_SLACK", uid, d, d2), finishSlack: get.int("FINISH_SLACK", uid, d, d2), totalSlack: get.int("TOTAL_SLACK", uid, d, d2),
      ctype: get.short("CTYPE", uid, d, d2), cdate: get.date("CDATE", uid, d, d2),
      cal: get.int("CAL", uid, d, d2),
      created: get.date("CREATED", uid, d, d2),
      guid: loc.GUID && loc.GUID.loc === "fixed" ? guid(loc.GUID.blk ? d2 : d, loc.GUID.off) : "",
      notes: (() => { const n = loc.NOTES && loc.NOTES.loc === "var" ? vd.get(uid, loc.NOTES.key) : null; return n ? rtfText(astr(n, 0)) : ""; })(),
      milestone: bit(meta, BIT.milestone),
      active: bit(meta2, BIT.active),
      cost: get.cur("COST", uid, d, d2), bCost: get.cur("BCOST", uid, d, d2), aCost: get.cur("ACOST", uid, d, d2), fixedCost: get.cur("FIXED", uid, d, d2),
      pj: { bcws: get.cur("BCWS", uid, d, d2), bcwp: get.cur("BCWP", uid, d, d2), acwp: get.cur("ACWP", uid, d, d2) },
    };
    /* attività automatiche: le date e la durata programmate vincono; manuali: la durata manuale (MPXJ) */
    const ss = get.date("SSTART", uid, d, d2), sf = get.date("SFINISH", uid, d, d2), sd = get.int("SDUR", uid, d, d2);
    if (r.start == null || (!manual && ss != null)) r.start = ss;
    if (r.finish == null || (!manual && sf != null)) r.finish = sf;
    r.dur = sd;
    if (manual && r.mdur != null && r.mdur !== -1) r.dur = r.mdur;
    /* riga senza nome né date: è una riga vuota anche se non lo dice */
    if (r.name == null && (r.start == null || r.finish == null || r.created == null)) { nulls.push({ id: i32(d, 4), uid: i32(d, 0) }); continue; }
    /* campi personalizzati, scritti come nell'XML */
    r.ext = {};
    for (const [idx, [, type]] of CUSTOM) {
      const it = fmap.get(idx);
      if (!it) continue;
      let v = null;
      const miss = () => lost.add(TASK_BASE + idx);
      if (type === "flag") {
        const [o, m] = BIT.flag(customIndex(idx));
        v = ok(meta, o, 1) && (i32(meta, o) & m) ? "1" : null;
      } else if (it.loc === "var") v = customValue(type, vd.get(uid, it.key), lists, miss);
      else if (it.loc === "fixed") v = customValue(type, (it.blk ? d2 : d).subarray(it.off), lists, miss);
      if (v != null && v !== "") r.ext[TASK_BASE + idx] = v;
    }
    recs.push(r);
    byId.set(id, r);
    if (d2 && d2.length >= 24) order.push({ key: new DataView(d2.buffer, d2.byteOffset + 16, 8).getBigInt64(0, true), uid });
    else nulls.push({ id, uid });
  }

  /* gli ID come li mostra Project: dall'ordine scritto nei dati fissi 2, con le righe vuote al loro posto (MPXJ postProcessTasks) */
  const idOf = renumber(order, nulls, recs.some((r) => r.uid === 0));
  for (const r of recs) if (idOf.has(r.uid)) r.id = idOf.get(r.uid);
  recs.sort((a, b) => a.id - b.id);

  /* struttura: livelli, numeri di struttura, riepiloghi */
  const byUid = new Map(recs.map((r) => [r.uid, r]));
  const kidsOf = new Map();
  for (const r of recs) {
    if (r.uid === 0) continue;
    const p = byUid.has(r.parent) && r.parent !== r.uid ? r.parent : 0;
    if (!kidsOf.has(p)) kidsOf.set(p, []);
    kidsOf.get(p).push(r);
  }
  const outline = new Map();
  const number = (p, pre, depth) => {
    if (depth > 100) throw fail("mppBroken");
    (kidsOf.get(p) || []).forEach((r, k) => { const n = pre ? pre + "." + (k + 1) : String(k + 1); outline.set(r.uid, n); number(r.uid, n, depth + 1); });
  };
  number(0, "", 0);
  const autoWbs = !recs.some((r) => r.uid !== 0 && r.wbs);

  /* ---- legami ---- */
  const preds = readLinks(cfb, getX, app);

  /* ---- campi personalizzati: alias dalle Props delle attività ---- */
  const alias = readAliases(readProps(getX(T + "Props")));

  const used = new Map(), manualOf = new Map(recs.map((r) => [r.uid, r.manual]));
  for (const r of recs) {
    if (r.uid === 0) continue;                             // riepilogo del progetto (riga 0)
    if (r.start == null || r.finish == null) { out.warnings.push({ k: "noDates", uid: r.uid, name: (r.name || "").trim() }); continue; }
    const level = r.level ?? (outline.get(r.uid) || "").split(".").length;
    if (level === 0) continue;
    for (const id of Object.keys(r.ext)) used.set(+id, (used.get(+id) || 0) + 1);
    const slack = r.totalSlack != null && loc.TOTAL_SLACK ? r.totalSlack : totalSlack(r);
    out.tasks.push({
      uid: r.uid, id: r.id, guid: r.guid,
      name: (r.name || "").trim(), wbs: (autoWbs ? outline.get(r.uid) : r.wbs || "").trim(), outline: outline.get(r.uid) || "", level,
      summary: kidsOf.has(r.uid), milestone: r.milestone, critical: false,
      active: r.active,
      start: r.start, finish: r.finish,
      dur: r.dur == null ? 0 : r.dur / 10, durFmt: r.durU == null ? 7 : r.durU,
      pct: Math.max(0, Math.min(100, r.pct > 100 ? 0 : r.pct || 0)),
      aStart: r.aStart, aFinish: r.aFinish,
      bStart: r.bStart, bFinish: r.bFinish,
      bDur: r.bStart != null || r.bFinish != null ? (r.bDur == null || r.bDur === -1 ? 0 : r.bDur / 10) : null,
      slack: slack == null ? null : slack / 10,
      ctype: r.ctype > 0 && r.ctype < 8 ? r.ctype : 0, cdate: r.ctype > 1 && r.ctype < 8 ? r.cdate : null,
      calendarUID: r.cal == null ? -1 : r.cal,
      notes: r.notes,
      preds: (preds.get(r.uid) || []).filter((l) => byUid.has(l.uid)),
      ext: r.ext,
      cost: r.cost, bCost: r.bStart != null || r.bFinish != null ? r.bCost : null, aCost: r.aCost, fixedCost: r.fixedCost, pj: r.pj,
    });
  }
  /* ---- risorse e assegnazioni (F7: le voci del contratto e le loro quote) ---- */
  /* il programma si legge anche se queste tabelle no: i costi mancano e lo si dice */
  try {
    out.resources = readResources(cfb, getX, PP, app);
    const known = new Set(out.resources.map((x) => x.uid));
    out.assignments = readAssignments(cfb, getX, PP).filter((a) => byUid.has(a.task) && known.has(a.res));
  } catch (e) {
    out.resources = []; out.assignments = [];
    out.warnings.push({ k: "mppCosts" });
  }
  /* critica (non scritta nel .mpp): come la calcola Project, margine totale entro il
     limite (in giorni nelle Props), attività non finita né al 100 % */
  const lim = pInt(37748756, 0) * mpd;
  for (const t of out.tasks) t.critical = t.slack != null && t.aFinish == null && t.pct !== 100 && t.slack <= lim && !manualOf.get(t.uid);

  for (const [id, n] of used) {
    const [name, type] = CUSTOM.get(id - TASK_BASE) || [String(id), "text"];
    out.fields.push({ id, name, alias: alias.get(id) || "", type, count: n });
  }
  out.fields.sort((a, b) => a.id - b.id);
  /* un valore da tabella di ricerca che non si trova: il campo si dice, non si inventa */
  for (const id of lost) { const [name] = CUSTOM.get(id - TASK_BASE) || [String(id)]; out.warnings.push({ k: "mppLookup", id, name, alias: alias.get(id) || "" }); }
  out.hasBaseline = out.tasks.some((t) => t.bFinish != null);
  out.hasActuals = out.tasks.some((t) => t.aStart != null);
  out.hasCosts = out.tasks.some((t) => t.cost) || out.assignments.some((a) => a.cost);
  if (!out.tasks.length) throw fail("noTasks");
  /* coerenza: un lettore ricostruito non deve sbagliare in silenzio */
  const bad = out.tasks.filter((t) => t.finish < t.start || (t.level > 1 && !t.outline.includes("."))).length;
  if (bad > Math.max(2, out.tasks.length * 0.05)) throw fail("mppBroken");
  return out;
}

const customIndex = (idx) => { const k = [72, 73, 74, 75, 76, 77, 78, 79, 80, 81].indexOf(idx); return k >= 0 ? k : 10 + (idx - 292); };
const isList = (v) => v.length >= 2 && (U16(v, 0) === 0x0701 || U16(v, 0) === 0x0401);
/* valore di un campo personalizzato, nella forma dell'XML (seq-io fieldValue).
   Un campo con tabella di ricerca punta a una voce di TBkndOutlCode (MPXJ VarDataFieldReader) */
function customValue(type, v, lists, miss) {
  if (!v || !v.length) return null;
  if (isList(v)) {
    if (v.length === 4) { const ms = day(v, 2); return type === "date" && ms != null ? isoDate(ms) : null; }
    const id = i32(v, 2), g = guid(v, 6);
    const item = (id !== -1 && lists.byId.get(id)) || (g && lists.byGuid.get(g));
    if (!item) { miss(); return null; }
    v = item.v;
    if (type === "text") return ustr(v, 0);
  }
  if (type === "text") return ustr(v, 0);
  if (type === "date") { if (v.length === 512) return null; const ms = stamp(v, 0); return ms == null ? null : isoDate(ms); }
  if (type === "dur") { if (v.length < 4 || v.length === 512) return null; const t = I32(v, 0); return t === -1 || t === 0 ? null : isoDur(t); }
  if (type === "cost" || type === "num") { if (v.length < 8) return null; const x = F64(v, 0); if (type === "cost" && Math.abs(x) < 0.1) return null; return x === 0 && type === "num" ? null : numStr(x); }
  return null;
}
/* le voci delle tabelle di ricerca (MPXJ CustomFieldValueReader14): UID → byte del valore */
function readValueLists(cfb, app) {
  const D = "   114/TBkndOutlCode/", byId = new Map(), byGuid = new Map();
  if (!cfb.has(D + "FixedMeta") || !cfb.has(D + "VarMeta")) return { byId, byGuid };
  const vd = varData(cfb.get(D + "VarMeta"), cfb.get(D + "Var2Data"));
  const fd = fixedData(fixedMeta(cfb.get(D + "FixedMeta"), 10), cfb.get(D + "FixedData"));
  const fd2 = cfb.has(D + "Fixed2Meta") ? fixedData(fixedMeta(cfb.get(D + "Fixed2Meta"), 10), cfb.get(D + "Fixed2Data")) : { items: [] };
  fd.items.forEach((d, k) => {
    if (!d) return;
    const id = u16(d, 4), v = vd.has(id) ? vd.get(id, 22) : null;
    if (!v) return;
    const item = { v, type: u16(fd2.items[k], app > 14 ? 16 : 32) };
    byId.set(id, item);
    const g = guid(fd2.items[k], 0);
    if (g) byGuid.set(g, item);
  });
  return { byId, byGuid };
}
function varDate(v) {
  if (!v || v.length < 4 || v.length === 512) return null;
  const flag = U16(v, 0);
  if ((flag === 0x0701 || flag === 0x0401) && v.length === 4) return null;
  return stamp(v, 0);
}
/* margine totale (non scritto nel .mpp): il minore fra margine d'inizio e di fine;
   iniziata l'attività conta solo quello di fine. Collaudato contro l'XML (§10) */
function totalSlack(r) {
  if (r.startSlack == null || r.finishSlack == null) return r.finishSlack ?? r.startSlack ?? null;
  if (r.aStart != null) return r.finishSlack;
  return Math.min(r.startSlack, r.finishSlack);
}

/* MPXJ postProcessTasks: ID dall'ordine nei dati fissi 2, righe vuote inserite al loro ID */
function renumber(order, nulls, hasZero) {
  order.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  nulls.sort((a, b) => a.id - b.id);
  const nullSeen = new Map();
  for (const n of nulls) if (!nullSeen.has(n.id)) nullSeen.set(n.id, n.uid);
  const inc = (Math.floor(nullSeen.size / 1000) + 1) * 2000;
  const slots = new Map();
  let next = hasZero ? 0 : inc;
  for (const o of order) { slots.set(next, o.uid); next += inc; }
  let ins = 0;
  const offs = new Map();
  for (const [id, uid] of nullSeen) {
    const base = (id - ins) * inc;
    let target = base, off = offs.has(base) ? offs.get(base) + 1 : 0;
    ins++;
    while (slots.has(target)) { off++; if (off === inc) throw fail("mppBroken"); target = base - (inc - off); }
    offs.set(base, off);
    slots.set(target, uid);
  }
  const out = new Map();
  let id = hasZero ? 0 : 1;
  for (const k of [...slots.keys()].sort((a, b) => a - b)) out.set(slots.get(k), id++);
  return out;
}

/* legami: TBkndCons, 20 byte per legame (MPXJ ConstraintFactory) */
function readLinks(cfb, getX, app) {
  const C = "   114/TBkndCons/", res = new Map();
  if (!cfb.has(C + "FixedMeta")) return res;
  const meta = fixedMeta(cfb.get(C + "FixedMeta"), 10);
  const data = fixedDataSized(meta, 20, getX(C + "FixedData"));
  const p15 = app > 14, unitsAt = p15 ? 18 : 14, durAt = p15 ? 14 : 16;
  const TYPE = { 0: "FF", 1: "FS", 2: "SF", 3: "SS" };
  const seen = new Set();
  for (let k = 0; k < meta.count && k < meta.items.length; k++) {
    const m = meta.items[k];
    if (U16(m, 0) !== 0) continue;
    const idx = data.offs.indexOf(I32(m, 4));
    if (idx < 0) continue;
    const d = data.items[idx];
    if (!d || d.length < 14) continue;
    const id = I32(d, 0), from = I32(d, 4), to = I32(d, 8);
    if (!from || !to || from === to || seen.has(id)) continue;
    seen.add(id);
    const units = u16(d, unitsAt) & 0x1f, lag = i32(d, durAt);
    if (!res.has(to)) res.set(to, []);
    res.get(to).push({ uid: from, type: TYPE[U16(d, 12)] || "FS", lag: lag / 10, lagFmt: units || 7 });
  }
  return res;
}

/* =========================================================================
   Risorse e assegnazioni (F7): MPXJ MPP14Reader processResourceData,
   ResourceAssignmentFactory. Mappa dei campi nelle Props come per le attività
   ========================================================================= */
/* dimensione nei dati fissi per categoria della mappa (commenti di MPXJ FieldMap) */
const CAT_SIZE = { 0x02: 2, 0x03: 4, 0x05: 8, 0x13: 4, 0x48: 16, 0x65: 8, 0x66: 8 };
function fieldMapOf(fm, base) {
  const map = new Map(), max = [0, 0];
  if (!fm) return { map, max };
  let last = 0, blk = 0;
  for (let o = 0; o + 28 <= fm.length; o += 28) {
    const type = I32(fm, o + 12) >>> 0, off = U16(fm, o + 4), cat = U16(fm, o + 20), idx = type & 0xffff;
    if ((type & 0xffff0000) >>> 0 !== base) continue;
    let item;
    if (cat === 0x0b || cat === 0x64) item = { loc: "meta" };
    else if (off !== 65535) {
      if (off < last) blk++;
      last = off;
      if (blk > 1) break;
      const size = CAT_SIZE[cat] || 4;
      if (off + size > max[blk]) max[blk] = off + size;
      item = { loc: "fixed", blk, off };
    } else item = idx ? { loc: "var", key: idx } : { loc: "?" };
    map.set(idx, item);
  }
  return { map, max };
}
/* lettore di un campo da una voce (dati fissi 1 e 2, dati variabili) */
const reader = (map, vd) => (idx, uid, d, d2, kind) => {
  const it = map.get(idx);
  if (!it || (it.loc !== "fixed" && it.loc !== "var")) return null;
  const a = it.loc === "fixed" ? (it.blk ? d2 : d) : vd.get(uid, it.key), o = it.loc === "fixed" ? it.off : 0;
  if (kind === "str") return it.loc === "var" && a ? ustr(a, 0) : null;
  if (kind === "int") return ok(a, o, 4) ? I32(a, o) : null;
  if (kind === "short") return ok(a, o, 2) ? U16(a, o) : null;
  return ok(a, o, 8) ? F64(a, o) : null;                       // double
};
const RSC_BASE = 0x0c400000, ASN_BASE = 0x0f400000;
function readResources(cfb, getX, PP, app) {
  const D = "   114/TBkndRsc/", out = [];
  if (!cfb.has(D + "FixedMeta") || !cfb.has(D + "FixedData")) return out;
  const { map, max } = fieldMapOf(PP.get(131093) || PP.get(50331669), RSC_BASE);
  /* MPXJ ResourceField: ID 0, NAME 1, STANDARD_RATE 6, UNIQUE_ID 27, MATERIAL_LABEL 299 (il COST 12 nel
     .mpp vero è la tariffa, non il totale: il totale si fa dalle assegnazioni) */
  const uidAt = map.get(27);
  if (!uidAt || uidAt.loc !== "fixed") return out;
  const vd = varData(cfb.get(D + "VarMeta"), cfb.get(D + "Var2Data"));
  const fMeta = fixedMeta(cfb.get(D + "FixedMeta"), 37);
  const fData = fixedData(fMeta, getX(D + "FixedData"));
  const f2Meta = cfb.has(D + "Fixed2Meta") ? fixedMeta(cfb.get(D + "Fixed2Meta"), fixedMetaSizes(fData.items.length, [50, 51])) : { items: [] };
  const f2Data = cfb.has(D + "Fixed2Data") ? fixedData(f2Meta, getX(D + "Fixed2Data")) : { items: [] };
  /* quale voce è quale risorsa (MPXJ createResourceMap): voci intere, la prima vince */
  const where = new Map();
  fData.items.forEach((d, k) => { if (d && d.length >= max[0]) { const u = U16(d, uidAt.off); if (!where.has(u)) where.set(u, k); } });
  const get = reader(map, vd);
  const late = app > 14;
  for (const uid of [...vd.table.keys()].sort((a, b) => a - b)) {
    const k = where.get(uid);
    if (k == null || uid <= 0) continue;
    const d = fData.items[k], d2 = f2Data.items[k] || null, m = fMeta.items[k], m2 = f2Meta.items[k] || null;
    const work = late ? !!m && ok(m, 12, 1) && (m[12] & 0x10) !== 0 : !!m && ok(m, 9, 1) && (m[9] & 0x02) !== 0;
    const isCost = !work && !!m2 && ok(m2, 8, 1) && (m2[8] & 0x10) !== 0;
    const rate = get(6, uid, d, d2);
    out.push({
      uid, id: get(0, uid, d, d2, "int") ?? 0, name: (get(1, uid, d, d2, "str") || "").trim(),
      type: work ? "work" : isCost ? "cost" : "material",
      rate: rate == null ? 0 : rate, label: (get(299, uid, d, d2, "str") || "").trim(),
      budget: !!m2 && ok(m2, 8, 1) && (m2[8] & (late ? 0x40 : 0x20)) !== 0,
    });
  }
  return out;
}
function readAssignments(cfb, getX, PP) {
  const D = "   114/TBkndAssn/", out = [];
  if (!cfb.has(D + "FixedMeta") || !cfb.has(D + "FixedData")) return out;
  const { map, max } = fieldMapOf(PP.get(131095) || PP.get(50331671), ASN_BASE);
  /* MPXJ AssignmentField: UNIQUE_ID 0, TASK_UNIQUE_ID 1, RESOURCE_UNIQUE_ID 2, ASSIGNMENT_UNITS 7, COST 26, ACTUAL_COST 28, BASELINE_COST 32 */
  const at = (i) => { const it = map.get(i); return it && it.loc === "fixed" && !it.blk ? it.off : -1; };
  const oU = at(0), oT = at(1), oR = at(2);
  if (oU < 0 || oT < 0 || oR < 0) return out;
  const vd = varData(cfb.get(D + "VarMeta"), cfb.get(D + "Var2Data"));
  const meta = fixedMeta(cfb.get(D + "FixedMeta"), 34);
  /* i dati fissi delle assegnazioni a voci di dimensione nota: 110 e 48 byte (MPXJ) */
  const raw = getX(D + "FixedData"), raw2 = cfb.has(D + "Fixed2Data") ? getX(D + "Fixed2Data") : null;
  const get = reader(map, vd), seen = new Set();
  for (let k = 0; k < meta.count && k < meta.items.length; k++) {
    const m = meta.items[k];
    if (m[0] !== 0) continue;
    const off = I32(m, 4);
    if (off < 0 || off % 110 || off + 110 > raw.length) continue;
    let d = raw.subarray(off, off + 110);
    if (d.length < max[0]) { const p = new Uint8Array(max[0]); p.set(d); d = p; }
    const n = off / 110, d2 = raw2 && (n + 1) * 48 <= raw2.length ? raw2.subarray(n * 48, (n + 1) * 48) : null;
    const uid = I32(d, oU);
    if (!vd.has(uid)) continue;
    const task = I32(d, oT), res = I32(d, oR), key = task + ":" + res;
    if (res === -65535 || seen.has(key)) continue;           // nessuna risorsa; la stessa risorsa due volte
    seen.add(key);
    const cur = (i) => { const v = get(i, uid, d, d2); return v == null ? null : money(v); };
    /* le unità in MPXJ sono percentuali (85 = 85 %), nell'XML frazioni (0,85) */
    out.push({ uid, task, res, units: (cur(7) ?? 0) / 100, cost: cur(26), aCost: cur(28), bCost: cur(32) });
  }
  return out;
}

/* alias dei campi personalizzati (MPXJ CustomFieldReader14) */
function readAliases(props) {
  const res = new Map(), a = props.get(71303169);
  if (!a || a.length < 12) return res;
  const size = I32(a, 0), n = I32(a, 8);
  for (let k = 0, o = 12; k < n && o + 8 <= Math.min(size, a.length); k++, o += 8) {
    const id = I32(a, o) >>> 0, at = I32(a, o + 4) + 4;
    if (at < a.length) { const s = ustr(a, at); if (s) res.set(id, s); }
  }
  return res;
}

/* calendari: TBkndCal (MPXJ MPP14CalendarFactory) → { uid, name, base, week[7], exc[] } come readMSPDI */
function readCalendars(cfb, getX, PP, app, opt = {}) {
  const D = "   114/TBkndCal/", out = [];
  if (!cfb.has(D + "FixedMeta")) return out;
  const vd = varData(cfb.get(D + "VarMeta"), cfb.get(D + "Var2Data"));
  const meta = fixedMeta(cfb.get(D + "FixedMeta"), 10);
  const data = fixedData(meta, getX(D + "FixedData"), 12);
  /* Project 2013 e successivi: ID del calendario a +8, base a +0 (MPXJ) */
  const idAt = app > 14 ? 8 : 0, baseAt = app > 14 ? 0 : 4, resAt = app > 14 ? 4 : 8;
  /* settimana di riserva: le ore predefinite del progetto, altrimenti lunedì–venerdì */
  const defData = PP.get(37753736) || null, defWeek = [false, true, true, true, true, true, false];
  if (defData) calHours(defData, { week: defWeek }, true, [false, true, true, true, true, true, false]);
  const seen = new Set();
  for (const d of data.items) {
    if (!d || d.length < 8) continue;
    for (let o = 0; o + 12 <= d.length; o += 12) {
      const uid = I32(d, o + idAt), base = I32(d, o + baseAt), res = I32(d, o + resAt);
      if (uid <= 0 || seen.has(uid)) continue;
      seen.add(uid);
      const isBase = base <= 0 || base === uid;
      /* i calendari delle risorse non servono al 4D (§3 bis: niente risorse) */
      if (res > 0 || (res === 0 && !isBase)) { (opt.resCals || []).push(uid); continue; }
      const cal = { uid, name: ustr(vd.get(uid, 1) || new Uint8Array(0), 0), base: isBase ? -1 : base, week: [null, null, null, null, null, null, null], exc: [] };
      const v = vd.get(uid, 8) || (isBase ? defData : null);
      if (v) { calHours(v, cal, isBase, defWeek); calExceptions(v, cal); }
      else if (isBase) cal.week = defWeek.slice();
      out.push(cal);
    }
  }
  /* un calendario derivato senza base valida si scarta, come in MPXJ */
  const ok = new Set(out.filter((c) => c.base < 0 && c.name).map((c) => c.uid));
  return out.filter((c) => c.base < 0 || ok.has(c.base));
}
/* settimana: 7 blocchi da 60 byte, domenica prima; 1 = come il calendario base */
function calHours(v, cal, isBase, defWeek) {
  for (let k = 0; k < 7; k++) {
    const o = 60 * k, def = ok(v, o, 2) ? U16(v, o) : 1;
    if (def === 1) { if (isBase) cal.week[k] = defWeek[k]; continue; }
    cal.week[k] = u16(v, o + 2) > 0;
  }
}
/* eccezioni: dopo i 420 byte della settimana, 92 byte + nome per eccezione */
function calExceptions(v, cal) {
  if (v.length <= 420) return;
  let o = 420;
  const n = U16(v, o);
  o += 4;
  for (let k = 0; k < n; k++) {
    if (o + 92 > v.length) break;
    const from = day(v, o), to = day(v, o + 2), periods = U16(v, o + 14);
    let nl = I32(v, o + 88);
    if (nl < 0) return;
    if (nl % 4) nl = (Math.floor(nl / 4) + 1) * 4;
    const name = nl ? ustr(v, o + 92) : "";
    if (from != null && to != null) cal.exc.push({ from, to, working: periods > 0, name });
    o += 92 + nl;
  }
}
/* titolo dal SummaryInformation (proprietà 2, stringa) */
function summaryTitle(a) {
  if (!a || a.length < 48) return "";
  try {
    const off = I32(a, 44);
    if (off <= 0 || off + 8 > a.length) return "";
    const n = I32(a, off + 4);
    let codepage = 1252, title = null;
    for (let k = 0; k < n && off + 8 + k * 8 + 8 <= a.length; k++) {
      const id = I32(a, off + 8 + k * 8), po = off + I32(a, off + 12 + k * 8);
      if (id === 1 && ok(a, po, 6)) codepage = U16(a, po + 4);
      if (id === 2) title = po;
    }
    if (title == null || !ok(a, title, 8)) return "";
    const type = I32(a, title), len = I32(a, title + 4);
    if (type === 0x1f) return UTF16.decode(a.subarray(title + 8, title + 8 + len * 2)).replace(/\0+$/, "").trim();
    if (type !== 0x1e || !ok(a, title + 8, len)) return "";
    const bytes = a.subarray(title + 8, title + 8 + len);
    const s = codepage === 1200 ? UTF16.decode(bytes) : codepage === 65001 ? new TextDecoder("utf-8").decode(bytes) : new TextDecoder("windows-1252").decode(bytes);
    return s.replace(/\0+$/, "").trim();
  } catch { return ""; }
}

/* che cosa c'è nel contenitore (per i messaggi): versione e formato */
export function sniffMPP(input) {
  try {
    const cfb = readCFB(input), comp = cfb.get("\x01CompObj");
    const s = comp ? new TextDecoder("latin1").decode(comp) : "";
    return { app: (/Microsoft\.Project [\d.]+/.exec(s) || [""])[0], format: (/MSProject\.MPP\d+/.exec(s) || [""])[0].replace("MSProject.", "") };
  } catch (e) { return { error: e.code || "notOle" }; }
}

/* ============================================================================
   E57 point-cloud parser — puro, senza dipendenze (browser + Node).
   Studio import PointCloud (branch study/pointcloud-import).

   E57 = ASTM E2807. Struttura:
     - header 48 byte (firma "ASTM-E57", versioni, offset/len XML, pageSize)
     - il file è IMPAGINATO: ogni pagina di pageSize byte (di norma 1024) ha gli
       ultimi 4 byte di CRC. Per leggere dati "logici" bisogna SALTARE quei 4
       byte a ogni confine di pagina. Il CRC NON viene verificato (non serve per
       leggere) → nessuna implementazione CRC-32C richiesta.
     - sezione XML (in coda) che descrive i Data3D (scansioni): ogni scansione ha
       un CompressedVector `points` con un `prototype` (campi: cartesianX/Y/Z,
       colorRed/Green/Blue, intensity, …), una `pose` (quaternione+traslazione)
       e opzionali `cartesianBounds`.
     - sezioni binarie CompressedVector: pacchetti dati con un bytestream per
       campo del prototype, codificati bit-pack (interi) o IEEE754 (float).

   Le coordinate globali E57 (dopo pose) sono trattate come mappa E,N,H come nel
   LAS: ribasate su worldOriginMap + swizzle Z-up→Y-up, catena invariante intatta.

   API (speculare a las.js):
     parseE57Header(arrayBuffer) -> { versionMajor, versionMinor, xmlOffset, xmlLength, pageSize }
     parseE57(arrayBuffer, opts) -> { position, color, count, subsampled, pointCount, worldBounds, scanCount, hasColor }
   opts: { origin:{x,y,z}, swizzle:true, maxPoints:Infinity }
============================================================================ */

/* ---- lettore che salta i 4 byte di CRC a ogni pagina ---- */
class PagedReader {
  constructor(buffer, pageSize) {
    this.u8 = buffer.buffer ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer);
    this.pageSize = pageSize || 1024;
    this.dpp = this.pageSize - 4;   // data-per-page (byte utili prima del CRC)
  }
  physicalToLogical(p) { const page = Math.floor(p / this.pageSize); return page * this.dpp + (p % this.pageSize); }
  /* copia `len` byte LOGICI a partire dall'offset logico dato, saltando i CRC */
  readLogical(logicalStart, len) {
    const out = new Uint8Array(len);
    let done = 0, l = logicalStart;
    while (done < len) {
      const page = Math.floor(l / this.dpp), off = l % this.dpp;
      const phys = page * this.pageSize + off;
      const run = Math.min(this.dpp - off, len - done);
      out.set(this.u8.subarray(phys, phys + run), done);
      done += run; l += run;
    }
    return out;
  }
  readLogicalFromPhysical(physicalStart, len) { return this.readLogical(this.physicalToLogical(physicalStart), len); }
}

/* ---- mini-parser XML (sufficiente per E57: elementi, attributi, testo, CDATA) ---- */
function parseXML(str) {
  let i = 0;
  const n = str.length;
  function skipWs() { while (i < n && /\s/.test(str[i])) i++; }
  function parseNode() {
    // salta dichiarazioni/commenti/PI
    while (i < n) {
      if (str.startsWith("<?", i)) { i = str.indexOf("?>", i) + 2; skipWs(); continue; }
      if (str.startsWith("<!--", i)) { i = str.indexOf("-->", i) + 3; skipWs(); continue; }
      if (str.startsWith("<!", i)) { i = str.indexOf(">", i) + 1; skipWs(); continue; }
      break;
    }
    if (str[i] !== "<") return null;
    i++; // '<'
    let name = "";
    while (i < n && !/[\s/>]/.test(str[i])) name += str[i++];
    const node = { name, attrs: {}, children: [], text: "" };
    // attributi
    while (i < n) {
      skipWs();
      if (str[i] === "/" || str[i] === ">") break;
      let an = "";
      while (i < n && !/[\s=/>]/.test(str[i])) an += str[i++];
      skipWs();
      if (str[i] === "=") {
        i++; skipWs();
        const q = str[i++]; let av = "";
        while (i < n && str[i] !== q) av += str[i++];
        i++; // chiusura quote
        node.attrs[an] = av;
      } else if (an) node.attrs[an] = "";
    }
    if (str[i] === "/") { i += 2; return node; }   // self-closing '/>'
    i++; // '>'
    // contenuto
    while (i < n) {
      if (str.startsWith("<![CDATA[", i)) { const end = str.indexOf("]]>", i); node.text += str.slice(i + 9, end); i = end + 3; continue; }
      if (str.startsWith("<!--", i)) { i = str.indexOf("-->", i) + 3; continue; }
      if (str.startsWith("</", i)) { i = str.indexOf(">", i) + 1; break; }   // chiusura tag
      if (str[i] === "<") { const child = parseNode(); if (child) node.children.push(child); continue; }
      node.text += str[i++];
    }
    node.text = node.text.trim();
    return node;
  }
  skipWs();
  return parseNode();
}
function xmlChild(node, name) { return node && node.children.find(c => c.name === name) || null; }
function xmlNum(node, name, dflt) { const c = xmlChild(node, name); return c ? Number(c.text) : (dflt || 0); }

/* ---- header ---- */
function parseE57Header(buffer) {
  const u8 = buffer.buffer ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const sig = String.fromCharCode(...u8.subarray(0, 8));
  if (sig !== "ASTM-E57") throw new Error("Non è un file E57 (firma 'ASTM-E57' assente).");
  return {
    versionMajor: dv.getUint32(8, true),
    versionMinor: dv.getUint32(12, true),
    filePhysicalLength: Number(dv.getBigUint64(16, true)),
    xmlOffset: Number(dv.getBigUint64(24, true)),
    xmlLength: Number(dv.getBigUint64(32, true)),
    pageSize: Number(dv.getBigUint64(40, true)) || 1024,
  };
}

/* ---- prototype: campi in ordine di documento ---- */
function _readPrototype(protoNode) {
  const fields = [];
  for (const c of protoNode.children) {
    const t = c.attrs.type;
    const f = { name: c.name, type: t };
    if (t === "Float") {
      f.bytes = (c.attrs.precision === "single") ? 4 : 8;
    } else if (t === "Integer" || t === "ScaledInteger") {
      f.min = c.attrs.minimum != null ? Number(c.attrs.minimum) : 0;
      f.max = c.attrs.maximum != null ? Number(c.attrs.maximum) : 0;
      f.scale = c.attrs.scale != null ? Number(c.attrs.scale) : 1;
      f.offset = c.attrs.offset != null ? Number(c.attrs.offset) : 0;
      const range = f.max - f.min;
      f.bits = range > 0 ? Math.ceil(Math.log2(range + 1)) : 0;
    }
    fields.push(f);
  }
  return fields;
}

/* ---- decodifica di un intero bit-packed (LSB-first), bits fino a ~53 ---- */
function _decodeIntField(bytes, count, bits, out) {
  if (bits === 0) { for (let i = 0; i < count; i++) out[i] = 0; return; }
  if (bits === 8) { for (let i = 0; i < count; i++) out[i] = bytes[i]; return; }
  if (bits === 16) { for (let i = 0; i < count; i++) out[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8); return; }
  let bitPos = 0;
  for (let i = 0; i < count; i++) {
    let v = 0, mult = 1;
    for (let b = 0; b < bits; b++) {
      const bytePos = bitPos >> 3, bit = bitPos & 7;
      v += ((bytes[bytePos] >> bit) & 1) * mult;
      mult *= 2; bitPos++;
    }
    out[i] = v;
  }
}

/* ---- legge la sezione CompressedVector: bytestream per campo, concatenati sui pacchetti ----
   Terminazione deterministica: per ogni campo sappiamo quanti byte servono a contenere
   recordCount valori (float → rc×bytes, intero → ceil(rc×bits/8)); leggiamo pacchetti dati
   finché OGNI campo è coperto, restando dentro la lunghezza logica della sezione. */
function _readCompressedVector(reader, fileOffset, fields, recordCount) {
  const fieldCount = fields.length;
  const sh = reader.readLogicalFromPhysical(fileOffset, 32);
  const shdv = new DataView(sh.buffer, sh.byteOffset, sh.byteLength);
  const sectionId = shdv.getUint8(0);
  if (sectionId !== 1) throw new Error("Sezione CompressedVector attesa (id 1), trovato " + sectionId);
  const sectionLogicalLength = Number(shdv.getBigUint64(8, true));
  const dataPhysicalOffset = Number(shdv.getBigUint64(16, true));

  const need = fields.map(f => f.type === "Float" ? recordCount * f.bytes : Math.ceil(recordCount * f.bits / 8));
  const have = new Array(fieldCount).fill(0);
  const chunks = Array.from({ length: fieldCount }, () => []);

  const sectionEndLogical = reader.physicalToLogical(fileOffset) + sectionLogicalLength;
  let logical = reader.physicalToLogical(dataPhysicalOffset);

  while (logical + 6 <= sectionEndLogical) {
    const hdr = reader.readLogical(logical, 6);
    const packetType = hdr[0];
    const packetLength = (hdr[2] | (hdr[3] << 8)) + 1;      // lunghezza logica del pacchetto
    if (packetType === 1) {                                  // data packet
      const bsCount = hdr[4] | (hdr[5] << 8);
      const lensRaw = reader.readLogical(logical + 6, bsCount * 2);
      const lens = []; let sum = 0;
      for (let k = 0; k < bsCount; k++) { const L = lensRaw[k * 2] | (lensRaw[k * 2 + 1] << 8); lens.push(L); sum += L; }
      const buffers = reader.readLogical(logical + 6 + bsCount * 2, sum);
      let off = 0;
      for (let k = 0; k < bsCount && k < fieldCount; k++) {
        chunks[k].push(buffers.subarray(off, off + lens[k]));
        have[k] += lens[k];
        off += lens[k];
      }
    } else if (packetType !== 0 && packetType !== 2) {
      break; // tipo sconosciuto → stop difensivo (0=index, 2=empty vengono saltati)
    }
    logical += packetLength;
    let done = true;
    for (let k = 0; k < fieldCount; k++) if (have[k] < need[k]) { done = false; break; }
    if (done) break;
  }

  const perField = [];
  for (let k = 0; k < fieldCount; k++) {
    const buf = new Uint8Array(have[k]);
    let o = 0; for (const c of chunks[k]) { buf.set(c, o); o += c.length; }
    perField.push(buf);
  }
  return perField;
}

function parseE57(buffer, opts) {
  opts = opts || {};
  const swizzle = opts.swizzle !== false;
  const maxPoints = opts.maxPoints || Infinity;
  const O = opts.origin || { x: 0, y: 0, z: 0 };

  const header = parseE57Header(buffer);
  const reader = new PagedReader(buffer, header.pageSize);
  const xmlBytes = reader.readLogicalFromPhysical(header.xmlOffset, header.xmlLength);
  const xmlStr = new TextDecoder("utf-8").decode(xmlBytes);
  const root = parseXML(xmlStr);
  if (!root) throw new Error("XML E57 non interpretabile.");

  const data3D = xmlChild(root, "data3D");
  const scans = data3D ? data3D.children.filter(c => c.attrs.type === "Structure" || c.name === "vectorChild") : [];
  if (!scans.length) throw new Error("Nessuna scansione (data3D) nel file E57.");

  // pianifica: leggi prototype/recordCount di ogni scansione, somma i punti
  const plan = [];
  let totalPoints = 0;
  for (const scan of scans) {
    const points = xmlChild(scan, "points");
    if (!points) continue;
    const fileOffset = Number(points.attrs.fileOffset);
    const recordCount = Number(points.attrs.recordCount);
    const proto = xmlChild(points, "prototype");
    if (!proto || !recordCount) continue;
    const fields = _readPrototype(proto);
    const idx = {
      x: fields.findIndex(f => f.name === "cartesianX"),
      y: fields.findIndex(f => f.name === "cartesianY"),
      z: fields.findIndex(f => f.name === "cartesianZ"),
      r: fields.findIndex(f => f.name === "colorRed"),
      g: fields.findIndex(f => f.name === "colorGreen"),
      b: fields.findIndex(f => f.name === "colorBlue"),
    };
    // pose
    let pose = null;
    const poseNode = xmlChild(scan, "pose");
    if (poseNode) {
      const rot = xmlChild(poseNode, "rotation"), tr = xmlChild(poseNode, "translation");
      pose = {
        w: rot ? xmlNum(rot, "w", 1) : 1, x: rot ? xmlNum(rot, "x", 0) : 0,
        y: rot ? xmlNum(rot, "y", 0) : 0, z: rot ? xmlNum(rot, "z", 0) : 0,
        tx: tr ? xmlNum(tr, "x", 0) : 0, ty: tr ? xmlNum(tr, "y", 0) : 0, tz: tr ? xmlNum(tr, "z", 0) : 0,
      };
    }
    plan.push({ fileOffset, recordCount, fields, idx, pose });
    totalPoints += recordCount;
  }
  if (!totalPoints) throw new Error("Scansioni E57 prive di punti cartesiani.");

  const hasColor = plan.some(p => p.idx.r >= 0 && p.idx.g >= 0 && p.idx.b >= 0);
  const step = totalPoints > maxPoints ? Math.ceil(totalPoints / maxPoints) : 1;
  const outCap = Math.ceil(totalPoints / step);
  const position = new Float32Array(outCap * 3);
  const color = hasColor ? new Uint8Array(outCap * 3) : null;

  let w = 0, gi = 0;   // gi = indice globale del punto (per lo step)
  let wminx = Infinity, wminy = Infinity, wminz = Infinity, wmaxx = -Infinity, wmaxy = -Infinity, wmaxz = -Infinity;
  /* se il viewer passa un'origine (worldOriginMap già fissata) la uso; altrimenti la
     derivo dal 1° punto e la restituisco, così il viewer può fissare worldOriginMap. */
  const hasOrigin = opts.origin != null;
  let Ox = hasOrigin ? O.x : 0, Oy = hasOrigin ? O.y : 0, Oz = hasOrigin ? O.z : 0;
  let originSet = hasOrigin;

  for (const sc of plan) {
    const per = _readCompressedVector(reader, sc.fileOffset, sc.fields, sc.recordCount);
    const rc = sc.recordCount;
    // decodifica per campo → array numerici
    const decoded = sc.fields.map((f, k) => {
      const buf = per[k];
      if (f.type === "Float") {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const arr = new Float64Array(rc);
        for (let i = 0; i < rc; i++) arr[i] = f.bytes === 4 ? dv.getFloat32(i * 4, true) : dv.getFloat64(i * 8, true);
        return arr;
      } else { // Integer / ScaledInteger
        const raw = new Float64Array(rc);
        _decodeIntField(buf, rc, f.bits, raw);
        if (f.type === "ScaledInteger") { for (let i = 0; i < rc; i++) raw[i] = (raw[i] + f.min) * f.scale + f.offset; }
        else { for (let i = 0; i < rc; i++) raw[i] = raw[i] + f.min; }
        return raw;
      }
    });
    const X = decoded[sc.idx.x], Y = decoded[sc.idx.y], Z = decoded[sc.idx.z];
    const R = sc.idx.r >= 0 ? decoded[sc.idx.r] : null;
    const G = sc.idx.g >= 0 ? decoded[sc.idx.g] : null;
    const B = sc.idx.b >= 0 ? decoded[sc.idx.b] : null;
    const p = sc.pose;

    for (let i = 0; i < rc; i++, gi++) {
      if (gi % step !== 0) continue;
      let vx = X[i], vy = Y[i], vz = Z[i];
      if (p) {   // ruota per quaternione poi trasla: v' = R·v + T
        const tx = 2 * (p.y * vz - p.z * vy), ty = 2 * (p.z * vx - p.x * vz), tz = 2 * (p.x * vy - p.y * vx);
        const gx = vx + p.w * tx + (p.y * tz - p.z * ty);
        const gy = vy + p.w * ty + (p.z * tx - p.x * tz);
        const gz = vz + p.w * tz + (p.x * ty - p.y * tx);
        vx = gx + p.tx; vy = gy + p.ty; vz = gz + p.tz;
      }
      // coord globali (E,N,H). Fissa l'origine dal 1° punto se non nota.
      if (!originSet) { Ox = Math.round(vx); Oy = Math.round(vy); Oz = Math.round(vz); originSet = true; }
      const rx = vx - Ox, ry = vy - Oy, rz = vz - Oz;
      const o3 = w * 3;
      const wx = rx, wy = swizzle ? rz : ry, wz = swizzle ? -ry : rz;
      position[o3] = wx; position[o3 + 1] = wy; position[o3 + 2] = wz;
      if (wx < wminx) wminx = wx; if (wx > wmaxx) wmaxx = wx;
      if (wy < wminy) wminy = wy; if (wy > wmaxy) wmaxy = wy;
      if (wz < wminz) wminz = wz; if (wz > wmaxz) wmaxz = wz;
      if (color) { color[o3] = (R ? R[i] : 180) & 0xff; color[o3 + 1] = (G ? G[i] : 180) & 0xff; color[o3 + 2] = (B ? B[i] : 180) & 0xff; }
      w++;
    }
  }

  return {
    position: w === outCap ? position : position.subarray(0, w * 3),
    color: color ? (w === outCap ? color : color.subarray(0, w * 3)) : null,
    count: w,
    subsampled: step > 1,
    step,
    pointCount: totalPoints,
    scanCount: plan.length,
    hasColor,
    origin: { x: Ox, y: Oy, z: Oz },
    worldBounds: w ? { min: [wminx, wminy, wminz], max: [wmaxx, wmaxy, wmaxz] } : null,
  };
}

/* conteggio rapido dei punti (solo header+XML, nessuna decodifica) — per la guardia
   dimensione del viewer prima del full-load */
function e57PointCount(buffer) {
  const header = parseE57Header(buffer);
  const reader = new PagedReader(buffer, header.pageSize);
  const xmlStr = new TextDecoder("utf-8").decode(reader.readLogicalFromPhysical(header.xmlOffset, header.xmlLength));
  const root = parseXML(xmlStr);
  const data3D = xmlChild(root, "data3D");
  if (!data3D) return 0;
  let total = 0;
  for (const scan of data3D.children) {
    const points = xmlChild(scan, "points");
    if (points && points.attrs.recordCount) total += Number(points.attrs.recordCount);
  }
  return total;
}

export { parseE57Header, parseE57, e57PointCount, parseXML, _decodeIntField as _decodeIntFieldExport };

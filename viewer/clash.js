/* ============================================================================
   CLASH — motore di clash detection: kernel geometrici, BVH, broad phase,
   matrice delle interferenze. Modulo PURO, senza dipendenze (browser + Node)
   — feature "clash detection" (v2.6.0).

   Come per qto.js/ids.js, tutta la logica dipendente da three.js/web-ifc
   (estrazione di AABB e triangoli dai bucket mesh, risoluzione dei set,
   UI, export BCF) sta in viewer/index.html: l'adapter passa a questo modulo
   geometria già in SPAZIO MONDO CONDIVISO (metri, stessi buffer del render,
   federazione già risolta). Qui dentro solo matematica e formati file —
   così è testabile in Node (test/test_clash.js) senza modelli IFC.

   Unità: METRI ovunque, tranne le tolleranze nel file matrice (mm, come
   deciso con l'utente 2026-07-16). matrixToRules converte mm → m.

   API principale:
     triTriIntersect(t1, t2)        -> null | {coplanar, pen, seg}   (kernel)
     triTriDistance(t1, t2)         -> {dist, pa, pb}                (kernel)
     new TriBvh(tris)               -> BVH sui triangoli di UN elemento
     hardPair(bvhA, bvhB, opts)     -> null | {pen, overlap, extent, point,
                                               nPairs, capped, seeds}
     penetrationPair(bvhA, bvhB, o) -> {pen, point|null, measured}
     pointInMesh(bvh, x, y, z)      -> bool (ray-parity doppio)
     clearancePair(bvhA, bvhB, opts)-> null | {dist, point, pa, pb}
     broadPhase(itemsA, itemsB, inflate, opts) -> {pairs, truncated}
     expandClassName(name)          -> [nomi] (sottoclassi note incluse)
     parseMatrixCsv(text)           -> {rows, cols, cells, errors}
     matrixToCsv(parsed, opts)      -> stringa CSV
     matrixToRules(parsed, opts)    -> {rules} (dedup simmetrico + severità)
     clashKey(guidA, guidB, ruleId) -> chiave stabile per persistenza stati

   Limite dichiarato (documentato anche in guida): il test hard è di
   SUPERFICIE (tri-tri). Un elemento completamente CONTENUTO in un altro,
   senza intersezione di superfici, non viene rilevato.

   Due livelli di "profondità" (deciso col feedback utente 2026-07-16):
   - hardPair.pen è una stima LOCALE (estensione oltre il piano dell'altro
     triangolo): sovrastima con triangoli lunghi che si incrociano ad angolo
     stretto (cordolo 13 m su scarpata → "13 m"). Serve SOLO da pre-filtro
     con la sovrapposizione AABB; non va mai mostrata come gravità.
   - penetrationPair misura la profondità REALE: massimo, sui punti
     campionati della superficie di un elemento DENTRO il solido dell'altro,
     della distanza dalla superficie dell'altro (max sui due versi). È la
     risposta a "di quanto entra?": un tubo che corre 50 m in un riempimento
     penetrando 20 cm dà ~0.2, non 50. Il dentro/fuori è un ray-parity
     DOPPIO (parità concorde sul raggio opposto) con COLLASSO dei crossing
     alla stessa distanza (le facce coincidenti — duplicati, gusci incollati,
     facce interne dei BREP — sono una superficie sola: senza collasso la
     parità sarebbe sempre pari e tutto risulterebbe "fuori"). Sulle mesh
     APERTE la parità non concorda, il verso resta non misurato
     (measured=false se nessun campione risulta interno) — meglio nessuna
     misura che una misura inventata. Essendo un massimo campionato, può
     sottostimare leggermente (mai sovrastimare oltre il rumore di parità).
============================================================================ */

/* Sotto questa distanza (m) dal piano un vertice è considerato SUL piano.
   I vertici arrivano da buffer float32 ribasati sull'origine condivisa
   (grandezze ~1e3 m, quantizzazione ~1e-4): 1e-7 separa bene il rumore
   numerico dalle tolleranze operative (>= 1e-3). */
const EPS_PLANE = 1e-7;

/* Separatore per le chiavi composte (coppie di set/elementi): il carattere
   NUL non può comparire in nomi di file, classi IFC o celle CSV. */
const SEP = String.fromCharCode(0);

/* ============================== scratch =====================================
   I kernel scrivono su buffer di modulo per non allocare nel percorso caldo
   (milioni di chiamate su un run reale). I wrapper pubblici copiano fuori. */
const _seg = new Float64Array(6);    // segmento di intersezione (x1y1z1 x2y2z2)
const _cpA = new Float64Array(3);    // punto più vicino su A (distanza)
const _cpB = new Float64Array(3);    // punto più vicino su B
let _pen = 0;                        // stima compenetrazione dell'ultimo _tti

/* ========================================================================== */
/* 1. KERNEL — intersezione triangolo-triangolo (Möller '97 + segmento)       */
/* ========================================================================== */

/* Intersezione T1(A,ao)–T2(B,bo) su array piatti (9 float a triangolo).
   Ritorna 0 = disgiunti · 1 = si intersecano (segmento in _seg, stima in
   _pen) · 2 = complanari sovrapposti (contatto di faccia: _pen = 0).
   Normali normalizzate → distanze e pen in metri. */
function _tti(A, ao, B, bo) {
  const v0x = A[ao], v0y = A[ao + 1], v0z = A[ao + 2];
  const v1x = A[ao + 3], v1y = A[ao + 4], v1z = A[ao + 5];
  const v2x = A[ao + 6], v2y = A[ao + 7], v2z = A[ao + 8];
  const u0x = B[bo], u0y = B[bo + 1], u0z = B[bo + 2];
  const u1x = B[bo + 3], u1y = B[bo + 4], u1z = B[bo + 5];
  const u2x = B[bo + 6], u2y = B[bo + 7], u2z = B[bo + 8];

  /* piano di T2: n2 = (u1-u0)×(u2-u0) normalizzato, d2 = -n2·u0 */
  let e1x = u1x - u0x, e1y = u1y - u0y, e1z = u1z - u0z;
  let e2x = u2x - u0x, e2y = u2y - u0y, e2z = u2z - u0z;
  let n2x = e1y * e2z - e1z * e2y, n2y = e1z * e2x - e1x * e2z, n2z = e1x * e2y - e1y * e2x;
  let l = Math.sqrt(n2x * n2x + n2y * n2y + n2z * n2z);
  if (l < 1e-30) return 0;                       // T2 degenere
  n2x /= l; n2y /= l; n2z /= l;
  const d2 = -(n2x * u0x + n2y * u0y + n2z * u0z);

  /* distanze con segno dei vertici di T1 dal piano di T2 */
  let dv0 = n2x * v0x + n2y * v0y + n2z * v0z + d2;
  let dv1 = n2x * v1x + n2y * v1y + n2z * v1z + d2;
  let dv2 = n2x * v2x + n2y * v2y + n2z * v2z + d2;
  if (Math.abs(dv0) < EPS_PLANE) dv0 = 0;
  if (Math.abs(dv1) < EPS_PLANE) dv1 = 0;
  if (Math.abs(dv2) < EPS_PLANE) dv2 = 0;
  if (dv0 * dv1 > 0 && dv0 * dv2 > 0) return 0;  // T1 tutto da un lato

  /* piano di T1 */
  e1x = v1x - v0x; e1y = v1y - v0y; e1z = v1z - v0z;
  e2x = v2x - v0x; e2y = v2y - v0y; e2z = v2z - v0z;
  let n1x = e1y * e2z - e1z * e2y, n1y = e1z * e2x - e1x * e2z, n1z = e1x * e2y - e1y * e2x;
  l = Math.sqrt(n1x * n1x + n1y * n1y + n1z * n1z);
  if (l < 1e-30) return 0;                       // T1 degenere
  n1x /= l; n1y /= l; n1z /= l;
  const d1 = -(n1x * v0x + n1y * v0y + n1z * v0z);

  let du0 = n1x * u0x + n1y * u0y + n1z * u0z + d1;
  let du1 = n1x * u1x + n1y * u1y + n1z * u1z + d1;
  let du2 = n1x * u2x + n1y * u2y + n1z * u2z + d1;
  if (Math.abs(du0) < EPS_PLANE) du0 = 0;
  if (Math.abs(du1) < EPS_PLANE) du1 = 0;
  if (Math.abs(du2) < EPS_PLANE) du2 = 0;
  if (du0 * du1 > 0 && du0 * du2 > 0) return 0;  // T2 tutto da un lato

  /* complanari? contatto di faccia: pen = 0 per definizione */
  if (dv0 === 0 && dv1 === 0 && dv2 === 0) {
    _pen = 0;
    return _coplanarOverlap(n1x, n1y, n1z,
      v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z,
      u0x, u0y, u0z, u1x, u1y, u1z, u2x, u2y, u2z) ? 2 : 0;
  }

  /* direzione della retta di intersezione dei due piani; proiezione
     sull'asse dominante (i punti calcolati sotto sono colineari su L) */
  const dx = n1y * n2z - n1z * n2y, dy = n1z * n2x - n1x * n2z, dz = n1x * n2y - n1y * n2x;
  const adx = Math.abs(dx), ady = Math.abs(dy), adz = Math.abs(dz);
  const axis = adx >= ady ? (adx >= adz ? 0 : 2) : (ady >= adz ? 1 : 2);

  /* intervallo di T1 sulla retta: i due punti in cui gli spigoli dal vertice
     "solo" (segno opposto agli altri due) attraversano il piano di T2 */
  if (!_planeCross(v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z, dv0, dv1, dv2, _pA)) return 0;
  if (!_planeCross(u0x, u0y, u0z, u1x, u1y, u1z, u2x, u2y, u2z, du0, du1, du2, _pB)) return 0;

  let a1 = _pA[axis], a2 = _pA[3 + axis], b1 = _pB[axis], b2 = _pB[3 + axis];
  let aLo = 0, aHi = 3, bLo = 0, bHi = 3;                 // offset del punto lo/hi
  if (a1 > a2) { const t = a1; a1 = a2; a2 = t; aLo = 3; aHi = 0; }
  if (b1 > b2) { const t = b1; b1 = b2; b2 = t; bLo = 3; bHi = 0; }
  const lo = Math.max(a1, b1), hi = Math.min(a2, b2);
  if (lo > hi) return 0;                                  // intervalli disgiunti

  /* estremi del segmento comune, interpolati sull'intervallo di T1 */
  const den = a2 - a1;
  const tLo = den > 1e-30 ? (lo - a1) / den : 0;
  const tHi = den > 1e-30 ? (hi - a1) / den : 0;
  for (let k = 0; k < 3; k++) {
    const p1 = _pA[aLo + k], p2 = _pA[aHi + k];
    _seg[k] = p1 + (p2 - p1) * tLo;
    _seg[3 + k] = p1 + (p2 - p1) * tHi;
  }

  /* stima di compenetrazione: quanto ciascun triangolo prosegue OLTRE il
     piano dell'altro, dal lato meno esteso (una faccia a filo → ~0).
     min dei due = crossing significativo per la coppia. */
  const penV = Math.min(Math.max(dv0, dv1, dv2, 0), Math.max(-dv0, -dv1, -dv2, 0));
  const penU = Math.min(Math.max(du0, du1, du2, 0), Math.max(-du0, -du1, -du2, 0));
  _pen = Math.min(penV, penU);
  return 1;
}

const _pA = new Float64Array(6), _pB = new Float64Array(6);

/* Punti in cui il triangolo (v0,v1,v2) con distanze (d0,d1,d2) attraversa il
   piano dell'altro: individua il vertice "solo" e interseca i suoi due
   spigoli. Ritorna false solo su configurazioni impossibili. */
function _planeCross(v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z, d0, d1, d2, out) {
  let lone;
  if (d0 * d1 > 0) lone = 2;
  else if (d0 * d2 > 0) lone = 1;
  else if (d1 * d2 > 0 || d0 !== 0) lone = 0;
  else if (d1 !== 0) lone = 1;
  else if (d2 !== 0) lone = 2;
  else return false;                    // tutto zero: complanare (già gestito)
  let lx, ly, lz, ld, ax, ay, az, ad, bx, by, bz, bd;
  if (lone === 0) { lx = v0x; ly = v0y; lz = v0z; ld = d0; ax = v1x; ay = v1y; az = v1z; ad = d1; bx = v2x; by = v2y; bz = v2z; bd = d2; }
  else if (lone === 1) { lx = v1x; ly = v1y; lz = v1z; ld = d1; ax = v0x; ay = v0y; az = v0z; ad = d0; bx = v2x; by = v2y; bz = v2z; bd = d2; }
  else { lx = v2x; ly = v2y; lz = v2z; ld = d2; ax = v0x; ay = v0y; az = v0z; ad = d0; bx = v1x; by = v1y; bz = v1z; bd = d1; }
  let t = ld / (ld - ad);               // ld e ad hanno segni opposti (o ad=0)
  out[0] = lx + (ax - lx) * t; out[1] = ly + (ay - ly) * t; out[2] = lz + (az - lz) * t;
  t = ld / (ld - bd);
  out[3] = lx + (bx - lx) * t; out[4] = ly + (by - ly) * t; out[5] = lz + (bz - lz) * t;
  return true;
}

/* ---- caso complanare: overlap 2D sulla proiezione dominante della normale */
function _orient2(ax, ay, bx, by, cx, cy) { return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax); }

function _segSeg2(p1x, p1y, p2x, p2y, q1x, q1y, q2x, q2y) {
  const o1 = _orient2(p1x, p1y, p2x, p2y, q1x, q1y);
  const o2 = _orient2(p1x, p1y, p2x, p2y, q2x, q2y);
  const o3 = _orient2(q1x, q1y, q2x, q2y, p1x, p1y);
  const o4 = _orient2(q1x, q1y, q2x, q2y, p2x, p2y);
  return o1 * o2 <= 0 && o3 * o4 <= 0 &&
    /* esclude il caso colineare-disgiunto: basta un test di bbox 1D */
    Math.max(Math.min(p1x, p2x), Math.min(q1x, q2x)) <= Math.min(Math.max(p1x, p2x), Math.max(q1x, q2x)) &&
    Math.max(Math.min(p1y, p2y), Math.min(q1y, q2y)) <= Math.min(Math.max(p1y, p2y), Math.max(q1y, q2y));
}

function _pointInTri2(px, py, ax, ay, bx, by, cx, cy) {
  const s1 = _orient2(ax, ay, bx, by, px, py);
  const s2 = _orient2(bx, by, cx, cy, px, py);
  const s3 = _orient2(cx, cy, ax, ay, px, py);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

function _coplanarOverlap(nx, ny, nz,
  v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z,
  u0x, u0y, u0z, u1x, u1y, u1z, u2x, u2y, u2z) {
  /* proietta scartando l'asse dominante della normale */
  const anx = Math.abs(nx), any = Math.abs(ny), anz = Math.abs(nz);
  let i0, i1;
  if (anx >= any && anx >= anz) { i0 = 1; i1 = 2; }
  else if (any >= anz) { i0 = 0; i1 = 2; }
  else { i0 = 0; i1 = 1; }
  const V = [[v0x, v0y, v0z], [v1x, v1y, v1z], [v2x, v2y, v2z]];
  const U = [[u0x, u0y, u0z], [u1x, u1y, u1z], [u2x, u2y, u2z]];
  for (let i = 0; i < 3; i++) {
    const a = V[i], b = V[(i + 1) % 3];
    for (let j = 0; j < 3; j++) {
      const c = U[j], d = U[(j + 1) % 3];
      if (_segSeg2(a[i0], a[i1], b[i0], b[i1], c[i0], c[i1], d[i0], d[i1])) return true;
    }
  }
  if (_pointInTri2(V[0][i0], V[0][i1], U[0][i0], U[0][i1], U[1][i0], U[1][i1], U[2][i0], U[2][i1])) return true;
  if (_pointInTri2(U[0][i0], U[0][i1], V[0][i0], V[0][i1], V[1][i0], V[1][i1], V[2][i0], V[2][i1])) return true;
  return false;
}

/* ========================================================================== */
/* 2. KERNEL — distanza triangolo-triangolo (Ericson, RTCD)                   */
/* ========================================================================== */

/* Punto di (a,b,c) più vicino a p → out; ritorna la distanza² . */
function _closestPtTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return _d2(px, py, pz, out); }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; return _d2(px, py, pz, out); }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = ax + abx * v; out[1] = ay + aby * v; out[2] = az + abz * v;
    return _d2(px, py, pz, out);
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; return _d2(px, py, pz, out); }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[0] = ax + acx * w; out[1] = ay + acy * w; out[2] = az + acz * w;
    return _d2(px, py, pz, out);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out[0] = bx + (cx - bx) * w; out[1] = by + (cy - by) * w; out[2] = bz + (cz - bz) * w;
    return _d2(px, py, pz, out);
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  out[0] = ax + abx * v + acx * w; out[1] = ay + aby * v + acy * w; out[2] = az + abz * v + acz * w;
  return _d2(px, py, pz, out);
}
function _d2(px, py, pz, q) { const dx = px - q[0], dy = py - q[1], dz = pz - q[2]; return dx * dx + dy * dy + dz * dz; }

const _ssP = new Float64Array(3), _ssQ = new Float64Array(3);
/* Coppia di punti più vicini tra i segmenti p1q1 e p2q2 → _ssP/_ssQ; dist². */
function _segSegDist2(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  if (a <= 1e-30 && e <= 1e-30) { s = 0; t = 0; }
  else if (a <= 1e-30) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-30) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const den = a * e - b * b;
      s = den > 1e-30 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  _ssP[0] = p1x + d1x * s; _ssP[1] = p1y + d1y * s; _ssP[2] = p1z + d1z * s;
  _ssQ[0] = p2x + d2x * t; _ssQ[1] = p2y + d2y * t; _ssQ[2] = p2z + d2z * t;
  const dx = _ssP[0] - _ssQ[0], dy = _ssP[1] - _ssQ[1], dz = _ssP[2] - _ssQ[2];
  return dx * dx + dy * dy + dz * dz;
}

const _cpt = new Float64Array(3);
/* Distanza² minima tra due triangoli (piatti, offset) + punti in _cpA/_cpB.
   Se si intersecano (o contatto complanare) → 0 con punto sul segmento. */
function _ttd2(A, ao, B, bo) {
  const r = _tti(A, ao, B, bo);
  if (r === 1) {
    _cpA[0] = _cpB[0] = (_seg[0] + _seg[3]) / 2;
    _cpA[1] = _cpB[1] = (_seg[1] + _seg[4]) / 2;
    _cpA[2] = _cpB[2] = (_seg[2] + _seg[5]) / 2;
    return 0;
  }
  if (r === 2) {   // complanari sovrapposti: contatto — usa un vertice interno
    _cpA[0] = _cpB[0] = A[ao]; _cpA[1] = _cpB[1] = A[ao + 1]; _cpA[2] = _cpB[2] = A[ao + 2];
    return 0;
  }
  let best = Infinity;
  /* vertici di A vs triangolo B e viceversa */
  for (let k = 0; k < 3; k++) {
    let d = _closestPtTri(A[ao + 3 * k], A[ao + 3 * k + 1], A[ao + 3 * k + 2],
      B[bo], B[bo + 1], B[bo + 2], B[bo + 3], B[bo + 4], B[bo + 5], B[bo + 6], B[bo + 7], B[bo + 8], _cpt);
    if (d < best) { best = d; _cpA[0] = A[ao + 3 * k]; _cpA[1] = A[ao + 3 * k + 1]; _cpA[2] = A[ao + 3 * k + 2]; _cpB[0] = _cpt[0]; _cpB[1] = _cpt[1]; _cpB[2] = _cpt[2]; }
    d = _closestPtTri(B[bo + 3 * k], B[bo + 3 * k + 1], B[bo + 3 * k + 2],
      A[ao], A[ao + 1], A[ao + 2], A[ao + 3], A[ao + 4], A[ao + 5], A[ao + 6], A[ao + 7], A[ao + 8], _cpt);
    if (d < best) { best = d; _cpB[0] = B[bo + 3 * k]; _cpB[1] = B[bo + 3 * k + 1]; _cpB[2] = B[bo + 3 * k + 2]; _cpA[0] = _cpt[0]; _cpA[1] = _cpt[1]; _cpA[2] = _cpt[2]; }
  }
  /* spigolo vs spigolo (9 coppie) */
  for (let i = 0; i < 3; i++) {
    const i2 = (i + 1) % 3;
    for (let j = 0; j < 3; j++) {
      const j2 = (j + 1) % 3;
      const d = _segSegDist2(
        A[ao + 3 * i], A[ao + 3 * i + 1], A[ao + 3 * i + 2],
        A[ao + 3 * i2], A[ao + 3 * i2 + 1], A[ao + 3 * i2 + 2],
        B[bo + 3 * j], B[bo + 3 * j + 1], B[bo + 3 * j + 2],
        B[bo + 3 * j2], B[bo + 3 * j2 + 1], B[bo + 3 * j2 + 2]);
      if (d < best) { best = d; _cpA.set(_ssP); _cpB.set(_ssQ); }
    }
  }
  return best;
}

/* ---- wrapper pubblici dei kernel (comodi per test e debug, allocano) ---- */
function triTriIntersect(t1, t2) {
  const a = t1 instanceof Float64Array || t1 instanceof Float32Array ? t1 : Float64Array.from(t1);
  const b = t2 instanceof Float64Array || t2 instanceof Float32Array ? t2 : Float64Array.from(t2);
  const r = _tti(a, 0, b, 0);
  if (r === 0) return null;
  return { coplanar: r === 2, pen: _pen, seg: r === 1 ? Array.from(_seg) : null };
}
function triTriDistance(t1, t2) {
  const a = t1 instanceof Float64Array || t1 instanceof Float32Array ? t1 : Float64Array.from(t1);
  const b = t2 instanceof Float64Array || t2 instanceof Float32Array ? t2 : Float64Array.from(t2);
  const d2 = _ttd2(a, 0, b, 0);
  return { dist: Math.sqrt(d2), pa: Array.from(_cpA), pb: Array.from(_cpB) };
}

/* ========================================================================== */
/* 3. BVH — costruzione generica su lista di AABB                             */
/* ========================================================================== */

const BVH_LEAF = 4;

/* aabbs: array-like di 6 valori a elemento [minx,miny,minz,maxx,maxy,maxz].
   Bounds dei nodi in Float64 (niente restringimento da arrotondamento).
   Nodi: foglia se b[i] > 0 (a=inizio in order, b=conteggio);
   interno se b[i] < 0 (a=figlio sx, -b=figlio dx). Radice = 0. */
function _buildBvh(aabbs, n) {
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const cx = new Float64Array(n), cy = new Float64Array(n), cz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    cx[i] = (aabbs[6 * i] + aabbs[6 * i + 3]) / 2;
    cy[i] = (aabbs[6 * i + 1] + aabbs[6 * i + 4]) / 2;
    cz[i] = (aabbs[6 * i + 2] + aabbs[6 * i + 5]) / 2;
  }
  const cap = Math.max(1, 2 * n);
  const nMin = new Float64Array(3 * cap), nMax = new Float64Array(3 * cap);
  const na = new Int32Array(cap), nb = new Int32Array(cap);
  let count = 0;

  function rec(start, cnt) {
    const idx = count++;
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    let cnx = Infinity, cny = Infinity, cnz = Infinity, cxx = -Infinity, cxy = -Infinity, cxz = -Infinity;
    for (let k = start; k < start + cnt; k++) {
      const i = order[k], o = 6 * i;
      if (aabbs[o] < mnx) mnx = aabbs[o];
      if (aabbs[o + 1] < mny) mny = aabbs[o + 1];
      if (aabbs[o + 2] < mnz) mnz = aabbs[o + 2];
      if (aabbs[o + 3] > mxx) mxx = aabbs[o + 3];
      if (aabbs[o + 4] > mxy) mxy = aabbs[o + 4];
      if (aabbs[o + 5] > mxz) mxz = aabbs[o + 5];
      if (cx[i] < cnx) cnx = cx[i]; if (cx[i] > cxx) cxx = cx[i];
      if (cy[i] < cny) cny = cy[i]; if (cy[i] > cxy) cxy = cy[i];
      if (cz[i] < cnz) cnz = cz[i]; if (cz[i] > cxz) cxz = cz[i];
    }
    nMin[3 * idx] = mnx; nMin[3 * idx + 1] = mny; nMin[3 * idx + 2] = mnz;
    nMax[3 * idx] = mxx; nMax[3 * idx + 1] = mxy; nMax[3 * idx + 2] = mxz;
    const ex = cxx - cnx, ey = cxy - cny, ez = cxz - cnz;
    if (cnt <= BVH_LEAF || (ex <= 0 && ey <= 0 && ez <= 0)) {
      na[idx] = start; nb[idx] = cnt;             // foglia (centroidi coincidenti inclusi)
      return idx;
    }
    const key = ex >= ey ? (ex >= ez ? cx : cz) : (ey >= ez ? cy : cz);
    order.subarray(start, start + cnt).sort((i, j) => key[i] - key[j]);
    const mid = cnt >> 1;
    const l = rec(start, mid);
    const r = rec(start + mid, cnt - mid);
    na[idx] = l; nb[idx] = -r;
    return idx;
  }
  if (n > 0) rec(0, n);
  return { nMin, nMax, na, nb, order, count, n };
}

/* distanza² tra gli AABB dei nodi ia (di ta) e ib (di tb) */
function _nodeDist2(ta, ia, tb, ib) {
  let d2 = 0;
  for (let k = 0; k < 3; k++) {
    const gap = Math.max(ta.nMin[3 * ia + k] - tb.nMax[3 * ib + k],
      tb.nMin[3 * ib + k] - ta.nMax[3 * ia + k], 0);
    d2 += gap * gap;
  }
  return d2;
}

/* ========================================================================== */
/* 4. TriBvh — BVH sui triangoli di UN elemento                               */
/* ========================================================================== */

class TriBvh {
  /* tris: 9 float per triangolo (ax ay az bx by bz cx cy cz), spazio mondo. */
  constructor(tris) {
    this.tris = (tris instanceof Float32Array || tris instanceof Float64Array)
      ? tris : Float32Array.from(tris);
    const n = this.n = Math.floor(this.tris.length / 9);
    const ab = this.triAabb = new Float64Array(6 * n);
    const t = this.tris;
    for (let i = 0; i < n; i++) {
      const o = 9 * i, q = 6 * i;
      ab[q] = Math.min(t[o], t[o + 3], t[o + 6]);
      ab[q + 1] = Math.min(t[o + 1], t[o + 4], t[o + 7]);
      ab[q + 2] = Math.min(t[o + 2], t[o + 5], t[o + 8]);
      ab[q + 3] = Math.max(t[o], t[o + 3], t[o + 6]);
      ab[q + 4] = Math.max(t[o + 1], t[o + 4], t[o + 7]);
      ab[q + 5] = Math.max(t[o + 2], t[o + 5], t[o + 8]);
    }
    this.bvh = _buildBvh(ab, n);
    /* stima memoria per il budget LRU dell'adapter (byte, approssimata) */
    this.bytes = this.tris.byteLength + ab.byteLength +
      this.bvh.nMin.byteLength * 2 + this.bvh.na.byteLength * 2 + this.bvh.order.byteLength;
  }
  get aabb() {
    const b = this.bvh;
    return b.count ? [b.nMin[0], b.nMin[1], b.nMin[2], b.nMax[0], b.nMax[1], b.nMax[2]] : null;
  }
}

/* overlap AABB-AABB gonfiato di `inf` */
function _nodeOverlap(ta, ia, tb, ib, inf) {
  for (let k = 0; k < 3; k++) {
    if (ta.nMin[3 * ia + k] - inf > tb.nMax[3 * ib + k]) return false;
    if (tb.nMin[3 * ib + k] - inf > ta.nMax[3 * ia + k]) return false;
  }
  return true;
}

/* HARD CLASH tra due elementi (i loro TriBvh).
   opts: { tol   : compenetrazione minima per riportare il clash (m, default 0
                   = anche i tocchi non complanari),
           maxPairs: cap sulle coppie di triangoli raccolte (default 512) }
   Ritorna null se niente sopra tolleranza, altrimenti:
   { pen, extent, point:[x,y,z], nPairs, capped, seeds }
   pen    = stima max di compenetrazione (m) — vedi header: SOLO pre-filtro;
   extent = diagonale del bbox dei segmenti di intersezione (m);
   point  = baricentro dei punti medi dei segmenti — per zoom/marker;
   seeds  = fino a PEN_SEEDS coppie {ia, ib, seg} campionate uniformemente
            (reservoir deterministico) tra quelle intersecanti — l'input di
            penetrationPair. */
const PEN_SEEDS = 32;
function hardPair(A, B, opts) {
  const tol = (opts && opts.tol) || 0;
  const maxPairs = (opts && opts.maxPairs) || 512;
  const ba = A.bvh, bb = B.bvh;
  if (!ba.count || !bb.count) return null;
  let pen = -1, nPairs = 0, capped = false;
  let sx = 0, sy = 0, sz = 0;
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  const seeds = [];
  let rng = 123456789;
  const stack = [0, 0];
  while (stack.length && !capped) {
    const jb = stack.pop(), ja = stack.pop();
    if (!_nodeOverlap(ba, ja, bb, jb, EPS_PLANE)) continue;
    const leafA = ba.nb[ja] > 0, leafB = bb.nb[jb] > 0;
    if (leafA && leafB) {
      for (let p = ba.na[ja]; p < ba.na[ja] + ba.nb[ja] && !capped; p++) {
        const i = ba.order[p], ao = 9 * i, aq = 6 * i;
        for (let q = bb.na[jb]; q < bb.na[jb] + bb.nb[jb]; q++) {
          const j = bb.order[q], bo = 9 * j, bq = 6 * j;
          /* prefiltro AABB triangolo-triangolo */
          if (A.triAabb[aq] > B.triAabb[bq + 3] || B.triAabb[bq] > A.triAabb[aq + 3] ||
              A.triAabb[aq + 1] > B.triAabb[bq + 4] || B.triAabb[bq + 1] > A.triAabb[aq + 4] ||
              A.triAabb[aq + 2] > B.triAabb[bq + 5] || B.triAabb[bq + 2] > A.triAabb[aq + 5]) continue;
          if (_tti(A.tris, ao, B.tris, bo) !== 1) continue;   // complanari: contatto, non hard
          if (_pen > pen) pen = _pen;
          nPairs++;
          /* reservoir: i semi restano un campione uniforme di TUTTE le coppie
             viste, non solo delle prime — su un contatto lungo 50 m la zona
             va coperta intera */
          if (seeds.length < PEN_SEEDS) {
            seeds.push({ ia: i, ib: j, seg: [_seg[0], _seg[1], _seg[2], _seg[3], _seg[4], _seg[5]] });
          } else {
            rng = (Math.imul(rng, 1103515245) + 12345) & 0x7fffffff;
            const r = rng % nPairs;
            if (r < PEN_SEEDS) seeds[r] = { ia: i, ib: j, seg: [_seg[0], _seg[1], _seg[2], _seg[3], _seg[4], _seg[5]] };
          }
          sx += (_seg[0] + _seg[3]) / 2; sy += (_seg[1] + _seg[4]) / 2; sz += (_seg[2] + _seg[5]) / 2;
          for (let k = 0; k < 6; k += 3) {
            if (_seg[k] < mnx) mnx = _seg[k];
            if (_seg[k] > mxx) mxx = _seg[k];
            if (_seg[k + 1] < mny) mny = _seg[k + 1];
            if (_seg[k + 1] > mxy) mxy = _seg[k + 1];
            if (_seg[k + 2] < mnz) mnz = _seg[k + 2];
            if (_seg[k + 2] > mxz) mxz = _seg[k + 2];
          }
          if (nPairs >= maxPairs) { capped = true; break; }
        }
      }
    } else if (leafB || (!leafA &&
        (ba.nMax[3 * ja] - ba.nMin[3 * ja] + ba.nMax[3 * ja + 1] - ba.nMin[3 * ja + 1] + ba.nMax[3 * ja + 2] - ba.nMin[3 * ja + 2]) >=
        (bb.nMax[3 * jb] - bb.nMin[3 * jb] + bb.nMax[3 * jb + 1] - bb.nMin[3 * jb + 1] + bb.nMax[3 * jb + 2] - bb.nMin[3 * jb + 2]))) {
      stack.push(ba.na[ja], jb, -ba.nb[ja], jb);   // scende nel nodo A (più esteso)
    } else {
      stack.push(ja, bb.na[jb], ja, -bb.nb[jb]);   // scende nel nodo B
    }
  }
  if (nPairs === 0) return null;
  /* Gate di tolleranza su max(pen, overlap). "overlap" = sovrapposizione minima
     degli AABB dei due elementi: cattura gli elementi INCASSATI A FILO (es.
     pilastro annegato nel muro con entrambe le facce coincidenti), dove le
     superfici si intersecano ma pen resta 0 come in un semplice contatto.
     Per i contatti ortogonali (muro su solaio, testa a faccia) l'overlap è 0
     sull'asse del contatto → restano filtrati. Limite accettato e documentato:
     un contatto A FILO SU FACCIA INCLINATA può avere overlap > 0 su tutti gli
     assi e produrre un falso positivo. */
  let overlap = Infinity;
  for (let k = 0; k < 3; k++) {
    const o = Math.min(ba.nMax[k], bb.nMax[k]) - Math.max(ba.nMin[k], bb.nMin[k]);
    if (o < overlap) overlap = o;
  }
  if (overlap < 0) overlap = 0;
  if (Math.max(pen, overlap) < tol) return null;
  const dx = mxx - mnx, dy = mxy - mny, dz = mxz - mnz;
  return {
    pen, overlap, extent: Math.sqrt(dx * dx + dy * dy + dz * dz),
    point: [sx / nPairs, sy / nPairs, sz / nPairs],
    nPairs, capped, seeds
  };
}

/* ========================================================================== */
/* 4bis. PENETRAZIONE REALE — dentro/fuori + distanza dalla superficie        */
/* ========================================================================== */

/* Direzioni di parità: componenti "irrazionali" per non allinearsi mai a
   facce assiali; tre alternative per gli incontri degeneri (spigoli). */
const _RAY_DIRS = [
  [0.5773502691896258, 0.5773502691896257, 0.5773502691896259],
  [-0.2672612419124244, 0.5345224838248488, 0.8017837257372732],
  [0.8111071056538127, -0.3244428422615251, 0.4866642633922876]
];
const _rcStack = [];           // scratch condiviso delle traversate (no alloc)

/* Möller–Trumbore: t>0 = crossing netto alla distanza t, 0 = mancato,
   -1 = sospetto (spigolo, vertice, raggio radente o origine sul piano). */
function _rayTri(A, o, px, py, pz, dx, dy, dz) {
  const ax = A[o], ay = A[o + 1], az = A[o + 2];
  const e1x = A[o + 3] - ax, e1y = A[o + 4] - ay, e1z = A[o + 5] - az;
  const e2x = A[o + 6] - ax, e2y = A[o + 7] - ay, e2z = A[o + 8] - az;
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (det > -1e-14 && det < 1e-14) return 0;      // parallelo: nessun crossing
  const inv = 1 / det;
  const sx = px - ax, sy = py - ay, sz = pz - az;
  const u = (sx * hx + sy * hy + sz * hz) * inv;
  const M = 1e-7;                                  // margine di sospetto (baricentrico)
  if (u < -M || u > 1 + M) return 0;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -M || u + v > 1 + M) return 0;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t <= -1e-7) return 0;                        // dietro l'origine
  if (t < 1e-7) return -1;                         // origine quasi sulla superficie
  if (u < M || v < M || u + v > 1 - M) return -1;  // spigolo/vertice
  return t;
}

/* Le mesh IFC hanno spesso FACCE COINCIDENTI (duplicati, gusci incollati,
   facce interne dei BREP): due incroci alla stessa distanza sono UNA
   superficie sola, non due — senza questo collasso la parità è sempre pari
   e ogni punto risulta "fuori". Tolleranza in metri lungo il raggio. */
const _RAY_T_EPS = 5e-4;
const _rcTs = new Float64Array(256);   // distanze dei crossing (scratch)

/* Numero di crossing DISTINTI del raggio p + t·d (t>0) coi triangoli di T;
   -1 se un incontro è ambiguo (il chiamante cambia direzione). */
function _rayCrossings(T, px, py, pz, dx, dy, dz) {
  const b = T.bvh, tris = T.tris;
  if (!b.count) return 0;
  let nh = 0;
  const stack = _rcStack; stack.length = 0; stack.push(0);
  while (stack.length) {
    const ni = stack.pop();
    /* slab test raggio-AABB su [0, ∞) */
    let t0 = 0, t1 = Infinity, out = false;
    for (let k = 0; k < 3; k++) {
      const o = k === 0 ? px : k === 1 ? py : pz;
      const d = k === 0 ? dx : k === 1 ? dy : dz;
      const mn = b.nMin[3 * ni + k], mx = b.nMax[3 * ni + k];
      if (d > -1e-30 && d < 1e-30) {
        if (o < mn || o > mx) { out = true; break; }
      } else {
        let ta = (mn - o) / d, tb = (mx - o) / d;
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) { out = true; break; }
      }
    }
    if (out) continue;
    if (b.nb[ni] > 0) {
      for (let p = b.na[ni]; p < b.na[ni] + b.nb[ni]; p++) {
        const r = _rayTri(tris, 9 * b.order[p], px, py, pz, dx, dy, dz);
        if (r === -1) { stack.length = 0; return -1; }
        if (r > 0 && nh < _rcTs.length) _rcTs[nh++] = r;
      }
    } else {
      stack.push(b.na[ni], -b.nb[ni]);
    }
  }
  if (nh < 2) return nh;
  /* collassa i crossing alla stessa distanza (facce coincidenti) */
  const ts = _rcTs.subarray(0, nh);
  ts.sort();
  let n = 1;
  for (let i = 1; i < nh; i++) if (ts[i] - ts[i - 1] > _RAY_T_EPS) n++;
  return n;
}

/* Punto dentro il SOLIDO della mesh? Parità dei crossing, richiesta CONCORDE
   sul raggio opposto: le mesh aperte (superfici) non concordano quasi mai →
   "fuori", che per la penetrazione è il fallback prudente. */
function pointInMesh(T, px, py, pz) {
  for (let k = 0; k < _RAY_DIRS.length; k++) {
    const D = _RAY_DIRS[k];
    const c1 = _rayCrossings(T, px, py, pz, D[0], D[1], D[2]);
    if (c1 < 0) continue;
    const c2 = _rayCrossings(T, px, py, pz, -D[0], -D[1], -D[2]);
    if (c2 < 0) continue;
    return (c1 & 1) === 1 && (c2 & 1) === 1;
  }
  return false;                 // troppe configurazioni degeneri: prudenza
}

/* Distanza² minima punto-mesh (traversata con potatura); best2 iniziale = cap. */
function _pointMeshDist2(T, px, py, pz, cap2) {
  const b = T.bvh, tris = T.tris;
  if (!b.count) return cap2;
  let best = cap2;
  const stack = _rcStack; stack.length = 0; stack.push(0);
  while (stack.length) {
    const ni = stack.pop();
    let d2 = 0;
    for (let k = 0; k < 3; k++) {
      const o = k === 0 ? px : k === 1 ? py : pz;
      const gap = Math.max(b.nMin[3 * ni + k] - o, o - b.nMax[3 * ni + k], 0);
      d2 += gap * gap;
    }
    if (d2 >= best) continue;
    if (b.nb[ni] > 0) {
      for (let p = b.na[ni]; p < b.na[ni] + b.nb[ni]; p++) {
        const o9 = 9 * b.order[p];
        const dd = _closestPtTri(px, py, pz,
          tris[o9], tris[o9 + 1], tris[o9 + 2], tris[o9 + 3], tris[o9 + 4], tris[o9 + 5],
          tris[o9 + 6], tris[o9 + 7], tris[o9 + 8], _cpt);
        if (dd < best) best = dd;
      }
    } else {
      stack.push(b.na[ni], -b.nb[ni]);
    }
  }
  return best;
}

/* Campioni sulla superficie di X vicino alla zona di clash:
   - vertici e baricentro dei triangoli dei semi (dedup);
   - marcia in-piano dal punto medio di ogni segmento, perpendicolare alla
     curva di intersezione, CLAMPATA al triangolo (uscita esatta sugli
     spigoli): è quella che trova la profondità sulle facce grandi;
   - vertici globali dentro l'AABB di sovrapposizione O (stride + cap):
     cattura i punti profondi lontani dalla zona di incrocio (fondo di un
     elemento quasi tutto affondato). Output piatto [x,y,z,...]. */
const _MARCH_FR = [0.35, 0.5, 0.8];   // frazioni della distanza al bordo del triangolo
const _MARCH_OD = [0.1, 0.25];        // frazioni della diagonale della zona di sovrapposizione
function _penSamplePts(X, seeds, side, O, Od) {
  const t = X.tris, out = [], seen = new Set();
  const push = (x, y, z) => {
    const k = Math.round(x * 1e4) + "," + Math.round(y * 1e4) + "," + Math.round(z * 1e4);
    if (!seen.has(k)) { seen.add(k); out.push(x, y, z); }
  };
  for (let si = 0; si < seeds.length && out.length < 2100; si++) {
    const sd = seeds[si];
    const o = 9 * (side ? sd.ib : sd.ia);
    push(t[o], t[o + 1], t[o + 2]);
    push(t[o + 3], t[o + 4], t[o + 5]);
    push(t[o + 6], t[o + 7], t[o + 8]);
    push((t[o] + t[o + 3] + t[o + 6]) / 3, (t[o + 1] + t[o + 4] + t[o + 7]) / 3, (t[o + 2] + t[o + 5] + t[o + 8]) / 3);
    /* marcia ⊥ alla curva, nel piano del triangolo */
    let svx = sd.seg[3] - sd.seg[0], svy = sd.seg[4] - sd.seg[1], svz = sd.seg[5] - sd.seg[2];
    const sl = Math.sqrt(svx * svx + svy * svy + svz * svz);
    if (sl < 1e-12) continue;
    svx /= sl; svy /= sl; svz /= sl;
    const e1x = t[o + 3] - t[o], e1y = t[o + 4] - t[o + 1], e1z = t[o + 5] - t[o + 2];
    const e2x = t[o + 6] - t[o], e2y = t[o + 7] - t[o + 1], e2z = t[o + 8] - t[o + 2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl < 1e-30) continue;
    nx /= nl; ny /= nl; nz /= nl;
    const dxv = ny * svz - nz * svy, dyv = nz * svx - nx * svz, dzv = nx * svy - ny * svx;
    /* proiezione 2D sull'asse dominante della normale: clamp esatto al bordo
       e verifica di appartenenza al triangolo di ogni campione */
    const anx = Math.abs(nx), any = Math.abs(ny), anz = Math.abs(nz);
    let i0, i1;
    if (anx >= any && anx >= anz) { i0 = 1; i1 = 2; }
    else if (any >= anz) { i0 = 0; i1 = 2; }
    else { i0 = 0; i1 = 1; }
    const P = [t[o], t[o + 1], t[o + 2], t[o + 3], t[o + 4], t[o + 5], t[o + 6], t[o + 7], t[o + 8]];
    const inTri = (q0, q1) => _pointInTri2(q0, q1, P[i0], P[i1], P[3 + i0], P[3 + i1], P[6 + i0], P[6 + i1]);
    /* origini: punto medio E estremi del segmento (coprono la zona meglio) */
    for (let og = 0; og < 3; og++) {
      const mx = og === 0 ? (sd.seg[0] + sd.seg[3]) / 2 : sd.seg[og === 1 ? 0 : 3];
      const my = og === 0 ? (sd.seg[1] + sd.seg[4]) / 2 : sd.seg[og === 1 ? 1 : 4];
      const mz = og === 0 ? (sd.seg[2] + sd.seg[5]) / 2 : sd.seg[og === 1 ? 2 : 5];
      for (let sg = 1; sg >= -1; sg -= 2) {
        /* t di uscita dal triangolo lungo ±d (intersezione coi 3 spigoli in 2D) */
        const dd0 = (i0 === 0 ? dxv : i0 === 1 ? dyv : dzv) * sg;
        const dd1 = (i1 === 0 ? dxv : i1 === 1 ? dyv : dzv) * sg;
        const mm0 = i0 === 0 ? mx : i0 === 1 ? my : mz;
        const mm1 = i1 === 0 ? mx : i1 === 1 ? my : mz;
        let te = Infinity;
        for (let e = 0; e < 3; e++) {
          const a0 = P[3 * e + i0], a1 = P[3 * e + i1];
          const b0 = P[3 * ((e + 1) % 3) + i0], b1 = P[3 * ((e + 1) % 3) + i1];
          const ex = b0 - a0, ey = b1 - a1;
          const den = ex * dd1 - ey * dd0;
          if (den > -1e-30 && den < 1e-30) continue;
          const tt = (ex * (a1 - mm1) - ey * (a0 - mm0)) / den;
          const ss = (dd0 * (a1 - mm1) - dd1 * (a0 - mm0)) / den;
          if (tt > 1e-9 && ss >= -1e-9 && ss <= 1 + 1e-9 && tt < te) te = tt;
        }
        if (!(te > 1e-9) || te === Infinity) continue;
        const step = (tt) => {
          const qx = mx + dxv * sg * tt, qy = my + dyv * sg * tt, qz = mz + dzv * sg * tt;
          const q0 = i0 === 0 ? qx : i0 === 1 ? qy : qz;
          const q1 = i1 === 0 ? qx : i1 === 1 ? qy : qz;
          if (inTri(q0, q1)) push(qx, qy, qz);
        };
        for (let f = 0; f < _MARCH_FR.length; f++) step(te * _MARCH_FR[f]);
        /* passi a scala della zona di sovrapposizione: su una faccia GRANDE
           (bordo a metri) la profondità sta molto prima del bordo */
        for (let f = 0; f < _MARCH_OD.length; f++) {
          const tt = _MARCH_OD[f] * Od;
          if (tt < te * 0.95) step(tt);
        }
      }
    }
  }
  /* punti medi tra coppie di segmenti COMPLANARI sullo stesso triangolo:
     in un attraversamento PASSANTE (tubo nel muro) le curve di entrata e
     uscita giacciono sulla stessa faccia — il punto a metà strada tra le
     due è il più profondo, e così è ESATTO invece che affidato alla scala
     dei passi di marcia. */
  const ns = Math.min(seeds.length, 16);
  for (let a = 0; a < ns; a++) {
    const sa = seeds[a], oa = 9 * (side ? sa.ib : sa.ia);
    const ax = t[oa], ay = t[oa + 1], az = t[oa + 2];
    const e1x = t[oa + 3] - ax, e1y = t[oa + 4] - ay, e1z = t[oa + 5] - az;
    const e2x = t[oa + 6] - ax, e2y = t[oa + 7] - ay, e2z = t[oa + 8] - az;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl < 1e-30) continue;
    nx /= nl; ny /= nl; nz /= nl;
    const anx = Math.abs(nx), any = Math.abs(ny), anz = Math.abs(nz);
    let i0, i1;
    if (anx >= any && anx >= anz) { i0 = 1; i1 = 2; }
    else if (any >= anz) { i0 = 0; i1 = 2; }
    else { i0 = 0; i1 = 1; }
    const P = [t[oa], t[oa + 1], t[oa + 2], t[oa + 3], t[oa + 4], t[oa + 5], t[oa + 6], t[oa + 7], t[oa + 8]];
    const max_ = (sa.seg[0] + sa.seg[3]) / 2, may = (sa.seg[1] + sa.seg[4]) / 2, maz = (sa.seg[2] + sa.seg[5]) / 2;
    for (let b = a + 1; b < ns; b++) {
      const sb = seeds[b];
      const qx = (max_ + (sb.seg[0] + sb.seg[3]) / 2) / 2;
      const qy = (may + (sb.seg[1] + sb.seg[4]) / 2) / 2;
      const qz = (maz + (sb.seg[2] + sb.seg[5]) / 2) / 2;
      /* deve stare SUL triangolo di a: complanare e dentro */
      if (Math.abs(nx * (qx - ax) + ny * (qy - ay) + nz * (qz - az)) > 0.002) continue;
      const q0 = i0 === 0 ? qx : i0 === 1 ? qy : qz;
      const q1 = i1 === 0 ? qx : i1 === 1 ? qy : qz;
      if (!_pointInTri2(q0, q1, P[i0], P[i1], P[3 + i0], P[3 + i1], P[6 + i0], P[6 + i1])) continue;
      push(qx, qy, qz);
    }
  }
  /* vertici globali dentro O (stride sui mesh grossi, cap sul totale) */
  const nv = 3 * X.n;
  const stride = Math.max(1, Math.ceil(nv / 500));
  let added = 0;
  for (let vi = 0; vi < nv && added < 160; vi += stride) {
    const x = t[3 * vi], y = t[3 * vi + 1], z = t[3 * vi + 2];
    if (x < O[0] || x > O[3] || y < O[1] || y > O[4] || z < O[2] || z > O[5]) continue;
    const before = out.length;
    push(x, y, z);
    if (out.length > before) added++;
  }
  return out;
}

/* PROFONDITÀ DI PENETRAZIONE tra due elementi già in hard clash.
   Definizione: max, sui punti campionati della superficie di un elemento
   che risultano DENTRO il solido dell'altro, della distanza dalla superficie
   dell'altro — max sui due versi ("di quanto entra?").
   opts: { seeds: da hardPair, tol }. Ritorna { pen, point|null, measured }:
   measured=false se nessun campione è risultato interno (mesh aperte da
   entrambi i lati, o tocco sotto la risoluzione dei campioni). */
function penetrationPair(A, B, opts) {
  const seeds = (opts && opts.seeds) || [];
  const ba = A.aabb, bb = B.aabb;
  if (!ba || !bb) return { pen: 0, point: null, measured: false };
  /* pad COSTANTE: la misura non deve dipendere dalla tolleranza del run
     (stesso clash → stesso valore a 1 mm e a 120 mm) */
  const pad = 0.05;
  const O = [Math.max(ba[0], bb[0]) - pad, Math.max(ba[1], bb[1]) - pad, Math.max(ba[2], bb[2]) - pad,
             Math.min(ba[3], bb[3]) + pad, Math.min(ba[4], bb[4]) + pad, Math.min(ba[5], bb[5]) + pad];
  const dA2 = (ba[3] - ba[0]) ** 2 + (ba[4] - ba[1]) ** 2 + (ba[5] - ba[2]) ** 2;
  const dB2 = (bb[3] - bb[0]) ** 2 + (bb[4] - bb[1]) ** 2 + (bb[5] - bb[2]) ** 2;
  const cap2 = Math.min(dA2, dB2) + pad * pad;   // dentro Y la distanza non supera la sua diagonale
  const Od = Math.sqrt((O[3] - O[0]) ** 2 + (O[4] - O[1]) ** 2 + (O[5] - O[2]) ** 2);
  let pen2 = 0, px = 0, py = 0, pz = 0, measured = false;
  for (let side = 0; side < 2; side++) {
    const X = side ? B : A, Y = side ? A : B;
    const pts = _penSamplePts(X, seeds, side, O, Od);
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i], y = pts[i + 1], z = pts[i + 2];
      if (!pointInMesh(Y, x, y, z)) continue;
      measured = true;
      const d2 = _pointMeshDist2(Y, x, y, z, cap2);
      if (d2 > pen2) { pen2 = d2; px = x; py = y; pz = z; }
    }
  }
  return { pen: Math.sqrt(pen2), point: measured ? [px, py, pz] : null, measured };
}

/* CLEARANCE tra due elementi: distanza minima, riportata solo se < tol.
   opts: { tol: distanza minima richiesta (m, obbligatoria) }
   Ritorna null se dist >= tol, altrimenti { dist, point, pa, pb }.
   Traversata DFS con potatura sulla best corrente; figlio più vicino prima. */
function clearancePair(A, B, opts) {
  const tol = opts && opts.tol;
  if (!(tol > 0)) return null;
  const ba = A.bvh, bb = B.bvh;
  if (!ba.count || !bb.count) return null;
  let best2 = tol * tol;
  let pa = null, pb = null;
  const stack = [0, 0];
  while (stack.length) {
    const jb = stack.pop(), ja = stack.pop();
    if (_nodeDist2(ba, ja, bb, jb) >= best2) continue;
    const leafA = ba.nb[ja] > 0, leafB = bb.nb[jb] > 0;
    if (leafA && leafB) {
      for (let p = ba.na[ja]; p < ba.na[ja] + ba.nb[ja]; p++) {
        const i = ba.order[p], ao = 9 * i, aq = 6 * i;
        for (let q = bb.na[jb]; q < bb.na[jb] + bb.nb[jb]; q++) {
          const j = bb.order[q], bo = 9 * j, bq = 6 * j;
          /* prefiltro: distanza² AABB-AABB dei due triangoli */
          let g2 = 0;
          for (let k = 0; k < 3; k++) {
            const gap = Math.max(A.triAabb[aq + k] - B.triAabb[bq + 3 + k],
              B.triAabb[bq + k] - A.triAabb[aq + 3 + k], 0);
            g2 += gap * gap;
          }
          if (g2 >= best2) continue;
          const d2 = _ttd2(A.tris, ao, B.tris, bo);
          if (d2 < best2) {
            best2 = d2;
            pa = [_cpA[0], _cpA[1], _cpA[2]];
            pb = [_cpB[0], _cpB[1], _cpB[2]];
            if (best2 <= 0) { stack.length = 0; break; }   // contatto: non si scende sotto 0
          }
        }
        if (!stack.length && best2 <= 0) break;
      }
    } else if (leafB || (!leafA &&
        (ba.nMax[3 * ja] - ba.nMin[3 * ja] + ba.nMax[3 * ja + 1] - ba.nMin[3 * ja + 1] + ba.nMax[3 * ja + 2] - ba.nMin[3 * ja + 2]) >=
        (bb.nMax[3 * jb] - bb.nMin[3 * jb] + bb.nMax[3 * jb + 1] - bb.nMin[3 * jb + 1] + bb.nMax[3 * jb + 2] - bb.nMin[3 * jb + 2]))) {
      const l = ba.na[ja], r = -ba.nb[ja];
      if (_nodeDist2(ba, l, bb, jb) <= _nodeDist2(ba, r, bb, jb)) stack.push(r, jb, l, jb);
      else stack.push(l, jb, r, jb);
    } else {
      const l = bb.na[jb], r = -bb.nb[jb];
      if (_nodeDist2(ba, ja, bb, l) <= _nodeDist2(ba, ja, bb, r)) stack.push(ja, r, ja, l);
      else stack.push(ja, l, ja, r);
    }
  }
  if (!pa) return null;
  const dist = Math.sqrt(best2);
  return {
    dist,
    point: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2],
    pa, pb
  };
}

/* ========================================================================== */
/* 5. BROAD PHASE — coppie candidate tra due liste di elementi                */
/* ========================================================================== */

/* itemsA/itemsB: [{key, aabb:[6]}] — key univoca (es. "uid:eid"); lo stesso
   elemento può comparire in entrambi i set (self-clash del set ammesso):
   le coppie (a,b)/(b,a) sono deduplicate e a==b è scartato.
   inflate: gonfiaggio degli AABB (m) — tolleranza clearance o epsilon hard.
   opts: { maxPairs: cap risultati (default 1e6) }
   Ritorna { pairs: [[iA, iB], ...], truncated }. */
function broadPhase(itemsA, itemsB, inflate, opts) {
  const maxPairs = (opts && opts.maxPairs) || 1000000;
  const inf = Math.max(inflate || 0, 0);
  const pairs = [];
  if (!itemsA.length || !itemsB.length) return { pairs, truncated: false };

  /* BVH sul set più piccolo, query col più grande */
  const swap = itemsB.length > itemsA.length;
  const S = swap ? itemsA : itemsB;        // lato indicizzato
  const L = swap ? itemsB : itemsA;        // lato che interroga
  const ab = new Float64Array(6 * S.length);
  for (let i = 0; i < S.length; i++) for (let k = 0; k < 6; k++) ab[6 * i + k] = S[i].aabb[k];
  const bvh = _buildBvh(ab, S.length);

  const seen = new Set();
  let truncated = false;
  const stack = [];
  for (let qi = 0; qi < L.length && !truncated; qi++) {
    const q = L[qi], qa = q.aabb;
    const q0 = qa[0] - inf, q1 = qa[1] - inf, q2 = qa[2] - inf;
    const q3 = qa[3] + inf, q4 = qa[4] + inf, q5 = qa[5] + inf;
    stack.length = 0; stack.push(0);
    while (stack.length) {
      const nIdx = stack.pop();
      if (bvh.nMin[3 * nIdx] > q3 || bvh.nMax[3 * nIdx] < q0 ||
          bvh.nMin[3 * nIdx + 1] > q4 || bvh.nMax[3 * nIdx + 1] < q1 ||
          bvh.nMin[3 * nIdx + 2] > q5 || bvh.nMax[3 * nIdx + 2] < q2) continue;
      if (bvh.nb[nIdx] > 0) {
        for (let p = bvh.na[nIdx]; p < bvh.na[nIdx] + bvh.nb[nIdx]; p++) {
          const si = bvh.order[p], s = S[si];
          const sa = s.aabb;
          if (sa[0] > q3 || sa[3] < q0 || sa[1] > q4 || sa[4] < q1 || sa[2] > q5 || sa[5] < q2) continue;
          if (s.key === q.key) continue;
          const k = s.key < q.key ? s.key + SEP + q.key : q.key + SEP + s.key;
          if (seen.has(k)) continue;
          seen.add(k);
          pairs.push(swap ? [si, qi] : [qi, si]);
          if (pairs.length >= maxPairs) { truncated = true; break; }
        }
        if (truncated) break;
      } else {
        stack.push(bvh.na[nIdx], -bvh.nb[nIdx]);
      }
    }
  }
  return { pairs, truncated };
}

/* ========================================================================== */
/* 6. CLASSI IFC — espansione con le sottoclassi note                         */
/* ========================================================================== */

/* Deciso con l'utente (2026-07-16): chi sceglie "IfcWall" si aspetta anche le
   IfcWallStandardCase (export Revit IFC2x3). Mappa esplicita, niente gerarchia
   di schema: solo i casi *StandardCase/*ElementedCase realmente diffusi. */
const KNOWN_SUBCLASSES = {
  IFCWALL: ["IFCWALLSTANDARDCASE", "IFCWALLELEMENTEDCASE"],
  IFCSLAB: ["IFCSLABSTANDARDCASE", "IFCSLABELEMENTEDCASE"],
  IFCBEAM: ["IFCBEAMSTANDARDCASE"],
  IFCCOLUMN: ["IFCCOLUMNSTANDARDCASE"],
  IFCMEMBER: ["IFCMEMBERSTANDARDCASE"],
  IFCPLATE: ["IFCPLATESTANDARDCASE"],
  IFCDOOR: ["IFCDOORSTANDARDCASE"],
  IFCWINDOW: ["IFCWINDOWSTANDARDCASE"],
  IFCOPENINGELEMENT: ["IFCOPENINGSTANDARDCASE"]
};

/* "IfcWall" -> ["IFCWALL","IFCWALLSTANDARDCASE","IFCWALLELEMENTEDCASE"]
   (nomi normalizzati MAIUSCOLI; il chiamante confronta case-insensitive). */
function expandClassName(name) {
  const up = String(name || "").trim().toUpperCase();
  if (!up) return [];
  return [up, ...(KNOWN_SUBCLASSES[up] || [])];
}

/* ========================================================================== */
/* 7. MATRICE DELLE INTERFERENZE — CSV (formato §6 del piano)                 */
/* ========================================================================== */

/* "0.3"|"0,3"|12 -> numero finito, altrimenti NaN (virgola decimale accettata
   se unica e senza punto — stessa logica di qto.toNumber, duplicata per
   mantenere i moduli indipendenti). */
function _num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  let s = String(v == null ? "" : v).trim();
  if (!s) return NaN;
  if (s.indexOf(",") !== -1) {
    if (s.indexOf(".") !== -1 || s.indexOf(",") !== s.lastIndexOf(",")) return NaN;
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/* Una riga CSV -> campi (gestisce i doppi apici; sep singolo carattere). */
function _splitCsvLine(line, sep) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === sep) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/* Parsing della matrice. Layout:
     ;NomeSetCol1;NomeSetCol2;...
     NomeSetRiga1;cella;cella;...
   Cella: vuota o "-" = non testare · H|X = hard (tolleranza di default) ·
   H:n = hard con tolleranza n mm · numero = clearance n mm (> 0).
   Separatore auto-rilevato (";" preferito, fallback ","). Le tolleranze
   restano in MM qui (unità del file); la conversione a metri è in
   matrixToRules. Ritorna { rows, cols, cells, errors } — cells:
   [{rowName, colName, type:"hard"|"clearance", tolMm|null, r, c}]. */
function parseMatrixCsv(text) {
  const errors = [];
  const lines = String(text || "").split(/\r\n|\n|\r/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return { rows: [], cols: [], cells: [], errors: [{ line: 0, msg: "file vuoto" }] };

  const header = lines[0];
  const sep = header.indexOf(";") !== -1 ? ";" : ",";
  const head = _splitCsvLine(header, sep).map(s => s.trim());
  const cols = head.slice(1);                    // head[0] (angolo) ignorato
  const rows = [], cells = [];

  for (let li = 1; li < lines.length; li++) {
    if (!lines[li].trim()) continue;
    const f = _splitCsvLine(lines[li], sep).map(s => s.trim());
    const rowName = f[0];
    if (!rowName) {
      if (f.some((x, i) => i > 0 && x && x !== "-")) errors.push({ line: li + 1, msg: "riga senza nome set" });
      continue;
    }
    rows.push(rowName);
    for (let c = 1; c < f.length; c++) {
      const t = f[c];
      if (!t || t === "-") continue;
      const colName = cols[c - 1];
      if (!colName) { errors.push({ line: li + 1, msg: `cella "${t}" in colonna ${c + 1} senza nome set` }); continue; }
      let cell = null;
      if (/^[hx]$/i.test(t)) cell = { type: "hard", tolMm: null };
      else {
        const mh = t.match(/^[hx]\s*:\s*(.+)$/i);
        if (mh) {
          const n = _num(mh[1]);
          if (!Number.isFinite(n) || n < 0) { errors.push({ line: li + 1, msg: `tolleranza hard non valida: "${t}" (${rowName}×${colName})` }); continue; }
          cell = { type: "hard", tolMm: n };
        } else {
          const n = _num(t);
          if (!Number.isFinite(n)) { errors.push({ line: li + 1, msg: `cella non riconosciuta: "${t}" (${rowName}×${colName}) — usare H, H:mm o un numero (mm)` }); continue; }
          if (n <= 0) { errors.push({ line: li + 1, msg: `clearance deve essere > 0 mm: "${t}" (${rowName}×${colName}) — per il solo contatto usare H` }); continue; }
          cell = { type: "clearance", tolMm: n };
        }
      }
      cell.rowName = rowName; cell.colName = colName; cell.r = rows.length - 1; cell.c = c - 1;
      cells.push(cell);
    }
  }
  return { rows, cols, cells, errors };
}

/* Serializza {rows, cols, cells} in CSV (round-trip di parseMatrixCsv).
   opts: { sep: ";" (default), decimal: "," (default, coerente con sep ;) } */
function matrixToCsv(parsed, opts) {
  const sep = (opts && opts.sep) || ";";
  const dec = (opts && opts.decimal) || (sep === ";" ? "," : ".");
  const fld = (s) => {
    s = String(s == null ? "" : s);
    return (s.indexOf(sep) !== -1 || s.indexOf('"') !== -1 || /[\r\n]/.test(s))
      ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const numS = (n) => String(n).replace(".", dec);
  const cellS = (c) => !c ? "" :
    c.type === "hard" ? (c.tolMm == null ? "H" : "H:" + numS(c.tolMm)) : numS(c.tolMm);
  const grid = new Map();   // "r|c" -> cell
  for (const c of parsed.cells) grid.set(c.rowName + SEP + c.colName, c);
  const lines = [[""].concat(parsed.cols).map(fld).join(sep)];
  for (const r of parsed.rows) {
    lines.push([fld(r)].concat(parsed.cols.map(cn => cellS(grid.get(r + SEP + cn)))).join(sep));
  }
  return lines.join("\r\n") + "\r\n";
}

/* Celle -> regole deduplicate. La matrice è concettualmente simmetrica:
   (A,B) e (B,A) collassano su una regola sola; in caso di conflitto vince la
   più severa (hard > clearance; tra hard la tolleranza MINORE — scarta meno;
   tra clearance la MAGGIORE — controlla più distanza). Diagonale ammessa
   (self-clash del set). Tolleranze convertite mm -> m.
   opts: { defaultHardTolMm: 1 } — Navisworks-style: compenetrazioni sotto
   il mm sono rumore di modellazione, non clash. */
function matrixToRules(parsed, opts) {
  const defHard = (opts && opts.defaultHardTolMm !== undefined) ? opts.defaultHardTolMm : 1;
  const byPair = new Map();
  for (const c of parsed.cells) {
    const a = c.rowName, b = c.colName;
    const key = a < b ? a + SEP + b : b + SEP + a;
    const tolMm = c.type === "hard" ? (c.tolMm == null ? defHard : c.tolMm) : c.tolMm;
    const prev = byPair.get(key);
    if (!prev) { byPair.set(key, { aName: a <= b ? a : b, bName: a <= b ? b : a, type: c.type, tolMm }); continue; }
    if (prev.type === c.type) {
      prev.tolMm = c.type === "hard" ? Math.min(prev.tolMm, tolMm) : Math.max(prev.tolMm, tolMm);
    } else if (prev.type === "clearance" && c.type === "hard") {
      prev.type = "hard"; prev.tolMm = tolMm;
    } /* prev hard + cella clearance: resta hard */
  }
  const rules = [];
  for (const r of byPair.values()) {
    r.tol = r.tolMm / 1000;
    r.id = `${r.aName}|${r.bName}|${r.type}|${r.tolMm}`;
    rules.push(r);
  }
  return { rules };
}

/* ========================================================================== */
/* 8. PERSISTENZA STATI — chiave stabile di un clash tra un run e l'altro     */
/* ========================================================================== */

/* GUID (non expressID: sopravvivono al re-import del file) + id regola.
   Ordinamento canonico: (A,B) e (B,A) sono lo stesso clash. */
function clashKey(guidA, guidB, ruleId) {
  return (guidA < guidB ? guidA + "|" + guidB : guidB + "|" + guidA) + "|" + ruleId;
}

export {
  EPS_PLANE,
  triTriIntersect, triTriDistance,
  TriBvh, hardPair, clearancePair,
  penetrationPair, pointInMesh,
  broadPhase,
  KNOWN_SUBCLASSES, expandClassName,
  parseMatrixCsv, matrixToCsv, matrixToRules,
  clashKey
};

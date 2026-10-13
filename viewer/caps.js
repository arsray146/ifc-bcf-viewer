/* ============================================================================
   Tappi delle sezioni (v2.10.2) — modulo puro, senza import: test/test_caps.js.

   Con un piano di taglio attivo (section box, piano su faccia, sezione ⟂ dell'asse)
   three.js scarta i frammenti dalla parte tolta e gli elementi restano GUSCI VUOTI.
   Qui si calcola la faccia piena sul piano, come nel taglio della vista di Sviluppo
   profili (tools/profile-sweep, C.sliceLoops / C.nestLoops, 0.10–0.14):
   - per ogni elemento (un range di triangoli del bucket) attraversato dal piano si
     prendono i soli triangoli tagliati, si uniscono i vertici per POSIZIONE (web-ifc
     duplica i vertici a ogni faccia per le normali) e si concatenano i segmenti in
     anelli chiusi; le catene che non si chiudono (mesh non a tenuta) diventano solo
     contorno;
   - gli anelli, portati nel 2D del piano, si annidano (pari = esterno, dispari = foro)
     e si triangolano con la funzione passata dal chiamante (THREE.ShapeUtils);
   - il tappo si scosta di `eps` dalla parte tenuta, così lo stesso piano non lo taglia
     e gli ALTRI piani attivi (le facce del box) lo rifilano col clipping normale.
   Piano come in three.js: distanza = n·p + c, si tiene la parte con distanza ≥ 0.
   ============================================================================ */

/** Ingombro di ogni range { start, count } (triangoli) di una geometria indicizzata:
 *  Float32Array con [minx, miny, minz, maxx, maxy, maxz] per range. */
export function rangeBoxes(pos, index, ranges) {
  const out = new Float32Array(ranges.length * 6);
  for (let r = 0; r < ranges.length; r++) {
    const a = ranges[r].start * 3, b = a + ranges[r].count * 3;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = a; k < b; k++) {
      const v = index[k] * 3, x = pos[v], y = pos[v + 1], z = pos[v + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    out.set([x0, y0, z0, x1, y1, z1], r * 6);
  }
  return out;
}

/** Il piano { nx, ny, nz, c } attraversa l'ingombro r? (centro e semidiagonale proiettati) */
export function boxCrosses(boxes, r, p) {
  const o = r * 6;
  const cx = (boxes[o] + boxes[o + 3]) / 2, cy = (boxes[o + 1] + boxes[o + 4]) / 2, cz = (boxes[o + 2] + boxes[o + 5]) / 2;
  const ex = (boxes[o + 3] - boxes[o]) / 2, ey = (boxes[o + 4] - boxes[o + 1]) / 2, ez = (boxes[o + 5] - boxes[o + 2]) / 2;
  if (!(ex >= 0)) return false;                                   // range vuoto (ingombro infinito)
  const d = p.nx * cx + p.ny * cy + p.nz * cz + p.c;
  const e = Math.abs(p.nx) * ex + Math.abs(p.ny) * ey + Math.abs(p.nz) * ez;
  return Math.abs(d) <= e;
}

/** L'ingombro r sta tutto dalla parte tolta del piano p (distanza < 0 ovunque)? Allora un altro piano
 *  lo nasconde per intero e il suo tappo non serve. */
export function boxOutside(boxes, r, p) {
  const o = r * 6;
  const x = p.nx >= 0 ? boxes[o + 3] : boxes[o], y = p.ny >= 0 ? boxes[o + 4] : boxes[o + 1], z = p.nz >= 0 ? boxes[o + 5] : boxes[o + 2];
  return p.nx * x + p.ny * y + p.nz * z + p.c < 0;          // il vertice più avanti lungo la normale
}

/**
 * Fetta dei triangoli [start, start + count) col piano p { nx, ny, nz, c }.
 * weld = distanza sotto la quale due punti di taglio sono lo stesso punto (m).
 * I punti di taglio si uniscono per POSIZIONE, non per lato: le booleane di web-ifc lasciano
 * giunzioni a T (il lato lungo di un triangolo contro due lati corti dei vicini, coi vertici
 * propri) e unendo i lati la fetta non si chiudeva (soletta con aperture, muro con un foro:
 * M2_200_EX_BIM_252, 2.10.2). I segmenti che compaiono un numero pari di volte (facce interne
 * doppie) si annullano. Ritorna { loops: [number[] (x, y, z di seguito)], open: number[]
 * (segmenti x,y,z,x,y,z delle catene che restano aperte: mesh non a tenuta) }.
 */
export function sliceRange(pos, index, start, count, p, weld = 1e-4) {
  const a = start * 3, b = a + count * 3, q = 1 / weld, w2 = weld * weld;
  const F = (v) => p.nx * pos[3 * v] + p.ny * pos[3 * v + 1] + p.nz * pos[3 * v + 2] + p.c;
  // griglia di passo weld: un punto nuovo cerca un gemello nelle 27 celle vicine
  const X = [], grid = new Map();
  const pid = (x, y, z) => {
    const i = Math.floor(x * q), j = Math.floor(y * q), k = Math.floor(z * q);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
      const l = grid.get((i + di) + "," + (j + dj) + "," + (k + dk));
      if (l) for (const id of l) {
        const dx = X[3 * id] - x, dy = X[3 * id + 1] - y, dz = X[3 * id + 2] - z;
        if (dx * dx + dy * dy + dz * dz <= w2) return id;
      }
    }
    const id = X.length / 3, kk = i + "," + j + "," + k, l = grid.get(kk);
    X.push(x, y, z);
    if (l) l.push(id); else grid.set(kk, [id]);
    return id;
  };
  // punto sul lato u–v; ordinato per F, così i due triangoli del lato fanno lo stesso conto
  const cut = (u, v, fu, fv) => {
    if (fu > fv) { const t = u; u = v; v = t; const g = fu; fu = fv; fv = g; }
    const t = fu / (fu - fv);
    return pid(pos[3 * u] + t * (pos[3 * v] - pos[3 * u]), pos[3 * u + 1] + t * (pos[3 * v + 1] - pos[3 * u + 1]), pos[3 * u + 2] + t * (pos[3 * v + 2] - pos[3 * u + 2]));
  };
  const segs = new Map();
  for (let k = a; k < b; k += 3) {
    const ia = index[k], ib = index[k + 1], ic = index[k + 2];
    const fa = F(ia), fb = F(ib), fc = F(ic);
    const sa = fa >= 0, sb = fb >= 0, sc = fc >= 0;
    if (sa === sb && sb === sc) continue;
    const e = [];
    if (sa !== sb) e.push(cut(ia, ib, fa, fb));
    if (sb !== sc) e.push(cut(ib, ic, fb, fc));
    if (sc !== sa) e.push(cut(ic, ia, fc, fa));
    if (e.length !== 2 || e[0] === e[1]) continue;
    const kk = Math.min(e[0], e[1]) * 4294967296 + Math.max(e[0], e[1]);   // intero esatto fino a 2 M punti
    const sg = segs.get(kk);
    if (sg) sg[2]++; else segs.set(kk, [e[0], e[1], 1]);
  }
  const A = [], B = [];
  for (const sg of segs.values()) if (sg[2] % 2) { A.push(sg[0]); B.push(sg[1]); }
  // segmenti → anelli
  const adj = new Map(), add = (pt, s) => { const l = adj.get(pt); if (l) l.push(s); else adj.set(pt, [s]); };
  for (let s = 0; s < A.length; s++) { add(A[s], s); add(B[s], s); }
  const used = new Uint8Array(A.length), loops = [], open = [];
  for (let s0 = 0; s0 < A.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const st = A[s0], chain = [st];
    let cur = B[s0], closed = false;
    for (;;) {
      if (cur === st) { closed = true; break; }
      chain.push(cur);
      let nx = -1;
      for (const s of adj.get(cur)) if (!used[s]) { nx = s; break; }
      if (nx < 0) break;
      used[nx] = 1;
      cur = A[nx] === cur ? B[nx] : A[nx];
    }
    if (closed && chain.length >= 3) {
      const xyz = [];
      for (const id of chain) xyz.push(X[3 * id], X[3 * id + 1], X[3 * id + 2]);
      loops.push(xyz);
    } else {
      for (let i = 0; i + 1 < chain.length; i++) { const u = chain[i], v = chain[i + 1]; open.push(X[3 * u], X[3 * u + 1], X[3 * u + 2], X[3 * v], X[3 * v + 1], X[3 * v + 2]); }
    }
  }
  return { loops, open };
}

const shoelace = (P) => { let s = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; s += p[0] * q[1] - q[0] * p[1]; } return s / 2; };

/**
 * Anelli piani [[x, y], …] → regioni da riempire: ogni esterno coi suoi fori per profondità di
 * annidamento (pari = esterno, dispari = foro del più piccolo che lo contiene); il verso non conta.
 * Ritorna [{ outer, holes, area }]. (Come nestLoops di tools/profile-sweep/profile-core.js.)
 */
export function nestLoops(L) {
  const area = L.map((r) => Math.abs(shoelace(r)));
  const inside = ([x, y], r) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < xi + (y - yi) * (xj - xi) / (yj - yi)) c = !c;
    }
    return c;
  };
  // un punto un poco dentro l'anello: il medio del lato più lungo spostato verso l'interno
  const probe = (r) => {
    const s = Math.sign(shoelace(r)) || 1;
    let best = 0, bl = -1;
    for (let i = 0; i < r.length; i++) { const q = r[(i + 1) % r.length], l = Math.hypot(q[0] - r[i][0], q[1] - r[i][1]); if (l > bl) { bl = l; best = i; } }
    const p = r[best], q = r[(best + 1) % r.length], e = 1e-6 * Math.max(1, bl);
    return [(p[0] + q[0]) / 2 - s * (q[1] - p[1]) / bl * e, (p[1] + q[1]) / 2 + s * (q[0] - p[0]) / bl * e];
  };
  const parent = L.map(() => -1), depth = L.map(() => 0);
  L.forEach((r, k) => {
    if (!(area[k] > 0)) return;
    const pt = probe(r);
    L.forEach((o, j) => {
      if (j === k || !(area[j] > area[k]) || !inside(pt, o)) return;
      depth[k]++;
      if (parent[k] < 0 || area[j] < area[parent[k]]) parent[k] = j;
    });
  });
  const out = [];
  L.forEach((r, k) => { if (area[k] > 0 && depth[k] % 2 === 0) out.push({ outer: k, holes: [], area: area[k] }); });
  L.forEach((r, k) => {
    if (!(area[k] > 0) || depth[k] % 2 === 0) return;
    const o = out.find((x) => x.outer === parent[k]);
    if (o) { o.holes.push(k); o.area -= area[k]; }
  });
  return out;
}

/** Base ortonormale (u, v) del piano di normale n. */
export function planeBasis(nx, ny, nz) {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  let ux, uy, uz;                                                  // u = n × asse meno allineato
  if (ax <= ay && ax <= az) { ux = 0; uy = nz; uz = -ny; }
  else if (ay <= az) { ux = -nz; uy = 0; uz = nx; }
  else { ux = ny; uy = -nx; uz = 0; }
  const l = Math.hypot(ux, uy, uz); ux /= l; uy /= l; uz /= l;
  return { u: [ux, uy, uz], v: [ny * uz - nz * uy, nz * ux - nx * uz, nx * uy - ny * ux] };
}

/**
 * Anelli 3D sul piano p → triangoli del tappo, accodati a pv (x, y, z) e ix; i contorni vanno in
 * lines. triangulate(contour, holes) → [[i, j, k], …] indici nei punti di contour seguiti da quelli
 * dei fori (la firma di THREE.ShapeUtils.triangulateShape con array [x, y]). eps = scostamento del
 * tappo verso la parte tenuta. Ritorna il numero di regioni riempite.
 */
export function capLoops(loops, p, triangulate, pv, ix, lines, eps = 1e-3, basis = planeBasis(p.nx, p.ny, p.nz)) {
  const { u, v } = basis, L2 = [], L3 = [];
  const ox = p.nx * eps, oy = p.ny * eps, oz = p.nz * eps;
  for (const lp of loops) {
    const a = [], b = [];
    for (let i = 0; i < lp.length; i += 3) {
      const x = lp[i], y = lp[i + 1], z = lp[i + 2];
      const q = [x * u[0] + y * u[1] + z * u[2], x * v[0] + y * v[1] + z * v[2]], l = a[a.length - 1];
      if (l && Math.abs(l[0] - q[0]) < 1e-9 && Math.abs(l[1] - q[1]) < 1e-9) continue;
      a.push(q); b.push(x, y, z);
    }
    while (a.length > 1 && Math.abs(a[0][0] - a[a.length - 1][0]) < 1e-9 && Math.abs(a[0][1] - a[a.length - 1][1]) < 1e-9) { a.pop(); b.length -= 3; }
    // punti allineati (le diagonali delle facce triangolate tagliano il lato a metà): via
    for (let i = 0; a.length > 3 && i < a.length;) {
      const p0 = a[(i + a.length - 1) % a.length], p1 = a[i], p2 = a[(i + 1) % a.length];
      const ux = p1[0] - p0[0], uy = p1[1] - p0[1], wx = p2[0] - p1[0], wy = p2[1] - p1[1];
      const cr = ux * wy - uy * wx, lu = Math.hypot(ux, uy), lw = Math.hypot(wx, wy);
      if (Math.abs(cr) <= 1e-9 * lu * lw && ux * wx + uy * wy > 0) { a.splice(i, 1); b.splice(3 * i, 3); }
      else i++;
    }
    L2.push(a); L3.push(b);
    for (let i = 0; i < b.length; i += 3) {
      const j = (i + 3) % b.length;
      lines.push(b[i] + ox, b[i + 1] + oy, b[i + 2] + oz, b[j] + ox, b[j + 1] + oy, b[j + 2] + oz);
    }
  }
  let n = 0;
  for (const r of nestLoops(L2)) {
    const ids = [r.outer, ...r.holes], lo = L2[r.outer];
    if (ids.some((k) => L2[k].length < 3)) continue;
    let per = 0;
    for (let i = 0; i < lo.length; i++) { const q = lo[(i + 1) % lo.length]; per += Math.hypot(q[0] - lo[i][0], q[1] - lo[i][1]); }
    if (r.area < 1e-4 * per) continue;                           // fettina più sottile di ~0,2 mm: solo il contorno
    let faces;
    try { faces = triangulate(L2[r.outer], r.holes.map((k) => L2[k])); } catch (_) { continue; }
    if (!faces || !faces.length) continue;
    const base = pv.length / 3;
    for (const k of ids) { const b = L3[k]; for (let i = 0; i < b.length; i += 3) pv.push(b[i] + ox, b[i + 1] + oy, b[i + 2] + oz); }
    for (const f of faces) ix.push(base + f[0], base + f[1], base + f[2]);
    n++;
  }
  return n;
}

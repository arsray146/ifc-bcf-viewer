libredwg-web 0.7.14 — lettore DWG/DXF in WebAssembly basato su GNU LibreDWG.
Pacchetto npm "@mlightcad/libredwg-web" (https://github.com/mlightcad/libredwg-web),
file copiati tali e quali, senza modifiche:
  dist/libredwg-web.js      involucro JavaScript (classe LibreDwg)
  wasm/libredwg-web.js      codice di raccordo di Emscripten
  wasm/libredwg-web.wasm    LibreDWG compilato (sola lettura: niente scrittura DWG/DXF)

Licenza: GNU General Public License v3 (testo in LICENSE-GPL-3.0.txt),
compatibile con la AGPL-3.0 di viewifc.com. Sorgenti corrispondenti:
  https://github.com/mlightcad/libredwg-web  (tag v0.7.14)
  https://www.gnu.org/software/libredwg/

Usato da «Sviluppo profili» (tools/profile-sweep/) solo quando si apre un
.dwg: il .wasm (9,5 MB) si scarica una volta e per OGNI file si crea
un'istanza nuova — riusare la stessa istanza per un secondo disegno manda in
crash la lettura dell'intestazione (provato il 2026-10-04 sui DWG AC1032
dell'utente).

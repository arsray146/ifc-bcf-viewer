# Third-party licenses

APE Viewer (Viewer IFC · BCF) is released under the **GNU AGPL-3.0** — see
[`LICENSE`](../../LICENSE) in the repository root.

This file lists every third-party component the viewer **ships or loads**, with
its license, copyright holder and where to read the full text. Everything listed
here is delivered to the visitor's browser, so the notices below travel with the
application, not just with the source repository.

## Bundled in this folder

| Component | Version | License | Copyright | Upstream |
|---|---|---|---|---|
| three.js (`three.module.js`) | 0.160.0 (r160) | MIT | © 2010-2023 Three.js Authors | https://github.com/mrdoob/three.js |
| three.js addons (`three-addons/controls/OrbitControls.js`) | r160 | MIT | © 2010-2023 Three.js Authors | https://github.com/mrdoob/three.js |
| web-ifc (`web-ifc-api.js`) | 0.0.77 | MPL-2.0 | © web-ifc contributors | https://github.com/ThatOpen/engine_web-ifc |
| web-ifc WebAssembly binary (`web-ifc.wasm`) | 0.0.77 | MPL-2.0 | © web-ifc contributors | https://github.com/ThatOpen/engine_web-ifc |

Full license texts, in this same folder:

- [`LICENSE-three.js.txt`](LICENSE-three.js.txt) — MIT, covering three.js and its addons
- [`LICENSE-web-ifc.txt`](LICENSE-web-ifc.txt) — Mozilla Public License 2.0, covering web-ifc

## Loaded at runtime from a CDN

These are not redistributed from this repository, but the application causes the
browser to fetch them, so they are listed for completeness:

| Component | Version | License | Upstream |
|---|---|---|---|
| JSZip | 3.10.1 | MIT **or** GPL-3.0-or-later (used here under **MIT**) | https://stuk.github.io/jszip/ |
| Barlow Semi Condensed | — | SIL Open Font License 1.1 | https://fonts.google.com/specimen/Barlow+Semi+Condensed |
| IBM Plex Sans / IBM Plex Mono | — | SIL Open Font License 1.1 | https://fonts.google.com/specimen/IBM+Plex+Sans |

## Compatibility notes

- **three.js — MIT.** Permissive and compatible with AGPL-3.0. The copyright
  notice and `SPDX-License-Identifier: MIT` are preserved in the header of
  `three.module.js` as the license requires.
- **web-ifc — MPL-2.0.** File-level copyleft: it can be combined with code under
  a different license, but modifications *to web-ifc's own files* must remain
  under MPL-2.0. The build shipped here is redistributed **unmodified**. It
  carries no "Incompatible With Secondary Licenses" notice, so under MPL-2.0
  §3.3 it can be distributed as part of a work licensed under the GNU AGPL-3.0.
- **JSZip** is dual-licensed; this project uses it under the MIT option.

## Maintenance

Vendored files are deliberately kept **byte-identical to upstream** — no headers
added, no patches applied — so their provenance stays verifiable and a version
bump is a plain file swap. That is why the notices live in this file instead of
being injected into the libraries themselves.

When bumping a vendored version: update the table above, re-download the license
text if upstream changed it, and check whether the new release added an
"Incompatible With Secondary Licenses" notice (for MPL components) — that would
change the compatibility conclusion above.

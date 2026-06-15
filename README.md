# Viewer IFC · BCF — a free, open-source BIM viewer in your browser

A free and open-source **IFC and BCF viewer** that runs entirely **in your browser**. Open and federate IFC models, review **BCF issues** and Solibri reports, inspect elements and their property sets, slice with a section box, edit properties in the 3D view and re-export an updated IFC — all in a single page, with **nothing to install** and **no upload**.

**Your models never leave your computer.** Parsing happens locally via [web-ifc](https://github.com/ThatOpen/engine_web-ifc) (WebAssembly). No server, no account, no cloud — privacy by design.

> **Keywords:** IFC viewer · BCF viewer · online IFC viewer · web BIM viewer · openBIM · BIM coordination · web-ifc · IFC2x3 · IFC4 · IFC4x3 · Solibri report viewer · free IFC viewer

---

## Why this viewer

Most online IFC viewers either upload your model to a server or stop at visualization. This one is a **coordination viewer, not just a visualization viewer**, and it is **100% client-side**:

- **No upload.** Files are read from your machine and parsed in the browser. Nothing is sent anywhere.
- **No account, no tracking.** Open the page and start working.
- **One file, no install.** The viewer is a single self-contained HTML page.
- **Open source (AGPL-3.0).** Inspect it, fork it, run it yourself.

---

## Features

- **Federated models** — load multiple IFC files and explore them together, federated on the first model. Supports **IFC2x3, IFC4 and IFC4x3**.
- **BCF issues & Solibri reports** — open BCF topics and Solibri reports with viewpoints, comments and snapshots. Filter the component list to show only elements actually present in the loaded models.
- **Section & inspect** — orbit or walk the model, clip it with a Revit-style section box, and inspect any element together with its property sets.
- **Edit & re-export** — change element properties directly in the 3D view and export an updated IFC, ready for the next coordination round.

---

## Privacy by design

| Aspect            | This viewer                          |
|-------------------|--------------------------------------|
| Processing        | Client-side, in your browser         |
| Engine            | web-ifc (WebAssembly)                |
| File upload       | None                                 |
| Account           | Not required                         |
| Cloud / server    | None                                 |
| Formats           | IFC2x3 · IFC4 · IFC4x3 · BCF · Solibri report |

---

## Quick start

No build step. The viewer is a standalone HTML file.

1. Download `Viewer_IFC_BCF_V1_9_5.html` (or the latest version).
2. Open it in a modern Chromium-based browser (**Chrome** or **Edge** recommended).
3. Click **Load IFC**, select one or more `.ifc` files, then optionally **Load BCF**.

On first run the viewer fetches the rendering engine from a CDN (see below), so an internet connection is needed the first time.

### Run it locally as a website

To serve the landing page and the viewer together (e.g. for a LAN or a static host), just serve the folder with any static server:

```bash
# Python 3
python -m http.server 8080

# or Node
npx serve .
```

Then open `http://localhost:8080/`.

---

## Tech stack

- **Rendering:** [three.js](https://threejs.org/) `0.160.0` (MIT)
- **IFC parsing:** [web-ifc](https://github.com/ThatOpen/engine_web-ifc) `0.0.77` (Mozilla Public License 2.0), WebAssembly
- **App:** plain HTML / CSS / JavaScript, no framework, single-file build
- **Fonts:** Barlow Semi Condensed, IBM Plex Sans, IBM Plex Mono

> Dependencies are loaded from a CDN on first launch. To run fully offline, vendor `three` and `web-ifc` locally and update the import map in the HTML.

---

## Project structure

```
index.html                     # Landing page (bilingual IT/EN)
Viewer_IFC_BCF_V1_9_5.html     # The viewer (single-file app)
favicon.svg                    # Icon (lime square + bee mark)
favicon-32.png                 # Fallback favicon
apple-touch-icon.png           # iOS home-screen icon
robots.txt                     # Crawl directives
sitemap.xml                    # Sitemap
LICENSE                        # GNU AGPL-3.0
```

---

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)** — see [`LICENSE`](LICENSE).

In short: you are free to use, study, modify and redistribute this software. If you run a modified version as a network service, the AGPL requires you to make the corresponding source code available to its users.

```
Viewer IFC · BCF
Copyright (C) 2026 Alessandro Perugini

This program is free software: you can redistribute it and/or modify it
under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
```

### Third-party licenses

- **three.js** — MIT License
- **web-ifc** — Mozilla Public License 2.0

Both are compatible with AGPL-3.0. Their respective copyrights and license terms belong to their authors.

---

## Disclaimer

This software is provided **"as is", without warranty of any kind**, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and non-infringement. In no event shall the author be liable for any claim, damages or other liability arising from the use of this software. Always verify results against your authoring tools and project requirements before relying on them for design or construction decisions.

---

## Author

**Alessandro Perugini** — BIM Coordinator
Built as an open tool for the openBIM community.

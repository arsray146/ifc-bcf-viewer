# Trazione elettrica / Railway OCS (tool 18)

**0.8.0 (2026-10-12, prova dell'utente)**: albero degli elementi come Sviluppo profili (icone, gruppi Contesto e Supercompattato col «+», classi IFC con l'occhio, rinomina col doppio clic); fusto dei pali di partenza col traliccio; taglio della vista **Sezione ⟂ / Lungo l'asse** (X, L) come Sviluppo profili, con tappi sul contesto; del supercompattato solo la faccia di riferimento, in arancione (PIANO §18). **0.7.0 (2026-10-12)**: fondazioni sul **supercompattato** scelto in un IFC di contesto (anche 2x3: un IFC senza asse si apre come contesto) — clic su un elemento, Ctrl+clic per aggiungere o togliere, «tutti quelli uguali» per nome/tipo/layer/Pset (proposto il criterio che parla di supercompattato); nel progetto si salva la sola superficie scelta. Testa del pilastrino = supercompattato sotto l'asse del palo + **0,25 m** (modificabile per binario, tratto e palo); fuori dalla superficie il bordo entro 2 m, oltre la quota di partenza; avvisi per dislivello PF → filo pilastrino oltre 0,75 m e per il palo che non arriva al tirante (PIANO §17). **0.5.0–0.6.0**: portali e modulo Pset comune (F3), picchettamento automatico (F4). **0.1.0 (F1, prima parte, 2026-10-11)**: binari dal LandXML (clotoidi, raccordi circolari, sopraelevazione), offset, vista 3D, pianta ortografica (T), modalità fast (Q), profilo e sezione al punto. **0.1.1**: scritte del profilo senza sovrapposizioni, sezione al punto che segue il mouse (PIANO §11.2). **0.4.0**: F2 chiusa — tratti da/a progressiva, import della tabella di picchettamento (CSV/XLSX), seconda mensola (PIANO §14). **0.3.0**: F1 chiusa — assi anche da IFC 4x3 (IfcAlignment) e da DWG/DXF di pianta e profilo (lettore di Sviluppo profili), annulla su tutto il documento. **0.2.0 (F2, prima parte)**: sostegni piazzati a mano — pali LSU con mensola, tirante, filo, fondazione E 64865, trasformatori e sezionatori su palo; tabella e sezione al palo (PIANO §12). Pagina `noindex`, non linkata. File: `index.html`, `ocs-core.js`, `ocs-catalog.js`, `ocs-io.js`, `ocs-stake.js` (+ `../common/pset-core.js`; al bisogno `../profile-sweep/profile-io.js`, `profile-core.js`, `../terrain-sculptor/terrain-io.js` e il web-ifc del viewer). Il piano completo (fatti misurati, catalogo, fasi, cose aperte) è in [`PIANO_Trazione_Elettrica.md`](../../PIANO_Trazione_Elettrica.md); qui sotto il riassunto delle decisioni.

Base: `tools/profile-sweep/` (interfaccia, pianta+profilo, ancoraggi, editing, DTM, contesto, tagli, sezioni correnti, tavole, IFC 4x3). Scopo: piazzare sostegni e apparecchiature lungo il tracciato. **Niente condutture per ora.**

## Decisioni dell'utente (2026-10-09)

| Tema | Scelta |
|---|---|
| Sistemi | 3 kV c.c. RFI, 2×25 kV c.a. AV/AC, 750 V tram/metro |
| Norme | specifiche RFI (le passa l'utente) **e** EN 50119 |
| Uso | progettare il picchettamento **e** modellare tabelle esistenti |
| Asse | DWG pianta+profilo, LandXML, IFC con IfcAlignment |
| Offset dell'asse | l'alignment ricevuto non sempre è in asse binario → **offset costante + a tratti** |
| Sopraelevazione | sì, **orienta gli oggetti** (piano del ferro inclinato) |
| Progressive | continua + numerazione libera configurabile |
| Stazioni | sì (più binari, portali); deviatoi come zone escluse |
| Oggetti prima versione | **pali + mensole, portali, trasformatori su palo, sezionatori su palo**; ormeggi, galleria, viadotto, SSE dopo |
| Geometria | parametrica per i tipi base + import di blocchi; livello di dettaglio a scelta per tipo |
| Distanza palo–binario | default per tipo, eccezioni per tratto e per palo |
| Fondazioni | sì, **solo il solido** (niente scavi); quota **dal supercompattato** del corpo ferroviario, scelto in un IFC di contesto (2026-10-12; in futuro anche disegnato qui): testa del pilastrino +250 mm, modificabile |
| Ordine | **prima piazzamento manuale**, poi proposta automatica |
| Regole automatiche | campate in retta/curva (dal raggio), pali appaiati |
| Vincoli | tagli del Profile Sweep (faccia/riga), intervalli a numeri, punti obbligati |
| Filo di contatto | altezza e poligonazione **come parametri** (dimensionano la mensola, controllo) |
| Sezioni correnti | **una per palo**: contesto + DTM, palo e mensola quotati, quote notevoli, **sagoma limite RFI e EN 15273** |
| Contesto IFC | da Revit e Civil 3D |
| Schemi IFC | **2x3, 4, 4x3** (più commesse); si parte dal 4x3 |
| Pset | **modulo Pset** configurabile (in comune col Profile Sweep) |
| Uscite | IFC, DXF 2D a blocchi, .3dm, **pacchetto per Revit (pyRevit/add-in che piazza le famiglie)** |
| Tavole | planimetria di picchettamento, sezioni ai pali, profilo con i pali |
| Codice | **import dei moduli puri da `../profile-sweep/`** (deploy insieme quando cambiano) |
| Pianta | vista **ortografica** (anche fix nel Profile Sweep) |
| Modalità fast | passo sezioni 1 m ↔ 10 m al volo; **all'export avviso + scelta** (anche nel Profile Sweep) |
| Pubblicazione | solo pagina **non linkata**; card e pagine del sito quando sarà pronto |
| File per la F0 | tracciato + specifiche RFI (dall'utente) |

## Fasi (ordine concordato)

F0 ricognizione sui file → F1 base + asse (offset, sopraelevazione, binari) → F2 piazzamento manuale (pali, mensole, trafi, sezionatori) → **F3 portali + modulo Pset** → F4 picchettamento automatico → F5 terreno e fondazioni → F6 uscite (IFC 4x3 → 4 → 2x3, DXF, .3dm, Revit) → F7 tavole.

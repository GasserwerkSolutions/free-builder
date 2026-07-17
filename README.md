# Free Salon Website Builder

Ein bewusst fokussierter Website-Builder für Coiffeur-Salons. Er ist der kostenlose Einstieg in das Buchungs-SaaS von Gasserwerk Solutions.

## Aktueller technischer Stand

Die Oberfläche bleibt eine statische Anwendung, ihre Logik ist aber in native TypeScript-/ES-Module aufgeteilt:

- `BuilderDraftV2` als versionierter Datenvertrag
- deterministische V1→V2-Migration
- IndexedDB für Drafts und spätere Bild-Blobs
- `localStorage` enthält nur die aktive `draftId`
- unveränderliche `clientId` für Services, Mitarbeitende und Relationen
- eingebaute Wochenplan- und Team-Readiness-Validierung
- Node-Test-Runner ohne zusätzliches Testframework
- reproduzierbarer TypeScript-Build mit gepinnter Version

Die kompilierten Browsermodule liegen unter `assets/` und werden bewusst mitcommittet. Dadurch bleibt die Anwendung direkt statisch auslieferbar; CI verifiziert, dass die Artefakte aus `src/` reproduzierbar gebaut werden können.

## Produktgrenze dieser Stufe

Enthalten:

- Salonprofil und Kontaktdaten
- direkt bearbeitbare Website-Texte
- gemeinsamer Service- und Preiskatalog
- Dauer, Preisart und Buchbarkeit pro Leistung
- strukturierter Wochenplan mit mehrspannigem Datenvertrag
- Teamkarten mit expliziter Mitarbeiter–Leistungs-Zuordnung
- persönliche Arbeitszeiten ohne stillen Default
- Team-Projektion in Website und JSON-LD
- vier kuratierte Designrichtungen
- optional bis zu drei manuelle Kundenstimmen
- lokales Autosave in IndexedDB
- responsive Live-Vorschau
- Export als einzelne HTML-Datei
- sichere Migration bestehender V1-Entwürfe

Bewusst noch nicht als produktiv fertig bezeichnet:

- lokale Bildauswahl und Upload
- Magic-Link-Aktivierung
- Tenant-/CMS-/Booking-Synchronisierung
- direkte Veröffentlichung
- externe Bewertungs-APIs

Buchungs- und Bild-URLs aus V1 werden nicht als neue Datenwahrheit übernommen. Eine frühere Titelbild-URL wird nur als sichtbarer Migrationshinweis bewahrt; die Datei muss später bewusst neu ausgewählt werden.

## Entwicklung

Voraussetzungen: Node.js 20 oder neuer.

```bash
npm ci
npm run check
python3 -m http.server 8080
```

Danach `http://localhost:8080` öffnen.

Weitere Befehle:

```bash
npm run typecheck
npm run build
npm test
```

## Daten- und Speichervertrag

IndexedDB-Datenbank: `gasserwerk-free-builder`

```text
drafts      key: draftId   value: BuilderDraftV2
assetBlobs  key: localId   value: Blob
meta        activeDraftId | schemaVersion | lastCleanupAt
```

`localStorage` enthält ausschliesslich den Pointer `gasserwerk-free-salon-builder-active-draft`. Ein alter V1-Eintrag wird erst gelöscht, nachdem der migrierte V2-Draft erfolgreich persistent geschrieben wurde.

Der verbindliche Ausbauplan liegt unter `docs/BUILDER-SAAS-AKTIVIERUNGSPLAN.md`.

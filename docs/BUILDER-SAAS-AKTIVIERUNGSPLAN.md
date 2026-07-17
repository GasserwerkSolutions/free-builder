# Builder → SaaS: Aktivierungs- und Publish-Plan

**Stand:** 2026-07-17  
**Status:** APPROVED — Rev. 2 (Owner-Freigabe 2026-07-17); Umsetzung noch nicht begonnen  
**Builder-Basis:** `GasserwerkSolutions/free-builder`, `main` bei `81984e75e1b8ddac6ea03eddb112a28fba15dc11` (nach PR #6)  
**SaaS-Basis:** `GasserwerkSolutions/gasserwerk`, `main` bei `1e62dd2140727024e80925f9cc6d8590735ed7c7`  
**Verwandt:** gasserwerk Issue #380, Paketarchitektur PR #382

---

## Revision 2 (Owner-Freigabe 2026-07-17)

Der Owner hat diese Revision fachlich freigegeben. Alle folgenden Punkte sind gegen das SaaS-Repo (`GasserwerkSolutions/gasserwerk`, `main`) code-verifiziert und in die jeweiligen Fachabschnitte integriert, nicht als Anhang geführt.

**Fünf Ergänzungen:**

1. **Scanner-sicherer Confirm-Schritt beim Magic Link** — Der Link öffnet nur eine Bestätigungsseite; Token-Consume, Tenant-Erstellung und Intent-Bindung starten erst bei ausdrücklicher Nutzeraktion. Ein Fehler hier stört nicht nur einen Login, sondern könnte unbeabsichtigt einen Tenant und einen Aktivierungsprozess erzeugen. Integriert in §10.3, Phase G2, §19 und Testmatrix.
2. **Persistenter lokaler Speicher mit ehrlicher Eviction-Semantik** — `navigator.storage.persist()` wird angefordert und der Rückgabestatus ehrlich behandelt; die UI weist auf mögliche Browser-Eviction lokaler Bilder hin (insbesondere iOS Safari). Integriert in §3.4, Phase F4, Phase I1 und Testmatrix.
3. **Verbindliche Erst-Copy-Regel für Arbeitszeiten** — „Öffnungszeiten aufs Team übernehmen“ füllt nur leere beziehungsweise unbestätigte Pläne, zeigt Betroffene vorab, überschreibt nur nach ausdrücklicher Bestätigung, bleibt wiederholbar und nie still destruktiv. Integriert in §4.4, §7.4 und Testmatrix.
4. **Gemeinsamer, versionierter Requirement-Code-Vertrag** — Builder und SaaS teilen einen versionierten Satz fachlicher Readiness-Codes; der Server bleibt autoritativ, jeder Code besitzt eine Builder-Fläche und eine Korrekturaktion. Integriert in §12.3 und die betroffenen Phasen-Gates.
5. **Rechtliche Mindestseiten als Publish-Gate** — Impressum und Datenschutzseite entstehen als echte CMS-Seiten; unvollständige rechtliche Pflichtangaben blockieren den Publish (`LEGAL_PAGES_INCOMPLETE`). Integriert in §5, §11.5, §12, §19 und Testmatrix.

**Drei Präzisierungen:**

- **G3 (Asset-Upload)** ist Integration vorhandener Bildinfrastruktur (sharp-Pipeline, sha256-Dedup), kein Greenfield-Bildsystem — Phase G3.
- **G4 (Katalog)** setzt auf der vorhandenen atomaren Kataloggrenze (`catalog-atomic-write.ts`) auf, kein neuer Transaktionsmechanismus — Phase G4.
- **Theme** wird auf Site-Ebene übernommen (Brand/Markenfarbe), nicht als CMS-Block modelliert — §9.3.

**Eine Abgrenzung:**

- Die Plan-/Capability-Migration ist ein eigener grösserer Produkt- und Architekturstrang (Paketarchitektur PR #382). Der erste Aktivierungsfluss weist ausschliesslich das bestehende FREE-Tier explizit und getestet zu — §18.

---

## 0. Entscheidungsstandard

Dieser Plan unterscheidet strikt:

- **VERIFIZIERT** — im aktuellen Code vorhanden.
- **ENTSCHEID** — bewusst gewählte Zielarchitektur; keine Tatsachenbehauptung über den Ist-Zustand.
- **UMBAU** — vorhandene Fähigkeit wird geordnet erweitert oder neu verdrahtet.
- **RELEASE-GATE** — darf erst öffentlich versprochen werden, wenn die genannte Prüfung bestanden ist.

Keine UI-Annahme darf zur Datenwahrheit werden. Keine lokale Builder-Struktur darf nach der Aktivierung eine zweite Wahrheit neben dem SaaS bilden.

---

## 1. Zielzustand

Ein Coiffeursalon kann ohne Konto eine echte Website vorbereiten und anschliessend mit einem einzigen verständlichen Vorgang veröffentlichen:

```text
Salon erfassen
→ Leistungen und Preise erfassen
→ Team und konkrete Leistungen zuordnen
→ Öffnungs- und Arbeitszeiten festlegen
→ Bilder auswählen
→ Website prüfen
→ „Website veröffentlichen“
→ E-Mail bestätigen
→ Tenant + OWNER entstehen
→ Daten werden in die SaaS-Wahrheiten übernommen
→ Website und Buchung werden gemeinsam freigegeben
→ Dashboard öffnet sich im vertrauten Design
```

Der Vorgang ist erst erfolgreich, wenn:

1. die Website öffentlich erreichbar ist,
2. die Buchung serverseitig `PUBLISHED` ist,
3. mindestens eine konkrete Leistung bei einer qualifizierten Person buchbar ist,
4. ein erneuter Aufruf keine Duplikate erzeugt,
5. ein Fehler jederzeit sauber fortgesetzt werden kann.

---

## 2. Verifizierter Ist-Zustand

### 2.1 Free Builder

**VERIFIZIERT:** Der aktuelle MVP ist eine statische Anwendung; die TypeScript-Quellen (`src/*.ts`) werden per `tsc` zu `assets/*.js` gebaut (CI-Reproduzierbarkeits-Gate), das ausgelieferte Produkt bleibt ohne Laufzeitabhängigkeiten.

- Der Zustand ist `BuilderDraftV2` (`schemaVersion: 2`), persistiert über IndexedDB; `localStorage` hält nur den `activeDraftId`-Pointer.
- Services besitzen bereits stabile Slugs, Kategorie, Dauer, Preisart und Buchbarkeit.
- Der Datenvertrag der Öffnungszeiten (`ScheduleDay.ranges: TimeRange[]`) trägt mehrere Intervalle; die UI bearbeitet derzeit nur die Hauptspanne (`ranges[0]`), die Mehrspannen-UI liefert Phase F3.
- Das Titelbild ist ein `BuilderAssetRef` (Kind `HERO`) als IndexedDB-Blob, keine externe URL; eine frühere URL überlebt nur als Migrationshinweis (`migration.legacyHeroImageUrl`).
- Es gibt ein Teammodell mit expliziter Staff↔Service-Zuordnung und Team-Readiness.
- Der primäre Abschluss ist `HTML exportieren`.
- Die linke Navigation arbeitet noch mit Panels; der Umblätter-Effekt wird beim Panelwechsel verwendet.

Belegpfade:

- `README.md`
- `index.html`
- `src/domain-model.ts`
- `src/persistence.ts`
- `src/domain-team.ts`
- `src/team-ui.ts`
- `src/ui-render.ts`
- `src/ui-actions.ts`
- `src/website.ts`

### 2.2 SaaS: Registrierung

**VERIFIZIERT:** `POST /api/register` ist verify-first:

- erzeugt vor E-Mail-Bestätigung keinen Tenant und keinen User,
- legt eine `PendingRegistration` an,
- sendet einen Magic Link,
- ist beim offenen Self-Service serverseitig auf `hair` begrenzt.

Tenant und OWNER entstehen erst beim Consume. `ConsumeRegistrationUseCase` schützt gegen Doppelklick, parallele Aufrufe und doppelte Tenant-Erzeugung.

Belegpfade:

- `apps/web/src/app/api/register/route.ts`
- `apps/web/src/application/tenant/consume-registration.use-case.ts`

### 2.3 SaaS: Booking-Katalog

**VERIFIZIERT:** Buchbare Daten liegen zentral in:

- `Service`
- `Staff`
- `StaffService`
- `Staff.workingHours`
- optional `Location`

Eine öffentliche Buchung wird serverseitig blockiert bei:

- keinen Services,
- keinem Team,
- Service ohne aktive qualifizierte Person,
- buchbarer Person ohne gültige Arbeitszeiten,
- unbestätigter Servicedauer,
- Standortlücken,
- nicht ausführbaren Bundles.

Belegpfade:

- `prisma/schema.prisma`
- `apps/web/src/adapters/persistence/queries/widget-activation.queries.ts`
- `apps/web/src/components/dashboard/booking-widget-settings.tsx`

### 2.4 SaaS: aktuelles Onboarding

**VERIFIZIERT:** Das SaaS-Onboarding kennt bereits Services, Team und Arbeitszeiten. Die Team-UI erfasst aktuell aber nur Name und E-Mail. Sie übermittelt keine bewusste Staff↔Service-Matrix.

Der zentrale Onboarding-Save ist atomar, erhält bestehende, geerdete Links und ergänzt nur Fallbacks, damit keine Achse unbuchbar bleibt. Das ist für Scan-Onboarding sinnvoll, aber kein Ersatz für eine ausdrückliche Auswahl im Builder.

Belegpfade:

- `apps/web/src/app/dashboard/onboarding/onboarding-page.tsx`
- `apps/web/src/app/dashboard/onboarding/use-onboarding-state.ts`
- `apps/web/src/app/dashboard/onboarding/steps/staff-step.tsx`
- `apps/web/src/adapters/persistence/queries/onboarding-catalog.queries.ts`
- `apps/web/src/adapters/persistence/catalog-link-write.ts`

### 2.5 SaaS: Zeiten

**VERIFIZIERT:** Persönliche Arbeitszeiten sind `Staff.workingHours`. Der Bulk-Editor kann einen Wochenplan auf alle aktiven Mitarbeitenden kopieren und danach pro Person verfeinern.

**VERIFIZIERTE LÜCKE:** Es gibt noch keine eigenständige betriebliche Regelzeiten-Wahrheit. Öffnungszeiten werden aktuell aus Mitarbeiterzeiten beziehungsweise CMS-Inhalt abgeleitet. Das reicht nicht für einen Builder, in dem öffentliche Öffnungszeiten und persönliche Buchbarkeit unabhängig editierbar sein sollen.

Belegpfade:

- `prisma/schema.prisma`
- `apps/web/src/components/dashboard/availability/business-hours-editor.tsx`
- `apps/web/src/app/dashboard/onboarding/steps/hours-step.tsx`
- `docs/DATEN-ZENTRALISIERUNG-KARTE.md`

### 2.6 SaaS: Bilder

**VERIFIZIERT:** Für Teamfotos existiert bereits ein authentifizierter Upload:

- Multipart,
- maximal 8 MB,
- JPEG/PNG/WebP/HEIC/HEIF/AVIF,
- EXIF-Rotation,
- quadratischer 512×512-Zuschnitt,
- WebP,
- Metadatenentfernung,
- Object-Storage-Adapter.

**VERIFIZIERT:** Für allgemeine CMS-Assets existieren `Asset`, Storage-Port, Dedup-Query und `/api/tenant/asset-ingest`. Dieser Endpoint ist aber absichtlich server-to-server und verlangt `INTAKE_SECRET` plus Tenant-API-Key. Er ist kein Browser-Uploadvertrag.

Belegpfade:

- `apps/web/src/app/api/staff/upload-photo/route.ts`
- `apps/web/src/components/dashboard/team/photo-drop.tsx`
- `apps/web/src/adapters/persistence/queries/asset-ingest.queries.ts`
- `apps/web/src/app/api/tenant/asset-ingest/route.ts`

### 2.7 SaaS: Website-Publish

**VERIFIZIERT:** DB-CMS-Seiten können über `POST /api/sites/[siteId]/publish` als `PageVersion` veröffentlicht werden und sind danach unter `/sites/[slug]` sichtbar.

Belegpfad:

- `apps/web/src/app/api/sites/[siteId]/publish/route.ts`

---

## 3. Verbindliche Architekturentscheide

### 3.1 Eine Datenwahrheit nach der Verifikation

**ENTSCHEID:** Der Builder ist vor der Verifikation ein lokaler Entwurf. Nach der Aktivierung sind ausschliesslich die SaaS-Domänen führend:

| Inhalt | Führende Wahrheit nach Aktivierung |
|---|---|
| Leistungen, Preise, Dauer | `Service` |
| Mitarbeitende | `Staff` |
| Wer bietet was an | `StaffService` |
| Persönliche Buchbarkeit | `Staff.workingHours` |
| Öffentliche Regelzeiten | neue Business-Hours-Domäne |
| Branding und Salonstammdaten | `Tenant` / Standortprojektion |
| Bilder | `Asset` plus referenzierende CMS-/Team-Strukturen |
| Website | `Site` / `Page` / `Block` / `PageVersion` |
| Buchungsfreigabe | serverseitiger Publication-/Readiness-Status |

Der Builder exportiert nach der Aktivierung keine eigene parallele HTML-Wahrheit.

### 3.2 Produktion unter derselben Origin

**ENTSCHEID:** Die produktive Builder-Oberfläche wird unter derselben Web-Origin wie das SaaS ausgeliefert, empfohlen:

```text
https://app.gasserwerk.ch/website-erstellen
```

Der Quellcode darf im öffentlichen `free-builder`-Repository bleiben. Die produktive Auslieferung erfolgt als versioniertes, gepinntes statisches Artefakt innerhalb des SaaS-Deployments.

Gründe:

- Magic-Link-Session ohne unsichere Browser-Tokens,
- IndexedDB-Draft bleibt nach dem Redirect erreichbar,
- kein breit geöffnetes CORS,
- kein Tenant-API-Key im Builder,
- keine getrennte Cookie-/Subdomain-Architektur,
- einfache Rückkehr an exakt dieselbe Entwurfsstelle.

**RELEASE-GATE:** Kein Publish-Flow wird auf einer fremden Origin produktiv aktiviert.

### 3.3 Kein Framework-Neubau

**ENTSCHEID:** Die visuelle Oberfläche und der Umblätter-Effekt bleiben erhalten. Es gibt keinen UX-Neubau in einem anderen Framework.

**UMBAU:** Vor den komplexen Integrationsschritten werden die globalen Skripte in native ES-Module mit TypeScript und kleinem Build-/Testschritt überführt. Das erzeugte Produkt bleibt eine statische Anwendung.

Zweck:

- versionierte Draft-Typen,
- testbare Migrationen,
- getrennte Daten-/UI-/API-Module,
- sichere IndexedDB-Abstraktion,
- weniger globale Zustände,
- reproduzierbares Deployment-Artefakt.

### 3.4 Bilder vor der Verifikation bleiben lokal

**ENTSCHEID:** In V1 werden keine anonymen Bilddateien hochgeladen.

Vor der Verifikation:

- Blob in IndexedDB,
- Vorschau via Object URL,
- nur Metadaten im Draft,
- kein Base64 in `localStorage`,
- keine externen Bild-URLs.

Nach der Verifikation:

- authentifizierter Upload,
- serverseitige Bildprüfung und Verarbeitung,
- Asset-ID statt URL als fachliche Referenz.

Bei Öffnung des Magic Links auf einem anderen Gerät kann der servergespeicherte Text-/Katalogentwurf wiederhergestellt werden. Lokal verbliebene Bilder werden sichtbar als fehlend markiert und können erneut ausgewählt werden. Bilder sind für V1 nicht buchungskritisch und blockieren die Aktivierung nicht.

**ENTSCHEID:** Der Builder fordert `navigator.storage.persist()` an und behandelt den Rückgabestatus ehrlich — eine Ablehnung ist kein Fehler, aber ein bekannter Zustand. Die UI weist transparent darauf hin, dass insbesondere mobile Browser (iOS Safari, Eviction unter Speicherdruck) lokale Bilder entfernen können. Der serverseitig gespeicherte Text-, Katalog- und Team-Draft (Upload beim Publish-Intent-Create, §10.1) bleibt die Recovery-Grundlage; lokale Bilder sind das Einzige, was ausschliesslich lokal lebt.

### 3.5 Publish ist eine Saga, keine riesige Transaktion

**ENTSCHEID:** Registrierung, Storage, Katalog, CMS und Freigabe können nicht glaubwürdig in einer einzigen DB-Transaktion gekapselt werden. Der Vorgang wird als persistierte, idempotente Aktivierungssaga gebaut.

Jeder Schritt:

- hat einen stabilen Idempotency-Key,
- kann sicher wiederholt werden,
- speichert sein Ergebnis,
- zeigt einen konkreten Fehler,
- erzeugt keine Duplikate.

---

## 4. UX-Zielbild

### 4.1 Grundregel

Die Websitefläche bleibt immer sichtbar. Der Nutzer öffnet keinen technischen Editor. Er bearbeitet das sichtbare Objekt:

- Fläche anklicken,
- Fläche dreht sich,
- wenige konkrete Felder erscheinen,
- speichern oder zurückdrehen,
- Vorschau bleibt räumlich erhalten.

Der Umblätter-Effekt wird zur Produktsignatur, aber nicht für Tabellen, lange Listen oder komplexe Mehrfachauswahl erzwungen.

### 4.2 Navigation

Die heutige Panelnavigation wird schrittweise reduziert. Sie darf vorläufig als Orientierung bestehen, ist aber nicht mehr die primäre Bearbeitungslogik.

Primäre Aktionen entstehen direkt an:

- Hero/Titelbild,
- Textabschnitt,
- Leistungskarte,
- Teamkarte,
- Öffnungszeitenblock,
- Galerie,
- Abschlussfläche.

### 4.3 Team

Jede Mitarbeiterkarte zeigt vorne:

- Portrait oder Initialen,
- Name,
- Rolle,
- Spezialgebiete,
- angebotene Leistungen.

Auf der Rückseite:

- Name,
- Rolle,
- optional E-Mail,
- Kurztext,
- Portrait hochladen/ersetzen/entfernen,
- explizite Leistungsauswahl,
- Arbeitszeiten,
- aktiv/deaktiviert.

Es gibt eine bewusste Aktion `Alle Leistungen auswählen`. Der Builder setzt niemals still alle Leistungen für alle Personen.

### 4.4 Öffnungszeiten

Der sichtbare Website-Block `Öffnungszeiten` ist direkt editierbar:

- Wochentag geöffnet/geschlossen,
- bis zu zwei Zeitspannen im ersten UI-Schnitt,
- Kopieren auf ausgewählte Tage,
- Validierung gegen Überschneidung und `von < bis`,
- explizite Aktion `Als Ausgangszeiten fürs Team übernehmen`.

Öffnungszeiten und Arbeitszeiten bleiben danach unabhängig.

**ENTSCHEID:** Die Aktion `Als Ausgangszeiten fürs Team übernehmen` ist nie still destruktiv. Sie füllt standardmässig nur vollständig leere beziehungsweise unbestätigte Wochenpläne, verändert bestehende persönliche Zeiten nicht, zeigt betroffene Personen vorab, überschreibt nur nach ausdrücklicher Bestätigung pro Person oder bewusst gewählter Gruppe und bleibt wiederholbar.

### 4.5 Bilder

Bildflächen sind keine URL-Felder.

V1-Bildtypen:

- Titelbild,
- Mitarbeiterportraits,
- Salon-/Galeriebilder.

Interaktion:

- klicken oder hineinziehen,
- Vorschau,
- Bildposition/Fokus festlegen,
- Alt-Text bearbeiten,
- ersetzen,
- entfernen.

Der Builder verwendet keine Stockbilder als angeblich echte Salonbilder.

### 4.6 Abschluss

Der primäre Button lautet:

```text
Website veröffentlichen
```

Der Abschluss zeigt keine technische Exportfunktion. HTML-Export kann als nicht primäre Support-/Backup-Aktion bestehen bleiben, darf aber nicht mehr das Produktziel erklären.

---

## 5. Lokaler Draft-Vertrag

Der bestehende Zustand wird additiv von Version 1 auf Version 2 migriert.

```ts
type BuilderDraftV2 = {
  schemaVersion: 2;
  draftId: string;
  createdAt: string;
  updatedAt: string;

  salon: {
    name: string;
    tagline: string;
    phone: string;
    email: string;
    address: string;
    postalCode: string;
    city: string;
    instagram: string;
  };

  legal: {
    operatorName: string;   // Betreiber/Firma, rechtlich verantwortlich
    legalForm: string;      // z. B. Einzelfirma, GmbH
    responsibleName: string;
    // Adresse und Kontakt stammen strukturiert aus salon, nicht als Freitext
  };

  copy: {
    heroLabel: string;
    heroTitle: string;
    heroSubtitle: string;
    servicesTitle: string;
    servicesSubtitle: string;
    bookingTitle: string;
    bookingSubtitle: string;
  };

  services: BuilderService[];
  staff: BuilderStaff[];
  businessHours: WeeklySchedule;
  assets: BuilderAssetRef[];

  testimonials: {
    enabled: boolean;
    items: ManualTestimonial[];
  };

  theme: {
    preset: "elegant" | "modern" | "natural" | "bold";
    primary: string;
    accent: string;
  };

  publication: {
    intentId: string | null;
    state: "LOCAL" | "EMAIL_SENT" | "VERIFIED" | "ACTIVATING" | "PUBLISHED" | "FAILED";
    lastErrorCode: string | null;
  };
};
```

### 5.1 Services

```ts
type BuilderService = {
  clientId: string;
  slug: string;
  category: string;
  name: string;
  description: string;
  durationMinutes: number;
  price: number;
  priceType: "fixed" | "from" | "on-request";
  bookable: boolean;
};
```

`clientId` ist unveränderlich. Der sichtbare Slug darf bei Namensänderung neu berechnet werden, ist aber nicht der Relation-Key im Builder.

### 5.2 Team

```ts
type BuilderStaff = {
  clientId: string;
  name: string;
  email: string;
  role: string;
  bio: string;
  specialties: string[];
  active: boolean;
  serviceClientIds: string[];
  workingHours: WeeklySchedule;
  portraitAssetLocalId: string | null;
};
```

### 5.3 Wochenplan

```ts
type WeeklySchedule = Array<{
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  closed: boolean;
  ranges: Array<{ from: string; to: string }>;
}>;
```

Der Vertrag unterstützt mehrere Zeitspannen. Die erste UI darf auf maximal zwei Spannen begrenzen, ohne den Datenvertrag später brechen zu müssen.

### 5.4 Assets

```ts
type BuilderAssetRef = {
  localId: string;
  kind: "HERO" | "PORTRAIT" | "GALLERY" | "LOGO";
  ownerClientId: string | null;
  fileName: string;
  mimeType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  alt: string;
  focalPoint: { x: number; y: number } | null;
  uploadedAssetId: string | null;
};
```

Die Binärdaten liegen in einem getrennten IndexedDB-Store und nie im JSON-Draft.

---

## 6. Lokale Persistenz

### 6.1 IndexedDB-Stores

```text
drafts
  key: draftId
  value: BuilderDraftV2

assetBlobs
  key: localId
  value: Blob

meta
  key: activeDraftId | schemaVersion | lastCleanupAt
```

`localStorage` enthält höchstens den Pointer auf `activeDraftId`, keine Bilddaten und keine API-/Aktivierungstokens.

### 6.2 Migration V1 → V2

- bestehende `services[].id` werden zu stabilen `clientId`-Werten übernommen,
- `hours` werden in `businessHours.ranges[]` überführt,
- `heroImage`-URL wird nicht automatisch extern geladen,
- eine vorhandene sichere URL bleibt nur als sichtbarer Migrationshinweis `Bild neu hochladen`, nicht als neue Asset-Wahrheit,
- Team startet leer,
- `bookingUrl` wird entfernt; die Buchungs-URL entsteht serverseitig nach Aktivierung,
- Testimonials und Theme bleiben erhalten.

**RELEASE-GATE:** Migrationstest mit allen V1-Feldkombinationen; kein stiller Datenverlust.

---

## 7. Neue Business-Hours-Domäne

### 7.1 Problem

`Staff.workingHours` beantwortet:

> Wann kann diese Person Termine annehmen?

Öffentliche Öffnungszeiten beantworten:

> Wann ist der Salon grundsätzlich geöffnet beziehungsweise erreichbar?

Beides ist oft ähnlich, aber nicht identisch. Eine Projektion aus dem einen in das andere erzeugt falsche Wahrheiten.

### 7.2 Zielmodell

**ENTSCHEID:** Eine eigene, standortfähige Business-Hours-Wahrheit wird eingeführt.

Empfohlene Form:

```ts
type BusinessHoursScope = "TENANT" | "LOCATION";

type BusinessHoursProfile = {
  id: string;
  tenantId: string;
  scope: BusinessHoursScope;
  scopeKey: string;       // "tenant" oder "location:<id>"
  locationId: string | null;
  weekly: WeeklySchedule;
  source: "MANUAL" | "EXTRACTED" | "CONFIRMED";
  confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
```

`@@unique([tenantId, scopeKey])` verhindert die PostgreSQL-NULL-Eindeutigkeitsfalle.

V1 verwendet `scopeKey = "tenant"`. Standort-Overrides können später additiv folgen.

### 7.3 Projektionen

Die Business-Hours-Wahrheit speist:

- Website-Öffnungszeitenblock,
- HairSalon-JSON-LD,
- Dashboard-Anzeige,
- später Google Business Profile,
- später standortbezogene Ausgabe.

Sie entscheidet nicht über Slots. Slots lesen weiterhin `Staff.workingHours`, Pausen, Feiertage und Blocker.

### 7.4 Erstübernahme

Beim Einrichten kann der Nutzer ausdrücklich wählen:

```text
Diese Öffnungszeiten als Arbeitszeiten fürs ganze Team übernehmen
```

Das ist ein einmaliger Copy-Vorgang. Spätere Änderungen bleiben unabhängig und überschreiben keine individuellen Zeiten still.

**ENTSCHEID:** Auch diese Erstübernahme ist nie still destruktiv: Sie füllt nur leere beziehungsweise unbestätigte Pläne, lässt bestehende persönliche Zeiten unangetastet, zeigt betroffene Personen vorab und überschreibt nur nach ausdrücklicher Bestätigung pro Person oder bewusst gewählter Gruppe. Der Vorgang bleibt wiederholbar.

---

## 8. Team- und Servicezuordnung im SaaS

### 8.1 Kein Fallback als Owner-Entscheid

Der aktuelle Backfill-Mechanismus bleibt für Scan-/Legacy-Fälle bestehen. Der Builder-Publish verwendet ihn nicht als fachliche Zuordnung.

### 8.2 Neuer atomarer Use Case

```ts
applyBuilderCatalog({
  tenantId,
  services: Array<BuilderService & { clientId: string }>,
  staff: Array<BuilderStaff & { clientId: string }>,
  links: Array<{ staffClientId: string; serviceClientId: string }>,
  editorUserId,
  idempotencyKey,
})
```

Der Use Case führt in einer PostgreSQL-Transaktion aus:

1. Catalog-Stream-Lock und Mutation-Claim,
2. Services ersetzen/abgleichen,
3. Staff ersetzen/abgleichen,
4. interne `clientId → dbId`-Maps erzeugen,
5. nur die expliziten StaffService-Paare schreiben,
6. Arbeitszeiten schreiben,
7. Revision committen,
8. Ergebnis-Map im Publish-Intent persistieren.

Invarianten:

- jeder `serviceClientId` muss im Payload existieren,
- jeder `staffClientId` muss im Payload existieren,
- doppelte Links kollabieren,
- bookable Service ohne Link ist Validierungsfehler,
- aktive Person ohne Service darf gespeichert werden, blockiert aber nicht, solange sie nicht buchbar ist,
- Retry mit gleichem Idempotency-Key erzeugt keinen zweiten Katalog.

---

## 9. Bildpipeline

### 9.1 Gemeinsamer Verarbeitungsdienst

Die Verarbeitung aus `staff/upload-photo` wird aus der Route in einen wiederverwendbaren Service extrahiert:

```ts
processUploadedImage({
  bytes,
  declaredMimeType,
  purpose: "PORTRAIT" | "HERO" | "GALLERY" | "LOGO",
})
```

Der Service prüft:

- Request- und Dateigrösse,
- dekodierbares Bild statt nur MIME-Behauptung,
- Pixelgrenze,
- EXIF-Rotation,
- Metadatenentfernung,
- serverseitige Re-Encodierung,
- deterministischen Content-Hash.

Portrait behält den verifizierten 512×512-WebP-Vertrag. Hero-/Galerievarianten werden erst anhand des tatsächlichen CMS-Renderers und eines dokumentierten Performance-Budgets festgelegt; keine geratene Pixelmatrix wird zum Vertrag.

### 9.2 Authentifizierter Builder-Endpoint

Neu:

```text
POST /api/builder/publish-intents/:intentId/assets
Content-Type: multipart/form-data
Session: verifizierter OWNER
```

Felder:

- `file`
- `localId`
- `kind`
- `ownerClientId` optional
- `alt`
- `focalPoint` optional

Antwort:

```json
{
  "success": true,
  "data": {
    "localId": "asset-local-1",
    "assetId": "...",
    "width": 0,
    "height": 0
  }
}
```

Der Endpoint:

- prüft Intent-Besitz und Tenant,
- nutzt Session statt API-Key,
- schreibt über `AssetStoragePort`,
- erzeugt/reused `Asset` per Content-Hash,
- speichert die `localId → assetId`-Zuordnung am Intent,
- akzeptiert keine fremden URLs.

### 9.3 Referenzauflösung

- `PORTRAIT` → Team-/CMS-Portraitreferenz,
- `HERO` → Hero-Block-Asset-ID,
- `GALLERY` → Gallery-Block-Items,
- `LOGO` → Tenant-/Site-Brandprojektion.

URLs werden nur am Render-Rand aus Asset + Storage aufgelöst.

**ENTSCHEID:** Das Theme (Brand/Markenfarbe aus dem Draft) wird auf Site-/Tenant-Ebene als Brandprojektion übernommen, nicht als eigener CMS-Block modelliert.

---

## 10. Publish-Intent und Magic Link

### 10.1 Neuer öffentlicher Einstieg

Neu:

```text
POST /api/builder/publish-intents
```

Payload:

```ts
{
  email: string;
  businessName: string;
  industry: "hair";
  draft: BuilderDraftV2; // ohne Blob-Daten
}
```

Der Server:

1. validiert und normalisiert den gesamten Draft,
2. erzwingt `industry = hair`,
3. begrenzt Payloadgrösse,
4. legt `BuilderPublishIntent` mit Ablaufzeit an,
5. erzeugt über den bestehenden verify-first Mechanismus die PendingRegistration,
6. sendet einen serverdefinierten Magic Link,
7. gibt eine neutrale Erfolgsantwort ohne Account-Enumeration zurück.

Es gibt kein clientseitig frei wählbares `returnTo`.

### 10.2 Persistenzmodell

```ts
type BuilderPublishIntentStatus =
  | "EMAIL_SENT"
  | "VERIFIED"
  | "ACTIVATING"
  | "WAITING_FOR_ASSETS"
  | "READY_TO_CUTOVER"
  | "PUBLISHED"
  | "FAILED"
  | "EXPIRED";

type BuilderPublishIntent = {
  id: string;
  pendingRegistrationId: string;
  draftVersion: number;
  draft: unknown;
  status: BuilderPublishIntentStatus;
  currentStep: string | null;
  tenantId: string | null;
  ownerUserId: string | null;
  appliedMap: unknown | null;
  lastErrorCode: string | null;
  lastErrorDetail: unknown | null;
  expiresAt: Date;
  verifiedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
```

Der Intent speichert keine Binärbilder und keine Klartext-Magic-Link-Tokens.

### 10.3 Magic-Link-Rückkehr über eine Bestätigungsseite

Der Link landet auf einer festen SaaS-/Builder-Route, beispielsweise:

```text
/website-erstellen/aktivieren?invite=<token>&intent=<id>
```

**ENTSCHEID:** Der Magic Link öffnet ausschliesslich eine Bestätigungsseite. Das Öffnen ist ein reiner Lesevorgang: kein Token-Consume, keine Tenant-Erstellung, keine Intent-Bindung, kein mutierender `GET`. Token-Consume, Tenant-/OWNER-Erzeugung und Intent-Bindung starten erst durch eine ausdrückliche Nutzeraktion auf dieser Seite (Form-Submit/POST).

Begründung: Freemail-Scanner (GMX und andere) prefetchen Links in E-Mails und würden ein One-Time-Token vor dem menschlichen Klick verbrennen. Im SaaS ist das produktionserprobt über Fix #355 gelöst (Muster `/login/bestaetigen`, gemergt auf `main`): Der Link zeigt zuerst eine Seite, das Token wird erst beim Nutzer-Submit eingelöst. Der Builder-Aktivierungslink übernimmt dieses Muster 1:1.

Ablauf:

1. Öffnen des Links rendert nur die Bestätigungsseite; Intent, Tenant und Token bleiben unverändert,
2. der Nutzer bestätigt ausdrücklich (POST); erst jetzt erzeugt das bestehende Consume-Verfahren Tenant und OWNER idempotent,
3. Intent wird atomar an Tenant und User gebunden,
4. Session steht,
5. Builder lädt den servergespeicherten Draft,
6. lokale IndexedDB-Bilder werden erkannt und hochgeladen,
7. fehlen lokale Bilder, zeigt die UI das transparent,
8. Aktivierung wird fortgesetzt.

Ein zweiter Submit desselben Links führt zum vorhandenen Tenant und Intent, nie zu einem zweiten Tenant. Diese Doppelklick-Idempotenz bezieht sich neu auf den Submit, nicht auf das blosse Öffnen des Links.

**RELEASE-GATE:** Ein Prefetch-/Scanner-Aufruf des Links (reiner Seitenaufruf) erzeugt weder Consume noch Tenant noch Intent-Statuswechsel.

---

## 11. Aktivierungssaga

### 11.1 Schritte

```text
01 VERIFY_OWNERSHIP
02 APPLY_TENANT_PROFILE
03 APPLY_BUSINESS_HOURS
04 APPLY_CATALOG_AND_LINKS
05 APPLY_STAFF_WORKING_HOURS
06 INGEST_AND_RESOLVE_ASSETS
07 ENSURE_SITE_AND_HOME_PAGE
08 APPLY_SITE_CONTENT_DRAFT   // inkl. Impressum + Datenschutzseite als echte CMS-Seiten
09 CHECK_BOOKING_READINESS
10 PREPARE_PUBLICATION
11 PUBLISH_SITE
12 ENABLE_BOOKING
13 FINALIZE
```

### 11.2 Schrittverträge

Jeder Schritt schreibt:

```ts
{
  intentId,
  step,
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED",
  attempts,
  idempotencyKey,
  result,
  errorCode,
  startedAt,
  completedAt
}
```

### 11.3 Kein falscher Erfolg

Die UI darf `Veröffentlicht` erst anzeigen, wenn der Intent `PUBLISHED` ist.

Bei Fehler:

- kein Zurücksetzen des Builder-Drafts,
- konkrete betroffene Fläche markieren,
- `Erneut versuchen` setzt beim fehlgeschlagenen Schritt fort,
- erfolgreich abgeschlossene Schritte werden nicht dupliziert,
- Plattformfehler werden mit Intent-/Tenant-/Request-ID beobachtbar.

### 11.4 Cutover

Vor `READY_TO_CUTOVER` sind Site-Draft und Katalog nicht öffentlich.

Der finale Cutover muss verhindern, dass eine halbe Aktivierung als fertiges Produkt erscheint. Für builder-erzeugte Sites wird deshalb eine explizite Aktivierungsfreigabe eingeführt:

```text
Site-Draft und PageVersion vorbereitet
+ Booking-Readiness READY
+ Widget-Aktivierung erfolgreich
+ Intent FINALIZE
= öffentliche Builder-Site sichtbar
```

Bestehende Sites bleiben von diesem zusätzlichen Gate unberührt.

Wenn Site-Publish oder Widget-Aktivierung fehlschlägt, bleibt die Builder-Site hinter dem Aktivierungsgate und der Intent fortsetzbar.

### 11.5 Rechtliche Mindestseiten und FREE-Tier

**ENTSCHEID:** Der Aktivierungsprozess erzeugt standardmässig Impressum und Datenschutzseite als echte, tenant-gebundene CMS-Seiten — als Teil des CMS-Projektionsschritts `08 APPLY_SITE_CONTENT_DRAFT`. Der Publish erzeugt eine echte Schweizer Business-Site, keine exportierte Datei mehr; nDSG und Impressumspflicht gelten damit unmittelbar. Die dafür nötigen Pflichtangaben (Betreiber/Firma, Adresse, Kontakt) werden im Flow strukturiert erfasst (Draft-`legal`-Block plus `salon`), nicht als Freitext. Die generierten Seiten bleiben nach der Aktivierung im Dashboard editierbar.

**RELEASE-GATE:** Unvollständige rechtliche Mindestangaben blockieren den Publish über den Readiness-Code `LEGAL_PAGES_INCOMPLETE` (§12).

**ENTSCHEID:** Schritt `02 APPLY_TENANT_PROFILE` weist dem neuen Tenant ausschliesslich das bestehende FREE-Tier explizit und getestet zu. Die spätere Paket-/Capability-Architektur (Paketarchitektur PR #382) ist ein eigener Strang und kein beiläufiger Bestandteil des Builder-Publish (§18).

---

## 12. Server-Readiness und Builder-Readiness

### 12.1 Builder-Vorschau

Der Builder zeigt früh verständliche Hinweise:

- Salonname fehlt,
- keine Kontaktmöglichkeit,
- keine buchbare Leistung,
- Leistung ohne Preis/Dauer,
- kein Team,
- buchbare Leistung ohne Person,
- Person ohne Arbeitszeiten,
- Öffnungszeiten ungeprüft.

Diese Hinweise verbessern die Bedienung, autorisieren aber nichts.

### 12.2 Server ist autoritativ

Vor Cutover läuft die bestehende serverseitige Readiness. Der Builder übersetzt Codes in konkrete Aktionen:

| Servercode | Builder-Aktion |
|---|---|
| `NO_SERVICES` | Leistungenfläche öffnen |
| `NO_STAFF` | Teamfläche öffnen |
| `SERVICE_WITHOUT_STAFF` | betroffene Leistung/Teamzuordnung markieren |
| `STAFF_WITHOUT_HOURS` | betroffene Mitarbeiterkarte öffnen |
| `SERVICE_DURATION_UNCONFIRMED` | Dauer bestätigen |
| Standortcodes | später Standortfläche; V1 darf sie bei einem Standort nicht erzeugen |
| `BUNDLE_WITHOUT_STAFF` | Bundle im V1-Builder nicht anbieten oder korrekt auflösen |
| `LEGAL_PAGES_INCOMPLETE` | rechtliche Pflichtangaben (Betreiber/Firma, Adresse, Kontakt) vervollständigen |

Keine Fehlermeldung endet nur in `Publish fehlgeschlagen`.

### 12.3 Gemeinsamer Requirement-Code-Vertrag

**ENTSCHEID:** Builder und SaaS verwenden einen versionierten gemeinsamen Satz fachlicher Readiness-Codes. Die lokalen Prüfungen (§12.1) dienen der frühzeitigen UX; der Server bleibt autoritativ (§12.2). Jeder Server-Code besitzt eine definierte Builder-Fläche und eine konkrete Korrekturaktion — keine namenlose Ablehnung, kein Code ohne zugeordnete Fläche.

**VERIFIZIERT:** Beide Code-Sätze existieren bereits als Ist-Code. SaaS: `ActivationRequirementCode` (`widget-activation.queries.ts`: `NO_SERVICES`, `SERVICE_WITHOUT_STAFF`, `SERVICE_DURATION_UNCONFIRMED`, `NO_STAFF`, `STAFF_WITHOUT_HOURS` …). Builder: `TeamReadinessIssue.code` (`src/domain-team.ts`: `NO_ACTIVE_STAFF`, `STAFF_WITHOUT_NAME`, `STAFF_WITHOUT_SERVICE`, `SERVICE_WITHOUT_STAFF`, `STAFF_WITHOUT_HOURS`), erzeugt via `getTeamReadinessIssues`/`getTeamReadinessChecks` und konsumiert in `src/team-ui.ts`. Beide Sätze sind bereits fast deckungsgleich.

**UMBAU:** Der Vertrag kodifiziert und versioniert diese Menge als eine gemeinsame Quelle. Ein neuer Server-Code — etwa `LEGAL_PAGES_INCOMPLETE` — kann nicht ausgeliefert werden, ohne dass ihm eine Builder-Fläche und eine Korrekturaktion zugeordnet sind. Die Version des Code-Satzes wird zwischen Builder-Artefakt und SaaS-Release abgeglichen.

---

## 13. API-Verträge

### Öffentlich, vor Verifikation

```text
POST /api/builder/publish-intents
GET  /api/builder/publish-intents/:id/status  // nur nicht-sensitive Statusprojektion
```

### Authentifiziert, nach Verifikation

```text
GET  /api/builder/publish-intents/:id
POST /api/builder/publish-intents/:id/assets
POST /api/builder/publish-intents/:id/activate
POST /api/builder/publish-intents/:id/retry
```

Der Client ruft niemals direkt auf:

- `/api/tenant/asset-ingest`,
- Catalog-Internals,
- Tenant-API-Key-Routen,
- einzelne CMS-Publish-Schritte,
- `widgetEnabled` als unkoordinierten letzten Klick.

Alle fachlichen Schritte laufen über den Activation-Use-Case.

---

## 14. Sicherheitsanforderungen

### 14.1 Vor Verifikation

- persistenter Rate-Limit pro HMAC-E-Mail und IP,
- neutrale Antwort bei bestehendem Account,
- Draft-Payload-Limit,
- strikte Schema-Validierung,
- keine HTML-/Script-Inhalte ungefiltert übernehmen,
- keine externen URL-Fetches,
- Ablaufzeit und Cleanup für Intents,
- keine Bilduploads.

### 14.2 Nach Verifikation

- Intent muss zum Session-User und Tenant gehören,
- OWNER-/Berechtigungsprüfung,
- CSRF-/SameSite-Schutz über bestehende Sessionarchitektur,
- Uploaddekodierung und Re-Encoding,
- EXIF-/Metadatenentfernung,
- Content-Hash serverseitig,
- Rate-Limit pro Tenant und IP,
- Audit-Events für Aktivierung und endgültige Veröffentlichung,
- kein API-Key im Browser,
- keine clientseitige Freigabeentscheidung.

### 14.3 Bildrechte

Vor dem Upload bestätigt der Salon:

```text
Ich darf diese Bilder für die Website verwenden und abgebildete Personen haben zugestimmt.
```

Die Bestätigung wird mit Intent, User und Zeitstempel auditierbar gespeichert.

---

## 15. Umsetzungssequenz

Jede Phase ist klein, reviewbar und besitzt ein eigenes Gate. Kein Big Bang über beide Repositories.

### Phase F0 — MVP-Basis festziehen

Repository: `free-builder`

- PR #1 manuell im Browser abnehmen,
- vorhandene Interaktionen und Umblätter-Effekt als visuelle Baseline dokumentieren,
- PR #1 mergen,
- keine neuen Features vor Baseline-Abnahme.

**Gate:** Desktop/Mobile, Autosave, Service-CRUD, Vorschau und Export funktionieren unverändert.

### Phase F1 — Technisches Fundament

Repository: `free-builder`

- ES-Module + TypeScript,
- kleiner reproduzierbarer Build,
- Unit-Test-Runner,
- `BuilderDraftV2`,
- V1→V2-Migration,
- IndexedDB-Repository,
- localStorage nur als Pointer.

**Gate:** visuelle Snapshot-/Smoke-Parität; bestehender V1-Draft migriert ohne Verlust.

### Phase F2 — Team und Zuordnungen

Repository: `free-builder`

- Teammodell,
- Karten und Umblätter-Bearbeitung,
- explizite Serviceauswahl,
- `Alle Leistungen` nur als bewusste Aktion,
- Teamsektion in der Vorschau,
- Readiness für Staff↔Service.

**Gate:** Entfernen/Umbenennen einer Leistung bereinigt oder markiert alle betroffenen Teamlinks deterministisch.

### Phase G1 — Business-Hours-Wahrheit

Repository: `gasserwerk`

- Business-Hours-Modell und Migration,
- Validierungsschema,
- Query-/Write-Port,
- Projektion in CMS-HOURS-Block,
- Dashboard-Adapter,
- keine Änderung der Staff-Slot-Semantik.

**Gate:** Website-Öffnungszeiten ändern sich ohne stille Änderung persönlicher Arbeitszeiten; Slot-Test bleibt grün.

### Phase F3 — Direkte Zeiten-UI

Repository: `free-builder`

- editierbarer Website-Öffnungszeitenblock,
- mehrere Ranges im Vertrag,
- Copy-to-days,
- explizite Erstübernahme aufs Team,
- persönliche Zeiten pro Teamkarte.

**Gate:** getrennte Änderungen bleiben nach Reload getrennt.

### Phase F4 — Lokale Bildverwaltung

Repository: `free-builder`

- Drag-and-drop/File Picker,
- IndexedDB-Blobs,
- `navigator.storage.persist()` anfordern und Rückgabestatus behandeln,
- transparenter UI-Hinweis auf mögliche Browser-Eviction lokaler Bilder (insbesondere iOS Safari),
- Hero, Portrait, Galerie,
- Object-URL-Lifecycle,
- Alt-Text und Fokuspunkt,
- URL-Felder entfernen,
- Rechtebestätigung.

**Gate:** Reload erhält Bilder; Reset und Entfernen löschen Blobs; keine Base64-Daten in localStorage; abgelehnte Persistenz ist sichtbar, aber kein Fehler.

### Phase I1 — Gleiche Origin und Artefaktlieferung

Repositories: beide

- versioniertes Builder-Artefakt,
- gepinnter Commit/Checksum im SaaS-Build,
- Auslieferung unter `/website-erstellen`,
- CSP und Cache-Regeln,
- kein Runtime-Download fremden Codes,
- persistente Storage-Anforderung, damit lokale Bilder und Draft den Auth-Redirect überstehen.

**Gate:** Builder, Magic Link und Dashboard laufen unter derselben Origin; IndexedDB bleibt nach Auth-Redirect verfügbar.

### Phase G2 — Publish-Intent

Repository: `gasserwerk`

- DB-Modell und Migration,
- öffentlicher Create-Endpoint,
- bestehende Registration-Dienste wiederverwenden,
- fester Redirect,
- scanner-sichere Bestätigungsseite (Consume erst bei Submit, kein mutierender GET) nach Muster Fix #355,
- Intent↔PendingRegistration↔Tenant-Bindung,
- Ablauf/Cleanup,
- Statusprojektion.

**Gate:** Doppelklick und paralleler Consume erzeugen exakt einen Tenant und einen Intent-Zustand; ein Prefetch-/Scanner-Aufruf des Magic Links löst weder Consume noch Tenant noch Intent-Statuswechsel aus.

### Phase G3 — Authentifizierter Asset-Upload

Repository: `gasserwerk`

**VERIFIZIERT:** Die Bildinfrastruktur existiert bereits — sharp-Pipeline mit EXIF-Autorotate, Re-Encoding zu WebP und Metadaten-Strip (Routen `staff/upload-photo`, `upload-logo`) sowie sha256-Content-Hash-Dedup (`asset-ingest`).

**UMBAU:** Diese Phase integriert und vereinheitlicht diese vorhandene Infrastruktur; sie baut kein Greenfield-Bildsystem.

- Bildverarbeitung aus Route extrahieren,
- Builder-Asset-Endpoint,
- Asset-Dedup/Storage,
- Intent-Mapping,
- Tests für falsches MIME, Pixelbomben, Grösse, Fremd-Intent und Retry.

**Gate:** gleiche Datei zweimal = ein Asset; fremder Tenant = 403; Metadaten sind entfernt.

### Phase G4 — Atomarer Builder-Katalog

Repository: `gasserwerk`

**VERIFIZIERT:** Die atomare Kataloggrenze existiert bereits (`catalog-atomic-write.ts` / `replaceCatalogWithinTransaction`, genutzt von `catalog-ingest`).

**UMBAU:** Diese Phase setzt auf dieser vorhandenen Grenze auf; es entsteht kein neuer Transaktionsmechanismus.

- Activation-spezifischer Catalog-Use-Case,
- explizite Linkmatrix,
- Arbeitszeiten,
- Catalog-Revision,
- Idempotency,
- keine Cross-Product-Fallbacks für Ownerdaten.

**Gate:** exakt die ausgewählten Zuordnungen existieren; Wiederholung verändert IDs/Links nicht unerwartet.

### Phase G5 — Site-Draft und Aktivierungssaga

Repository: `gasserwerk`

- Tenantprofil inkl. expliziter FREE-Tier-Zuweisung,
- Business Hours,
- Asset-Refs,
- Site/Home sicherstellen,
- Blockprojektion aus Draft,
- Impressum + Datenschutzseite als CMS-Seiten (Gate `LEGAL_PAGES_INCOMPLETE`),
- persistierte Saga-Schritte,
- Readiness gegen den gemeinsamen versionierten Requirement-Code-Vertrag (§12.3),
- Aktivierungsgate,
- Publish + Widget-Cutover.

**Gate:** Fehler in jedem injizierten Schritt ist fortsetzbar und zeigt niemals falsches `PUBLISHED`.

### Phase F5 — Publish-Oberfläche

Repository: `free-builder`

- `HTML exportieren` als Hauptaktion entfernen,
- E-Mail-/Verifikationszustand,
- Status und Retry,
- lokale Assets nach Auth hochladen,
- konkrete Readiness-Navigation über den gemeinsamen versionierten Requirement-Code-Vertrag (§12.3),
- Erfolg mit Website- und Buchungs-URL,
- Übergang ins Dashboard.

**Gate:** Nutzer verlässt den Builder nicht in einem unklaren Zwischenzustand.

### Phase I2 — Ende-zu-Ende-Abnahme

Repositories: beide

Pflichtpfad:

```text
leerer Browser
→ Salon erfassen
→ 3 Leistungen
→ 2 Mitarbeitende
→ unterschiedliche Servicezuordnung
→ Öffnungszeiten
→ unterschiedliche Arbeitszeiten
→ Hero + 2 Portraits + Galerie
→ Veröffentlichen
→ Magic Link
→ Aktivierung
→ öffentliche Website
→ konkrete buchbare Slots
→ Dashboard zeigt dieselben Daten
```

---

## 16. Testmatrix

### Draft und Migration

- V1 vollständig → V2 vollständig,
- kaputtes JSON → sichere Recovery,
- Schema-Version unbekannt → kein Überschreiben,
- Service-ID-Konflikte,
- entfernte Leistung mit bestehenden Staff-Links,
- IndexedDB-Quota-Fehler sichtbar.

### Team

- Person ohne Service,
- Service ohne Person,
- `Alle Leistungen` explizit,
- Deaktivierung,
- doppelte Namen bei unterschiedlichen `clientId`,
- Rename ohne Relationsverlust.

### Zeiten

- geschlossener Tag,
- eine und zwei Spannen,
- Überlappung,
- Ende vor Start,
- Copy-to-team einmalig,
- Copy aufs Team füllt nur leere/unbestätigte Pläne, überschreibt bestehende Zeiten erst nach Bestätigung,
- nachträgliche Unabhängigkeit,
- leerer Staff-Plan blockiert Readiness.

### Bilder

- erlaubte Formate,
- falsche MIME-Deklaration,
- beschädigte Datei,
- Pixelbomben,
- zu grosse Datei,
- EXIF-Rotation,
- Metadatenentfernung,
- Hash-Dedup,
- Blobrecovery nach Reload,
- abgelehnte `navigator.storage.persist()` → sichtbarer UI-Hinweis, kein Datenverlust-Irrtum,
- Eviction lokaler Bilder → transparente Fehlend-Markierung, Recovery aus Server-Draft,
- Magic Link auf anderem Gerät.

### Registrierung

- bestehender Account,
- neuer Account,
- abgelaufener Link,
- Prefetch/Scanner-Aufruf des Links ohne Consume (Bestätigungsseite erst bei Submit),
- doppelter Linkklick,
- paralleler Consume,
- Intent gehört zu anderer E-Mail,
- Session gehört zu anderem Tenant.

### Aktivierung

- Retry nach jedem Schritt,
- Storage-Ausfall,
- Catalog-Konflikt,
- Page-Publish-Fehler,
- Widget-Readiness-Fehler,
- unvollständige rechtliche Mindestangaben → `LEGAL_PAGES_INCOMPLETE` blockiert Publish,
- Impressum + Datenschutzseite entstehen als echte, danach editierbare CMS-Seiten,
- keine öffentliche Halbfertig-Site,
- keine Duplikate bei mehrfacher Aktivierungsanfrage,
- Dashboard-/Website-/Widget-Parität.

### Accessibility und UX

- komplette Tastaturbedienung,
- sichtbarer Fokus,
- `prefers-reduced-motion` ohne Informationsverlust,
- Screenreader-Status bei Upload/Publish,
- Mobile-Touchflächen,
- keine Bearbeitung nur über Hover.

---

## 17. Observability und Betrieb

Jeder Publish-Vorgang trägt durchgehend:

- `intentId`,
- `tenantId` sobald vorhanden,
- `userId` sobald vorhanden,
- `requestId`,
- `correlationId`,
- aktuellen Saga-Schritt.

Metriken:

- Intent erstellt,
- Magic Link bestätigt,
- Aktivierung gestartet,
- pro Schritt Erfolg/Fehler/Dauer,
- veröffentlichte Website,
- aktivierte Buchung,
- Abbruchstelle,
- Retry-Anzahl,
- Asset-Grösse und Processing-Fehler.

Keine Metrik enthält Bilddaten, Website-Texte oder Kontakt-PII im Klartext.

Plattformfehler werden für irreversible oder wiederholt scheiternde Aktivierungen als `PlatformIssue` sichtbar.

---

## 18. Bewusste Nicht-Ziele dieses Plans

- Google-Review-API,
- automatische Review-Synchronisierung,
- Google-Kalender-Sync,
- mehrere Standorte im Free Builder,
- eigene Domain/DNS im ersten Publish,
- Vorher-Nachher-Galerie,
- anonyme Bilduploads,
- beliebige Branchen,
- KI-Schlüssel oder Providerwahl im Browser,
- vollständige Medienbibliothek,
- komplexe Rollen-/Einladungsverwaltung im Builder,
- Paket-/Capability-Migration im ersten Builder-Publish (eigener Produkt- und Architekturstrang, Paketarchitektur PR #382),
- automatische erfundene Inhalte.

**ENTSCHEID / Abgrenzung:** Die Plan-/Capability-Migration ist ein eigener grösserer Produkt- und Architekturstrang (Paketarchitektur PR #382) und kein beiläufiger, im Builder-Publish versteckter Bestandteil. Für den ersten Aktivierungsfluss genügt eine explizite, getestete Zuweisung des bestehenden FREE-Tiers (§11.5, Schritt `02 APPLY_TENANT_PROFILE`); die spätere Paketarchitektur wird separat und kontrolliert migriert.

---

## 19. Release-Gates

Der neue Hauptbutton darf erst `Website veröffentlichen` heissen, wenn alle folgenden Punkte wahr sind:

1. Builder läuft produktiv same-origin mit dem SaaS.
2. Draft V2 und IndexedDB-Migration sind abgenommen.
3. Team↔Service-Zuordnung wird explizit und atomar gespeichert.
4. Business Hours besitzen eine eigene zentrale Wahrheit.
5. Authentifizierter Hero-/Portrait-/Galerie-Upload ist produktionsfähig.
6. Magic-Link-Consume bindet genau einen Tenant an genau einen Intent; ein Prefetch-/Scanner-Aufruf des Links erzeugt weder Consume noch Tenant noch Intent-Statuswechsel (Bestätigungsseite, Consume erst bei Submit).
7. Aktivierung ist idempotent und fortsetzbar.
8. Site bleibt bis zum vollständigen Cutover nicht öffentlich sichtbar.
9. Server-Readiness autorisiert die Buchungsfreigabe.
10. Der Ende-zu-Ende-Pflichtpfad ist auf Desktop und Mobile grün.
11. Dashboard, Website und Widget zeigen denselben Katalog, dasselbe Team und dieselben Zeiten.
12. Keine API-Keys, Intake-Secrets oder langlebigen Aktivierungstokens befinden sich im Browser.
13. Impressum und Datenschutzseite entstehen als echte, danach editierbare CMS-Seiten; unvollständige rechtliche Mindestangaben blockieren den Publish (`LEGAL_PAGES_INCOMPLETE`).

---

## 20. Definition of Done

Der Ausbau ist abgeschlossen, wenn ein realer Coiffeursalon den gesamten Pfad ohne technische Hilfe durchlaufen kann und anschliessend im Dashboard genau die Daten wiederfindet, die er im Builder angelegt hat.

Das Produktversprechen lautet dann wahrheitsgemäss:

> Erstelle deine Salon-Website, bestätige deine E-Mail und werde direkt online buchbar — mit 100 freien Buchungen pro Monat.

Nicht der Klick auf den Button ist der Erfolg. Erfolg ist eine öffentlich erreichbare, korrekt befüllte Website mit einer tatsächlich funktionierenden Buchung und einem vertrauten Dashboard dahinter.

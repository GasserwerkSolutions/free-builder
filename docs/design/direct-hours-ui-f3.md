# F3 — Direkte Zeiten-UI

**Status:** ENTSCHEID — implementation. Branch `feat/direct-hours-ui`, off `main@edb03c7`.
**Scope:** Aktivierungsplan Phase F3 (Owner-Go 2026-07-17). Rein `free-builder`.

## 1. Ausgangslage (VERIFIZIERT)

Der Datenvertrag trägt F3 bereits:
- `ScheduleDay = { dayOfWeek, closed, ranges: TimeRange[] }`, `TimeRange = {from,to}` (domain-model.ts:12-14); genutzt für `businessHours` (Salon) UND `Staff.workingHours` — **identische Struktur**.
- `normalizeDraftV2` klemmt auf **max 4 Ranges/Tag** (domain-normalize.ts:17) und injiziert bei offenem Tag ohne Range einen Default.
- `validateWeeklySchedule` prüft **HH:MM, from<to, Overlap** (sortiert) mit deutschen Meldungen (domain-normalize.ts:25-39).
- Persistenz: `store.mutate` → re-normalisiert → debounced IndexedDB-Write; `flush()` erzwingt Schreiben.

Die **UI** editiert heute nur `ranges[0]` (renderHours ui-render.ts:56, handleInput ui-actions.ts:100-102). Team hat nur einen bedingungslosen Copy-Button (team-ui.ts:79), **keinen** Pro-Person-Editor. Tests importieren aus `assets/` (kompiliert), node:test, keine DOM-Tests.

## 2. Gate (bindend)

> Getrennte Änderungen bleiben nach Reload getrennt. (Salon-Öffnungszeiten und persönliche Arbeitszeiten sind unabhängig; eine Änderung der einen verändert die andere nicht.)

## 3. Domänen-Ergänzungen (pur, testbar) — neues Modul `src/domain-schedule.ts`

Reine Funktionen auf `WeeklySchedule` (wiederverwendbar für Salon UND Staff, da gleiche Struktur), jeweils **neue** Schedule zurückgebend (immutabel):
- `setDayClosed(schedule, dow, closed)` — closed=true → `ranges:[]`; closed=false und leer → ein Default-Range.
- `setRangeField(schedule, dow, index, field: "from"|"to", value)` — setzt ein Feld eines Range; `closed=false`.
- `addRange(schedule, dow)` — hängt einen Range an (Start = `to` des letzten Range, +60 min, Clamp 23:59; **No-op bei bereits 4 Ranges**; setzt closed=false). Bewusst überlappungsarm; Validierung fängt Restfälle.
- `removeRange(schedule, dow, index)` — entfernt; bleibt 0 Ranges → Tag `closed=true, ranges:[]` (kein stiller Default-Re-Inject).
- `copyDayToDays(schedule, sourceDow, targetDows)` — kopiert `closed`+`ranges` (deep) des Quelltags auf Zieltage.

## 4. Erst-Copy-Semantik aufs Team (Rev.2 §3 — kritisch)

`copyBusinessHoursToStaff` überschreibt heute bedingungslos → **ändern**:
- Neuer Guard `staffHasPersonalHours(staff)` = mindestens ein nicht-geschlossener Tag mit ≥1 Range (d. h. nicht der `createClosedSchedule`-Nullzustand).
- `copyBusinessHoursToStaff(draft, staffClientId, { overwrite = false })` → Rückgabe `{ applied: boolean; reason?: "ALREADY_HAS_HOURS" }`:
  - Staff leer ODER `overwrite=true` → kopiert (`applied:true`).
  - Staff hat Zeiten UND `overwrite=false` → **kein** Überschreiben (`applied:false, reason:"ALREADY_HAS_HOURS"`).
- **Nie still destruktiv.** Wiederholbar. Die UI entscheidet über `overwrite` per ausdrücklicher Bestätigung.

## 5. UI-Ergänzungen

**Öffnungszeitenblock (renderHours + handleInput/handleClick):**
- Rendert ALLE Ranges pro offenem Tag (nicht nur [0]); je Range zwei `time`-Inputs + „Entfernen"-Button (`data-hour-action="remove-range"` mit `data-range-index`).
- Pro Tag „+ Intervall / Pause"-Button (`data-hour-action="add-range"`), **ausgeblendet bei 4 Ranges**.
- `closed`-Checkbox pro Tag (bestehend).
- „Auf andere Tage übernehmen" pro Tag (`data-hour-action="copy-day"` → copyDayToDays auf alle anderen offenen/gewählten Tage; MVP: auf alle übrigen Tage).
- **Validierungs-Anzeige:** `validateWeeklySchedule(businessHours)` als Fehlerliste über/unter dem Block rendern (Meldungen existieren bereits).

**Team-Karte (team-ui.ts) — Pro-Person-Editor:**
- Derselbe Range-Editor je Staff, aber **eigener Namespace `data-staff-hour-field` / `data-staff-hour-action`** (getrennter Delegator in team-ui, sonst Kreuz-Kollision mit dem Business-Hours-Handler — Fallstrick!). Schreibt `staff.workingHours` via store.mutate.
- Copy-Button: bei leerem Staff direkt kopieren; bei vorhandenen Zeiten **Bestätigung** („bestehende persönliche Zeiten überschreiben?") vor `overwrite:true`. Optionaler Gruppen-/Alle-Copy zeigt betroffene Personen vor dem Überschreiben.

**Event-Wiring (Fallstrick):** Business-Hours und Staff-Hours haben getrennte, global auf `document` lauschende Delegatoren; strikt getrennte `data-*`-Namespaces. Dynamische Range-Rows brauchen `data-range-index` + `[data-day-of-week]`-Scope. `addRange`/`removeRange` bauen gezielt die Tageszeile neu (Fokus-schonend wo möglich); beachte, dass `normalizeDraftV2` bei jeder Mutation Cap 4 + `closed→[]` erneut anwendet.

## 6. Tests (Gate + pure Logik)

1. `domain-schedule`: add (inkl. No-op bei 4), remove (letzter → closed), setRangeField, copyDayToDays.
2. **Erst-Copy-Semantik:** leerer Staff → kopiert; Staff mit Zeiten + overwrite=false → unverändert (`applied:false`); overwrite=true → kopiert. `staffHasPersonalHours`.
3. `validateWeeklySchedule`: Pause-Split ohne Overlap gültig; überlappende 2 Intervalle → Fehler (ergänzend zu Bestehendem).
4. **Reload-Trennungs-Gate:** MemoryDraftRepository; businessHours (2. Range) und ein Staff.workingHours getrennt mutieren → flush → neu laden → beide unabhängig erhalten; Änderung an einem lässt den anderen unberührt.

## 7. Build / Gate

`npm run check` (typecheck + build + node --test) muss grün sein; **kompilierte `assets/*.js` mitcommitten** (CI: `git diff --exit-code -- assets`). Englische Code-Kommentare; deutsche it()-Strings. Kein Self-Merge; NICHT mit G2 beginnen.

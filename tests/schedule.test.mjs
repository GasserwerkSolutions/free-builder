import test from "node:test";
import assert from "node:assert/strict";
import {
  addRange,
  copyBusinessHoursToStaff,
  copyDayToDays,
  createClosedSchedule,
  createDefaultDraft,
  createDefaultSchedule,
  createStaffDraft,
  removeRange,
  setRangeField,
  staffHasPersonalHours,
  validateWeeklySchedule,
} from "../assets/domain.js";
import { MemoryDraftRepository } from "../assets/persistence.js";
import { BuilderStore } from "../assets/store.js";

// Build a full 7-day schedule with a single open day, all others closed.
function scheduleWithOpenDay(dow, ranges) {
  return createClosedSchedule().map((day) => (day.dayOfWeek === dow ? { dayOfWeek: dow, closed: false, ranges } : day));
}

function dayOf(schedule, dow) {
  return schedule.find((day) => day.dayOfWeek === dow);
}

test("addRange hängt eine Spanne an und ist bei vier Spannen ein No-op", () => {
  const base = createDefaultSchedule(); // Dienstag (2) offen 09:00–18:00
  const step1 = addRange(base, 2);
  assert.equal(dayOf(base, 2).ranges.length, 1, "Original bleibt unverändert");
  assert.equal(dayOf(step1, 2).ranges.length, 2);
  assert.equal(dayOf(step1, 2).ranges[1].from, "19:00");
  const filled = addRange(addRange(step1, 2), 2); // jetzt vier Spannen
  assert.equal(dayOf(filled, 2).ranges.length, 4);
  const capped = addRange(filled, 2);
  assert.equal(dayOf(capped, 2).ranges.length, 4, "keine fünfte Spanne");
  assert.deepEqual(capped, filled, "No-op verändert die Spannen nicht");
});

test("removeRange schliesst den Tag, wenn die letzte Spanne entfernt wird", () => {
  const base = scheduleWithOpenDay(3, [{ from: "09:00", to: "12:00" }, { from: "13:00", to: "18:00" }]);
  const afterFirst = removeRange(base, 3, 0);
  assert.equal(dayOf(afterFirst, 3).closed, false);
  assert.equal(dayOf(afterFirst, 3).ranges.length, 1);
  assert.equal(dayOf(afterFirst, 3).ranges[0].from, "13:00");
  const afterLast = removeRange(afterFirst, 3, 0);
  assert.equal(dayOf(afterLast, 3).closed, true);
  assert.deepEqual(dayOf(afterLast, 3).ranges, []);
});

test("setRangeField setzt ein Feld und öffnet den Tag", () => {
  const base = scheduleWithOpenDay(4, [{ from: "09:00", to: "18:00" }]);
  const next = setRangeField(base, 4, 0, "from", "10:30");
  assert.equal(dayOf(next, 4).ranges[0].from, "10:30");
  assert.equal(dayOf(next, 4).ranges[0].to, "18:00");
  assert.equal(dayOf(base, 4).ranges[0].from, "09:00", "Original bleibt unverändert");
});

test("copyDayToDays kopiert closed und Spannen tief auf die Zieltage", () => {
  const base = scheduleWithOpenDay(2, [{ from: "08:00", to: "16:00" }]);
  const next = copyDayToDays(base, 2, [1, 3]);
  assert.equal(dayOf(next, 1).closed, false);
  assert.equal(dayOf(next, 1).ranges[0].from, "08:00");
  assert.equal(dayOf(next, 3).ranges[0].to, "16:00");
  assert.equal(dayOf(next, 5).closed, true, "nicht anvisierte Tage bleiben unberührt");
  next[1].ranges[0].from = "05:00";
  assert.equal(dayOf(base, 2).ranges[0].from, "08:00", "Quelle bleibt entkoppelt (tiefe Kopie)");
});

test("Erst-Copy: leerer Staff wird kopiert, vorhandene Zeiten nicht still überschrieben", () => {
  const draft = createDefaultDraft("2026-07-17T12:00:00.000Z");
  const person = createStaffDraft();
  draft.staff.push(person);
  const id = person.clientId;

  assert.equal(staffHasPersonalHours(person), false);
  const first = copyBusinessHoursToStaff(draft, id);
  assert.deepEqual(first, { applied: true });
  assert.equal(staffHasPersonalHours(draft.staff[0]), true);
  assert.deepEqual(draft.staff[0].workingHours, draft.businessHours);

  // Öffnungszeiten ändern, dann ohne overwrite kopieren: Staff bleibt unverändert.
  draft.businessHours = scheduleWithOpenDay(0, [{ from: "06:00", to: "07:00" }]);
  const snapshot = JSON.parse(JSON.stringify(draft.staff[0].workingHours));
  const guarded = copyBusinessHoursToStaff(draft, id);
  assert.deepEqual(guarded, { applied: false, reason: "ALREADY_HAS_HOURS" });
  assert.deepEqual(draft.staff[0].workingHours, snapshot, "persönliche Zeiten bleiben erhalten");

  // Mit overwrite wird kopiert.
  const forced = copyBusinessHoursToStaff(draft, id, { overwrite: true });
  assert.deepEqual(forced, { applied: true });
  assert.deepEqual(draft.staff[0].workingHours, draft.businessHours);
});

test("validateWeeklySchedule akzeptiert Pausen-Split und meldet Überschneidung", () => {
  const valid = scheduleWithOpenDay(2, [{ from: "09:00", to: "12:00" }, { from: "13:00", to: "18:00" }]);
  assert.deepEqual(validateWeeklySchedule(valid), []);
  const overlapping = scheduleWithOpenDay(2, [{ from: "09:00", to: "12:00" }, { from: "11:00", to: "14:00" }]);
  assert.ok(validateWeeklySchedule(overlapping).some((error) => error.includes("überlappende")));
});

test("Reload-Trennungs-Gate: Öffnungszeiten und persönliche Arbeitszeiten bleiben unabhängig", async () => {
  const repository = new MemoryDraftRepository();
  const base = createDefaultDraft("2026-07-17T12:00:00.000Z");
  base.staff.push(createStaffDraft());
  const staffId = base.staff[0].clientId;
  const store = new BuilderStore(base, repository, 1);

  // Erst persönliche Zeiten von den Öffnungszeiten ableiten (Dienstag: eine Spanne 09:00–18:00).
  store.mutate((draft) => { copyBusinessHoursToStaff(draft, staffId, { overwrite: true }); });
  // Öffnungszeiten Dienstag um eine zweite Spanne ergänzen.
  store.mutate((draft) => { draft.businessHours = addRange(draft.businessHours, 2); });
  // Persönliche Zeiten Dienstag getrennt anpassen (Beginn der ersten Spanne).
  store.mutate((draft) => {
    const person = draft.staff.find((item) => item.clientId === staffId);
    person.workingHours = setRangeField(person.workingHours, 2, 0, "from", "07:30");
  });
  await store.flush();

  const reloaded = await repository.getDraft(base.draftId);
  const bizTue = dayOf(reloaded.businessHours, 2);
  const staffTue = dayOf(reloaded.staff[0].workingHours, 2);

  assert.equal(bizTue.ranges.length, 2, "zweite Öffnungs-Spanne durablisiert");
  assert.equal(bizTue.ranges[0].from, "09:00", "Staff-Änderung hat die Öffnungszeiten nicht berührt");
  assert.equal(staffTue.ranges.length, 1, "Öffnungs-Spanne ist nicht in die persönlichen Zeiten geleckt");
  assert.equal(staffTue.ranges[0].from, "07:30", "persönliche Änderung durablisiert");
});

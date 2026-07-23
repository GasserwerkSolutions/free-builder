import test from "node:test";
import assert from "node:assert/strict";
import { adjacentReorderIndex, moveArrayItem, pointerInsertionIndex } from "../assets/reorder-core.js";

// Die Rechenkerne des Umsortierens, ohne DOM und ohne Entwurf.

test("moveArrayItem verschiebt in beide Richtungen und lässt die Länge unverändert", () => {
  const list = ["a", "b", "c", "d"];
  assert.equal(moveArrayItem(list, 0, 2), true);
  assert.deepEqual(list, ["b", "c", "a", "d"]);
  assert.equal(moveArrayItem(list, 3, 0), true);
  assert.deepEqual(list, ["d", "b", "c", "a"]);
});

test("moveArrayItem weist jede sinnlose Anfrage ab, statt still etwas anderes zu tun", () => {
  const list = ["a", "b", "c"];
  for (const [from, to] of [[1, 1], [-1, 0], [0, -1], [3, 0], [0, 3], [0.5, 1], [0, Number.NaN]]) {
    assert.equal(moveArrayItem(list, from, to), false, `${from} -> ${to}`);
  }
  assert.deepEqual(list, ["a", "b", "c"], "eine abgewiesene Anfrage lässt die Liste unberührt");
  assert.equal(moveArrayItem([], 0, 0), false);
});

test("adjacentReorderIndex endet an den Rändern statt zu überlaufen", () => {
  assert.equal(adjacentReorderIndex(1, "up", 3), 0);
  assert.equal(adjacentReorderIndex(1, "down", 3), 2);
  assert.equal(adjacentReorderIndex(0, "up", 3), null);
  assert.equal(adjacentReorderIndex(2, "down", 3), null);
  assert.equal(adjacentReorderIndex(0, "up", 1), null);
  assert.equal(adjacentReorderIndex(-1, "down", 3), null);
  assert.equal(adjacentReorderIndex(3, "down", 3), null);
  assert.equal(adjacentReorderIndex(0, "down", 0), null);
});

test("pointerInsertionIndex trennt bei der Hälfte der Karte und fällt ans Ende", () => {
  const boxes = [{ top: 0, height: 100 }, { top: 100, height: 100 }, { top: 200, height: 100 }];
  assert.equal(pointerInsertionIndex(10, boxes), 0);
  assert.equal(pointerInsertionIndex(49, boxes), 0);
  assert.equal(pointerInsertionIndex(51, boxes), 1);
  assert.equal(pointerInsertionIndex(151, boxes), 2);
  assert.equal(pointerInsertionIndex(400, boxes), 3, "unterhalb aller Karten landet der Eintrag am Ende");
  assert.equal(pointerInsertionIndex(0, []), 0, "ohne Nachbarn gibt es nur die Position 0");
});

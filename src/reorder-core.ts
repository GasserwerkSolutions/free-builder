// The arithmetic of reordering, with no DOM and no draft in sight.
//
// Every reorder path — arrow button, Alt + arrow key, drag — ends in the same two questions: which
// index does the item go to, and is that move legal at all? They are answered here so the surface
// code below can stay about events, and so the answers can be tested without a browser.

export type ReorderDirection = "up" | "down";

/** Move one item inside an array in place. False means the request was not carried out. */
export function moveArrayItem<T>(items: T[], fromIndex: number, toIndex: number): boolean {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return false;
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length || fromIndex === toIndex) return false;
  const [item] = items.splice(fromIndex, 1);
  if (item === undefined) return false;
  items.splice(toIndex, 0, item);
  return true;
}

/** The neighbouring index in the given direction, or null at the end of the list. */
export function adjacentReorderIndex(currentIndex: number, direction: ReorderDirection, itemCount: number): number | null {
  if (!Number.isInteger(currentIndex) || itemCount < 1 || currentIndex < 0 || currentIndex >= itemCount) return null;
  const nextIndex = currentIndex + (direction === "up" ? -1 : 1);
  return nextIndex >= 0 && nextIndex < itemCount ? nextIndex : null;
}

/**
 * Where a pointer at `pointerY` drops between the remaining cards. `candidates` are the boxes of the
 * list WITHOUT the dragged item, in document order, so the result is directly the target index.
 */
export function pointerInsertionIndex(pointerY: number, candidates: readonly { top: number; height: number }[]): number {
  const index = candidates.findIndex((candidate) => pointerY < candidate.top + candidate.height / 2);
  return index < 0 ? candidates.length : index;
}

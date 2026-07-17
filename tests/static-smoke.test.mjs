import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("static entry loads the compiled module and no legacy global scripts", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /type="module" src="assets\/main\.js"/);
  assert.doesNotMatch(html, /src="(?:app|state|website|ui-core|ui-content|ui-actions)\.js"/);
  assert.doesNotMatch(html, /data-bind="salon\.(?:bookingUrl|heroImage)"/);
});

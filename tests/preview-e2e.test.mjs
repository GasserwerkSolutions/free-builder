import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

// The parts jsdom structurally cannot answer: a real sandboxed iframe with an opaque origin, real
// layout, real scrolling, and the question of whether an edit actually patches the live document
// instead of rebuilding it.
//
// Locally this test skips — loudly — when no browser can be found, rather than pretending to have
// run. Set CHROME_PATH (or CHROME_BIN, which the GitHub runner image already sets) to point it at
// one. In CI it does NOT skip: this is the only test with a real layout engine, and `node --test`
// ends a skipped test with exit 0, so a silently disappearing browser would silently disappear the
// gate with it. There it fails instead.
const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.CHROME_BIN,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

async function findBrowser() {
  for (const candidate of CANDIDATES) {
    if (!candidate) continue;
    try { await access(candidate); return candidate; } catch { /* try the next one */ }
  }
  return null;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

async function staticServer() {
  const root = normalize(fileURLToPath(new URL("../", import.meta.url)));
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://local").pathname);
      const path = normalize(join(root, pathname === "/" ? "index.html" : pathname.slice(1)));
      if (!path.startsWith(root) || !(await stat(path)).isFile()) throw new Error("not found");
      response.setHeader("content-type", MIME[extname(path)] ?? "application/octet-stream");
      response.end(await readFile(path));
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const executablePath = await findBrowser();
const inCi = Boolean(process.env.CI);
const skip = executablePath || inCi ? false : "Kein Chromium gefunden — CHROME_PATH oder CHROME_BIN setzen";

test("echte Vorschau im Chromium: Patch statt Neuaufbau, Klick springt ins Feld", { timeout: 90_000, skip }, async () => {
  assert.ok(executablePath, `In CI muss ein Browser vorhanden sein. Gesucht wurde in: ${CANDIDATES.filter(Boolean).join(", ")}. CHROME_PATH oder CHROME_BIN setzen oder einen Browser installieren.`);
  const { server, url } = await staticServer();
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1440, height: 900 } });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#previewFrame");
    const frameHandle = await page.$("#previewFrame");
    let preview = await frameHandle.contentFrame();
    await preview.waitForSelector("h1 .preview-edit-trigger");

    // The exported page carries no instrumentation; the preview does. Same renderer, one flag apart.
    assert.ok(await preview.$('[data-preview-region="hero"]'));
    assert.ok(await preview.$('[data-preview-section="leistungen"]'));

    // Scroll the preview somewhere, then edit. A patch keeps both the document and the position.
    await preview.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; scrollTo(0, document.querySelector("#zeiten").offsetTop); });
    const scrollBefore = await preview.evaluate(() => scrollY);
    assert.ok(scrollBefore > 0, "die Vorschau ist wirklich gescrollt");
    const srcdocBefore = await page.$eval("#previewFrame", (frame) => frame.getAttribute("srcdoc"));

    await page.click('[data-panel-target="copy"]');
    const liveTitle = `Sofort sichtbarer Titel ${Date.now()}`;
    await page.$eval('[data-bind="copy.heroTitle"]', (input, value) => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, liveTitle);

    await preview.waitForFunction((value) => document.querySelector("h1").textContent.trim() === value, { timeout: 5000 }, liveTitle);
    // The decisive assertion: the iframe was never rebuilt, so this was a real patch.
    assert.equal(await page.$eval("#previewFrame", (frame) => frame.getAttribute("srcdoc")), srcdocBefore, "srcdoc unverändert — es war ein Patch, kein Neuaufbau");
    assert.ok(Math.abs(await preview.evaluate(() => scrollY) - scrollBefore) <= 2, "die Scrollposition bleibt stehen");

    // A colour change patches the custom properties in place, again without a rebuild.
    await page.click('[data-panel-target="design"]');
    await page.$eval('[data-bind="theme.primary"]', (input) => { input.value = "#123456"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await preview.waitForFunction(() => document.documentElement.style.getPropertyValue("--primary") === "#123456", { timeout: 5000 });
    assert.equal(await page.$eval("#previewFrame", (frame) => frame.getAttribute("srcdoc")), srcdocBefore);

    // Click in the preview: the editor opens the matching field and focuses it.
    await preview.click("h1 .preview-edit-trigger");
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-bind") === "copy.heroTitle", { timeout: 5000 });
    assert.equal(await page.$eval('[data-panel="copy"]', (panel) => panel.hidden), false);

    // A new service replaces the services block — still a patch, still no rebuild.
    await page.click('[data-panel-target="services"]');
    await page.click('[data-action="add-service"]');
    await preview.waitForFunction(() => [...document.querySelectorAll(".price-row h4")].some((heading) => heading.textContent.trim() === "Neue Leistung"), { timeout: 5000 });
    assert.equal(await page.$eval("#previewFrame", (frame) => frame.getAttribute("srcdoc")), srcdocBefore, "auch eine neue Leistung ist ein Regionentausch");

    // A preset is a whole new stylesheet: that one has to rebuild, and the preview has to come back.
    await page.click('[data-panel-target="design"]');
    await page.click('[data-preset="bold"]');
    await page.waitForFunction((previous) => document.querySelector("#previewFrame").getAttribute("srcdoc") !== previous, { timeout: 5000 }, srcdocBefore);
    preview = await (await page.$("#previewFrame")).contentFrame();
    await preview.waitForSelector("h1 .preview-edit-trigger");
    assert.equal(await preview.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()), "#311b4d");
    assert.equal(await preview.evaluate(() => document.querySelector("h1").textContent.trim()), liveTitle, "der gepatchte Stand überlebt den Neuaufbau");

    // Real navigation stays swallowed inside the preview.
    const before = preview.url();
    const mail = await preview.$('a[href^="mailto:"]');
    if (mail) await mail.click();
    assert.equal(preview.url(), before);
  } finally {
    await browser.close();
    server.close();
  }
});

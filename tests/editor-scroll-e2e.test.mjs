import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

// Scrolling is layout, and jsdom computes no layout: it reports 0 for every height and would pass
// this file green on a completely broken shell. The proof therefore belongs in a real engine.
//
// Same contract as tests/preview-e2e.test.mjs: locally the test skips loudly when no browser can be
// found, in CI it fails instead, because a silently skipped browser test is a silently missing gate.
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

/** Enough services that the panel is taller than any plausible window. */
const EXTRA_SERVICES = 14;

/** Wait out the panel-turn animation, whose 3D transform would otherwise be measured as overflow. */
function settleSurfaceAnimation(page) {
  return page.waitForFunction(
    () => document.getElementById("surfaceCard").getAnimations().every((animation) => animation.playState !== "running"),
    { timeout: 5_000 },
  );
}

const executablePath = await findBrowser();
const inCi = Boolean(process.env.CI);
const skip = executablePath || inCi ? false : "Kein Chromium gefunden — CHROME_PATH oder CHROME_BIN setzen";

test("echtes Layout: die geöffnete Bearbeitungsfläche scrollt intern, der Seitenrahmen steht", { timeout: 120_000, skip }, async () => {
  assert.ok(executablePath, `In CI muss ein Browser vorhanden sein. Gesucht wurde in: ${CANDIDATES.filter(Boolean).join(", ")}. CHROME_PATH oder CHROME_BIN setzen oder einen Browser installieren.`);
  const { server, url } = await staticServer();
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1440, height: 900 } });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#surfaceStage [data-service-card]", { visible: false });

    // Fill the panel through the surface itself, exactly like a salon with a long price list.
    await page.click('[data-panel-target="services"]');
    for (let index = 0; index < EXTRA_SERVICES; index += 1) await page.click('[data-action="add-service"]');
    await page.waitForFunction((expected) => document.querySelectorAll("[data-service-card]").length >= expected, { timeout: 15_000 }, EXTRA_SERVICES + 3);
    await settleSurfaceAnimation(page);

    // 1) The stage is the scroll container, and it really has more content than room.
    const geometry = await page.evaluate(() => {
      const stage = document.getElementById("surfaceStage");
      return {
        stageScroll: stage.scrollHeight,
        stageClient: stage.clientHeight,
        cardHeight: document.getElementById("surfaceCard").getBoundingClientRect().height,
        docScroll: document.scrollingElement.scrollHeight,
        viewport: window.innerHeight,
      };
    });
    assert.ok(geometry.cardHeight > geometry.viewport, `der Inhalt ist wirklich länger als das Fenster (${geometry.cardHeight} > ${geometry.viewport})`);
    assert.ok(
      geometry.stageScroll > geometry.stageClient + 100,
      `die Bearbeitungsfläche scrollt intern (scrollHeight ${geometry.stageScroll} > clientHeight ${geometry.stageClient})`,
    );

    // 2) ... and the page around it does not grow past the viewport.
    assert.ok(
      geometry.docScroll <= geometry.viewport + 1,
      `das Dokument bleibt auf Fensterhöhe (scrollHeight ${geometry.docScroll} <= ${geometry.viewport})`,
    );

    // 3) A real wheel over the sidebar moves the sidebar, not the page — and the preview stays put.
    const frameBefore = await page.$eval("#previewFrame", (frame) => frame.getBoundingClientRect().top);
    const stageCentre = await page.$eval("#surfaceStage", (stage) => {
      const rect = stage.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(stageCentre.x, stageCentre.y);
    await page.mouse.wheel({ deltaY: 900 });
    await page.waitForFunction(() => document.getElementById("surfaceStage").scrollTop > 0, { timeout: 5_000 });

    const scrolled = await page.evaluate(() => {
      const frame = document.getElementById("previewFrame").getBoundingClientRect();
      return {
        stageScrollTop: document.getElementById("surfaceStage").scrollTop,
        docScrollTop: document.scrollingElement.scrollTop,
        frameTop: frame.top,
        frameBottom: frame.bottom,
        viewport: window.innerHeight,
      };
    });
    assert.ok(scrolled.stageScrollTop > 0, "ein Scrollversuch verändert scrollTop der Bearbeitungsfläche");
    assert.equal(scrolled.docScrollTop, 0, "das Dokument selbst scrollt dabei nicht");
    assert.ok(Math.abs(scrolled.frameTop - frameBefore) <= 1, "die Vorschau wandert nicht mit");
    assert.ok(scrolled.frameTop >= 0 && scrolled.frameTop < scrolled.viewport && scrolled.frameBottom > 0, "die Vorschau bleibt sichtbar");

    // 4) The collapse button survives the new overflow: inside the window and actually the hit target.
    const toggle = await page.evaluate(() => {
      const button = document.getElementById("sidebarToggle");
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        hits: Boolean(hit && (hit === button || button.contains(hit))),
      };
    });
    assert.ok(toggle.rect.width > 0 && toggle.rect.height > 0, "der Einklapp-Knopf hat eine Fläche");
    assert.ok(
      toggle.rect.top >= 0 && toggle.rect.bottom <= toggle.viewport.height && toggle.rect.left >= 0 && toggle.rect.right <= toggle.viewport.width,
      `der Einklapp-Knopf liegt im Fenster (${JSON.stringify(toggle.rect)} in ${JSON.stringify(toggle.viewport)})`,
    );
    assert.ok(toggle.hits, "der Einklapp-Knopf ist nicht vom neuen overflow abgeschnitten");

    // ... and it still works in both directions.
    await page.click("#sidebarToggle");
    await page.waitForFunction(() => document.getElementById("sidebarToggle").getAttribute("aria-expanded") === "false", { timeout: 5_000 });
    const collapsed = await page.evaluate(() => ({
      stageWidth: document.getElementById("surfaceStage").getBoundingClientRect().width,
      docScroll: document.scrollingElement.scrollHeight,
      viewport: window.innerHeight,
    }));
    assert.equal(Math.round(collapsed.stageWidth), 0, "eingeklappt bleibt die Spalte auf 0");
    assert.ok(collapsed.docScroll <= collapsed.viewport + 1, "auch eingeklappt wächst die Seite nicht");
    await page.click("#sidebarToggle");
    await page.waitForFunction(() => document.getElementById("sidebarToggle").getAttribute("aria-expanded") === "true", { timeout: 5_000 });

    // 5) The jump from the preview into a field has to bring the new scroll container along.
    const firstServiceId = await page.$eval("[data-service-card]", (card) => card.dataset.serviceId);
    const preview = await (await page.$("#previewFrame")).contentFrame();
    await preview.waitForFunction((id) => [...document.querySelectorAll("[data-preview-target]")].some((element) => element.dataset.previewTarget.includes(id)), { timeout: 10_000 }, firstServiceId);
    await page.evaluate(() => { const stage = document.getElementById("surfaceStage"); stage.scrollTop = stage.scrollHeight; });
    const beforeJump = await page.evaluate((id) => {
      const field = document.querySelector(`[data-service-card][data-service-id="${id}"] [data-service-field="name"]`);
      const stage = document.getElementById("surfaceStage");
      return { above: field.getBoundingClientRect().bottom < stage.getBoundingClientRect().top, scrollTop: stage.scrollTop };
    }, firstServiceId);
    assert.ok(beforeJump.scrollTop > 0, "die Fläche lässt sich ans Ende scrollen");
    assert.ok(beforeJump.above, "das Ziel liegt vor dem Sprung ausserhalb der sichtbaren Fläche");

    await preview.evaluate((id) => {
      const trigger = [...document.querySelectorAll("[data-preview-target]")].find((element) => {
        try {
          const target = JSON.parse(element.dataset.previewTarget);
          return target.kind === "service" && target.field === "name" && target.serviceClientId === id;
        } catch { return false; }
      });
      if (!trigger) throw new Error("kein Vorschau-Ziel für die erste Leistung gefunden");
      trigger.click();
    }, firstServiceId);
    await page.waitForFunction((id) => document.activeElement?.closest?.("[data-service-card]")?.dataset.serviceId === id, { timeout: 5_000 }, firstServiceId);
    const afterJump = await page.evaluate(() => {
      const field = document.activeElement.getBoundingClientRect();
      const stage = document.getElementById("surfaceStage").getBoundingClientRect();
      return {
        insideStage: field.top >= stage.top - 1 && field.bottom <= stage.bottom + 1,
        insideWindow: field.top >= 0 && field.bottom <= window.innerHeight,
        docScrollTop: document.scrollingElement.scrollTop,
      };
    });
    assert.ok(afterJump.insideStage, "der neue Scrollcontainer folgt dem Sprung");
    assert.ok(afterJump.insideWindow, "das angesprungene Feld ist wirklich sichtbar");
    assert.equal(afterJump.docScrollTop, 0, "der Sprung scrollt nicht die ganze Seite");

    // Opening a panel plays a 3D turn on the card. That transform inflates the painted box for a
    // third of a second, so measuring heights while it runs measures the animation, not the layout.
    await settleSurfaceAnimation(page);

    // 6) A low window: the narrow section column overflows too, and has to scroll on its own.
    await page.setViewport({ width: 1440, height: 460 });
    await page.waitForFunction(() => document.querySelector(".surface-nav").getBoundingClientRect().height < 460, { timeout: 5_000 });
    const nav = await page.evaluate(() => {
      const column = document.querySelector(".surface-nav");
      column.scrollTop = 9_999;
      return {
        scroll: column.scrollHeight,
        client: column.clientHeight,
        scrollTop: column.scrollTop,
        docScroll: document.scrollingElement.scrollHeight,
        viewport: window.innerHeight,
      };
    });
    assert.ok(nav.scroll > nav.client, `die Bereichsspalte überläuft auf niedrigen Fenstern (${nav.scroll} > ${nav.client})`);
    assert.ok(nav.scrollTop > 0, "und sie scrollt dort selbst");
    assert.ok(nav.docScroll <= nav.viewport + 1, "auch dann wächst die Seite nicht");

    // 7) Tablet and phone keep the page scroll they had: no second scroll cage down there.
    for (const viewport of [{ width: 900, height: 800 }, { width: 390, height: 780 }]) {
      await page.setViewport(viewport);
      await page.waitForFunction((width) => window.innerWidth === width, { timeout: 5_000 }, viewport.width);
      const stacked = await page.evaluate(() => {
        const stage = document.getElementById("surfaceStage");
        return {
          scroll: stage.scrollHeight,
          client: stage.clientHeight,
          docScroll: document.scrollingElement.scrollHeight,
          viewport: window.innerHeight,
          caged: stage.scrollHeight > stage.clientHeight + 1,
          pageScrolls: document.scrollingElement.scrollHeight > window.innerHeight + 1,
        };
      });
      assert.equal(stacked.caged, false, `bei ${viewport.width}px entsteht kein zweiter Scrollkäfig (${JSON.stringify(stacked)})`);
      assert.equal(stacked.pageScrolls, true, `bei ${viewport.width}px scrollt weiterhin die Seite (${JSON.stringify(stacked)})`);
    }
  } finally {
    await browser.close();
    server.close();
  }
});

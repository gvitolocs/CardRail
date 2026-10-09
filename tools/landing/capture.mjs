// Screenshots of the real app for the /about landing page.
//   npx vite --port 5199 --strictPort &
//   node tools/landing/capture.mjs http://localhost:5199 /tmp/cr-shots
// The browser talks to route mocks that serve the sample workspace, so no
// account, Blob store or marketplace is touched.
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { buildSampleWorkspace, photoFiles } from "./sample-workspace.mjs";

const [base = "http://localhost:5199", out = "/tmp/cr-shots"] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PW_HOME || "/home/nez/.cache/cr-landing-tools/node_modules/playwright-core",
);
const workspace = await buildSampleWorkspace();
const allowed = new Set([new URL(base).host, "fonts.googleapis.com", "fonts.gstatic.com"]);
const errors = [];
mkdirSync(out, { recursive: true });

async function route(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (!allowed.has(url.host)) return route.abort();
  const api = /^\/api\/v1\/([a-z-]+)$/.exec(url.pathname)?.[1];
  if (!api) return route.continue();
  if (api === "photo") {
    const file = photoFiles.get(url.searchParams.get("id"));
    return file
      ? route.fulfill({ contentType: "image/jpeg", body: readFileSync(file) })
      : route.fulfill({ status: 404, json: { error: "Photo not found." } });
  }
  if (api === "capture") {
    const id = "0".repeat(32), secret = "0".repeat(48), code = "4821";
    return route.fulfill({
      json: { id, secret, code, expiresAt: Date.now() + 600000, url: `${base}/#capture=${id}&key=${secret}&code=${code}` },
    });
  }
  if (api === "developer") return route.fulfill({ json: { keys: [] } });
  return route.fulfill({ json: workspace });
}

async function open(browser, options, path, init) {
  const context = await browser.newContext(options);
  await context.route("**/*", route);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${path}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${path}: ${m.text()}`));
  await page.goto(base + path);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function shot(page, name, ready) {
  await ready.waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`${out}/${name}.png`);
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME || "/home/nez/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
});
try {
  const desktop = { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: "dark" };
  const desk = await open(browser, desktop, "/");
  await shot(desk, "desk-desktop", desk.getByText("Pikachu").first());
  for (const [label, name, text] of [
    ["Inventory", "inventory-desktop", "Rayquaza"],
    ["Pick run", "pick-desktop", "Picking list"],
    ["Platforms", "platforms-desktop", "Your stock. Everywhere you sell."],
  ]) {
    await desk.getByRole("button", { name: label, exact: true }).click();
    await shot(desk, name, desk.getByText(text).first());
  }

  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" };
  const scan = await open(browser, phone, "/", () => sessionStorage.setItem("cardrails_phone", "1"));
  // Headless Chromium has no camera; close that notice so the shot shows the idle preview.
  const dismiss = scan.getByRole("button", { name: "Dismiss" });
  await dismiss.click({ timeout: 5000 }).catch(() => {});
  await shot(scan, "phone-scan", scan.getByText("Connected to your desk").first());
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  for (const error of errors) console.error("page error:", error);
}

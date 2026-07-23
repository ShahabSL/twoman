import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.TWOMAN_DESKTOP_URL || "http://127.0.0.1:1420";
const screenshotDir = process.argv[2] || process.env.TWOMAN_DEPLOY_SCREENSHOT_DIR;
const browser = await chromium.launch({ channel: "msedge", headless: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function verifyViewport(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(150);
  const layout = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  assert(
    layout.bodyWidth <= layout.viewportWidth,
    `horizontal overflow at ${width}x${height}: ${layout.bodyWidth}px body`,
  );
}

async function resetScrollPositions(page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelectorAll("*").forEach((element) => {
      if (element.scrollHeight > element.clientHeight) {
        element.scrollTop = 0;
      }
    });
  });
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => window.localStorage.removeItem("twoman.deployCoachSeen"));
  await page.reload({ waitUntil: "networkidle" });

  assert(
    (await page.getByRole("heading", { name: "Choose a deployment mode" }).count()) === 0,
    "deployment coach opened in the Client workspace",
  );

  await page.getByRole("button", { name: "Deploy", exact: true }).first().click();
  await page.getByRole("heading", { name: "Choose a deployment mode" }).waitFor();
  for (let step = 0; step < 3; step += 1) {
    await page.getByRole("button", { name: "Next" }).click();
  }
  await page.getByRole("button", { name: "Done" }).click();
  assert(
    (await page.evaluate(() => window.localStorage.getItem("twoman.deployCoachSeen"))) === "true",
    "deployment coach completion was not persisted",
  );

  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByLabel("Camouflage site name").fill("Service Portal");
  await page.getByLabel("Upstream proxy label").fill("wireproxy");
  await page.getByLabel("Outbound proxy label").fill("wireproxy");
  await page.getByLabel("TLS verification").click();
  await page.getByRole("option", { name: "Allow invalid certificates" }).click();

  await page.getByRole("button", { name: "Remote SSH", exact: true }).click();
  await page.getByLabel("Server host").fill("hidden.example.test");
  await page.getByLabel("SSH user").fill("deploy-user");

  await page.getByLabel("Public origin").fill("https://host.example.test");
  await page.getByLabel("cPanel username").fill("cpanel-user");
  await page.getByLabel("cPanel password").fill("test-password");
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
    await resetScrollPositions(page);
    await page.screenshot({
      path: path.join(screenshotDir, "deployment-workspace-desktop.png"),
    });
  }
  await page.getByRole("button", { name: "Deploy", exact: true }).last().click();
  await page.getByText("Deployed default", { exact: true }).waitFor();
  const profileOutput = page.locator("textarea[readonly]").last();
  await profileOutput.waitFor();
  assert(
    (await profileOutput.inputValue()).startsWith("twoman://profile?data="),
    "deployment did not return client profile text",
  );

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("true", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Rollback", exact: true }).click();
  await page.getByText("Rolled back default", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Guide", exact: true }).click();
  await page.getByRole("heading", { name: "Choose a deployment mode" }).waitFor();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await verifyViewport(page, 1440, 1000);
  await verifyViewport(page, 390, 844);
  if (screenshotDir) {
    await page.getByRole("heading", { name: "Deploy server stack" }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(screenshotDir, "deployment-workspace-mobile.png"),
    });
  }
  console.log("TWOMAN DEPLOYMENT UI SMOKE OK");
} finally {
  await browser.close();
}

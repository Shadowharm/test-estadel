import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const themeKey = "integration-monitor-theme";

const themeLabels = {
  system: "Как в системе",
  light: "Светлая",
  dark: "Тёмная",
};
async function setTheme(
  page: import("@playwright/test").Page,
  value: keyof typeof themeLabels,
) {
  const button = page.getByRole("button", { name: /^Тема:/ });
  await expect(button).toBeEnabled();
  for (let index = 0; index < 3; index++) {
    const before = await button.getAttribute("aria-label");
    if (before?.startsWith(`Тема: ${themeLabels[value]}.`)) return;
    await button.click();
    await expect(button).not.toHaveAttribute("aria-label", before!);
  }
  throw new Error("Theme cycle did not reach the requested mode");
}

test("renders the journal, preserves themes and has no browser errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Журнал событий" }),
  ).toBeVisible();
  const select = page.getByRole("button", { name: /^Тема:/ });
  await expect(select).toBeEnabled();
  await setTheme(page, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(select).toHaveAttribute("aria-label", /^Тема: Тёмная\./);
  await setTheme(page, "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(errors).toEqual([]);
});

test("applies saved theme before hydration even with app scripts blocked", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.addInitScript(
    (key) => localStorage.setItem(key, "dark"),
    themeKey,
  );
  const page = await context.newPage();
  await page.route("**/_next/**/*.js*", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await context.close();
});

test("tracks OS changes and respects manual override", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await setTheme(page, "system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await setTheme(page, "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("synchronizes theme between tabs", async ({ context, page }) => {
  await page.goto("/");
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByRole("button", { name: /^Тема:/ })).toBeEnabled();
  await setTheme(page, "dark");
  await expect(other.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(other.getByRole("button", { name: /^Тема:/ })).toHaveAttribute(
    "aria-label",
    /^Тема: Тёмная\./,
  );
});

for (const theme of ["light", "dark"]) {
  test(`${theme}: reflow, keyboard and accessibility`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto("/");
    await setTheme(page, theme as keyof typeof themeLabels);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.reload();
    // Safari defaults to form controls on Tab; Option-Tab includes links.
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect(
      page.getByRole("link", { name: "Перейти к содержимому" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
    await page.keyboard.press("Tab");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
    await page.screenshot({
      path: `test-results/scaffold-${test.info().project.name}-${theme}-mobile.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/scaffold-${test.info().project.name}-${theme}-desktop.png`,
      fullPage: true,
    });
  });
}

test("does not expose data or env through static routes", async ({
  request,
}) => {
  for (const path of [
    "/data/events.db",
    "/events.db",
    "/.env.local",
    "/backups/events.db",
  ]) {
    expect((await request.get(path)).status()).toBe(404);
  }
});

// Event reads are public.
test("serves the paginated API with request metadata", async ({ request }) => {
  const response = await request.get("/api/events");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers()["x-request-id"]).toBeTruthy();
  const body = await response.json();
  expect(body.items).toBeInstanceOf(Array);
  expect(body.items.length).toBeLessThanOrEqual(50);
  expect(body.snapshot.token).toBeTruthy();
});

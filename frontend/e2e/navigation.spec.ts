import { test, expect } from "./fixtures";

test.describe("Navigation", () => {
  test("can navigate between pages via header links", async ({ page }) => {
    await page.goto("/");

    // Navigate to Search
    await page.locator("header nav").getByText("Search").click();
    await expect(page).toHaveURL(/\/search/);
    await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();

    // Navigate to Researchers
    await page.locator("header nav").getByText("Researchers").click();
    await expect(page).toHaveURL(/\/researchers/);
    await expect(page.getByRole("heading", { name: "Accredited Researchers" })).toBeVisible();

    // Navigate to Stats
    await page.locator("header nav").getByText("Stats").click();
    await expect(page).toHaveURL(/\/stats/);
    await expect(page.getByRole("heading", { name: "Platform Statistics" })).toBeVisible();

    // Navigate back to Papers
    await page.locator("header nav").getByText("Papers").click();
    await expect(page).toHaveURL("/");
  });

  test("paper card links to paper detail", async ({ page }) => {
    await page.goto("/");

    await page.getByText("Neural Network Plasticity in Adult Brains").click();
    await expect(page).toHaveURL(/\/paper\/alice\/neural-plasticity-2026/);
  });

  test("header logo links home", async ({ page }) => {
    await page.goto("/search");

    await page.locator("header").getByRole("link", { name: /pevo/i }).first().click();
    await expect(page).toHaveURL("/");
  });

  test("footer is visible on all pages", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("footer")).toBeVisible();

    await page.goto("/search");
    await expect(page.locator("footer")).toBeVisible();
  });
});

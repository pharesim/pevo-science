import { test, expect } from "./fixtures";

test.describe("Search", () => {
  test("renders search form", async ({ page }) => {
    await page.goto("/search");

    await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();
    await expect(page.getByPlaceholder("Search papers and reviews...")).toBeVisible();
    await expect(page.getByRole("button", { name: "Search" })).toBeVisible();
  });

  test("shows initial prompt when no search performed", async ({ page }) => {
    await page.goto("/search");

    await expect(page.getByText("Enter a search query to find papers and reviews.")).toBeVisible();
  });

  test("performs search and shows results", async ({ page }) => {
    await page.goto("/search");

    await page.getByPlaceholder("Search papers and reviews...").fill("neural");
    await page.getByRole("button", { name: "Search" }).click();

    await expect(page.getByText("1 result found")).toBeVisible();
    await expect(page.getByText("Neural Network Plasticity in Adult Brains")).toBeVisible();
  });

  test("shows no results for unmatched query", async ({ page }) => {
    await page.goto("/search");

    await page.getByPlaceholder("Search papers and reviews...").fill("nonexistent");
    await page.getByRole("button", { name: "Search" }).click();

    await expect(page.getByText("No results found for your search.")).toBeVisible();
  });

  test("search via URL query param", async ({ page }) => {
    await page.goto("/search?q=neural");

    await expect(page.getByText("1 result found")).toBeVisible();
    await expect(page.getByText("Neural Network Plasticity in Adult Brains")).toBeVisible();
  });

  test("has type and discipline filters", async ({ page }) => {
    await page.goto("/search");

    await expect(page.getByLabel("Type")).toBeVisible();
    await expect(page.getByLabel("Discipline")).toBeVisible();
  });
});

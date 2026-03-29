import { test, expect } from "./fixtures";

test.describe("Stats", () => {
  test("displays platform statistics", async ({ page }) => {
    await page.goto("/stats");

    await expect(page.getByRole("heading", { name: "Platform Statistics" })).toBeVisible();

    // Stat values
    await expect(page.getByText("150")).toBeVisible(); // total_papers
    await expect(page.getByText("340")).toBeVisible(); // total_reviews
    await expect(page.getByText("85")).toBeVisible(); // total_accredited_researchers

    // Stat labels
    await expect(page.getByText("Total Papers")).toBeVisible();
    await expect(page.getByText("Total Reviews")).toBeVisible();
    await expect(page.getByText("Accredited Researchers")).toBeVisible();
  });
});

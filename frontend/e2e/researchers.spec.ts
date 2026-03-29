import { test, expect } from "./fixtures";

test.describe("Researchers", () => {
  test("displays accredited researchers list", async ({ page }) => {
    await page.goto("/researchers");

    await expect(page.getByRole("heading", { name: "Accredited Researchers" })).toBeVisible();
    await expect(page.getByText("Dr. Alice")).toBeVisible();
    await expect(page.getByText("Dr. Bob")).toBeVisible();
  });

  test("shows researcher details in cards", async ({ page }) => {
    await page.goto("/researchers");

    await expect(page.getByText("MIT")).toBeVisible();
    await expect(page.getByText("Stanford")).toBeVisible();
    await expect(page.getByText("Email Verification")).toBeVisible();
    await expect(page.getByText("Web of Trust")).toBeVisible();
  });

  test("has filter controls", async ({ page }) => {
    await page.goto("/researchers");

    await expect(page.getByLabel("Field")).toBeVisible();
    await expect(page.getByLabel("Institution")).toBeVisible();
  });

  test("researcher links to profile", async ({ page }) => {
    await page.goto("/researchers");

    const aliceLink = page.getByRole("link", { name: "@alice" });
    await expect(aliceLink).toHaveAttribute("href", "/profile/alice");
  });
});

import { test, expect } from "./fixtures";

test.describe("Accreditation", () => {
  test("renders accreditation page", async ({ page }) => {
    await page.goto("/accreditation");

    await expect(page.getByRole("heading", { name: "Researcher Accreditation" })).toBeVisible();
    await expect(page.getByText("Why Accreditation?")).toBeVisible();
    await expect(page.getByText("How It Works")).toBeVisible();
  });

  test("shows request form", async ({ page }) => {
    await page.goto("/accreditation");

    await expect(page.getByLabel("Full Name")).toBeVisible();
    await expect(page.getByLabel("Institution")).toBeVisible();
    await expect(page.getByLabel("Field of Research")).toBeVisible();
    await expect(page.getByLabel("Institutional Email")).toBeVisible();
    await expect(page.getByLabel("ORCID (optional)")).toBeVisible();
  });

  test("shows wallet warning when not connected", async ({ page }) => {
    await page.goto("/accreditation");

    await expect(page.getByText("Wallet not connected")).toBeVisible();
  });

  test("submit button is disabled when not connected", async ({ page }) => {
    await page.goto("/accreditation");

    const submitBtn = page.getByRole("button", { name: "Connect Wallet to Begin" });
    await expect(submitBtn).toBeDisabled();
  });

  test("mentions Web of Trust alternative", async ({ page }) => {
    await page.goto("/accreditation");

    await expect(page.getByText(/Web of Trust/)).toBeVisible();
  });
});

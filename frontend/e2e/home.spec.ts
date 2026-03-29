import { test, expect } from "./fixtures";

test.describe("Home / Paper Feed", () => {
  test("renders hero section and paper feed", async ({ page }) => {
    await page.goto("/");

    // Hero
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Scientific");
    await expect(page.getByRole("link", { name: "Publish a Paper" })).toBeVisible();

    // Paper feed heading
    await expect(page.getByText("Research Papers")).toBeVisible();
  });

  test("displays papers from API", async ({ page }) => {
    await page.goto("/");

    // Wait for papers to load
    await expect(page.getByText("Neural Network Plasticity in Adult Brains")).toBeVisible();
    await expect(page.getByText("Quantum Gravity Explored")).toBeVisible();
    await expect(page.getByText("2 papers found")).toBeVisible();
  });

  test("navigation links are present", async ({ page }) => {
    await page.goto("/");

    const nav = page.locator("header nav");
    await expect(nav.getByText("Papers")).toBeVisible();
    await expect(nav.getByText("Search")).toBeVisible();
    await expect(nav.getByText("Researchers")).toBeVisible();
    await expect(nav.getByText("Publish")).toBeVisible();
    await expect(nav.getByText("Accreditation")).toBeVisible();
    await expect(nav.getByText("Stats")).toBeVisible();
    await expect(nav.getByText("About")).toBeVisible();
  });

  test("shows Connect Wallet button when not authenticated", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Connect Wallet" })).toBeVisible();
  });
});

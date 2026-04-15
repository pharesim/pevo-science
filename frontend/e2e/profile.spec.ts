import { test, expect } from "./fixtures";

test.describe("Profile", () => {
  test("displays researcher profile", async ({ page }) => {
    await page.goto("/profile/alice");

    // Name and username
    await expect(page.getByRole("heading", { name: "Dr. Alice" })).toBeVisible();
    await expect(page.getByText("@alice")).toBeVisible();

    // Institution and field
    await expect(page.getByText("MIT")).toBeVisible();
    await expect(page.getByText("neuroscience")).toBeVisible();
  });

  test("displays reputation score and breakdown", async ({ page }) => {
    await page.goto("/profile/alice");

    // Score
    await expect(page.getByText("78")).toBeVisible();
    await expect(page.getByText("Reputation Score")).toBeVisible();

    // Breakdown section
    await expect(page.getByText("Reputation Breakdown")).toBeVisible();
  });

  test("displays activity stats", async ({ page }) => {
    await page.goto("/profile/alice");

    await expect(page.getByText("Activity")).toBeVisible();
    await expect(page.getByText("Papers")).toBeVisible();
    await expect(page.getByText("Reviews")).toBeVisible();
    await expect(page.getByText("Citations")).toBeVisible();
  });

  test("displays user publications", async ({ page }) => {
    await page.goto("/profile/alice");

    // Publications tab is active by default
    await expect(page.getByRole("button", { name: "Publications" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reviews" })).toBeVisible();
    await expect(page.getByText("Neural Network Plasticity in Adult Brains")).toBeVisible();
  });

  test("shows accreditation badge", async ({ page }) => {
    await page.goto("/profile/alice");

    // Accreditation badge should be visible for accredited users
    await expect(page.getByText("Accredited")).toBeVisible();
  });
});

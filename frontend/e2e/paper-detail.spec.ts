import { test, expect } from "./fixtures";

test.describe("Paper Detail", () => {
  test("displays paper content and metadata", async ({ page }) => {
    await page.goto("/paper/alice/neural-plasticity-2026");

    // Title
    await expect(page.getByRole("heading", { name: "Neural Network Plasticity in Adult Brains" })).toBeVisible();

    // Author
    await expect(page.getByText("Dr. Alice")).toBeVisible();
    await expect(page.getByText("(MIT)")).toBeVisible();

    // Discipline badge
    await expect(page.getByText("neuroscience")).toBeVisible();

    // Body content
    await expect(page.getByText("This paper explores neural plasticity.")).toBeVisible();
  });

  test("displays review section", async ({ page }) => {
    await page.goto("/paper/alice/neural-plasticity-2026");

    await expect(page.getByText("Peer Reviews (1)")).toBeVisible();
    await expect(page.getByText("Excellent methodology and clear presentation.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Write a Review" })).toBeVisible();
  });

  test("displays citations section", async ({ page }) => {
    await page.goto("/paper/alice/neural-plasticity-2026");

    await expect(page.getByText("References to PEvO Papers")).toBeVisible();
    await expect(page.getByText("A Follow-up Study on Plasticity")).toBeVisible();
  });

  test("displays metrics bar", async ({ page }) => {
    await page.goto("/paper/alice/neural-plasticity-2026");

    await expect(page.getByText("42 votes")).toBeVisible();
    await expect(page.getByText(/1 review/)).toBeVisible();
    await expect(page.getByText(/5 citations/)).toBeVisible();
  });

  test("back link navigates home", async ({ page }) => {
    await page.goto("/paper/alice/neural-plasticity-2026");

    const backLink = page.getByRole("link", { name: /Back to Papers/ });
    await expect(backLink).toBeVisible();
    await expect(backLink).toHaveAttribute("href", "/");
  });
});

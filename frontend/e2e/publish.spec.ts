import { test, expect } from "./fixtures";

test.describe("Publish", () => {
  test("renders publish form", async ({ page }) => {
    await page.goto("/publish");

    await expect(page.getByRole("heading", { name: "Publish a Paper" })).toBeVisible();
    await expect(page.getByLabel("Paper Title")).toBeVisible();
    await expect(page.getByLabel("Discipline")).toBeVisible();
    await expect(page.getByLabel("Keywords")).toBeVisible();
    await expect(page.getByLabel("Paper Content (Markdown)")).toBeVisible();
  });

  test("shows wallet not connected warning", async ({ page }) => {
    await page.goto("/publish");

    await expect(page.getByText("Wallet not connected")).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect Wallet" })).toBeVisible();
  });

  test("submit button is disabled when not connected", async ({ page }) => {
    await page.goto("/publish");

    const submitBtn = page.getByRole("button", { name: "Publish Paper" });
    await expect(submitBtn).toBeDisabled();
  });

  test("co-author management works", async ({ page }) => {
    await page.goto("/publish");

    // No co-authors initially
    await expect(page.getByText("No co-authors added")).toBeVisible();

    // Add a co-author
    await page.getByRole("button", { name: "+ Add Co-Author" }).click();
    await expect(page.getByPlaceholder("Full name")).toBeVisible();
    await expect(page.getByPlaceholder("Hive username")).toBeVisible();

    // Remove the co-author
    await page.getByRole("button", { name: "Remove co-author" }).click();
    await expect(page.getByText("No co-authors added")).toBeVisible();
  });

  test("preview toggle works", async ({ page }) => {
    await page.goto("/publish");

    const textarea = page.getByLabel("Paper Content (Markdown)");
    await textarea.fill("## Test\n\nHello world");

    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByText("Hello world")).toBeVisible();

    await page.getByRole("button", { name: "Edit" }).click();
    await expect(textarea).toBeVisible();
  });

  test("discipline dropdown is populated", async ({ page }) => {
    await page.goto("/publish");

    const select = page.getByLabel("Discipline");
    await expect(select.locator("option")).toHaveCount(4); // "Select..." + 3 disciplines
  });
});

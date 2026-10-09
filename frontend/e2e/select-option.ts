import { Locator } from '@playwright/test'

export async function selectOption(field: Locator, value: string) {
  await field.click()
  await field.page().locator(`[role="option"][data-value="${value}"]`).click()
}

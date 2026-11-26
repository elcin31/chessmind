import { devices, expect, test } from '@playwright/test'
import { ending } from './cloudFixtures'
import { opera } from './fixtures'

const { defaultBrowserType: _browser, ...iphone } = devices['iPhone 15']
test.use({ ...iphone, browserName: 'webkit', launchOptions: {} })
test.skip(!process.env.CHESSMIND_WEBKIT, 'Для проверки нужен установленный Playwright WebKit.')

test('standalone повторно открывает приложение офлайн и завершает обычный разбор', async ({ page, context }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true })
    localStorage.setItem('chessmind-mobile-local-warning', '1')
  })
  await page.goto('/')
  await expect(page.getByText('Офлайн готов')).toBeVisible({ timeout: 45_000 })
  await context.setOffline(true)
  await page.reload()
  await page.getByRole('button', { name: 'PGN', exact: true }).click()
  await page.getByRole('textbox', { name: 'Текст PGN' }).fill(ending(opera, 4))
  await page.getByRole('button', { name: 'Импортировать PGN' }).click()
  await page.getByRole('button', { name: /Morphy – Duke/ }).click()
  await expect(page.getByRole('combobox', { name: 'Тип разбора' })).toHaveValue('smart')
  await page.getByRole('button', { name: 'Начать анализ' }).click()
  await expect(page.getByText('Анализ завершён · На устройстве')).toBeVisible({ timeout: 45_000 })
})

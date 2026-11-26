import { test, expect } from '@playwright/test'
import { immortal, opera } from './fixtures'

test('production PWA: реальные партии, WASM, разбор и экспорт офлайн', async ({ page, context }) => {
  const errors: string[] = []
  const full: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.url().includes('/stockfish-19-single.')) full.push(request.url()) })
  await page.goto('/')
  await expect(page.getByText('Офлайн готов')).toBeVisible({ timeout: 60_000 })
  expect(full).toEqual([])
  await context.setOffline(true)
  await page.reload()
  await page.getByRole('button', { name: 'PGN', exact: true }).click()
  await page.getByRole('textbox', { name: 'Текст PGN' }).fill(opera + '\n\n' + immortal)
  await page.getByRole('button', { name: 'Импортировать PGN' }).click()
  await expect(page.getByRole('status').getByText(/Добавлено: 2/)).toBeVisible()
  await page.getByRole('button', { name: /Morphy – Duke/ }).click()
  await page.getByRole('combobox', { name: 'Тип разбора' }).selectOption('smart')
  await page.getByRole('button', { name: 'Начать анализ' }).click()
  await expect(page.getByRole('heading', { name: /Итоги партии/ })).toBeVisible({ timeout: 100_000 })
  await page.getByRole('button', { name: 'Конец партии' }).click()
  await expect(page.getByText('Rd8# ставит мат', { exact: false })).toBeVisible()
  await expect(page.getByLabel('WDL после выбора хода')).toBeVisible()
  await page.getByRole('button', { name: 'Перепроверить ход' }).click()
  await expect(page.getByText(/Перепроверка Professional/)).toBeVisible({ timeout: 45_000 })
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'PGN с разбором' }).click()
  expect((await download).suggestedFilename()).toMatch(/\.pgn$/)
  await page.goto('/#review')
  await page.goto('/#games')
  await page.getByRole('button', { name: /Anderssen.*Kieseritzky/ }).click()
  await page.getByRole('combobox', { name: 'Тип разбора' }).selectOption('smart')
  await page.getByRole('button', { name: 'Начать анализ' }).click()
  await expect(page.getByRole('heading', { name: /Итоги партии/ })).toBeVisible({ timeout: 100_000 })
  await page.getByRole('button', { name: 'Конец партии' }).click()
  await expect(page.getByText('Be7# ставит мат', { exact: false })).toBeVisible()
  expect(errors).toEqual([])
})

test('миграция IndexedDB 1.0 и мобильная компоновка', async ({ page }) => {
  await page.setViewportSize({ width: 402, height: 874 })
  await page.route('**/seed.html', route => route.fulfill({ status: 200, contentType: 'text/html', body: 'Seed' }))
  await page.goto('/seed.html')
  await page.evaluate(pgn => new Promise<void>((resolve, reject) => {
    localStorage.setItem('chessmind-settings', JSON.stringify({ nickname: '', theme: 'system', mode: 'lite' }))
    const request = indexedDB.open('chessmind-review', 1)
    request.onupgradeneeded = () => {
      const database = request.result
      database.createObjectStore('positions')
      database.createObjectStore('archives')
      database.createObjectStore('practice', { keyPath: 'id' }).put({ id: 'legacy:0', correct: 3, wrong: 1, due: 1000, last: 500, streak: 1 })
      const oldLine = { kind: 'cp', value: 20, pv: ['e2e4'], depth: 8 }
      database.createObjectStore('games', { keyPath: 'id' }).put({
        id: 'legacy', pgn, initial: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        source: 'pgn', white: 'Morphy', black: 'Duke and Count', date: '', result: '1-0', time: '', book: 0, moves: 33,
        mode: 'standard', reviews: [{ color: 'w', index: 0, category: 'best', before: oldLine, played: oldLine,
          after: { ...oldLine, pv: ['e7e5'] }, lines: [oldLine], loss: 0, cpLoss: 0, accuracy: 100,
          phase: 'opening', explanation: 'Сохранённое объяснение версии 1.0', critical: false, depth: 8, forced: false }],
      })
    }
    request.onsuccess = () => { request.result.close(); resolve() }
    request.onerror = () => reject(request.error)
  }), opera)
  await page.goto('/#review/legacy')
  await expect(page.getByRole('heading', { name: /Morphy.*Duke and Count/ })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Тип разбора' })).toHaveValue('smart')
  await expect(page.getByRole('combobox', { name: 'Источник вычислений' })).toHaveValue('local')
  await expect(page.getByText('Сохранённый режим Standard.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Вперёд' })).toBeVisible()
  await page.getByRole('button', { name: 'Вперёд' }).click()
  await expect(page.locator('.board-context')).toContainText('1. e4')
  await expect(page.getByText('Сохранённое объяснение версии 1.0')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(402)
  await page.goto('/#openings')
  await expect(page.getByRole('heading', { name: 'Дерево ECO' })).toBeVisible()
  await page.locator('.opening-options').getByRole('button', { name: /^e4/ }).click()
  await expect(page.getByRole('button', { name: 'Назад' })).toBeEnabled()
  await page.getByRole('button', { name: 'Назад' }).click()
  await page.locator('.opening-options > div').filter({ has: page.getByRole('button', { name: /^e4/ }) })
    .getByRole('button', { name: 'В репертуар', exact: true }).click()
  await page.getByRole('button', { name: 'Повторить эту позицию' }).click()
  await page.getByRole('button', { name: 'e2 пешка белые' }).click()
  await page.getByRole('button', { name: 'e4', exact: true }).click()
  await expect(page.getByText('Верно · e4')).toBeVisible()
})

test('реальный Stockfish Full по запросу и продолжение после права на ничью', async ({ page }) => {
  await page.goto('/#settings')
  await page.getByText('Технические настройки', { exact: true }).click()
  await page.getByLabel('Stockfish Full', { exact: false }).check()
  await page.goto('/#home')
  await page.getByRole('button', { name: 'PGN', exact: true }).click()
  await page.getByRole('textbox', { name: 'Текст PGN' }).fill(`[Event "50 moves"]
[White "White"]
[Black "Black"]
[SetUp "1"]
[FEN "4k3/8/8/8/8/8/8/4K2R w - - 99 51"]
[Result "1-0"]

51. Rh8+ Kf7 52. Rh7+ 1-0`)
  await page.getByRole('button', { name: 'Импортировать PGN' }).click()
  await page.getByRole('button', { name: /White – Black/ }).click()
  await page.getByRole('combobox', { name: 'Тип разбора' }).selectOption('smart')
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('Stockfish Full использует больше памяти')
    await dialog.accept()
  })
  await page.getByRole('button', { name: 'Начать анализ' }).click()
  await expect(page.getByRole('heading', { name: /Итоги партии/ })).toBeVisible({ timeout: 125_000 })
  await page.getByRole('button', { name: 'Вперёд' }).click()
  await expect(page.getByText('Можно потребовать ничью по правилу 50 ходов')).toBeVisible()
  const profiles = await page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const request = indexedDB.open('chessmind-review', 2)
    request.onsuccess = () => {
      const records = request.result.transaction('games').objectStore('games').getAll()
      records.onsuccess = () => {
        request.result.close()
        resolve(records.result[0].reviews.map((item: { before: { engine?: string } }) => item.before.engine ?? ''))
      }
      records.onerror = () => reject(records.error)
    }
    request.onerror = () => reject(request.error)
  }))
  expect(profiles).toEqual(['Full · 1', 'Full · 1', 'Full · 1'])
})

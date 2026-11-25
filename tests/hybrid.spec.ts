import { test, expect } from '@playwright/test'
import { cloudEngine } from '../src/cloudProtocol'
import { opera } from './fixtures'

test('облако выключено, автоматический выбор работает офлайн, настройки сохраняются', async ({ page, context }) => {
  await page.goto('/#settings')
  await expect(page.getByText('Облако отключено для защиты общей квоты Vercel.')).toBeVisible()
  await expect(page.getByText('Офлайн готов')).toBeVisible({ timeout: 30_000 })
  const source = page.getByRole('combobox', { name: 'Источник вычислений' })
  await expect(source).toHaveValue('local')
  await source.selectOption('auto')
  const energy = page.getByRole('combobox', { name: 'Энергопотребление' })
  await energy.selectOption('turbo')
  await expect(page.getByText('Turbo может ускорить разряд аккумулятора и повысить нагрев.')).toBeVisible()
  await energy.selectOption('eco')
  await page.reload()
  await expect(source).toHaveValue('auto')
  await expect(energy).toHaveValue('eco')
  await expect(page.getByText('Офлайн готов')).toBeVisible()

  const calls: string[] = []
  page.on('request', request => { if (request.url().includes('/api/engine/analyze')) calls.push(request.url()) })
  await context.setOffline(true)
  await page.getByRole('link', { name: 'Главная', exact: true }).first().click()
  await page.getByRole('button', { name: 'PGN', exact: true }).click()
  await page.getByRole('textbox', { name: 'Текст PGN' }).fill(opera)
  await page.getByRole('button', { name: 'Импортировать PGN' }).click()
  await page.getByRole('button', { name: /Morphy – Duke/ }).click({ timeout: 10_000 })
  await page.getByRole('combobox', { name: 'Глубина анализа' }).selectOption('quick')
  await page.getByRole('button', { name: 'Начать анализ' }).click()
  await expect(page.getByText('Анализ завершён · На устройстве')).toBeVisible({ timeout: 50_000 })
  expect(calls).toEqual([])
})

test('оборванный поток сохраняется, облачный лимит обработан, продолжение локально', async ({ page }) => {
  const archive = 'https://api.chess.com/pub/player/morphy/games/2024/05'
  const cors = { 'access-control-allow-origin': '*' }
  await page.route('https://api.chess.com/pub/player/morphy/games/archives', route =>
    route.fulfill({ json: { archives: [archive] }, headers: cors }))
  await page.route(archive, route => route.fulfill({ headers: cors, json: { games: [
    { pgn: opera.replace('1858.01.01', '2024.05.01'), rules: 'chess', url: 'https://www.chess.com/game/live/12345' },
  ] } }))
  await page.route('**/api/engine/status', route => route.fulfill({ json: {
    available: true, engine: cloudEngine, modes: ['quick', 'standard'], remainingCpuMs: 3_600_000,
  } }))
  let requests = 0
  await page.route('**/api/engine/analyze', async route => {
    requests++
    const input = route.request().postDataJSON()
    expect(input.reference).toEqual({ platform: 'chesscom', id: '12345', account: 'morphy', month: '2024-05' })
    expect(input.pgn).toBeUndefined()
    if (requests === 2) return route.fulfill({ status: 429, json: { code: 'quota', message: 'Облачный лимит исчерпан.' } })
    const instant = [{ kind: 'cp', value: 13, depth: 8, pv: ['e2e4'], wdl: [100, 800, 100] },
      ...Array.from({ length: 33 }, () => null)]
    const messages = [
      { type: 'start', fingerprint: input.fingerprint, engine: cloudEngine, mode: 'quick', options: { threads: 1, hash: 16 } },
      { type: 'progress', draft: { format: 1, instant }, progress: { stage: 'instant', instant: 1, checked: 0, critical: 0, criticalDone: 0, moves: 33 } },
    ]
    return route.fulfill({ contentType: 'application/x-ndjson', body: messages.map(message => JSON.stringify(message)).join('\n') + '\n' })
  })
  await page.goto('/#games')
  await page.getByRole('textbox', { name: /Никнейм на Chess.com/ }).fill('morphy')
  await page.getByRole('button', { name: 'Импортировать историю' }).click()
  await page.getByRole('button', { name: /Morphy – Duke/ }).click()
  await page.getByRole('combobox', { name: 'Источник вычислений' }).selectOption('cloud')
  const mode = page.getByRole('combobox', { name: 'Глубина анализа' })
  await mode.selectOption('professional')
  await expect(page.getByText('Deep и Professional выполняются на устройстве.')).toBeVisible()
  await mode.selectOption('quick')
  await page.getByRole('button', { name: 'Начать анализ' }).click()
  await expect(page.getByRole('alert')).toContainText('Готовые позиции сохранены.')
  await expect(page.getByRole('button', { name: 'Продолжить', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Облачный лимит исчерпан.')
  await page.getByRole('button', { name: 'Продолжить на устройстве' }).click()
  await expect(page.getByText('Анализ завершён · На устройстве')).toBeVisible({ timeout: 50_000 })
  expect(requests).toBe(2)

  const data = await page.evaluate(() => new Promise<{ cloud: number; local: number; source: string }>((resolve, reject) => {
    const open = indexedDB.open('chessmind-review')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const request = open.result.transaction('games').objectStore('games').getAll()
      request.onsuccess = () => {
        const game = request.result[0]
        open.result.close()
        resolve({ cloud: game.cloudDraft.instant[0].depth, local: game.draft.instant[0].depth, source: game.compute })
      }
      request.onerror = () => reject(request.error)
    }
  }))
  expect(data).toEqual({ cloud: 8, local: 8, source: 'local' })
})

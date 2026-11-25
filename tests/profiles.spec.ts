import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { immortal, opera } from './fixtures'

test('обе аватарки, исторический Elo, лимит 429 и локальный кэш профилей', async ({ page }) => {
  const users: string[] = []
  let images = 0
  let limited: string | undefined
  const host = 'https://api.chess.com/pub/player/'
  const month = host + 'tester/games/2024/05'
  const pgn = (game: string, white: string, black: string) =>
    game.replace(/\[White ".*?"\]/, '[White "' + white + '"]').replace(/\[Black ".*?"\]/, '[Black "' + black + '"]')
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Retry-After' }
  await page.route(host + '**', async route => {
    const name = route.request().url().slice(host.length)
    if (name === 'tester/games/archives') return route.fulfill({ json: { archives: [month] }, headers: cors })
    if (name === 'tester/games/2024/05') return route.fulfill({ headers: cors, json: { games: [
      { pgn: pgn(opera, 'tester', 'rival'), rules: 'chess', url: 'https://www.chess.com/game/live/1', white: { rating: 1740 }, black: { rating: 1850 } },
      { pgn: pgn(immortal, 'tester', 'rival'), rules: 'chess', url: 'https://www.chess.com/game/live/2', white: { rating: 1660 } },
    ] } })
    users.push(name)
    if (!limited) {
      limited = name
      return route.fulfill({ status: 429, headers: { ...cors, 'retry-after': '1' } })
    }
    return route.fulfill({ headers: cors, json: { avatar: 'https://images.chesscomfiles.com/' + name + '.png', rating: 3100 } })
  })
  const sample = readFileSync(new URL('../public/icon-192.png', import.meta.url))
  await page.route('https://images.chesscomfiles.com/**', route => {
    images++
    return route.fulfill({ headers: cors, contentType: 'image/png', body: sample })
  })
  await page.goto('/#games')
  await page.getByRole('textbox', { name: /Никнейм на Chess.com/ }).fill('tester')
  await page.getByRole('button', { name: 'Импортировать историю' }).click()
  await expect(page.locator('.game-rows .game-row')).toHaveCount(2)
  await page.locator('.game-rows').scrollIntoViewIfNeeded()
  await expect(page.locator('.avatar-frame img')).toHaveCount(4, { timeout: 15_000 })
  await expect(page.getByLabel('Elo в партии 1740')).toBeVisible()
  await expect(page.getByLabel('Elo в партии 1850')).toBeVisible()
  await expect(page.getByLabel('Elo в партии нет данных')).toBeVisible()
  await expect(page.getByLabel('Elo в партии 3100')).toHaveCount(0)
  expect(users.toSorted()).toEqual(['rival', 'tester', limited!].toSorted())
  expect(images).toBe(2)
  await page.getByRole('button', { name: /tester – rival/ }).filter({ has: page.getByLabel('Elo в партии 1740') }).click()
  await page.locator('.player-line').last().scrollIntoViewIfNeeded()
  await expect(page.locator('.player-line img')).toHaveCount(2)
  await expect(page.locator('.player-line').getByLabel('Elo в партии 1740')).toBeVisible()
  await expect(page.locator('.player-line [data-owner]')).toContainText('Ваш профиль')
  await page.reload()
  await page.locator('.player-line').last().scrollIntoViewIfNeeded()
  await expect(page.locator('.player-line img')).toHaveCount(2)
  expect(users).toHaveLength(3)
  expect(images).toBe(2)
})

test('готовые ходы доступны при активном поиске, пауза сохраняет результат', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'PGN', exact: true }).click()
  await page.getByRole('textbox', { name: 'Текст PGN' }).fill(immortal)
  await page.getByRole('button', { name: 'Импортировать PGN' }).click()
  await page.getByRole('button', { name: /Anderssen – Kieseritzky/ }).click()
  await page.getByRole('combobox', { name: 'Глубина анализа' }).selectOption('standard')
  await page.getByRole('button', { name: 'Начать анализ' }).click()
  await expect(page.getByLabel('Параметры поиска')).toContainText('узлов/с')
  const jump = page.getByRole('button', { name: 'К последнему готовому ходу' })
  await jump.click({ timeout: 30_000 })
  await expect(page.locator('.move-heading')).toBeVisible()
  await page.getByRole('button', { name: 'Пауза', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Продолжить' })).toBeVisible()
  await page.reload()
  await expect(jump).toBeVisible()
  const bar = page.getByLabel('Ходы, проанализированные Stockfish')
  const done = Number(await bar.getAttribute('value'))
  expect(done).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Продолжить' }).click()
  await expect.poll(async () => Number(await bar.getAttribute('value')), { timeout: 25_000 }).toBeGreaterThan(done)
  await page.getByRole('button', { name: 'Пауза', exact: true }).click()
})

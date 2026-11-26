import { devices, expect, test, type Page } from '@playwright/test'
import { immortal, opera } from './fixtures'
import { ending } from './cloudFixtures'

async function importGames(page: Page, pgn = opera) {
  await page.goto('/')
  await page.getByRole('button', { name: 'PGN', exact: true }).click()
  await page.getByRole('textbox', { name: 'Текст PGN' }).fill(pgn)
  await page.getByRole('button', { name: 'Импортировать PGN' }).click()
  await page.getByRole('button', { name: /Morphy – Duke/ }).click()
}

test.describe('Android Chrome', () => {
  const { defaultBrowserType: _browser, ...android } = devices['Pixel 7']
  test.use(android)

  test('Обычный разбор офлайн использует один поток на слабом телефоне', async ({ page, context }) => {
    const commands: string[] = []
    await page.exposeFunction('recordUci', (message: string) => commands.push(message))
    await page.addInitScript(() => {
      const original = Worker.prototype.postMessage
      Worker.prototype.postMessage = function (payload: unknown, ...options: []) {
        if (typeof payload === 'string') void (window as any).recordUci(payload)
        return original.call(this, payload, ...options)
      }
      Object.defineProperty(navigator, 'deviceMemory', { value: 2 })
    })
    await importGames(page)
    const mode = page.getByRole('combobox', { name: 'Тип разбора' })
    await expect(mode).toHaveValue('smart')
    await expect(page.getByText('Офлайн готов')).toBeVisible({ timeout: 30_000 })
    await context.setOffline(true)
    await page.reload()
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('Анализ выполняется на вашем устройстве')
      await dialog.accept()
    })
    await page.getByRole('button', { name: 'Начать анализ' }).click()
    await expect(page.getByRole('heading', { name: /Итоги партии/ })).toBeVisible({ timeout: 40_000 })
    expect(commands).toContain('setoption name Hash value 16')
    expect(commands).toContainEqual(expect.stringMatching(/^go depth 9 nodes /))
    expect(commands.some(command => /setoption name Threads value 2/.test(command))).toBe(false)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Анализ готов' })).toBeVisible()
  })

  for (const [memory, width, height] of [[4, 360, 800], [6, 393, 873], [8, 412, 915]]) {
    test(`Android Balanced · ${memory} ГиБ · ${width} × ${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      let running = 0
      let peak = 0
      const commands: string[] = []
      await page.exposeFunction('recordAndroidSearch', (message: string) => {
        commands.push(message)
        if (message.startsWith('go ')) peak = Math.max(peak, ++running)
        if (message === 'bestmove') running--
      })
      await page.addInitScript(memory => {
        Object.defineProperty(navigator, 'deviceMemory', { value: memory })
        Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8 })
        if (memory === 6) {
          const original = window.matchMedia
          window.matchMedia = query => query === '(display-mode: standalone)'
            ? Object.assign(new EventTarget(), { matches: true, media: query }) as MediaQueryList
            : original.call(window, query)
        }
        localStorage.setItem('chessmind-mobile-local-warning', '1')
        localStorage.setItem('chessmind-settings', JSON.stringify({ engine: { energy: 'balanced', workers: 4 }, computeSource: 'local' }))
        const original = Worker.prototype.postMessage
        const seen = new WeakSet()
        const report = (message: string) => void (window as any).recordAndroidSearch(message)
        Worker.prototype.postMessage = function (payload: unknown, ...options: []) {
          if (typeof payload === 'string') {
            if (!seen.has(this)) {
              seen.add(this)
              this.addEventListener('message', event => {
                if (typeof event.data === 'string' && /^bestmove /m.test(event.data)) report('bestmove')
              })
            }
            report(payload)
          }
          return original.call(this, payload, ...options)
        }
      }, memory)
      await importGames(page, ending(opera, 12))
      const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      expect(await fits()).toBe(true)
      await page.getByRole('button', { name: 'Начать анализ' }).click()
      await expect(page.locator('.analysis-progress')).toBeVisible()
      expect(await fits()).toBe(true)
      await expect(page.getByRole('heading', { name: /Итоги партии/ })).toBeVisible({ timeout: 60_000 })
      expect(await fits()).toBe(true)
      expect(await page.getByRole('button', { name: 'Вперёд' }).boundingBox()).toMatchObject({ width: 44, height: 44 })
      expect(peak).toBe(1)
      expect(commands).toContain('setoption name Hash value 16')
      expect(commands.some(command => /setoption name Threads value 2/.test(command))).toBe(false)
    })
  }

  test('сворачивание сохраняет черновик, а смена профиля не перезапускает готовый разбор', async ({ page, context }) => {
    await page.addInitScript(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      Object.defineProperty(navigator, 'deviceMemory', { value: 4 })
      localStorage.setItem('chessmind-mobile-local-warning', '1')
    })
    let workers = 0
    page.on('worker', () => workers++)
    await importGames(page, ending(opera, 16))
    const reviewUrl = page.url()
    await expect(page.getByText('Офлайн готов')).toBeVisible()
    await page.getByRole('button', { name: 'Начать анализ' }).click()
    await expect(page.getByText('Предварительный проход завершён')).toBeVisible()
    const show = (hidden: boolean) => page.evaluate(hidden => {
      Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    }, hidden)
    await show(true)
    const previewCount = () => page.evaluate(() => new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('chessmind-review')
      request.onsuccess = () => {
        const entries = request.result.transaction('games').objectStore('games').getAll()
        entries.onsuccess = () => { request.result.close(); resolve(entries.result[0]?.draft?.instant.filter(Boolean).length ?? 0) }
        entries.onerror = () => reject(entries.error)
      }
      request.onerror = () => reject(request.error)
    }))
    await expect.poll(previewCount).toBe(17)
    await context.setOffline(true)
    await show(false)
    await expect(page.getByRole('button', { name: 'Анализ готов' })).toBeVisible({ timeout: 60_000 })
    const before = workers
    await page.evaluate(() => { location.hash = 'settings' })
    await page.getByRole('combobox', { name: 'Энергопотребление' }).selectOption('eco')
    await page.goto(reviewUrl)
    await expect(page.getByRole('button', { name: 'Анализ готов' })).toBeVisible()
    expect(workers).toBe(before)
  })

  test('предел времени оставляет черновик и требует ручного продолжения', async ({ page }) => {
    await page.addInitScript(() => {
      const original = Worker.prototype.postMessage
      let stuck: Worker | undefined
      Worker.prototype.postMessage = function (payload: unknown, ...options: []) {
        if (typeof payload === 'string' && payload.startsWith('go ')) {
          stuck = this
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
            data: 'info depth 3 seldepth 4 multipv 1 score cp 20 nodes 500 nps 10000 pv e2e4',
          })))
        } else if (payload === 'stop' && stuck === this) {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: 'bestmove e2e4' })))
        } else {
          original.call(this, payload, ...options)
        }
      }
    })
    await importGames(page)
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: 'Начать анализ' }).click()
    await expect(page.getByRole('alert')).toContainText('предел времени', { timeout: 15_000 })
    await expect(page.getByText(/Сохранена предварительная оценка с глубины 3/)).toBeVisible()
    await expect(page.getByRole('heading', { name: /Итоги партии/ })).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Продолжить', exact: true })).toBeVisible()
  })

  test('низкий заряд останавливает анализ, Eco продолжает после подключения питания', async ({ page }) => {
    await page.addInitScript(() => {
      const battery = Object.assign(new EventTarget(), { level: .04, charging: false })
      Object.defineProperty(navigator, 'getBattery', { value: async () => battery })
      Object.defineProperty(window, 'testBattery', { value: battery })
    })
    await importGames(page)
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: 'Начать анализ' }).click()
    await expect(page.getByRole('alert')).toContainText('низкого заряда')
    await expect(page.getByRole('heading', { name: /Итоги партии/ })).toHaveCount(0)
    await page.evaluate(() => Reflect.get(window, 'testBattery').charging = true)
    await page.getByRole('button', { name: 'Продолжить в Eco' }).click()
    await expect(page.getByRole('heading', { name: /Итоги партии/ })).toBeVisible({ timeout: 40_000 })
  })

  test('резервная блокировка выполняет партии последовательно в двух вкладках', async ({ page, context }) => {
    const active = new Map<Page, number>()
    let overlap = false
    let peak = 0
    let searches = 0
    await context.exposeBinding('trackSearches', ({ page }, delta: number) => {
      const count = (active.get(page) ?? 0) + delta
      active.set(page, count)
      peak = Math.max(peak, count)
      if (delta > 0) searches++
      if ([...active.values()].filter(count => count > 0).length > 1) overlap = true
    })
    await context.addInitScript(() => {
      // Two foreground windows can compete even though one tab in a test window is hidden.
      Object.defineProperty(document, 'hidden', { get: () => false })
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible' })
      Object.defineProperty(navigator, 'locks', { value: undefined })
      Object.defineProperty(navigator, 'deviceMemory', { value: 8 })
      Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8 })
      localStorage.setItem('chessmind-mobile-local-warning', '1')
      localStorage.setItem('chessmind-settings', JSON.stringify({ engine: { energy: 'turbo' } }))
      const original = Worker.prototype.postMessage
      const seen = new WeakSet()
      const track = (delta: number) => void (window as Window & { trackSearches?: (delta: number) => void }).trackSearches?.(delta)
      Worker.prototype.postMessage = function (payload: unknown, ...options: []) {
        if (typeof payload === 'string' && payload.startsWith('go ')) {
          if (!seen.has(this)) {
            seen.add(this)
            this.addEventListener('message', event => {
              if (typeof event.data === 'string' && /^bestmove /m.test(event.data)) track(-1)
            })
          }
          track(1)
        }
        return original.call(this, payload, ...options)
      }
    })
    await importGames(page, ending(opera, 12) + '\n\n' + ending(immortal, 12))
    const other = await context.newPage()
    for (const tab of [page, other]) tab.on('dialog', dialog => dialog.accept())
    await other.goto('/')
    await other.getByRole('button', { name: /Anderssen – Kieseritzky/ }).click()
    await Promise.all([page, other].map(tab => tab.getByRole('button', { name: 'Начать анализ' }).click()))
    await expect(page.getByRole('heading', { name: /Итоги партии/ })).toBeVisible({ timeout: 45_000 })
    await expect(other.getByRole('heading', { name: /Итоги партии/ })).toBeVisible({ timeout: 45_000 })
    await expect.poll(() => [...active.values()].reduce((sum, count) => sum + count, 0)).toBe(0)
    expect(searches).toBeGreaterThan(40)
    expect(peak).toBe(2)
    expect(overlap).toBe(false)
  })
})

test.describe('эмуляция iPhone', () => {
  const { defaultBrowserType: _browser, ...iphone } = devices['iPhone 15']
  test.use(iphone)

  test('предупреждение глубокого разбора и остановка без автоматического перезапуска', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }))
    await importGames(page)
    const mode = page.getByRole('combobox', { name: 'Тип разбора' })
    await mode.selectOption('deep-review')
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('Глубокий разбор может занять несколько минут')
      await dialog.dismiss()
    })
    const start = page.getByRole('button', { name: 'Начать анализ' })
    await start.click()
    await expect(start).toBeEnabled()
    page.once('dialog', dialog => dialog.accept())
    await start.click()
    await expect(page.getByText('Предварительный проход завершён')).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Пауза', exact: true }).click()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Продолжить', exact: true })).toBeVisible()
    await expect(page.getByText('Предварительный проход завершён')).toBeVisible()
    await expect(page.getByRole('heading', { name: /Итоги партии/ })).toHaveCount(0)
  })
})

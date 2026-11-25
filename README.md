# ChessMind 2.0.4

Русскоязычное PWA для разбора завершённых шахматных партий. Stockfish 19 WASM работает на устройстве. Партии, анализы и история тренировок хранятся локально. Chess.com и Lichess используются при синхронизации истории, отдельный запрос к таблицам Lichess доступен по кнопке в эндшпильной лаборатории.

Источник вычислений и энергопрофиль сохраняются в настройках. На устройстве работают все четыре глубины анализа, Stockfish Lite и Full. Автоматический выбор проверяет облачный кэш и использует локальный движок при отказе в допуске. Node.js Functions поддерживают Express и короткие партии Standard. Для запуска им нужно подключение отдельной базы Upstash Redis Free и включённый серверный флаг.

[ChessMind на Vercel](https://chessmind-black.vercel.app)

## Разработка и проверка

- `npm ci` устанавливает зависимости.
- `npm run dev` запускает режим разработки.
- `npm test` проверяет правила, метрики, импорт, серверную валидацию, поток Stockfish и отмену.
- `npm run build` проверяет TypeScript и создаёт статическую сборку в `dist`.
- `npx playwright install chromium` устанавливает браузер для E2E. После сборки запустите `npm run test:e2e`. Для системного Chromium можно указать `CHROMIUM_PATH`.
- `npm run preview` запускает production-сборку с Service Worker и заголовками для WASM.

Vercel использует конфигурацию из `vercel.json` и Node.js 24.6+. Lite доступен после установки Service Worker. Stockfish Full загружает около 95 МиБ при первом запуске с включённой опцией. На iPhone в Safari выберите «Поделиться» → «На экран Домой» → «Добавить».

В разделе «Настройки» доступны резервные копии. Импорт поддерживает форматы 1.0 и 2.0. Формулы и пределы оценок описаны на странице «Методология». Исходники и лицензии ресурсов перечислены в [NOTICE](public/legal/NOTICE.txt).

Для сравнительного замера откройте две production-сборки на разных портах и запустите `node --import tsx scripts/benchmark.mjs <адрес> <файл.ndjson>` для каждой. Скрипт использует один поток Lite, Hash 16 МБ, фиксирует узлы из UCI и снимает PSS процессов Chromium на Linux. `BENCH_MODES` выбирает режимы, `BENCH_TAIL` ограничивает замер последними полуходами обеих партий.

Сравнение браузера, сервера и Redis-кэша описано в [замерах 2.0.4](benchmarks/2.0.4.md). Параллелизм локального движка отдельно измерялся в [версии 2.0.2](benchmarks/2.0.2.md).

## Подключение облачного анализа

Подключите отдельную базу `chessmind-redis` на тарифе Free только к проекту `chessmind` в Production. Marketplace передаёт `UPSTASH_REDIS_REST_URL` и `UPSTASH_REDIS_REST_TOKEN` серверу. Если переменные создаются вручную, сохраните их только в настройках проекта. [Upstash в Vercel Marketplace](https://vercel.com/marketplace/upstash)

Параметры Production — `CHESSMIND_MONTHLY_CPU_BUDGET=3600`, `CHESSMIND_MAX_CONCURRENT_ANALYSES=1`. Значение `CHESSMIND_CLOUD_ENABLED=0` блокирует любые вычисления. После проверки допуска на подключённой базе значение `1` включает облако при следующем развёртывании. Оба вычислительных предела зафиксированы также в серверном коде. [Переменные Vercel](https://vercel.com/elcin31s-projects/chessmind/settings/environment-variables)

Для локальной проверки Lua нужен Redis 7+ с `redis-server` и `redis-cli`. `npm test` запускает временный экземпляр. Можно задать путь к бинарникам через `CM_REDIS_SERVER` и `CM_REDIS_CLI`.

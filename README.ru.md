# Proman

**Язык:** [English](./README.md) · [Русский](./README.ru.md)

Расширение **Cursor / VS Code** для управления разработкой через дерево задач в `.proman/`.

Локальный бэклог, статусы, зависимости, handoff в Agent, Git-синхронизация команды и мост к GitHub Issues — без обязательного Jira/Linear.

**Версия:** 0.3.16 · [Changelog](./CHANGELOG.md)

---

## Для кого

Разработчики и небольшие команды, которые хотят:

- вести план рядом с кодом (файлы в репозитории);
- генерировать план разработки в Cursor **по единому шаблону** и сразу импортировать в дерево;
- **переносить план** между проектами **с сохранением прогресса** (экспорт MD → импорт);
- отдавать задачи Cursor Agent с контекстом, статусами и списком затронутых файлов;
- синхронизироваться через Git / GitHub Issues без тяжёлого PM-стека.

---

## Быстрый старт

1. Установите VSIX (`npm run install:cursor` или Install from VSIX) и сделайте **Reload Window**.
2. Включите MCP-сервер **proman**: Settings → **MCP** → найдите `proman` (или проверьте `.cursor/mcp.json` в проекте) → включите / Restart. Без этого Agent не сможет обновлять статусы через tools `proman_*`.
3. Откройте папку проекта → Activity Bar → **Proman**.
4. Импортируйте MD или добавьте корневую задачу.
5. (Опционально) `Proman: Set Current User` — кто вы в команде.
6. (Опционально) `Proman: Enable Git Sync` / `Enable GitHub Issues`.

### Шаблон плана в правилах Cursor

Чтобы Cursor **стабильно** создавал план разработки в формате, который Proman импортирует без ручной правки, подключите шаблон [`docs/templates/proman-tasks.md`](./docs/templates/proman-tasks.md) как правило проекта.

1. Скопируйте шаблон в свой репозиторий (если его ещё нет), например:
   `docs/templates/proman-tasks.md`
2. Создайте правило Cursor:
   - Cursor Settings → **Rules** → Project Rules → **Add Rule**, или
   - файл `.cursor/rules/proman-plan.mdc` в корне проекта.
3. Пример содержимого правила:

```markdown
---
description: Планы разработки для Proman — только по шаблону proman-tasks.md
alwaysApply: true
---

# План разработки (Proman)

Когда пользователь просит roadmap, план задач, backlog или planning MD для этого проекта:

1. Читай и следуй шаблону `docs/templates/proman-tasks.md` (frontmatter `type: plan`, заголовки, чекбоксы `- [ ]`, описания, Depends on, Оценка / Assignee / Теги / Код).
2. Пиши результат в один `.md` файл (например `docs/plans/<name>.md`) в формате шаблона.
3. Не придумывай другой формат списков задач: Proman парсит именно этот MD.
4. После генерации напомни импортировать файл: команда **Proman: Import Planning Docs**.
```

4. Reload Window (или откройте новый чат), затем попросите, например:  
   *«Составь план разработки по шаблону Proman»* / *«Сделай MD-план для фичи X»*.
5. Импортируйте полученный файл: **Proman: Import Planning Docs**.

Без правила можно разово указать путь к шаблону в чате — но правило избавляет от повторения и снижает «свободный» формат от модели.

### План задач через Cursor (разово)

В чате дайте путь к [`docs/templates/proman-tasks.md`](./docs/templates/proman-tasks.md) и попросите составить roadmap **по этому шаблону**, затем **Proman: Import Planning Docs**.

Данные проекта:

```
.proman/
  project.json      # meta, team, sync, github, trees[]
  trees/            # одно дерево на импортированный MD/план
    <slug>.json
  tree.json         # плоский снимок всех деревьев (MCP/совместимость)
  edges.json
  history.json
  comments/
  prompts/
  imports/          # копии исходных MD
  proposals/
```

Каждый файл из импорта → отдельная **секция** в панели Proman. Статусы пишутся в `trees/<slug>.json` и переживают reopen; повторный Import/Sync **мержит** структуру из MD, сохраняя `status` / assignee / `changedFiles`. Источник правды для UI — `trees/*`; плоский `tree.json` синхронизируется (в т.ч. после записей MCP).

В **командном** репозитории коммитьте `.proman/` (не добавляйте его в `.gitignore`).

### Переносимость плана с прогрессом

План разработки можно **вынести из одного workspace и поднять в другом**, не теряя отмеченный прогресс:

1. На секции дерева в панели Proman: **Export Tree to Markdown** (или ПКМ → экспорт).
2. Сохраните `.md` — в файл попадут иерархия, описания, зависимости, assignee и **текущие статусы** (`done` → `- [x]`, остальные через `Status: …` при необходимости).
3. В целевом проекте: **Import Planning Docs** — дерево восстановится с прогрессом.

Так же удобно бэкапить план перед экспериментом или передавать roadmap коллеге без копирования всего `.proman/`.

Удаление секции: **Delete Task Tree** — с предупреждением, что прогресс в этом дереве **не сохранится** (при необходимости сначала сделайте экспорт).

---

## Возможности

### Дерево и статусы

- Панель дерева: статусы `todo` / `new` / `in_progress` / `done` / `needs_rework` / `error` / `blocked`
- Несколько деревьев (секций) в одном проекте — по одному на импортированный план
- Цвета иконок, Σ SP на эпиках, assignee в строке
- Detail panel: описание, оценки, теги, зависимости, assign, комментарии, история
- У **done**-задач: список **созданных/изменённых файлов** (клик → открыть в IDE); свои + done-подзадачи; источник — MCP `files` при `done`, иначе fallback на `Код:` / `Тесты:` из описания
- Поиск по дереву + фильтр пути
- **👤 Мои задачи** — фильтр по `team.currentUser`
- **Экспорт секции в MD** с текущим прогрессом; **удаление дерева** с подтверждением

### Планирование из Markdown

- Импорт roadmap / plan / чеклистов → дерево
- Frontmatter `type: plan` → id `plan_1`, `plan_2`, …
- Шаблон: [`docs/templates/proman-tasks.md`](./docs/templates/proman-tasks.md) — подключайте через **правила Cursor** (см. выше)
- Пример meta: [`docs/templates/proman-project.json`](./docs/templates/proman-project.json)
- Round-trip: экспорт → MD → импорт **сохраняет прогресс** (чекбоксы + строки `Status:`)

### Agent / Drive Mode

- **Run in Agent** — промпт с маркером `PROMAN_TASK_RUN:<taskId>` в `.proman/prompts/`, открытие Agent с **вставкой промпта** (Enter отправляете вы); статус `in_progress` (спиннер) ставит агент через MCP **только если маркер остался в сообщении**; при `done` — список `files`
- **Add subtask** / **Delete** в деталях задачи — через диалоги IDE (в webview `prompt`/`confirm` недоступны)
- **Drive Mode** — выделите **заголовок секции** дерева (не первый узел-эпик) и запустите Drive: агент идёт по очереди этого дерева через MCP `proman_*`, начиная с первой разблокированной задачи
- Структура дерева меняется только после вашего **Approve**
- При активации пишется `.cursor/mcp.json` (сервер `proman`); после установки **включите** сервер в Settings → MCP и перезапустите MCP / Reload Window
- Не правьте `.proman/*.json` вручную — только UI / MCP tools

### Командная работа (локально)

- История в `.proman/history.json` (кто сменил статус / назначил / когда)
- Комментарии в `.proman/comments/<taskId>.json`
- Уведомление при назначении задачи на вас

### Этап 1 — Git как бэкенд

В `project.json`:

```json
"team": {
  "members": [
    { "username": "alice", "name": "Алиса" },
    { "username": "bob", "name": "Боб" }
  ],
  "currentUser": "alice"
},
"sync": {
  "type": "git",
  "autoCommit": true,
  "autoPush": false
}
```

- Кнопки **Pull** / **Push** в тулбаре
- Авто-коммит `.proman/` при смене статуса (`proman: @alice todo → done: …`)
- Команды: `Enable Git Sync`, `Configure Git Sync`

#### Team Git sync · merge

Источник правды для командного бэклога — файлы `.proman/` в git (`project.json`, `trees/*.json`, …). Слияние веток = обычный **git merge / rebase**. Семантический merge JSON по `task.id` доступен только вручную через **Resolve Proman Merge** (см. ниже).

- **Auto-commit** затрагивает только `.proman/` (статусы / дерево), не весь код репозитория.
- **Pull** меняет весь workspace (не только `.proman/`) — как в предупреждении перед `git pull`.
- При **conflict markers** или битом JSON в `.proman/` после Pull / Reload / старта показывается предупреждение с путями и действиями **Открыть файл** / **Reload** / **Source Control**. Валидные секции `trees/*.json` продолжают загружаться; conflicted файлы **не** перезаписываются heal-ом с диска.
- Если `git pull` упал с **CONFLICT**, ошибка сохраняется и hint указывает разрешить маркеры (часто под `.proman/`), затем Reload.
- **Advanced:** команда `Proman: Resolve Proman Merge` — семантический merge двух валидных JSON-снимков секции по `task.id` (опционально с base для удалений). Не запускается автоматически на pull. Правила: `docs/adr/semantic-tree-merge.md`.

**Правила командной работы** (меньше CONFLICT в `trees/*.json`):

1. **Pull перед** сменой статусов и импортом MD.
2. **Короткие коммиты** статусов; не смешивайте рефакторинг кода и массовый rewrite дерева в одном коммите без нужды.
3. По возможности **один «владелец»** активной секции (`trees/<slug>.json`) на спринт.
4. При **CONFLICT**: разрешите markers в git → Reload; не оставляйте `<<<<<<<` в JSON.

### Этап 2 — GitHub Issues

```json
"github": {
  "enabled": true,
  "owner": "acme",
  "repo": "my-app",
  "createOnAdd": true,
  "closeToDone": true
}
```

- Создание задачи → Issue; в описании связь: `GitHub: #42`
- Закрытие Issue → задача `done`
- Auth: сессия GitHub в Cursor (`repo`)
- Команды: `Enable GitHub Issues`, `Sync Closed GitHub Issues`
- Фоновый sync при старте / каждые 5 мин / после Pull

---

## Команды (основные)

| Команда | Действие |
|---------|----------|
| Proman: Open | Фокус на панели |
| Proman: Import Planning Docs | Импорт MD |
| Proman: Export Tree to Markdown | Экспорт секции в MD **с текущим прогрессом** |
| Proman: Delete Task Tree | Удалить секцию (прогресс не сохраняется) |
| Proman: Set Current User | `team.currentUser` |
| Proman: Мои задачи / Все | Фильтр assignee |
| Proman: Assign Task | Назначение |
| Proman: Agent Drive Tree | Drive Mode |
| Proman: Run Task in Agent | Промпт + открытие Agent |
| Proman: Git Pull / Push | Синхронизация `.proman/` |
| Proman: Resolve Proman Merge | Advanced: semantic merge двух JSON-снимков секции |
| Proman: Enable Git Sync | Git backend |
| Proman: Enable GitHub Issues | Мост Issues |
| Proman: Sync Closed GitHub Issues | closed → done |

---

## Разработка расширения

```bash
npm install
npm run build          # esbuild → dist/extension.js
npm test               # vitest
npm run test:coverage
npm run package        # → proman-x.y.z.vsix
npm run install:cursor # package + install в Cursor
```

- **F5** — Extension Development Host (`Run Proman Extension`)
- Entry: `src/extension.ts`
- Core (без UI): `src/core/*`
- MCP server: `mcp/server.mjs` → бандл `mcp/server.cjs`

### Тесты

Unit-тесты: pathSafety, forest/security, taskFiles, MD export/import, handoff/Agent open, parsers, dependency/drive, history, GitHub links, projectMeta.

```bash
npm test
```

---

## Язык интерфейса

UI (команды, дерево, детали задачи, диалоги) следует **языку отображения** Cursor/VS Code (`Configure Display Language`). Сейчас: английский и русский. Документация: [README.md](./README.md) · [README.ru.md](./README.ru.md).

## Требования

- Cursor или VS Code `^1.85.0`
- Для Git sync: `git` в PATH, workspace = git repo
- Для GitHub Issues: вход в GitHub в IDE, права на репозиторий

---

## Лицензия

MIT — см. [LICENSE](./LICENSE).

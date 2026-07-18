# Proman

**Язык:** [Русский](./README.md) · [English](./README.en.md)

Расширение **Cursor / VS Code** для управления разработкой через дерево задач в `.proman/`.

Локальный бэклог, статусы, зависимости, handoff в Agent, Git-синхронизация команды и мост к GitHub Issues — без обязательного Jira/Linear.

**Версия:** 0.3.15

---

## Для кого

Разработчики и небольшие команды, которые хотят:

- вести план рядом с кодом (файлы в репозитории);
- **переносить план разработки** между проектами/репозиториями **с сохранением текущего прогресса** (экспорт в MD → импорт);
- отдавать задачи Cursor Agent с контекстом и статусами;
- синхронизироваться через Git / GitHub Issues без тяжёлого PM-стека.

---

## Быстрый старт

1. Установите VSIX (`npm run install:cursor` или Install from VSIX) и сделайте **Reload Window**.
2. Включите MCP-сервер **proman**: Settings → **MCP** → найдите `proman` (или проверьте `.cursor/mcp.json` в проекте) → включите / Restart. Без этого Agent не сможет обновлять статусы через tools `proman_*`.
3. Откройте папку проекта → Activity Bar → **Proman**.
4. Импортируйте MD или добавьте корневую задачу.
5. (Опционально) `Proman: Set Current User` — кто вы в команде.
6. (Опционально) `Proman: Enable Git Sync` / `Enable GitHub Issues`.

### План задач через Cursor

Чтобы Agent сгенерировал список задач в формате, который Proman хорошо импортирует, в чате предложите шаблон [`docs/templates/proman-tasks.md`](./docs/templates/proman-tasks.md) (скопируйте файл в проект или дайте ссылку/путь). Попросите Cursor составить roadmap/чеклист **по этому шаблону**, затем **Proman: Import Planning Docs**.

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

Каждый файл из импорта → отдельная **секция** в панели Proman. Статусы пишутся в `trees/<slug>.json` и переживают reopen; повторный Import/Sync **мержит** структуру из MD, сохраняя `status` / assignee.

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
- Поиск по дереву + фильтр пути
- **👤 Мои задачи** — фильтр по `team.currentUser`
- **Экспорт секции в MD** с текущим прогрессом; **удаление дерева** с подтверждением

### Планирование из Markdown

- Импорт roadmap / plan / чеклистов → дерево
- Frontmatter `type: plan` → id `plan_1`, `plan_2`, …
- Шаблон для генерации списка задач: [`docs/templates/proman-tasks.md`](./docs/templates/proman-tasks.md) — его стоит предлагать Cursor как образец формата
- Пример meta: [`docs/templates/proman-project.json`](./docs/templates/proman-project.json)
- Round-trip: экспорт → MD → импорт **сохраняет прогресс** (чекбоксы + строки `Status:`)

### Agent / Drive Mode

- **Run Task in Agent** — промпт в буфер + Agent
- **Drive Mode** — агент идёт по очереди через MCP `proman_*`
- Структура дерева меняется только после вашего **Approve**
- При активации пишется `.cursor/mcp.json` (сервер `proman`); после установки **включите** сервер в Settings → MCP и перезапустите MCP / Reload Window

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
| Proman: Git Pull / Push | Синхронизация `.proman/` |
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

Unit-тесты на pure core: pathSafety, forest/security, MD export/import, parsers, dependency/drive logic, history helpers, GitHub link parsing, projectMeta.

```bash
npm test
```

---

## Язык интерфейса

UI (команды, дерево, детали задачи, диалоги) следует **языку отображения** Cursor/VS Code (`Configure Display Language`). Сейчас: английский и русский. Документация: [README.md](./README.md) · [README.en.md](./README.en.md).

## Требования

- Cursor или VS Code `^1.85.0`
- Для Git sync: `git` в PATH, workspace = git repo
- Для GitHub Issues: вход в GitHub в IDE, права на репозиторий

---

## Лицензия

MIT — см. [LICENSE](./LICENSE).

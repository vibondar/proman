# Proman

Расширение **Cursor / VS Code** для управления разработкой через дерево задач в `.proman/`.

Локальный бэклог, статусы, зависимости, handoff в Agent, Git-синхронизация команды и мост к GitHub Issues — без обязательного Jira/Linear.

**Версия:** 0.3.13

---

## Для кого

Разработчики и небольшие команды, которые хотят:

- вести план рядом с кодом (файлы в репозитории);
- отдавать задачи Cursor Agent с контекстом и статусами;
- синхронизироваться через Git / GitHub Issues без тяжёлого PM-стека.

---

## Быстрый старт

1. Установите VSIX (`npm run install:cursor` или Install from VSIX).
2. Откройте папку проекта → Activity Bar → **Proman**.
3. Импортируйте MD или добавьте корневую задачу.
4. (Опционально) `Proman: Set Current User` — кто вы в команде.
5. (Опционально) `Proman: Enable Git Sync` / `Enable GitHub Issues`.

Данные проекта:

```
.proman/
  project.json      # meta, team, sync, github
  tree.json         # задачи
  edges.json        # зависимости
  history.json      # локальная история изменений
  comments/         # комментарии по task id
  prompts/
  imports/
  proposals/
```

В **командном** репозитории коммитьте `.proman/` (не добавляйте его в `.gitignore`).

---

## Возможности

### Дерево и статусы

- Панель дерева: статусы `todo` / `new` / `in_progress` / `done` / `needs_rework` / `error` / `blocked`
- Цвета иконок, Σ SP на эпиках, assignee в строке
- Detail panel: описание, оценки, теги, зависимости, assign, комментарии, история
- Поиск по дереву + фильтр пути
- **👤 Мои задачи** — фильтр по `team.currentUser`

### Планирование из Markdown

- Импорт roadmap / plan / чеклистов → дерево
- Frontmatter `type: plan` → id `plan_1`, `plan_2`, …
- Шаблон: [`docs/templates/proman-tasks.md`](./docs/templates/proman-tasks.md)
- Пример meta: [`docs/templates/proman-project.json`](./docs/templates/proman-project.json)

### Agent / Drive Mode

- **Run Task in Agent** — промпт в буфер + Agent
- **Drive Mode** — агент идёт по очереди через MCP `proman_*`
- Структура дерева меняется только после вашего **Approve**
- При активации пишется `.cursor/mcp.json` (сервер `proman`)

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

Unit-тесты на pure core: pathSafety, parsers, dependency/drive logic, history helpers, GitHub link parsing, projectMeta.

```bash
npm test
```

---

## Требования

- Cursor или VS Code `^1.85.0`
- Для Git sync: `git` в PATH, workspace = git repo
- Для GitHub Issues: вход в GitHub в IDE, права на репозиторий

---

## Лицензия / поставка

Локальный VSIX. Поле `repository` в манифесте можно добавить при публикации на Marketplace.

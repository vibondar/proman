# Proman

Расширение Cursor / VS Code для управления ходом разработки через **дерево проекта**.

## Возможности

- Панель **Proman** в Activity Bar: дерево задач, статусы, прогресс
- Вставка / удаление задач с **превью влияния** на зависимые узлы
- Импорт MD (roadmap, plan, чеклисты) → дерево в `.proman/`
- При открытии проекта — поиск директории планирования
- **Выполнить в Agent** — промпт в буфер + открытие Cursor Agent (без отдельного API key)
- MCP-инструменты `proman_*` (stdio MCP в Cursor) для обновления статусов из Agent

## Запуск (разработка)

```bash
npm install
npm run build
```

Затем **F5** (конфигурация «Run Proman Extension») — откроется Extension Development Host.

В боковой панели найдите иконку Proman.

## Данные проекта

В корне workspace создаётся:

```
.proman/
  project.json
  tree.json
  edges.json
  prompts/
  imports/
```

## Шаблон planning-MD

Эталон для генерации документов задач (иерархия + описания + зависимости):

[`docs/templates/proman-tasks.md`](./docs/templates/proman-tasks.md)

В начале файла: frontmatter `type: plan` — Proman находит такие MD сам, id узлов: `plan_1`, `plan_2`, …  
Пример запроса агенту: *«сгенерируй roadmap по шаблону `docs/templates/proman-tasks.md` для …»*.  
Импорт: **Proman: Import Planning Docs**.

## Drive Mode (агент ведёт дерево)

1. В панели Proman нажмите **▶ Agent Drive Tree** (или Command Palette → `Proman: Agent Drive Tree`)
2. Промпт копируется → вставьте в Cursor Agent и отправьте
3. Agent вызывает MCP `proman_*`: берёт следующую задачу, пишет код, ставит статусы
4. Изменение **структуры** дерева — только после вашего **Approve** в диалоге
5. `Proman: Stop Drive Mode` — остановить сессию

При активации расширения в проект пишется `.cursor/mcp.json` с сервером `proman` (tools для Agent).


## Команды

| Команда | Действие |
|---------|----------|
| Proman: Open | Фокус на панели |
| Proman: Import Planning Docs | Импорт MD / папки |
| Proman: Set Planning Directory | Папка для watcher |
| Proman: Run Task in Agent | Handoff выбранной задачи |
| Proman: Enrich Tree via Agent | Уточнить дерево из MD |
| Proman: Recalculate Dependencies | Пересчёт blocked |

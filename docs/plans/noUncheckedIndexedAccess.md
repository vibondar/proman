---
type: plan
title: Enable noUncheckedIndexedAccess
---

# Enable noUncheckedIndexedAccess

Кратко: включить `compilerOptions.noUncheckedIndexedAccess` в `tsconfig.json` и послойно починить все ошибки компиляции в `src/` и тестах, чтобы обращения `obj[key]` / `arr[i]` явно учитывали `undefined`.
Planning source of truth для PR; успех = `tsc --noEmit` зелёный со флагом, тесты зелёные, без массовых `!` «для тишины».

## Эпик A — включение флага и дисциплина правок

Зачем этот эпик: зафиксировать правила PR до массовых правок по коду, иначе ревью утонет в шумовых `!`.
Критерии готовности эпика: флаг включён, есть короткий гайд в описании PR / комментарии к коммиту, baseline ошибок известен.

### Правила правок

Единый стиль устранения ошибок `noUncheckedIndexedAccess` для эпиков B–D (и для описания PR / коммитов):

1. **Предпочтение:** после `obj[key]` / `arr[i]` — ранний `if (!x) return` / `continue` / `throw`, затем работа с суженным типом.
2. **`x!`:** только где инвариант доказан локально в том же блоке. Избегать `for (const id of Object.keys(tasks)) { const t = tasks[id]!; }` даже с комментарием «ключ из Object.keys».
3. **Хелперы** вида `requireTask(state, id)` допустимы в `src/core/`, если один и тот же lookup повторяется ≥3 раза. Не вводить «на всякий случай».

Запрещено: массовые `as T`, `!` «для тишины», ослабление до `any`. `noPropertyAccessFromIndexSignature` — вне scope этого плана.

### Базовая конфигурация

Цель: включить флаг и увидеть полный список ошибок без частичных «заглушек».
Критерии готовности:
1. В `tsconfig.json` стоит `"noUncheckedIndexedAccess": true`
2. `npx tsc -p . --noEmit` падает предсказуемо; список файлов зафиксирован в заметке PR
Вне scope: правки логики фич вне indexed-access.
Заметки: webview уже в `exclude` tsconfig — не трогать, пока не понадобится отдельный tsconfig.

#### Baseline `tsc` (после включения флага)

Команда: `npx tsc -p . --noEmit` → exit 2, **67** ошибок в **14** файлах `src/` (тесты в этот tsconfig не входят).

| Файл | Ошибок |
|------|--------|
| `src/core/mdParser.ts` | 11 |
| `src/core/driveEngine.ts` | 9 |
| `src/core/dependencyEngine.ts` | 7 |
| `src/core/taskMeta.ts` | 7 |
| `src/core/store.ts` | 6 |
| `src/tree/promanTree.ts` | 6 |
| `src/core/forest.ts` | 5 |
| `src/core/planDiscoverer.ts` | 3 |
| `src/core/planFrontmatter.ts` | 3 |
| `src/onboarding.ts` | 3 |
| `src/sidebarProvider.ts` | 3 |
| `src/core/mdExport.ts` | 2 |
| `src/core/githubIssueLink.ts` | 1 |
| `src/core/taskFiles.ts` | 1 |

Порядок починки — по эпикам B→C ниже; этот список — снимок для PR, не live checklist.

- [ ] Включить noUncheckedIndexedAccess
  Цель: активировать проверку в компиляторе проекта.
  Критерии готовности:
  1. Флаг в `compilerOptions` рядом со `strict: true`
  2. Сборка без флага больше не считается целевой для этого PR
  Оценка: 1 SP / 0.5 часа
  Assignee: @vibondar
  Теги: #infra #refactoring
  Код: tsconfig.json
  Вне scope: `noPropertyAccessFromIndexSignature` (отдельное решение).

- [ ] Зафиксировать правила правок
  Цель: единый стиль устранения ошибок, чтобы не плодить `as` / `!`.
  Критерии готовности:
  1. Предпочтение: ранний `if (!x) return/continue/throw`
  2. `x!` только где инвариант доказан локально (цикл по `Object.keys` + сразу `tasks[id]!` с комментарием — избегать)
  3. Хелперы вида `requireTask(state, id)` допустимы в `core/`, если повторяются ≥3 раза
  Оценка: 1 SP / 0.5 часа
  Assignee: @vibondar
  Теги: #docs #refactoring
  Код: docs/plans/noUncheckedIndexedAccess.md
  Depends on Включить noUncheckedIndexedAccess

## Эпик B — ядро домена (core/)

Зачем: здесь `Record<string, TaskNode>` и массивы id — главный выигрыш от флага; ошибки чаще всего про реальные runtime-дыры.
Критерии готовности эпика: `src/core/**` компилируется со флагом; юнит-тесты core зелёные.

### Forest и path safety

Цель: безопасные обращения к trees/tasks при namespace и sanitize.
Критерии готовности:
1. Нет небезопасного `trees[i]` / `tasks[id]` без проверки
2. Поведение sanitize/load не меняется для валидных данных
Depends on Зафиксировать правила правок

- [ ] Починить forest.ts под indexed access
  Цель: все lookup по id/index в forest явно обрабатывают отсутствие узла.
  Критерии готовности:
  1. `tsc` без ошибок в `src/core/forest.ts`
  2. `tests/forest.test.ts` проходит
  Оценка: 5 SP / 3 часа
  Assignee: @vibondar
  Теги: #backend #refactoring
  Код: src/core/forest.ts
  Тесты: tests/forest.test.ts
  Depends on Зафиксировать правила правок

- [ ] Починить pathSafety и proposalOps
  Цель: граничные модули с id/path lookup без ложных «всегда есть».
  Критерии готовности:
  1. `tsc` чист для `pathSafety.ts`, `proposalOps.ts`
  2. Security/path тесты зелёные
  Оценка: 2 SP / 1.5 часа
  Assignee: @vibondar
  Теги: #backend #refactoring
  Код: src/core/pathSafety.ts, src/core/proposalOps.ts
  Тесты: tests/pathSafety.test.ts, tests/proposalOps.test.ts, tests/security.test.ts
  Depends on Зафиксировать правила правок

### Store, зависимости, парсеры

Цель: `ProjectStore` и движки, которые индексируют `state.tasks` / массивы детей.
Критерии готовности:
1. store / dependencyEngine / mdParser / связанные модули компилируются
2. Существующие тесты без ослабления ассертов
Depends on Починить forest.ts под indexed access

- [ ] Починить store.ts под indexed access
  Цель: все `this.state.tasks[id]` и обходы children/dependsOn безопасны.
  Критерии готовности:
  1. `tsc` без ошибок в `src/core/store.ts`
  2. Поведение save/load/setStatus/delete не регрессирует (тесты + smoke вручную при необходимости)
  Оценка: 5 SP / 4 часа
  Assignee: @vibondar
  Теги: #backend #refactoring
  Код: src/core/store.ts
  Заметки / риски: самый большой файл; дробить коммиты по методам (setStatus, deleteTask, rebuildFlat).
  Depends on Починить forest.ts под indexed access

- [ ] Починить dependencyEngine и mdParser
  Цель: циклы, preview impact и разбор MD без unchecked index.
  Критерии готовности:
  1. `tsc` чист для `dependencyEngine.ts`, `mdParser.ts` (и прямых хелперов при задевании)
  2. `tests/dependencyEngine.test.ts`, `tests/mdParser.test.ts` зелёные
  Оценка: 3 SP / 2 часа
  Assignee: @vibondar
  Теги: #backend #refactoring
  Код: src/core/dependencyEngine.ts, src/core/mdParser.ts
  Тесты: tests/dependencyEngine.test.ts, tests/mdParser.test.ts
  Depends on Зафиксировать правила правок

- [ ] Добить оставшийся core/
  Цель: закрыть остальные файлы `src/core/*.ts` (taskMeta, driveEngine, history, taskFiles, git/github helpers, …).
  Критерии готовности:
  1. Весь `src/core/` проходит `tsc` со флагом
  2. Затронутые тесты в `tests/` зелёные
  Оценка: 5 SP / 3 часа
  Assignee: @vibondar
  Теги: #backend #refactoring
  Код: src/core/
  Тесты: tests/
  Depends on Починить store.ts под indexed access
  Depends on Починить dependencyEngine и mdParser
  Depends on Починить pathSafety и proposalOps

## Эпик C — extension host и UI

Зачем: команды, tree, MCP, panels тоже индексируют tasks; без этого флаг нельзя мержить.
Критерии готовности эпика: весь `src/` (кроме уже excluded webview) компилируется; smoke команд не ломается.
Depends on Добить оставшийся core/

### Регистрация команд и дерево

Цель: безопасные lookup при командах и отрисовке tree.
Критерии готовности:
1. `extension.ts`, `registerCommands.ts`, `tree/*` без ошибок tsc
2. Ручной smoke: open details, set status, delete task

- [ ] Починить extension host (commands)
  Цель: indexed access в activate/registerCommands/github/git UI.
  Критерии готовности:
  1. `tsc` чист для `extension.ts`, `registerCommands.ts`, `githubSync.ts`, `gitSyncUi.ts` и соседних host-файлов с ошибками
  2. Нет новых `any` ради тишины
  Оценка: 3 SP / 2 часа
  Assignee: @vibondar
  Теги: #backend #refactoring
  Код: src/extension.ts, src/registerCommands.ts, src/githubSync.ts, src/gitSyncUi.ts
  Depends on Добить оставшийся core/

- [ ] Починить tree и detail panel
  Цель: tree provider / search / task detail без unchecked index.
  Критерии готовности:
  1. `tsc` чист для `src/tree/**`, `taskDetailPanel.ts`, `sidebarProvider.ts` при наличии ошибок
  2. Поиск/фильтр и панель деталей открываются
  Оценка: 3 SP / 2 часа
  Assignee: @vibondar
  Теги: #frontend #ui #refactoring
  Код: src/tree/promanTree.ts, src/tree/treeSearch.ts, src/taskDetailPanel.ts
  Depends on Добить оставшийся core/

- [ ] Починить MCP, agent, drive UI
  Цель: handoff / MCP / drive пути тоже под флагом.
  Критерии готовности:
  1. `tsc` чист для `src/mcp/**`, `src/agent/**`, `driveUi.ts`, `driveEngine` уже в core
  2. Существующие тесты handoff/drive/proposal зелёные
  Оценка: 3 SP / 2 часа
  Assignee: @vibondar
  Теги: #mcp #backend #refactoring
  Код: src/mcp/promanMcp.ts, src/agent/handoff.ts, src/driveUi.ts
  Тесты: tests/handoff.test.ts, tests/driveEngine.test.ts
  Depends on Добить оставшийся core/

## Эпик D — проверка и merge PR

Зачем: доказать, что флаг реально включён в CI/локально и регрессий нет.
Критерии готовности эпика: полный зелёный прогон + краткое описание в PR.
Depends on Починить extension host (commands)
Depends on Починить tree и detail panel
Depends on Починить MCP, agent, drive UI

- [ ] Полный прогон tsc и vitest
  Цель: merge-ready сигнал качества.
  Критерии готовности:
  1. `npx tsc -p . --noEmit` exit 0
  2. `npm test` все suites green
  3. В PR указано число оставшихся осознанных `!` (стремиться к минимуму)
  Оценка: 2 SP / 1 час
  Assignee: @vibondar
  Теги: #test #infra
  Код: tsconfig.json, package.json
  Тесты: tests/
  Depends on Починить extension host (commands)
  Depends on Починить tree и detail panel
  Depends on Починить MCP, agent, drive UI

- [ ] Оформить PR
  Цель: отдельный PR только про typed indexed access.
  Критерии готовности:
  1. Title/body: зачем флаг, правила правок, что не в scope
  2. Нет смешанных фич (только type-safety)
  Оценка: 1 SP / 0.5 часа
  Assignee: @vibondar
  Теги: #docs #infra
  Код: docs/plans/noUncheckedIndexedAccess.md
  Depends on Полный прогон tsc и vitest

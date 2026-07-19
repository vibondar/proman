---
type: plan
title: Git sync merge conflicts
---

# Git sync merge conflicts

Кратко: сделать командный Git sync предсказуемым — явно описать стратегию слияний и ограничения в README, научить Proman детектить conflict markers / битый JSON в `.proman/` с понятным диалогом (вместо тихого skip), и при необходимости добавить семантический merge по `task.id`. Успех = ревьюеры и пользователи понимают правила работы в команде; после CONFLICT дерево не «молча ломается».

## Эпик A — документация стратегии

Зачем этот эпик: закрыть вопросы ревью про merge до кода — зафиксировать, что Git sync = общий JSON в git, без автоматического трёхстороннего merge задач, и какие правила снижает число конфликтов.
Критерии готовности эпика: раздел в README.md и README.en.md; ограничения названы честно (нет semantic merge / нет UI по markers — до реализации соответствующих эпиков).

### Раздел в README

Цель: единый источник правды для пользователей и ревьюеров о командном режиме.
Критерии готовности:
1. В обоих README есть раздел про Git sync / merge
2. Описаны ограничения текущей реализации
3. Описаны правила работы команды
Вне scope: CRDT, серверный бэкенд, один файл на задачу (только упоминание как future).

- [ ] Описать стратегию слияний в README
  Цель: зафиксировать модель «источник правды — файлы `.proman/` в git; слияние = обычный git merge/rebase».
  Критерии готовности:
  1. README.md и README.en.md содержат раздел (например «Team Git sync · merge»)
  2. Явно сказано: нет семантического merge JSON; auto-commit только `.proman/`
  3. Указано, что pull затрагивает весь workspace (как в текущем warning)
  Оценка: 2 SP / 1 час
  Assignee: @vibondar
  Теги: #docs #infra
  Код: README.md, README.en.md
  Вне scope: перевод на другие языки кроме en/ru.

- [ ] Описать правила командной работы
  Цель: практический чеклист, снижающий CONFLICT в `trees/*.json`.
  Критерии готовности:
  1. Pull перед сменой статусов / импортом MD
  2. Короткие коммиты статусов; не смешивать рефакторинг кода и массовый rewrite дерева в одном коммите без нужды
  3. По возможности один «владелец» активной секции (`trees/<slug>.json`) на спринт
  4. При CONFLICT: править markers в git, затем Reload / не оставлять `<<<<<<<` в JSON
  Оценка: 1 SP / 0.5 часа
  Assignee: @vibondar
  Теги: #docs
  Код: README.md, README.en.md
  Depends on Описать стратегию слияний в README

## Эпик B — детект конфликтов и UX

Зачем: сейчас corrupt `trees/*.json` тихо пропускается (`load: skipped corrupt tree file`); пользователь видит «пропавшее» дерево без объяснения. Нужен явный сигнал и путь восстановления.
Критерии готовности эпика: markers и битый JSON видны в UI; store не молча глотает conflicted файлы; тесты на детектор.
Depends on Описать правила командной работы

### Детектор и загрузка

Цель: при load/pull распознать git conflict markers и невалидный JSON в `.proman/`.
Критерии готовности:
1. Общий хелпер детекта `<<<<<<<` / `=======` / `>>>>>>>` (и опционально «не парсится как JSON»)
2. Store/load возвращает структурированный результат (список проблемных путей), а не только log
3. Поведение валидных файлов не меняется
Depends on Описать правила командной работы

- [ ] Добавить детект conflict markers в .proman
  Цель: машинно отличать merge-conflict от прочего corrupt JSON.
  Критерии готовности:
  1. Функция вроде `detectPromanFileProblem(text)` → `ok | conflict_markers | invalid_json`
  2. Покрыта unit-тестами (markers, валидный JSON, обрезанный JSON)
  3. Сканируются как минимум `project.json`, `tree.json`, `trees/*.json`
  Оценка: 3 SP / 2 часа
  Assignee: @vibondar
  Теги: #backend #git #refactoring
  Код: src/core/promanConflict.ts
  Тесты: tests/promanConflict.test.ts
  Depends on Описать правила командной работы

- [ ] Не молчать при corrupt/conflict в store.load
  Цель: заменить тихий skip на явный отчёт о проблемных файлах.
  Критерии готовности:
  1. Conflicted/corrupt файлы не подмешиваются в forest «как будто их нет» без сигнала
  2. API load (или side-channel) отдаёт список `{ path, kind }`
  3. Валидные секции по-прежнему загружаются, если это безопасно; иначе fail-closed с понятной причиной (зафиксировать выбор в PR)
  Оценка: 5 SP / 3 часа
  Assignee: @vibondar
  Теги: #backend #git
  Код: src/core/store.ts, src/core/driveEngine.ts
  Тесты: tests/storeLoadConflict.test.ts
  Depends on Добавить детект conflict markers в .proman
  Заметки / риски: не перезаписывать conflicted файл heal/write с диска.

### Диалоги после Pull / при старте

Цель: пользователь видит, что делать дальше, а не пустое дерево.
Критерии готовности:
1. После неудачного/частичного load — Warning/Error с путями файлов
2. Действия: Open file / Reload / (опционально) Open in Source Control
Depends on Не молчать при corrupt/conflict в store.load

- [ ] Диалог при conflict markers после pull/load
  Цель: понятный human-facing путь при CONFLICT в `.proman/`.
  Критерии готовности:
  1. Сообщение отличает conflict markers от прочего invalid JSON
  2. Есть кнопка открыть проблемный файл (или первый из списка)
  3. После ручного разрешения markers — Reload восстанавливает дерево без перезапуска Cursor
  4. Строки l10n en/ru
  Оценка: 3 SP / 2 часа
  Assignee: @vibondar
  Теги: #frontend #ui #git
  Код: src/gitSyncUi.ts, src/extension.ts, l10n/bundle.l10n.ru.json
  Depends on Не молчать при corrupt/conflict в store.load

- [ ] Пробросить ошибку git CONFLICT из pull
  Цель: если `git pull` упал с CONFLICT, текст ошибки не теряется и hint указывает на `.proman/`.
  Критерии готовности:
  1. `runGitPull` при `!r.ok` по-прежнему показывает sanitize error
  2. Если stderr/stdout содержит CONFLICT / conflict — дополнительная подсказка про resolve + Reload
  3. Не предлагать «Keep from disk» sync-meta поверх неразрешённого merge
  Оценка: 2 SP / 1 час
  Assignee: @vibondar
  Теги: #git #ui
  Код: src/gitSyncUi.ts, src/core/gitSync.ts
  Тесты: tests/gitSync.test.ts
  Depends on Диалог при conflict markers после pull/load

## Эпик C — семантический merge (опционально v2)

Зачем: снизить ручной разбор JSON, когда оба изменили разные задачи в одном `trees/<slug>.json`. Это не замена git; это post-conflict / smart-merge helper.
Критерии готовности эпика: merge по `task.id` с документированными правилами полей; тесты на пересечения; вызов только по явному действию пользователя (не silent на каждый pull).
Depends on Диалог при conflict markers после pull/load
Вне scope эпика: полный CRDT, offline-first multiplayer, один файл на задачу.

### Правила слияния задач

Цель: детерминированные правила для status / assignee / children / dependsOn.
Критерии готовности:
1. Документ правил в плане или коротком ADR в docs/
2. Реализация чистой функции merge без vscode API
Depends on Диалог при conflict markers после pull/load

- [ ] Зафиксировать правила semantic merge полей
  Цель: до кода согласовать приоритеты (иначе ревью снова упрётся в «чья версия»).
  Критерии готовности:
  1. Таблица: поле → стратегия (ours / theirs / union / prefer non-todo / timestamp если появится)
  2. Явно: `children` и `dependsOn` — union vs ours-wins при структурном конфликте
  3. Случай «одна сторона удалила задачу» описан
  Оценка: 2 SP / 1.5 часа
  Assignee: @vibondar
  Теги: #docs #design
  Код: docs/plans/gitMergeConflicts.md
  Depends on Диалог при conflict markers после pull/load
  Вне scope: автоматический выбор без подтверждения человека на structural delete.

Правила полей (ADR): [docs/adr/semantic-tree-merge.md](../adr/semantic-tree-merge.md).

- [ ] Реализовать mergeTreeByTaskId
  Цель: чистая функция слияния двух валидных TreeBundle (или tasks maps).
  Критерии готовности:
  1. Unit-тесты: disjoint status edits, один title+status conflict, union dependsOn
  2. Нет зависимости от git / vscode
  3. Результат проходит sanitizeLoadedTreeBundle
  Оценка: 5 SP / 4 часа
  Assignee: @vibondar
  Теги: #backend #git
  Код: src/core/treeMerge.ts
  Тесты: tests/treeMerge.test.ts
  Depends on Зафиксировать правила semantic merge полей

- [ ] Команда Resolve Proman merge
  Цель: human-in-the-loop: взять ours/theirs/base (или два файла) и записать результат.
  Критерии готовности:
  1. Команда в package.json + handler
  2. Работает только когда файлы уже без markers либо принимает пару JSON-снимков
  3. После записи — reload store + сообщение об успехе
  4. В README добавлена ссылка на команду как advanced
  Оценка: 5 SP / 3 часа
  Assignee: @vibondar
  Теги: #frontend #git
  Код: src/registerCommands.ts, src/core/treeMerge.ts
  Тесты: tests/treeMerge.test.ts
  Depends on Реализовать mergeTreeByTaskId
  Depends on Описать стратегию слияний в README
  Заметки / риски: не включать в MVP, если эпик B закрывает ревью; можно отложить в follow-up PR.

## Эпик D — проверка и документация итога

Зачем: доказать ревью, что ограничения задокументированы, а silent skip устранён (или заменён явным UX).
Критерии готовности эпика: README актуален относительно кода; тесты детектора зелёные; smoke pull с искусственными markers.
Depends on Диалог при conflict markers после pull/load

- [ ] Обновить README после UX
  Цель: убрать формулировки «будет» / «пока нет», если эпик B смержен.
  Критерии готовности:
  1. README описывает фактическое поведение диалога
  2. Semantic merge упомянут только если эпик C вошёл в релиз; иначе — «не в scope / planned»
  Оценка: 1 SP / 0.5 часа
  Assignee: @vibondar
  Теги: #docs
  Код: README.md, README.en.md
  Depends on Диалог при conflict markers после pull/load

- [ ] Smoke и тесты регрессии load
  Цель: merge-ready сигнал.
  Критерии готовности:
  1. `npm test` зелёный, включая conflict-тесты
  2. Ручной smoke: файл с `<<<<<<<` в `trees/*.json` → диалог, не пустой silent tree
  3. Валидный `.proman/` без регрессии load/save
  Оценка: 2 SP / 1 час
  Assignee: @vibondar
  Теги: #test #git
  Код: tests/
  Depends on Диалог при conflict markers после pull/load
  Depends on Обновить README после UX

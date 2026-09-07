/**
 * Плечи бенчмарка. Каждое плечо — это то, ЧЕМ агент ищет по репозиторию.
 *
 * Всё остальное держим одинаковым: одна модель, один корпус, один набор
 * вопросов, один системный промпт opencode. Меняется ровно две вещи:
 * `agents` (текст, который уезжает в системный промпт и говорит, чем искать)
 * и `mcp` (какие MCP-серверы подняты — их схемы инструментов тоже стоят
 * токенов, и это часть замеряемой цены).
 *
 * `setup` — разовая подготовка индекса, время и размер меряются отдельно от
 * запросов: это цена входа, а не цена вопроса.
 */

/**
 * Права плеча. В v2 это УПОРЯДОЧЕННЫЙ массив `{action, resource, effect}`,
 * побеждает последнее совпавшее правило.
 *
 * Зачем вообще запрещать. В первом прогоне плечи `ast-grep` и `semble` свои
 * бинари не запустили ни разу: модель читала инструкцию «используй ast-grep» и
 * всё равно звала `grep`. Строка таблицы тогда меряет grep, а не инструмент.
 * Поэтому у плеча с собственным поисковиком `grep` и `glob` закрыты — иначе
 * сравнение бессмысленно.
 *
 * Чтение оставлено всем: без него нечего цитировать, и вопрос не про чтение.
 * Запреты стоят последними, чтобы никакая строка выше их молча не открыла.
 */
const ALLOW_ALL = [
  { action: 'read', resource: '*', effect: 'allow' },
  { action: 'list', resource: '*', effect: 'allow' },
  { action: 'grep', resource: '*', effect: 'allow' },
  { action: 'glob', resource: '*', effect: 'allow' },
  { action: 'shell', resource: '*', effect: 'allow' },
]

/**
 * Свой поисковик запускается из шелла, поэтому шелл нужен, а grep — закрыт.
 *
 * Запрета инструмента `grep` мало: агент трижды обошёл его — сначала вызвал
 * бинарь `grep` из шелла, потом `rg`, потом перепоручил поиск субагенту
 * `explore`. Поэтому закрыты все три пути: `shell` по ОБРАЗЦУ КОМАНДЫ
 * (`resource` сравнивается со строкой команды — проверено, отдаёт
 * `Permission denied: shell`) и `subagent` целиком.
 *
 * PATH-заглушки для той же цели не годятся: агентский шелл — git-bash, он
 * ставит `/usr/bin` первым и настоящий grep перекрывает любую подложенную
 * пустышку (`which grep` → `/usr/bin/grep`, проверено зондом).
 */
const NO_GREP_SHELL = [
  { action: 'read', resource: '*', effect: 'allow' },
  { action: 'list', resource: '*', effect: 'allow' },
  { action: 'shell', resource: '*', effect: 'allow' },
  { action: 'grep', resource: '*', effect: 'deny' },
  { action: 'glob', resource: '*', effect: 'deny' },
  { action: 'subagent', resource: '*', effect: 'deny' },
  { action: 'shell', resource: '*grep*', effect: 'deny' },
  { action: 'shell', resource: '*rg *', effect: 'deny' },
  { action: 'shell', resource: '*findstr*', effect: 'deny' },
  { action: 'shell', resource: '*Select-String*', effect: 'deny' },
]

/**
 * MCP-инструменты в v2 доступны только через Code Mode (`execute`), поэтому
 * шелл здесь не нужен вовсе — и закрыт, иначе агент обойдёт запрет grep,
 * позвав `rg` из шелла (в первом прогоне он так и делал).
 */
const MCP_ONLY = [
  { action: 'read', resource: '*', effect: 'allow' },
  { action: 'list', resource: '*', effect: 'allow' },
  { action: 'execute', resource: '*', effect: 'allow' },
  { action: 'grep', resource: '*', effect: 'deny' },
  { action: 'glob', resource: '*', effect: 'deny' },
  { action: 'shell', resource: '*', effect: 'deny' },
  { action: 'subagent', resource: '*', effect: 'deny' },
]

/** Ничем не помогаем — встроенные read/grep/glob/shell. Точка отсчёта. */
const baseline = {
  id: 'baseline',
  title: 'grep + read (точка отсчёта)',
  instructions: '',
  permissions: ALLOW_ALL,
  mcp: {},
  setup: null,
}

const astgrep = {
  id: 'ast-grep',
  title: 'ast-grep (структурный CLI)',
  instructions: [
    'Для поиска по коду в этом репозитории используй `ast-grep` через bash — он ищет по AST, а не по тексту.',
    '',
    'Примеры:',
    '- найти определение функции: `ast-grep run -p "function $NAME($$$) { $$$ }" -l js`',
    '- найти все вызовы: `ast-grep run -p "readGatewayKey($$$)"`',
    '- по языку: флаг `-l js|ts|python`; только пути: `--json=compact` и разбор поля file.',
    '',
    '',
    'Grep и glob тебе НЕ выданы: ищи только через ast-grep, читай найденное через read.',
  ].join('\n'),
  permissions: NO_GREP_SHELL,
  blockGrep: 'ast-grep',
  mcp: {},
  setup: null,
}

const semble = {
  id: 'semble',
  title: 'semble (эмбеддинги + BM25, CLI)',
  instructions: [
    'Для поиска по коду в этом репозитории используй `semble` через bash — семантический поиск, отдаёт готовые фрагменты кода с путями.',
    '',
    'Команда: `semble search "<запрос своими словами>" --top-k 10`',
    'Работает по смыслу, а не по точному совпадению: спрашивай «где логика выбора прокси», а не «shouldProxy».',
    '',
    'Grep и glob тебе НЕ выданы: ищи только через semble, читай найденное через read.',
  ].join('\n'),
  permissions: NO_GREP_SHELL,
  blockGrep: 'semble search',
  mcp: {},
  // Первый запуск сам строит индекс; прогреваем заранее, чтобы не мерить его в
  // вопросе. Запрос — одним словом и в кавычках: аргументы уезжают через
  // cmd.exe, и «warmup index» он разбил на два, а `index` semble принял за путь.
  setup: { cmd: 'semble', args: ['search', '"warmup"', '--top-k', '1'] },
}

const repomix = {
  id: 'repomix',
  title: 'repomix (весь репозиторий одним файлом)',
  instructions: [
    'В корне лежит `repomix-output.xml` — весь репозиторий, сжатый в один файл: дерево каталогов и содержимое всех файлов.',
    '',
    'Сначала читай его, отвечай по нему. Отдельные файлы открывай, только если в выжимке чего-то не хватает.',
    '',
    'Grep и glob тебе НЕ выданы.',
  ].join('\n'),
  permissions: NO_GREP_SHELL,
  blockGrep: 'repomix-output.xml',
  mcp: {},
  setup: { cmd: 'repomix', args: ['--compress', '--output', 'repomix-output.xml'] },
}

const codanna = {
  id: 'codanna',
  title: 'codanna (граф символов, MCP)',
  instructions: [
    'Для поиска по коду в этом репозитории используй инструменты codanna — у них готовый граф символов репозитория.',
    '',
    'Grep, glob и шелл тебе НЕ выданы: ищи только инструментами codanna через execute.',
  ].join('\n'),
  permissions: MCP_ONLY,
  // Сервер поднимает `serve`. Подкоманда `mcp` — это «выполнить MCP-инструмент
  // из CLI», на stdio она не отвечает и сервер оставался в статусе `pending`.
  mcp: {
    codanna: { type: 'local', command: ['codanna', 'serve'], environment: {} },
  },
  // Флага `--progress` у codanna нет, есть `--no-progress`; прогресс-бар пишется
  // в stdout и мешает разбору, поэтому гасим его явно.
  setup: [
    { cmd: 'codanna', args: ['init', '--force'] },
    { cmd: 'codanna', args: ['index', '.', '--no-progress', '--force'] },
  ],
}

/**
 * codebase-memory-mcp. Установку НЕ делаем автоматически: на Windows у них
 * открыты #2045 (инсталлятор стёр пользователю PATH) и #2021 (BSOD в Ntfs.sys).
 * Плечо включается только явным флагом --with-cbm и только после того, как
 * владелец машины сказал «ставь».
 */
const cbm = {
  id: 'codebase-memory',
  title: 'codebase-memory-mcp (граф tree-sitter, MCP)',
  gated: true,
  instructions: [
    'Для поиска по коду в этом репозитории используй инструменты codebase-memory — у них готовый граф знаний репозитория.',
    '',
    'Grep, glob и шелл тебе НЕ выданы: ищи только инструментами codebase-memory через execute.',
  ].join('\n'),
  permissions: MCP_ONLY,
  // Без подкоманды бинарь И ЕСТЬ MCP-сервер на stdio — подкоманды `mcp` у него нет.
  // Ставили распакованным релизом, их `install` не запускали: именно установщик
  // стирает PATH в #2045, а мерить надо сервер, а не установщик.
  mcp: {
    'codebase-memory': { type: 'local', command: ['codebase-memory-mcp.exe'], environment: {} },
  },
  // `repo_path` только флагом и только абсолютным путём: позиционный `.` бинарь
  // отвергает («repo_path is required»). {CORPUS} подставляет bench.mjs.
  // Индекс кладётся не в репозиторий, а глобально в ~/.cache/codebase-memory-mcp.
  setup: [{ cmd: 'codebase-memory-mcp.exe', args: ['cli', 'index_repository', '--repo_path={CORPUS}'] }],
  indexPath: '~/.cache/codebase-memory-mcp',
}

export const ARMS = [baseline, astgrep, semble, repomix, codanna, cbm]
export const arm = (id) => ARMS.find((a) => a.id === id)

#!/usr/bin/env node
/**
 * Бенчмарк инструментов навигации по коду для агента.
 *
 * Что меряем и почему именно это. Все вендоры в категории меряют экономию
 * токенов НА ОДИН ВЫЗОВ поиска. Это не то число, по которому приходит счёт:
 * если инструмент отдаёт компактный ответ, но агент делает вдвое больше ходов,
 * сессия дорожает. Поэтому здесь единица замера — полный ответ на вопрос:
 * все токены всех ходов, все вызовы инструментов, всё время до ответа, и
 * отдельно — попал агент в правильные файлы или нет.
 *
 * Запуск (всё по умолчанию):
 *   node bench.mjs
 * Отдельные плечи и повторы:
 *   node bench.mjs --arms baseline,semble --repeats 3
 * Только вопросы одного типа:
 *   node bench.mjs --kinds inventory --repeats 2
 *
 * Результат: results.jsonl (сырьё), report.md (сводка).
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARMS } from './arms.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/**
 * Корпус обязан лежать в отдельном дереве, а не рядом с харнессом.
 *
 * Агент умеет подниматься по каталогам вверх. Пока корпус был подкаталогом
 * харнесса, агент доходил до `questions.json` и читал оттуда правильные ответы —
 * 11 прогонов из 191 в одном из заходов. Держите корпус там, где рядом нет
 * ни вопросов, ни результатов: `BENCH_CORPUS=C:\\bench-arena\\repo`.
 */
const CORPUS = process.env.BENCH_CORPUS || path.join(HERE, '..', 'arena', 'repo')
const MODEL = process.env.BENCH_MODEL || 'glm-5.3-flash'
/** Сырьё прогона; для второй модели — другой файл, чтобы треки не смешивались. */
const RESULTS = process.env.BENCH_RESULTS || 'results.jsonl'

/**
 * Каталог самого харнесса — корпус, а не `bench/`.
 *
 * Корень проекта opencode берёт из cwd РОДИТЕЛЬСКОГО процесса: ни `cwd` у
 * `spawn`, ни `cd /d` внутри команды, ни каталог `OPENCODE_CONFIG` на это не
 * влияют (проверено всеми тремя). Пока bench.mjs работал из `bench/`, агент
 * стартовал там же — читал `bench.mjs` и `questions.json` с правильными
 * ответами. Все свои пути харнесс и так строит от `HERE`, поэтому смена
 * каталога больше ничего не задевает.
 */
process.chdir(CORPUS)

/**
 * Каталоги с бинарями инструментов. Свежепоставленный npm-global или `uv tool`
 * PATH текущего процесса обычно ещё не знает, а распакованные из релиза бинари
 * не знает и подавно. Свои пути добавляйте через `BENCH_BIN` (разделитель —
 * `;` на Windows, `:` на остальных).
 */
const PATH_EXTRA = [
  ...(process.env.BENCH_BIN || '').split(path.delimiter).filter(Boolean),
  path.join(process.env.APPDATA || '', 'npm'),
  path.join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'bin'),
  path.join(process.env.USERPROFILE || process.env.HOME || '', '.cargo', 'bin'),
].filter(Boolean)

/**
 * `PWD` и `INIT_CWD` переписываем на корпус.
 *
 * Вот из-за чего агент упорно стартовал в каталоге харнесса, сколько его оттуда
 * ни выгоняй. Git Bash выставляет `PWD` при `cd`, node его при `process.chdir`
 * НЕ обновляет, а opencode берёт рабочий каталог именно из окружения — поэтому
 * не помогли ни `cwd` у spawn, ни `cd /d` в команде, ни `process.chdir`, ни
 * перенос конфига. Итог был один: агент читал `questions.json` с эталонными
 * ответами. Здесь это чинится одной строкой.
 */
const ENV = {
  ...process.env,
  PATH: [...PATH_EXTRA, process.env.PATH].join(path.delimiter),
  PWD: CORPUS,
  INIT_CWD: CORPUS,
  OLDPWD: CORPUS,
}

const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i === -1 ? def : argv[i + 1]
}
const REPEATS = Number(flag('repeats', 1))
const ONLY = (flag('arms', '') || '').split(',').filter(Boolean)
const WITH_CBM = argv.includes('--with-cbm')
/** Только вопросы этих типов: `--kinds inventory` — догнать новый тип, не перегоняя всё. */
const KINDS = (flag('kinds', '') || '').split(',').filter(Boolean)

/** Запустить процесс, вернуть {code, stdout, stderr, ms}. Без исключений. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    // `cd /d` внутри самой команды, а не опция `cwd`. Проверено: opencode2,
    // запущенный через cmd.exe, опцию `cwd` игнорирует и берёт каталог
    // родительского процесса — агент оказывался в `bench/` вместо корпуса и
    // видел файлы харнесса. Из bash напрямую тот же вызов отрабатывает верно,
    // то есть дело именно в связке spawn+shell.
    const dir = opts.cwd || CORPUS
    const line = `cd /d "${dir}" && ${cmd} ${args.join(' ')}`
    const p = spawn(line, { env: { ...ENV, ...(opts.env || {}) }, shell: true })
    // Без этого `opencode2 run` ждёт EOF на stdin и висит вечно.
    p.stdin.end()
    let out = '', err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    // `shell: true` порождает cmd.exe, а под ним — реальный процесс. `p.kill()`
    // валит только cmd, а `opencode2 --standalone` остаётся жить: за прогон их
    // накопилось столько, что харнесс встал насмерть. Бьём всё дерево.
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { shell: true }) } catch { /* уже умер */ }
          p.kill('SIGKILL')
          err += '\n[timeout]'
        }, opts.timeoutMs)
      : null
    p.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout: out, stderr: err, ms: Date.now() - started })
    })
    p.on('error', (e) => {
      if (timer) clearTimeout(timer)
      resolve({ code: -1, stdout: out, stderr: err + String(e), ms: Date.now() - started })
    })
  })
}

/** Размер каталога в байтах, рекурсивно. Нет каталога — ноль. */
function dirSize(dir) {
  let total = 0
  const walk = (d) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else try { total += fs.statSync(full).size } catch { /* исчез между readdir и stat */ }
    }
  }
  walk(dir)
  return total
}

/** Артефакты индексов — чтобы плечи не наследовали чужой индекс и мерился размер. */
const INDEX_DIRS = ['.codanna', '.semble', '.codebase-memory', 'repomix-output.xml']

function cleanIndexes() {
  for (const name of INDEX_DIRS) {
    const p = path.join(CORPUS, name)
    try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* занят — переживём */ }
  }
}

/**
 * Каждому плечу — свой конфиг opencode, а не проектный `opencode.json`.
 *
 * Почему так. Фоновый сервис поднимает MCP-серверы один раз при старте и
 * проектный `opencode.json` с новым сервером не перечитывает: `opencode2 mcp
 * list` показывал codanna как `pending` до конца прогона, а плечо всё это время
 * молча измеряло голый grep. Если в глобальном конфиге есть плагин, он вдобавок
 * держит каталог MCP под собой, и чужая запись туда не попадает вовсе.
 * Наконец, посторонние серверы льют свои схемы в контекст каждого хода и
 * портят замер токенов.
 *
 * Поэтому: берём провайдеров и модель из глобального конфига, выбрасываем всё
 * остальное, добавляем серверы плеча — и запускаем с `--standalone`, чтобы
 * поднялся приватный сервер, который этот конфиг прочтёт. Проверено живьём:
 * так codanna отдаёт 9 инструментов, а с фоновым сервисом — ни одного.
 */
function armConfigPath(a) {
  const globalCfg = JSON.parse(fs.readFileSync(
    path.join(process.env.USERPROFILE || '', '.config', 'opencode', 'opencode.json'), 'utf8'))
  const cfg = {
    $schema: globalCfg.$schema,
    model: globalCfg.model,
    providers: globalCfg.providers,
    mcp: { servers: { ...a.mcp } },
    // Права задаются агентом: в v2 это единственное место, где их принимают
    // Плечу со своим поисковиком grep закрыт, иначе оно молча меряет grep.
    agents: { bench: { mode: 'primary', permissions: a.permissions } },
  }
  // Конфиг кладём РЯДОМ С КОРПУСОМ, а не в каталог харнесса: корнем проекта
  // opencode берёт каталог файла `OPENCODE_CONFIG`, а не cwd (проверено —
  // агент бегал по `bench/` и видел `corpus/src/...`). Теперь корень — `arena/`,
  // а в ней только `repo/` и этот `cfg/`; правильных ответов там нет.
  const dir = path.join(CORPUS, '..', 'cfg')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, a.id + '.json')
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
  return file
}

/** Инструкции плеча — обычный AGENTS.md в корне корпуса; их opencode читает. */
function applyArm(a) {
  fs.rmSync(path.join(CORPUS, 'opencode.json'), { force: true })
  const agents = path.join(CORPUS, 'AGENTS.md')
  if (a.instructions) fs.writeFileSync(agents, a.instructions + '\n')
  else fs.rmSync(agents, { force: true })
  return armConfigPath(a)
}

/**
 * Один вопрос одному плечу.
 *
 * `opencode2 run --format json` печатает поток событий; из него нужен только
 * sessionID. Числа берём не из потока, а из `opencode2 export`: там лежит
 * посчитанный сервером usage, и это единственный источник, которому можно
 * верить — сам поток токены не суммирует.
 */
async function ask(q, cfgFile) {
  // Одна строка без кавычек и переносов: аргумент уезжает через cmd.exe
  // (`shell: true`), а тот и то, и другое коверкает молча — сессия создавалась,
  // но сообщение в неё не уходило.
  const prompt = (q.q + ' Ответь коротко и обязательно перечисли пути файлов относительно корня репозитория.')
    .replace(/["\n\r%^&|<>]/g, ' ')

  const r = await run('opencode2', [
    'run', '--standalone', '--format', 'json', '--model', MODEL, '--agent', 'bench', '--auto',
    '"' + prompt + '"',
  ], { timeoutMs: 600_000, env: { OPENCODE_CONFIG: cfgFile } })

  let sessionID = null
  for (const line of r.stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try { sessionID = JSON.parse(line).sessionID || sessionID } catch { /* хвост потока рвётся */ }
  }
  if (!sessionID) return { error: 'нет sessionID', wallMs: r.ms, stderr: r.stderr.slice(-400) }

  // В v2.0.2 `export` переехал в `session export`; в beta-19086 был верхнеуровневым.
  const ex = await run('opencode2', ['session', 'export', '--standalone', sessionID], { timeoutMs: 120_000, env: { OPENCODE_CONFIG: cfgFile } })
  let session
  try { session = JSON.parse(ex.stdout) } catch { return { error: 'export не разобрался', sessionID, wallMs: r.ms } }

  // Заражение: агент добрался до файлов харнесса, где лежат правильные ответы.
  // Ловим здесь, а не глазами потом — в прошлый раз 11 таких прогонов нашлись
  // только после сборки отчёта. `must_files` и `must_text` встречаются ТОЛЬКО
  // внутри эталона и разбирающего его кода, в самом корпусе их нет.
  const tainted = /must_files|must_text|bench\.mjs|questions\.json|results\.jsonl/.test(ex.stdout)

  const msgs = session.messages || []
  let input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0, cost = 0
  let turns = 0, toolCalls = 0, answer = ''
  const toolNames = []

  // Форма снята с живого `opencode2 export` (сборка 0.0.0-beta-19086):
  // сообщение плоское — `type`, `tokens`, `cost`, `content[]`. Ни `info`,
  // ни `parts`, ни `role` там нет.
  for (const m of msgs) {
    if (m.type !== 'assistant') continue
    turns++
    const t = m.tokens || {}
    // Суммируем input по ходам сознательно: каждый ход шлёт контекст заново,
    // и платится именно эта сумма, а не input последнего хода.
    input += t.input || 0
    output += t.output || 0
    reasoning += t.reasoning || 0
    cacheRead += t.cache?.read || 0
    cacheWrite += t.cache?.write || 0
    cost += m.cost || 0
    for (const part of m.content || []) {
      // Имя инструмента лежит в `name`, не в `tool` — снято с живого export.
      // Это единственная проверка, что плечо реально пользовалось своим
      // инструментом, а не молча свалилось в grep.
      if (part.type === 'tool') { toolCalls++; if (part.name) toolNames.push(part.name) }
      if (part.type === 'text') answer += (part.text || '') + '\n'
    }
  }

  return {
    sessionID, answer, wallMs: r.ms, tainted,
    input, output, reasoning, cacheRead, cacheWrite, cost,
    turns, toolCalls, toolNames,
  }
}

/** Нормализуем пути: Windows даёт и `\`, и `/`, модель пишет как хочет. */
const norm = (s) => s.replace(/\\/g, '/').toLowerCase()

/**
 * Оценка. Никакого LLM-судьи: сверяем, назвал ли ответ нужные файлы.
 * `recall` — доля эталонных файлов, попавших в ответ. `textHit` — назвал ли
 * требуемые строки (URL, версию, имя функции).
 */
function score(q, answer) {
  const a = norm(answer || '')
  const found = q.must_files.filter((f) => a.includes(norm(f)))
  const foundText = q.must_text.filter((t) => a.includes(t.toLowerCase()))
  const textOk = foundText.length === q.must_text.length
  const fileRecall = q.must_files.length ? found.length / q.must_files.length : 1
  // У `inventory` («перечисли все X») ответ — чеклист, и попадание в файл там
  // тривиально: он один и назван в вопросе. Поэтому recall у этого типа — доля
  // названных элементов чеклиста, а не файлов.
  const textRecall = q.must_text.length ? foundText.length / q.must_text.length : 1
  return {
    recall: q.kind === 'inventory' ? textRecall : fileRecall,
    exact: found.length === q.must_files.length && textOk ? 1 : 0,
    textHit: textOk ? 1 : 0,
    textRecall,
    foundFiles: found,
    missedFiles: q.must_files.filter((f) => !a.includes(norm(f))),
    missedText: q.must_text.filter((t) => !a.includes(t.toLowerCase())),
  }
}

async function main() {
  const questions = JSON.parse(fs.readFileSync(path.join(HERE, 'questions.json'), 'utf8'))
    .filter((q) => !KINDS.length || KINDS.includes(q.kind))
  let arms = ARMS.filter((a) => !a.gated || WITH_CBM)
  if (ONLY.length) arms = arms.filter((a) => ONLY.includes(a.id))

  const outFile = path.join(HERE, RESULTS)
  const stream = fs.createWriteStream(outFile, { flags: 'a' })
  console.log(`модель: ${MODEL} | корпус: ${CORPUS}`)
  console.log(`плечи: ${arms.map((a) => a.id).join(', ')} | вопросов: ${questions.length} | повторов: ${REPEATS}\n`)

  for (const a of arms) {
    console.log(`── ${a.id}: ${a.title}`)
    cleanIndexes()
    const cfgFile = applyArm(a)

    // Цена входа: время индексации и размер индекса на диске.
    let setupMs = 0, setupOk = true, setupErr = ''
    const steps = a.setup ? (Array.isArray(a.setup) ? a.setup : [a.setup]) : []
    for (const s of steps) {
      // {CORPUS} — абсолютный путь корпуса: некоторые инструменты (codebase-memory)
      // относительный путь и `.` не принимают вовсе.
      const args = s.args.map((x) => x.replace('{CORPUS}', CORPUS))
      const r = await run(s.cmd, args, { timeoutMs: 900_000 })
      setupMs += r.ms
      if (r.code !== 0) { setupOk = false; setupErr += `${s.cmd} → код ${r.code}: ${(r.stderr || r.stdout).slice(-300)}\n` }
    }
    let indexBytes = INDEX_DIRS.reduce((sum, n) => {
      const p = path.join(CORPUS, n)
      if (!fs.existsSync(p)) return sum
      return sum + (fs.statSync(p).isDirectory() ? dirSize(p) : fs.statSync(p).size)
    }, 0)
    // Инструмент может держать индекс вне репозитория — тогда меряем там.
    if (a.indexPath) indexBytes += dirSize(a.indexPath.replace('~', process.env.USERPROFILE || ''))
    console.log(`   индекс: ${(setupMs / 1000).toFixed(1)} с, ${(indexBytes / 1e6).toFixed(1)} МБ${setupOk ? '' : ' — СБОЙ'}`)
    if (!setupOk) console.log(`   ${setupErr.trim()}`)

    for (let rep = 0; rep < REPEATS; rep++) {
      for (const q of questions) {
        const res = await ask(q, cfgFile)
        const sc = res.error ? null : score(q, res.answer)
        const row = {
          model: MODEL, arm: a.id, rep, qid: q.id, kind: q.kind,
          setupMs, indexBytes, setupOk,
          ...res, ...(sc || {}),
          answer: undefined, // сырой ответ отдельно, чтобы строка jsonl не распухала
          answerText: res.answer,
        }
        stream.write(JSON.stringify(row) + '\n')
        const mark = res.error ? 'ОШИБКА' : `recall ${(sc.recall * 100).toFixed(0)}%${res.tainted ? ' ЗАРАЖЁН' : ''}`
        const cost = res.error ? '' : ` | ${res.input + res.output} ток | ${res.turns} ход | ${res.toolCalls} вызов | ${(res.wallMs / 1000).toFixed(1)} с`
        console.log(`   ${q.id} ${mark}${cost}${res.error ? ' ' + res.error : ''}`)
      }
    }
    console.log('')
  }

  stream.end()
  cleanIndexes()
  fs.rmSync(path.join(CORPUS, 'AGENTS.md'), { force: true })
  console.log(`готово → ${outFile}`)
}

main()

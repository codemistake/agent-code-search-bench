#!/usr/bin/env node
/**
 * Сводка по results.jsonl. Отдельно от bench.mjs, потому что пересчитывать
 * отчёт приходится чаще, чем гонять модель.
 *
 *   node report.mjs > report.md
 *   node report.mjs results.qwen.jsonl > report.qwen.md
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const rows = fs.readFileSync(path.join(HERE, process.argv[2] || process.env.BENCH_RESULTS || 'results.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

const by = (list, key) => list.reduce((acc, r) => ((acc[r[key]] ||= []).push(r), acc), {})
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
/** Медиана устойчивее среднего: один сорвавшийся прогон не должен решать. */
const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const pct = (x) => (x * 100).toFixed(0) + '%'
const num = (x) => Math.round(x).toLocaleString('ru-RU')

const ok = rows.filter((r) => !r.error)
const failed = rows.filter((r) => r.error)

console.log('# Бенчмарк инструментов навигации по коду\n')
console.log(`Модель: \`${rows[0]?.model || process.env.BENCH_MODEL || 'glm-5.3-flash'}\`. Корпус: \`${process.env.BENCH_CORPUS_NAME || 'см. настройку прогона'}\`.`)
console.log(`Прогонов: ${rows.length}, из них сорвалось ${failed.length}.\n`)

console.log('## Итог по плечам\n')
console.log('| Плечо | recall | точных | токенов | ходов | вызовов | сек | индекс, с | индекс, МБ |')
console.log('|---|---|---|---|---|---|---|---|---|')
for (const [armId, list] of Object.entries(by(ok, 'arm'))) {
  const tok = list.map((r) => r.input + r.output)
  console.log([
    armId,
    pct(mean(list.map((r) => r.recall))),
    pct(mean(list.map((r) => r.exact))),
    num(median(tok)),
    median(list.map((r) => r.turns)).toFixed(1),
    median(list.map((r) => r.toolCalls)).toFixed(1),
    (median(list.map((r) => r.wallMs)) / 1000).toFixed(1),
    (list[0].setupMs / 1000).toFixed(1),
    (list[0].indexBytes / 1e6).toFixed(1),
  ].join(' | ').replace(/^/, '| ') + ' |')
}

console.log('\n## По типу вопроса (recall)\n')
const kinds = [...new Set(ok.map((r) => r.kind))]
console.log('| Плечо | ' + kinds.join(' | ') + ' |')
console.log('|---' .repeat(kinds.length + 1) + '|')
for (const [armId, list] of Object.entries(by(ok, 'arm'))) {
  const cells = kinds.map((k) => pct(mean(list.filter((r) => r.kind === k).map((r) => r.recall))))
  console.log(`| ${armId} | ${cells.join(' | ')} |`)
}

console.log('\n## Токены относительно точки отсчёта\n')
const base = ok.filter((r) => r.arm === 'baseline')
const baseTok = median(base.map((r) => r.input + r.output))
const baseRecall = mean(base.map((r) => r.recall))
console.log('| Плечо | токенов | против baseline | recall | против baseline |')
console.log('|---|---|---|---|---|')
for (const [armId, list] of Object.entries(by(ok, 'arm'))) {
  const tok = median(list.map((r) => r.input + r.output))
  const rec = mean(list.map((r) => r.recall))
  const dTok = baseTok ? ((tok / baseTok - 1) * 100).toFixed(0) : '—'
  const dRec = ((rec - baseRecall) * 100).toFixed(0)
  console.log(`| ${armId} | ${num(tok)} | ${dTok > 0 ? '+' : ''}${dTok}% | ${pct(rec)} | ${dRec > 0 ? '+' : ''}${dRec} п.п. |`)
}

if (failed.length) {
  console.log('\n## Сорвавшиеся прогоны\n')
  for (const r of failed) console.log(`- \`${r.arm}\` / ${r.qid}: ${r.error}`)
}

console.log('\n## Промахи по вопросам\n')
console.log('| Вопрос | ' + Object.keys(by(ok, 'arm')).join(' | ') + ' |')
console.log('|---'.repeat(Object.keys(by(ok, 'arm')).length + 1) + '|')
for (const [qid, list] of Object.entries(by(ok, 'qid'))) {
  const cells = Object.keys(by(ok, 'arm')).map((a) => {
    const r = list.find((x) => x.arm === a)
    return r ? pct(r.recall) : '—'
  })
  console.log(`| ${qid} | ${cells.join(' | ')} |`)
}

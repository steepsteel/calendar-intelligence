import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeAgenda, detectProvider, type CalendarEvent } from '../src/calendar.ts'
import { demoEvents } from '../src/demo.ts'

function event(id: string, start: string, end: string, changes: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id, provider: 'google', ical_uid: null, title: id,
    starts_at: start, ends_at: end, private: false, busy: true, all_day: false, ...changes,
  }
}

test('suggests providers using exact domains and allows unknown domains', () => {
  assert.equal(detectProvider(' Person@GMAIL.COM '), 'google')
  assert.equal(detectProvider('me@outlook.com'), 'microsoft')
  assert.equal(detectProvider('me@mac.com'), 'apple')
  assert.equal(detectProvider('me@zohomail.com'), 'zoho')
  assert.equal(detectProvider('me@company.example'), undefined)
  assert.equal(detectProvider('me@fake.gmail.com'), undefined)
  assert.equal(detectProvider('me@@gmail.com'), undefined)
})

test('merges cross-provider copies, preserves recurring occurrences, and masks a private copy', () => {
  const original = event('planning', '2026-11-26T17:00Z', '2026-11-26T18:00Z', { ical_uid: 'series' })
  const copy = { ...original, id: 'copy', provider: 'microsoft' as const, starts_at: '2026-11-26T11:00-06:00', private: true }
  const recurrence = { ...original, id: 'later', starts_at: '2026-11-27T17:00Z', ends_at: '2026-11-27T18:00Z' }
  const [first, second] = analyzeAgenda([original, copy, recurrence])
  assert.equal(first.title, 'Private event')
  assert.deepEqual([...first.sources], ['google', 'microsoft'])
  assert.equal(first.conflict, false)
  assert.equal(second.title, 'planning')
})

test('marks nested busy overlaps while ignoring free events and touching boundaries', () => {
  const time = (hour: number) => `2026-11-26T${hour}:00Z`
  const agenda = analyzeAgenda([
    event('long', time(10), time(14)),
    event('short', time(11), time(12)),
    event('free', time(11), time(15), { busy: false }),
    event('later', time(13), time(14)),
    event('adjacent', time(14), time(15)),
    event('invalid', time(15), time(14)),
  ])
  assert.deepEqual(agenda.filter(entry => entry.conflict).map(entry => entry.event.id), ['long', 'short', 'later'])
  assert.equal(agenda.length, 5)
})

test('demo illustrates four providers, a duplicate and a conflict', () => {
  const agenda = analyzeAgenda(demoEvents(new Date(2026, 10, 26)))
  assert.equal(agenda.length, 4)
  assert.equal(new Set(agenda.flatMap(entry => [...entry.sources])).size, 4)
  assert.equal(agenda.filter(entry => entry.conflict).length, 2)
})

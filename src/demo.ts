import type { CalendarEvent, Provider } from './calendar.ts'

export function demoEvents(now = new Date()): CalendarEvent[] {
  function event(id: string, provider: Provider, title: string, hour: number, minutes: number): CalendarEvent {
    const start = new Date(now)
    start.setHours(0, hour * 60, 0, 0)
    return {
      id, provider, title, ical_uid: null, busy: true, all_day: false, private: false,
      starts_at: start.toISOString(),
      ends_at: new Date(start.getTime() + minutes * 60_000).toISOString(),
    }
  }

  const review = { ...event('review', 'google', 'Project review', 10, 60), ical_uid: 'review@example.test' }
  return [
    event('planning', 'google', 'Weekly planning', 8, 45),
    review,
    { ...review, id: 'review-copy', provider: 'microsoft' },
    event('appointment', 'apple', 'Appointment', 10.5, 30),
    event('focus', 'zoho', 'Focus time', 14, 90),
  ]
}

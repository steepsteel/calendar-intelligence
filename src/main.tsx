import { createClient, type Session } from '@supabase/supabase-js'
import { useEffect, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { analyzeAgenda, detectProvider, providerLabels, type CalendarEvent, type Provider } from './calendar.ts'
import { demoEvents } from './demo.ts'
import './style.css'

const { VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: key } = import.meta.env
const supabase = url && key ? createClient(url, key, { auth: { flowType: 'pkce' } }) : null
const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

interface Connection {
  id: string
  provider: Provider
  status: string
  last_success_at: string | null
}

function Agenda({ events }: { events: CalendarEvent[] }) {
  const [hideTitles, setHideTitles] = useState(false)
  const agenda = analyzeAgenda(events)
  return <section aria-labelledby="agenda-title">
    <div className="section-heading">
      <h2 id="agenda-title">Agenda</h2>
      <label><input type="checkbox" checked={hideTitles} onChange={e => setHideTitles(e.target.checked)} /> Hide titles</label>
    </div>
    {agenda.length === 0 && <p>No events in this window.</p>}
    <ul className="agenda">
      {agenda.map((entry, index) => {
        const day = dateFormat.format(entry.start)
        return <li key={entry.key}>
          {(index === 0 || dateFormat.format(agenda[index - 1].start) !== day) && <h3>{day}</h3>}
          <article>
            <div className="time">{entry.event.all_day ? 'All day' : timeFormat.formatRange(entry.start, entry.end)}</div>
            <div><strong>{hideTitles ? 'Calendar event' : entry.title}</strong>
              <div className="sources">{[...entry.sources].map(provider => providerLabels[provider]).join(' · ')}</div>
            </div>
            {entry.conflict && <span className="conflict">Conflict</span>}
          </article>
        </li>
      })}
    </ul>
  </section>
}

function ProviderPicker() {
  const [email, setEmail] = useState('')
  const [selected, setSelected] = useState<Provider | ''>('')
  const suggested = detectProvider(email)
  return <section aria-labelledby="provider-title">
    <h2 id="provider-title">Identify a calendar provider</h2>
    <div className="fields">
      <label>Calendar email<input type="email" value={email} onChange={e => { setEmail(e.target.value); setSelected('') }} /></label>
      <div className="field">
        <label htmlFor="calendar-provider">Provider</label>
        <select id="calendar-provider" value={selected || suggested || ''} onChange={e => setSelected(e.target.value as Provider)}>
          <option value="" disabled>Choose a provider</option>
          {Object.entries(providerLabels).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
        </select>
      </div>
    </div>
    <p className="sources">Calendar account connections are pending. Email matching runs locally.</p>
  </section>
}

function SignIn() {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setMessage('')
    try {
      const result = await supabase!.auth.signInWithOtp({
        email, options: { shouldCreateUser: false, emailRedirectTo: location.origin },
      })
      setMessage(result.error ? 'Could not send a sign-in link.' : 'Check your email for a sign-in link.')
    } catch {
      setMessage('Could not send a sign-in link.')
    } finally {
      setPending(false)
    }
  }
  return <section>
    <h2>Sign in</h2>
    <form onSubmit={signIn}>
      <label>Email<input required type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
      <button disabled={pending}>Send sign-in link</button>
    </form>
    <p role="status">{message}</p>
  </section>
}

function SignedIn({ userId }: { userId: string }) {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [truncated, setTruncated] = useState(false)
  const [signOutError, setSignOutError] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setDate(end.getDate() + 14)
    void Promise.all([
      supabase!.from('calendar_events')
        .select('id,provider,ical_uid,title,starts_at,ends_at,busy,all_day,private')
        .gt('ends_at', start.toISOString()).lt('starts_at', end.toISOString())
        .order('starts_at').order('id').limit(501).abortSignal(controller.signal),
      supabase!.from('calendar_connections').select('id,provider,status,last_success_at')
        .order('provider').abortSignal(controller.signal),
    ]).then(([agenda, accounts]) => {
      if (controller.signal.aborted) return
      if (agenda.error || accounts.error) {
        setStatus('error')
        return
      }
      setEvents(agenda.data.slice(0, 500))
      setTruncated(agenda.data.length > 500)
      setConnections(accounts.data)
      setStatus('ready')
    }).catch(() => {
      if (!controller.signal.aborted) setStatus('error')
    })
    return () => controller.abort()
  }, [userId])
  return <>
    <button onClick={async () => {
      setSignOutError(false)
      try {
        const { error } = await supabase!.auth.signOut({ scope: 'local' })
        setSignOutError(Boolean(error))
      } catch {
        setSignOutError(true)
      }
    }}>Sign out</button>
    {signOutError && <p role="alert">Could not sign out. Try again.</p>}
    {status === 'loading' && <p role="status">Loading your calendars…</p>}
    {status === 'error' && <p role="alert">Calendar data could not be loaded. Reload to try again.</p>}
    {status === 'ready' && <>
      <section>
        <h2>Connections</h2>
        {connections.length === 0 ? <p>No calendar accounts connected.</p> : <ul>
          {connections.map(connection => <li key={connection.id}>
            {providerLabels[connection.provider]} · {connection.status === 'reauthorize' ? 'Sign-in required' : connection.status}
            {connection.last_success_at && <span> · Last sync {new Date(connection.last_success_at).toLocaleString()}</span>}
          </li>)}
        </ul>}
      </section>
      <p className="sources">14-day window{truncated && ' · Showing the first 500 records. Conflict detection covers these records.'}</p>
      <Agenda events={events} />
    </>}
  </>
}

function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  useEffect(() => {
    const subscription = supabase?.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => subscription?.data.subscription.unsubscribe()
  }, [])
  return <main>
    <header><p className="eyebrow">{supabase ? 'Personal calendar' : 'Demo · Synthetic events'}</p><h1>Calendar Intelligence</h1></header>
    {!supabase && <Agenda events={demoEvents()} />}
    {supabase && (session === undefined ? <p role="status">Checking sign-in…</p> : session
      ? <SignedIn key={session.user.id} userId={session.user.id} />
      : <SignIn />)}
    <ProviderPicker />
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)

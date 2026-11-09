import { useEffect, useRef } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import { Layout } from './components/Layout'
import { ToastProvider } from './components/Toasts'
import { useTheme } from './lib/hooks'
import { SessionProvider, useSession } from './lib/session'
import { CompliancePage } from './pages/Compliance'
import { EventsPage } from './pages/Events'
import { FilesPage } from './pages/Files'
import { JobDetailPage } from './pages/JobDetail'
import { JobHistoryPage } from './pages/JobHistory'
import { JobsPage } from './pages/Jobs'
import { KeysPage } from './pages/Keys'
import { LoginPage } from './pages/Login'
import { MinionDetailPage } from './pages/MinionDetail'
import { MinionsPage } from './pages/Minions'
import { OrchestratePage } from './pages/Orchestrate'
import { PatchesPage } from './pages/Patches'
import { RunPage } from './pages/Run'
import { AuditPage } from './pages/Audit'
import { UsersPage } from './pages/Users'
import { NotificationsPage } from './pages/Notifications'
import { SystemPage } from './pages/System'
import { SchedulesPage } from './pages/Schedules'
import { VulnerabilitiesPage } from './pages/Vulnerabilities'

function Gate() {
  const { session, login, server } = useSession()
  useTheme()
  // ?demo opens the simulated master straight away (handy for shareable demo links)
  const wantsDemo = !session && new URLSearchParams(window.location.search).has('demo')
  const started = useRef(false)
  useEffect(() => {
    if (!wantsDemo || started.current) return
    started.current = true
    void login({ mode: 'demo', apiUrl: '', username: 'demo', password: '', eauth: 'pam' })
  }, [wantsDemo, login])
  if (wantsDemo) return null
  // wait for the server probe so the right login form shows
  if (!session && server === undefined) return null
  if (!session) return <LoginPage />
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<MinionsPage />} />
        <Route path="minions/:id" element={<MinionDetailPage />} />
        <Route path="compliance" element={<CompliancePage />} />
        <Route path="patches" element={<PatchesPage />} />
        {session.mode !== 'live' && <Route path="vulnerabilities" element={<VulnerabilitiesPage />} />}
        <Route path="keys" element={<KeysPage />} />
        <Route path="run" element={<RunPage />} />
        <Route path="orchestrate" element={<OrchestratePage />} />
        <Route path="jobs" element={<JobsSwitch />} />
        <Route path="jobs/:jid" element={<JobDetailPage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="events" element={<EventsPage />} />
        {session.mode === 'server' && session.eauth === 'admin' && <Route path="users" element={<UsersPage />} />}
        {session.mode === 'server' && session.eauth === 'admin' && <Route path="schedules" element={<SchedulesPage />} />}
        {session.mode === 'server' && session.eauth === 'admin' && <Route path="notifications" element={<NotificationsPage />} />}
        {session.mode === 'server' && session.eauth === 'admin' && <Route path="system" element={<SystemPage />} />}
        {session.mode === 'server' && (session.eauth === 'admin' || session.eauth === 'operator') && <Route path="audit" element={<AuditPage />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

/** With a server, Jobs shows its long-term history; ?source=master shows the master's cache. */
function JobsSwitch() {
  const { session } = useSession()
  const [params] = useSearchParams()
  return session?.mode === 'server' && params.get('source') !== 'master' ? <JobHistoryPage /> : <JobsPage />
}

export default function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <ToastProvider>
          <Gate />
        </ToastProvider>
      </BrowserRouter>
    </SessionProvider>
  )
}

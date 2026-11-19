import { lazy, useEffect, useRef } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import { Layout } from './components/Layout'
import { ToastProvider } from './components/Toasts'
import { useTheme } from './lib/hooks'
import { SessionProvider, useSession } from './lib/session'
import { LoginPage } from './pages/Login'
import { OverviewPage } from './pages/Overview'

// pages load on first visit, so the first paint only carries the shell, the login and the overview
const CompliancePage = lazy(() => import('./pages/Compliance').then((m) => ({ default: m.CompliancePage })))
const EventsPage = lazy(() => import('./pages/Events').then((m) => ({ default: m.EventsPage })))
const FilesPage = lazy(() => import('./pages/Files').then((m) => ({ default: m.FilesPage })))
const JobDetailPage = lazy(() => import('./pages/JobDetail').then((m) => ({ default: m.JobDetailPage })))
const JobComparePage = lazy(() => import('./pages/JobCompare').then((m) => ({ default: m.JobComparePage })))
const JobHistoryPage = lazy(() => import('./pages/JobHistory').then((m) => ({ default: m.JobHistoryPage })))
const JobsPage = lazy(() => import('./pages/Jobs').then((m) => ({ default: m.JobsPage })))
const KeysPage = lazy(() => import('./pages/Keys').then((m) => ({ default: m.KeysPage })))
const MinionDetailPage = lazy(() => import('./pages/MinionDetail').then((m) => ({ default: m.MinionDetailPage })))
const MinionsPage = lazy(() => import('./pages/Minions').then((m) => ({ default: m.MinionsPage })))
const HardeningPage = lazy(() => import('./pages/Hardening').then((m) => ({ default: m.HardeningPage })))
const SlackLinkPage = lazy(() => import('./pages/SlackLink').then((m) => ({ default: m.SlackLinkPage })))
const MapPage = lazy(() => import('./pages/Map').then((m) => ({ default: m.MapPage })))
const ReportPage = lazy(() => import('./pages/Report').then((m) => ({ default: m.ReportPage })))
const RunbooksPage = lazy(() => import('./pages/Runbooks').then((m) => ({ default: m.RunbooksPage })))
const RunbookRunPage = lazy(() => import('./pages/RunbookRun').then((m) => ({ default: m.RunbookRunPage })))
const BranchPreviewPage = lazy(() => import('./pages/BranchPreview').then((m) => ({ default: m.BranchPreviewPage })))
const TokensPage = lazy(() => import('./pages/Tokens').then((m) => ({ default: m.TokensPage })))
const ComparePage = lazy(() => import('./pages/Compare').then((m) => ({ default: m.ComparePage })))
const ChangeDetailPage = lazy(() => import('./pages/Changes').then((m) => ({ default: m.ChangeDetailPage })))
const ChangesPage = lazy(() => import('./pages/Changes').then((m) => ({ default: m.ChangesPage })))
const OrchestratePage = lazy(() => import('./pages/Orchestrate').then((m) => ({ default: m.OrchestratePage })))
const PatchesPage = lazy(() => import('./pages/Patches').then((m) => ({ default: m.PatchesPage })))
const RunPage = lazy(() => import('./pages/Run').then((m) => ({ default: m.RunPage })))
const QueryPage = lazy(() => import('./pages/Query').then((m) => ({ default: m.QueryPage })))
const AuditPage = lazy(() => import('./pages/Audit').then((m) => ({ default: m.AuditPage })))
const UsersPage = lazy(() => import('./pages/Users').then((m) => ({ default: m.UsersPage })))
const NotificationsPage = lazy(() => import('./pages/Notifications').then((m) => ({ default: m.NotificationsPage })))
const SystemPage = lazy(() => import('./pages/System').then((m) => ({ default: m.SystemPage })))
const SchedulesPage = lazy(() => import('./pages/Schedules').then((m) => ({ default: m.SchedulesPage })))
const VulnerabilitiesPage = lazy(() => import('./pages/Vulnerabilities').then((m) => ({ default: m.VulnerabilitiesPage })))

// the minions list used to be the home page; its filters in an old link still lead there
const MINION_FILTERS = ['q', 'status', 'facet']

function Home() {
  const [params] = useSearchParams()
  if (MINION_FILTERS.some((k) => params.has(k))) {
    const keep = new URLSearchParams([...params].filter(([k]) => MINION_FILTERS.includes(k)))
    return <Navigate to={`/minions?${keep}`} replace />
  }
  return <OverviewPage />
}

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
        <Route index element={<Home />} />
        <Route path="minions" element={<MinionsPage />} />
        <Route path="minions/compare" element={<ComparePage />} />
        <Route path="minions/:id" element={<MinionDetailPage />} />
        <Route path="compliance" element={<CompliancePage />} />
        <Route path="compliance/preview" element={<BranchPreviewPage />} />
        <Route path="compliance/hardening" element={<HardeningPage />} />
        <Route path="slack/link" element={<SlackLinkPage />} />
        <Route path="map" element={<MapPage />} />
        <Route path="patches" element={<PatchesPage />} />
        {session.mode !== 'live' && <Route path="vulnerabilities" element={<VulnerabilitiesPage />} />}
        <Route path="keys" element={<KeysPage />} />
        <Route path="run" element={<RunPage />} />
        <Route path="query" element={<QueryPage />} />
        {/* changes are run by the server (the demo has its own) */}
        {session.mode !== 'live' && <Route path="changes" element={<ChangesPage />} />}
        {session.mode !== 'live' && <Route path="changes/:id" element={<ChangeDetailPage />} />}
        <Route path="orchestrate" element={<OrchestratePage />} />
        {/* runbooks are kept and run by the server (the demo has its own) */}
        {session.mode !== 'live' && <Route path="runbooks" element={<RunbooksPage />} />}
        {session.mode !== 'live' && <Route path="runbooks/runs/:id" element={<RunbookRunPage />} />}
        <Route path="jobs" element={<JobsSwitch />} />
        <Route path="jobs/compare" element={<JobComparePage />} />
        <Route path="jobs/:jid" element={<JobDetailPage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="events" element={<EventsPage />} />
        {(session.mode === 'demo' || (session.mode === 'server' && session.eauth === 'admin')) && <Route path="users" element={<UsersPage />} />}
        {/* the demo keeps made-up schedules and channels in memory */}
        {(session.mode === 'demo' || (session.mode === 'server' && session.eauth === 'admin')) && <Route path="schedules" element={<SchedulesPage />} />}
        {(session.mode === 'demo' || (session.mode === 'server' && session.eauth === 'admin')) && <Route path="notifications" element={<NotificationsPage />} />}
        {(session.mode === 'demo' || (session.mode === 'server' && session.eauth === 'admin')) && <Route path="system" element={<SystemPage />} />}
        {/* built from the weekly report, which admins see */}
        {(session.mode === 'demo' || (session.mode === 'server' && session.eauth === 'admin')) && <Route path="reports" element={<ReportPage />} />}
        {(session.mode === 'demo' || (session.mode === 'server' && (session.eauth === 'admin' || session.eauth === 'operator'))) && <Route path="audit" element={<AuditPage />} />}
        {session.mode !== 'live' && <Route path="tokens" element={<TokensPage />} />}
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

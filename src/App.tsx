import { useEffect, useRef } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { ToastProvider } from './components/Toasts'
import { useTheme } from './lib/hooks'
import { SessionProvider, useSession } from './lib/session'
import { CompliancePage } from './pages/Compliance'
import { EventsPage } from './pages/Events'
import { FilesPage } from './pages/Files'
import { JobDetailPage } from './pages/JobDetail'
import { JobsPage } from './pages/Jobs'
import { KeysPage } from './pages/Keys'
import { LoginPage } from './pages/Login'
import { MinionDetailPage } from './pages/MinionDetail'
import { MinionsPage } from './pages/Minions'
import { OrchestratePage } from './pages/Orchestrate'
import { PatchesPage } from './pages/Patches'
import { RunPage } from './pages/Run'

function Gate() {
  const { session, login } = useSession()
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
  if (!session) return <LoginPage />
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<MinionsPage />} />
        <Route path="minions/:id" element={<MinionDetailPage />} />
        <Route path="compliance" element={<CompliancePage />} />
        <Route path="patches" element={<PatchesPage />} />
        <Route path="keys" element={<KeysPage />} />
        <Route path="run" element={<RunPage />} />
        <Route path="orchestrate" element={<OrchestratePage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="jobs/:jid" element={<JobDetailPage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
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

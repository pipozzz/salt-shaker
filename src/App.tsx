import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { useTheme } from './lib/hooks'
import { SessionProvider, useSession } from './lib/session'
import { EventsPage } from './pages/Events'
import { FilesPage } from './pages/Files'
import { JobDetailPage } from './pages/JobDetail'
import { JobsPage } from './pages/Jobs'
import { KeysPage } from './pages/Keys'
import { LoginPage } from './pages/Login'
import { MinionDetailPage } from './pages/MinionDetail'
import { MinionsPage } from './pages/Minions'
import { RunPage } from './pages/Run'

function Gate() {
  const { session } = useSession()
  useTheme()
  if (!session) return <LoginPage />
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<MinionsPage />} />
        <Route path="minions/:id" element={<MinionDetailPage />} />
        <Route path="keys" element={<KeysPage />} />
        <Route path="run" element={<RunPage />} />
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
        <Gate />
      </BrowserRouter>
    </SessionProvider>
  )
}

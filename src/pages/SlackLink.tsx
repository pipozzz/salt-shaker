import { Check, MessageSquare } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { slack } from '../api/server'
import { Button, Card, ErrorBox, PageHeader } from '../components/ui'
import { useSession } from '../lib/session'

/** Opened from the link /salt link gives in Slack: the signed-in user confirms the Slack account is theirs. */
export function SlackLinkPage() {
  const { session } = useSession()
  const [params] = useSearchParams()
  const code = params.get('code') ?? ''
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const me = session?.user

  return (
    <>
      <PageHeader title="Link Slack" description="So the /salt command in Slack acts as you." />
      <Card className="max-w-xl p-5">
        {session?.mode !== 'server' ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Slack works with the Salt Shaker server only.</p>
        ) : done ? (
          <p className="flex items-center gap-2 text-sm">
            <Check className="size-4 text-green-600" /> Linked: @{done} now acts as <span className="font-medium">{me}</span> in Slack. See it under{' '}
            <Link to="/tokens" className="text-accent-700 underline underline-offset-2 dark:text-accent-400">
              API tokens
            </Link>
            .
          </p>
        ) : (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Commands from this Slack account will run as <span className="font-medium text-zinc-900 dark:text-zinc-100">{me}</span>, with your role and limits, and appear in the audit log under
              your name. Link it only if you asked for this link in Slack yourself.
            </p>
            {error && (
              <div className="mt-3">
                <ErrorBox error={error} />
              </div>
            )}
            <Button
              className="mt-4"
              variant="primary"
              icon={<MessageSquare className="size-4" />}
              loading={busy}
              disabled={!code}
              onClick={async () => {
                setBusy(true)
                setError(null)
                try {
                  setDone((await slack.link(code)).slackName)
                } catch (e) {
                  setError(e as Error)
                } finally {
                  setBusy(false)
                }
              }}
            >
              Link my Slack account
            </Button>
          </>
        )}
      </Card>
    </>
  )
}

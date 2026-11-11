import { MessageSquare, Unlink } from 'lucide-react'
import { useState } from 'react'
import { slack } from '../api/server'
import { relTime } from '../lib/format'
import { useAsync } from '../lib/hooks'
import { Button, Card, CardHeader, ErrorBox } from './ui'

/** The Slack accounts that act as you in /salt commands, when the server has Slack set up. */
export function SlackLinks() {
  const [reloads, setReloads] = useState(0)
  const list = useAsync(() => slack.links(), [reloads])
  const [error, setError] = useState<Error | null>(null)
  if (!list.data?.enabled) return null
  const links = list.data.links
  return (
    <Card className="mt-6">
      <CardHeader
        title="Slack"
        subtitle="The /salt command in Slack acts as you too. Run /salt link in Slack and open the link it gives you here to connect your account."
        actions={
          links.length > 0 ? (
            <Button
              size="sm"
              icon={<Unlink className="size-3.5" />}
              onClick={async () => {
                setError(null)
                try {
                  await slack.unlink()
                  setReloads((n) => n + 1)
                } catch (e) {
                  setError(e as Error)
                }
              }}
            >
              Unlink
            </Button>
          ) : undefined
        }
      />
      <div className="p-4 text-sm">
        {error && <ErrorBox error={error} />}
        {links.length === 0 ? (
          <p className="text-zinc-500 dark:text-zinc-400">No Slack account is linked.</p>
        ) : (
          <ul className="space-y-1">
            {links.map((l) => (
              <li key={`${l.team}/${l.slackUser}`} className="flex items-center gap-2">
                <MessageSquare className="size-4 text-zinc-500" />
                <span className="font-medium">@{l.slackName ?? l.slackUser}</span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">linked {relTime(new Date(l.linkedAt))}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

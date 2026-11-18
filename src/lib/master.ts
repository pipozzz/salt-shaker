/**
 * The master's address for minions, guessed from salt-api's URL: usually the same host. Not when salt-api
 * is reached on this machine's loopback (Salt Shaker running on the master), which minions can't use.
 */
export function masterHostFrom(url: string | null | undefined, base?: string): string | null {
  if (!url) return null
  let host: string
  try {
    host = new URL(url, base).hostname
  } catch {
    return null
  }
  host = host.replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1' || /^127\./.test(host)) return null
  return host
}

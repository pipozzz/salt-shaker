import type { ReactNode } from 'react'

/** Minimal highlighter for SLS files: YAML keys, comments, Jinja tags, salt:// URLs. */
export function CodeView({ code }: { code: string }) {
  const lines = code.replace(/\n$/, '').split('\n')
  return (
    <div className="overflow-x-auto font-mono text-[12.5px] leading-6">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
              <td className="w-10 pr-4 text-right align-top text-zinc-400 select-none dark:text-zinc-600">{i + 1}</td>
              <td className="pr-4 whitespace-pre">{highlight(line)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function highlight(line: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\{[{%#].*?[%}#]\})|(#.*$)|(salt:\/\/\S+)|^(\s*-?\s*)([\w./'"*:@-]+?)(:)(?=\s|$)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index))
    if (m[1]) out.push(<span key={k++} className="text-amber-600 dark:text-amber-400">{m[1]}</span>)
    else if (m[2]) out.push(<span key={k++} className="text-zinc-400 italic">{m[2]}</span>)
    else if (m[3]) out.push(<span key={k++} className="text-emerald-600 dark:text-emerald-400">{m[3]}</span>)
    else {
      out.push(m[4])
      out.push(<span key={k++} className="text-sky-700 dark:text-sky-400">{m[5]}</span>)
      out.push(m[6])
    }
    last = re.lastIndex
    if (m[0] === '') re.lastIndex++
  }
  if (last < line.length) out.push(line.slice(last))
  return out
}

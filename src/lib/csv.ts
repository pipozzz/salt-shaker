/** One CSV cell: quoted when it could break the row, with leading formula characters defused for spreadsheets. */
export function csvCell(v: unknown) {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v)
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** Rows to CSV text with CRLF line endings, as spreadsheets expect. */
export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'

import { describe, expect, it } from 'vitest'
import { checkQuery, osqueryCall, parseOsquery } from './osquery'

describe('checkQuery', () => {
  it.each([
    ['SELECT * FROM users;', null],
    ['  with x as (select 1) select * from x', null],
    ['-- who\nSELECT * FROM users', null],
    ['', 'Write a query'],
    ['DELETE FROM users', 'Only SELECT queries can run here'],
    ['ATTACH DATABASE "/tmp/x" AS x', 'Only SELECT queries can run here'],
    ['SELECT 1; SELECT 2', 'One query at a time'],
  ])('%j', (sql, want) => expect(checkQuery(sql)).toBe(want))
})

it('sends the query on stdin, ending with one semicolon', () => {
  expect(osqueryCall('SELECT 1  ')).toEqual({ arg: ['osqueryi --json'], kwarg: { stdin: 'SELECT 1;', python_shell: false, timeout: 120 } })
  expect(osqueryCall('SELECT 1;\n').kwarg.stdin).toBe('SELECT 1;')
})

describe('parseOsquery', () => {
  it('reads the JSON rows, as strings', () => {
    expect(parseOsquery('[\n  {"name":"Debian GNU/Linux","version":"13 (trixie)","n":3}\n]')).toEqual({ rows: [{ name: 'Debian GNU/Linux', version: '13 (trixie)', n: '3' }] })
    expect(parseOsquery('[\n\n]')).toEqual({ rows: [] })
  })
  it('skips warnings printed before the JSON', () => {
    expect(parseOsquery('W1110 07:00:00.000 database.cpp:42] Could not lock the database\n[{"a":"1"}]')).toEqual({ rows: [{ a: '1' }] })
  })
  it('tells when osquery is missing', () => {
    expect(parseOsquery("ERROR: Unable to run command '['osqueryi', '--json']' with the context '{}', reason: [Errno 2] No such file or directory: 'osqueryi'")).toEqual({ error: 'osquery is not installed', missing: true })
    expect(parseOsquery('/bin/sh: 1: osqueryi: not found')).toMatchObject({ missing: true })
  })
  it('passes on query errors', () => {
    expect(parseOsquery('Error: no such table: nope')).toEqual({ error: 'Error: no such table: nope' })
    expect(parseOsquery(false)).toEqual({ error: 'The minion did not run the query' })
  })
})

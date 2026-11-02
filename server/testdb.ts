import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import type { Config } from './config'
import { openDatabase } from './db'

export type TestDialect = 'sqlite' | 'pg'

/**
 * Dialects the database tests run on: SQLite always, Postgres too when TEST_POSTGRES_URL points at
 * a server where the test user may create databases (CI starts one).
 */
export const testDialects: TestDialect[] = process.env.TEST_POSTGRES_URL ? ['sqlite', 'pg'] : ['sqlite']

/** A fresh database with all migrations applied; Postgres gets a throwaway database, dropped on close. */
export async function openTestDatabase(dialect: TestDialect) {
  if (dialect === 'sqlite') return openDatabase({ databaseUrl: 'file::memory:', dialect: 'sqlite' } as Config)
  const base = new URL(process.env.TEST_POSTGRES_URL!)
  const name = `salt_shaker_test_${randomBytes(4).toString('hex')}`
  const admin = postgres(base.href, { max: 1, onnotice: () => undefined })
  await admin.unsafe(`create database ${name}`)
  const url = new URL(base.href)
  url.pathname = `/${name}`
  const opened = await openDatabase({ databaseUrl: url.href, dialect: 'pg' } as Config)
  return {
    ...opened,
    close: async () => {
      await opened.close()
      await admin.unsafe(`drop database if exists ${name}`)
      await admin.end()
    },
  }
}

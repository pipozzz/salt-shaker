import Database from 'better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator'
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import type { Config } from '../config'
import * as pgSchema from './schema.pg'
import * as sqliteSchema from './schema.sqlite'

export type Schema = typeof sqliteSchema

/**
 * One Drizzle handle for either dialect. The query builder API is the same for what this
 * app does (insert / select / where / orderBy / limit), so callers use the SQLite-typed
 * handle and the Postgres one is cast to it.
 */
export type Db = BetterSQLite3Database<Schema>

const MIGRATIONS = fileURLToPath(new URL(process.env.MIGRATIONS_DIR ?? './migrations', import.meta.url))

export async function openDatabase(config: Config) {
  if (config.dialect === 'pg') {
    const client = postgres(config.databaseUrl, { max: 10, onnotice: () => undefined })
    const db = drizzlePg(client, { schema: pgSchema })
    await migratePg(db, { migrationsFolder: `${MIGRATIONS}/pg` })
    return { db: db as unknown as Db, schema: pgSchema as unknown as Schema, provider: 'pg' as const, close: () => client.end() }
  }
  const sqlite = new Database(config.databaseUrl.replace(/^file:/, ''))
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzleSqlite(sqlite, { schema: sqliteSchema })
  migrateSqlite(db, { migrationsFolder: `${MIGRATIONS}/sqlite` })
  return { db, schema: sqliteSchema, provider: 'sqlite' as const, close: async () => sqlite.close() }
}

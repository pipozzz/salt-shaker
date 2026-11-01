import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './server/db/schema.sqlite.ts',
  out: './server/db/migrations/sqlite',
})

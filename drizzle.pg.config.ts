import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema.pg.ts',
  out: './server/db/migrations/pg',
})

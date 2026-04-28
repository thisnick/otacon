import { readFileSync } from 'fs'
import type { Config } from 'drizzle-kit'

// Load .env manually (avoid dotenv import issues with pnpm hoisting)
const envFile = readFileSync(new URL('.env', import.meta.url), 'utf-8')
for (const line of envFile.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/)
  if (match) process.env[match[1].trim()] = match[2].trim()
}

export default {
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config

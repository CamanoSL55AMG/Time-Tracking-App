import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { Prisma } from '@prisma/client'
import { assertConfig, config } from './config.js'
import { prisma } from './db.js'
import { ApiError } from './errors.js'
import { authenticate, rateLimit } from './auth/middleware.js'
import { authRouter } from './routes/auth.js'
import { peopleRouter } from './routes/people.js'
import { jobsRouter } from './routes/jobs.js'
import { punchesRouter } from './routes/punches.js'
import { systemRouter } from './routes/system.js'
import { assignmentsRouter } from './routes/assignments.js'

assertConfig()

const app = express()
app.set('trust proxy', 1) // behind the Cloudflare tunnel / a reverse proxy
app.use(helmet())
app.use(morgan(config.isProduction ? 'combined' : 'dev'))
if (config.corsOrigins.length) {
  app.use(cors({ origin: config.corsOrigins, allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Act-As'] }))
}
app.use(express.json({ limit: '1mb' }))

// ─── API v1 ─────────────────────────────────────────────────────────────────
const v1 = express.Router()
v1.use(authenticate)
v1.use(rateLimit)
v1.use(systemRouter)
v1.use(authRouter)
v1.use(peopleRouter)
v1.use(jobsRouter)
v1.use(punchesRouter)
v1.use(assignmentsRouter)
v1.use((req, _res, next) => next(new ApiError(404, 'not_found', `No such endpoint: ${req.method} ${req.originalUrl}`)))
app.use('/api/v1', v1)
app.use('/api', (req, _res, next) => next(new ApiError(404, 'not_found', `No such endpoint: ${req.method} ${req.originalUrl}. The API lives under /api/v1.`)))

// ─── The app itself (built client), when present ────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.resolve(here, '..', 'public')
if (fs.existsSync(path.join(publicDir, 'index.html'))) {
  app.use(express.static(publicDir))
  app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')))
} else {
  // In development the app is served by Vite, not by this server. Say where it is
  // instead of Express's bare "Cannot GET /".
  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Time Tracking API</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1c2330}code{background:#f2f4f8;padding:1px 5px;border-radius:4px}a{color:#1f6feb}</style></head><body>
<h1>Time Tracking API is running</h1>
<p>This port is the API. The app itself is at <a href="http://localhost:5195">http://localhost:5195</a> while <code>dev-web.cmd</code> is running.</p>
<p>To serve the app from this port instead, run <code>build.bat</code> and restart the server.</p>
<p>API reference: <a href="/api/v1/docs">/api/v1/docs</a></p>
</body></html>`)
  })
}

// ─── Errors ─────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } })
    return
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: { code: 'bad_json', message: 'The request body is not valid JSON.' } })
    return
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: { code: 'duplicate', message: 'That already exists.', details: err.meta } })
      return
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } })
      return
    }
  }
  console.error(err)
  res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on the server.' } })
})

const server = app.listen(config.port, () => {
  console.log(`Time Tracking API on http://localhost:${config.port}  (docs: /api/v1/docs)`)
})

const shutdown = () => {
  server.close(() => {
    prisma.$disconnect().finally(() => process.exit(0))
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

import Job from '../models/Job.js'
import { logger } from '../lib/logger.js'

const handlers = new Map()
const log = logger.child({ module: 'jobs' })

/** Registers the function that runs jobs of `type`. */
export function defineJob(type, handler) {
  handlers.set(type, handler)
}

/**
 * Queues a job. `delayMs` schedules it for later; `uniqueKey` makes it a no-op
 * if an identical job is already waiting (returns null in that case).
 */
export async function enqueue(type, payload = {}, { delayMs = 0, uniqueKey, maxAttempts } = {}) {
  try {
    return await Job.create({
      type,
      payload,
      runAt: new Date(Date.now() + delayMs),
      ...(uniqueKey ? { uniqueKey } : {}),
      ...(maxAttempts ? { maxAttempts } : {}),
    })
  } catch (err) {
    if (err?.code === 11000 && uniqueKey) return null
    throw err
  }
}

/** Claims and runs one due job. Returns true if it ran one. */
export async function runOne() {
  const now = new Date()
  const job = await Job.findOneAndUpdate(
    {
      $or: [
        { status: 'pending', runAt: { $lte: now } },
        // A worker that crashed mid-job leaves it "running" — reclaim after the lock expires.
        { status: 'running', lockedUntil: { $lte: now } },
      ],
    },
    { $set: { status: 'running', lockedUntil: new Date(now.getTime() + 5 * 60_000) }, $inc: { attempts: 1 } },
    { sort: { runAt: 1 }, new: true },
  )
  if (!job) return false

  const handler = handlers.get(job.type)
  try {
    if (!handler) throw new Error(`No handler for job type "${job.type}"`)
    await handler(job.payload, job)
    job.status = 'done'
    job.lastError = undefined
    log.info({ jobId: job.id, type: job.type }, 'job done')
  } catch (err) {
    const giveUp = job.attempts >= job.maxAttempts || !handler
    job.status = giveUp ? 'failed' : 'pending'
    // Exponential backoff: 1m, 2m, 4m, 8m...
    job.runAt = new Date(Date.now() + 60_000 * 2 ** (job.attempts - 1))
    job.lastError = err.message
    log[giveUp ? 'error' : 'warn']({ jobId: job.id, type: job.type, attempt: job.attempts, err: err.message }, giveUp ? 'job failed permanently' : 'job failed, will retry')
  }
  job.lockedUntil = undefined
  await job.save()
  return true
}

/** Drains every due job — used by tests and by the polling loop. */
export async function runDue(limit = 50) {
  let n = 0
  while (n < limit && (await runOne())) n++
  return n
}

let timer
/** Polls for due jobs every `intervalMs`, plus runs `recurring` tasks on their own schedule. */
export function startWorker({ intervalMs = 5_000, recurring = [] } = {}) {
  const tick = async () => {
    try {
      await runDue()
    } catch (err) {
      log.error({ err: err.message }, 'job worker tick failed')
    }
    timer = setTimeout(tick, intervalMs)
  }
  timer = setTimeout(tick, 1_000)

  const intervals = recurring.map(({ type, everyMs }) => {
    // uniqueKey per time window: with several instances, only one schedules it.
    const schedule = () =>
      enqueue(type, {}, { uniqueKey: `recurring:${type}:${Math.floor(Date.now() / everyMs)}`, maxAttempts: 1 }).catch((err) =>
        log.error({ err: err.message, type }, 'could not schedule recurring job'),
      )
    schedule()
    return setInterval(schedule, everyMs)
  })

  return () => {
    clearTimeout(timer)
    intervals.forEach(clearInterval)
  }
}

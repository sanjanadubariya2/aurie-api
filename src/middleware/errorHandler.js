import multer from 'multer'
import { HttpError } from '../lib/HttpError.js'
import { config } from '../config.js'

/** Wraps an async route handler so a rejected promise reaches errorHandler
 *  instead of crashing the process. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

export function notFoundHandler(req, res) {
  res.status(404).json({ message: 'Not found' })
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ message: err.message })
  }

  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be smaller than 5MB.' : err.message
    return res.status(400).json({ message })
  }

  if (err?.name === 'ZodError') {
    const first = err.issues?.[0]
    return res.status(400).json({ message: first?.message || 'Invalid request' })
  }

  if (err?.code === 11000) {
    return res.status(409).json({ message: 'That already exists.' })
  }

  if (err?.name === 'ValidationError') {
    return res.status(400).json({ message: err.message })
  }

  console.error(err)
  res.status(500).json({ message: config.isProd ? 'Something went wrong. Try again.' : err.message })
}

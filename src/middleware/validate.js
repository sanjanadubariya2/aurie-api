/** Parses req.body against a Zod schema, replacing it with the parsed (typed,
 *  stripped-of-extra-keys) result. Never let raw req.body reach Mongoose. */
export const validateBody = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({ message: result.error.issues[0]?.message || 'Invalid request' })
  }
  req.body = result.data
  next()
}

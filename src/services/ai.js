import { config, isAiLive } from '../config.js'
import { HttpError } from '../lib/HttpError.js'
import { logger } from '../lib/logger.js'

/**
 * Google Gemini through its REST API (no SDK — one fetch is all this needs,
 * and it keeps working when the SDK changes shape). Every call:
 *   - runs on the server only; the key never reaches a browser
 *   - asks for JSON and validates it before anything uses it
 *   - times out after 20s
 *   - counts against a daily cap, so a bug or an abusive client cannot run up
 *     the bill (AI_DAILY_CALL_CAP, default 2000/day per instance)
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
const log = logger.child({ module: 'ai' })

let day = ''
let calls = 0
function takeBudget() {
  const today = new Date().toISOString().slice(0, 10)
  if (today !== day) {
    day = today
    calls = 0
  }
  if (calls >= config.ai.dailyCallCap) throw new HttpError(503, 'The assistant is resting for today. Try again tomorrow.')
  calls++
}

export function assertAi() {
  if (!isAiLive) throw new HttpError(503, 'The assistant is not switched on yet.')
}

/**
 * Asks Gemini for a JSON answer.
 * @param {object} o
 * @param {string} o.system   standing instructions
 * @param {string} o.prompt   the request
 * @param {object} [o.schema] OpenAPI-style response schema Gemini must follow
 * @param {{ mimeType: string, data: string }[]} [o.images] base64 images
 * @param {number} [o.temperature]
 */
export async function generateJson({ system, prompt, schema, images = [], temperature = 0.8, model }) {
  assertAi()
  takeBudget()

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [
      {
        role: 'user',
        parts: [...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })), { text: prompt }],
      },
    ],
    generationConfig: {
      temperature,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
      ...(schema ? { responseSchema: schema } : {}),
    },
  }

  const useModel = model || (images.length ? config.ai.visionModel : config.ai.model)
  const started = Date.now()
  let res
  try {
    res = await fetch(`${ENDPOINT}/${encodeURIComponent(useModel)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.ai.geminiApiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    log.warn({ err: err.message, model: useModel }, 'gemini request failed')
    throw new HttpError(503, 'The assistant is not responding right now. Try again in a moment.')
  }

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    log.error({ status: res.status, model: useModel, error: data?.error?.message }, 'gemini error')
    throw new HttpError(503, 'The assistant could not answer that. Try again in a moment.')
  }

  const candidate = data.candidates?.[0]
  if (!candidate || candidate.finishReason === 'SAFETY') {
    throw new HttpError(422, 'The assistant could not help with that request. Try wording it differently.')
  }
  const text = candidate.content?.parts?.map((p) => p.text || '').join('') || ''
  log.info({ model: useModel, ms: Date.now() - started, tokens: data.usageMetadata?.totalTokenCount }, 'gemini ok')

  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(502, 'The assistant replied in a way we could not read. Try again.')
  }
}

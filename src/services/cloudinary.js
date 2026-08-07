import { config, isCloudinaryLive } from '../config.js'
import { HttpError } from '../lib/HttpError.js'

let cloudinaryClient
async function getClient() {
  if (!cloudinaryClient) {
    const { v2 } = await import('cloudinary')
    v2.config({
      cloud_name: config.cloudinary.cloudName,
      api_key: config.cloudinary.apiKey,
      api_secret: config.cloudinary.apiSecret,
    })
    cloudinaryClient = v2
  }
  return cloudinaryClient
}

/** Uploads an image buffer (from multer memory storage — the file never
 *  touches disk). Returns the https URL to store, and the public_id needed
 *  to later replace or delete this exact asset. */
export async function uploadImage(buffer, folder = config.cloudinary.folder) {
  if (!isCloudinaryLive) {
    throw new HttpError(503, 'Image uploads are not configured yet. Set the CLOUDINARY_* env vars.')
  }
  const cloudinary = await getClient()
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder }, (err, res) => (err ? reject(err) : resolve(res)))
    stream.end(buffer)
  })
  return { secure_url: result.secure_url, public_id: result.public_id }
}

/** Deletes a previously-uploaded asset. Never throws — a leaked asset costs a
 *  few KB of storage; a failed save because Cloudinary hiccuped on cleanup
 *  does not. Callers just fire this and move on. */
export async function destroyImage(publicId) {
  if (!publicId || !isCloudinaryLive) return
  try {
    const cloudinary = await getClient()
    await cloudinary.uploader.destroy(publicId)
  } catch (err) {
    console.error(`Failed to delete Cloudinary asset ${publicId}:`, err.message)
  }
}

/**
 * Builds a delivery URL rather than serving the original upload. Most of
 * this shop's traffic is Indian mobile on variable connections — `f_auto`
 * picks WebP/AVIF automatically per browser, `q_auto` compresses without a
 * visible quality hit, and `w_900,c_limit` means a phone never downloads a
 * desktop-sized original just to show it at a few hundred pixels wide. The
 * combination routinely cuts payload by 60-80% versus the raw file, which on
 * a slow connection is the difference between a product card that paints
 * instantly and one a shopper scrolls past before it loads.
 *
 * Plain string templating — Cloudinary's delivery URL scheme is public and
 * needs only the cloud name, not API credentials, so this stays synchronous
 * and doesn't need the SDK loaded.
 */
export function deliveryUrl(publicId, { width = 900 } = {}) {
  if (!publicId || !config.cloudinary.cloudName) return null
  return `https://res.cloudinary.com/${config.cloudinary.cloudName}/image/upload/f_auto,q_auto,w_${width},c_limit/${publicId}`
}

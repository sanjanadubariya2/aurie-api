import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectDb, disconnectDb } from './db.js'
import Product from './models/Product.js'
import { uploadImage } from './services/cloudinary.js'
import { isCloudinaryLive } from './config.js'

// One-off: uploads the original seed images (still living in the frontend's
// public/ folder) to Cloudinary and points each product at the result.
// Safe to re-run — anything with an imagePublicId already is left alone.
// Usage: npm run migrate-images

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// src/migrateImages.js -> aurie-api -> (parent) -> aurie-storefront/public/products
const PRODUCTS_DIR = path.resolve(__dirname, '../../aurie-storefront/public/products')

async function migrate() {
  if (!isCloudinaryLive) {
    console.error('CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET are not set in .env — nothing to migrate to.')
    process.exit(1)
  }

  if (!fs.existsSync(PRODUCTS_DIR)) {
    console.error(`Could not find ${PRODUCTS_DIR} — is aurie-storefront checked out as a sibling of aurie-api?`)
    process.exit(1)
  }

  await connectDb()

  const localPathProducts = await Product.find({ image: { $regex: '^/products/' } })
  const toMigrate = localPathProducts.filter((p) => !p.imagePublicId)
  const skipped = localPathProducts.length - toMigrate.length

  console.log(`${localPathProducts.length} product(s) still on a local image path, ${toMigrate.length} to migrate, ${skipped} already done`)

  let uploaded = 0
  const failed = []

  for (const product of toMigrate) {
    const filename = path.basename(product.image)
    const filePath = path.join(PRODUCTS_DIR, filename)

    if (!fs.existsSync(filePath)) {
      failed.push({ slug: product.slug, reason: `local file not found: ${filePath}` })
      continue
    }

    try {
      const buffer = fs.readFileSync(filePath)
      const { secure_url, public_id } = await uploadImage(buffer)
      product.image = secure_url
      product.imagePublicId = public_id
      await product.save()
      uploaded++
      console.log(`  uploaded ${product.slug} -> ${public_id}`)
    } catch (err) {
      failed.push({ slug: product.slug, reason: err.message })
    }
  }

  console.log('\n--- migration summary ---')
  console.log(`uploaded: ${uploaded}`)
  console.log(`skipped (already migrated): ${skipped}`)
  console.log(`failed: ${failed.length}`)
  failed.forEach((f) => console.log(`  - ${f.slug}: ${f.reason}`))
  console.log('\nLocal files in public/products/ were left untouched.')

  await disconnectDb()
}

migrate().catch((err) => {
  console.error(err)
  process.exit(1)
})

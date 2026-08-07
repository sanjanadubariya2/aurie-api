import { connectDb, disconnectDb } from './db.js'
import Product from './models/Product.js'
import CollectionModel from './models/Collection.js'
import { products, collections } from './data/seedData.js'

async function seed() {
  await connectDb()

  await Promise.all(
    collections.map((c, i) =>
      CollectionModel.findOneAndUpdate(
        { slug: c.id },
        { slug: c.id, name: c.name, tagline: c.tagline, note: c.note, order: i },
        { upsert: true },
      ),
    ),
  )
  console.log(`seeded ${collections.length} collections`)

  // Upsert rather than wipe-and-reinsert. A product that's already been
  // migrated to Cloudinary (or had its image replaced from the admin panel)
  // must not get its image/imagePublicId silently reset to the seed data's
  // dead local /products/*.jpg path on a re-seed — so those two fields are
  // only ever set on first insert, never touched on an update.
  let inserted = 0
  let updated = 0
  for (const p of products) {
    const { id, collection, image, ...rest } = p
    // eslint-disable-next-line no-await-in-loop
    const existing = await Product.findOne({ slug: id })

    if (existing) {
      // eslint-disable-next-line no-await-in-loop
      await Product.updateOne({ slug: id }, { ...rest, collection_: collection })
      updated++
    } else {
      // eslint-disable-next-line no-await-in-loop
      await Product.create({ ...rest, slug: id, collection_: collection, image })
      inserted++
    }
  }
  console.log(`seeded products: ${inserted} inserted, ${updated} updated (existing images left untouched)`)

  await disconnectDb()
}

seed().catch((err) => {
  console.error(err)
  process.exit(1)
})

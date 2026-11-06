import mongoose from 'mongoose'

const tierSchema = new mongoose.Schema(
  {
    id: { type: String, enum: ['single', 'double', 'combo'], required: true },
    label: String,
    qty: Number,
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false },
)

const productSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true }, // "laddoo" — the frontend's `id`
    name: { type: String, required: true },
    collection_: { type: String, required: true, index: true }, // `collection` is reserved in Mongoose
    image: String,
    imagePublicId: String, // Cloudinary public_id for `image` — needed to replace or delete it later
    scent: String,
    burn: String,
    blurb: String,
    badge: String,
    quote: { type: Boolean, default: false }, // priced after a chat, not sold with tiers
    active: { type: Boolean, default: true },
    tiers: [tierSchema],
    // Kept in step with approved reviews (lib/reviews.js), so listings never aggregate.
    rating: { average: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
  },
  { timestamps: true },
)

/** Shapes a document back into exactly what src/data/products.js used to export. */
export function toPublicProduct(doc) {
  const p = doc.toObject ? doc.toObject() : doc
  const out = {
    id: p.slug,
    name: p.name,
    collection: p.collection_,
    image: p.image,
  }
  if (p.scent) out.scent = p.scent
  if (p.burn) out.burn = p.burn
  if (p.blurb) out.blurb = p.blurb
  if (p.badge) out.badge = p.badge
  if (p.quote) out.quote = true
  if (p.tiers?.length) out.tiers = p.tiers.map((t) => ({ id: t.id, label: t.label, qty: t.qty, price: t.price }))
  if (p.rating?.count) out.rating = { average: p.rating.average, count: p.rating.count }
  return out
}

/** Shapes a document for the admin panel — the raw doc, but with `inStock`
 *  mirroring `active` and `collection` mirroring `collection_`, since those
 *  are the field names aurie-admin's UI and edit form actually read. Without
 *  this the collection picker silently resets to blank after every save. */
export function toAdminProduct(doc) {
  const p = doc.toObject ? doc.toObject() : doc
  const { collection_, ...rest } = p
  return { ...rest, collection: collection_, inStock: p.active }
}

export default mongoose.model('Product', productSchema)

import mongoose from 'mongoose'

const collectionSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true }, // "festive" — the frontend's `id`
    name: { type: String, required: true },
    tagline: String,
    note: String,
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
)

export function toPublicCollection(doc) {
  const c = doc.toObject ? doc.toObject() : doc
  return { id: c.slug, name: c.name, tagline: c.tagline, note: c.note }
}

export default mongoose.model('Collection', collectionSchema)

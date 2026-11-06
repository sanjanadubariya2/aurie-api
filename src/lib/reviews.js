import Review from '../models/Review.js'
import Product from '../models/Product.js'

/** Recomputes a product's stored rating from its approved reviews. */
export async function refreshProductRating(slug) {
  const [row] = await Review.aggregate([
    { $match: { product: slug, status: 'approved' } },
    { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
  ])
  await Product.updateOne(
    { slug },
    { $set: { rating: { average: row ? Math.round(row.average * 10) / 10 : 0, count: row?.count || 0 } } },
  )
}

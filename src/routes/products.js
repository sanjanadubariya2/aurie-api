import { Router } from 'express'
import Product, { toPublicProduct } from '../models/Product.js'
import CollectionModel, { toPublicCollection } from '../models/Collection.js'
import { deliveryUrl } from '../services/cloudinary.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import Review, { toPublicReview } from '../models/Review.js'

/**
 * Backend contract
 *   GET /products     -> { products: [...] }   same shape as the frontend's src/data/products.js
 *   GET /collections  -> { collections: [...] }
 */

const router = Router()

router.get(
  '/products',
  asyncHandler(async (req, res) => {
    const products = await Product.find({ active: true }).sort({ createdAt: 1 })
    res.json({
      products: products.map((p) => {
        const pub = toPublicProduct(p)
        // Serve the optimised Cloudinary delivery URL when this product has
        // been migrated; un-migrated products just keep their stored `image`.
        if (p.imagePublicId) pub.image = deliveryUrl(p.imagePublicId) || pub.image
        return pub
      }),
    })
  }),
)

router.get(
  '/collections',
  asyncHandler(async (req, res) => {
    const collections = await CollectionModel.find().sort({ order: 1 })
    res.json({ collections: collections.map(toPublicCollection) })
  }),
)

/** Approved reviews for one product, newest first, with a rating summary. */
router.get(
  '/products/:slug/reviews',
  asyncHandler(async (req, res) => {
    const reviews = await Review.find({ product: req.params.slug, status: 'approved' }).sort({ createdAt: -1 }).limit(50)
    const count = reviews.length
    const average = count ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / count) * 10) / 10 : 0
    res.set('Cache-Control', 'public, max-age=300')
    res.json({ reviews: reviews.map(toPublicReview), summary: { average, count } })
  }),
)

export default router

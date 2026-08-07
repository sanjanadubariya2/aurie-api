/**
 * A snapshot of the frontend's src/data/products.js, kept here so this repo
 * seeds a database without depending on a sibling checkout at build/deploy
 * time. If the frontend catalogue changes, re-sync this file and re-run
 * `npm run seed` — after that, the admin panel is the source of truth.
 */

export const collections = [
  { id: 'festive', name: 'Festive', tagline: 'Mithai you light instead of eat', note: 'Poured for Diwali, Ganpati and wedding trays.' },
  { id: 'bloom', name: 'Bloom', tagline: 'Flowers that never wilt', note: 'Peonies, roses and tulips sculpted in soy wax.' },
  { id: 'brew', name: 'Brew & Glow', tagline: 'Your order, in wax', note: 'Cold brew, chai and iced lattes that burn for hours.' },
  { id: 'tide', name: 'Tide', tagline: 'A shoreline in a glass', note: 'Shells, sand and gel wax set like shallow water.' },
  { id: 'whims', name: 'Whims', tagline: 'Small, silly, sold out fast', note: 'Bubble cubes, bears and desserts under 250.' },
  { id: 'jars', name: 'Jars', tagline: 'Everyday burners', note: 'Reusable glass, 40 to 50 hours of burn time.' },
  { id: 'secret', name: 'Secret Glow', tagline: 'Melt to read the message', note: 'A hidden line surfaces as the wax pool grows.' },
  { id: 'luxe', name: 'Luxe Boxes', tagline: 'Hampers, wrapped and ready', note: 'Built around your budget and occasion.' },
]

const t = (single, double, combo) => {
  const tiers = [{ id: 'single', label: 'Single', qty: 1, price: single }]
  if (double) tiers.push({ id: 'double', label: 'Pair', qty: 2, price: double })
  if (combo) tiers.push({ id: 'combo', label: 'Box of 4', qty: 4, price: combo })
  return tiers
}

export const products = [
  // ---------------------------------------------------------------- festive
  { id: 'laddoo', name: 'Motichoor Laddoo', collection: 'festive', image: '/products/laddoo.jpg', scent: 'Saffron & cardamom', burn: '5 hrs', blurb: 'Pearled like the real thing, down to the edible-looking gold fleck. Sits on a puja thali without anyone noticing until it is lit.', tiers: t(69, 120, 240), badge: 'Bestseller' },
  { id: 'modak', name: 'Modak', collection: 'festive', image: '/products/modak.jpg', scent: 'Coconut & jaggery', burn: '5 hrs', blurb: 'Hand-pleated in pastel wax. Ordered by the dozen through Ganpati week.', tiers: t(69, 120, 240) },
  { id: 'kaju-katli', name: 'Kaju Katli', collection: 'festive', image: '/products/kaju-katli.jpg', scent: 'Cashew & cream', burn: '5 hrs', blurb: 'A diamond of pale wax finished with real vark-style leaf.', tiers: t(69, 120, 240) },
  { id: 'diya-rangoli', name: 'Rangoli Diya', collection: 'festive', image: '/products/diya-rangoli.jpg', scent: 'Unscented', burn: '3 hrs', blurb: 'Floating diyas in eight colours. Buy a dozen, lay a rangoli, light it once.', tiers: t(60) },
  { id: 'lotus-thali', name: 'Lotus Thali', collection: 'festive', image: '/products/lotus-thali.jpg', scent: 'Rose & sandal', burn: '12 hrs', blurb: 'Three lotus blooms set into a gilded plate. The centrepiece for a Diwali table.', tiers: t(300), badge: 'Centrepiece' },
  { id: 'rose-thali', name: 'Rose & Marigold Thali', collection: 'festive', image: '/products/rose-thali.jpg', scent: 'Marigold & musk', burn: '10 hrs', blurb: 'Marigold and rose heads floating on a wide wax pool, ringed with pearls.', tiers: t(250) },

  // ------------------------------------------------------------------ bloom
  { id: 'peony-bloom', name: 'Peony Bloom', collection: 'bloom', image: '/products/peony-bloom.jpg', scent: 'Peony & lychee', burn: '8 hrs', blurb: 'Petal by petal, then dusted by hand. It opens further as the centre melts.', tiers: t(249), badge: 'Bestseller' },
  { id: 'rose-bouquet', name: 'Rose Bouquet Pillar', collection: 'bloom', image: '/products/rose-bouquet.jpg', scent: 'Turkish rose', burn: '14 hrs', blurb: 'A dome of roses over a ribboned stem. Most people keep it unlit on a shelf.', tiers: t(300) },
  { id: 'daisy-bouquet', name: 'Daisy Posy', collection: 'bloom', image: '/products/daisy-bouquet.jpg', scent: 'White tea', burn: '4 hrs', blurb: 'One gerbera wrapped in kraft paper with dried gypsophila. The under-100 gift that does not look it.', tiers: t(60), badge: 'Under ₹100' },
  { id: 'tulip-jar', name: 'Tulip Jar', collection: 'bloom', image: '/products/tulip-jar.jpg', scent: 'Fresh tulip', burn: '30 hrs', blurb: 'A cluster of tulips growing out of a clear jar, in four colourways.', tiers: t(499) },

  // ------------------------------------------------------------- brew & glow
  { id: 'cold-brew', name: 'Cold Brew', collection: 'brew', image: '/products/cold-brew.jpg', scent: 'Roasted coffee', burn: '40 hrs', blurb: 'Wax ice, a milk swirl and a labelled tumbler. Reads as a real cup from across the room.', tiers: t(249), badge: 'Bestseller' },
  { id: 'biscoff-chai', name: 'Biscoff Chai', collection: 'brew', image: '/products/biscoff-chai.jpg', scent: 'Spiced chai & caramel', burn: '30 hrs', blurb: 'Cutting-chai glass with a biscuit resting on the rim.', tiers: t(200) },
  { id: 'latte-trio', name: 'Iced Latte', collection: 'brew', image: '/products/latte-trio.jpg', scent: 'Latte, matcha or strawberry', burn: '35 hrs', blurb: 'Three layered pours — classic, matcha and strawberry. Say which one at checkout.', tiers: t(249) },
  { id: 'champagne-flute', name: 'Champagne Flute', collection: 'brew', image: '/products/champagne-flute.jpg', scent: 'Pear & prosecco', burn: '20 hrs', blurb: 'Gold flake suspended in gel with a foam head that never settles. A New Year and engagement regular.', tiers: t(300) },

  // ------------------------------------------------------------------- tide
  { id: 'shell-shore', name: 'Shell Shore', collection: 'tide', image: '/products/shell-shore.jpg', scent: 'Sea salt & driftwood', burn: '18 hrs', blurb: 'Three wicks under a gel tide, with real sand and shells collected on the shoreline.', tiers: t(399), badge: 'Three wicks' },
  { id: 'starfish-set', name: 'Starfish Set', collection: 'tide', image: '/products/starfish-set.jpg', scent: 'Ocean breeze', burn: '9 hrs', blurb: 'A starfish, a scallop and a clam, glazed in tidepool blue. Sold as a set of three.', tiers: t(300) },
  { id: 'ocean-layer', name: 'Ocean Layer Jar', collection: 'tide', image: '/products/ocean-layer.jpg', scent: 'Coconut & sea salt', burn: '35 hrs', blurb: 'Cream wax below, a shell-strewn blue surface above.', tiers: t(249) },
  { id: 'seabed-gel', name: 'Seabed Gel Jar', collection: 'tide', image: '/products/seabed-gel.jpg', scent: 'Unscented', burn: '25 hrs', blurb: 'Clear gel over blue sand. Lit, the shells cast shadows on the glass.', tiers: t(300) },

  // ------------------------------------------------------------------ whims
  { id: 'bubble-cube', name: 'Bubble Cube', collection: 'whims', image: '/products/bubble-cube.jpg', scent: 'Vanilla', burn: '6 hrs', blurb: 'The one everyone starts with. Eight colours, pick yours at checkout.', tiers: t(59), badge: 'Cheapest' },
  { id: 'teddy-bear', name: 'Teddy Bear', collection: 'whims', image: '/products/teddy-bear.jpg', scent: 'Cotton candy', burn: '10 hrs', blurb: 'Textured fur, sat upright. Goes into most of our gift boxes.', tiers: t(199) },
  { id: 'cupcake', name: 'Cupcake', collection: 'whims', image: '/products/cupcake.jpg', scent: 'Vanilla buttercream', burn: '12 hrs', blurb: 'Piped swirl, chocolate shard and a wax strawberry on top.', tiers: t(249) },
  { id: 'marble-pillar', name: 'Marble Pillar', collection: 'whims', image: '/products/marble-pillar.jpg', scent: 'Fig & amber', burn: '16 hrs', blurb: 'Swirled peach and cream — no two are the same pattern.', tiers: t(200) },

  // ------------------------------------------------------------------- jars
  { id: 'monogram-rose', name: 'Monogram Rose Jar', collection: 'jars', image: '/products/monogram-rose.jpg', scent: 'Red rose', burn: '40 hrs', blurb: 'Initials printed on the glass, petals set on the surface. Our most ordered wedding favour.', tiers: t(199), badge: 'Wedding favour' },
  { id: 'heart-confetti', name: 'Heart Confetti Jar', collection: 'jars', image: '/products/heart-confetti.jpg', scent: 'Strawberry cream', burn: '40 hrs', blurb: 'Wax hearts pressed against the glass under a clean cream pour.', tiers: t(199) },
  { id: 'indigo-marble', name: 'Indigo Marble Jar', collection: 'jars', image: '/products/indigo-marble.jpg', scent: 'Blue lotus', burn: '45 hrs', blurb: 'Ink swirled through cream wax, marbled while it sets.', tiers: t(249) },
  { id: 'blueberry-bliss', name: 'Blueberry Bliss', collection: 'jars', image: '/products/blueberry-bliss.jpg', scent: 'Blueberry & rose', burn: '40 hrs', blurb: 'Frosted wax berries heaped in a cobalt glass.', tiers: t(199) },
  { id: 'sunset-peony', name: 'Sunset Peony Jar', collection: 'jars', image: '/products/sunset-peony.jpg', scent: 'Peony & pink pepper', burn: '45 hrs', blurb: 'A pink gradient pour with a wooden wick that crackles as it burns.', tiers: t(249), badge: 'Wooden wick' },
  { id: 'sunflower-jar', name: 'Sunflower Jar', collection: 'jars', image: '/products/sunflower-jar.jpg', scent: 'Honey & neroli', burn: '40 hrs', blurb: 'A whipped wax field with one sunflower sitting in it.', tiers: t(249) },
  { id: 'raspberry-cups', name: 'Raspberry Cream Cup', collection: 'jars', image: '/products/raspberry-cups.jpg', scent: 'Raspberry & vanilla', burn: '20 hrs', blurb: 'A dessert cup in wax — coulis at the bottom, cream and berries on top.', tiers: t(199) },
  { id: 'bear-ribbon', name: 'Ribbon Bear Jar', collection: 'jars', image: '/products/bear-ribbon.jpg', scent: 'Cashmere & musk', burn: '30 hrs', blurb: 'A ribboned bear sitting in a ribbed glass. Sold in fives for return gifts.', tiers: t(249) },

  // ----------------------------------------------------------- secret glow
  { id: 'love-note', name: 'Love Note Reveal', collection: 'secret', image: '/products/love-note.jpg', scent: 'Rose & vanilla', burn: '35 hrs', blurb: 'Letter beads spell your line across the wax. It surfaces once the pool spreads to the edge.', quote: true, badge: 'Made to order' },
  { id: 'baby-reveal', name: 'Baby Reveal', collection: 'secret', image: '/products/baby-reveal.jpg', scent: 'Baby powder', burn: '35 hrs', blurb: 'Pink or blue hidden under a neutral pour. Nobody knows until the flame gets there.', quote: true },
  { id: 'birthday-reveal', name: 'Birthday Reveal', collection: 'secret', image: '/products/birthday-reveal.jpg', scent: 'Cashmere vanilla', burn: '35 hrs', blurb: 'A greeting set into the surface, with a sprinkle-print label and gift jar.', quote: true },
  { id: 'custom-message', name: 'Your Words', collection: 'secret', image: '/products/custom-message.jpg', scent: 'Your pick', burn: '35 hrs', blurb: 'Up to 24 characters, any colour. Inside jokes welcome — we have poured worse.', quote: true },

  // ------------------------------------------------------------- luxe boxes
  { id: 'gold-gift-box', name: 'Gold Keepsake Box', collection: 'luxe', image: '/products/gold-gift-box.jpg', blurb: 'Rose and pumpkin candles with chocolates in a rigid gold box.', quote: true },
  { id: 'pastel-trinket-box', name: 'Pastel Trinket Box', collection: 'luxe', image: '/products/pastel-trinket-box.jpg', blurb: 'A flower candle, macaron candles and jewellery on shredded paper.', quote: true },
  { id: 'cozy-crate', name: 'Cosy Crate', collection: 'luxe', image: '/products/cozy-crate.jpg', blurb: 'Bubble cubes, a rose pillar and a chocolate coffee jar in a kraft crate.', quote: true },
  { id: 'pink-bear-box', name: 'Pink Bear Box', collection: 'luxe', image: '/products/pink-bear-box.jpg', blurb: 'Bear, heart and bubble cube in one pink palette. A Valentine staple.', quote: true },
  { id: 'personalised-jar-box', name: 'Named Jar Set', collection: 'luxe', image: '/products/personalised-jar-box.jpg', blurb: 'A name-etched jar with a botanical candle and dried petals.', quote: true },
  { id: 'birthday-hamper', name: 'Birthday Hamper', collection: 'luxe', image: '/products/birthday-hamper.jpg', blurb: 'Roses, ribbed pillars and an age-numbered candle, boxed with the date.', quote: true },
  { id: 'bloom-bouquet', name: 'Wax Bouquet', collection: 'luxe', image: '/products/bloom-bouquet.jpg', blurb: 'A full bouquet where every stem is a candle. Wrapped like a florist would.', quote: true, badge: 'Most gifted' },
  { id: 'mini-bouquet', name: 'Mini Bouquet Box', collection: 'luxe', image: '/products/mini-bouquet.jpg', blurb: 'A single rose candle and dried stems in a hat box, ribbon tied.', quote: true },
  { id: 'daisy-basket', name: 'Daisy Basket', collection: 'luxe', image: '/products/daisy-basket.jpg', blurb: 'A cane basket packed with daisy candles under an organza bow.', quote: true },
]

# 🛒 AliExpress Winning Products Scraper

Apify Actor to scrape **winning products** on AliExpress by keyword or category.

Extracts: product details, pricing, variants, photos, ratings, reviews, seller info — ready for dropshipping analysis.

---

## ✨ Features

- 🏆 **Sort by orders** (last 7 days) to surface winning/trending products
- 🔍 **Search by keyword** OR **browse by category URL**
- 💰 **Full product sheet**: title, price, original price, discount %, all variants
- 📸 **All product images** (up to 20 per product)
- ⭐ **Ratings + reviews** with buyer country, photos in reviews
- 🏪 **Seller info**: store name, positive rate, store URL
- 🚚 **Shipping info**: free shipping detection, estimated delivery
- 📐 **Product specs** (dimensions, material, etc.)
- 🔒 **Stealth browsing** with residential proxy support (anti-bot bypass)
- 🔧 **Filters**: min orders, min rating, max products per query

---

## 📥 Input

| Field | Type | Default | Description |
|---|---|---|---|
| `searchQueries` | string[] | `[]` | Keywords to search (e.g. `"wireless earbuds"`) |
| `categoryUrls` | string[] | `[]` | Direct AliExpress category URLs |
| `maxProductsPerQuery` | number | `50` | Products to scrape per query (max 1000) |
| `sortBy` | string | `LAST_SEVEN_DAYS_VOLUME` | Sort: orders / price / rating / newest |
| `scrapeReviews` | boolean | `true` | Fetch product reviews |
| `maxReviewsPerProduct` | number | `20` | Max reviews per product |
| `scrapeVariants` | boolean | `true` | Fetch all color/size variants with prices |
| `minOrders` | number | `100` | Filter: skip products with fewer orders |
| `minRating` | number | `4.0` | Filter: skip products with lower rating |
| `country` | string | `FR` | Target country for prices/shipping |
| `currency` | string | `EUR` | Price currency |
| `proxyConfiguration` | object | Apify Residential | Proxy settings |
| `requestDelay` | number | `1500` | Delay between requests (ms) |

---

## 📤 Output

Each product is stored as a JSON item in the Apify Dataset:

```json
{
  "productId": "1005006789012345",
  "url": "https://www.aliexpress.com/item/1005006789012345.html",
  "title": "Wireless Earbuds Bluetooth 5.3 Hi-Fi Stereo",
  "price": 12.99,
  "maxPrice": 18.99,
  "originalPrice": 24.99,
  "discountPercent": 48,
  "currency": "EUR",
  "rating": 4.7,
  "reviewCount": 1250,
  "orderCount": 8500,
  "images": [
    "https://ae01.alicdn.com/kf/xxx.jpg",
    "https://ae01.alicdn.com/kf/yyy.jpg"
  ],
  "thumbnailUrl": "https://ae01.alicdn.com/kf/xxx.jpg",
  "specs": {
    "Connectivity": "Bluetooth",
    "Battery Life": "30 Hours"
  },
  "variants": [
    {
      "skuId": "12_123456",
      "price": 12.99,
      "originalPrice": 24.99,
      "availability": true,
      "stock": 999,
      "attributes": [
        { "propertyName": "Color", "valueName": "Black", "imageUrl": "..." }
      ]
    }
  ],
  "seller": {
    "storeId": "123456",
    "storeName": "Tech Gadgets Store",
    "storeUrl": "https://www.aliexpress.com/store/123456",
    "positiveRate": "97.8%"
  },
  "shipping": {
    "freeShipping": true,
    "deliveryDays": 12
  },
  "category": null,
  "searchQuery": "wireless earbuds",
  "scrapedAt": "2026-05-01T10:00:00.000Z"
}
```

---

## 🤖 Using with n8n

### Option 1 — Trigger actor and wait for results

Use the **Apify → Run Actor** node with these settings:
- Actor ID: `your-username/aliexpress-winning-products-scraper`
- Wait for finish: ✅
- Input: (your JSON input)

Then use **Apify → Get Dataset Items** with the run's `defaultDatasetId`.

### Option 2 — Webhook (async, recommended for large scrapes)

1. In n8n, create a **Webhook** node to receive results
2. In Apify, set up a **webhook** on actor finish → POST to your n8n webhook URL
3. n8n receives the `defaultDatasetId` and fetches products with HTTP Request node:
   ```
   GET https://api.apify.com/v2/datasets/{datasetId}/items?token={your_token}
   ```

### Option 3 — Schedule with n8n Cron

Add a **Schedule Trigger** → **HTTP Request** node:
```
POST https://api.apify.com/v2/acts/{actorId}/runs?token={your_token}
Body: { "searchQueries": ["winning product niche"], "maxProductsPerQuery": 100 }
```

---

## 🚀 Deploy to Apify

```bash
# Install Apify CLI
npm install -g apify-cli

# Login
apify login

# Push actor to Apify platform
apify push
```

---

## 🛠 Local development

```bash
npm install
npm run start:dev
```

Set `INPUT_SCHEMA.json` values in `storage/key_value_stores/default/INPUT.json` for local testing.

---

## ⚠️ Notes

- **Residential proxy is strongly recommended** — AliExpress aggressively blocks datacenter IPs
- Keep `requestDelay` ≥ 1000ms to avoid rate limiting
- For large scrapes (1000+ products), use `maxConcurrency: 1` and increase delay
- AliExpress may change their page structure; if scraping breaks, open an issue

---

## 📄 License

MIT — Free to use and modify for personal and commercial projects.

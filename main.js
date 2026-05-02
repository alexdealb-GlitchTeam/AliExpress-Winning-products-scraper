/**
 * main.js — AliExpress Winning Products Scraper
 *
 * Apify Actor entry point.
 * Uses Playwright (chromium) with stealth to scrape AliExpress product listings,
 * product details, reviews, images, ratings, and variant info.
 *
 * @author  Glitch Music / Wizaa
 * @version 1.0.0
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, RequestQueue, Configuration } from 'crawlee';
import { handleSearchPage, handleProductPage, handleReviewsApi } from './routes.js';
import { buildSearchUrl, buildCategoryUrl } from './utils.js';

await Actor.init();

// ─── Load & validate input ─────────────────────────────────────────────────
const input = (await Actor.getInput()) || {};

const {
  searchQueries = [],
  categoryUrls = [],
  maxProductsPerQuery = 50,
  sortBy = 'LAST_SEVEN_DAYS_VOLUME',
  scrapeReviews = true,
  maxReviewsPerProduct = 20,
  scrapeVariants = true,
  minOrders = 100,
  minRating = 4.0,
  country = 'FR',
  currency = 'EUR',
  proxyConfiguration,
  requestDelay = 1500,
} = input;

if (searchQueries.length === 0 && categoryUrls.length === 0) {
  // Default: scrape trending/winning products across top categories
  log.warning('No searchQueries or categoryUrls provided — using default trending search queries.');
  searchQueries.push('wireless earbuds', 'led strip', 'phone case', 'smart watch', 'kitchen gadget');
}

log.info('─────────────────────────────────────────────');
log.info('AliExpress Winning Products Scraper');
log.info(`  Queries: ${searchQueries.join(', ') || '(none)'}`);
log.info(`  Categories: ${categoryUrls.length} URL(s)`);
log.info(`  Max per query: ${maxProductsPerQuery}`);
log.info(`  Sort: ${sortBy}`);
log.info(`  Filters: ≥${minOrders} orders | ≥${minRating}★`);
log.info(`  Country: ${country} | Currency: ${currency}`);
log.info('─────────────────────────────────────────────');

// ─── Proxy setup ─────────────────────────────────────────────────────────────
let proxy = null;
if (proxyConfiguration?.useApifyProxy) {
  proxy = await Actor.createProxyConfiguration({
    groups: proxyConfiguration.apifyProxyGroups || ['RESIDENTIAL'],
    countryCode: country,
  });
  log.info('Proxy: Apify Residential enabled');
} else {
  log.warning('Proxy disabled — AliExpress may block datacenter IPs. Residential proxy recommended.');
}

// ─── Build initial request list ───────────────────────────────────────────────
const initialRequests = [];

for (const query of searchQueries) {
  initialRequests.push({
    url: buildSearchUrl({ query, page: 1, sortBy, country, currency }),
    label: 'SEARCH_PAGE',
    userData: {
      query,
      sortBy,
      country,
      currency,
      maxProducts: maxProductsPerQuery,
      scrapeReviews,
      maxReviewsPerProduct,
      scrapeVariants,
      minOrders,
      minRating,
      requestDelay,
      pageNum: 1,
      currentCount: 0,
    },
  });
}

for (const categoryUrl of categoryUrls) {
  initialRequests.push({
    url: buildCategoryUrl({ baseUrl: categoryUrl, page: 1, sortBy, country, currency }),
    label: 'SEARCH_PAGE',
    userData: {
      category: categoryUrl,
      sortBy,
      country,
      currency,
      maxProducts: maxProductsPerQuery,
      scrapeReviews,
      maxReviewsPerProduct,
      scrapeVariants,
      minOrders,
      minRating,
      requestDelay,
      pageNum: 1,
      currentCount: 0,
    },
  });
}

// ─── Playwright Crawler setup ─────────────────────────────────────────────────
const crawler = new PlaywrightCrawler({
  proxyConfiguration: proxy,
  maxConcurrency: 2, // Keep low to avoid AliExpress rate limiting
  requestHandlerTimeoutSecs: 120,
  navigationTimeoutSecs: 90,
  maxRequestRetries: 3,
  retryOnBlocked: true,

  // Shared userData accessible in all handlers
  async requestHandler(context) {
    const { request, page, log: crawlerLog } = context;
    const label = request.label;

    switch (label) {
      case 'SEARCH_PAGE':
        await handleSearchPage({ ...context, crawler, log: crawlerLog });
        break;

      case 'PRODUCT_PAGE':
        await handleProductPage({ ...context, crawler, log: crawlerLog, pushData: Actor.pushData.bind(Actor) });
        break;

      case 'REVIEWS_API':
        // Reviews are fetched as JSON from AliExpress API
        try {
          const response = await page.evaluate(async (url) => {
            const res = await fetch(url, { credentials: 'include' });
            return res.json();
          }, request.url);
          await handleReviewsApi({ request, json: response, log: crawlerLog, pushData: Actor.pushData.bind(Actor) });
        } catch (err) {
          crawlerLog.warning(`[REVIEWS] Failed to fetch reviews for ${request.userData.productId}: ${err.message}`);
        }
        break;

      default:
        crawlerLog.warning(`Unknown label: ${label}`);
    }
  },

  // Browser launch options — stealth settings to bypass bot detection
  launchContext: {
    launchOptions: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--lang=fr-FR',
        `--accept-lang=fr-FR,fr;q=0.9,en;q=0.8`,
      ],
    },
    // Stealth setup: mask automation fingerprints
    useChrome: false,
  },

  // Page setup: inject stealth patches before navigating
  async preNavigationHooks: [
    async ({ page }) => {
      // Remove automation markers
      await page.addInitScript(() => {
        // Override navigator.webdriver
        Object.defineProperty(navigator, 'webdriver', { get: () => false });

        // Override permissions API
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);

        // Override plugins
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });
        Object.defineProperty(navigator, 'languages', {
          get: () => ['fr-FR', 'fr', 'en-US', 'en'],
        });
      });

      // Set realistic headers
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      });

      // Set a realistic viewport
      await page.setViewportSize({ width: 1366, height: 768 });
    },
  ],

  // Error handling
  async failedRequestHandler({ request, error, log: crawlerLog }) {
    crawlerLog.error(`Request failed after retries: ${request.url}\n${error?.message}`);
  },
});

// ─── Run ──────────────────────────────────────────────────────────────────────
await crawler.run(initialRequests);

// ─── Summary ─────────────────────────────────────────────────────────────────
const datasetInfo = await Actor.openDataset();
const stats = await datasetInfo.getInfo();
const itemCount = stats?.itemCount || 0;

log.info('─────────────────────────────────────────────');
log.info(`✅ Scraping complete! ${itemCount} products saved.`);
log.info('─────────────────────────────────────────────');

// Push a run summary as the last item for easy monitoring in n8n
await Actor.pushData({
  _type: 'run_summary',
  totalProducts: itemCount,
  queries: searchQueries,
  categories: categoryUrls,
  filters: { minOrders, minRating, sortBy },
  completedAt: new Date().toISOString(),
});

await Actor.exit();

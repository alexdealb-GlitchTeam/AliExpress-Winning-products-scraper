/**
 * main.js — AliExpress Winning Products Scraper
 *
 * Apify Actor entry point.
 * Uses Playwright (chromium) with stealth to scrape AliExpress product listings,
 * product details, reviews, images, ratings, and variant info.
 *
 * @author  Glitch Music / Wizaa
 * @version 1.1.0
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { handleSearchPage, handleProductPage, handleReviewsApi } from './routes.js';
import { buildSearchUrl, buildCategoryUrl } from './utils.js';

await Actor.init();

// ─── Load & validate input ─────────────────────────────────────────────────
const input = (await Actor.getInput()) || {};

const {
  searchQueries = [],
  categoryUrls = [],
  maxProductsPerQuery = 10,        // ← change 50 en 10
  sortBy = 'LAST_SEVEN_DAYS_VOLUME',
  scrapeReviews = false,           // ← change true en false
  maxReviewsPerProduct = 20,
  scrapeVariants = true,
  minOrders = 0,
  minRating = 0,
  minStock = 30,
  country = 'FR',
  currency = 'EUR',
  proxyConfiguration = { useApifyProxy: false },  // ← change ici
  requestDelay = 1500,
} = input;

if (searchQueries.length === 0 && categoryUrls.length === 0) {
  log.warning('No searchQueries or categoryUrls provided — using default trending search queries.');

  // 🔥 Viral TikTok / Instagram — produits en vogue sur les réseaux
  searchQueries.push(
    'tiktok viral gadget',
    'trending product 2025',
    'aesthetic room decor',
    'led neon sign',
    'portable blender',
    'ice roller face',
    'hair claw clip',
    'mini projector',
    'magnetic phone holder',
    'cozy home gadget',
    'viral kitchen tool',
    'aesthetic water bottle',
    'phone stand aesthetic',
    'ring light mini',
    'skin care tool viral',

    // 💼 Collection LinkedIn — bureau & productivité
    'desk organizer aesthetic',
    'laptop stand portable',
    'wireless charging pad desk',
    'ergonomic mouse pad wrist',
    'cable management desk',
    'mini desk vacuum cleaner',
    'monitor light bar',
    'webcam light ring',
    'sticky notes dispenser',
    'pen holder desk',

    // 💑 Collection Tinder — couples & dates
    'couple matching bracelet',
    'romantic candle set',
    'date night game couple',
    'massage candle romantic',
    'couple photo frame',
    'picnic basket set',
    'star projector bedroom',
    'love letter writing kit',
    'couple jewelry set',
    'wine glass set romantic'
  );
}

log.info('─────────────────────────────────────────────');
log.info('AliExpress Winning Products Scraper v1.1');
log.info(`  Queries     : ${searchQueries.length} requêtes`);
log.info(`  Categories  : ${categoryUrls.length} URL(s)`);
log.info(`  Max/query   : ${maxProductsPerQuery}`);
log.info(`  Sort        : ${sortBy}`);
log.info(`  Filtres     : ≥${minOrders} commandes | ≥${minRating}★ | ≥${minStock} stock`);
log.info(`  Pays/devise : ${country} / ${currency}`);
log.info('─────────────────────────────────────────────');

// ─── Proxy setup ─────────────────────────────────────────────────────────────
let proxy = null;
if (proxyConfiguration?.useApifyProxy) {
  proxy = await Actor.createProxyConfiguration({
    groups: proxyConfiguration.apifyProxyGroups || ['RESIDENTIAL'],
    countryCode: country,
  });
  log.info('Proxy: Apify Residential activé');
} else {
  log.warning('Proxy désactivé — AliExpress bloque les IPs datacenter. Proxy résidentiel recommandé.');
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
      minStock,
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
      minStock,
      requestDelay,
      pageNum: 1,
      currentCount: 0,
    },
  });
}

// ─── Playwright Crawler ───────────────────────────────────────────────────────
const crawler = new PlaywrightCrawler({
  ...(proxy ? { proxyConfiguration: proxy } : {}),
  maxConcurrency: 10,
  requestHandlerTimeoutSecs: 120,
  navigationTimeoutSecs: 90,
  maxRequestRetries: 3,
  retryOnBlocked: true,

  async requestHandler(context) {
    const { request, page, log: crawlerLog } = context;
    const label = request.label;

    switch (label) {
      case 'SEARCH_PAGE':
        await handleSearchPage({ ...context, crawler, log: crawlerLog });
        break;

      case 'PRODUCT_PAGE':
        await handleProductPage({
          ...context,
          crawler,
          log: crawlerLog,
          pushData: Actor.pushData.bind(Actor),
        });
        break;

      case 'REVIEWS_API':
        try {
          const response = await page.evaluate(async (url) => {
            const res = await fetch(url, { credentials: 'include' });
            return res.json();
          }, request.url);
          await handleReviewsApi({
            request,
            json: response,
            log: crawlerLog,
            pushData: Actor.pushData.bind(Actor),
          });
        } catch (err) {
          crawlerLog.warning(`[REVIEWS] Échec pour ${request.userData.productId}: ${err.message}`);
        }
        break;

      default:
        crawlerLog.warning(`Label inconnu: ${label}`);
    }
  },

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
        '--accept-lang=fr-FR,fr;q=0.9,en;q=0.8',
      ],
    },
    useChrome: false,
  },

  preNavigationHooks: [
    async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr', 'en-US', 'en'] });
      });

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

      await page.setViewportSize({ width: 1366, height: 768 });
    },
  ],

  async failedRequestHandler({ request, error, log: crawlerLog }) {
    crawlerLog.error(`Requête échouée: ${request.url}\n${error?.message}`);
  },
});

// ─── Run ──────────────────────────────────────────────────────────────────────
await crawler.run(initialRequests);

// ─── Résumé final ─────────────────────────────────────────────────────────────
const datasetInfo = await Actor.openDataset();
const stats = await datasetInfo.getInfo();
const itemCount = stats?.itemCount || 0;

log.info('─────────────────────────────────────────────');
log.info(`✅ Scraping terminé ! ${itemCount} produits sauvegardés.`);
log.info('─────────────────────────────────────────────');

await Actor.pushData({
  _type: 'run_summary',
  totalProducts: itemCount,
  queries: searchQueries,
  categories: categoryUrls,
  filters: { minOrders, minRating, minStock, sortBy },
  completedAt: new Date().toISOString(),
});

await Actor.exit();
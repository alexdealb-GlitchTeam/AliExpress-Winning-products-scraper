/**
 * routes.js — Crawlee router handlers for AliExpress scraper
 *
 * Labels:
 *  SEARCH_PAGE   → AliExpress search/category listing
 *  PRODUCT_PAGE  → Individual product detail page
 *  REVIEWS_PAGE  → Product reviews API endpoint
 */

import { Dataset, Log } from 'crawlee';
import {
  extractProductId,
  extractPageGlobalData,
  parseOrderCount,
  parsePrice,
  parseRating,
  cleanTitle,
  buildProductUrl,
  buildSearchUrl,
  buildCategoryUrl,
  sleep,
  deepGet,
} from './utils.js';

// In-memory store to avoid duplicate products
const seenProductIds = new Set();

/**
 * Handler for search/category listing pages.
 * Extracts product cards, enqueues next pages + individual product pages.
 */
export async function handleSearchPage({ page, request, crawler, log }) {
  const { query, category, sortBy, country, currency, maxProducts, currentCount = 0, pageNum = 1, minOrders, minRating, requestDelay } = request.userData;

  log.info(`[SEARCH] Scraping page ${pageNum} — query: "${query || category}"`);

  await page.waitForLoadState('domcontentloaded');
  await sleep(requestDelay || 1500);

  // Try to extract listing data from global JS state first (faster + more reliable)
  const globalData = await extractPageGlobalData(page);
  let products = [];

  if (globalData) {
    // Modern AliExpress SPA — product list in various paths depending on page version
    const listPaths = [
      'data.itemList.content',
      'mods.itemList.content',
      'data.mods.itemList.content',
    ];
    for (const path of listPaths) {
      const list = deepGet(globalData, path);
      if (Array.isArray(list) && list.length > 0) {
        products = list;
        break;
      }
    }
  }

  // Fallback: scrape product cards from DOM
  if (products.length === 0) {
    products = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll(
        '[class*="product-card"], [class*="ProductCard"], [class*="item-card"], a[href*="/item/"]'
      ));

      return cards
        .map((el) => {
          const link = el.tagName === 'A' ? el : el.querySelector('a[href*="/item/"]');
          if (!link) return null;

          const priceEl = el.querySelector('[class*="price--current"], [class*="Price--current"], [class*="price_current"]');
          const origPriceEl = el.querySelector('[class*="price--original"], [class*="Price--original"]');
          const titleEl = el.querySelector('[class*="multi--titleText"], [class*="title"], h3');
          const ratingEl = el.querySelector('[class*="star-rating"], [class*="StarRating"], [class*="star_rating"]');
          const ordersEl = el.querySelector('[class*="sold"], [class*="Sold"], [class*="trade"]');
          const imgEl = el.querySelector('img[src*="aliexpress"], img[src*="ae01"], img[lazy-src]');

          return {
            url: link.href || link.getAttribute('href'),
            price: priceEl?.textContent?.trim() || null,
            originalPrice: origPriceEl?.textContent?.trim() || null,
            title: titleEl?.textContent?.trim() || null,
            rating: ratingEl?.getAttribute('aria-label') || ratingEl?.textContent?.trim() || null,
            orders: ordersEl?.textContent?.trim() || null,
            thumbnailUrl: imgEl?.src || imgEl?.getAttribute('lazy-src') || null,
          };
        })
        .filter(Boolean);
    });
  }

  log.info(`[SEARCH] Found ${products.length} products on page ${pageNum}`);

  let enqueuedCount = currentCount;

  for (const product of products) {
    if (enqueuedCount >= maxProducts) break;

    let productId, productUrl;

    // Normalize product data coming from global state vs DOM
    if (product.itemId || product.productId) {
      productId = String(product.itemId || product.productId);
      productUrl = buildProductUrl(productId);
    } else if (product.url) {
      productUrl = product.url.startsWith('http') ? product.url : `https:${product.url}`;
      productId = extractProductId(productUrl);
    }

    if (!productId || seenProductIds.has(productId)) continue;

    // Apply pre-filters on listing data if available
    const orders = parseOrderCount(product.orders || product.tradeDesc || deepGet(product, 'trade.tradeDesc') || '');
    const rating = parseRating(product.averageStar || deepGet(product, 'evaluation.starRating') || product.rating || 0);

    if (minOrders > 0 && orders > 0 && orders < minOrders) {
      log.debug(`[FILTER] Skipping ${productId} — orders ${orders} < ${minOrders}`);
      continue;
    }
    if (minRating > 0 && rating > 0 && rating < minRating) {
      log.debug(`[FILTER] Skipping ${productId} — rating ${rating} < ${minRating}`);
      continue;
    }

    seenProductIds.add(productId);
    enqueuedCount++;

    await crawler.addRequests([{
      url: productUrl,
      label: 'PRODUCT_PAGE',
      userData: {
        productId,
        query,
        category,
        country,
        currency,
        requestDelay,
        // Pass listing-level data as hints (will be overwritten by product page)
        hintTitle: cleanTitle(product.title || deepGet(product, 'title.displayTitle') || ''),
        hintPrice: parsePrice(product.price || deepGet(product, 'prices.salePrice.formattedPrice') || ''),
        hintOrders: orders,
        hintRating: rating,
        hintThumbnail: product.thumbnailUrl || deepGet(product, 'image.imgUrl') || '',
      },
    }]);
  }

  log.info(`[SEARCH] Enqueued ${enqueuedCount - currentCount} products (total: ${enqueuedCount}/${maxProducts})`);

  // Enqueue next page if we haven't hit the limit
  if (enqueuedCount < maxProducts && products.length > 0) {
    const nextPage = pageNum + 1;
    let nextUrl;

    if (query) {
      nextUrl = buildSearchUrl({ query, page: nextPage, sortBy, country, currency });
    } else if (category) {
      nextUrl = buildCategoryUrl({ baseUrl: category, page: nextPage, sortBy, country, currency });
    }

    if (nextUrl) {
      await crawler.addRequests([{
        url: nextUrl,
        label: 'SEARCH_PAGE',
        userData: { ...request.userData, pageNum: nextPage, currentCount: enqueuedCount },
      }]);
    }
  }
}

/**
 * Handler for individual product pages.
 * Extracts full product data: title, price, variants, images, seller, specs.
 */
export async function handleProductPage({ page, request, crawler, log, pushData }) {
  const { productId, query, category, country, currency, requestDelay, scrapeReviews, maxReviewsPerProduct, scrapeVariants, minOrders, minRating } = request.userData;

  log.info(`[PRODUCT] Scraping product ${productId}`);

  await page.waitForLoadState('domcontentloaded');
  await sleep(requestDelay || 1500);

  let productData = {};

  // ─── Method 1: Extract from global JS state (preferred) ───────────────────
  const globalData = await extractPageGlobalData(page);

  if (globalData) {
    const dataRoot =
      deepGet(globalData, 'data') ||
      deepGet(globalData, 'pageConfig') ||
      globalData;

    // Price
    const minPrice = deepGet(dataRoot, 'priceModule.minPrice') ||
      deepGet(dataRoot, 'priceModule.formattedPrice') ||
      deepGet(dataRoot, 'price.minAmount.value');
    const maxPrice = deepGet(dataRoot, 'priceModule.maxPrice');
    const originalPrice = deepGet(dataRoot, 'priceModule.maxActivityAmount.value') ||
      deepGet(dataRoot, 'priceModule.originalPrice');

    // Title & Description
    const title = cleanTitle(
      deepGet(dataRoot, 'titleModule.subject') ||
      deepGet(dataRoot, 'title') || ''
    );

    // Ratings
    const avgRating = parseRating(
      deepGet(dataRoot, 'feedbackModule.trialProductAvgStar') ||
      deepGet(dataRoot, 'feedbackModule.evarageStar') ||
      deepGet(dataRoot, 'evaluation.starRating') || 0
    );
    const reviewCount = parseInt(
      deepGet(dataRoot, 'feedbackModule.totalValidNum') ||
      deepGet(dataRoot, 'feedbackModule.display5StarNum') ||
      deepGet(dataRoot, 'evaluation.totalCount') || 0
    );

    // Orders
    const orderStr = deepGet(dataRoot, 'tradeModule.formatTradeCount') ||
      deepGet(dataRoot, 'tradeModule.tradeCount') || '';
    const orderCount = parseOrderCount(String(orderStr));

    // Store / Seller
    const storeId = deepGet(dataRoot, 'storeModule.storeNum') || deepGet(dataRoot, 'seller.storeId');
    const storeName = deepGet(dataRoot, 'storeModule.storeName') || deepGet(dataRoot, 'seller.storeName');
    const storeUrl = storeId ? `https://www.aliexpress.com/store/${storeId}` : null;
    const sellerRating = deepGet(dataRoot, 'storeModule.positiveRate');

    // Images
    const imageList =
      deepGet(dataRoot, 'imageModule.imagePathList') ||
      deepGet(dataRoot, 'product.images') || [];
    const images = imageList.map((img) => (img.startsWith('http') ? img : `https:${img}`));

    // Description
    const descriptionUrl = deepGet(dataRoot, 'descriptionModule.descriptionUrl') ||
      deepGet(dataRoot, 'description.url');

    // Specs / Properties
    const specs = {};
    const props =
      deepGet(dataRoot, 'specsModule.props') ||
      deepGet(dataRoot, 'productPropComponent.props') || [];
    for (const prop of props) {
      if (prop.attrName && prop.attrValue) {
        specs[prop.attrName] = prop.attrValue;
      }
    }

    // Shipping
    const shippingInfo = {
      freeShipping: deepGet(dataRoot, 'shippingModule.generalFreightInfo.originalLayoutResultList.0.bizData.freightAmount.value') === 0,
      deliveryDays: deepGet(dataRoot, 'shippingModule.generalFreightInfo.originalLayoutResultList.0.bizData.deliveryDayMin'),
    };

    // Variants (SKUs)
    let variants = [];
    if (scrapeVariants) {
      const skuModule = deepGet(dataRoot, 'skuModule') || deepGet(dataRoot, 'sku');
      if (skuModule) {
        const priceList = deepGet(skuModule, 'skuPriceList') || [];
        const propList = deepGet(skuModule, 'productSKUPropertyList') || [];

        variants = priceList.map((sku) => ({
          skuId: sku.skuId,
          skuPropIds: sku.skuPropIds,
          price: deepGet(sku, 'skuVal.skuAmount.value'),
          originalPrice: deepGet(sku, 'skuVal.skuActivityAmount.value'),
          availability: deepGet(sku, 'skuVal.availQuantity') > 0,
          stock: deepGet(sku, 'skuVal.availQuantity'),
        }));

        // Build variant labels (color/size names)
        const propMap = {};
        for (const prop of propList) {
          for (const val of (prop.skuPropertyValues || [])) {
            propMap[val.propertyValueId] = {
              propertyName: prop.skuPropertyName,
              valueName: val.propertyValueDisplayName || val.skuPropertyValueName,
              imageUrl: val.skuPropertyImagePath ? `https:${val.skuPropertyImagePath}` : null,
            };
          }
        }

        variants = variants.map((v) => {
          const ids = String(v.skuPropIds || '').split(',');
          const attrs = ids.map((id) => propMap[id]).filter(Boolean);
          return { ...v, attributes: attrs };
        });
      }
    }

    productData = {
      productId,
      url: buildProductUrl(productId),
      title,
      price: parsePrice(String(minPrice || request.userData.hintPrice || '')),
      maxPrice: parsePrice(String(maxPrice || '')),
      originalPrice: parsePrice(String(originalPrice || '')),
      discountPercent: originalPrice && minPrice
        ? Math.round((1 - minPrice / originalPrice) * 100)
        : null,
      currency,
      rating: avgRating || request.userData.hintRating,
      reviewCount,
      orderCount: orderCount || request.userData.hintOrders,
      images: images.length > 0 ? images : (request.userData.hintThumbnail ? [request.userData.hintThumbnail] : []),
      thumbnailUrl: images[0] || request.userData.hintThumbnail || null,
      specs,
      variants,
      seller: {
        storeId,
        storeName,
        storeUrl,
        positiveRate: sellerRating,
      },
      shipping: shippingInfo,
      descriptionUrl,
      category: category || null,
      searchQuery: query || null,
      scrapedAt: new Date().toISOString(),
    };
  }

  // ─── Method 2: DOM fallback if global data was incomplete ─────────────────
  if (!productData.title) {
    const domData = await page.evaluate(() => {
      const title = document.querySelector('h1[class*="product-title"], h1[class*="ProductTitle"], .product-title-text')?.textContent?.trim();
      const price = document.querySelector('[class*="product-price-current"], [class*="uniform-banner-box-price"], [class*="es--wrap"]')?.textContent?.trim();
      const rating = document.querySelector('[class*="overview-rating-average"], [class*="star-view"]')?.textContent?.trim();
      const orders = document.querySelector('[class*="sold"], [class*="Sold"]')?.textContent?.trim();
      const images = Array.from(document.querySelectorAll('[class*="slider--img"] img, [class*="product-image"] img'))
        .map((el) => el.src || el.getAttribute('lazy-src'))
        .filter(Boolean)
        .slice(0, 20);

      return { title, price, rating, orders, images };
    });

    productData = {
      ...productData,
      productId,
      url: buildProductUrl(productId),
      title: cleanTitle(domData.title || request.userData.hintTitle || ''),
      price: parsePrice(domData.price) || request.userData.hintPrice,
      rating: parseRating(domData.rating) || request.userData.hintRating,
      orderCount: parseOrderCount(domData.orders) || request.userData.hintOrders,
      images: domData.images.length > 0 ? domData.images : (request.userData.hintThumbnail ? [request.userData.hintThumbnail] : []),
      thumbnailUrl: domData.images[0] || request.userData.hintThumbnail || null,
      currency,
      category: category || null,
      searchQuery: query || null,
      scrapedAt: new Date().toISOString(),
    };
  }

  // ─── Apply post-scrape filters ─────────────────────────────────────────────
  if (minOrders > 0 && productData.orderCount > 0 && productData.orderCount < minOrders) {
    log.info(`[FILTER] Skipping ${productId} — orders ${productData.orderCount} < ${minOrders}`);
    return;
  }
  if (minRating > 0 && productData.rating > 0 && productData.rating < minRating) {
    log.info(`[FILTER] Skipping ${productId} — rating ${productData.rating} < ${minRating}`);
    return;
  }

  // ─── Scrape reviews ────────────────────────────────────────────────────────
  if (scrapeReviews && productData.reviewCount > 0) {
    await crawler.addRequests([{
      url: `https://www.aliexpress.com/store/feedback/eva/getEvaluation.do?productId=${productId}&memberType=seller&i18n=true&page=1&pageSize=${Math.min(maxReviewsPerProduct, 20)}`,
      label: 'REVIEWS_API',
      userData: {
        productId,
        maxReviewsPerProduct,
        requestDelay,
        accumulatedReviews: [],
        reviewPage: 1,
      },
    }]);
  }

  await pushData(productData);
  log.info(`[PRODUCT] Saved: "${productData.title}" — ⭐ ${productData.rating} | 📦 ${productData.orderCount} orders | 💰 ${productData.price} ${currency}`);
}

/**
 * Handler for AliExpress reviews API endpoint.
 * Fetches reviews page by page and saves them into the product's dataset entry.
 */
export async function handleReviewsApi({ request, json, log, pushData }) {
  const { productId, maxReviewsPerProduct, accumulatedReviews, reviewPage, requestDelay } = request.userData;

  log.info(`[REVIEWS] Fetching reviews page ${reviewPage} for product ${productId}`);

  const reviews = [];
  const data = json?.data || json;

  if (data?.evaViewList) {
    for (const r of data.evaViewList) {
      reviews.push({
        reviewId: r.id || r.reviewId,
        rating: r.starRating || r.star,
        content: r.buyerFeedback || r.content || '',
        date: r.date || r.createDate,
        country: r.countryName || r.buyerCountry || null,
        helpful: r.likesCount || 0,
        hasMedia: (r.images?.length > 0) || r.hasMedia || false,
        images: (r.images || []).map((img) => (img.startsWith('http') ? img : `https:${img}`)),
        buyerInfo: {
          name: r.buyerName || null,
          avatar: r.buyerPortrait || null,
        },
      });
    }
  }

  const allReviews = [...accumulatedReviews, ...reviews];

  // Stop if we hit the max or there are no more
  const hasMore = data?.totalPage > reviewPage;
  if (allReviews.length < maxReviewsPerProduct && hasMore) {
    // Enqueue next reviews page
    const nextUrl = request.url.replace(/page=\d+/, `page=${reviewPage + 1}`);
    // Note: reviews are saved via a separate KV entry, linked to product
  }

  // Save reviews as a separate entry linked by productId
  if (reviews.length > 0) {
    await pushData({
      _type: 'reviews',
      productId,
      reviews: allReviews.slice(0, maxReviewsPerProduct),
      totalReviews: data?.totalCount || allReviews.length,
      scrapedAt: new Date().toISOString(),
    });
    log.info(`[REVIEWS] Saved ${allReviews.length} reviews for product ${productId}`);
  }
}

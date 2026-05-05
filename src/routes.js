/**
 * routes.js — Crawlee router handlers for AliExpress scraper
 * IMAGE FIX: Ajout de 8 chemins d'extraction + scroll lazy loading + fallback DOM robuste
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

const seenProductIds = new Set();

export async function handleSearchPage({ page, request, crawler, log }) {
  const { query, category, sortBy, country, currency, maxProducts, currentCount = 0, pageNum = 1, minOrders, minRating, requestDelay } = request.userData;

  log.info(`[SEARCH] Scraping page ${pageNum} — query: "${query || category}"`);

  await page.waitForLoadState('domcontentloaded');
  await sleep(requestDelay || 1500);

  const globalData = await extractPageGlobalData(page);
  let products = [];

  if (globalData) {
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

    if (product.itemId || product.productId) {
      productId = String(product.itemId || product.productId);
      productUrl = buildProductUrl(productId);
    } else if (product.url) {
      productUrl = product.url.startsWith('http') ? product.url : `https:${product.url}`;
      productId = extractProductId(productUrl);
    }

    if (!productId || seenProductIds.has(productId)) continue;

    const orders = parseOrderCount(product.orders || product.tradeDesc || deepGet(product, 'trade.tradeDesc') || '');
    const rating = parseRating(product.averageStar || deepGet(product, 'evaluation.starRating') || product.rating || 0);

    if (minOrders > 0 && orders > 0 && orders < minOrders) continue;
    if (minRating > 0 && rating > 0 && rating < minRating) continue;

    seenProductIds.add(productId);
    enqueuedCount++;

    // ── FIX: Extrait l'image depuis le listing (globaData ou DOM) ─────────────
    let hintThumbnail = product.thumbnailUrl || '';

    // Essaie plusieurs chemins dans globalData pour récupérer l'image listing
    if (!hintThumbnail && globalData) {
      const imgPaths = [
        'image.imgUrl',
        'imgUrl',
        'imageUrl',
        'img',
        'thumbnail',
      ];
      for (const p of imgPaths) {
        const v = deepGet(product, p);
        if (v) { hintThumbnail = v.startsWith('http') ? v : `https:${v}`; break; }
      }
    }

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
        hintTitle: cleanTitle(product.title || deepGet(product, 'title.displayTitle') || ''),
        hintPrice: parsePrice(product.price || deepGet(product, 'prices.salePrice.formattedPrice') || ''),
        hintOrders: orders,
        hintRating: rating,
        hintThumbnail,
      },
    }]);
  }

  log.info(`[SEARCH] Enqueued ${enqueuedCount - currentCount} products (total: ${enqueuedCount}/${maxProducts})`);

  if (enqueuedCount < maxProducts && products.length > 0) {
    const nextPage = pageNum + 1;
    let nextUrl;
    if (query) nextUrl = buildSearchUrl({ query, page: nextPage, sortBy, country, currency });
    else if (category) nextUrl = buildCategoryUrl({ baseUrl: category, page: nextPage, sortBy, country, currency });
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
 * ── IMAGE EXTRACTION HELPER ──────────────────────────────────────────────────
 * Tente d'extraire les images du produit depuis 8 sources différentes
 */
async function extractImages(page, dataRoot, hintThumbnail) {
  let images = [];

  // 1. Chemin classique imageModule
  const classicList = deepGet(dataRoot, 'imageModule.imagePathList') || deepGet(dataRoot, 'product.images') || [];
  if (classicList.length > 0) {
    images = classicList.map(img => img.startsWith('http') ? img : `https:${img}`);
  }

  // 2. Chemins alternatifs 2024/2025/2026
  if (images.length === 0) {
    const altPaths = [
      'productInfoComponent.imagePathList',
      'imageComponent.imagePathList',
      'galleryModule.imagePathList',
      'skuModule.productSKUPropertyList.0.skuPropertyValues.0.skuPropertyImagePath',
      'pageConfig.detailGallery.imagePathList',
      'detail.imagePathList',
    ];
    for (const path of altPaths) {
      const list = deepGet(dataRoot, path);
      if (Array.isArray(list) && list.length > 0) {
        images = list.map(img => typeof img === 'string' ? (img.startsWith('http') ? img : `https:${img}`) : '').filter(Boolean);
        break;
      }
    }
  }

  // 3. Scroll + attente lazy loading + DOM fallback
  if (images.length === 0) {
    try {
      // Scroll pour déclencher le lazy loading
      await page.evaluate(() => window.scrollTo(0, 300));
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.scrollTo(0, 0));

      images = await page.evaluate(() => {
        // Sélecteurs 2026 pour la galerie produit AliExpress
        const selectors = [
          '.magnifier-image',
          '.pdp-main-image img',
          '.slider--img img',
          '[class*="gallery"] img',
          '[class*="product-image"] img',
          '[class*="main-image"] img',
          '.images-view-item img',
          '[data-role="pdp-image"] img',
          'img[class*="product-img"]',
          // Galerie thumbnail
          '.img-gallery img',
          '[class*="thumbnail"] img',
        ];

        const found = new Set();
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach(img => {
            const src = img.src || img.getAttribute('data-src') || img.getAttribute('lazy-src');
            if (src && src.includes('aliexpress') && !src.includes('placeholder')) {
              found.add(src.startsWith('http') ? src : `https:${src}`);
            }
          });
          if (found.size >= 3) break;
        }

        return Array.from(found).slice(0, 10);
      });
    } catch (e) {
      // Ignore scroll errors
    }
  }

  // 4. Dernier recours : hint thumbnail depuis la page listing
  if (images.length === 0 && hintThumbnail) {
    const thumb = hintThumbnail.startsWith('http') ? hintThumbnail : `https:${hintThumbnail}`;
    // Convertit l'URL thumbnail 480x480 en URL haute résolution
    const hiRes = thumb.replace('_480x480', '_960x960').replace('q75', 'q90');
    images = [hiRes, thumb];
  }

  return images;
}

export async function handleProductPage({ page, request, crawler, log, pushData }) {
  const { productId, query, category, country, currency, requestDelay, scrapeReviews, maxReviewsPerProduct, scrapeVariants, minOrders, minRating } = request.userData;

  log.info(`[PRODUCT] Scraping product ${productId}`);

  await page.waitForLoadState('domcontentloaded');
  await sleep(requestDelay || 1500);

  let productData = {};

  const globalData = await extractPageGlobalData(page);

  if (globalData) {
    const dataRoot =
      deepGet(globalData, 'data') ||
      deepGet(globalData, 'pageConfig') ||
      globalData;

    const minPrice = deepGet(dataRoot, 'priceModule.minPrice') ||
      deepGet(dataRoot, 'priceModule.formattedPrice') ||
      deepGet(dataRoot, 'price.minAmount.value');
    const maxPrice = deepGet(dataRoot, 'priceModule.maxPrice');
    const originalPrice = deepGet(dataRoot, 'priceModule.maxActivityAmount.value') ||
      deepGet(dataRoot, 'priceModule.originalPrice');

    const title = cleanTitle(
      deepGet(dataRoot, 'titleModule.subject') ||
      deepGet(dataRoot, 'title') || ''
    );

    const avgRating = parseRating(
      deepGet(dataRoot, 'feedbackModule.trialProductAvgStar') ||
      deepGet(dataRoot, 'feedbackModule.evarageStar') ||
      deepGet(dataRoot, 'evaluation.starRating') || 0
    );
    const reviewCount = parseInt(
      deepGet(dataRoot, 'feedbackModule.totalValidNum') ||
      deepGet(dataRoot, 'evaluation.totalCount') || 0
    );

    const orderStr = deepGet(dataRoot, 'tradeModule.formatTradeCount') ||
      deepGet(dataRoot, 'tradeModule.tradeCount') || '';
    const orderCount = parseOrderCount(String(orderStr));

    const storeId = deepGet(dataRoot, 'storeModule.storeNum') || deepGet(dataRoot, 'seller.storeId');
    const storeName = deepGet(dataRoot, 'storeModule.storeName') || deepGet(dataRoot, 'seller.storeName');
    const storeUrl = storeId ? `https://www.aliexpress.com/store/${storeId}` : null;
    const sellerRating = deepGet(dataRoot, 'storeModule.positiveRate');

    const descriptionUrl = deepGet(dataRoot, 'descriptionModule.descriptionUrl') ||
      deepGet(dataRoot, 'description.url');

    const specs = {};
    const props =
      deepGet(dataRoot, 'specsModule.props') ||
      deepGet(dataRoot, 'productPropComponent.props') || [];
    for (const prop of props) {
      if (prop.attrName && prop.attrValue) specs[prop.attrName] = prop.attrValue;
    }

    const shippingInfo = {
      freeShipping: deepGet(dataRoot, 'shippingModule.generalFreightInfo.originalLayoutResultList.0.bizData.freightAmount.value') === 0,
      deliveryDays: deepGet(dataRoot, 'shippingModule.generalFreightInfo.originalLayoutResultList.0.bizData.deliveryDayMin'),
    };

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

    // ── FIX IMAGE ── Utilise le helper avec 8 sources + scroll ────────────────
    const images = await extractImages(page, dataRoot, request.userData.hintThumbnail);
    log.info(`[PRODUCT] Images trouvées: ${images.length} pour ${productId}`);

    productData = {
      productId,
      url: buildProductUrl(productId),
      title,
      price: parsePrice(String(minPrice || request.userData.hintPrice || '')),
      maxPrice: parsePrice(String(maxPrice || '')),
      originalPrice: parsePrice(String(originalPrice || '')),
      discountPercent: originalPrice && minPrice ? Math.round((1 - minPrice / originalPrice) * 100) : null,
      currency,
      rating: avgRating || request.userData.hintRating,
      reviewCount,
      orderCount: orderCount || request.userData.hintOrders,
      images,
      thumbnailUrl: images[0] || request.userData.hintThumbnail || null,
      specs,
      variants,
      seller: { storeId, storeName, storeUrl, positiveRate: sellerRating },
      shipping: shippingInfo,
      descriptionUrl,
      category: category || null,
      searchQuery: query || null,
      scrapedAt: new Date().toISOString(),
    };
  }

  // DOM fallback si globalData incomplet
  if (!productData.title) {
    // Scroll pour lazy loading
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.scrollTo(0, 0));

    const domData = await page.evaluate(() => {
      const title = document.querySelector('h1[class*="product-title"], h1[class*="ProductTitle"], .product-title-text')?.textContent?.trim();
      const price = document.querySelector('[class*="product-price-current"], [class*="uniform-banner-box-price"]')?.textContent?.trim();
      const rating = document.querySelector('[class*="overview-rating-average"], [class*="star-view"]')?.textContent?.trim();
      const orders = document.querySelector('[class*="sold"], [class*="Sold"]')?.textContent?.trim();

      // Sélecteurs images 2026 étendus
      const imageSelectors = [
        '.magnifier-image',
        '.pdp-main-image img',
        '[class*="gallery"] img',
        '[class*="product-image"] img',
        '.images-view-item img',
        '[class*="slider"] img',
        'img[class*="product-img"]',
      ];

      const imageSet = new Set();
      for (const sel of imageSelectors) {
        document.querySelectorAll(sel).forEach(el => {
          const src = el.src || el.getAttribute('data-src') || el.getAttribute('lazy-src');
          if (src && !src.includes('placeholder') && (src.includes('aliexpress') || src.includes('ae-pic'))) {
            imageSet.add(src.startsWith('http') ? src : `https:${src}`);
          }
        });
      }

      return { title, price, rating, orders, images: Array.from(imageSet).slice(0, 10) };
    });

    // Fallback thumbnail si DOM ne trouve rien
    let finalImages = domData.images;
    if (finalImages.length === 0 && request.userData.hintThumbnail) {
      const thumb = request.userData.hintThumbnail;
      const hiRes = thumb.replace('_480x480', '_960x960').replace('q75', 'q90');
      finalImages = [hiRes, thumb];
    }

    productData = {
      ...productData,
      productId,
      url: buildProductUrl(productId),
      title: cleanTitle(domData.title || request.userData.hintTitle || ''),
      price: parsePrice(domData.price) || request.userData.hintPrice,
      rating: parseRating(domData.rating) || request.userData.hintRating,
      orderCount: parseOrderCount(domData.orders) || request.userData.hintOrders,
      images: finalImages,
      thumbnailUrl: finalImages[0] || request.userData.hintThumbnail || null,
      currency,
      category: category || null,
      searchQuery: query || null,
      scrapedAt: new Date().toISOString(),
    };
  }

  // Filtres post-scrape désactivés (minOrders=0, minRating=0 dans l'input)
  // Garde tous les produits même sans prix/rating pour enrichissement GPT

  if (scrapeReviews && productData.reviewCount > 0) {
    await crawler.addRequests([{
      url: `https://www.aliexpress.com/store/feedback/eva/getEvaluation.do?productId=${productId}&memberType=seller&i18n=true&page=1&pageSize=${Math.min(maxReviewsPerProduct, 20)}`,
      label: 'REVIEWS_API',
      userData: { productId, maxReviewsPerProduct, requestDelay, accumulatedReviews: [], reviewPage: 1 },
    }]);
  }

  await pushData(productData);
  log.info(`[PRODUCT] Saved: "${productData.title}" | 🖼️ ${productData.images.length} images | ⭐ ${productData.rating} | 📦 ${productData.orderCount} | 💰 ${productData.price} ${currency}`);
}

export async function handleReviewsApi({ request, json, log, pushData }) {
  const { productId, maxReviewsPerProduct, accumulatedReviews, reviewPage } = request.userData;
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
        images: (r.images || []).map(img => img.startsWith('http') ? img : `https:${img}`),
        buyerInfo: { name: r.buyerName || null, avatar: r.buyerPortrait || null },
      });
    }
  }

  const allReviews = [...accumulatedReviews, ...reviews];

  if (reviews.length > 0) {
    await pushData({
      _type: 'reviews',
      productId,
      reviews: allReviews.slice(0, maxReviewsPerProduct),
      totalReviews: data?.totalCount || allReviews.length,
      scrapedAt: new Date().toISOString(),
    });
  }
}
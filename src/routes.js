/**
 * routes.js — AliExpress Winning Products Scraper (Optimisé pour n8n)
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
    const listPaths = ['data.itemList.content', 'mods.itemList.content', 'data.mods.itemList.content'];
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
      const cards = Array.from(document.querySelectorAll('[class*="product-card"], [class*="ProductCard"], [class*="item-card"], a[href*="/item/"]'));
      return cards.map((el) => {
        const link = el.tagName === 'A' ? el : el.querySelector('a[href*="/item/"]');
        if (!link) return null;
        const priceEl = el.querySelector('[class*="price--current"], [class*="Price--current"]');
        const titleEl = el.querySelector('[class*="multi--titleText"], [class*="title"], h3');
        const imgEl = el.querySelector('img[src*="aliexpress"], img[src*="ae01"], img[lazy-src]');
        return {
          url: link.href || link.getAttribute('href'),
          price: priceEl?.textContent?.trim() || null,
          title: titleEl?.textContent?.trim() || null,
          thumbnailUrl: imgEl?.src || imgEl?.getAttribute('lazy-src') || null,
        };
      }).filter(Boolean);
    });
  }

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

    seenProductIds.add(productId);
    enqueuedCount++;

    await crawler.addRequests([{
      url: productUrl,
      label: 'PRODUCT_PAGE',
      userData: { ...request.userData, productId, hintTitle: product.title, hintThumbnail: product.thumbnailUrl },
    }]);
  }

  if (enqueuedCount < maxProducts && products.length > 0) {
    const nextPage = pageNum + 1;
    const nextUrl = query ? buildSearchUrl({ query, page: nextPage, sortBy, country, currency }) : buildCategoryUrl({ baseUrl: category, page: nextPage, sortBy, country, currency });
    if (nextUrl) {
      await crawler.addRequests([{ url: nextUrl, label: 'SEARCH_PAGE', userData: { ...request.userData, pageNum: nextPage, currentCount: enqueuedCount } }]);
    }
  }
}

export async function handleProductPage({ page, request, crawler, log, pushData }) {
  const { productId, query, category, country, currency, requestDelay, scrapeReviews, maxReviewsPerProduct, scrapeVariants, minOrders, minRating } = request.userData;

  log.info(`[PRODUCT] Scraping product ${productId}`);
  await page.waitForLoadState('domcontentloaded');
  await sleep(requestDelay || 1500);

  let productData = {};
  const globalData = await extractPageGlobalData(page);

  if (globalData) {
    const dataRoot = deepGet(globalData, 'data') || deepGet(globalData, 'pageConfig') || globalData;
    const minPrice = deepGet(dataRoot, 'priceModule.minPrice') || deepGet(dataRoot, 'price.minAmount.value');
    const title = cleanTitle(deepGet(dataRoot, 'titleModule.subject') || deepGet(dataRoot, 'title') || '');
    const avgRating = parseRating(deepGet(dataRoot, 'feedbackModule.trialProductAvgStar') || 0);
    const orderCount = parseOrderCount(String(deepGet(dataRoot, 'tradeModule.formatTradeCount') || ''));
    const imageList = deepGet(dataRoot, 'imageModule.imagePathList') || deepGet(dataRoot, 'product.images') || [];
    
    productData = {
      productId,
      url: buildProductUrl(productId),
      title,
      price: parsePrice(String(minPrice || '')),
      rating: avgRating,
      orderCount,
      images: imageList.map(img => img.startsWith('http') ? img : `https:${img}`),
      scrapedAt: new Date().toISOString(),
    };
  }

  // Fallback DOM si le JS global échoue
  if (!productData.title) {
    const domData = await page.evaluate(() => {
      const title = document.querySelector('h1')?.textContent?.trim();
      const images = Array.from(document.querySelectorAll('.slider--img img, .product-image img')).map(el => el.src).filter(Boolean);
      return { title, images };
    });
    productData.title = domData.title || request.userData.hintTitle;
    productData.images = domData.images.length > 0 ? domData.images : [request.userData.hintThumbnail];
  }

  // --- MAPPING CRITIQUE POUR n8n ---
  // On récupère la première image et on la nettoie pour n8n
  let finalImage = productData.images && productData.images.length > 0 ? productData.images[0] : request.userData.hintThumbnail;

  if (finalImage) {
    if (finalImage.startsWith('//')) finalImage = 'https:' + finalImage;
    // On retire les suffixes qui compressent l'image pour avoir la HD
    finalImage = finalImage.split('_.webp')[0].split('.jpg_')[0];
  }

  // On crée les champs exacts que ton n8n attend
  productData.aliexpress_image = finalImage;
  productData.aliexpress_url = productData.url;

  // Filtres post-scrape
  if (minOrders > 0 && productData.orderCount < minOrders) return;
  
  await pushData(productData);
  log.info(`[PRODUCT] Saved: "${productData.title}" avec image HD: ${productData.aliexpress_image}`);
}

export async function handleReviewsApi({ request, json, log, pushData }) {
  // Garde ton code de reviews tel quel si tu en as besoin
}
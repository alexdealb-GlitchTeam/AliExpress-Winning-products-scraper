/**
 * utils.js — Helper functions for AliExpress scraper
 */

/**
 * Parses order count from strings like "1.2k+ sold", "500+ sold", "10000 sold"
 */
export function parseOrderCount(str) {
  if (!str) return 0;
  const clean = str.toLowerCase().replace(/[^0-9.k+]/g, '');
  if (clean.includes('k')) {
    return Math.round(parseFloat(clean) * 1000);
  }
  return parseInt(clean) || 0;
}

/**
 * Parses price string "€ 12,99" or "12.99" → float
 */
export function parsePrice(str) {
  if (!str) return null;
  const match = str.replace(',', '.').match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

/**
 * Builds an AliExpress search URL with sort + country params
 */
export function buildSearchUrl({ query, page = 1, sortBy = 'LAST_SEVEN_DAYS_VOLUME', country = 'FR', currency = 'EUR' }) {
  const params = new URLSearchParams({
    SearchText: query,
    sortType: sortBy,
    page,
    shipCountry: country.toLowerCase(),
    currency,
    origin: 'y',
    isrefine: 'y',
  });
  return `https://www.aliexpress.com/wholesale?${params.toString()}`;
}

/**
 * Builds a category listing URL with page + sort
 */
export function buildCategoryUrl({ baseUrl, page = 1, sortBy = 'LAST_SEVEN_DAYS_VOLUME', country = 'FR', currency = 'EUR' }) {
  const url = new URL(baseUrl);
  url.searchParams.set('SortType', sortBy);
  url.searchParams.set('page', page);
  url.searchParams.set('shipCountry', country.toLowerCase());
  url.searchParams.set('currency', currency);
  return url.toString();
}

/**
 * Extract product ID from AliExpress product URL
 */
export function extractProductId(url) {
  const match = url.match(/\/item\/(\d+)\.html/);
  return match ? match[1] : null;
}

/**
 * Parse window.__GLOBAL_DATA__ or window.runParams from page context
 * AliExpress embeds all product data as a JS global variable
 */
export async function extractPageGlobalData(page) {
  return page.evaluate(() => {
    // Try multiple known data injection points used by AliExpress
    const candidates = [
      window.__GLOBAL_DATA__,
      window.runParams,
      window._dida_config_,
      window.PAGE_VARIABLES,
    ];
    for (const c of candidates) {
      if (c && typeof c === 'object') return c;
    }
    // Fallback: try to parse from a script tag
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const s of scripts) {
      const text = s.textContent || '';
      const m = text.match(/window\.__GLOBAL_DATA__\s*=\s*(\{.+?\});?\s*(?:window|$)/s);
      if (m) {
        try { return JSON.parse(m[1]); } catch {}
      }
      const m2 = text.match(/window\.runParams\s*=\s*(\{.+?\});?\s*(?:var|window|$)/s);
      if (m2) {
        try { return JSON.parse(m2[1]); } catch {}
      }
    }
    return null;
  });
}

/**
 * Random sleep to mimic human browsing
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Cleans up a title string
 */
export function cleanTitle(str) {
  if (!str) return '';
  return str.replace(/\s+/g, ' ').trim();
}

/**
 * Extracts numeric rating from strings like "4.8 out of 5" or "4.8"
 */
export function parseRating(str) {
  if (!str && typeof str !== 'number') return null;
  if (typeof str === 'number') return str;
  const match = String(str).match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

/**
 * Builds product URL from productId
 */
export function buildProductUrl(productId) {
  return `https://www.aliexpress.com/item/${productId}.html`;
}

/**
 * Deep-gets a nested value from an object using a dot-path string
 * e.g. deepGet(obj, 'data.product.price.minPrice')
 */
export function deepGet(obj, path) {
  return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : null), obj);
}

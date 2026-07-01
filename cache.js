// Cache simples em memória para endpoints estáticos
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

const getCache = (key) => {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
};

const setCache = (key, data) => {
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL });
};

const clearCache = () => {
  cache.clear();
};

module.exports = { getCache, setCache, clearCache };

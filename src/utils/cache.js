const cache = new Map();
const TTL_PADRAO = 5 * 60 * 1000; // 5 minutos

function get(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function set(key, data, ttl = TTL_PADRAO) {
  cache.set(key, { data, expiry: Date.now() + ttl });
}

function del(key) {
  cache.delete(key);
}

module.exports = { get, set, del };

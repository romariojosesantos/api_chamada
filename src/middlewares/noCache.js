// Impede o navegador de guardar respostas GET em cache (o Safari do iPhone
// mostrava dados antigos da chamada).
function noCache(req, res, next) {
  if (req.method === 'GET') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
}

module.exports = noCache;

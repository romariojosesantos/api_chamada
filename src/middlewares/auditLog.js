// Uma linha de log por requisição (ajuda a rastrear chamadas feitas pelo celular).
function auditLog(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(
    `[AUDIT] ${new Date().toISOString()} - ${req.method} ${req.originalUrl} - IP: ${ip} - UA: ${req.headers['user-agent']}`,
  );
  next();
}

module.exports = auditLog;

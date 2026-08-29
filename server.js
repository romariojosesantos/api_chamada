// Reexporta o app real (ver _server.js). Existe separado por compatibilidade —
// alguma ferramenta/script pode esperar um "server.js" na raiz — mas toda a
// lógica do servidor vive em _server.js.
const app = require('./_server');

module.exports = app;

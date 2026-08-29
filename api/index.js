// Entry point da função serverless da Vercel — vercel.json faz o rewrite de
// "/(.*)" pra cá, então toda rota da API passa por aqui. A lógica real está em
// _server.js; este arquivo só existe porque a Vercel exige um arquivo dentro de
// api/ para criar a function.
const app = require('../_server');

module.exports = app;

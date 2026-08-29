// Reexporta o app real (ver _server.js). Existe separado por compatibilidade —
// alguma ferramenta/script pode esperar um "server.js" na raiz — mas toda a
// lógica do servidor vive em _server.js.
//
// O `require('express')` abaixo não é usado diretamente aqui, mas não remova: o
// build da Vercel varre os arquivos por um import literal de 'express' pra
// detectar o entrypoint da function, e sem essa linha o deploy falha ("No
// entrypoint found which imports express") mesmo com o app funcionando localmente
// (ver api/index.js, que é o entrypoint real configurado no vercel.json).
const express = require('express');
const app = require('./_server');

module.exports = app;

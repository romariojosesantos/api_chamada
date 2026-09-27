// Entry point da função serverless da Vercel: vercel.json manda toda rota para
// cá. A aplicação é montada em src/app.js.
//
// O `require('express')` abaixo NÃO é usado diretamente neste arquivo, mas NÃO
// PODE ser removido: o build da Vercel detecta o entrypoint da função varrendo
// os arquivos por um import literal de 'express' (erro visto ao remover:
// "No entrypoint found which imports express"). Sem essa linha, o deploy falha
// no build mesmo com tudo funcionando localmente.
// eslint-disable-next-line no-unused-vars -- import literal exigido pelo build da Vercel (ver acima)
const express = require('express');
const app = require('../src/app');

module.exports = app;

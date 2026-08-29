// Entry point da função serverless da Vercel — vercel.json faz o rewrite de
// "/(.*)" pra cá, então toda rota da API passa por aqui. A lógica real está em
// _server.js; este arquivo só existe porque a Vercel exige um arquivo dentro de
// api/ para criar a function.
//
// O `require('express')` abaixo NÃO é usado diretamente neste arquivo, mas NÃO
// PODE ser removido: o build da Vercel detecta o entrypoint da função varrendo
// os arquivos por um import literal de 'express' (erro visto ao remover:
// "No entrypoint found which imports express"). Sem essa linha, o deploy falha
// no build mesmo com tudo funcionando localmente.
const express = require('express');
const app = require('../_server');

module.exports = app;

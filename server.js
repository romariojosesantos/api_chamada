// Sobe a API localmente (`npm start`). Na Vercel quem responde é api/index.js.
//
// O require('express') abaixo não é usado aqui, mas não remova: o build da
// Vercel procura um import literal de 'express' para detectar o entrypoint e
// falha sem ele ("No entrypoint found which imports express").
// eslint-disable-next-line no-unused-vars
const express = require('express');
const app = require('./src/app');

const PORT = process.env.PORT || 3001;

if (require.main === module) {
  // 0.0.0.0: acessível por outros aparelhos da mesma rede (pelo IP local).
  app.listen(PORT, '0.0.0.0', (err) => {
    // No Express 5 a falha ao abrir a porta (ex.: já em uso) chega aqui.
    if (err) {
      console.error(`Não foi possível iniciar na porta ${PORT}: ${err.message}`);
      process.exit(1);
    }
    console.log(`Servidor rodando na porta ${PORT}.`);
  });
}

module.exports = app;

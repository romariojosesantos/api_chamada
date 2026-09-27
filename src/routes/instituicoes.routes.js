const express = require('express');
const controller = require('../controllers/instituicoes.controller');

// Montado ANTES do middleware de x-institution-id (usuário ainda não escolheu instituição).
const globalRouter = express.Router();
globalRouter.get('/todas', controller.listarTodas);

// Montado DEPOIS do middleware de x-institution-id (usa req.id_instituicao).
const tenantRouter = express.Router();
tenantRouter.get('/', controller.detalhe);

module.exports = { globalRouter, tenantRouter };

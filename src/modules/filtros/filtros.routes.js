const express = require('express');
const controller = require('./filtros.controller');

// Dropdowns de filtro; montado DEPOIS do middleware de x-institution-id.
const router = express.Router();
router.get('/transportes', controller.transportes);
router.get('/professores', controller.professores);

module.exports = router;

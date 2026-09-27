// Presença (chamada) — regras em presenca.service.js.
const express = require('express');
const controller = require('./presenca.controller');
const { validate } = require('../../middlewares/validate');
const { presencaSchema } = require('./presenca.schema');
const { exigirRecurso } = require('../../middlewares/permissao');

const router = express.Router();

router.get('/', controller.listar);
router.post('/', exigirRecurso('/', 'editar'), validate(presencaSchema), controller.salvarChamada);
router.post('/adicao-manual', exigirRecurso('/', 'criar'), controller.adicaoManual);
router.get('/adicoes-manuais', controller.adicoesManuais);
router.post('/finalizar', exigirRecurso('/', 'editar'), controller.finalizar);
router.post(
  '/finalizar-dia',
  exigirRecurso('/relatorio-diario', 'editar'),
  controller.finalizarDia,
);
router.get('/pendencias-mes', controller.pendenciasMes);

module.exports = router;

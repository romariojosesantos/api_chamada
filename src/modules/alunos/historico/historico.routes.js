// Ficha do aluno para o master (qualquer instituição) — ver historico.service.js.
// masterMiddleware fica em cada rota (e não em router.use) para que caminhos
// que não existem aqui continuem seguindo para os próximos roteadores.
const express = require('express');
const controller = require('./historico.controller');
const { masterMiddleware } = require('../../../middlewares/auth');

const router = express.Router();

// Literais antes de '/:id'.
router.get('/buscar', masterMiddleware, controller.buscar);
router.put('/matricula/:id', masterMiddleware, controller.atualizarMatricula);
router.post('/matricula', masterMiddleware, controller.criarMatricula);
router.delete('/matricula/:id', masterMiddleware, controller.excluirMatricula);
router.post('/matricula/:id/reabrir', masterMiddleware, controller.reabrirMatricula);
router.put('/contato/:id', masterMiddleware, controller.atualizarContato);
router.post('/contato', masterMiddleware, controller.criarContato);
router.delete('/contato/:id', masterMiddleware, controller.excluirContato);
router.get('/:id', masterMiddleware, controller.ficha);
router.put('/:id', masterMiddleware, controller.atualizarAluno);

module.exports = router;

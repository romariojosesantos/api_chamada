// Turmas (atividades) — regras em atividades.service.js.
const express = require('express');
const controller = require('./atividades.controller');
const { exigirRecurso } = require('../../middlewares/permissao');

const exigir = (recurso) => exigirRecurso('/turmas', recurso);

const router = express.Router();

router.get('/', controller.listar);
router.post('/', exigir('criar'), controller.criar);
router.put('/:id', exigir('editar'), controller.atualizar);
router.post('/:id/professores', exigir('editar'), controller.adicionarCoProfessor);
router.delete('/:id/professores/:idprofessor', exigir('editar'), controller.removerCoProfessor);
router.post('/:id/encerrar', exigir('editar'), controller.encerrar);
router.post('/:id/reabrir', exigir('editar'), controller.reabrir);
router.get('/:id/alunos-historico', controller.historicoDeAlunos);
router.delete('/:id', exigir('excluir'), controller.excluir);

module.exports = router;

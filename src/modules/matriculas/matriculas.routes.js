const express = require('express');
const controller = require('./matriculas.controller');
const { exigirRecurso } = require('../../../permissoes-middleware');

const router = express.Router();

router.get('/por-instituicao', controller.listar);
router.get('/aluno/:id', controller.doAluno);
router.get('/historico-periodo', controller.historico);
router.post('/', exigirRecurso('/ajuste-grade', 'editar'), controller.salvarAjusteGrade);
router.get('/duplicidades', controller.duplicidades);
router.post('/duplicidades/resolver', controller.resolverDuplicidade);
// /matricular e DELETE são usados por Turmas, Gerenciar Matrículas e Grade;
// a permissão de "/turmas" é a dona (ver permissoes-middleware.js).
router.post('/matricular', exigirRecurso('/turmas', 'editar'), controller.matricular);
router.post('/mover', exigirRecurso('/grade-turmas', 'editar'), controller.mover);
router.delete('/:id', exigirRecurso('/turmas', 'editar'), controller.cancelar);

module.exports = router;

// Ponto dos educadores — regras e contexto em pontos.service.js.
const express = require('express');
const controller = require('./pontos.controller');
const { exigirRecurso } = require('../../middlewares/permissao');

const exigir = (recurso) => exigirRecurso('/pontos', recurso);

const router = express.Router();

// Educador (conta vinculada a um professor), sempre no dia de hoje.
router.get('/turmas', controller.turmasDeHoje);
router.get('/meu-historico', controller.meuHistorico);
router.post('/bater', exigir('criar'), controller.baterEntrada);
router.post('/saida', exigir('editar'), controller.registrarSaida);
router.post('/bater-interno', exigir('criar'), controller.baterEntradaInterna);
router.post('/saida-interno', exigir('editar'), controller.registrarSaidaInterna);

// Coordenação (master, coordenador geral ou da área).
router.get('/', controller.listar);
router.get('/educadores', controller.educadores);
router.get('/relatorio-pdf', exigir('exportar'), controller.relatorioPdf);
router.put('/:id', exigir('editar'), controller.corrigir);
router.delete('/:id', exigir('excluir'), controller.excluir);

module.exports = router;

// Relatórios de presença do dashboard (somente leitura). Um aluno só é
// "esperado" num dia se tiver matrícula para aquele dia da semana e o dia não
// for dia sem aula.
const express = require('express');
const controller = require('./relatorios.controller');

const router = express.Router();

router.get('/estatisticas-diarias', controller.estatisticasDiarias);
router.get('/ativos-sem-matricula', controller.ativosSemMatricula);
router.get('/matriculas-por-area', controller.matriculasPorArea);
router.get('/alunos-por-status', controller.alunosPorStatus);
router.get('/estatisticas-periodo', controller.estatisticasPeriodo);
router.get('/estatisticas-mensais', controller.estatisticasMensais);
router.get('/historico-geral', controller.historicoGeral);

module.exports = router;

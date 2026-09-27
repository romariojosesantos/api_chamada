// Todas as rotas da API, montadas em /api em três grupos. A ORDEM importa:
// cada grupo só recebe os middlewares declarados antes dele.
//
//   1. Públicas       — sem login.
//   2. Globais        — com login, sem instituição (master/multi-instituição, aluno).
//   3. Da instituição — com login e header x-institution-id (req.id_instituicao).
//
// Rota nova de dado de uma instituição vai no grupo 3.
// (require sempre com caminho literal: a Vercel só empacota o que acha assim.)
const express = require('express');
const { authMiddleware } = require('../middlewares/auth');
const tenantMiddleware = require('../middlewares/tenant');
const instituicoes = require('../modules/instituicoes/instituicoes.routes');

const router = express.Router();

// 1. Públicas
router.use('/auth', require('../modules/auth/auth.routes'));
// Chamados pelo cron da Vercel; protegidos por CRON_SECRET, não por login.
router.use('/cron/lembrete-chamada', require('../jobs/lembrete-chamada'));
router.use('/cron/saude-banco', require('../jobs/saude-banco'));

// 2. Globais (login, sem instituição)
// master consulta alunos de qualquer instituição
router.use('/historico-aluno', authMiddleware, require('../../historico-aluno'));
// login e perfil master checados dentro dos próprios roteadores
router.use('/permissoes', require('../../permissoes'));
router.use('/perfis-customizados', require('../../perfis-customizados'));
router.use('/areas', require('../../areas-config')); // nomes das áreas valem para o sistema todo
router.use(
  '/estatisticas-comparativas',
  authMiddleware,
  require('../../estatisticas-comparativas'),
);
router.use('/db-health', authMiddleware, require('../modules/sistema/db-health.routes'));
// Telas do aluno: o token de aluno já traz a instituição.
router.use('/aluno', authMiddleware, require('../../aluno-gamificacao'));
router.use('/aluno', authMiddleware, require('../../aluno-carater'));
// Antes de escolher a instituição: o seletor e a data do servidor.
router.use('/instituicoes', authMiddleware, instituicoes.globalRouter);
router.use('/hoje', authMiddleware, require('../modules/hoje/hoje.routes'));

// 3. Da instituição
router.use(authMiddleware, tenantMiddleware);
router.use('/instituicao', instituicoes.tenantRouter);
router.use('/', require('../modules/filtros/filtros.routes')); // /transportes e /professores
router.use('/alunos', require('../modules/alunos/alunos.routes'));
router.use('/presenca', require('../../presenca'));
router.use('/relatorios', require('../modules/relatorios/relatorios.routes'));
router.use('/grade', require('../../grade'));
router.use('/matriculas', require('../modules/matriculas/matriculas.routes'));
router.use('/atividades', require('../../atividades'));
router.use('/professores-admin', require('../../professores'));
router.use('/listas', require('../../listas'));
router.use('/termos', require('../../termos'));
router.use('/devolucoes', require('../../devolucoes'));
router.use('/pontos-embarque', require('../../pontos-embarque'));
router.use('/contatos-emergencia', require('../../contatos-emergencia').router);
router.use('/dias-sem-aula', require('../../dias-sem-aula'));
router.use('/agenda-eventos', require('../../agenda-eventos'));
router.use('/justificativas-falta', require('../../justificativas-falta'));
router.use('/notas', require('../../notas'));
router.use('/pontos', require('../../pontos'));
router.use('/tipos-ponto-interno', require('../../tiposPontoInterno'));
router.use('/notificacoes', require('../../notificacoes'));
router.use('/carater', require('../../carater'));
router.use('/foguinhos', require('../../foguinhos'));
router.use('/ocorrencias', require('../../ocorrencias'));

module.exports = router;

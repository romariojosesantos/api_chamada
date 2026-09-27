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
router.use(
  '/historico-aluno',
  authMiddleware,
  require('../modules/alunos/historico/historico.routes'),
);
// login e perfil master checados dentro dos próprios roteadores
router.use('/permissoes', require('../modules/permissoes/permissoes.routes'));
router.use('/perfis-customizados', require('../modules/permissoes/perfis-customizados.routes'));
router.use('/areas', require('../modules/areas/areas.routes')); // nomes das áreas valem para o sistema todo
router.use(
  '/estatisticas-comparativas',
  authMiddleware,
  require('../modules/relatorios/comparativo.routes'),
);
router.use('/db-health', authMiddleware, require('../modules/sistema/db-health.routes'));
// Telas do aluno: o token de aluno já traz a instituição.
router.use('/aluno', authMiddleware, require('../modules/area-aluno/gamificacao.routes'));
router.use('/aluno', authMiddleware, require('../modules/area-aluno/carater.routes'));
// Antes de escolher a instituição: o seletor e a data do servidor.
router.use('/instituicoes', authMiddleware, instituicoes.globalRouter);
router.use('/hoje', authMiddleware, require('../modules/hoje/hoje.routes'));

// 3. Da instituição
router.use(authMiddleware, tenantMiddleware);
router.use('/instituicao', instituicoes.tenantRouter);
router.use('/', require('../modules/filtros/filtros.routes')); // /transportes e /professores
router.use('/alunos', require('../modules/alunos/alunos.routes'));
router.use('/presenca', require('../modules/presenca/presenca.routes'));
router.use('/relatorios', require('../modules/relatorios/relatorios.routes'));
router.use('/grade', require('../modules/matriculas/grade.routes'));
router.use('/matriculas', require('../modules/matriculas/matriculas.routes'));
router.use('/atividades', require('../modules/atividades/atividades.routes'));
router.use('/professores-admin', require('../modules/professores/professores.routes'));
router.use('/listas', require('../modules/listas/listas.routes'));
router.use('/termos', require('../modules/termos/termos.routes'));
router.use('/devolucoes', require('../modules/devolucoes/devolucoes.routes'));
router.use('/pontos-embarque', require('../modules/pontos-embarque/pontos-embarque.routes'));
router.use('/contatos-emergencia', require('../modules/alunos/contatos/contatos.routes').router);
router.use('/dias-sem-aula', require('../modules/calendario/dias-sem-aula.routes'));
router.use('/agenda-eventos', require('../modules/agenda/agenda.routes'));
router.use(
  '/justificativas-falta',
  require('../modules/justificativas-falta/justificativas-falta.routes'),
);
router.use('/notas', require('../modules/notas/notas.routes'));
router.use('/pontos', require('../modules/pontos/pontos.routes'));
router.use('/tipos-ponto-interno', require('../modules/pontos/tipos-interno.routes'));
router.use('/notificacoes', require('../modules/notificacoes/notificacoes.routes'));
router.use('/carater', require('../modules/carater/carater.routes'));
router.use('/foguinhos', require('../modules/relatorios/foguinhos.routes'));
router.use('/ocorrencias', require('../modules/ocorrencias/ocorrencias.routes'));

module.exports = router;

// Ponto de entrada real da API (ver server.js, que só reexporta este módulo, e
// api/index.js, o entry point da função serverless da Vercel — vercel.json faz o
// rewrite de toda rota pra lá).
//
// Ordem dos middlewares importa bastante aqui: CORS e parsing de JSON vêm
// primeiro; depois authMiddleware (exige login) é aplicado a tudo em /api EXCETO
// /api/auth/* e /api/historico-aluno (que aplica o middleware direto na sua
// própria linha de app.use); e só depois disso o middleware de x-institution-id
// popula req.id_instituicao, que todas as rotas de negócio usam para isolar os
// dados de cada instituição. Ou seja: qualquer rota nova montada em /api só deve
// assumir req.user e req.id_instituicao já disponíveis se vier depois dessa
// cadeia (as declaradas abaixo da linha `app.use('/api', authMiddleware)`).
require('dotenv').config();

//mudei aqui
const express = require('express');
const cors = require('cors');
const corsOptions = require('./src/config/cors');
const pool = require('./db');

// Inicializa o aplicativo Express
const app = express();
const PORT = process.env.PORT || 3001;

// Importação de Rotas
const alunosRouter = require('./alunos');
const presencaRouter = require('./presenca');
const relatoriosRouter = require('./relatorios');
const gradeRouter = require('./grade');
const matriculasRouter = require('./matriculas');
const atividadesRouter = require('./atividades');
const professoresAdminRouter = require('./professores');
const listasRouter = require('./listas');
const termosRouter = require('./termos');
const devolucoesRouter = require('./devolucoes');
const pontosEmbarqueRouter = require('./pontos-embarque');
const { router: authRouter, authMiddleware } = require('./auth');
const { router: contatosEmergenciaRouter } = require('./contatos-emergencia');
const diasSemAulaRouter = require('./dias-sem-aula');
const notificacoesRouter = require('./notificacoes');
const historicoAlunoRouter = require('./historico-aluno');
const permissoesRouter = require('./permissoes');
const perfisCustomizadosRouter = require('./perfis-customizados');
const areasConfigRouter = require('./areas-config');
const notasRouter = require('./notas');
const estatisticasComparativasRouter = require('./estatisticas-comparativas');
const cronLembreteChamadaRouter = require('./cron-lembrete-chamada');
const { router: dbHealthRouter } = require('./db-health');
const cronSaudeBancoRouter = require('./cron-saude-banco');
const pontosRouter = require('./pontos');
const tiposPontoInternoRouter = require('./tiposPontoInterno');
const agendaEventosRouter = require('./agenda-eventos');
const justificativasFaltaRouter = require('./justificativas-falta');
const instituicoesRoutes = require('./src/routes/instituicoes.routes');
const hojeRouter = require('./src/routes/hoje.routes');
const filtrosRouter = require('./src/routes/filtros.routes');
const AppError = require('./src/utils/AppError');

// Middlewares
app.use(cors(corsOptions));

// Middleware para desativar o cache do navegador (Crucial para iPhone/Safari)
// Isso garante que o celular sempre busque a informação mais recente do banco de dados.
// Aplicado apenas para requisições GET, já que POST/PUT/DELETE não são cacheados pelo navegador.
app.use((req, res, next) => {
  if (req.method === 'GET') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

// Middleware de Auditoria e Logs (Pilar de Observabilidade)
// Essencial para rastrear marcações feitas em dispositivos móveis (Safari/iPhone)
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];
  console.log(
    `[AUDIT] ${timestamp} - ${req.method} ${req.originalUrl} - IP: ${ip} - UA: ${userAgent}`,
  );
  next();
});

// Aumentado o limite para suportar grandes volumes de dados em importações (Bulk Import)
// O padrão é 100kb, aqui estamos definindo para 50mb.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use('/api/auth', authRouter);
// Rotas de histórico do aluno: só master, feito diretamente aqui (não dentro do
// próprio historico-aluno.js) porque também precisa de authMiddleware, mas NÃO
// do middleware de x-institution-id logo abaixo (master vê alunos de qualquer instituição).
app.use('/api/historico-aluno', authMiddleware, historicoAlunoRouter);
// Permissões por perfil: mesmo motivo do historico-aluno acima (master, ação
// global, não é de uma instituição específica) — authMiddleware já vem
// aplicado dentro do próprio permissoes.js, junto do masterMiddleware.
app.use('/api/permissoes', permissoesRouter);
// Perfis customizados: mesmo motivo/posição de permissoes acima (master,
// ação global) — authMiddleware+masterMiddleware já vêm aplicados dentro do
// próprio perfis-customizados.js.
app.use('/api/perfis-customizados', perfisCustomizadosRouter);
// Nomes de exibição das áreas: não é dado de uma instituição específica (é
// nomenclatura única do sistema inteiro), por isso também fica de fora do
// bloco de x-institution-id abaixo — authMiddleware (e masterMiddleware no
// PUT) já vêm aplicados dentro do próprio areas-config.js.
app.use('/api/areas', areasConfigRouter);
// Tela "Comparativo" (master/coordenador): compara VÁRIAS instituições de uma
// vez, por isso também fica fora do bloco de x-institution-id abaixo — ver
// comentário no topo de estatisticas-comparativas.js.
app.use('/api/estatisticas-comparativas', authMiddleware, estatisticasComparativasRouter);
// Saúde do pool de conexões MySQL (ver db-health.js): infraestrutura, não
// dado de uma instituição — mesmo motivo/posição de estatisticas-comparativas
// acima.
app.use('/api/db-health', authMiddleware, dbHealthRouter);
// Lembrete de fim de expediente (ver cron-lembrete-chamada.js): chamado pelo
// cron da Vercel, sem token de usuário — NUNCA passa por authMiddleware, se
// protege sozinha checando CRON_SECRET.
app.use('/api/cron/lembrete-chamada', cronLembreteChamadaRouter);
// Checagem diária da saúde do pool de conexões (ver cron-saude-banco.js):
// mesmo motivo/proteção do cron acima.
app.use('/api/cron/saude-banco', cronSaudeBancoRouter);
// Tela de perfil/gamificação do aluno: mesmo motivo do historico-aluno acima
// (authMiddleware direto, sem x-institution-id — o token de aluno já traz
// id_instituicao embutido, ver POST /api/auth/aluno-login).
app.use('/api/aluno', authMiddleware, require('./aluno-gamificacao'));
// Lado do aluno do sistema de formação de caráter (missões, diário, indicar
// colega) — mesmo motivo acima, montado ao lado de aluno-gamificacao.
app.use('/api/aluno', authMiddleware, require('./aluno-carater'));

// Seletor de instituição e data do servidor: exigem login, mas NÃO o
// x-institution-id (o usuário ainda não escolheu instituição). Ver src/routes/.
app.use('/api/instituicoes', authMiddleware, instituicoesRoutes.globalRouter);
app.use('/api/hoje', authMiddleware, hojeRouter);

app.use('/api', authMiddleware);

// Middleware para forçar o ID da instituição em todas as rotas da API.
//
// Confere o vínculo direto em usuario_instituicoes (nunca req.user.instituicoes,
// que vem do TOKEN assinado no login) — sem isso, desvincular um usuário de uma
// instituição (ex.: coordenador trocou de unidade, ou teve acesso revogado) só
// tinha efeito depois que o token dele expirasse (até 7 dias), porque a lista de
// instituições ficava cravada no token e nunca era reconferida no banco. Com a
// consulta aqui, a remoção vale já na PRÓXIMA requisição.
app.use('/api', async (req, res, next) => {
  try {
    const institutionId = req.headers['x-institution-id'];

    const parsedId = parseInt(institutionId);
    if (!institutionId) {
      console.warn(`Tentativa de acesso sem header x-institution-id em: ${req.originalUrl}`);
      return res
        .status(401)
        .json({ error: 'Acesso negado. O cabeçalho "x-institution-id" é obrigatório.' });
    }
    if (isNaN(parsedId)) {
      return res
        .status(401)
        .json({ error: 'Acesso negado. ID da instituição deve ser um número válido.' });
    }

    if (req.user.perfil !== 'master') {
      const [vinculo] = await pool.query(
        'SELECT 1 FROM usuario_instituicoes WHERE id_usuario = ? AND id_instituicao = ? LIMIT 1',
        [req.user.id, parsedId],
      );
      if (vinculo.length === 0) {
        return res
          .status(403)
          .json({ error: 'Acesso negado. Usuário não vinculado a esta instituição.' });
      }
    }

    req.id_instituicao = parsedId;
    next();
  } catch (err) {
    next(err);
  }
});

// Dados da instituição selecionada e dropdowns de filtro (ver src/routes/).
app.use('/api/instituicao', instituicoesRoutes.tenantRouter);
app.use('/api', filtrosRouter); // /api/transportes e /api/professores

// Modularização de Rotas (Transferido para roteadores específicos)
app.use('/api/alunos', alunosRouter);
app.use('/api/presenca', presencaRouter);
app.use('/api/relatorios', relatoriosRouter);
app.use('/api/grade', gradeRouter);
app.use('/api/matriculas', matriculasRouter);
// CRUD de turmas (atividades) — GET/POST/PUT/DELETE, ver atividades.js.
app.use('/api/atividades', atividadesRouter);
app.use('/api/professores-admin', professoresAdminRouter);
app.use('/api/listas', listasRouter);
app.use('/api/termos', termosRouter);
app.use('/api/devolucoes', devolucoesRouter);
app.use('/api/pontos-embarque', pontosEmbarqueRouter);
app.use('/api/contatos-emergencia', contatosEmergenciaRouter);
app.use('/api/dias-sem-aula', diasSemAulaRouter);
app.use('/api/agenda-eventos', agendaEventosRouter);
app.use('/api/justificativas-falta', justificativasFaltaRouter);
app.use('/api/notas', notasRouter);
app.use('/api/pontos', pontosRouter);
app.use('/api/tipos-ponto-interno', tiposPontoInternoRouter);
app.use('/api/notificacoes', notificacoesRouter);
app.use('/api/carater', require('./carater'));
app.use('/api/foguinhos', require('./foguinhos'));
app.use('/api/ocorrencias', require('./ocorrencias'));

// Middleware de Tratamento de Erros Global (Melhoria de UX/Estabilidade)
app.use((err, req, res, next) => {
  console.error(`[ERRO GLOBAL]: ${err.stack}`);

  // Tratar especificamente erros de validação do Joi
  if (err.isJoi || err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Erro de validação nos dados enviados.',
      details: err.details ? err.details.map((i) => i.message) : err.message,
    });
  }

  // Erros esperados (AppError, ex.: 404) podem mostrar a mensagem ao cliente;
  // o resto nunca expõe detalhes internos (ex.: mensagens do banco).
  res.status(err.status || 500).json({
    error: err instanceof AppError ? err.message : 'Ocorreu um erro interno no servidor.',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// Inicia o servidor na porta definida — só quando este arquivo é executado
// diretamente (`npm start` -> `node _server.js`). Na Vercel, api/index.js importa
// este módulo só para pegar o `app`, sem nunca chamar `require.main === module`
// como true, então o listen() nunca roda lá — a Vercel lida com o socket sozinha.
const HOST = '0.0.0.0';
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Servidor rodando na porta ${PORT}.`);
    console.log(`Para acessar de outros dispositivos na mesma rede, use seu IP local.`);
  });
}

// Exporta o app para a Vercel serverless
module.exports = app;

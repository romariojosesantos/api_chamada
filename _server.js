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

const express = require('express');
const cors = require('cors');
const pool = require('./db');

// Cache simples em memória para endpoints estáticos. Só é útil localmente ou
// dentro da mesma invocação serverless — na Vercel cada invocação é isolada, então
// esse cache não é compartilhado entre requisições diferentes em produção.
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

const getCache = (key) => {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
};

const setCache = (key, data) => {
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL });
};

const clearCache = () => {
  cache.clear();
};

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
const { router: authRouter, authMiddleware } = require('./auth');
const { router: contatosEmergenciaRouter } = require('./contatos-emergencia');
const diasSemAulaRouter = require('./dias-sem-aula');
const notificacoesRouter = require('./notificacoes');
const historicoAlunoRouter = require('./historico-aluno');

// Middlewares
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://controle-de-presenca-ten.vercel.app', 'https://api-chamada.vercel.app', 'https://atoson.com.br'] // Domínios permitidos em produção
    : '*',
  allowedHeaders: ['Content-Type', 'x-institution-id', 'Authorization', 'Pragma', 'Cache-Control', 'Expires'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));

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
  console.log(`[AUDIT] ${timestamp} - ${req.method} ${req.originalUrl} - IP: ${ip} - UA: ${userAgent}`);
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

// Lista de instituições para o seletor do usuário logado: master vê todas, os
// demais perfis só as instituições vinculadas a eles (req.user.instituicoes).
// Fica fora do bloco `app.use('/api', authMiddleware)` porque usa authMiddleware
// diretamente, sem depender do header x-institution-id (o usuário ainda não
// escolheu instituição neste ponto do fluxo do front).
app.get('/api/instituicoes/todas', authMiddleware, async (req, res) => {
  try {
    if (req.user.perfil === 'master') {
      const cacheKey = 'instituicoes_todas';
      const cached = getCache(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const [results] = await pool.query("SELECT id, nome FROM instituicoes ORDER BY nome ASC");
      setCache(cacheKey, results);
      return res.json(results);
    }

    const ids = Array.isArray(req.user.instituicoes) ? req.user.instituicoes : [];
    if (ids.length === 0) return res.json([]);

    const [results] = await pool.query("SELECT id, nome FROM instituicoes WHERE id IN (?) ORDER BY nome ASC", [ids]);
    res.json(results);
  } catch (err) {
    console.error("Erro em GET /api/instituicoes/todas:", err);
    res.status(500).json({ error: 'Erro ao buscar lista de instituições: ' + err.message });
  }
});

// Data de "hoje" segundo o servidor, no fuso de Brasília — nunca o relógio do
// aparelho do usuário. Existe porque a tela de Chamada usava só o relógio do
// navegador pra decidir a data padrão ao abrir; se o aparelho estiver com a
// data errada (relógio desconfigurado, fuso trocado etc.), a chamada podia
// ser lançada no dia errado sem ninguém perceber. Usa Intl com timeZone fixo
// em vez de `new Date()` puro porque o servidor roda em UTC — sem isso, entre
// 21h e meia-noite (Brasília) a resposta já seria do dia seguinte.
app.get('/api/hoje', authMiddleware, (req, res) => {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  res.json({ hoje });
});

app.use('/api', authMiddleware);

// Middleware para forçar o ID da instituição em todas as rotas da API
app.use('/api', (req, res, next) => {
  const institutionId = req.headers['x-institution-id'];

  const parsedId = parseInt(institutionId);
  if (!institutionId) {
    console.warn(`Tentativa de acesso sem header x-institution-id em: ${req.originalUrl}`);
    return res.status(401).json({ error: 'Acesso negado. O cabeçalho "x-institution-id" é obrigatório.' });
  }
  if (isNaN(parsedId)) {
    return res.status(401).json({ error: 'Acesso negado. ID da instituição deve ser um número válido.' });
  }

  if (req.user.perfil !== 'master') {
    const instituicoes = Array.isArray(req.user.instituicoes) ? req.user.instituicoes.map(Number) : [];
    if (!instituicoes.includes(parsedId)) {
      return res.status(403).json({ error: 'Acesso negado. Usuário não vinculado a esta instituição.' });
    }
  }

  req.id_instituicao = parsedId;
  next();
});

// Rota para obter detalhes da instituição selecionada (ID vindo do header via middleware)
app.get('/api/instituicao', async (req, res) => {
  try {
    const [results] = await pool.query("SELECT id, nome FROM instituicoes WHERE id = ?", [req.id_instituicao]);
    if (results.length === 0) {
      return res.status(404).json({ error: 'Instituição não encontrada.' });
    }
    res.json(results[0]);
  } catch (err) {
    console.error("Erro em GET /api/instituicao:", err);
    res.status(500).json({ error: 'Erro ao buscar dados da instituição: ' + err.message });
  }
});

// Rota para listar transportes únicos da instituição (para o dropdown de filtros)
app.get('/api/transportes', async (req, res) => {
  try {
    const sql = `
      SELECT DISTINCT TRIM(transporte) AS transporte
      FROM alunos
      WHERE id_instituicao = ? AND transporte IS NOT NULL AND TRIM(transporte) != ''
      ORDER BY transporte ASC
    `;
    const [results] = await pool.query(sql, [req.id_instituicao]);
    const lista = results.map(r => r.transporte).filter(Boolean);
    res.json(lista);
  } catch (err) {
    console.error("Erro em GET /api/transportes:", err);
    res.status(500).json({ error: 'Erro ao buscar transportes: ' + err.message });
  }
});

// Rota para listar professores únicos da instituição (para o dropdown de filtros)
app.get('/api/professores', async (req, res) => {
  try {
    const sql = `
      SELECT DISTINCT TRIM(nome) AS nome
      FROM professores
      WHERE id_instituicao = ? AND nome IS NOT NULL AND TRIM(nome) != ''
      ORDER BY nome ASC
    `;
    const [results] = await pool.query(sql, [req.id_instituicao]);
    const lista = results.map(r => r.nome).filter(Boolean);
    res.json(lista);
  } catch (err) {
    console.error("Erro em GET /api/professores:", err);
    res.status(500).json({ error: 'Erro ao buscar professores: ' + err.message });
  }
});

// Modularização de Rotas (Transferido para roteadores específicos)
app.use('/api/alunos', alunosRouter);
app.use('/api/presenca', presencaRouter);
app.use('/api/relatorios', relatoriosRouter);
app.use('/api/grade', gradeRouter);
app.use('/api/matriculas', matriculasRouter);
// CRUD de turmas (atividades) — GET/POST/PUT/DELETE, ver atividades.js.
app.use('/api/atividades', atividadesRouter);
app.use('/api/contatos-emergencia', contatosEmergenciaRouter);
app.use('/api/dias-sem-aula', diasSemAulaRouter);
app.use('/api/notificacoes', notificacoesRouter);

// Middleware de Tratamento de Erros Global (Melhoria de UX/Estabilidade)
app.use((err, req, res, next) => {
  console.error(`[ERRO GLOBAL]: ${err.stack}`);

  // Tratar especificamente erros de validação do Joi
  if (err.isJoi || err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Erro de validação nos dados enviados.',
      details: err.details ? err.details.map(i => i.message) : err.message
    });
  }

  res.status(err.status || 500).json({
    error: 'Ocorreu um erro interno no servidor.',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
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

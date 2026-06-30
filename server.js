// /minha-api/server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const pool = require('./db');

const { getCache, setCache, clearCache } = require('./cache');

// Inicializa o aplicativo Express
const app = express();
const PORT = process.env.PORT || 3001;

// Importação de Rotas
const alunosRouter = require('./alunos');
const presencaRouter = require('./presenca');
const relatoriosRouter = require('./relatorios');
const gradeRouter = require('./grade');
const matriculasRouter = require('./matriculas');
const { router: authRouter, authMiddleware } = require('./auth');

// Middlewares
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://controle-de-presenca-ten.vercel.app', 'https://api-chamada.vercel.app'] // Domínios permitidos em produção
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
    const cacheKey = `transportes_${req.id_instituicao}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }
    
    const sql = `
      SELECT DISTINCT transporte 
      FROM alunos 
      WHERE id_instituicao = ? AND transporte IS NOT NULL AND transporte != ''
      ORDER BY transporte ASC
    `;
    const [results] = await pool.query(sql, [req.id_instituicao]);
    const lista = results.map(r => r.transporte);
    setCache(cacheKey, lista);
    res.json(lista);
  } catch (err) {
    console.error("Erro em GET /api/transportes:", err);
    res.status(500).json({ error: 'Erro ao buscar transportes: ' + err.message });
  }
});

// Rota para listar professores únicos da instituição (para o dropdown de filtros)
app.get('/api/professores', async (req, res) => {
  try {
    const cacheKey = `professores_${req.id_instituicao}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }
    
    const sql = `
      SELECT DISTINCT p.nome 
      FROM professores p
      JOIN atividades a ON p.id = a.idprofessor
      JOIN matricula m ON a.idatividades = m.idatividades
      WHERE p.id_instituicao = ? AND m.status = 'matriculado'
      ORDER BY p.nome ASC
    `;
    const [results] = await pool.query(sql, [req.id_instituicao]);
    const lista = results.map(r => r.nome);
    setCache(cacheKey, lista);
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

// Inicia o servidor na porta definida
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Servidor rodando na porta ${PORT}.`);
  console.log(`Para acessar de outros dispositivos na mesma rede, use seu IP local.`);
});

module.exports = { app, clearCache };

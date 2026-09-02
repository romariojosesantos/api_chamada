// Lado do aluno do sistema de formação de caráter — ver carater.js pro lado
// da equipe (missões, fila de confirmação, reconhecimento). Tudo aqui gira em
// torno de `atos_carater`: um registro pendente até um professor/coordenador/
// master confirmar (ver PUT /api/carater/:id/confirmar), com 4 origens
// possíveis:
//   - 'missao': aluno marcou uma missão de caráter como feita
//   - 'diario': aluno escreveu uma reflexão no Diário de Semeadura
//   - 'indicacao_colega': aluno indicou um colega pra um ato observado
//   - 'reconhecimento_professor': a equipe registrou direto, já confirmado
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { PRINCIPIOS_CARATER, PRINCIPIO_IDS } = require('./carater-principios');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const LIMITE_EMBLEMA_PRINCIPIO = 3; // atos confirmados num princípio pra desbloquear o emblema dele
const RANKS_LIDERANCA = [
  { min: 0, nome: 'Aprendiz de Serviço' },
  { min: 3, nome: 'Servo Fiel' },
  { min: 8, nome: 'Líder Servidor' },
  { min: 16, nome: 'Mentor de Caráter' }
];

const exigirAluno = (req, res, next) => {
  if (req.user.perfil !== 'aluno') return res.status(403).json({ error: 'Rota exclusiva para alunos.' });
  next();
};
router.use(exigirAluno);

router.get('/carater', asyncHandler(async (req, res) => {
  const alunoId = req.user.aluno_id;
  const idInstituicao = req.user.id_instituicao;
  const hoje = new Date().toISOString().split('T')[0];

  const [
    [contagemPorPrincipioRows],
    [missoesRows],
    [diarioRows],
    [atosRecentesRows]
  ] = await Promise.all([
    pool.query(
      "SELECT principio, COUNT(*) AS total FROM atos_carater WHERE id_aluno = ? AND status = 'confirmado' GROUP BY principio",
      [alunoId]
    ),
    pool.query(
      `SELECT mc.id, mc.titulo, mc.descricao, mc.principio,
              (SELECT ac.status FROM atos_carater ac
               WHERE ac.id_missao = mc.id AND ac.id_aluno = ?
               ORDER BY ac.created_at DESC LIMIT 1) AS status_aluno
       FROM missoes_carater mc
       WHERE mc.id_instituicao = ? AND mc.ativa = 1
       ORDER BY mc.created_at DESC`,
      [alunoId, idInstituicao]
    ),
    pool.query(
      `SELECT id, principio, texto, status, comentario_professor, created_at
       FROM atos_carater WHERE id_aluno = ? AND origem = 'diario'
       ORDER BY created_at DESC LIMIT 10`,
      [alunoId]
    ),
    pool.query(
      `SELECT principio, origem, status, texto, created_at
       FROM atos_carater WHERE id_aluno = ?
       ORDER BY created_at DESC LIMIT 10`,
      [alunoId]
    )
  ]);

  const contagemPorPrincipio = {};
  for (const row of contagemPorPrincipioRows) contagemPorPrincipio[row.principio] = row.total;

  const principios = PRINCIPIOS_CARATER.map(p => ({ ...p, confirmados: contagemPorPrincipio[p.id] || 0 }));

  const emblemas = principios.map(p => ({
    principio_id: p.id,
    chave: p.chave,
    nome: p.nome,
    desbloqueada: p.confirmados >= LIMITE_EMBLEMA_PRINCIPIO,
    progresso: Math.min(p.confirmados, LIMITE_EMBLEMA_PRINCIPIO),
    meta: LIMITE_EMBLEMA_PRINCIPIO
  }));

  const totalConfirmados = principios.reduce((soma, p) => soma + p.confirmados, 0);
  let nivelAtualIdx = 0;
  for (let i = 0; i < RANKS_LIDERANCA.length; i++) {
    if (totalConfirmados >= RANKS_LIDERANCA[i].min) nivelAtualIdx = i;
  }
  const nivelAtual = RANKS_LIDERANCA[nivelAtualIdx];
  const proximoNivel = RANKS_LIDERANCA[nivelAtualIdx + 1] || null;
  const trilha = {
    nivel_atual: nivelAtual.nome,
    proximo_nivel: proximoNivel ? proximoNivel.nome : null,
    total_confirmados: totalConfirmados,
    progresso: proximoNivel ? totalConfirmados - nivelAtual.min : 0,
    meta: proximoNivel ? proximoNivel.min - nivelAtual.min : 0
  };

  res.json({
    principios,
    emblemas,
    trilha,
    missoes_ativas: missoesRows.map(m => ({ ...m, status_aluno: m.status_aluno || null })),
    diario: diarioRows.map(d => ({
      ...d,
      data: d.created_at instanceof Date ? d.created_at.toISOString().split('T')[0] : String(d.created_at).split('T')[0]
    })),
    atos_recentes: atosRecentesRows.map(a => ({
      ...a,
      data: a.created_at instanceof Date ? a.created_at.toISOString().split('T')[0] : String(a.created_at).split('T')[0]
    })),
    hoje
  });
}));

router.post('/missoes/:id/concluir', asyncHandler(async (req, res) => {
  const alunoId = req.user.aluno_id;
  const idInstituicao = req.user.id_instituicao;
  const missaoId = parseInt(req.params.id);

  const [missoes] = await pool.query(
    'SELECT id, principio FROM missoes_carater WHERE id = ? AND id_instituicao = ? AND ativa = 1',
    [missaoId, idInstituicao]
  );
  if (missoes.length === 0) return res.status(404).json({ error: 'Missão não encontrada.' });

  const [emAndamento] = await pool.query(
    "SELECT id FROM atos_carater WHERE id_missao = ? AND id_aluno = ? AND status IN ('pendente','confirmado')",
    [missaoId, alunoId]
  );
  if (emAndamento.length > 0) return res.status(400).json({ error: 'Você já marcou essa missão.' });

  await pool.query(
    `INSERT INTO atos_carater (id_instituicao, id_aluno, principio, origem, id_missao, status)
     VALUES (?, ?, ?, 'missao', ?, 'pendente')`,
    [idInstituicao, alunoId, missoes[0].principio, missaoId]
  );
  res.status(201).json({ message: 'Aguardando confirmação do professor.' });
}));

router.post('/diario', asyncHandler(async (req, res) => {
  const alunoId = req.user.aluno_id;
  const idInstituicao = req.user.id_instituicao;
  const texto = String(req.body.texto || '').trim();
  const principio = PRINCIPIO_IDS.includes(parseInt(req.body.principio)) ? parseInt(req.body.principio) : 5;

  if (texto.length < 10) return res.status(400).json({ error: 'Escreva um pouco mais sobre o que você viveu (pelo menos 10 caracteres).' });

  await pool.query(
    `INSERT INTO atos_carater (id_instituicao, id_aluno, principio, origem, texto, status)
     VALUES (?, ?, ?, 'diario', ?, 'pendente')`,
    [idInstituicao, alunoId, principio, texto]
  );
  res.status(201).json({ message: 'Reflexão enviada — seu professor vai ler em breve.' });
}));

router.get('/colegas', asyncHandler(async (req, res) => {
  const alunoId = req.user.aluno_id;
  const hoje = new Date().toISOString().split('T')[0];

  const [rows] = await pool.query(
    `SELECT DISTINCT a2.id, a2.nome
     FROM matricula m1
     JOIN matricula m2 ON m2.idatividades = m1.idatividades AND m2.idaluno != m1.idaluno
       AND ? >= m2.data_inicio AND (m2.data_fim IS NULL OR ? <= m2.data_fim)
     JOIN alunos a2 ON a2.id = m2.idaluno AND a2.excluido_em IS NULL AND a2.status = 'ativo'
     WHERE m1.idaluno = ? AND ? >= m1.data_inicio AND (m1.data_fim IS NULL OR ? <= m1.data_fim)
     ORDER BY a2.nome ASC
     LIMIT 100`,
    [hoje, hoje, alunoId, hoje, hoje]
  );
  res.json(rows);
}));

router.post('/indicar', asyncHandler(async (req, res) => {
  const alunoId = req.user.aluno_id;
  const idInstituicao = req.user.id_instituicao;
  const idColega = parseInt(req.body.id_aluno_colega);
  const principio = parseInt(req.body.principio);
  const texto = String(req.body.texto || '').trim();

  if (idColega === alunoId) return res.status(400).json({ error: 'Você não pode se indicar.' });
  if (!PRINCIPIO_IDS.includes(principio)) return res.status(400).json({ error: 'Princípio inválido.' });
  if (texto.length < 10) return res.status(400).json({ error: 'Conte um pouco mais sobre o que você viu (pelo menos 10 caracteres).' });

  const [colegas] = await pool.query(
    "SELECT id FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL AND status = 'ativo'",
    [idColega, idInstituicao]
  );
  if (colegas.length === 0) return res.status(404).json({ error: 'Colega não encontrado.' });

  await pool.query(
    `INSERT INTO atos_carater (id_instituicao, id_aluno, principio, origem, id_aluno_indicador, texto, status)
     VALUES (?, ?, ?, 'indicacao_colega', ?, ?, 'pendente')`,
    [idInstituicao, idColega, principio, alunoId, texto]
  );
  res.status(201).json({ message: 'Indicação enviada — seu professor vai confirmar em breve.' });
}));

module.exports = router;

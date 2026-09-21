// CRUD de "Listas" — agrupamentos nomeados de alunos por instituição (tela
// "Listas", estilo Apple Notas: título + busca pra adicionar aluno). Mesmo
// nível de proteção que as outras telas "normais" (Turmas, Educadores): só
// authMiddleware/instituição genéricos (aplicados em _server.js), controle
// de acesso por perfil é decidido no front (ver backend/telas.js).
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { logAuditEvent } = require('./audit');
const { exigirRecurso } = require('./permissoes-middleware');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const exigir = (recurso) => exigirRecurso('/listas', recurso);

// Lista todas as listas da instituição, com quantos alunos cada uma tem —
// é a "tela inicial" (cartões com título, estilo Apple Notas).
router.get('/', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT l.id, l.titulo, l.criado_em,
       (SELECT COUNT(*) FROM lista_alunos la WHERE la.id_lista = l.id) AS total_alunos
     FROM listas l
     WHERE l.id_instituicao = ?
     ORDER BY l.criado_em DESC`,
    [req.id_instituicao]
  );
  res.json(rows);
}));

router.post('/', exigir('criar'), asyncHandler(async (req, res) => {
  const titulo = String(req.body.titulo || '').trim();
  if (!titulo) return res.status(400).json({ error: 'Título é obrigatório.' });

  const [result] = await pool.query(
    'INSERT INTO listas (id_instituicao, titulo) VALUES (?, ?)',
    [req.id_instituicao, titulo]
  );

  await logAuditEvent('LISTA_CRIADA', `Lista "${titulo}" (#${result.insertId})`, req.id_instituicao);

  res.status(201).json({ id: result.insertId, titulo, criado_em: new Date().toISOString(), total_alunos: 0 });
}));

// Detalhe de uma lista: título + membros (dados básicos de exibição).
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [[lista]] = await pool.query(
    'SELECT id, titulo, criado_em FROM listas WHERE id = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );
  if (!lista) return res.status(404).json({ error: 'Lista não encontrada.' });

  // telefone_responsavel/telefone_aluno vêm separados (não resolve a
  // prioridade aqui) pra exportação em Excel decidir: telefone do responsável
  // se tiver, senão o do próprio aluno (ver exportarExcel em ListaDetalhe.js).
  const [alunos] = await pool.query(
    `SELECT a.id, a.nome, a.turno, a.turma, a.telefone AS telefone_aluno, rl.telefone AS telefone_responsavel
     FROM lista_alunos la
     JOIN alunos a ON a.id = la.id_aluno
     LEFT JOIN responsavel_legal rl ON rl.id_aluno = a.id
     WHERE la.id_lista = ?
     ORDER BY a.nome ASC`,
    [id]
  );

  res.json({ ...lista, alunos });
}));

router.patch('/:id', exigir('editar'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const titulo = String(req.body.titulo || '').trim();
  if (!titulo) return res.status(400).json({ error: 'Título não pode ficar vazio.' });

  const [result] = await pool.query(
    'UPDATE listas SET titulo = ? WHERE id = ? AND id_instituicao = ?',
    [titulo, id, req.id_instituicao]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Lista não encontrada.' });

  res.json({ id: Number(id), titulo });
}));

router.delete('/:id', exigir('excluir'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [[lista]] = await pool.query('SELECT titulo FROM listas WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);
  if (!lista) return res.status(404).json({ error: 'Lista não encontrada.' });

  await pool.query('DELETE FROM listas WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);

  await logAuditEvent('LISTA_APAGADA', `Lista #${id} "${lista.titulo}"`, req.id_instituicao);

  res.json({ success: true });
}));

router.post('/:id/alunos', exigir('editar'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const alunoId = Number(req.body.aluno_id);
  if (!alunoId) return res.status(400).json({ error: 'Informe aluno_id.' });

  const [[lista]] = await pool.query('SELECT id FROM listas WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);
  if (!lista) return res.status(404).json({ error: 'Lista não encontrada.' });

  const [[aluno]] = await pool.query('SELECT id, nome, turno, turma FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL', [alunoId, req.id_instituicao]);
  if (!aluno) return res.status(404).json({ error: 'Aluno não encontrado.' });

  const [[jaEsta]] = await pool.query('SELECT 1 FROM lista_alunos WHERE id_lista = ? AND id_aluno = ?', [id, alunoId]);
  if (jaEsta) return res.status(409).json({ error: `"${aluno.nome}" já está nessa lista.` });

  await pool.query('INSERT INTO lista_alunos (id_lista, id_aluno) VALUES (?, ?)', [id, alunoId]);

  res.status(201).json(aluno);
}));

router.delete('/:id/alunos/:alunoId', exigir('editar'), asyncHandler(async (req, res) => {
  const { id, alunoId } = req.params;

  const [result] = await pool.query(
    `DELETE la FROM lista_alunos la JOIN listas l ON l.id = la.id_lista
     WHERE la.id_lista = ? AND la.id_aluno = ? AND l.id_instituicao = ?`,
    [id, alunoId, req.id_instituicao]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Esse aluno não está nessa lista.' });

  res.json({ success: true });
}));

module.exports = router;

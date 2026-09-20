// CRUD de "Termos" — termos de responsabilidade que os pais dos inscritos
// assinam (ex.: "Corajosamente Éticos", "Animais Peçonhentos"), cada
// instituição cria/apaga os seus. Mesmo nível de proteção que Listas/Turmas:
// só authMiddleware/instituição genéricos (aplicados em _server.js), controle
// de acesso por perfil é decidido no front (ver backend/telas.js).
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { logAuditEvent } = require('./audit');
const { hojeBrasil } = require('./data-brasil');
const { exigirRecurso } = require('./permissoes-middleware');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const exigir = (recurso) => exigirRecurso('/termos', recurso);

// Lista os termos da instituição com a contagem de assinados/pendentes —
// "tela inicial" (cartões, mesmo estilo de Listas). Só considera alunos
// ATIVOS nas contagens (quem está inativo/em espera não entra na pendência).
router.get('/', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT t.id, t.nome, t.criado_em,
       (SELECT COUNT(*) FROM alunos a WHERE a.id_instituicao = t.id_instituicao AND a.status = 'ativo' AND a.excluido_em IS NULL) AS total_alunos,
       (SELECT COUNT(*) FROM termo_assinaturas ta
          JOIN alunos a ON a.id = ta.id_aluno
          WHERE ta.id_termo = t.id AND a.status = 'ativo' AND a.excluido_em IS NULL) AS assinados
     FROM termos t
     WHERE t.id_instituicao = ?
     ORDER BY t.nome ASC`,
    [req.id_instituicao]
  );
  res.json(rows);
}));

router.post('/', exigir('criar'), asyncHandler(async (req, res) => {
  const nome = String(req.body.nome || '').trim();
  if (!nome) return res.status(400).json({ error: 'Nome do termo é obrigatório.' });

  const [result] = await pool.query(
    'INSERT INTO termos (id_instituicao, nome) VALUES (?, ?)',
    [req.id_instituicao, nome]
  );

  await logAuditEvent('TERMO_CRIADO', `Termo "${nome}" (#${result.insertId})`, req.id_instituicao);

  res.status(201).json({ id: result.insertId, nome, criado_em: new Date().toISOString(), total_alunos: 0, assinados: 0 });
}));

// Detalhe de um termo: nome + duas listas (quem assinou, com a data; quem
// falta assinar) — só alunos ativos em ambas, mesma regra da listagem acima.
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [[termo]] = await pool.query(
    'SELECT id, nome, criado_em FROM termos WHERE id = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );
  if (!termo) return res.status(404).json({ error: 'Termo não encontrado.' });

  const [assinados] = await pool.query(
    `SELECT a.id, a.nome, a.turno, a.turma, ta.assinado_em
     FROM termo_assinaturas ta
     JOIN alunos a ON a.id = ta.id_aluno
     WHERE ta.id_termo = ? AND a.id_instituicao = ? AND a.status = 'ativo' AND a.excluido_em IS NULL
     ORDER BY a.nome ASC`,
    [id, req.id_instituicao]
  );

  const [pendentes] = await pool.query(
    `SELECT a.id, a.nome, a.turno, a.turma
     FROM alunos a
     WHERE a.id_instituicao = ? AND a.status = 'ativo' AND a.excluido_em IS NULL
       AND a.id NOT IN (SELECT id_aluno FROM termo_assinaturas WHERE id_termo = ?)
     ORDER BY a.nome ASC`,
    [req.id_instituicao, id]
  );

  res.json({ ...termo, assinados, pendentes });
}));

router.delete('/:id', exigir('excluir'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [[termo]] = await pool.query('SELECT nome FROM termos WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);
  if (!termo) return res.status(404).json({ error: 'Termo não encontrado.' });

  await pool.query('DELETE FROM termos WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);

  await logAuditEvent('TERMO_APAGADO', `Termo #${id} "${termo.nome}"`, req.id_instituicao);

  res.json({ success: true });
}));

// Marca um aluno como tendo assinado (upsert — assinar de novo só atualiza a
// data, não dá erro de duplicidade).
router.post('/:id/assinaturas', exigir('editar'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const alunoId = Number(req.body.aluno_id);
  if (!alunoId) return res.status(400).json({ error: 'Informe aluno_id.' });

  const [[termo]] = await pool.query('SELECT id FROM termos WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);
  if (!termo) return res.status(404).json({ error: 'Termo não encontrado.' });

  const [[aluno]] = await pool.query('SELECT id, nome, turno, turma FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL', [alunoId, req.id_instituicao]);
  if (!aluno) return res.status(404).json({ error: 'Aluno não encontrado.' });

  const assinadoEm = req.body.assinado_em || hojeBrasil();

  await pool.query(
    'INSERT INTO termo_assinaturas (id_termo, id_aluno, assinado_em) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE assinado_em = VALUES(assinado_em)',
    [id, alunoId, assinadoEm]
  );

  res.status(201).json({ ...aluno, assinado_em: assinadoEm });
}));

// Desmarca (assinatura registrada por engano).
router.delete('/:id/assinaturas/:alunoId', exigir('editar'), asyncHandler(async (req, res) => {
  const { id, alunoId } = req.params;

  const [result] = await pool.query(
    `DELETE ta FROM termo_assinaturas ta JOIN termos t ON t.id = ta.id_termo
     WHERE ta.id_termo = ? AND ta.id_aluno = ? AND t.id_instituicao = ?`,
    [id, alunoId, req.id_instituicao]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Esse aluno não está marcado como assinado nesse termo.' });

  res.json({ success: true });
}));

module.exports = router;

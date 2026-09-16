// CRUD de "Devolução de Materiais" — controle de devolução de uniforme e
// outros itens por alunos que ficaram INATIVOS (mesmo padrão de Termos.js,
// mas o público das listas é só quem está inativo, não ativo). Cada
// instituição cria/apaga os seus próprios itens. Mesmo nível de proteção que
// Listas/Termos: só authMiddleware/instituição genéricos (aplicados em
// _server.js), controle de acesso por perfil é decidido no front (ver
// backend/telas.js).
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { logAuditEvent } = require('./audit');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Lista os itens da instituição com a contagem de devolvidos/pendentes —
// "tela inicial" (cartões, mesmo estilo de Termos). Só considera alunos
// INATIVOS nas contagens — é só pra eles que devolução faz sentido aqui.
router.get('/', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT i.id, i.nome, i.criado_em,
       (SELECT COUNT(*) FROM alunos a WHERE a.id_instituicao = i.id_instituicao AND a.status = 'inativo' AND a.excluido_em IS NULL) AS total_alunos,
       (SELECT COUNT(*) FROM itens_devolucao_registros r
          JOIN alunos a ON a.id = r.id_aluno
          WHERE r.id_item = i.id AND a.status = 'inativo' AND a.excluido_em IS NULL) AS devolvidos
     FROM itens_devolucao i
     WHERE i.id_instituicao = ?
     ORDER BY i.nome ASC`,
    [req.id_instituicao]
  );
  res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const nome = String(req.body.nome || '').trim();
  if (!nome) return res.status(400).json({ error: 'Nome do item é obrigatório.' });

  const [result] = await pool.query(
    'INSERT INTO itens_devolucao (id_instituicao, nome) VALUES (?, ?)',
    [req.id_instituicao, nome]
  );

  await logAuditEvent('ITEM_DEVOLUCAO_CRIADO', `Item "${nome}" (#${result.insertId})`, req.id_instituicao);

  res.status(201).json({ id: result.insertId, nome, criado_em: new Date().toISOString(), total_alunos: 0, devolvidos: 0 });
}));

// Detalhe de um item: nome + duas listas (quem devolveu, com a data; quem
// falta devolver) — só alunos INATIVOS em ambas.
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [[item]] = await pool.query(
    'SELECT id, nome, criado_em FROM itens_devolucao WHERE id = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );
  if (!item) return res.status(404).json({ error: 'Item não encontrado.' });

  const [devolvidos] = await pool.query(
    `SELECT a.id, a.nome, a.turno, a.turma, r.devolvido_em
     FROM itens_devolucao_registros r
     JOIN alunos a ON a.id = r.id_aluno
     WHERE r.id_item = ? AND a.id_instituicao = ? AND a.status = 'inativo' AND a.excluido_em IS NULL
     ORDER BY a.nome ASC`,
    [id, req.id_instituicao]
  );

  const [pendentes] = await pool.query(
    `SELECT a.id, a.nome, a.turno, a.turma
     FROM alunos a
     WHERE a.id_instituicao = ? AND a.status = 'inativo' AND a.excluido_em IS NULL
       AND a.id NOT IN (SELECT id_aluno FROM itens_devolucao_registros WHERE id_item = ?)
     ORDER BY a.nome ASC`,
    [req.id_instituicao, id]
  );

  res.json({ ...item, devolvidos, pendentes });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [[item]] = await pool.query('SELECT nome FROM itens_devolucao WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);
  if (!item) return res.status(404).json({ error: 'Item não encontrado.' });

  await pool.query('DELETE FROM itens_devolucao WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);

  await logAuditEvent('ITEM_DEVOLUCAO_APAGADO', `Item #${id} "${item.nome}"`, req.id_instituicao);

  res.json({ success: true });
}));

// Marca um aluno como tendo devolvido (upsert — devolver de novo só atualiza
// a data, não dá erro de duplicidade). Só aceita aluno que esteja de fato
// inativo hoje — não faz sentido registrar devolução de quem está ativo.
router.post('/:id/registros', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const alunoId = Number(req.body.aluno_id);
  if (!alunoId) return res.status(400).json({ error: 'Informe aluno_id.' });

  const [[item]] = await pool.query('SELECT id FROM itens_devolucao WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);
  if (!item) return res.status(404).json({ error: 'Item não encontrado.' });

  const [[aluno]] = await pool.query(
    "SELECT id, nome, turno, turma FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL AND status = 'inativo'",
    [alunoId, req.id_instituicao]
  );
  if (!aluno) return res.status(404).json({ error: 'Aluno não encontrado ou não está inativo.' });

  const devolvidoEm = req.body.devolvido_em || new Date().toISOString().split('T')[0];

  await pool.query(
    'INSERT INTO itens_devolucao_registros (id_item, id_aluno, devolvido_em) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE devolvido_em = VALUES(devolvido_em)',
    [id, alunoId, devolvidoEm]
  );

  res.status(201).json({ ...aluno, devolvido_em: devolvidoEm });
}));

// Desmarca (registro feito por engano).
router.delete('/:id/registros/:alunoId', asyncHandler(async (req, res) => {
  const { id, alunoId } = req.params;

  const [result] = await pool.query(
    `DELETE r FROM itens_devolucao_registros r JOIN itens_devolucao i ON i.id = r.id_item
     WHERE r.id_item = ? AND r.id_aluno = ? AND i.id_instituicao = ?`,
    [id, alunoId, req.id_instituicao]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Esse aluno não está marcado como devolvido nesse item.' });

  res.json({ success: true });
}));

module.exports = router;

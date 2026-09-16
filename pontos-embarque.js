// CRUD de "Pontos de Embarque" — lista de pontos (campo "Ponto" do cadastro
// do aluno) que cada instituição mantém a sua própria. Mesmo nível de
// proteção que Listas/Termos: só authMiddleware/instituição genéricos
// (aplicados em _server.js), sem middleware de perfil — qualquer perfil com
// acesso à tela de cadastro de aluno pode gerenciar.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { logAuditEvent } = require('./audit');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, nome FROM pontos_embarque WHERE id_instituicao = ? ORDER BY nome ASC',
    [req.id_instituicao]
  );
  res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const nome = String(req.body.nome || '').trim();
  if (!nome) return res.status(400).json({ error: 'Nome do ponto é obrigatório.' });

  const [[jaExiste]] = await pool.query(
    'SELECT id FROM pontos_embarque WHERE id_instituicao = ? AND nome = ?',
    [req.id_instituicao, nome]
  );
  if (jaExiste) return res.status(409).json({ error: `"${nome}" já está cadastrado.` });

  const [result] = await pool.query(
    'INSERT INTO pontos_embarque (id_instituicao, nome) VALUES (?, ?)',
    [req.id_instituicao, nome]
  );

  await logAuditEvent('PONTO_EMBARQUE_CRIADO', `Ponto "${nome}" (#${result.insertId})`, req.id_instituicao);

  res.status(201).json({ id: result.insertId, nome });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [[ponto]] = await pool.query('SELECT nome FROM pontos_embarque WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);
  if (!ponto) return res.status(404).json({ error: 'Ponto não encontrado.' });

  await pool.query('DELETE FROM pontos_embarque WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);

  await logAuditEvent('PONTO_EMBARQUE_APAGADO', `Ponto #${id} "${ponto.nome}"`, req.id_instituicao);

  // Não mexe em `alunos.ponto` de quem já tinha esse valor gravado — apagar
  // da lista só impede escolher de novo no dropdown, não some com o dado de
  // quem já estava usando (mesmo espírito de apagar uma Lista ou um Termo).
  res.json({ success: true });
}));

module.exports = router;

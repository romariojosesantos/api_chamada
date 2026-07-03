const express = require('express');
const router = express.Router();
const pool = require('./db');
const { logAuditEvent } = require('./audit');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Listar contatos de emergência de um aluno
router.get('/aluno/:alunoId', asyncHandler(async (req, res) => {
  const alunoId = parseInt(req.params.alunoId);
  if (isNaN(alunoId)) return res.status(400).json({ error: 'ID do aluno inválido.' });

  const [rows] = await pool.query(
    'SELECT id, id_aluno, nome, telefone, parentesco FROM contatos_emergencia WHERE id_aluno = ? AND id_instituicao = ? ORDER BY id',
    [alunoId, req.id_instituicao]
  );
  res.json(rows);
}));

// Criar contato de emergência
router.post('/', asyncHandler(async (req, res) => {
  const { id_aluno, nome, telefone, parentesco } = req.body;
  const alunoId = parseInt(id_aluno);
  
  if (isNaN(alunoId)) return res.status(400).json({ error: 'ID do aluno inválido.' });
  if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome do contato é obrigatório.' });
  if (!telefone || !telefone.trim()) return res.status(400).json({ error: 'Telefone do contato é obrigatório.' });

  const [result] = await pool.query(
    'INSERT INTO contatos_emergencia (id_aluno, nome, telefone, parentesco, id_instituicao) VALUES (?, ?, ?, ?, ?)',
    [alunoId, nome.trim(), telefone.trim(), parentesco?.trim() || null, req.id_instituicao]
  );

  await logAuditEvent(req, 'contato_emergencia_criado', `Contato de emergência criado para aluno ID ${alunoId}`);
  res.status(201).json({ id: result.insertId, message: 'Contato de emergência criado com sucesso.' });
}));

// Atualizar contato de emergência
router.put('/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const { nome, telefone, parentesco } = req.body;
  
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido.' });
  if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome do contato é obrigatório.' });
  if (!telefone || !telefone.trim()) return res.status(400).json({ error: 'Telefone do contato é obrigatório.' });

  const [result] = await pool.query(
    'UPDATE contatos_emergencia SET nome = ?, telefone = ?, parentesco = ? WHERE id = ? AND id_instituicao = ?',
    [nome.trim(), telefone.trim(), parentesco?.trim() || null, id, req.id_instituicao]
  );

  if (result.affectedRows === 0) return res.status(404).json({ error: 'Contato de emergência não encontrado.' });

  await logAuditEvent(req, 'contato_emergencia_atualizado', `Contato de emergência ID ${id} atualizado`);
  res.json({ message: 'Contato de emergência atualizado com sucesso.' });
}));

// Deletar contato de emergência
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido.' });

  const [result] = await pool.query(
    'DELETE FROM contatos_emergencia WHERE id = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );

  if (result.affectedRows === 0) return res.status(404).json({ error: 'Contato de emergência não encontrado.' });

  await logAuditEvent(req, 'contato_emergencia_deletado', `Contato de emergência ID ${id} deletado`);
  res.json({ message: 'Contato de emergência removido com sucesso.' });
}));

module.exports = { router };

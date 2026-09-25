// Lista de motivos de falta (dropdown "Adicionar justificativa" na Chamada,
// ver frontend/src/Components/AttendanceList.jsx) — editável POR
// INSTITUIÇÃO, cada uma com a sua própria lista independente. O texto
// escolhido é gravado como string livre em `presenca.observacao` (sem FK
// pra cá) — editar/apagar uma justificativa aqui nunca muda um registro de
// presença já lançado, só as opções oferecidas dali pra frente.
//
// Reaproveita a permissão da tela "/" (Chamada) — não é uma tela própria de
// propósito: quem já lança/edita chamada numa instituição é exatamente quem
// deveria poder ajustar essa lista, sem precisar configurar uma tela nova em
// Permissões pra cada instituição existente.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { authMiddleware } = require('./auth');
const { exigirRecurso } = require('./permissoes-middleware');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(authMiddleware);
const exigir = (recurso) => exigirRecurso('/', recurso);

// Leitura livre pra qualquer usuário autenticado da instituição — é só a
// tela de Chamada precisando popular o próprio dropdown, sem exigir
// permissão de editar/criar pra isso.
router.get('/', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, texto FROM justificativas_falta WHERE id_instituicao = ? ORDER BY texto ASC',
    [req.id_instituicao]
  );
  res.json(rows);
}));

router.post('/', exigir('criar'), asyncHandler(async (req, res) => {
  const texto = String(req.body.texto || '').trim();
  if (!texto) return res.status(400).json({ error: 'Informe o texto da justificativa.' });
  if (texto.length > 150) return res.status(400).json({ error: 'Texto muito longo (máximo 150 caracteres).' });

  try {
    const [result] = await pool.query(
      'INSERT INTO justificativas_falta (id_instituicao, texto) VALUES (?, ?)',
      [req.id_instituicao, texto]
    );
    res.status(201).json({ id: result.insertId, texto, message: 'Justificativa criada.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Essa justificativa já existe.' });
    throw err;
  }
}));

router.put('/:id', exigir('editar'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const texto = String(req.body.texto || '').trim();
  if (!texto) return res.status(400).json({ error: 'Informe o texto da justificativa.' });
  if (texto.length > 150) return res.status(400).json({ error: 'Texto muito longo (máximo 150 caracteres).' });

  const [[existente]] = await pool.query(
    'SELECT id FROM justificativas_falta WHERE id = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );
  if (!existente) return res.status(404).json({ error: 'Justificativa não encontrada.' });

  try {
    await pool.query('UPDATE justificativas_falta SET texto = ? WHERE id = ?', [texto, id]);
    res.json({ message: 'Justificativa atualizada.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Essa justificativa já existe.' });
    throw err;
  }
}));

router.delete('/:id', exigir('excluir'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [result] = await pool.query(
    'DELETE FROM justificativas_falta WHERE id = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Justificativa não encontrada.' });
  res.json({ message: 'Justificativa removida.' });
}));

module.exports = router;

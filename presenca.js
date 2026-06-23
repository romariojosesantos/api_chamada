const express = require('express');
const router = express.Router();
const pool = require('./db');
const { validate } = require('./validation');
const { logAuditEvent } = require('./audit');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Buscar histórico de presença
router.get('/', asyncHandler(async (req, res) => {
  const sql = `
    SELECT p.aluno_id, a.nome, p.data, p.status, p.observacao
    FROM presenca p
    JOIN alunos a ON p.aluno_id = a.id
    WHERE p.id_instituicao = ?
    ORDER BY a.nome ASC, p.data DESC
  `;
  const [results] = await pool.query(sql, [req.id_instituicao]);
  res.json(results);
}));

// Salvar chamada (Upsert Lote)
router.post('/', validate('presenca'), asyncHandler(async (req, res) => {
  const { data, chamadas } = req.body;
  const connection = await pool.getConnection();

  try {
    if (chamadas.length === 0) return res.status(200).json({ message: 'Sem dados para salvar.' });

    await connection.beginTransaction();

    const sql = `
      INSERT INTO presenca (aluno_id, data, status, id_instituicao, observacao)
      VALUES ?
      ON DUPLICATE KEY UPDATE 
        status = VALUES(status),
        observacao = VALUES(observacao)
    `;
    const values = chamadas.map(c => [c.aluno_id, data, c.status, req.id_instituicao, c.observacao || null]);
    
    const [result] = await connection.query(sql, [values]);

    // Registrar evento na tabela de conexões/auditoria
    await logAuditEvent('SALVAR_CHAMADA_LOTE', `Data: ${data}, Alunos: ${chamadas.length}, Afetados: ${result.affectedRows}`, req.id_instituicao, connection);

    await connection.commit();

    res.status(201).json({ 
      message: 'Presenças processadas com sucesso!',
      detalhes: { total: chamadas.length, registros_afetados: result.affectedRows }
    });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}));

module.exports = router;
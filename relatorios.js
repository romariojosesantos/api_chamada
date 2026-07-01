const express = require('express');
const router = express.Router();
const pool = require('./db');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/estatisticas-diarias', asyncHandler(async (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).json({ error: 'Data é obrigatória.' });

  const [year, month, day] = data.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  const dias = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const diaDaSemana = dias[dateObj.getDay()];

  // 1. Total de alunos ativos na instituição
  const [ativosRes] = await pool.query(
    "SELECT COUNT(*) as total FROM alunos WHERE id_instituicao = ? AND status = 'ativo'",
    [req.id_instituicao]
  );

  // 2. Breakdown por turno (Alunos ativos)
  const [turnosRes] = await pool.query(
    "SELECT turno, COUNT(*) as total FROM alunos WHERE id_instituicao = ? AND status = 'ativo' GROUP BY turno",
    [req.id_instituicao]
  );

  // 3. Alunos esperados hoje (possuem matrícula para este dia da semana)
  const [esperadosRes] = await pool.query(
    `SELECT COUNT(DISTINCT a.id) as total 
     FROM alunos a 
     JOIN matricula m ON a.id = m.idaluno
     WHERE a.id_instituicao = ? AND a.status = 'ativo' AND TRIM(m.dia_semana) = ? AND m.status = 'matriculado'`,
    [req.id_instituicao, diaDaSemana]
  );

  res.json({
    data,
    dia_semana: diaDaSemana,
    total_ativos_instituicao: ativosRes[0].total,
    total_esperados_hoje: esperadosRes[0].total,
    ativos_por_turno: turnosRes
  });
}));

module.exports = router;
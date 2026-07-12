const express = require('express');
const router = express.Router();
const pool = require('./db');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Listar todas as matrículas/grade da instituição
router.get('/', asyncHandler(async (req, res) => {
  const sql = `
    SELECT m.idmatricula, m.idaluno, m.idatividades, m.turno, m.horario, m.dia_semana, m.status, m.id_instituicao,
           a.nome as nome_aluno,
           a.turno as aluno_turno, 
           a.transporte,
           atv.nome as nome_atividade,
           p.nome as nome_professor
    FROM matricula m
    JOIN alunos a ON m.idaluno = a.id
    LEFT JOIN atividades atv ON m.idatividades = atv.idatividades
    LEFT JOIN professores p ON atv.idprofessor = p.id
    WHERE m.id_instituicao = ?
    AND m.data_fim IS NULL
    ORDER BY a.nome ASC
  `;
  
  const [results] = await pool.query(sql, [req.id_instituicao]);
  res.json(results);
}));

module.exports = router;
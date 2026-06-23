const express = require('express');
const router = express.Router();
const pool = require('./db');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Listar todas as matrículas/grade da instituição
router.get('/', asyncHandler(async (req, res) => {
  const sql = `
    SELECT m.*, 
           a.nome as nome_aluno, 
           a.nome as aluno_nome,
           a.turno as aluno_turno, 
           a.transporte,
           at.nome as nome_atividade,
           at.exibir_no_resumo,
           p.nome as nome_professor
    FROM matricula m
    JOIN alunos a ON m.idaluno = a.id
    LEFT JOIN atividades at ON m.idatividades = at.idatividades
    LEFT JOIN professores p ON at.idprofessor = p.id
    WHERE m.id_instituicao = ?
    ORDER BY a.nome ASC
  `;
  
  const [results] = await pool.query(sql, [req.id_instituicao]);
  res.json(results);
}));

module.exports = router;
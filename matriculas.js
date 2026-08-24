const express = require('express');
const router = express.Router();
const pool = require('./db');
const { syncAlunoStatusFromMatriculas } = require('./status-sync');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Listar matrículas ativas por instituição, com vínculo aluno → atividade → dia da semana
router.get('/por-instituicao', asyncHandler(async (req, res) => {
  const { status, dia_semana } = req.query;

  let sql = `
    SELECT m.idmatricula AS id,
           a.id AS aluno_id,
           a.nome AS nome_aluno,
           a.turno AS aluno_turno,
           a.transporte,
           atv.idatividades AS id_atividade,
           atv.nome AS nome_atividade,
           m.dia_semana,
           m.horario,
           m.turno,
           m.status,
           p.nome AS nome_professor
    FROM matricula m
    JOIN alunos a ON m.idaluno = a.id
    LEFT JOIN atividades atv ON m.idatividades = atv.idatividades
    LEFT JOIN professores p ON atv.idprofessor = p.id
    WHERE m.id_instituicao = ?
    AND m.data_fim IS NULL
  `;
  const params = [req.id_instituicao];

  if (status) {
    sql += " AND m.status = ?";
    params.push(status);
  }

  if (dia_semana) {
    sql += " AND TRIM(m.dia_semana) = ?";
    params.push(dia_semana);
  }

  sql += " ORDER BY a.nome ASC, m.dia_semana ASC";

  const [results] = await pool.query(sql, params);
  res.json(results);
}));

// Buscar matrículas de um aluno específico (compatibilidade com frontend)
router.get('/aluno/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const sql = `
    SELECT m.idmatricula AS id,
           a.id AS aluno_id,
           a.nome AS nome_aluno,
           a.turno AS aluno_turno,
           a.transporte,
           atv.idatividades AS id_atividade,
           atv.nome AS nome_atividade,
           m.dia_semana,
           m.horario,
           m.turno,
           m.status,
           p.nome AS nome_professor
    FROM matricula m
    JOIN alunos a ON m.idaluno = a.id
    LEFT JOIN atividades atv ON m.idatividades = atv.idatividades
    LEFT JOIN professores p ON atv.idprofessor = p.id
    WHERE m.idaluno = ? AND m.id_instituicao = ?
    AND m.data_fim IS NULL
    ORDER BY m.dia_semana ASC
  `;

  const [results] = await pool.query(sql, [id, req.id_instituicao]);
  res.json(results);
}));

// Buscar histórico de matrículas por período (para relatórios de Excel)
router.get('/historico-periodo', asyncHandler(async (req, res) => {
  const { data_inicio, data_fim } = req.query;
  
  if (!data_inicio || !data_fim) {
    return res.status(400).json({ error: 'data_inicio e data_fim são obrigatórias' });
  }

  const sql = `
    SELECT m.idaluno,
           a.nome,
           m.idatividades,
           atv.nome AS nome_atividade,
           m.dia_semana,
           m.turno,
           m.data_inicio,
           m.data_fim,
           m.status AS matricula_status,
           m.id_instituicao
    FROM matricula m
    JOIN alunos a ON m.idaluno = a.id
    LEFT JOIN atividades atv ON m.idatividades = atv.idatividades
    WHERE m.id_instituicao = ?
    ORDER BY a.nome, m.data_inicio
  `;

  const [results] = await pool.query(sql, [req.id_instituicao]);
  res.json(results);
}));

// Atualizar matrículas em lote (para AjusteGrade)
router.post('/', asyncHandler(async (req, res) => {
  const { alteracoes } = req.body;
  
  if (!alteracoes || !Array.isArray(alteracoes) || alteracoes.length === 0) {
    return res.status(400).json({ error: 'Nenhuma alteração fornecida' });
  }

  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const results = [];
    
    for (const alteracao of alteracoes) {
      const { aluno_id, dia_semana, horario, id_atividade } = alteracao;
      
      if (!aluno_id || !dia_semana || !horario) {
        throw new Error('Dados incompletos na alteração');
      }
      
      // Buscar matrícula existente
      const [existing] = await connection.query(
        'SELECT idmatricula FROM matricula WHERE idaluno = ? AND dia_semana = ? AND horario = ? AND id_instituicao = ? AND data_fim IS NULL',
        [aluno_id, dia_semana, horario, req.id_instituicao]
      );
      
      if (id_atividade) {
        // Atualizar ou criar matrícula
        if (existing.length > 0) {
          await connection.query(
            'UPDATE matricula SET idatividades = ? WHERE idmatricula = ?',
            [id_atividade, existing[0].idmatricula]
          );
          results.push({ action: 'updated', id: existing[0].idmatricula });
        } else {
          // Buscar turno do aluno
          const [aluno] = await connection.query(
            'SELECT turno FROM alunos WHERE id = ?',
            [aluno_id]
          );
          
          const turno = aluno[0]?.turno || '';
          
          await connection.query(
            'INSERT INTO matricula (idaluno, idatividades, dia_semana, horario, turno, status, data_inicio, id_instituicao) VALUES (?, ?, ?, ?, ?, ?, CURDATE(), ?)',
            [aluno_id, id_atividade, dia_semana, horario, turno, 'matriculado', req.id_instituicao]
          );
          results.push({ action: 'created', aluno_id, dia_semana, horario });
        }
      } else {
        // Remover matrícula (id_atividade vazio)
        if (existing.length > 0) {
          await connection.query(
            'UPDATE matricula SET data_fim = CURDATE() WHERE idmatricula = ?',
            [existing[0].idmatricula]
          );
          results.push({ action: 'deleted', id: existing[0].idmatricula });
        }
      }
    }

    const idsParaSincronizar = [...new Set(alteracoes
      .map(alteracao => Number(alteracao.aluno_id))
      .filter(id => Number.isInteger(id) && id > 0))];

    await syncAlunoStatusFromMatriculas(connection, idsParaSincronizar, req.id_instituicao);
    await connection.commit();
    res.json({ success: true, updated: results.length, results });
    
  } catch (error) {
    await connection.rollback();
    console.error('Erro ao atualizar matrículas:', error);
    res.status(500).json({ error: 'Erro ao atualizar matrículas: ' + error.message });
  } finally {
    connection.release();
  }
}));

module.exports = router;

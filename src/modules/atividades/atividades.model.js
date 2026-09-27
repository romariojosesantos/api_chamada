// SQL de turmas (tabela `atividades`) e dos co-professores (atividade_professores).
const pool = require('../../config/database');

// Todas as turmas, inclusive encerradas, com professor e total de alunos ativos.
async function listar(idInstituicao) {
  const [rows] = await pool.query(
    `
    SELECT atv.idatividades AS id, atv.nome, atv.dia_semana, atv.horario, atv.turno, atv.idprofessor,
           atv.area, atv.data_inicio, atv.data_fim,
           p.nome AS nome_professor,
           (SELECT COUNT(*) FROM matricula m
            WHERE m.idatividades = atv.idatividades AND m.status = 'matriculado' AND m.data_fim IS NULL) AS total_alunos
    FROM atividades atv
    LEFT JOIN professores p ON atv.idprofessor = p.id
    WHERE atv.id_instituicao = ?
    ORDER BY atv.nome ASC, atv.dia_semana ASC, atv.turno ASC, atv.horario ASC
  `,
    [idInstituicao],
  );
  return rows;
}

async function coProfessores(idInstituicao) {
  const [rows] = await pool.query(
    `SELECT ap.idatividades, p.id, p.nome
     FROM atividade_professores ap
     JOIN professores p ON p.id = ap.idprofessor
     WHERE ap.id_instituicao = ?`,
    [idInstituicao],
  );
  return rows;
}

async function buscar(id, idInstituicao) {
  const [[turma]] = await pool.query(
    'SELECT idatividades, nome, data_fim, idprofessor FROM atividades WHERE idatividades = ? AND id_instituicao = ?',
    [id, idInstituicao],
  );
  return turma || null;
}

// Turma ativa idêntica (mesmo nome+professor+dia+horário+turno).
async function existeDuplicada(t, idInstituicao) {
  const [rows] = await pool.query(
    `SELECT idatividades FROM atividades
     WHERE nome = ? AND dia_semana = ? AND horario = ? AND turno = ? AND id_instituicao = ?
       AND idprofessor <=> ? AND data_fim IS NULL`,
    [t.nome, t.dia_semana, t.horario, t.turno, idInstituicao, t.idprofessor],
  );
  return rows.length > 0;
}

async function criar(t, idInstituicao) {
  const [result] = await pool.query(
    'INSERT INTO atividades (nome, idprofessor, id_instituicao, dia_semana, horario, turno, area, data_inicio) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [t.nome, t.idprofessor, idInstituicao, t.dia_semana, t.horario, t.turno, t.area, t.data_inicio],
  );
  return result.insertId;
}

async function atualizar(id, t, idInstituicao) {
  await pool.query(
    'UPDATE atividades SET nome = ?, idprofessor = ?, dia_semana = ?, horario = ?, turno = ?, area = ? WHERE idatividades = ? AND id_instituicao = ?',
    [t.nome, t.idprofessor, t.dia_semana, t.horario, t.turno, t.area, id, idInstituicao],
  );
}

// Toda matrícula de uma turma tem o mesmo dia/horário/turno da turma.
async function alinharMatriculas(id, t, idInstituicao) {
  await pool.query(
    'UPDATE matricula SET dia_semana = ?, horario = ?, turno = ? WHERE idatividades = ? AND id_instituicao = ?',
    [t.dia_semana, t.horario, t.turno, id, idInstituicao],
  );
}

async function reabrir(id) {
  await pool.query('UPDATE atividades SET data_fim = NULL WHERE idatividades = ?', [id]);
}

async function excluir(id, idInstituicao) {
  await pool.query('DELETE FROM atividades WHERE idatividades = ? AND id_instituicao = ?', [
    id,
    idInstituicao,
  ]);
}

async function contarMatriculas(id) {
  const [rows] = await pool.query(
    `SELECT
       SUM(CASE WHEN status = 'matriculado' AND data_fim IS NULL THEN 1 ELSE 0 END) AS ativas,
       COUNT(*) AS total
     FROM matricula WHERE idatividades = ?`,
    [id],
  );
  return rows[0];
}

async function historicoDeAlunos(id) {
  const [rows] = await pool.query(
    `SELECT m.idmatricula AS id, m.idaluno AS aluno_id, a.nome AS nome_aluno,
            m.data_inicio, m.data_fim, m.status
     FROM matricula m
     JOIN alunos a ON a.id = m.idaluno
     WHERE m.idatividades = ? AND m.data_fim IS NOT NULL
     ORDER BY m.data_fim DESC`,
    [id],
  );
  return rows;
}

// --- Encerramento (dentro de transação: recebe a conexão `db`) ---

async function marcarEncerrada(db, id, data) {
  await db.query('UPDATE atividades SET data_fim = ? WHERE idatividades = ?', [data, id]);
}

async function matriculasAtivas(db, id) {
  const [rows] = await db.query(
    `SELECT idmatricula, idaluno FROM matricula WHERE idatividades = ? AND status = 'matriculado' AND data_fim IS NULL`,
    [id],
  );
  return rows;
}

async function cancelarMatriculas(db, ids, data) {
  await db.query(
    `UPDATE matricula SET data_fim = ?, status = 'cancelada' WHERE idmatricula IN (?)`,
    [data, ids],
  );
}

// --- Professores ---

async function professorPorNome(nome, idInstituicao) {
  const [rows] = await pool.query(
    'SELECT id FROM professores WHERE nome = ? AND id_instituicao = ?',
    [nome, idInstituicao],
  );
  return rows[0]?.id ?? null;
}

async function criarProfessor(nome, idInstituicao) {
  const [result] = await pool.query(
    'INSERT INTO professores (nome, ativo, id_instituicao) VALUES (?, 1, ?)',
    [nome, idInstituicao],
  );
  return result.insertId;
}

async function buscarProfessor(id, idInstituicao) {
  const [[professor]] = await pool.query(
    'SELECT id, nome FROM professores WHERE id = ? AND id_instituicao = ?',
    [id, idInstituicao],
  );
  return professor || null;
}

async function ehCoProfessor(id, idProfessor) {
  const [[linha]] = await pool.query(
    'SELECT 1 FROM atividade_professores WHERE idatividades = ? AND idprofessor = ?',
    [id, idProfessor],
  );
  return !!linha;
}

async function adicionarCoProfessor(id, idProfessor, idInstituicao) {
  await pool.query(
    'INSERT INTO atividade_professores (idatividades, idprofessor, id_instituicao) VALUES (?, ?, ?)',
    [id, idProfessor, idInstituicao],
  );
}

async function removerCoProfessor(id, idProfessor, idInstituicao) {
  const [result] = await pool.query(
    'DELETE FROM atividade_professores WHERE idatividades = ? AND idprofessor = ? AND id_instituicao = ?',
    [id, idProfessor, idInstituicao],
  );
  return result.affectedRows;
}

module.exports = {
  listar,
  coProfessores,
  buscar,
  existeDuplicada,
  criar,
  atualizar,
  alinharMatriculas,
  reabrir,
  excluir,
  contarMatriculas,
  historicoDeAlunos,
  marcarEncerrada,
  matriculasAtivas,
  cancelarMatriculas,
  professorPorNome,
  criarProfessor,
  buscarProfessor,
  ehCoProfessor,
  adicionarCoProfessor,
  removerCoProfessor,
};

// SQL de matrículas. Uma matrícula com data_fim preenchida está encerrada
// (soft-delete): não é um intervalo de vigência, é "isso não vale mais".
const pool = require('../../../db');

const CAMPOS_MATRICULA_ATIVA = `
  SELECT m.idmatricula AS id,
         a.id AS aluno_id,
         a.nome AS nome_aluno,
         a.turno AS aluno_turno,
         a.transporte,
         (SELECT an.nivel FROM aluno_niveis an WHERE an.id_aluno = a.id AND an.id_instituicao = a.id_instituicao AND an.data_fim IS NULL ORDER BY an.data_inicio DESC LIMIT 1) AS nivel,
         (SELECT an.subnivel FROM aluno_niveis an WHERE an.id_aluno = a.id AND an.id_instituicao = a.id_instituicao AND an.data_fim IS NULL ORDER BY an.data_inicio DESC LIMIT 1) AS subnivel,
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
`;

// --- Consultas ---

async function listarAtivas({ status, dia_semana, id_atividade }, idInstituicao) {
  let sql = `${CAMPOS_MATRICULA_ATIVA} WHERE m.id_instituicao = ? AND m.data_fim IS NULL`;
  const params = [idInstituicao];
  if (status) {
    sql += ' AND m.status = ?';
    params.push(status);
  }
  // O banco pode ter espaços sobrando no dia da semana.
  if (dia_semana) {
    sql += ' AND TRIM(m.dia_semana) = ?';
    params.push(dia_semana);
  }
  if (id_atividade) {
    sql += ' AND m.idatividades = ?';
    params.push(id_atividade);
  }
  sql += ' ORDER BY a.nome ASC, m.dia_semana ASC';
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function listarAtivasDoAluno(idAluno, idInstituicao) {
  const [rows] = await pool.query(
    `${CAMPOS_MATRICULA_ATIVA}
     WHERE m.idaluno = ? AND m.id_instituicao = ?
     AND m.data_fim IS NULL
     ORDER BY m.dia_semana ASC`,
    [idAluno, idInstituicao],
  );
  return rows;
}

// Inclui as encerradas: a exportação precisa saber quem estava em cada dia do passado.
async function historico(idInstituicao) {
  const [rows] = await pool.query(
    `SELECT m.idaluno,
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
     ORDER BY a.nome, m.data_inicio`,
    [idInstituicao],
  );
  return rows;
}

// Grupos de matrículas ativas na mesma posição (aluno + dia + horário).
async function gruposDuplicados(idInstituicao) {
  const [rows] = await pool.query(
    `SELECT idaluno, dia_semana, horario, GROUP_CONCAT(idmatricula) AS ids
     FROM matricula
     WHERE id_instituicao = ? AND status = 'matriculado' AND data_fim IS NULL
     GROUP BY idaluno, dia_semana, horario
     HAVING COUNT(*) > 1`,
    [idInstituicao],
  );
  return rows;
}

async function detalhesDasMatriculas(ids) {
  const [rows] = await pool.query(
    `SELECT m.idmatricula, m.idaluno, a.nome AS nome_aluno, m.idatividades, atv.nome AS nome_turma,
            atv.dia_semana, atv.horario, atv.turno, p.nome AS nome_professor, m.data_inicio
     FROM matricula m
     JOIN alunos a ON a.id = m.idaluno
     LEFT JOIN atividades atv ON atv.idatividades = m.idatividades
     LEFT JOIN professores p ON p.id = atv.idprofessor
     WHERE m.idmatricula IN (?)
     ORDER BY m.idmatricula DESC`,
    [ids],
  );
  return rows;
}

async function buscarAtiva(id, idInstituicao) {
  const [[matricula]] = await pool.query(
    'SELECT idmatricula, idaluno, dia_semana, horario FROM matricula WHERE idmatricula = ? AND id_instituicao = ? AND data_fim IS NULL',
    [id, idInstituicao],
  );
  return matricula || null;
}

async function buscarParaCancelar(id, idInstituicao) {
  const [rows] = await pool.query(
    'SELECT idmatricula, idaluno FROM matricula WHERE idmatricula = ? AND id_instituicao = ? AND data_fim IS NULL',
    [id, idInstituicao],
  );
  return rows[0] || null;
}

// Matrícula de origem de um "mover", com a turma atual para a notificação.
async function buscarOrigem(id, idInstituicao) {
  const [rows] = await pool.query(
    `SELECT m.idmatricula, m.idaluno, atv.nome AS nome_turma, atv.dia_semana, atv.horario, atv.turno, p.nome AS nome_professor
     FROM matricula m
     LEFT JOIN atividades atv ON atv.idatividades = m.idatividades
     LEFT JOIN professores p ON p.id = atv.idprofessor
     WHERE m.idmatricula = ? AND m.id_instituicao = ? AND m.data_fim IS NULL`,
    [id, idInstituicao],
  );
  return rows[0] || null;
}

// Outras matrículas ativas na mesma posição, exceto `exceto`.
async function outrasNaPosicao(db, { idAluno, diaSemana, horario, exceto }, idInstituicao) {
  const [rows] = await db.query(
    `SELECT idmatricula FROM matricula
     WHERE id_instituicao = ? AND idaluno = ? AND dia_semana = ? AND horario = ?
       AND status = 'matriculado' AND data_fim IS NULL AND idmatricula != ?`,
    [idInstituicao, idAluno, diaSemana, horario, exceto],
  );
  return rows.map((r) => r.idmatricula);
}

// Posição ocupada? Não filtra por turno: dia + horário já é o horário real de
// aula (um ensaio da tarde e um da noite no mesmo HR ocupam o mesmo horário).
async function ocupacaoNoHorario(db, { idAluno, diaSemana, horario }, idInstituicao) {
  const [rows] = await db.query(
    `SELECT idmatricula, idatividades, (SELECT nome FROM atividades WHERE idatividades = matricula.idatividades) AS nome_turma_atual
     FROM matricula
     WHERE idaluno = ? AND dia_semana = ? AND horario = ?
       AND id_instituicao = ? AND data_fim IS NULL`,
    [idAluno, diaSemana, horario, idInstituicao],
  );
  return rows;
}

// pares [idaluno, dia, horario]: todas as matrículas ativas nessas posições, num SELECT só.
async function ativasNasPosicoes(db, posicoes, idInstituicao) {
  const placeholders = posicoes.map(() => '(?,?,?)').join(',');
  const [rows] = await db.query(
    `SELECT idmatricula, idaluno, dia_semana, horario, idatividades FROM matricula
     WHERE id_instituicao = ? AND data_fim IS NULL
       AND (idaluno, dia_semana, horario) IN (${placeholders})`,
    [idInstituicao, ...posicoes.flat()],
  );
  return rows;
}

// --- Turmas e alunos usados pelas regras de matrícula ---

async function buscarTurma(id, idInstituicao) {
  const [rows] = await pool.query(
    `SELECT atv.idatividades, atv.nome, atv.dia_semana, atv.horario, atv.turno, p.nome AS nome_professor
     FROM atividades atv LEFT JOIN professores p ON p.id = atv.idprofessor
     WHERE atv.idatividades = ? AND atv.id_instituicao = ?`,
    [id, idInstituicao],
  );
  return rows[0] || null;
}

async function turmasPorIds(db, ids) {
  const [rows] = await db.query(
    `SELECT atv.idatividades, atv.nome, atv.turno, p.nome AS nome_professor
     FROM atividades atv LEFT JOIN professores p ON p.id = atv.idprofessor
     WHERE atv.idatividades IN (?)`,
    [ids],
  );
  return rows;
}

async function buscarAluno(id, idInstituicao) {
  const [rows] = await pool.query(
    'SELECT id, nome, turno FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL',
    [id, idInstituicao],
  );
  return rows[0] || null;
}

async function nomeETurnoDoAluno(id) {
  const [[aluno]] = await pool.query('SELECT nome, turno FROM alunos WHERE id = ?', [id]);
  return aluno;
}

async function alunosPorIds(db, ids) {
  const [rows] = await db.query('SELECT id, nome, turno FROM alunos WHERE id IN (?)', [ids]);
  return rows;
}

// --- Escrita ---

async function inserir(db, m, idInstituicao) {
  await db.query(
    `INSERT INTO matricula (idaluno, idatividades, dia_semana, horario, turno, status, data_inicio, id_instituicao)
     VALUES (?, ?, ?, ?, ?, 'matriculado', CURDATE(), ?)`,
    [m.idAluno, m.idAtividade, m.diaSemana, m.horario, m.turno, idInstituicao],
  );
}

async function inserirVarias(db, matriculas, idInstituicao) {
  const valores = matriculas.map((x) => [
    x.aluno_id,
    x.id_atividade,
    x.dia_semana,
    x.horario,
    x.turno,
    'matriculado',
    idInstituicao,
  ]);
  await db.query(
    `INSERT INTO matricula (idaluno, idatividades, dia_semana, horario, turno, status, data_inicio, id_instituicao)
     VALUES ${valores.map(() => '(?, ?, ?, ?, ?, ?, CURDATE(), ?)').join(', ')}`,
    valores.flat(),
  );
}

async function encerrar(db, id) {
  await db.query(
    `UPDATE matricula SET data_fim = CURDATE(), status = 'cancelada' WHERE idmatricula = ?`,
    [id],
  );
}

async function encerrarVarias(db, ids) {
  await db.query(
    `UPDATE matricula SET data_fim = CURDATE(), status = 'cancelada' WHERE idmatricula IN (?)`,
    [ids],
  );
}

// itens: [{ id, id_atividade, turno }] — um UPDATE só, via CASE WHEN.
async function trocarTurmas(db, itens) {
  const casos = itens.map(() => 'WHEN ? THEN ?').join(' ');
  await db.query(
    `UPDATE matricula SET
       idatividades = CASE idmatricula ${casos} END,
       turno = CASE idmatricula ${casos} END
     WHERE idmatricula IN (?)`,
    [
      ...itens.flatMap((x) => [x.id, x.id_atividade]),
      ...itens.flatMap((x) => [x.id, x.turno]),
      itens.map((x) => x.id),
    ],
  );
}

module.exports = {
  listarAtivas,
  listarAtivasDoAluno,
  historico,
  gruposDuplicados,
  detalhesDasMatriculas,
  buscarAtiva,
  buscarParaCancelar,
  buscarOrigem,
  outrasNaPosicao,
  ocupacaoNoHorario,
  ativasNasPosicoes,
  buscarTurma,
  turmasPorIds,
  buscarAluno,
  nomeETurnoDoAluno,
  alunosPorIds,
  inserir,
  inserirVarias,
  encerrar,
  encerrarVarias,
  trocarTurmas,
};

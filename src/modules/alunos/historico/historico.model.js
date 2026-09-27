// SQL da ficha do aluno para o master. Sem filtro de instituição selecionada:
// o master vê/edita alunos de qualquer instituição.
const pool = require('../../../config/database');

async function buscarPorNome(termo, idInstituicao) {
  let sql = `SELECT a.id, a.nome, a.data_nascimento, a.sexo, a.telefone, a.turma, a.turno, a.transporte, a.Inf, a.status, a.id_instituicao, i.nome AS nome_instituicao,
       (SELECT an.nivel FROM aluno_niveis an WHERE an.id_aluno = a.id AND an.id_instituicao = a.id_instituicao AND an.data_fim IS NULL ORDER BY an.data_inicio DESC LIMIT 1) AS nivel,
       (SELECT an.subnivel FROM aluno_niveis an WHERE an.id_aluno = a.id AND an.id_instituicao = a.id_instituicao AND an.data_fim IS NULL ORDER BY an.data_inicio DESC LIMIT 1) AS subnivel
     FROM alunos a
     JOIN instituicoes i ON a.id_instituicao = i.id
     WHERE a.nome LIKE ? AND a.excluido_em IS NULL`;
  const params = [`%${termo}%`];
  if (idInstituicao !== null) {
    sql += ' AND a.id_instituicao = ?';
    params.push(idInstituicao);
  }
  sql += ' ORDER BY a.nome ASC LIMIT 50';
  const [rows] = await pool.query(sql, params);
  return rows;
}

// --- Ficha ---

async function buscarAluno(id) {
  const [[aluno]] = await pool.query(
    `SELECT a.*, i.nome AS nome_instituicao
     FROM alunos a
     JOIN instituicoes i ON a.id_instituicao = i.id
     WHERE a.id = ?`,
    [id],
  );
  return aluno || null;
}

// Todas as matrículas, inclusive encerradas (ao contrário do resto do sistema).
async function todasAsMatriculas(idAluno) {
  const [rows] = await pool.query(
    `SELECT m.idmatricula AS id,
            m.idaluno,
            m.idatividades,
            atv.nome AS nome_atividade,
            p.nome AS nome_professor,
            m.turno,
            m.horario,
            m.dia_semana,
            m.status,
            m.data_inicio,
            m.data_fim,
            m.id_instituicao
     FROM matricula m
     LEFT JOIN atividades atv ON m.idatividades = atv.idatividades
     LEFT JOIN professores p ON atv.idprofessor = p.id
     WHERE m.idaluno = ?
     ORDER BY m.data_inicio DESC, atv.nome ASC`,
    [idAluno],
  );
  return rows;
}

async function contatosDoAluno(idAluno) {
  const [rows] = await pool.query(
    `SELECT id, id_aluno, nome, telefone, parentesco
       FROM contatos_emergencia
       WHERE id_aluno = ?
       ORDER BY id`,
    [idAluno],
  );
  return rows;
}

async function presencasDoAluno(idAluno) {
  const [rows] = await pool.query(
    `SELECT p.id, p.aluno_id, p.data, p.status, p.observacao, p.id_instituicao
     FROM presenca p
     WHERE p.aluno_id = ?
     ORDER BY p.data DESC`,
    [idAluno],
  );
  return rows;
}

// --- Dados cadastrais ---

async function statusDoAluno(id) {
  const [[aluno]] = await pool.query('SELECT id_instituicao, status FROM alunos WHERE id = ?', [
    id,
  ]);
  return aluno || null;
}

async function alunoNaInstituicao(id, idInstituicao) {
  const [[aluno]] = await pool.query('SELECT id FROM alunos WHERE id = ? AND id_instituicao = ?', [
    id,
    idInstituicao,
  ]);
  return !!aluno;
}

async function atualizarAluno(id, dados) {
  await pool.query(
    `UPDATE alunos
     SET nome = ?, data_nascimento = ?, sexo = ?, telefone = ?, turma = ?, turno = ?, transporte = ?, Inf = ?, status = ?
     WHERE id = ?`,
    [
      dados.nome,
      dados.data_nascimento,
      dados.sexo,
      dados.telefone,
      dados.turma,
      dados.turno,
      dados.transporte,
      dados.Inf,
      dados.status,
      id,
    ],
  );
}

async function marcarInativadoHoje(id) {
  await pool.query('UPDATE alunos SET inativado_em = CURDATE() WHERE id = ?', [id]);
}

async function limparInativadoEm(id) {
  await pool.query('UPDATE alunos SET inativado_em = NULL WHERE id = ?', [id]);
}

// --- Matrículas ---

async function horarioDaTurma(idAtividade) {
  const [[turma]] = await pool.query(
    'SELECT dia_semana, horario, turno FROM atividades WHERE idatividades = ?',
    [idAtividade],
  );
  return turma || null;
}

async function buscarTurma(idAtividade) {
  const [[turma]] = await pool.query(
    'SELECT idatividades, nome, data_fim FROM atividades WHERE idatividades = ?',
    [idAtividade],
  );
  return turma || null;
}

async function matriculaParaEditar(id) {
  const [[matricula]] = await pool.query(
    'SELECT idmatricula, data_fim, idatividades FROM matricula WHERE idmatricula = ?',
    [id],
  );
  return matricula || null;
}

async function matriculaParaExcluir(id) {
  const [[matricula]] = await pool.query(
    'SELECT idmatricula, id_instituicao, data_fim FROM matricula WHERE idmatricula = ?',
    [id],
  );
  return matricula || null;
}

async function matriculaParaReabrir(id) {
  const [[matricula]] = await pool.query(
    'SELECT idmatricula, idaluno, idatividades, dia_semana, horario, data_fim, id_instituicao FROM matricula WHERE idmatricula = ?',
    [id],
  );
  return matricula || null;
}

async function instituicaoDaMatricula(id) {
  const [[matricula]] = await pool.query(
    'SELECT id_instituicao FROM matricula WHERE idmatricula = ?',
    [id],
  );
  return matricula?.id_instituicao;
}

async function atualizarMatricula(id, m) {
  await pool.query(
    `UPDATE matricula
     SET turno = ?, horario = ?, dia_semana = ?, status = ?, data_inicio = ?, data_fim = ?, idatividades = ?
     WHERE idmatricula = ?`,
    [m.turno, m.horario, m.dia_semana, m.status, m.data_inicio, m.data_fim, m.idatividades, id],
  );
}

async function criarMatricula(m) {
  const [result] = await pool.query(
    `INSERT INTO matricula (idaluno, idatividades, turno, horario, dia_semana, status, data_inicio, data_fim, id_instituicao)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      m.idaluno,
      m.idatividades,
      m.turno,
      m.horario,
      m.dia_semana,
      m.status,
      m.data_inicio,
      m.data_fim,
      m.id_instituicao,
    ],
  );
  return result.insertId;
}

async function excluirMatricula(id) {
  await pool.query('DELETE FROM matricula WHERE idmatricula = ?', [id]);
}

async function encerrarMatricula(id) {
  await pool.query('UPDATE matricula SET data_fim = CURDATE(), status = ? WHERE idmatricula = ?', [
    'cancelada',
    id,
  ]);
}

async function reabrirMatricula(id) {
  await pool.query(
    `UPDATE matricula SET data_fim = NULL, status = 'matriculado' WHERE idmatricula = ?`,
    [id],
  );
}

// Outra matrícula ativa do aluno na mesma posição da grade (dia + horário).
async function temConflitoNaPosicao({ idAluno, diaSemana, horario, exceto }) {
  const [rows] = await pool.query(
    `SELECT idmatricula FROM matricula
     WHERE idaluno = ? AND dia_semana = ? AND horario = ? AND status = 'matriculado' AND data_fim IS NULL AND idmatricula != ?`,
    [idAluno, diaSemana, horario, exceto],
  );
  return rows.length > 0;
}

// --- Contatos de emergência ---

async function atualizarContato(id, c) {
  const [result] = await pool.query(
    'UPDATE contatos_emergencia SET nome = ?, telefone = ?, parentesco = ? WHERE id = ?',
    [c.nome, c.telefone, c.parentesco, id],
  );
  return result.affectedRows;
}

async function criarContato(c) {
  const [result] = await pool.query(
    'INSERT INTO contatos_emergencia (id_aluno, nome, telefone, parentesco, id_instituicao) VALUES (?, ?, ?, ?, ?)',
    [c.id_aluno, c.nome, c.telefone, c.parentesco, c.id_instituicao],
  );
  return result.insertId;
}

async function excluirContato(id) {
  const [result] = await pool.query('DELETE FROM contatos_emergencia WHERE id = ?', [id]);
  return result.affectedRows;
}

async function instituicaoDoContato(id) {
  const [[contato]] = await pool.query(
    'SELECT id_instituicao FROM contatos_emergencia WHERE id = ?',
    [id],
  );
  return contato?.id_instituicao;
}

module.exports = {
  buscarPorNome,
  buscarAluno,
  todasAsMatriculas,
  contatosDoAluno,
  presencasDoAluno,
  statusDoAluno,
  alunoNaInstituicao,
  atualizarAluno,
  marcarInativadoHoje,
  limparInativadoEm,
  horarioDaTurma,
  buscarTurma,
  matriculaParaEditar,
  matriculaParaExcluir,
  matriculaParaReabrir,
  instituicaoDaMatricula,
  atualizarMatricula,
  criarMatricula,
  excluirMatricula,
  encerrarMatricula,
  reabrirMatricula,
  temConflitoNaPosicao,
  atualizarContato,
  criarContato,
  excluirContato,
  instituicaoDoContato,
};

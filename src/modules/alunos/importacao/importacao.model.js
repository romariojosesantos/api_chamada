// SQL da importação em massa. Tudo roda na conexão da transação (`db`).
const pool = require('../../../config/database');

async function nomesDeAlunos(db, idInstituicao) {
  const [rows] = await db.query(
    'SELECT nome FROM alunos WHERE id_instituicao = ? AND excluido_em IS NULL',
    [idInstituicao],
  );
  return rows.map((r) => r.nome);
}

async function nomesDeProfessores(db, idInstituicao) {
  const [rows] = await db.query('SELECT nome FROM professores WHERE id_instituicao = ?', [
    idInstituicao,
  ]);
  return rows.map((r) => r.nome);
}

async function turnosPorNome(db, nomes, idInstituicao) {
  const [rows] = await db.query(
    `SELECT nome, turno FROM alunos WHERE nome IN (?) AND id_instituicao = ? AND excluido_em IS NULL`,
    [nomes, idInstituicao],
  );
  return new Map(rows.map((a) => [a.nome, a.turno]));
}

// `data_cadastro` e `criado_em` ficam fora do UPDATE: são do primeiro cadastro
// e uma reimportação nunca os sobrescreve.
async function upsertAlunos(db, valores) {
  const [result] = await db.query(
    `INSERT INTO alunos (nome, data_nascimento, data_cadastro, sexo, telefone, turma, turno, transporte, Inf, acompanhamento, ponto, informacoes_gerais, escola_atual, status, id_instituicao, criado_em)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       data_nascimento = VALUES(data_nascimento),
       sexo = VALUES(sexo),
       telefone = VALUES(telefone),
       turma = VALUES(turma),
       turno = VALUES(turno),
       transporte = VALUES(transporte),
       Inf = VALUES(Inf),
       acompanhamento = VALUES(acompanhamento),
       ponto = VALUES(ponto),
       informacoes_gerais = VALUES(informacoes_gerais),
       escola_atual = VALUES(escola_atual)`,
    [valores],
  );
  return result.affectedRows;
}

// Excluídos (lixeira) ficam de fora: reimportar o mesmo nome não os reativa.
async function alunosPorNome(db, nomes, idInstituicao) {
  const [rows] = await db.query(
    `SELECT id, nome, turno, status FROM alunos WHERE nome IN (?) AND id_instituicao = ? AND excluido_em IS NULL`,
    [nomes, idInstituicao],
  );
  return rows;
}

// pares: [[idAluno, status], ...]
async function aplicarStatus(db, pares, idInstituicao) {
  const caseWhen = pares.map(([id]) => `WHEN ${id} THEN ?`).join(' ');
  const ids = pares.map(([id]) => id);
  await db.query(
    `UPDATE alunos SET status = CASE id ${caseWhen} END WHERE id IN (${ids.map(() => '?').join(',')}) AND id_instituicao = ?`,
    [...pares.map(([, status]) => status), ...ids, idInstituicao],
  );
}

async function professoresPorNome(db, nomes, idInstituicao) {
  const [rows] = await db.query(
    `SELECT id, nome FROM professores WHERE nome IN (?) AND id_instituicao = ?`,
    [nomes, idInstituicao],
  );
  return rows;
}

async function inserirProfessores(db, nomes, idInstituicao) {
  await db.query(`INSERT INTO professores (nome, id_instituicao) VALUES ?`, [
    nomes.map((nome) => [nome, idInstituicao]),
  ]);
}

async function turmasPorNome(db, nomes, idInstituicao) {
  const [rows] = await db.query(
    `SELECT idatividades, nome, idprofessor, area, dia_semana, horario, turno FROM atividades WHERE nome IN (?) AND id_instituicao = ?`,
    [nomes, idInstituicao],
  );
  return rows;
}

// Devolve o id da primeira turma criada: num insert em lote na mesma conexão
// o MySQL gera ids contíguos, na ordem dos VALUES.
async function inserirTurmas(db, valores) {
  const [result] = await db.query(
    `INSERT INTO atividades (nome, idprofessor, area, id_instituicao, dia_semana, horario, turno) VALUES ?`,
    [valores],
  );
  return result.insertId;
}

// pares: [[idProfessor, idTurma], ...] — um UPDATE só, via CASE WHEN.
async function atualizarProfessorDasTurmas(db, pares, idInstituicao) {
  const caseWhen = pares
    .map(([idProfessor, idTurma]) => `WHEN ${idTurma} THEN ${idProfessor}`)
    .join(' ');
  const ids = pares.map(([, idTurma]) => idTurma).join(',');
  await db.query(
    `UPDATE atividades SET idprofessor = CASE idatividades ${caseWhen} END WHERE idatividades IN (${ids}) AND id_instituicao = ?`,
    [idInstituicao],
  );
}

// pares: [[area, idTurma], ...]
async function atualizarAreaDasTurmas(db, pares, idInstituicao) {
  const caseWhen = pares
    .map(([area, idTurma]) => `WHEN ${idTurma} THEN ${pool.escape(area)}`)
    .join(' ');
  const ids = pares.map(([, idTurma]) => idTurma).join(',');
  await db.query(
    `UPDATE atividades SET area = CASE idatividades ${caseWhen} END WHERE idatividades IN (${ids}) AND id_instituicao = ?`,
    [idInstituicao],
  );
}

async function matriculasAtivas(db, idsAlunos, idInstituicao) {
  const [rows] = await db.query(
    `SELECT idmatricula, idaluno, idatividades, turno, horario, dia_semana
     FROM matricula
     WHERE idaluno IN (?) AND id_instituicao = ? AND status = 'matriculado' AND data_fim IS NULL`,
    [idsAlunos, idInstituicao],
  );
  return rows;
}

async function encerrarMatriculas(db, idsMatriculas, data) {
  await db.query(
    `UPDATE matricula SET data_fim = ?, status = 'cancelada' WHERE idmatricula IN (?)`,
    [data, idsMatriculas],
  );
}

async function inserirMatriculas(db, valores) {
  const [result] = await db.query(
    `INSERT INTO matricula (idaluno, idatividades, turno, horario, dia_semana, id_instituicao, data_inicio, status)
     VALUES ?`,
    [valores],
  );
  return result.affectedRows;
}

async function niveisAbertos(db, idsAlunos, idInstituicao) {
  const [rows] = await db.query(
    `SELECT id, id_aluno, nivel, subnivel FROM aluno_niveis WHERE id_aluno IN (?) AND id_instituicao = ? AND data_fim IS NULL`,
    [idsAlunos, idInstituicao],
  );
  return rows;
}

async function encerrarNiveis(db, idsNiveis, data) {
  await db.query(`UPDATE aluno_niveis SET data_fim = ? WHERE id IN (?)`, [data, idsNiveis]);
}

async function inserirNiveis(db, valores) {
  const [result] = await db.query(
    `INSERT INTO aluno_niveis (id_instituicao, id_aluno, nivel, subnivel, data_inicio) VALUES ?`,
    [valores],
  );
  return result.affectedRows;
}

// COALESCE: célula vazia na planilha não apaga o que já estava salvo.
async function upsertSituacoesAnuais(db, valores) {
  const [result] = await db.query(
    `INSERT INTO aluno_situacao_anual (id_instituicao, id_aluno, ano, situacao_matricula, situacao_divida)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       situacao_matricula = COALESCE(VALUES(situacao_matricula), situacao_matricula),
       situacao_divida = COALESCE(VALUES(situacao_divida), situacao_divida)`,
    [valores],
  );
  return result.affectedRows;
}

async function observacoesSaude(db, idsAlunos, idInstituicao) {
  const [rows] = await db.query(
    `SELECT id_aluno, descricao FROM aluno_saude WHERE id_aluno IN (?) AND id_instituicao = ?`,
    [idsAlunos, idInstituicao],
  );
  return rows;
}

async function inserirObservacoesSaude(db, valores) {
  const [result] = await db.query(
    `INSERT INTO aluno_saude (id_instituicao, id_aluno, descricao) VALUES ?`,
    [valores],
  );
  return result.affectedRows;
}

// COALESCE: uma reimportação parcial (ex.: só o telefone) não apaga CPF/RG/endereço.
async function upsertResponsaveis(db, valores) {
  const [result] = await db.query(
    `INSERT INTO responsavel_legal
       (id_instituicao, id_aluno, nome, cpf, rg, data_nascimento, email, endereco, bairro, cep, telefone)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       nome = COALESCE(VALUES(nome), nome),
       cpf = COALESCE(VALUES(cpf), cpf),
       rg = COALESCE(VALUES(rg), rg),
       data_nascimento = COALESCE(VALUES(data_nascimento), data_nascimento),
       email = COALESCE(VALUES(email), email),
       endereco = COALESCE(VALUES(endereco), endereco),
       bairro = COALESCE(VALUES(bairro), bairro),
       cep = COALESCE(VALUES(cep), cep),
       telefone = COALESCE(VALUES(telefone), telefone)`,
    [valores],
  );
  return result.affectedRows;
}

module.exports = {
  nomesDeAlunos,
  nomesDeProfessores,
  turnosPorNome,
  upsertAlunos,
  alunosPorNome,
  aplicarStatus,
  professoresPorNome,
  inserirProfessores,
  turmasPorNome,
  inserirTurmas,
  atualizarProfessorDasTurmas,
  atualizarAreaDasTurmas,
  matriculasAtivas,
  encerrarMatriculas,
  inserirMatriculas,
  niveisAbertos,
  encerrarNiveis,
  inserirNiveis,
  upsertSituacoesAnuais,
  observacoesSaude,
  inserirObservacoesSaude,
  upsertResponsaveis,
};

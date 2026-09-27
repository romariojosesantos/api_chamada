// SQL do ponto dos educadores (tabela `pontos`). Uma linha é OU uma aula
// (id_atividade) OU uma atividade interna (id_tipo_interno) — ver pontos.service.js.
const pool = require('../../config/database');

// Datas/horas saem já formatadas como texto: o valor gravado é a hora de
// Brasília e não pode passar por conversão de fuso do driver.
const HORA_ENTRADA = "DATE_FORMAT(pt.hora_entrada, '%Y-%m-%dT%H:%i:%s') AS hora_entrada";
const HORA_SAIDA = "DATE_FORMAT(pt.hora_saida, '%Y-%m-%dT%H:%i:%s') AS hora_saida";

// "É do professor" = principal (idprofessor) OU co-professor (ver
// atividade_professores, co-docência) — mesma regra em toda consulta que
// decide o que um professor pode ver/bater. Usa o id do professor 2 vezes.
const EH_DO_PROFESSOR =
  'atv.idprofessor = ? OR atv.idatividades IN (SELECT idatividades FROM atividade_professores WHERE idprofessor = ?)';

// Filtro opcional por área (coordenador de área): turma ou tipo interno.
function filtroDeArea(area, params) {
  if (!area) return '';
  params.push(area);
  return ' AND COALESCE(atv.area, tpi.area) = ?';
}

// --- Tela do educador ---

async function turmasDoDia(idProfessor, data, diaSemana, idInstituicao) {
  const [rows] = await pool.query(
    `SELECT atv.idatividades AS id_atividade, atv.nome, atv.horario, atv.turno,
            pt.id AS id_ponto, ${HORA_ENTRADA}, ${HORA_SAIDA}
     FROM atividades atv
     LEFT JOIN pontos pt ON pt.id_atividade = atv.idatividades AND pt.id_professor = ? AND pt.data = ?
     WHERE atv.id_instituicao = ? AND (${EH_DO_PROFESSOR}) AND atv.dia_semana = ? AND atv.data_fim IS NULL
     ORDER BY atv.horario ASC, atv.nome ASC`,
    [idProfessor, data, idInstituicao, idProfessor, idProfessor, diaSemana],
  );
  return rows;
}

// Tipos internos das áreas onde o educador dá aula ATUALMENTE (qualquer dia
// da semana). `atv.data_fim IS NULL` é essencial: sem isso, um educador que já
// deu aula em outra área no passado (turma já encerrada) continuava vendo os
// tipos internos daquela área pra sempre — bug real, já reproduzido (um
// educador só de "Arte e Cultura" enxergava tipo de "Educação por Princípios"
// por causa de uma turma antiga encerrada). Uma atividade interna pode ser
// batida VÁRIAS vezes no mesmo dia, por isso o join só traz a sessão em ABERTO
// de hoje (`hora_saida IS NULL`): sessões encerradas ficam só no histórico e
// sempre dá para abrir uma nova.
async function tiposInternosDoProfessor(idProfessor, data, idInstituicao) {
  const [rows] = await pool.query(
    `SELECT t.id AS id_tipo_interno, t.nome, t.area, pt.id AS id_ponto, ${HORA_ENTRADA}, ${HORA_SAIDA}
     FROM tipos_ponto_interno t
     LEFT JOIN pontos pt ON pt.id_tipo_interno = t.id AND pt.id_professor = ? AND pt.data = ? AND pt.hora_saida IS NULL
     WHERE t.id_instituicao = ? AND t.ativo = 1
       AND t.area IN (SELECT DISTINCT area FROM atividades atv WHERE (${EH_DO_PROFESSOR}) AND atv.data_fim IS NULL AND id_instituicao = ?)
     ORDER BY t.area ASC, t.nome ASC`,
    [idProfessor, data, idInstituicao, idProfessor, idProfessor, idInstituicao],
  );
  return rows;
}

// Ordena por `pt.hora_entrada DESC` dentro do dia — NUNCA por `atv.horario`,
// que só existe pra turma (pra atividade interna vem NULL, e com várias
// sessões da mesma atividade no dia a ordem ficava indefinida).
async function historicoDoProfessor(idProfessor, dataInicio, dataFim, idInstituicao) {
  const [rows] = await pool.query(
    `SELECT pt.id, pt.data, ${HORA_ENTRADA}, ${HORA_SAIDA},
            COALESCE(atv.nome, tpi.nome) AS nome_turma,
            COALESCE(atv.area, tpi.area) AS area,
            atv.dia_semana, atv.horario, atv.turno
     FROM pontos pt
     LEFT JOIN atividades atv ON atv.idatividades = pt.id_atividade
     LEFT JOIN tipos_ponto_interno tpi ON tpi.id = pt.id_tipo_interno
     WHERE pt.id_professor = ? AND pt.id_instituicao = ? AND pt.data BETWEEN ? AND ?
     ORDER BY pt.data DESC, pt.hora_entrada DESC`,
    [idProfessor, idInstituicao, dataInicio, dataFim],
  );
  return rows;
}

// --- Visão agregada (coordenação) ---

async function listar({ dataInicio, dataFim, idProfessor, area }, idInstituicao) {
  const params = [idInstituicao, dataInicio, dataFim];
  let filtros = '';
  if (idProfessor) {
    filtros += ' AND pt.id_professor = ?';
    params.push(idProfessor);
  }
  filtros += filtroDeArea(area, params);

  const [rows] = await pool.query(
    `SELECT pt.id, pt.id_atividade, pt.data, ${HORA_ENTRADA}, ${HORA_SAIDA},
            pt.id_professor, p.nome AS nome_professor,
            COALESCE(atv.nome, tpi.nome) AS nome_turma,
            COALESCE(atv.area, tpi.area) AS area,
            atv.dia_semana, atv.horario, atv.turno
     FROM pontos pt
     JOIN professores p ON p.id = pt.id_professor
     LEFT JOIN atividades atv ON atv.idatividades = pt.id_atividade
     LEFT JOIN tipos_ponto_interno tpi ON tpi.id = pt.id_tipo_interno
     WHERE pt.id_instituicao = ? AND pt.data BETWEEN ? AND ?${filtros}
     ORDER BY pt.data DESC, p.nome ASC, pt.hora_entrada DESC`,
    params,
  );
  return rows;
}

async function educadoresComPonto(area, idInstituicao) {
  const params = [idInstituicao];
  const filtro = filtroDeArea(area, params);
  const [rows] = await pool.query(
    `SELECT DISTINCT p.id, p.nome
     FROM pontos pt
     JOIN professores p ON p.id = pt.id_professor
     LEFT JOIN atividades atv ON atv.idatividades = pt.id_atividade
     LEFT JOIN tipos_ponto_interno tpi ON tpi.id = pt.id_tipo_interno
     WHERE pt.id_instituicao = ?${filtro}
     ORDER BY p.nome ASC`,
    params,
  );
  return rows;
}

async function linhasDoRelatorio({ dataInicio, dataFim, idProfessor, area }, idInstituicao) {
  const params = [idInstituicao, dataInicio, dataFim, idProfessor];
  const filtro = filtroDeArea(area, params);
  const [rows] = await pool.query(
    `SELECT pt.data, ${HORA_ENTRADA}, ${HORA_SAIDA},
            COALESCE(atv.nome, tpi.nome) AS nome_turma
     FROM pontos pt
     LEFT JOIN atividades atv ON atv.idatividades = pt.id_atividade
     LEFT JOIN tipos_ponto_interno tpi ON tpi.id = pt.id_tipo_interno
     WHERE pt.id_instituicao = ? AND pt.data BETWEEN ? AND ? AND pt.id_professor = ?${filtro}
     ORDER BY pt.data ASC, pt.hora_entrada ASC`,
    params,
  );
  return rows;
}

async function buscarProfessor(idProfessor, idInstituicao) {
  const [[professor]] = await pool.query(
    'SELECT nome, nome_completo FROM professores WHERE id = ? AND id_instituicao = ?',
    [idProfessor, idInstituicao],
  );
  return professor || null;
}

// E-mail vem do login vinculado (professores não tem coluna de e-mail).
async function emailDoProfessor(idProfessor) {
  const [[usuario]] = await pool.query(
    "SELECT email FROM usuarios WHERE id_professor = ? AND perfil = 'professor' LIMIT 1",
    [idProfessor],
  );
  return usuario?.email || '';
}

async function nomeDaInstituicao(idInstituicao) {
  const [[instituicao]] = await pool.query('SELECT nome FROM instituicoes WHERE id = ?', [
    idInstituicao,
  ]);
  return instituicao?.nome || '';
}

// --- Bater ponto ---

async function buscarTurmaAtiva(idAtividade, idInstituicao) {
  const [[turma]] = await pool.query(
    'SELECT idatividades, dia_semana, idprofessor FROM atividades WHERE idatividades = ? AND id_instituicao = ? AND data_fim IS NULL',
    [idAtividade, idInstituicao],
  );
  return turma || null;
}

async function ehCoProfessor(idAtividade, idProfessor) {
  const [[linha]] = await pool.query(
    'SELECT 1 FROM atividade_professores WHERE idatividades = ? AND idprofessor = ?',
    [idAtividade, idProfessor],
  );
  return !!linha;
}

// Tipo interno ativo de uma área onde o professor já deu aula.
async function tipoInternoPermitido(idTipo, idProfessor, idInstituicao) {
  const [[tipo]] = await pool.query(
    `SELECT t.id FROM tipos_ponto_interno t
     WHERE t.id = ? AND t.id_instituicao = ? AND t.ativo = 1
       AND t.area IN (
         SELECT DISTINCT area FROM atividades atv
         WHERE id_instituicao = ? AND (${EH_DO_PROFESSOR})
       )`,
    [idTipo, idInstituicao, idInstituicao, idProfessor, idProfessor],
  );
  return !!tipo;
}

// O ponto em aberto (entrada sem saída) do professor no dia, turma ou interno.
async function buscarPontoAberto(idProfessor, data, idInstituicao) {
  const [[aberto]] = await pool.query(
    `SELECT pt.id, COALESCE(atv.nome, tpi.nome) AS nome
     FROM pontos pt
     LEFT JOIN atividades atv ON atv.idatividades = pt.id_atividade
     LEFT JOIN tipos_ponto_interno tpi ON tpi.id = pt.id_tipo_interno
     WHERE pt.id_professor = ? AND pt.data = ? AND pt.id_instituicao = ?
       AND pt.hora_entrada IS NOT NULL AND pt.hora_saida IS NULL`,
    [idProfessor, data, idInstituicao],
  );
  return aberto || null;
}

async function pontoDaTurmaNoDia(idProfessor, idAtividade, data) {
  const [[ponto]] = await pool.query(
    'SELECT id, hora_entrada FROM pontos WHERE id_professor = ? AND id_atividade = ? AND data = ?',
    [idProfessor, idAtividade, data],
  );
  return ponto || null;
}

async function pontoDaTurmaNaInstituicao(idProfessor, idAtividade, data, idInstituicao) {
  const [[ponto]] = await pool.query(
    'SELECT id, hora_entrada, hora_saida FROM pontos WHERE id_professor = ? AND id_atividade = ? AND data = ? AND id_instituicao = ?',
    [idProfessor, idAtividade, data, idInstituicao],
  );
  return ponto || null;
}

async function sessaoInternaAberta(idProfessor, idTipo, data, idInstituicao) {
  const [[ponto]] = await pool.query(
    'SELECT id FROM pontos WHERE id_professor = ? AND id_tipo_interno = ? AND data = ? AND id_instituicao = ? AND hora_entrada IS NOT NULL AND hora_saida IS NULL ORDER BY hora_entrada DESC LIMIT 1',
    [idProfessor, idTipo, data, idInstituicao],
  );
  return ponto || null;
}

async function marcarEntrada(id, hora) {
  await pool.query('UPDATE pontos SET hora_entrada = ? WHERE id = ?', [hora, id]);
}

async function marcarSaida(id, hora) {
  await pool.query('UPDATE pontos SET hora_saida = ? WHERE id = ?', [hora, id]);
}

async function criarEntradaTurma({ idProfessor, idAtividade, data, hora }, idInstituicao) {
  const [result] = await pool.query(
    'INSERT INTO pontos (id_instituicao, id_professor, id_atividade, data, hora_entrada) VALUES (?, ?, ?, ?, ?)',
    [idInstituicao, idProfessor, idAtividade, data, hora],
  );
  return result.insertId;
}

async function criarEntradaInterna({ idProfessor, idTipo, data, hora }, idInstituicao) {
  const [result] = await pool.query(
    'INSERT INTO pontos (id_instituicao, id_professor, id_tipo_interno, data, hora_entrada) VALUES (?, ?, ?, ?, ?)',
    [idInstituicao, idProfessor, idTipo, data, hora],
  );
  return result.insertId;
}

// --- Correção pela coordenação ---

async function buscarPorId(id, idInstituicao) {
  const [[ponto]] = await pool.query(
    'SELECT id, id_professor, id_atividade, id_tipo_interno FROM pontos WHERE id = ? AND id_instituicao = ?',
    [id, idInstituicao],
  );
  return ponto || null;
}

// Área da turma ou do tipo interno de um ponto.
async function areaDoPonto(ponto) {
  const [[linha]] = ponto.id_atividade
    ? await pool.query('SELECT area FROM atividades WHERE idatividades = ?', [ponto.id_atividade])
    : await pool.query('SELECT area FROM tipos_ponto_interno WHERE id = ?', [
        ponto.id_tipo_interno,
      ]);
  return linha?.area;
}

async function atualizarHorarios(id, horaEntrada, horaSaida) {
  await pool.query('UPDATE pontos SET hora_entrada = ?, hora_saida = ? WHERE id = ?', [
    horaEntrada,
    horaSaida,
    id,
  ]);
}

async function excluir(id) {
  await pool.query('DELETE FROM pontos WHERE id = ?', [id]);
}

module.exports = {
  turmasDoDia,
  tiposInternosDoProfessor,
  historicoDoProfessor,
  listar,
  educadoresComPonto,
  linhasDoRelatorio,
  buscarProfessor,
  emailDoProfessor,
  nomeDaInstituicao,
  buscarTurmaAtiva,
  ehCoProfessor,
  tipoInternoPermitido,
  buscarPontoAberto,
  pontoDaTurmaNoDia,
  pontoDaTurmaNaInstituicao,
  sessaoInternaAberta,
  marcarEntrada,
  marcarSaida,
  criarEntradaTurma,
  criarEntradaInterna,
  buscarPorId,
  areaDoPonto,
  atualizarHorarios,
  excluir,
};

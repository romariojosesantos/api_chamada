// Importação em massa da planilha da grade (aba de alunos + aba opcional de
// atividades), numa transação só: se algo falhar, nada é gravado.
//
// A planilha só cria/atualiza quem ela menciona. Aluno ausente não é tocado:
// tratar ausência como desistência já inativou alunos em massa por engano.
// A matrícula é a fonte da verdade do status (ver syncAlunoStatusFromMatriculas).
const pool = require('../../../../db');
const model = require('./importacao.model');
const planilha = require('./planilha');
const matriculas = require('./matriculas');
const complementares = require('./complementares');
const { prepararTurmas } = require('./turmas');
const { criarResolvedorDeNomes } = require('./nomes');
const { syncAlunoStatusFromMatriculas } = require('../../../../status-sync');
const { hojeBrasil, agoraBrasil } = require('../../../utils/data-brasil');

// Aba "Atividades": professor e área declarados para cada nome de turma.
function lerAbaAtividades(atividades, resolverProfessor) {
  const nomesDeTurma = new Set();
  const professorPorTurma = new Map();
  const areaPorTurma = new Map();
  for (const atv of atividades) {
    const { nome, professor, area } = planilha.lerLinhaDeAtividade(atv);
    const professorFinal = professor ? resolverProfessor(professor) : '';
    if (!nome) continue;
    nomesDeTurma.add(nome);
    if (professorFinal) professorPorTurma.set(nome, professorFinal);
    if (area) areaPorTurma.set(nome, area);
  }
  return { nomesDeTurma, professorPorTurma, areaPorTurma };
}

// Status explícito da planilha (ex.: "espera"), aplicado à parte do upsert
// para que aluno novo sem a coluna continue 'ativo' e aluno existente sem a
// coluna não tenha o status mexido.
function lerStatusExplicitos(alunos, alunoPorNome) {
  const pares = [];
  for (const linha of alunos) {
    const idAluno = alunoPorNome.get(planilha.nomeDaLinha(linha))?.id;
    if (!idAluno || !linha.status) continue;
    const status = planilha.lerStatus(linha);
    if (status) pares.push([idAluno, status]);
  }
  return pares;
}

async function importar(db, alunos, atividades, idInstituicao) {
  const hoje = hojeBrasil();

  // 1. Corrige grafia de nomes que já existem (acento, maiúscula, espaço).
  const [nomesAlunos, nomesProfessores] = await Promise.all([
    model.nomesDeAlunos(db, idInstituicao),
    model.nomesDeProfessores(db, idInstituicao),
  ]);
  const nomes = criarResolvedorDeNomes();
  for (const linha of alunos) {
    linha.nome = nomes.resolver('aluno', planilha.nomeOriginalDaLinha(linha), nomesAlunos);
  }

  // 2. Turno de antes do upsert, para detectar troca de turno depois.
  const turnoAntigoPorNome = await model.turnosPorNome(
    db,
    alunos.map(planilha.nomeDaLinha),
    idInstituicao,
  );

  // 3. Cria/atualiza os alunos e recarrega os ids (insertId não serve em upsert de lote).
  const alunosAfetados = await model.upsertAlunos(
    db,
    alunos.map((linha) => planilha.valoresDoAluno(linha, hoje, agoraBrasil(), idInstituicao)),
  );
  const cadastrados = await model.alunosPorNome(
    db,
    alunos.map(planilha.nomeDaLinha),
    idInstituicao,
  );
  const alunoPorNome = new Map(
    cadastrados.map((a) => [a.nome, { id: a.id, turno: a.turno, status: a.status }]),
  );
  const nomePorIdAluno = new Map(cadastrados.map((a) => [a.id, a.nome]));

  const statusExplicitos = lerStatusExplicitos(alunos, alunoPorNome);
  if (statusExplicitos.length > 0) await model.aplicarStatus(db, statusExplicitos, idInstituicao);

  // 4. Turmas e matrículas pedidas pela planilha.
  const abaAtividades = lerAbaAtividades(atividades, (nome) =>
    nomes.resolver('professor', nome, nomesProfessores),
  );
  const pedidas = matriculas.montarMatriculas(alunos, alunoPorNome, idInstituicao);
  pedidas.nomesDeTurma.forEach((nome) => abaAtividades.nomesDeTurma.add(nome));

  const turmas = await prepararTurmas(
    db,
    {
      ...abaAtividades,
      turmasPedidas: pedidas.turmas,
      matriculas: pedidas.matriculas,
      nomePorIdAluno,
      turnoAntigoPorNome,
    },
    idInstituicao,
  );

  const matriculasAfetadas = await matriculas.sincronizarMatriculas(
    db,
    {
      idsAlunos: cadastrados.map((a) => a.id),
      matriculas: turmas.matriculas,
      idTurmaPorChave: turmas.idTurmaPorChave,
      hoje,
    },
    idInstituicao,
  );

  // 5. Dados complementares.
  const niveis = await complementares.atualizarNiveis(
    db,
    alunos,
    alunoPorNome,
    hoje,
    idInstituicao,
  );
  const situacoes = await complementares.salvarSituacoesAnuais(
    db,
    alunos,
    alunoPorNome,
    Number(hojeBrasil().slice(0, 4)),
    idInstituicao,
  );
  const saude = await complementares.adicionarObservacoesSaude(
    db,
    alunos,
    alunoPorNome,
    idInstituicao,
  );
  const responsaveis = await complementares.salvarResponsaveis(
    db,
    alunos,
    alunoPorNome,
    idInstituicao,
  );

  // 6. Encerra matrículas que deixaram de valer e sincroniza o status de quem veio na planilha.
  const porTurno = await matriculas.encerrarPorTrocaDeTurno(
    db,
    alunos,
    alunoPorNome,
    turnoAntigoPorNome,
    idInstituicao,
  );
  const porStatus = await matriculas.encerrarPorStatus(db, statusExplicitos, idInstituicao);
  await syncAlunoStatusFromMatriculas(
    db,
    cadastrados.map((a) => a.id),
    idInstituicao,
  );

  return {
    total_recebido: alunos.length,
    alunos_afetados: alunosAfetados,
    matriculas_afetadas: matriculasAfetadas,
    status_explicitos_aplicados: statusExplicitos.length,
    niveis_afetados: niveis.afetados,
    niveis_fora_de_faixa_ignorados: niveis.foraDeFaixa,
    situacoes_anuais_afetadas: situacoes,
    observacoes_saude_adicionadas: saude,
    responsaveis_afetados: responsaveis,
    matriculas_encerradas_troca_turno: porTurno.encerradas,
    turmas_encerradas_troca_turno: porTurno.turmas,
    matriculas_encerradas_status: porStatus.encerradas,
    turmas_encerradas_status: porStatus.turmas,
    nomes_corrigidos: nomes.corrigidos,
    possiveis_duplicados: nomes.suspeitos,
    conflitos_horario: pedidas.conflitosHorario,
    conflitos_turno: turmas.conflitosTurno,
    turmas_sem_area: [...turmas.turmasSemArea],
  };
}

async function importarPlanilha(body, idInstituicao) {
  const { alunos, atividades } = planilha.lerCorpo(body);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const resumo = await importar(connection, alunos, atividades, idInstituicao);
    await connection.commit();
    return resumo;
  } catch (err) {
    console.error('Erro no upsert-bulk:', err);
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = { importarPlanilha };

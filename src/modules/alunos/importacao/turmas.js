// Garante que toda turma citada na planilha exista, com professor e área.
const model = require('./importacao.model');
const { detectarAreaPorNome } = require('../normalizacao');
const { separarConflitosDeTurno } = require('./matriculas');

const PROFESSOR_PADRAO = 'Professor Padrão'; // quando a planilha não diz o professor

// Busca os professores citados e cria os que faltam. Devolve nome -> id.
async function garantirProfessores(db, nomes, idInstituicao) {
  const idPorNome = new Map();
  const existentes = await model.professoresPorNome(db, nomes, idInstituicao);
  existentes.forEach((p) => idPorNome.set(p.nome, p.id));

  const faltando = nomes.filter((nome) => !idPorNome.has(nome));
  if (faltando.length > 0) {
    await model.inserirProfessores(db, faltando, idInstituicao);
    const criados = await model.professoresPorNome(db, faltando, idInstituicao);
    criados.forEach((p) => idPorNome.set(p.nome, p.id));
  }
  return idPorNome;
}

// Área: a coluna "Área" da aba Atividades tem prioridade; sem ela, vale o
// prefixo do nome (e sem prefixo conhecido é palpite, reportado ao usuário).
function areaDaTurma(nome, areaPorTurma) {
  const daPlanilha = areaPorTurma.get(nome);
  return daPlanilha ? { area: daPlanilha, confiavel: true } : detectarAreaPorNome(nome);
}

// Turma já existente com professor ou área diferente da planilha é atualizada.
// Sem coluna "Área", só preenche turma ainda sem área: nunca troca por palpite.
async function atualizarTurmasExistentes(db, turmas, contexto, idInstituicao) {
  const { professorPorTurma, areaPorTurma, idProfessorPorNome, turmasSemArea } = contexto;
  const novosProfessores = [];
  const novasAreas = [];

  for (const turma of turmas) {
    const professor = professorPorTurma.get(turma.nome);
    if (professor) {
      const idProfessor = idProfessorPorNome.get(professor);
      if (idProfessor && turma.idprofessor !== idProfessor) {
        novosProfessores.push([idProfessor, turma.idatividades]);
      }
    }

    const areaDaPlanilha = areaPorTurma.get(turma.nome);
    if (areaDaPlanilha) {
      if (turma.area !== areaDaPlanilha) novasAreas.push([areaDaPlanilha, turma.idatividades]);
    } else if (!turma.area) {
      const { area, confiavel } = detectarAreaPorNome(turma.nome);
      novasAreas.push([area, turma.idatividades]);
      if (!confiavel) turmasSemArea.add(turma.nome);
    }
  }

  if (novosProfessores.length > 0) {
    await model.atualizarProfessorDasTurmas(db, novosProfessores, idInstituicao);
  }
  if (novasAreas.length > 0) await model.atualizarAreaDasTurmas(db, novasAreas, idInstituicao);
}

// Devolve o id de cada turma (por chave nome|dia|horário|turno), as matrículas
// que continuam válidas e os conflitos de turno encontrados.
async function prepararTurmas(db, dados, idInstituicao) {
  const { nomesDeTurma, turmasPedidas, matriculas, professorPorTurma, areaPorTurma } = dados;
  const idTurmaPorChave = new Map();
  const turmasSemArea = new Set();
  if (nomesDeTurma.size === 0) {
    return { idTurmaPorChave, matriculas, conflitosTurno: [], turmasSemArea };
  }

  const idProfessorPorNome = await garantirProfessores(
    db,
    Array.from(new Set([PROFESSOR_PADRAO, ...professorPorTurma.values()])),
    idInstituicao,
  );

  const existentes = await model.turmasPorNome(db, Array.from(nomesDeTurma), idInstituicao);
  for (const turma of existentes) {
    if (turma.dia_semana && turma.horario && turma.turno) {
      idTurmaPorChave.set(
        `${turma.nome}|${turma.dia_semana}|${turma.horario}|${turma.turno}`,
        turma.idatividades,
      );
    }
  }

  const { validas, conflitos } = separarConflitosDeTurno(
    matriculas,
    existentes,
    dados.nomePorIdAluno,
    dados.turnoAntigoPorNome,
  );

  // Só cria as turmas que ainda têm matrícula válida e que não existem.
  const chavesUsadas = new Set(
    validas.map((m) => `${m.nome_atividade}|${m.dia_semana}|${m.horario}|${m.turno}`),
  );
  const aCriar = [...turmasPedidas.entries()].filter(
    ([chave]) => chavesUsadas.has(chave) && !idTurmaPorChave.has(chave),
  );

  if (aCriar.length > 0) {
    const valores = aCriar.map(([, turma]) => {
      const professor = professorPorTurma.get(turma.nome);
      const idProfessor = professor
        ? idProfessorPorNome.get(professor)
        : idProfessorPorNome.get(PROFESSOR_PADRAO);
      const { area, confiavel } = areaDaTurma(turma.nome, areaPorTurma);
      if (!confiavel) turmasSemArea.add(turma.nome);
      return [
        turma.nome,
        idProfessor,
        area,
        idInstituicao,
        turma.dia_semana,
        turma.horario,
        turma.turno,
      ];
    });
    const primeiroId = await model.inserirTurmas(db, valores);
    aCriar.forEach(([chave], i) => idTurmaPorChave.set(chave, primeiroId + i));
  }

  await atualizarTurmasExistentes(
    db,
    existentes,
    { professorPorTurma, areaPorTurma, idProfessorPorNome, turmasSemArea },
    idInstituicao,
  );

  return { idTurmaPorChave, matriculas: validas, conflitosTurno: conflitos, turmasSemArea };
}

module.exports = { prepararTurmas };

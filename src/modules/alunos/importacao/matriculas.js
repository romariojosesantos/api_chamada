// Matrículas da importação. Uma "turma" é o par nome + dia + horário + turno
// (ver migrate-split-atividades-por-horario.js); o nome sozinho não basta.
const model = require('./importacao.model');
const { logAuditEvent } = require('../../../../audit');
const { podeMatricular } = require('../../../../regras-matricula');
const {
  encerrarMatriculasForaDoTurno,
  encerrarMatriculasSeNaoAtivo,
} = require('../../../../status-sync');
const { validarTurno, truncar } = require('../normalizacao');
const { nomeDaLinha, lerMatriculas } = require('./planilha');

const chaveDaTurma = (m) => `${m.nome_atividade}|${m.dia_semana}|${m.horario}|${m.turno}`;

// Matrículas pedidas pela planilha. Mesmo aluno em duas turmas no mesmo dia e
// horário (em geral linha duplicada) vira conflito, e só a primeira vale.
function montarMatriculas(alunos, alunoPorNome, idInstituicao) {
  const matriculas = [];
  const nomesDeTurma = [];
  const turmas = new Map(); // chave da turma -> { nome, dia_semana, horario, turno }
  const ocupacao = new Map(); // "idaluno|dia|horario" -> turma
  const conflitosHorario = [];

  for (const linha of alunos) {
    const nomeAluno = nomeDaLinha(linha);
    const aluno = alunoPorNome.get(nomeAluno);
    const turno = validarTurno(aluno?.turno || linha.turno); // o turno do banco tem prioridade
    if (!aluno?.id) {
      console.warn(`Aluno ${nomeAluno} não encontrado após upsert. Pulando matrículas.`);
      continue;
    }

    for (const { dia_semana, horario, nome_atividade } of lerMatriculas(linha)) {
      if (!dia_semana || !nome_atividade || !turno) continue;

      const posicao = `${aluno.id}|${dia_semana}|${horario}`;
      const ocupadaPor = ocupacao.get(posicao);
      if (ocupadaPor && ocupadaPor !== nome_atividade) {
        conflitosHorario.push({
          aluno: nomeAluno,
          dia_semana,
          horario,
          turma_1: ocupadaPor,
          turma_2: nome_atividade,
        });
        continue;
      }
      ocupacao.set(posicao, nome_atividade);

      const matricula = {
        idaluno: aluno.id,
        nome_atividade,
        turno,
        horario,
        dia_semana,
        id_instituicao: idInstituicao,
      };
      nomesDeTurma.push(nome_atividade);
      if (!turmas.has(chaveDaTurma(matricula))) {
        turmas.set(chaveDaTurma(matricula), { nome: nome_atividade, dia_semana, horario, turno });
      }
      matriculas.push(matricula);
    }
  }

  return { matriculas, nomesDeTurma, turmas, conflitosHorario };
}

// A turma (nome + dia + horário) já existe só em turnos incompatíveis com o do
// aluno: criar outra só para encaixá-lo deixaria um aluno da tarde numa turma
// da manhã. Exceção: o aluno está trocando de turno nesta mesma importação.
function separarConflitosDeTurno(matriculas, turmasExistentes, nomePorIdAluno, turnoAntigoPorNome) {
  const turnosPorTurma = new Map(); // "nome|dia|horario" -> Set de turnos
  for (const turma of turmasExistentes) {
    if (!turma.dia_semana || !turma.horario || !turma.turno) continue;
    const chave = `${turma.nome}|${turma.dia_semana}|${turma.horario}`;
    const turnos = turnosPorTurma.get(chave) || new Set();
    turnos.add(turma.turno);
    turnosPorTurma.set(chave, turnos);
  }

  const validas = [];
  const conflitos = [];
  for (const m of matriculas) {
    const turnosExistentes = turnosPorTurma.get(`${m.nome_atividade}|${m.dia_semana}|${m.horario}`);
    // podeMatricular: turma da Noite (ensaio) aceita aluno de qualquer turno.
    const incompativel =
      turnosExistentes?.size > 0 && ![...turnosExistentes].some((t) => podeMatricular(m.turno, t));
    const nomeAluno = nomePorIdAluno.get(m.idaluno);
    const turnoAntigo = turnoAntigoPorNome.get(nomeAluno);
    const trocandoDeTurno =
      turnoAntigo !== undefined && (turnoAntigo || null) !== (m.turno || null);

    if (incompativel && !trocandoDeTurno) {
      conflitos.push({
        aluno: nomeAluno || `aluno #${m.idaluno}`,
        turma: m.nome_atividade,
        dia_semana: m.dia_semana,
        horario: m.horario,
        turno_aluno: m.turno,
        turno_turma: [...turnosExistentes].join('/'),
      });
      continue;
    }
    validas.push(m);
  }
  return { validas, conflitos };
}

// Se já houver duas matrículas ativas na mesma posição (aluno + turno +
// horário + dia), fica a mais recente e as outras são encerradas.
async function encerrarDuplicadas(db, matriculasAtuais, hoje, idInstituicao) {
  const porPosicao = new Map();
  for (const m of matriculasAtuais) {
    const chave = `${m.idaluno}_${m.turno}_${m.horario}_${m.dia_semana}`;
    if (!porPosicao.has(chave)) porPosicao.set(chave, []);
    porPosicao.get(chave).push(m.idmatricula);
  }
  const duplicadas = [];
  porPosicao.forEach((ids) => {
    if (ids.length <= 1) return;
    const maisRecente = Math.max(...ids);
    ids.filter((id) => id !== maisRecente).forEach((id) => duplicadas.push(id));
  });
  if (duplicadas.length === 0) return matriculasAtuais;

  await model.encerrarMatriculas(db, duplicadas, hoje);
  await logAuditEvent(
    'MATRICULA_DUPLICIDADE_AUTOCORRIGIDA',
    `Import em massa: ${duplicadas.length} matrícula(s) duplicada(s) (mesma posição, já existiam antes deste import) encerrada(s) automaticamente: ${duplicadas.join(', ')}`,
    idInstituicao,
    db,
  );
  return matriculasAtuais.filter((m) => !duplicadas.includes(m.idmatricula));
}

// Compara com as matrículas atuais, posição por posição da grade: mesma turma
// não muda nada; turma diferente encerra a antiga e cria outra (preserva o
// histórico); posição nova só cria. Devolve quantas matrículas foram criadas.
async function sincronizarMatriculas(
  db,
  { idsAlunos, matriculas, idTurmaPorChave, hoje },
  idInstituicao,
) {
  let atuais =
    idsAlunos.length > 0 ? await model.matriculasAtivas(db, idsAlunos, idInstituicao) : [];
  atuais = await encerrarDuplicadas(db, atuais, hoje, idInstituicao);

  const atualPorPosicao = new Map();
  for (const m of atuais)
    atualPorPosicao.set(`${m.idaluno}_${m.turno}_${m.horario}_${m.dia_semana}`, m);

  const aEncerrar = [];
  const aCriar = [];
  for (const m of matriculas) {
    const idTurma = idTurmaPorChave.get(chaveDaTurma(m));
    const atual = atualPorPosicao.get(`${m.idaluno}_${m.turno}_${m.horario}_${m.dia_semana}`);
    if (atual && atual.idatividades === idTurma) continue;
    if (atual) aEncerrar.push(atual.idmatricula);
    aCriar.push([
      m.idaluno,
      idTurma,
      m.turno,
      m.horario,
      m.dia_semana,
      m.id_instituicao,
      hoje,
      'matriculado',
    ]);
  }

  if (aEncerrar.length > 0) await model.encerrarMatriculas(db, aEncerrar, hoje);
  return aCriar.length > 0 ? model.inserirMatriculas(db, aCriar) : 0;
}

// Aluno mudou de turno na planilha: encerra as matrículas que ficaram
// incompatíveis, inclusive as que a planilha nem menciona mais.
async function encerrarPorTrocaDeTurno(
  db,
  alunos,
  alunoPorNome,
  turnoAntigoPorNome,
  idInstituicao,
) {
  let encerradas = 0;
  const turmas = [];
  for (const linha of alunos) {
    const nome = nomeDaLinha(linha);
    const idAluno = alunoPorNome.get(nome)?.id;
    if (!idAluno) continue;

    const turnoAntigo = turnoAntigoPorNome.get(nome);
    if (turnoAntigo === undefined) continue; // aluno novo: não tem matrícula antiga
    const turnoNovo = truncar(linha.turno, 50) || null;
    if (turnoNovo === (turnoAntigo || null)) continue;

    const resultado = await encerrarMatriculasForaDoTurno(db, idAluno, turnoNovo, idInstituicao);
    encerradas += resultado.encerradas;
    turmas.push(...resultado.turmas);
  }
  if (encerradas > 0) {
    await logAuditEvent(
      'MATRICULAS_ENCERRADAS_TROCA_TURNO',
      `Import em massa: ${encerradas} matrícula(s) encerrada(s) por troca de turno: ${turmas.join(', ')}`,
      idInstituicao,
      db,
    );
  }
  return { encerradas, turmas };
}

// Matrícula só vale para aluno ativo: status "espera", "inativo"... encerra as
// que ficaram abertas, inclusive as criadas nesta importação.
async function encerrarPorStatus(db, statusExplicitos, idInstituicao) {
  let encerradas = 0;
  const turmas = [];
  for (const [idAluno, status] of statusExplicitos) {
    const resultado = await encerrarMatriculasSeNaoAtivo(db, idAluno, status, idInstituicao);
    encerradas += resultado.encerradas;
    turmas.push(...resultado.turmas);
  }
  if (encerradas > 0) {
    await logAuditEvent(
      'MATRICULAS_ENCERRADAS_STATUS',
      `Import em massa: ${encerradas} matrícula(s) encerrada(s) por status diferente de ativo: ${turmas.join(', ')}`,
      idInstituicao,
      db,
    );
  }
  return { encerradas, turmas };
}

module.exports = {
  chaveDaTurma,
  montarMatriculas,
  separarConflitosDeTurno,
  sincronizarMatriculas,
  encerrarPorTrocaDeTurno,
  encerrarPorStatus,
};

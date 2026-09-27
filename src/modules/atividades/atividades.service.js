// Turmas (tabela `atividades`). Desde a migração que separou `atividades` por
// horário (migrate-split-atividades-por-horario.js), cada linha é uma turma
// real: nome + professor + dia_semana + horario + turno, com seus próprios
// alunos matriculados.
const model = require('./atividades.model');
const AppError = require('../../utils/AppError');
const { emTransacao } = require('../../utils/transacao');
const { logAuditEvent } = require('../../utils/audit');
const { syncAlunoStatusFromMatriculas } = require('../alunos/status-sync');
const { AREAS_VALIDAS } = require('../../constants/areas');
const { hojeBrasil } = require('../../utils/data-brasil');

const DIAS_VALIDOS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta'];
// "Noite" é o turno dos ensaios — aceita aluno de qualquer turno, ver
// regras-matricula.js (podeMatricular).
const TURNOS_VALIDOS = ['Manhã', 'Tarde', 'Noite'];

async function exigirTurma(id, idInstituicao) {
  const turma = await model.buscar(id, idInstituicao);
  if (!turma) throw new AppError('Turma não encontrada.', 404);
  return turma;
}

// Com `idprofessor`, usa direto; só com `professor_nome`, acha o professor
// com esse nome ou cria um novo — o usuário não precisa cadastrar o professor
// numa tela separada antes de criar a turma. Vale pro principal e pros
// co-professores.
async function resolverProfessor(idprofessor, professorNome, idInstituicao) {
  const id = idprofessor ? Number(idprofessor) : null;
  if (id || !professorNome || !String(professorNome).trim()) return id;

  const nome = String(professorNome).trim();
  return (
    (await model.professorPorNome(nome, idInstituicao)) ??
    (await model.criarProfessor(nome, idInstituicao))
  );
}

// Valida os campos comuns a criar/editar turma e resolve o professor principal.
async function lerTurma(body, idInstituicao) {
  const { nome, dia_semana, horario, turno, area, idprofessor, professor_nome } = body;

  const nomeLimpo = String(nome || '').trim();
  if (!nomeLimpo) throw new AppError('Nome da turma é obrigatório.', 400);
  if (!DIAS_VALIDOS.includes(dia_semana)) {
    throw new AppError('Dia da semana inválido. Use: ' + DIAS_VALIDOS.join(', '), 400);
  }
  if (!horario || !String(horario).trim()) throw new AppError('Horário é obrigatório.', 400);
  if (!TURNOS_VALIDOS.includes(turno)) {
    throw new AppError('Turno inválido. Use: ' + TURNOS_VALIDOS.join(', '), 400);
  }
  if (!AREAS_VALIDAS.includes(area)) {
    throw new AppError('Área inválida. Use: ' + AREAS_VALIDAS.join(', '), 400);
  }

  return {
    nome: nomeLimpo,
    dia_semana,
    horario: String(horario).trim(),
    turno,
    area,
    idprofessor: await resolverProfessor(idprofessor, professor_nome, idInstituicao),
  };
}

// Inclui as encerradas — quem esconde é o front. Os co-professores vêm numa
// consulta separada + Map, pra não complicar a query principal.
async function listar(idInstituicao) {
  const turmas = await model.listar(idInstituicao);
  const coProfessores = await model.coProfessores(idInstituicao);

  const adicionaisPorTurma = new Map();
  for (const row of coProfessores) {
    if (!adicionaisPorTurma.has(row.idatividades)) adicionaisPorTurma.set(row.idatividades, []);
    adicionaisPorTurma.get(row.idatividades).push({ id: row.id, nome: row.nome });
  }
  turmas.forEach((t) => {
    t.professores_adicionais = adicionaisPorTurma.get(t.id) || [];
  });
  return turmas;
}

// data_inicio começa hoje, a não ser que venha informada (turma que já
// existia antes). Recusa duplicata ativa (duplo clique/reenvio).
async function criar(body, idInstituicao) {
  const turma = await lerTurma(body, idInstituicao);
  if (await model.existeDuplicada(turma, idInstituicao)) {
    throw new AppError('Já existe uma turma ativa com esse nome, professor, dia e horário.', 409);
  }

  const dataInicio = body.data_inicio || hojeBrasil();
  const id = await model.criar({ ...turma, data_inicio: dataInicio }, idInstituicao);

  await logAuditEvent(
    'TURMA_CRIADA',
    `Turma "${turma.nome}" (${turma.dia_semana} ${turma.horario} ${turma.turno})`,
    idInstituicao,
  );
  return { id, ...turma, data_inicio: dataInicio };
}

// Edita a turma e realinha as matrículas dela ao novo dia/horário/turno.
async function atualizar(id, body, idInstituicao) {
  await exigirTurma(id, idInstituicao);
  const turma = await lerTurma(body, idInstituicao);

  await model.atualizar(id, turma, idInstituicao);
  await model.alinharMatriculas(id, turma, idInstituicao);
  await logAuditEvent(
    'TURMA_EDITADA',
    `Turma #${id} -> "${turma.nome}" (${turma.dia_semana} ${turma.horario} ${turma.turno})`,
    idInstituicao,
  );
}

// Co-docência: o co-professor também bate ponto e lança nota da turma. O
// principal só muda editando a turma.
async function adicionarCoProfessor(id, { idprofessor, professor_nome }, idInstituicao) {
  const turma = await exigirTurma(id, idInstituicao);

  const idProfessor = await resolverProfessor(idprofessor, professor_nome, idInstituicao);
  if (!idProfessor) throw new AppError('Informe idprofessor ou professor_nome.', 400);
  if (idProfessor === turma.idprofessor) {
    throw new AppError('Esse professor já é o principal dessa turma.', 409);
  }
  if (await model.ehCoProfessor(id, idProfessor)) {
    throw new AppError('Esse professor já está nessa turma.', 409);
  }
  // Confere antes de gravar: sem isso, um id inexistente (ou de outra
  // instituição) virava vínculo gravado e a rota respondia 500.
  const professor = await model.buscarProfessor(idProfessor, idInstituicao);
  if (!professor) throw new AppError('Professor não encontrado.', 404);

  await model.adicionarCoProfessor(id, idProfessor, idInstituicao);
  await logAuditEvent(
    'TURMA_CO_PROFESSOR_ADICIONADO',
    `Turma #${id}: adicionado "${professor.nome}" (#${idProfessor})`,
    idInstituicao,
  );
  return professor;
}

async function removerCoProfessor(id, idProfessor, idInstituicao) {
  if ((await model.removerCoProfessor(id, idProfessor, idInstituicao)) === 0) {
    throw new AppError('Esse professor não está nessa turma como adicional.', 404);
  }
  await logAuditEvent(
    'TURMA_CO_PROFESSOR_REMOVIDO',
    `Turma #${id}: removido professor #${idProfessor}`,
    idInstituicao,
  );
}

// Encerra a turma (data_fim = hoje) e cancela as matrículas ativas dela numa
// transação. A turma continua existindo, com o histórico intacto. Devolve
// quantos alunos foram desmatriculados.
async function encerrar(id, idInstituicao) {
  const turma = await exigirTurma(id, idInstituicao);
  if (turma.data_fim) throw new AppError('Essa turma já está encerrada.', 409);

  try {
    return await emTransacao(async (db) => {
      const hoje = hojeBrasil();
      await model.marcarEncerrada(db, id, hoje);

      const ativas = await model.matriculasAtivas(db, id);
      if (ativas.length > 0) {
        await model.cancelarMatriculas(
          db,
          ativas.map((m) => m.idmatricula),
          hoje,
        );
        await syncAlunoStatusFromMatriculas(
          db,
          ativas.map((m) => m.idaluno),
          idInstituicao,
        );
      }

      // Passa `db` (a mesma transação): em produção o pool tem 1 conexão, e
      // pedir outra enquanto esta está em uso travaria pra sempre.
      await logAuditEvent(
        'TURMA_ENCERRADA',
        `Turma #${id} "${turma.nome}" — ${ativas.length} aluno(s) desmatriculado(s) junto`,
        idInstituicao,
        db,
      );
      return ativas.length;
    });
  } catch (error) {
    console.error('Erro ao encerrar turma:', error);
    throw new AppError('Erro ao encerrar turma: ' + error.message, 500);
  }
}

// Reabre só a turma — não rematricula quem saiu no encerramento (decisão manual).
async function reabrir(id, idInstituicao) {
  const turma = await exigirTurma(id, idInstituicao);
  if (!turma.data_fim) throw new AppError('Essa turma já está ativa.', 409);

  await model.reabrir(id);
  await logAuditEvent('TURMA_REABERTA', `Turma #${id} "${turma.nome}"`, idInstituicao);
}

// Quem já passou pela turma (matrículas encerradas).
async function historicoDeAlunos(id, idInstituicao) {
  await exigirTurma(id, idInstituicao);
  return model.historicoDeAlunos(id);
}

// Bloqueado se houver QUALQUER matrícula (ativa ou encerrada): apagar uma
// turma com histórico deixaria atividade "fantasma" nos relatórios.
async function excluir(id, idInstituicao) {
  const turma = await exigirTurma(id, idInstituicao);

  const { ativas, total } = await model.contarMatriculas(id);
  if (total > 0) {
    const detalheAtivas =
      ativas > 0
        ? `${ativas} aluno(s) matriculado(s) agora`
        : 'nenhum aluno matriculado agora, mas';
    const detalheHistorico =
      total > ativas ? ` e ${total - ativas} matrícula(s) encerrada(s) no histórico` : '';
    throw new AppError(
      `Essa turma tem ${detalheAtivas}${detalheHistorico}. Remova os alunos primeiro (ou mantenha a turma, mesmo vazia, para preservar o histórico).`,
      409,
    );
  }

  await model.excluir(id, idInstituicao);
  await logAuditEvent('TURMA_APAGADA', `Turma #${id} "${turma.nome}"`, idInstituicao);
}

module.exports = {
  listar,
  criar,
  atualizar,
  adicionarCoProfessor,
  removerCoProfessor,
  encerrar,
  reabrir,
  historicoDeAlunos,
  excluir,
};

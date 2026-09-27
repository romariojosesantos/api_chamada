// Ficha completa de um aluno, só para perfil master (pode ver/editar alunos de
// QUALQUER instituição, por isso estas rotas não passam pelo middleware de
// x-institution-id — a instituição vem do corpo/query, não de req.id_instituicao).
// Usado pela tela HistoricoAlunoMaster.js: busca, edição de dados cadastrais,
// matrículas, contatos de emergência e histórico de presença.
const model = require('./historico.model');
const AppError = require('../../../utils/AppError');
const { logAuditEvent } = require('../../../utils/audit');
const { syncAlunoStatusFromMatriculas, encerrarMatriculasSeNaoAtivo } = require('../status-sync');
const pool = require('../../../config/database');

function exigirId(valor, mensagem) {
  const id = parseInt(valor);
  if (isNaN(id)) throw new AppError(mensagem, 400);
  return id;
}

function exigirContato({ nome, telefone }) {
  if (!nome || !nome.trim()) throw new AppError('Nome do contato é obrigatório.', 400);
  if (!telefone || !telefone.trim()) throw new AppError('Telefone do contato é obrigatório.', 400);
}

// Busca por nome. Com `idInstituicao` (a tela sempre manda a instituição
// selecionada pelo master) a busca fica restrita a ela, coerente com o resto
// do sistema; sem ela, busca em todas.
async function buscar(q, idInstituicao) {
  const termo = String(q || '').trim();
  if (!termo || termo.length < 2) {
    throw new AppError('Informe pelo menos 2 caracteres para buscar.', 400);
  }
  const instId = parseInt(idInstituicao);
  return model.buscarPorNome(termo, isNaN(instId) ? null : instId);
}

// Dados do aluno + TODAS as matrículas (inclusive encerradas) + contatos de
// emergência + todo o histórico de presença.
async function ficha(idTexto) {
  const id = exigirId(idTexto, 'ID do aluno inválido.');
  const aluno = await model.buscarAluno(id);
  if (!aluno) throw new AppError('Aluno não encontrado.', 404);

  const matriculas = await model.todasAsMatriculas(id);

  // Tolerante se a tabela não existir (ambiente sem essa migração aplicada
  // continua funcionando, só sem essa seção da ficha).
  let contatos = [];
  try {
    contatos = await model.contatosDoAluno(id);
  } catch (err) {
    if (err.message && err.message.includes('contatos_emergencia')) {
      console.warn(
        '[historico-aluno] Tabela contatos_emergencia não existe. Continuando sem contatos.',
      );
    } else {
      throw err;
    }
  }

  const presencas = await model.presencasDoAluno(id);
  return { aluno, matriculas, contatos, presencas };
}

// Dados cadastrais. Não inclui acompanhamento/ponto — o formulário da ficha
// não tem esses campos (só o PATCH de campo único de alunos).
async function atualizarAluno(idTexto, body) {
  const id = exigirId(idTexto, 'ID do aluno inválido.');
  const { nome, data_nascimento, sexo, telefone, turma, turno, transporte, Inf, status } = body;
  if (!nome || !nome.trim()) throw new AppError('Nome é obrigatório.', 400);

  const aluno = await model.statusDoAluno(id);
  if (!aluno) throw new AppError('Aluno não encontrado.', 404);

  const statusNovo = status || 'ativo';
  await model.atualizarAluno(id, {
    nome: nome.trim(),
    data_nascimento: data_nascimento || null,
    sexo: sexo || null,
    telefone: telefone || null,
    turma: turma || null,
    turno: turno || null,
    transporte: transporte || null,
    Inf: Inf || null,
    status: statusNovo,
  });

  if (statusNovo !== aluno.status) {
    // Mantém `inativado_em` coerente também quando o status muda por aqui.
    if (statusNovo === 'inativo') await model.marcarInativadoHoje(id);
    else if (aluno.status === 'inativo') await model.limparInativadoEm(id);

    // Matrícula só vale pra aluno ativo: sem isso, aluno marcado inativo aqui
    // ficava com matrícula aberta pra sempre, inflando "esperado" nos relatórios.
    const resultado = await encerrarMatriculasSeNaoAtivo(
      pool,
      id,
      statusNovo,
      aluno.id_instituicao,
    );
    if (resultado.encerradas > 0) {
      await logAuditEvent(
        'MATRICULAS_ENCERRADAS_STATUS',
        `Aluno ID: ${id}, status ${aluno.status || '(vazio)'} -> ${statusNovo} (via ficha do master), ${resultado.encerradas} matrícula(s) encerrada(s): ${resultado.turmas.join(', ')}`,
        aluno.id_instituicao,
      );
    }
  }

  await logAuditEvent(
    'ALUNO_ATUALIZADO_MASTER',
    `Aluno ID ${id} atualizado pelo master`,
    aluno.id_instituicao,
  );
}

// dia_semana/horario/turno de uma matrícula vêm SEMPRE da turma que ela
// aponta, nunca do cliente — senão daria pra criar uma matrícula com posição
// inconsistente com a turma. null = turma não existe.
async function horarioDaTurma(idAtividade) {
  if (!idAtividade) return { dia_semana: '', horario: '', turno: '' };
  const turma = await model.horarioDaTurma(idAtividade);
  if (!turma) return null;
  return {
    dia_semana: turma.dia_semana || '',
    horario: turma.horario || '',
    turno: turma.turno || '',
  };
}

// Edita status/datas de uma matrícula ATIVA. Nunca muda a turma (trocar de
// turma é encerrar e criar outra, pra não reescrever o histórico) nem mexe
// numa matrícula que já virou histórico (essa só pode ser excluída).
async function atualizarMatricula(idTexto, { status, data_inicio, data_fim }) {
  const id = exigirId(idTexto, 'ID da matrícula inválido.');
  const matricula = await model.matriculaParaEditar(id);
  if (!matricula) throw new AppError('Matrícula não encontrada.', 404);
  if (matricula.data_fim) {
    throw new AppError(
      'Essa matrícula já foi encerrada e virou histórico — não pode mais ser editada, só excluída.',
      409,
    );
  }

  const idatividades = matricula.idatividades;
  const horario = await horarioDaTurma(idatividades);
  if (!horario) throw new AppError('A turma dessa matrícula não existe mais.', 404);
  await model.atualizarMatricula(id, {
    turno: horario.turno,
    horario: horario.horario,
    dia_semana: horario.dia_semana,
    status: status || 'matriculado',
    data_inicio: data_inicio || null,
    data_fim: data_fim || null,
    idatividades: idatividades || null,
  });

  await logAuditEvent(
    'MATRICULA_ATUALIZADA_MASTER',
    `Matrícula ID ${id} atualizada pelo master`,
    await model.instituicaoDaMatricula(id),
  );
}

// Cria matrícula com a instituição explícita no corpo (o master pode estar
// editando aluno de qualquer instituição).
async function criarMatricula(body) {
  const { idaluno, idatividades, status, data_inicio, data_fim, id_instituicao } = body;
  const alunoId = exigirId(idaluno, 'ID do aluno inválido.');
  const instId = exigirId(id_instituicao, 'ID da instituição inválido.');
  if (!idatividades) throw new AppError('Selecione uma turma.', 400);

  if (!(await model.alunoNaInstituicao(alunoId, instId))) {
    throw new AppError('Aluno não encontrado nesta instituição.', 404);
  }
  const horario = await horarioDaTurma(idatividades);
  if (!horario) throw new AppError('Turma não encontrada.', 404);

  const id = await model.criarMatricula({
    idaluno: alunoId,
    idatividades,
    ...horario,
    status: status || 'matriculado',
    data_inicio: data_inicio || null,
    data_fim: data_fim || null,
    id_instituicao: instId,
  });

  await logAuditEvent(
    'MATRICULA_CRIADA_MASTER',
    `Matrícula ID ${id} criada pelo master para aluno ${alunoId}`,
    instId,
  );
  return id;
}

// Matrícula ATIVA: soft-delete (data_fim = hoje, status 'cancelada', o mesmo
// valor do resto do sistema). JÁ HISTÓRICA: hard-delete — é a única forma de
// corrigir um registro errado do passado, então é permanente; a tela confirma
// antes. Devolve se foi permanente.
async function excluirMatricula(idTexto) {
  const id = exigirId(idTexto, 'ID da matrícula inválido.');
  const matricula = await model.matriculaParaExcluir(id);
  if (!matricula) throw new AppError('Matrícula não encontrada.', 404);

  if (matricula.data_fim) {
    await model.excluirMatricula(id);
    await logAuditEvent(
      'MATRICULA_EXCLUIDA_PERMANENTEMENTE_MASTER',
      `Matrícula ID ${id} (já histórica) excluída permanentemente pelo master`,
      matricula.id_instituicao,
    );
    return true;
  }

  await model.encerrarMatricula(id);
  await logAuditEvent(
    'MATRICULA_ENCERRADA_MASTER',
    `Matrícula ID ${id} encerrada pelo master`,
    matricula.id_instituicao,
  );
  return false;
}

// Reabre uma matrícula histórica. A turma precisa existir e estar ativa, e o
// aluno não pode ter outra matrícula ativa na mesma posição (dia + horário),
// senão criaria uma duplicidade.
async function reabrirMatricula(idTexto) {
  const id = exigirId(idTexto, 'ID da matrícula inválido.');
  const matricula = await model.matriculaParaReabrir(id);
  if (!matricula) throw new AppError('Matrícula não encontrada.', 404);
  if (!matricula.data_fim) throw new AppError('Essa matrícula já está ativa.', 409);

  const turma = await model.buscarTurma(matricula.idatividades);
  if (!turma) throw new AppError('A turma dessa matrícula não existe mais.', 404);
  if (turma.data_fim) {
    throw new AppError(
      `A turma "${turma.nome}" está encerrada — reabra a turma primeiro para depois reabrir esta matrícula.`,
      409,
    );
  }

  const conflito = await model.temConflitoNaPosicao({
    idAluno: matricula.idaluno,
    diaSemana: matricula.dia_semana,
    horario: matricula.horario,
    exceto: id,
  });
  if (conflito) {
    throw new AppError(
      'Esse aluno já tem uma matrícula ativa nesse mesmo dia/horário — encerre-a antes de reabrir esta.',
      409,
    );
  }

  await model.reabrirMatricula(id);
  await syncAlunoStatusFromMatriculas(pool, [matricula.idaluno], matricula.id_instituicao);
  await logAuditEvent(
    'MATRICULA_REABERTA_MASTER',
    `Matrícula ID ${id} ("${turma.nome}") reaberta pelo master`,
    matricula.id_instituicao,
  );
}

// --- Contatos de emergência (versão master; a da instituição fica em
// alunos/contatos/contatos.routes.js) ---

async function atualizarContato(idTexto, { nome, telefone, parentesco }) {
  const id = exigirId(idTexto, 'ID inválido.');
  exigirContato({ nome, telefone });

  const alterados = await model.atualizarContato(id, {
    nome: nome.trim(),
    telefone: telefone.trim(),
    parentesco: parentesco?.trim() || null,
  });
  if (alterados === 0) throw new AppError('Contato não encontrado.', 404);

  await logAuditEvent(
    'CONTATO_EMERGENCIA_ATUALIZADO_MASTER',
    `Contato de emergência ID ${id} atualizado pelo master`,
    await model.instituicaoDoContato(id),
  );
}

async function criarContato({ id_aluno, nome, telefone, parentesco, id_instituicao }) {
  const alunoId = exigirId(id_aluno, 'ID do aluno inválido.');
  const instId = parseInt(id_instituicao);
  exigirContato({ nome, telefone });

  const id = await model.criarContato({
    id_aluno: alunoId,
    nome: nome.trim(),
    telefone: telefone.trim(),
    parentesco: parentesco?.trim() || null,
    id_instituicao: isNaN(instId) ? null : instId,
  });

  await logAuditEvent(
    'CONTATO_EMERGENCIA_CRIADO_MASTER',
    `Contato de emergência criado pelo master para aluno ${alunoId}`,
    isNaN(instId) ? null : instId,
  );
  return id;
}

async function excluirContato(idTexto) {
  const id = exigirId(idTexto, 'ID inválido.');
  // Lida antes de apagar: depois do DELETE a linha não existe mais.
  const idInstituicao = await model.instituicaoDoContato(id);
  if ((await model.excluirContato(id)) === 0) throw new AppError('Contato não encontrado.', 404);

  await logAuditEvent(
    'CONTATO_EMERGENCIA_DELETADO_MASTER',
    `Contato de emergência ID ${id} deletado pelo master`,
    idInstituicao,
  );
}

module.exports = {
  buscar,
  ficha,
  atualizarAluno,
  atualizarMatricula,
  criarMatricula,
  excluirMatricula,
  reabrirMatricula,
  atualizarContato,
  criarContato,
  excluirContato,
};

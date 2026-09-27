// Regras de cadastro, edição e exclusão de alunos.
const pool = require('../../../db');
const model = require('./alunos.model');
const AppError = require('../../utils/AppError');
const { logAuditEvent } = require('../../../audit');
const { criarNotificacao } = require('../../../notificacoes-service');
const {
  encerrarMatriculasForaDoTurno,
  encerrarMatriculasSeNaoAtivo,
} = require('../../../status-sync');
const { hojeBrasil, agoraBrasil } = require('../../utils/data-brasil');
const { enviarFoto, removerFoto, configurado: storageConfigurado } = require('../../utils/storage');
const { truncar, parseInteiro } = require('./normalizacao');

const SEM_ENCERRAMENTOS = { encerradas: 0, turmas: [] };

async function emTransacao(fn) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const resultado = await fn(connection);
    await connection.commit();
    return resultado;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

function dadosDoAluno(body) {
  return {
    nome: body.nome,
    data_nascimento: body.data_nascimento || null,
    sexo: body.sexo || null,
    telefone: body.telefone || null,
    turma: body.turma || null,
    turno: body.turno || null,
    transporte: body.transporte || null,
    Inf: body.Inf || null,
    acompanhamento: body.acompanhamento || null,
    ponto: body.ponto || null,
    informacoes_gerais: body.informacoes_gerais || null,
    escola_atual: body.escola_atual || null,
    status: body.status || 'ativo',
  };
}

function responsavelDoFormulario(body) {
  return {
    nome: truncar(body.responsavel_nome, 255),
    cpf: truncar(body.responsavel_cpf, 20),
    rg: truncar(body.responsavel_rg, 20),
    data_nascimento: body.responsavel_data_nascimento || null,
    email: truncar(body.responsavel_email, 255),
    endereco: truncar(body.responsavel_endereco, 255),
    bairro: truncar(body.responsavel_bairro, 100),
    cep: truncar(body.responsavel_cep, 10),
    telefone: truncar(body.responsavel_telefone, 20),
  };
}

const preenchido = (valor) => valor && String(valor).trim();

// Cadastro manual completo: dados do aluno + nível, situação anual, uma
// observação de saúde e responsável legal (os mesmos dados da planilha).
async function criar(body, idInstituicao) {
  return emTransacao(async (db) => {
    const idAluno = await model.inserir(
      db,
      {
        ...dadosDoAluno(body),
        data_cadastro: body.data_cadastro || hojeBrasil(),
        criado_em: agoraBrasil(),
      },
      idInstituicao,
    );

    const nivel = parseInt(body.nivel, 10);
    if (!isNaN(nivel) && nivel >= 1 && nivel <= 99) {
      const subnivel = parseInteiro(body.subnivel);
      await model.abrirNivel(
        db,
        idAluno,
        nivel,
        subnivel === null ? null : truncar(String(subnivel), 10),
        idInstituicao,
      );
    }

    if (body.situacao_matricula || body.situacao_divida) {
      await model.inserirSituacaoAnual(
        db,
        idAluno,
        truncar(body.situacao_matricula, 50),
        truncar(body.situacao_divida, 50),
        idInstituicao,
      );
    }

    if (preenchido(body.observacao_saude)) {
      await model.adicionarObservacaoSaude(
        db,
        idAluno,
        truncar(body.observacao_saude, 255),
        idInstituicao,
      );
    }

    if (preenchido(body.responsavel_nome)) {
      await model.inserirResponsavel(db, idAluno, responsavelDoFormulario(body), idInstituicao);
    }

    await logAuditEvent(
      'CRIAR_ALUNO',
      `Aluno ID: ${idAluno}, Nome: ${body.nome}`,
      idInstituicao,
      db,
    );
    return idAluno;
  });
}

// Nível mudou (nível ou subnível)? Fecha o registro aberto e abre outro.
// Nível vazio só fecha o atual.
async function atualizarNivel(db, idAluno, body, idInstituicao) {
  const atual = await model.nivelAberto(db, idAluno, idInstituicao);
  const nivelNum = parseInt(body.nivel, 10);
  const subnivelNum = parseInteiro(body.subnivel);
  const nivel = !isNaN(nivelNum) && nivelNum >= 1 && nivelNum <= 99 ? nivelNum : null;
  const subnivel = nivel === null || subnivelNum === null ? null : truncar(String(subnivelNum), 10);

  const mudou = (atual?.nivel ?? null) !== nivel || (atual?.subnivel ?? null) !== subnivel;
  if (!mudou) return;
  if (atual) await model.encerrarNivel(db, atual.id);
  if (nivel !== null) await model.abrirNivel(db, idAluno, nivel, subnivel, idInstituicao);
}

// Edição completa pela tela do aluno. Situação anual e responsável gravam
// exatamente o que está no formulário (campo vazio = apagar); a observação de
// saúde é sempre adicionada como nova entrada.
async function atualizarCompleto(id, body, idUsuario, idInstituicao) {
  return emTransacao(async (db) => {
    const antes = await model.buscarTurnoEStatus(db, id, idInstituicao);
    const turnoAntigo = antes?.turno || null;

    const alterados = await model.atualizar(
      db,
      id,
      { ...dadosDoAluno(body), data_cadastro: body.data_cadastro || null },
      idInstituicao,
    );
    if (alterados === 0) throw new AppError('Aluno não encontrado.', 404);

    let porTurno = SEM_ENCERRAMENTOS;
    if ((body.turno || null) !== turnoAntigo) {
      porTurno = await encerrarMatriculasForaDoTurno(db, id, body.turno, idInstituicao);
    }

    await atualizarNivel(db, id, body, idInstituicao);

    const { situacao_matricula, situacao_divida } = body;
    const temSituacao = await model.temSituacaoAnualNoAno(db, id, idInstituicao);
    if (temSituacao || situacao_matricula || situacao_divida) {
      await model.salvarSituacaoAnual(
        db,
        id,
        truncar(situacao_matricula, 50),
        truncar(situacao_divida, 50),
        idInstituicao,
      );
    }

    if (preenchido(body.observacao_saude)) {
      await model.adicionarObservacaoSaude(
        db,
        id,
        truncar(body.observacao_saude, 255),
        idInstituicao,
      );
    }

    if (preenchido(body.responsavel_nome)) {
      await model.salvarResponsavelDaEdicao(db, id, responsavelDoFormulario(body), idInstituicao);
    }

    if (porTurno.encerradas > 0) {
      await logAuditEvent(
        'MATRICULAS_ENCERRADAS_TROCA_TURNO',
        `Aluno ID: ${id}, turno ${turnoAntigo || '(vazio)'} -> ${body.turno || '(vazio)'}, ${porTurno.encerradas} matrícula(s) encerrada(s): ${porTurno.turmas.join(', ')}`,
        idInstituicao,
        db,
      );
    }

    // Matrícula só vale para aluno ativo.
    let porStatus = SEM_ENCERRAMENTOS;
    if ((body.status || 'ativo') !== (antes?.status || 'ativo')) {
      porStatus = await encerrarMatriculasSeNaoAtivo(db, id, body.status, idInstituicao);
    }
    if (porStatus.encerradas > 0) {
      await logAuditEvent(
        'MATRICULAS_ENCERRADAS_STATUS',
        `Aluno ID: ${id}, status -> ${body.status}, ${porStatus.encerradas} matrícula(s) encerrada(s): ${porStatus.turmas.join(', ')}`,
        idInstituicao,
        db,
      );
    }

    await logAuditEvent(
      'ATUALIZAR_ALUNO',
      `Aluno ID: ${id}, edição completa por usuário #${idUsuario}`,
      idInstituicao,
      db,
    );

    return {
      matriculas_encerradas: porTurno.encerradas + porStatus.encerradas,
      turmas_encerradas: [...porTurno.turmas, ...porStatus.turmas],
    };
  });
}

const CAMPOS_EDITAVEIS = [
  'data_nascimento',
  'data_cadastro',
  'sexo',
  'telefone',
  'turma',
  'turno',
  'transporte',
  'Inf',
  'acompanhamento',
  'ponto',
  'informacoes_gerais',
  'escola_atual',
  'status',
  'inativado_em',
];

async function notificarDesistencia(id, nomeAluno, statusAnterior, idInstituicao) {
  await criarNotificacao({
    tipo: 'desistencia',
    titulo: 'Aluno marcado como desistente',
    mensagem: `${nomeAluno || 'Um aluno'} foi marcado(a) como inativo(a).`,
    id_instituicao: idInstituicao,
    id_aluno: Number(id),
    detalhes: [
      {
        aluno_id: Number(id),
        aluno_nome: nomeAluno || null,
        de: { status: statusAnterior },
        para: { status: 'inativo' },
      },
    ],
  });
}

// Edição de um único campo (tela de Gerenciar Matrículas).
async function atualizarCampo(id, campo, valor, idInstituicao) {
  if (!CAMPOS_EDITAVEIS.includes(campo)) {
    throw new AppError('Campo não permitido para atualização.', 400);
  }
  if (campo === 'inativado_em' && valor && !/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    throw new AppError('Data inválida. Use o formato AAAA-MM-DD.', 400);
  }

  // Valores de antes, para detectar desistência e troca de turno.
  let statusAnterior = null;
  let nomeAluno = null;
  let turnoAnterior = null;
  if (campo === 'status') {
    const atual = await model.buscarStatusENome(id, idInstituicao);
    statusAnterior = atual?.status;
    nomeAluno = atual?.nome;
  }
  if (campo === 'turno') {
    const atual = await model.buscarTurno(id, idInstituicao);
    turnoAnterior = atual?.turno || null;
  }

  // DATE não aceita '' no modo estrito: limpar a data precisa gravar NULL.
  const valorParaGravar = campo === 'inativado_em' && !valor ? null : valor;
  const alterados = await model.atualizarCampo(id, campo, valorParaGravar, idInstituicao);
  if (alterados === 0) throw new AppError('Aluno não encontrado.', 404);

  await logAuditEvent('ATUALIZAR_ALUNO', `Aluno ID: ${id}, Campo: ${campo}`, idInstituicao);

  const mudouStatus = campo === 'status' && valor !== statusAnterior;
  if (campo === 'status' && valor === 'inativo' && statusAnterior && statusAnterior !== 'inativo') {
    await notificarDesistencia(id, nomeAluno, statusAnterior, idInstituicao);
  }
  if (mudouStatus) {
    if (valor === 'inativo') await model.marcarInativadoHoje(id, idInstituicao);
    else if (statusAnterior === 'inativo') await model.limparInativadoEm(id, idInstituicao);
  }

  let porTurno = SEM_ENCERRAMENTOS;
  if (campo === 'turno' && (valor || null) !== turnoAnterior) {
    porTurno = await encerrarMatriculasForaDoTurno(pool, id, valor, idInstituicao);
    if (porTurno.encerradas > 0) {
      await logAuditEvent(
        'MATRICULAS_ENCERRADAS_TROCA_TURNO',
        `Aluno ID: ${id}, turno ${turnoAnterior || '(vazio)'} -> ${valor || '(vazio)'}, ${porTurno.encerradas} matrícula(s) encerrada(s): ${porTurno.turmas.join(', ')}`,
        idInstituicao,
      );
    }
  }

  let porStatus = SEM_ENCERRAMENTOS;
  if (mudouStatus) {
    porStatus = await encerrarMatriculasSeNaoAtivo(pool, id, valor, idInstituicao);
    if (porStatus.encerradas > 0) {
      await logAuditEvent(
        'MATRICULAS_ENCERRADAS_STATUS',
        `Aluno ID: ${id}, status ${statusAnterior || '(vazio)'} -> ${valor}, ${porStatus.encerradas} matrícula(s) encerrada(s): ${porStatus.turmas.join(', ')}`,
        idInstituicao,
      );
    }
  }

  return {
    matriculas_encerradas: porTurno.encerradas + porStatus.encerradas,
    turmas_encerradas: [...porTurno.turmas, ...porStatus.turmas],
  };
}

// Soft-delete: vai para a lixeira e as matrículas ativas são encerradas.
async function moverParaLixeira(id, idUsuario, idInstituicao) {
  await emTransacao(async (db) => {
    const alterados = await model.moverParaLixeira(db, id, idUsuario, idInstituicao);
    if (alterados === 0) throw new Error('Aluno não encontrado');

    await model.encerrarMatriculasAtivas(db, id, idInstituicao);
    await logAuditEvent(
      'EXCLUIR_ALUNO',
      `Aluno ID: ${id} excluído (soft-delete) por usuário #${idUsuario}, matrículas ativas encerradas`,
      idInstituicao,
      db,
    );
  });
}

// Só apaga de vez quem já está na lixeira: nunca um aluno ativo num clique só.
async function excluirDefinitivamente(id, idUsuario, idInstituicao) {
  const aluno = await model.buscarNaLixeira(id, idInstituicao);
  if (!aluno) {
    throw new AppError(
      'Aluno não encontrado na lixeira. Só é possível excluir definitivamente um aluno que já foi excluído antes.',
      404,
    );
  }

  await model.excluirDefinitivamente(id, idInstituicao);
  await logAuditEvent(
    'ALUNO_EXCLUIDO_PERMANENTEMENTE',
    `Aluno ID: ${id}, Nome: ${aluno.nome}, excluído para sempre (com tudo relacionado) por usuário #${idUsuario}`,
    idInstituicao,
  );
}

// As matrículas antigas não voltam: quem restaura decide onde matricular.
async function restaurar(id, idUsuario, idInstituicao) {
  const alterados = await model.restaurar(id, idInstituicao);
  if (alterados === 0) throw new AppError('Aluno excluído não encontrado.', 404);

  await logAuditEvent(
    'ALUNO_RESTAURADO',
    `Aluno ID: ${id} restaurado por usuário #${idUsuario}`,
    idInstituicao,
  );
}

// Código de 6 dígitos para o login do aluno. A coluna é UNIQUE, então tenta
// de novo nos raros casos de colisão.
async function gerarCodigoAcesso(id, idUsuario, idInstituicao) {
  if (!(await model.existe(id, idInstituicao))) throw new AppError('Aluno não encontrado.', 404);

  let codigo;
  let salvou = false;
  for (let tentativa = 0; tentativa < 10 && !salvou; tentativa++) {
    codigo = String(Math.floor(100000 + Math.random() * 900000));
    try {
      salvou = (await model.salvarCodigoAcesso(id, codigo)) > 0;
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
    }
  }
  if (!salvou) throw new AppError('Não foi possível gerar um código único. Tente novamente.', 500);

  await logAuditEvent(
    'ALUNO_CODIGO_ACESSO_GERADO',
    `Aluno ID: ${id}, código gerado por usuário #${idUsuario}`,
    idInstituicao,
  );
  return codigo;
}

// Nunca SVG (pode carregar script).
const TIPOS_FOTO_ACEITOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const TAMANHO_MAX_FOTO_BYTES = 3 * 1024 * 1024; // a foto já chega comprimida pelo navegador

// A foto chega como data URL e vai para o bucket (R2); no banco fica só a URL.
async function atualizarFoto(id, dataUrl, idInstituicao) {
  if (!storageConfigurado) {
    throw new AppError('Armazenamento de fotos não configurado neste ambiente ainda.', 503);
  }

  const aluno = await model.buscarFoto(id, idInstituicao);
  if (!aluno) throw new AppError('Aluno não encontrado.', 404);

  const match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) throw new AppError('Envie a foto como data URL (data:image/...;base64,...).', 400);

  const [, contentType, base64] = match;
  const extensao = TIPOS_FOTO_ACEITOS[contentType];
  if (!extensao) throw new AppError('Formato de imagem não aceito. Use JPEG, PNG ou WEBP.', 400);

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > TAMANHO_MAX_FOTO_BYTES)
    throw new AppError('Foto muito grande (máximo 3MB).', 400);

  const url = await enviarFoto(
    `alunos/${idInstituicao}/${id}/${Date.now()}.${extensao}`,
    buffer,
    contentType,
  );
  await model.salvarFotoUrl(id, url);
  if (aluno.foto_url) await removerFoto(aluno.foto_url);

  await logAuditEvent('ALUNO_FOTO_ATUALIZADA', `Aluno ID: ${id}`, idInstituicao);
  return url;
}

async function removerFotoDoAluno(id, idInstituicao) {
  const aluno = await model.buscarFoto(id, idInstituicao);
  if (!aluno) throw new AppError('Aluno não encontrado.', 404);
  if (!aluno.foto_url) return;

  await model.limparFotoUrl(id);
  await removerFoto(aluno.foto_url);
  await logAuditEvent('ALUNO_FOTO_REMOVIDA', `Aluno ID: ${id}`, idInstituicao);
}

// Único jeito de tirar uma observação lançada errado (a importação só adiciona).
async function removerObservacaoSaude(idAluno, idSaude, idInstituicao) {
  const removidas = await model.removerObservacaoSaude(idSaude, idAluno, idInstituicao);
  if (removidas === 0) throw new AppError('Observação de saúde não encontrada.', 404);

  await logAuditEvent(
    'OBSERVACAO_SAUDE_REMOVIDA',
    `Aluno ID: ${idAluno}, observação #${idSaude} removida`,
    idInstituicao,
  );
}

async function salvarResponsavel(id, body, idInstituicao) {
  if (!(await model.existe(id, idInstituicao))) throw new AppError('Aluno não encontrado.', 404);

  const { nome, cpf, rg, data_nascimento, email, endereco, bairro, cep, telefone } = body;
  await model.salvarResponsavel(
    id,
    {
      nome: nome || null,
      cpf: cpf || null,
      rg: rg || null,
      data_nascimento: data_nascimento || null,
      email: email || null,
      endereco: endereco || null,
      bairro: bairro || null,
      cep: cep || null,
      telefone: telefone || null,
    },
    idInstituicao,
  );
  await logAuditEvent('RESPONSAVEL_LEGAL_ATUALIZADO', `Aluno ID: ${id}`, idInstituicao);
}

module.exports = {
  criar,
  atualizarCompleto,
  atualizarCampo,
  moverParaLixeira,
  excluirDefinitivamente,
  restaurar,
  gerarCodigoAcesso,
  atualizarFoto,
  removerFotoDoAluno,
  removerObservacaoSaude,
  salvarResponsavel,
};

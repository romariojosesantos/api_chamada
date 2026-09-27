// Cadastro, login, sessão e senha.
const crypto = require('crypto');
const model = require('./usuarios.model');
const email = require('./email');
const sessao = require('./sessao');
const AppError = require('../../utils/AppError');
const { signToken, verifyToken } = require('./token');
const { hashPassword, verifyPassword } = require('./senha');
const { limparEmail, lerFormulario, exigirCamposValidos } = require('./validacao-usuario');

const CODIGO_TTL_MS = 15 * 60 * 1000; // código de redefinição vale 15 minutos
const CODIGO_INTERVALO_MS = 60 * 1000; // intervalo mínimo entre pedidos de código

// Avisa os masters de um cadastro pendente, com link de aprovação. O token do
// link tem `tipo` próprio, então não serve como token de sessão.
async function avisarMastersNovoCadastro(usuario) {
  if (!email.configurado()) {
    console.warn(
      `[AVISO] RESEND_API_KEY não configurada — masters não notificados sobre o cadastro pendente de ${usuario.email}.`,
    );
    return;
  }
  const destinatarios = await model.emailsDosMastersAtivos();
  if (destinatarios.length === 0) return;
  const token = signToken({ usuarioId: usuario.id, tipo: 'aprovacao_cadastro' });
  await email.avisarNovoCadastro(destinatarios, usuario, token);
}

// Autocadastro: fica "pendente" até um master aprovar. O primeiro master do
// sistema é a exceção (entra ativo e já logado); só pode existir um.
async function cadastrar(body) {
  const { nome, email: emailLimpo, senha, perfil } = lerFormulario(body);
  const idInstituicao = parseInt(body.id_instituicao);

  await exigirCamposValidos({
    nome,
    email: emailLimpo,
    senha,
    perfil,
    idsInstituicoes: isNaN(idInstituicao) ? [] : [idInstituicao],
  });
  if (perfil !== 'master' && isNaN(idInstituicao)) {
    throw new AppError('Selecione a instituição vinculada ao usuário.', 400);
  }
  if (await model.emailEmUso(emailLimpo))
    throw new AppError('Este e-mail já está cadastrado.', 409);
  if (perfil === 'master' && (await model.existeMaster())) {
    throw new AppError('Já existe um usuário master no sistema. Contate o administrador.', 403);
  }

  const status = perfil === 'master' ? 'ativo' : 'pendente';
  const id = await model.inserirCadastro({
    nome,
    email: emailLimpo,
    senhaHash: hashPassword(senha),
    perfil,
    status,
  });
  if (perfil !== 'master') await model.vincularInstituicao(id, idInstituicao);

  if (status === 'pendente') {
    // Com await: na Vercel a função pode ser congelada logo após a resposta.
    try {
      await avisarMastersNovoCadastro({ id, nome, email: emailLimpo, perfil });
    } catch (e) {
      console.error('Erro ao notificar masters sobre novo cadastro pendente:', e);
    }
    return { message: 'Cadastro realizado. Aguarde aprovação do master para acessar o sistema.' };
  }

  const user = {
    id,
    nome,
    email: emailLimpo,
    perfil,
    instituicoes: perfil === 'master' ? [] : [idInstituicao],
  };
  return { message: 'Usuário registrado com sucesso.', token: signToken(user), user };
}

// A mensagem de erro não diz se errou o e-mail ou a senha: não ajuda a
// descobrir quais e-mails estão cadastrados.
async function login(body) {
  const usuario = await model.buscarPorEmailParaLogin(limparEmail(body.email));
  if (!usuario || !verifyPassword(String(body.senha || ''), usuario.senha_hash)) {
    throw new AppError('E-mail ou senha inválidos.', 401);
  }
  if (usuario.status === 'pendente') {
    throw new AppError('Cadastro pendente de aprovação. Aguarde liberação do master.', 403, {
      status: 'pendente',
    });
  }
  if (usuario.status !== 'ativo') {
    throw new AppError('Conta inativa. Entre em contato com o administrador.', 403, {
      status: usuario.status,
    });
  }

  const user = await sessao.montarSessao(usuario);
  return { message: 'Login realizado com sucesso.', token: signToken(user), user };
}

const sessaoDoAluno = (aluno) => ({
  aluno_id: aluno.id,
  nome: aluno.nome,
  perfil: 'aluno',
  id_instituicao: aluno.id_instituicao,
});

// Aluno entra só com o código de 6 dígitos gerado pela equipe. O token dele
// já traz a instituição (o aluno não escolhe instituição).
async function loginAluno(codigoInformado) {
  const codigo = String(codigoInformado || '').trim();
  if (!codigo) throw new AppError('Informe o código de acesso.', 400);

  const aluno = await model.alunoAtivoPorCodigo(codigo);
  if (!aluno) throw new AppError('Código de acesso inválido.', 401);

  const user = sessaoDoAluno(aluno);
  return { message: 'Login realizado com sucesso.', token: signToken(user), user };
}

// Revalida a sessão ao recarregar a página (token de aluno não tem id de usuário).
async function sessaoAtual(usuarioDoToken) {
  if (usuarioDoToken.perfil === 'aluno') {
    const aluno = await model.alunoAtivoPorId(usuarioDoToken.aluno_id);
    if (!aluno) throw new AppError('Aluno não encontrado.', 401);
    return { user: sessaoDoAluno(aluno) };
  }

  const usuario = await model.buscarPorId(usuarioDoToken.id);
  if (!usuario) throw new AppError('Usuário não encontrado.', 401);
  const user = await sessao.montarSessao(usuario);
  return { user: { ...user, status: usuario.status } };
}

// Permissões na instituição ativa: o front chama de novo a cada troca de instituição.
async function permissoes(usuarioDoToken, cabecalhoInstituicao) {
  if (usuarioDoToken.perfil === 'aluno') return { telas_permitidas: [], recursos_permitidos: {} };
  const idInstituicao = parseInt(cabecalhoInstituicao);
  if (usuarioDoToken.perfil !== 'master' && isNaN(idInstituicao)) {
    throw new AppError('Cabeçalho "x-institution-id" é obrigatório.', 400);
  }
  const telas = await sessao.telasPermitidas(usuarioDoToken.perfil, idInstituicao);
  const recursos = await sessao.recursosPermitidos(usuarioDoToken.perfil, telas, idInstituicao);
  return { telas_permitidas: telas, recursos_permitidos: recursos };
}

async function trocarSenha(idUsuario, body) {
  const senhaAtual = String(body.senhaAtual || '');
  const novaSenha = String(body.novaSenha || '');
  if (novaSenha.length < 6)
    throw new AppError('A nova senha deve ter pelo menos 6 caracteres.', 400);

  const hashAtual = await model.senhaHashDoAtivo(idUsuario);
  if (!hashAtual || !verifyPassword(senhaAtual, hashAtual)) {
    throw new AppError('Senha atual incorreta.', 401);
  }
  await model.salvarSenha(idUsuario, hashPassword(novaSenha));
}

// "Esqueci a senha": envia um código de 6 dígitos (guardado com hash). A
// resposta é sempre a mesma, exista ou não o e-mail.
const RESPOSTA_ESQUECI_SENHA = {
  message: 'Se este e-mail estiver cadastrado, um código de verificação foi enviado.',
};

async function esqueciSenha(emailInformado) {
  const emailLimpo = limparEmail(emailInformado);
  if (!emailLimpo) throw new AppError('Informe o e-mail.', 400);

  const usuario = await model.buscarParaRedefinicao(emailLimpo);
  if (!usuario || usuario.status !== 'ativo') return RESPOSTA_ESQUECI_SENHA;

  if (usuario.reset_codigo_expira) {
    const pedidoEm = new Date(usuario.reset_codigo_expira).getTime() - CODIGO_TTL_MS;
    if (Date.now() - pedidoEm < CODIGO_INTERVALO_MS) return RESPOSTA_ESQUECI_SENHA;
  }

  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await model.salvarCodigoRedefinicao(
    usuario.id,
    hashPassword(codigo),
    new Date(Date.now() + CODIGO_TTL_MS),
  );

  if (email.configurado()) {
    try {
      await email.enviarCodigoRedefinicao(emailLimpo, usuario.nome, codigo);
    } catch (e) {
      console.error('Erro ao enviar e-mail de redefinição de senha:', e);
    }
  } else {
    console.warn(
      `[AVISO] RESEND_API_KEY não configurada — código gerado mas não enviado por e-mail (${emailLimpo}): ${codigo}`,
    );
  }
  return RESPOSTA_ESQUECI_SENHA;
}

async function redefinirSenha(body) {
  const codigo = String(body.codigo || '').trim();
  const novaSenha = String(body.novaSenha || '');
  const invalido = () => new AppError('Código inválido ou expirado.', 400);

  if (novaSenha.length < 6)
    throw new AppError('A nova senha deve ter pelo menos 6 caracteres.', 400);
  if (!codigo) throw invalido();

  const usuario = await model.codigoRedefinicaoDoAtivo(limparEmail(body.email));
  if (!usuario || !usuario.reset_codigo_hash || !usuario.reset_codigo_expira) throw invalido();
  if (new Date(usuario.reset_codigo_expira).getTime() < Date.now()) throw invalido();
  if (!verifyPassword(codigo, usuario.reset_codigo_hash)) throw invalido();

  await model.redefinirSenha(usuario.id, hashPassword(novaSenha));
}

// --- Aprovação de cadastro pelo link do e-mail (sem login) ---

function idDoLinkDeAprovacao(token) {
  const payload = verifyToken(token);
  if (!payload || payload.tipo !== 'aprovacao_cadastro' || !payload.usuarioId) {
    throw new AppError('Link inválido ou expirado.', 400);
  }
  return payload.usuarioId;
}

// Só leitura: a tela de confirmação mostra de quem é o cadastro.
async function cadastroParaAprovar(token) {
  const cadastro = await model.resumoDoCadastro(idDoLinkDeAprovacao(token));
  if (!cadastro) throw new AppError('Cadastro não encontrado.', 404);
  return {
    nome: cadastro.nome,
    email: cadastro.email,
    perfil: cadastro.perfil,
    instituicao: cadastro.instituicoes || null,
    jaAprovado: cadastro.status !== 'pendente',
  };
}

// Idempotente: aprovar de novo (outro master, clique duplo) também dá sucesso.
async function aprovarPeloLink(token) {
  const id = idDoLinkDeAprovacao(token);
  const usuario = await model.buscarStatus(id);
  if (!usuario) throw new AppError('Cadastro não encontrado.', 404);
  if (usuario.status === 'pendente') await model.ativar(id);
}

module.exports = {
  cadastrar,
  login,
  loginAluno,
  sessaoAtual,
  permissoes,
  trocarSenha,
  esqueciSenha,
  redefinirSenha,
  cadastroParaAprovar,
  aprovarPeloLink,
};

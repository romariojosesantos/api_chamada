// Administração de usuários (master) e vínculo conta <-> professor (coordenador).
const model = require('./usuarios.model');
const AppError = require('../../utils/AppError');
const { instituicoesDoUsuario } = require('./sessao');
const { hashPassword } = require('./senha');
const {
  lerFormulario,
  exigirCamposValidos,
  resolverIdProfessor,
  resolverAreaCoordenacao,
} = require('./validacao-usuario');

function idValido(valor) {
  const id = parseInt(valor);
  if (isNaN(id)) throw new AppError('ID inválido.', 400);
  return id;
}

async function comInstituicoes(usuarios) {
  const resultado = [];
  for (const u of usuarios) {
    const instituicoes = u.perfil === 'master' ? [] : await instituicoesDoUsuario(u.id, u.perfil);
    resultado.push({ ...u, instituicoes });
  }
  return resultado;
}

const listar = async () => comInstituicoes(await model.listarNaoPendentes());
const listarPendentes = async () => comInstituicoes(await model.listarPendentes());

async function buscarPendente(idTexto) {
  const id = idValido(idTexto);
  const usuario = await model.buscarStatus(id);
  if (!usuario) throw new AppError('Usuário não encontrado.', 404);
  if (usuario.status !== 'pendente') {
    throw new AppError('Este usuário não está pendente de aprovação.', 400);
  }
  return id;
}

async function aprovar(idTexto) {
  await model.ativar(await buscarPendente(idTexto));
}

async function rejeitar(idTexto) {
  await model.excluir(await buscarPendente(idTexto));
}

// Criado pelo master já entra ativo (pula a aprovação).
async function criar(body) {
  const f = lerFormulario(body);
  await exigirCamposValidos({ ...f, idsInstituicoes: f.instituicoes });
  if (f.perfil !== 'master' && f.instituicoes.length === 0) {
    throw new AppError('Vincule ao menos uma instituição ao usuário.', 400);
  }
  if (await model.emailEmUso(f.email)) throw new AppError('Este e-mail já está cadastrado.', 409);

  const idProfessor = await resolverIdProfessor(f.perfil, body.id_professor, f.instituicoes);
  const areaCoordenacao = resolverAreaCoordenacao(f.perfil, body.area_coordenacao);

  const id = await model.inserirPeloAdmin({
    nome: f.nome,
    email: f.email,
    senhaHash: hashPassword(f.senha),
    perfil: f.perfil,
    idProfessor,
    areaCoordenacao,
  });
  for (const idInstituicao of f.instituicoes) await model.vincularInstituicao(id, idInstituicao);
  return id;
}

async function atualizar(idTexto, body) {
  const id = parseInt(idTexto);
  const f = lerFormulario(body);
  const status = String(body.status || '')
    .trim()
    .toLowerCase();

  if (isNaN(id)) throw new AppError('ID inválido.', 400);
  await exigirCamposValidos({
    ...f,
    senha: '',
    exigirSenha: false,
    idsInstituicoes: f.instituicoes,
  });
  if (f.perfil !== 'master' && f.instituicoes.length === 0) {
    throw new AppError('Vincule ao menos uma instituição ao usuário.', 400);
  }
  if (status && !['ativo', 'inativo', 'pendente'].includes(status)) {
    throw new AppError('Status inválido.', 400);
  }
  if (await model.emailEmUso(f.email, id))
    throw new AppError('Este e-mail já está cadastrado.', 409);

  const idProfessor = await resolverIdProfessor(f.perfil, body.id_professor, f.instituicoes);
  const areaCoordenacao = resolverAreaCoordenacao(f.perfil, body.area_coordenacao);

  await model.atualizarPeloAdmin(id, {
    nome: f.nome,
    email: f.email,
    perfil: f.perfil,
    idProfessor,
    areaCoordenacao,
    status,
  });
  await model.substituirInstituicoes(id, f.instituicoes);
}

async function definirSenha(idTexto, senha) {
  const id = idValido(idTexto);
  const novaSenha = String(senha || '');
  if (novaSenha.length < 6) throw new AppError('A senha deve ter pelo menos 6 caracteres.', 400);
  await model.salvarSenha(id, hashPassword(novaSenha));
}

async function professoresDaInstituicao(idTexto) {
  const idInstituicao = parseInt(idTexto);
  if (isNaN(idInstituicao)) throw new AppError('id_instituicao é obrigatório.', 400);
  return model.professoresDaInstituicao(idInstituicao);
}

// --- Vínculo conta <-> professor ---
// Mexe só em id_professor. Coordenador só vê/edita contas de professor que
// compartilham instituição com ele; master vê todas.

const compartilhaInstituicao = (usuario, instituicoes) =>
  instituicoes.some((id) => usuario.instituicoes.includes(id));

async function contasDeProfessor(usuario) {
  const ehMaster = usuario.perfil === 'master';
  if (!ehMaster && usuario.instituicoes.length === 0) return [];

  const resultado = [];
  for (const conta of await model.listarContasDeProfessor()) {
    const instituicoes = await instituicoesDoUsuario(conta.id, 'professor');
    if (!ehMaster && !compartilhaInstituicao(usuario, instituicoes)) continue;
    resultado.push({ ...conta, instituicoes });
  }
  return resultado;
}

async function professoresParaVincular(usuario, idTexto) {
  const idInstituicao = parseInt(idTexto);
  if (isNaN(idInstituicao)) throw new AppError('id_instituicao é obrigatório.', 400);
  if (usuario.perfil !== 'master' && !usuario.instituicoes.includes(idInstituicao)) {
    throw new AppError('Você não tem acesso a essa instituição.', 403);
  }
  return model.professoresDaInstituicao(idInstituicao);
}

async function vincularProfessor(usuario, idTexto, idProfessor) {
  const id = idValido(idTexto);
  const conta = await model.buscarPerfil(id);
  if (!conta) throw new AppError('Usuário não encontrado.', 404);
  if (conta.perfil !== 'professor')
    throw new AppError('Esse usuário não tem perfil professor.', 400);

  const instituicoes = await instituicoesDoUsuario(id, 'professor');
  if (usuario.perfil !== 'master' && !compartilhaInstituicao(usuario, instituicoes)) {
    throw new AppError('Você não tem acesso a esse usuário.', 403);
  }

  await model.vincularProfessor(
    id,
    await resolverIdProfessor('professor', idProfessor, instituicoes),
  );
}

module.exports = {
  listar,
  listarPendentes,
  aprovar,
  rejeitar,
  criar,
  atualizar,
  definirSenha,
  professoresDaInstituicao,
  contasDeProfessor,
  professoresParaVincular,
  vincularProfessor,
};

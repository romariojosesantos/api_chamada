const model = require('./usuarios.model');
const auth = require('./auth.service');
const usuarios = require('./usuarios.service');

// --- Públicas ---

async function instituicoes(req, res) {
  res.json(await model.listarInstituicoes());
}

// O front usa para saber se ainda falta criar o primeiro master.
async function temMaster(req, res) {
  res.json({ hasMaster: await model.existeMaster() });
}

async function cadastrar(req, res) {
  res.status(201).json(await auth.cadastrar(req.body));
}

async function login(req, res) {
  res.json(await auth.login(req.body));
}

async function loginAluno(req, res) {
  res.json(await auth.loginAluno(req.body.codigo_acesso));
}

async function esqueciSenha(req, res) {
  res.json(await auth.esqueciSenha(req.body.email));
}

async function redefinirSenha(req, res) {
  await auth.redefinirSenha(req.body);
  res.json({ message: 'Senha redefinida com sucesso.' });
}

async function cadastroParaAprovar(req, res) {
  res.json(await auth.cadastroParaAprovar(req.params.token));
}

async function aprovarPeloLink(req, res) {
  await auth.aprovarPeloLink(req.params.token);
  res.json({ message: 'Cadastro aprovado com sucesso.' });
}

// --- Usuário logado ---

async function sessaoAtual(req, res) {
  res.json(await auth.sessaoAtual(req.user));
}

async function permissoes(req, res) {
  res.json(await auth.permissoes(req.user, req.headers['x-institution-id']));
}

async function trocarSenha(req, res) {
  await auth.trocarSenha(req.user.id, req.body);
  res.json({ message: 'Senha alterada com sucesso.' });
}

// --- Administração (master) ---

async function professoresDaInstituicao(req, res) {
  res.json(await usuarios.professoresDaInstituicao(req.query.id_instituicao));
}

async function listarUsuarios(req, res) {
  res.json(await usuarios.listar());
}

async function listarPendentes(req, res) {
  res.json(await usuarios.listarPendentes());
}

async function aprovar(req, res) {
  await usuarios.aprovar(req.params.id);
  res.json({ message: 'Usuário aprovado com sucesso.' });
}

async function rejeitar(req, res) {
  await usuarios.rejeitar(req.params.id);
  res.json({ message: 'Cadastro rejeitado e removido com sucesso.' });
}

async function criarUsuario(req, res) {
  const id = await usuarios.criar(req.body);
  res.status(201).json({ message: 'Usuário criado com sucesso.', id });
}

async function atualizarUsuario(req, res) {
  await usuarios.atualizar(req.params.id, req.body);
  res.json({ message: 'Usuário atualizado com sucesso.' });
}

async function definirSenha(req, res) {
  await usuarios.definirSenha(req.params.id, req.body.senha);
  res.json({ message: 'Senha redefinida com sucesso.' });
}

// --- Vínculo conta <-> professor (coordenador ou master) ---

async function contasDeProfessor(req, res) {
  res.json(await usuarios.contasDeProfessor(req.user));
}

async function professoresParaVincular(req, res) {
  res.json(await usuarios.professoresParaVincular(req.user, req.query.id_instituicao));
}

async function vincularProfessor(req, res) {
  await usuarios.vincularProfessor(req.user, req.params.id, req.body.id_professor);
  res.json({ message: 'Vínculo atualizado com sucesso.' });
}

module.exports = {
  instituicoes,
  temMaster,
  cadastrar,
  login,
  loginAluno,
  esqueciSenha,
  redefinirSenha,
  cadastroParaAprovar,
  aprovarPeloLink,
  sessaoAtual,
  permissoes,
  trocarSenha,
  professoresDaInstituicao,
  listarUsuarios,
  listarPendentes,
  aprovar,
  rejeitar,
  criarUsuario,
  atualizarUsuario,
  definirSenha,
  contasDeProfessor,
  professoresParaVincular,
  vincularProfessor,
};

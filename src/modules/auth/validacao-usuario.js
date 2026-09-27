// Validação dos dados de usuário (autocadastro e administração).
const model = require('./usuarios.model');
const AppError = require('../../utils/AppError');
const { AREAS_VALIDAS } = require('../../constants/areas');
const { carregarPerfisEditaveis } = require('../permissoes/permissoes.model');

const PERFIS_FIXOS = ['master', 'coordenador', 'professor', 'monitor'];

const limparEmail = (email) =>
  String(email || '')
    .trim()
    .toLowerCase();

// Campos do formulário já limpos (espaços, maiúsculas, perfil padrão "monitor").
function lerFormulario(body) {
  return {
    nome: String(body.nome || '').trim(),
    email: limparEmail(body.email),
    senha: String(body.senha || ''),
    perfil: String(body.perfil || 'monitor')
      .trim()
      .toLowerCase(),
    instituicoes: Array.isArray(body.instituicoes)
      ? body.instituicoes.map(Number).filter(Boolean)
      : [],
  };
}

// Perfil customizado é por instituição: precisa existir em TODAS as
// instituições do usuário, senão ele ficaria sem telas em alguma delas.
async function validarCampos({
  nome,
  email,
  senha,
  perfil,
  exigirSenha = true,
  idsInstituicoes = [],
}) {
  if (nome.length < 3) return 'Informe um nome com pelo menos 3 caracteres.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Informe um e-mail válido.';
  if (exigirSenha && senha.length < 6) return 'A senha deve ter pelo menos 6 caracteres.';
  if (PERFIS_FIXOS.includes(perfil)) return null;
  if (idsInstituicoes.length === 0) {
    return 'Selecione ao menos uma instituição para usar um perfil customizado.';
  }
  for (const idInstituicao of idsInstituicoes) {
    if (!(await carregarPerfisEditaveis(idInstituicao)).includes(perfil)) {
      return `Perfil "${perfil}" não existe na instituição selecionada (ID ${idInstituicao}). Crie-o antes pela tela de Permissões.`;
    }
  }
  return null;
}

async function exigirCamposValidos(dados) {
  const erro = await validarCampos(dados);
  if (erro) throw new AppError(erro, 400);
}

// Conta de perfil "professor" pode ser ligada a um cadastro de professor, que
// precisa ser de uma das instituições do usuário. Devolve o id ou null.
async function resolverIdProfessor(perfil, idProfessor, idsInstituicoes) {
  if (perfil !== 'professor' || !idProfessor) return null;
  const professor = await model.buscarProfessor(idProfessor);
  if (!professor) throw new AppError('Professor não encontrado.', 400);
  if (!idsInstituicoes.includes(professor.id_instituicao)) {
    throw new AppError(
      'Esse professor pertence a uma instituição não vinculada a este usuário.',
      400,
    );
  }
  return professor.id;
}

// Só coordenador tem área: null = coordenador geral (todas as áreas).
function resolverAreaCoordenacao(perfil, area) {
  if (perfil !== 'coordenador' || !area) return null;
  if (!AREAS_VALIDAS.includes(area)) throw new AppError('Área de coordenação inválida.', 400);
  return area;
}

module.exports = {
  limparEmail,
  lerFormulario,
  exigirCamposValidos,
  resolverIdProfessor,
  resolverAreaCoordenacao,
};

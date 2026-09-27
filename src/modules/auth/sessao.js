// O que o usuário logado pode ver e fazer.
const model = require('./usuarios.model');
const { TELAS_VALIDAS, RECURSOS_VALIDOS } = require('../../constants/telas');

// Master acessa todas as instituições sem vínculo em usuario_instituicoes.
async function instituicoesDoUsuario(idUsuario, perfil) {
  if (perfil === 'master') return [];
  return model.idsDasInstituicoes(idUsuario);
}

// Telas do perfil na instituição. Master tem todas, fixo aqui, para não
// conseguir se trancar fora do sistema pela tela de Permissões. Perfil
// customizado usa a mesma tabela; perfil sem configuração não vê nada.
async function telasPermitidas(perfil, idInstituicao) {
  if (perfil === 'master') return TELAS_VALIDAS;
  return model.telasDoPerfil(perfil, idInstituicao);
}

// Ações liberadas em cada tela. A tabela guarda o que foi BLOQUEADO: tela nunca
// configurada continua com tudo liberado.
async function recursosPermitidos(perfil, telas, idInstituicao) {
  if (perfil === 'master') {
    return Object.fromEntries(telas.map((tela) => [tela, RECURSOS_VALIDOS]));
  }
  const bloqueadosPorTela = {};
  for (const r of await model.recursosBloqueados(perfil, idInstituicao)) {
    if (!bloqueadosPorTela[r.tela]) bloqueadosPorTela[r.tela] = [];
    bloqueadosPorTela[r.tela].push(r.recurso);
  }
  const recursos = {};
  for (const tela of telas) {
    const bloqueados = bloqueadosPorTela[tela] || [];
    recursos[tela] = RECURSOS_VALIDOS.filter((r) => !bloqueados.includes(r));
  }
  return recursos;
}

// Dados da sessão (vão no token e para o front). Telas e ações ficam de fora:
// dependem da instituição escolhida depois do login (ver /minhas-permissoes).
// id_professor e area_coordenacao estão no token, então mudá-los só vale no
// próximo login.
async function montarSessao(usuario) {
  const instituicoes = await instituicoesDoUsuario(usuario.id, usuario.perfil);
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    perfil: usuario.perfil,
    id_professor: usuario.id_professor || null,
    area_coordenacao: usuario.area_coordenacao || null,
    instituicoes,
  };
}

module.exports = { instituicoesDoUsuario, telasPermitidas, recursosPermitidos, montarSessao };

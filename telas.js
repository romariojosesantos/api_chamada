// Lista fixa de telas editáveis na tela de Permissões (master escolhe quais
// telas cada perfil não-master acessa — ver backend/permissoes.js). Mesma
// lista (por path) usada pelo front pra montar o checklist e pra decidir
// menu/rota (ver PerfilRoute e menuItemsBase em frontend/src/App.js e
// frontend/src/Components/Layout.jsx).
//
// De propósito NÃO incluem /admin-usuarios e /historico-aluno: essas duas
// telas têm um redirecionamento pra master hardcoded dentro do próprio
// componente React (AdminUsuarios.js, HistoricoAlunoMaster.js) — marcar pra
// outro perfil aqui não teria efeito real, só confundiria. /trocar-senha e
// /foguinhos também ficam de fora (sempre liberadas pra qualquer perfil
// logado, sem depender de configuração nenhuma do master).
const pool = require('./db');

const TELAS = [
  { tela: '/', label: 'Chamada' },
  { tela: '/notificacoes', label: 'Notificações' },
  { tela: '/relatorio-diario', label: 'Painel do Gestor' },
  { tela: '/grade', label: 'Grade' },
  { tela: '/ajuste-grade', label: 'Ajuste Grade' },
  { tela: '/grade-turmas', label: 'Grade por Turma' },
  { tela: '/turmas', label: 'Turmas' },
  { tela: '/professores', label: 'Educadores' },
  { tela: '/gerenciar-matriculas', label: 'Matrículas' },
  { tela: '/dias-sem-aula', label: 'Dias Sem Aula' },
  { tela: '/meritocracia', label: 'Meritocracia' },
  { tela: '/ocorrencias', label: 'Ocorrências' },
  { tela: '/carater', label: 'Formação de Caráter' },
  { tela: '/notas', label: 'Notas' },
  { tela: '/pontos', label: 'Ponto' },
  { tela: '/vincular-professor', label: 'Vincular Educador' },
  { tela: '/listas', label: 'Listas' },
  { tela: '/termos', label: 'Termos' },
  { tela: '/devolucoes', label: 'Devolução de Materiais' },
];

const TELAS_VALIDAS = TELAS.map(t => t.tela);

// Perfis fixos no código, sempre editáveis pela tela de Permissões. Além
// desses, o master pode criar perfis novos "genéricos" direto pela tela (ver
// perfis-customizados.js) — carregarPerfisEditaveis() abaixo é quem junta os
// dois. Um perfil customizado nunca herda o vínculo com professor (bater
// ponto, lançar nota por turma) nem o escopo por área de coordenador: essas
// duas coisas checam o texto exato "professor"/"coordenador" em vários
// lugares (ver resolverIdProfessor/resolverAreaCoordenacao em auth.js), não
// esta lista — um perfil novo só tem o que o master marcar em tela/recurso.
const PERFIS_EDITAVEIS_BASE = ['monitor', 'professor', 'coordenador'];

// Lista completa de perfis editáveis AGORA (fixos + customizados) — sempre
// consulta o banco na hora (mesmo espírito de exigirRecurso em
// permissoes-middleware.js: perfil customizado pode ser criado/apagado a
// qualquer momento, uma lista estática ficaria desatualizada).
// Customizados são POR INSTITUIÇÃO (cada instituição cria os seus, ver
// perfis-customizados.js) — os fixos continuam valendo em qualquer uma.
async function carregarPerfisEditaveis(idInstituicao) {
  const [rows] = await pool.query('SELECT chave FROM perfis_customizados WHERE id_instituicao = ? ORDER BY chave', [idInstituicao]);
  return [...PERFIS_EDITAVEIS_BASE, ...rows.map(r => r.chave)];
}

// Ações genéricas dentro de uma tela (ver permissoes_perfil_recurso em
// backend/permissoes.js) — mesmo conjunto pra todas as telas, por
// simplicidade. Bloqueio de verdade em backend/permissoes-middleware.js,
// aplicado nas rotas de criar/editar/excluir de cada tela.
const RECURSOS = [
  { recurso: 'visualizar', label: 'Visualizar' },
  { recurso: 'criar', label: 'Criar' },
  { recurso: 'editar', label: 'Editar' },
  { recurso: 'excluir', label: 'Excluir' },
  { recurso: 'exportar', label: 'Exportar' },
];

const RECURSOS_VALIDOS = RECURSOS.map(r => r.recurso);

module.exports = { TELAS, TELAS_VALIDAS, PERFIS_EDITAVEIS_BASE, carregarPerfisEditaveis, RECURSOS, RECURSOS_VALIDOS };

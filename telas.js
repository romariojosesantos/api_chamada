// Lista fixa de telas editáveis na tela de Permissões (master escolhe quais
// telas cada perfil não-master acessa — ver backend/permissoes.js). Mesma
// lista (por path) usada pelo front pra montar o checklist e pra decidir
// menu/rota (ver PerfilRoute e menuItemsBase em frontend/src/App.js e
// frontend/src/Components/Layout.jsx).
//
// De propósito NÃO incluem /admin-usuarios e /historico-aluno: essas duas
// telas têm um redirecionamento pra master hardcoded dentro do próprio
// componente React (AdminUsuarios.js, HistoricoAlunoMaster.js) — marcar pra
// outro perfil aqui não teria efeito real, só confundiria. /trocar-senha
// também fica de fora (sempre liberada pra qualquer perfil logado).
const TELAS = [
  { tela: '/', label: 'Chamada' },
  { tela: '/notificacoes', label: 'Notificações' },
  { tela: '/relatorio-diario', label: 'Relatórios' },
  { tela: '/grade', label: 'Grade' },
  { tela: '/ajuste-grade', label: 'Ajuste Grade' },
  { tela: '/grade-turmas', label: 'Grade por Turma' },
  { tela: '/turmas', label: 'Turmas' },
  { tela: '/professores', label: 'Educadores' },
  { tela: '/gerenciar-matriculas', label: 'Matrículas' },
  { tela: '/dias-sem-aula', label: 'Dias Sem Aula' },
  { tela: '/meritocracia', label: 'Meritocracia' },
  { tela: '/carater', label: 'Formação de Caráter' },
  { tela: '/notas', label: 'Notas' },
  { tela: '/pontos', label: 'Ponto' },
  { tela: '/vincular-professor', label: 'Vincular Educador' },
  { tela: '/listas', label: 'Listas' },
];

const TELAS_VALIDAS = TELAS.map(t => t.tela);
const PERFIS_EDITAVEIS = ['monitor', 'professor', 'coordenador'];

module.exports = { TELAS, TELAS_VALIDAS, PERFIS_EDITAVEIS };

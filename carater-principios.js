// Os 7 princípios da Educação por Princípios — conteúdo fixo (como PERFIS em
// auth.js), não vem do banco. `id` é o valor gravado na coluna `principio` de
// missoes_carater/atos_carater; `chave` é um slug estável pro frontend mapear
// ícone/cor sem depender do texto do nome (que pode ser editado aqui sem
// quebrar nada já gravado).
const PRINCIPIOS_CARATER = [
  { id: 1, chave: 'individualidade', nome: 'Individualidade', descricao: 'Cada aluno é único, criado com propósito e talentos próprios.' },
  { id: 2, chave: 'autogoverno', nome: 'Autogoverno', descricao: 'Capacidade de se governar internamente antes de precisar de regras externas.' },
  { id: 3, chave: 'consciencia', nome: 'Consciência', descricao: 'Agir de acordo com as próprias convicções, mesmo sem ninguém vendo.' },
  { id: 4, chave: 'forma_de_governo', nome: 'Forma de Governo', descricao: 'Responsabilidade compartilhada, respeito à autoridade e à ordem.' },
  { id: 5, chave: 'semeadura_colheita', nome: 'Semeadura e Colheita', descricao: 'Toda escolha tem consequência — colhemos o que plantamos.' },
  { id: 6, chave: 'carater_cristao', nome: 'Caráter Cristão', descricao: 'Virtudes vividas no dia a dia: honestidade, bondade, perseverança.' },
  { id: 7, chave: 'missao_de_vida', nome: 'Missão de Vida', descricao: 'Viver com propósito e servir aos outros — liderança servidora.' }
];

const PRINCIPIO_IDS = PRINCIPIOS_CARATER.map(p => p.id);

module.exports = { PRINCIPIOS_CARATER, PRINCIPIO_IDS };

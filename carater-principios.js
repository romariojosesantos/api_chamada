// Os 7 princípios usados pela instituição — conteúdo fixo (como PERFIS em
// auth.js), não vem do banco. `id` é o valor gravado na coluna `principio` de
// missoes_carater/atos_carater; `chave` é um slug estável pro frontend mapear
// ícone/cor sem depender do texto do nome (que pode ser editado aqui sem
// quebrar nada já gravado).
const PRINCIPIOS_CARATER = [
  { id: 1, chave: 'carater', nome: 'Caráter', descricao: 'A base de toda escolha e ação — quem se é quando ninguém está vendo.' },
  { id: 2, chave: 'soberania', nome: 'Soberania', descricao: 'Reconhecer a autoridade de Deus acima de tudo e de todos.' },
  { id: 3, chave: 'individualidade', nome: 'Individualidade', descricao: 'Cada aluno é único, criado com propósito e talentos próprios.' },
  { id: 4, chave: 'alianca', nome: 'Aliança', descricao: 'Compromissos e relações vividos com fidelidade — a palavra dada tem peso.' },
  { id: 5, chave: 'autogoverno', nome: 'Autogoverno', descricao: 'Capacidade de se governar internamente antes de precisar de regras externas.' },
  { id: 6, chave: 'semear_colher', nome: 'Semear e Colher', descricao: 'Toda escolha tem consequência — colhemos o que plantamos.' },
  { id: 7, chave: 'mordomia', nome: 'Mordomia', descricao: 'Administrar com responsabilidade tudo o que foi confiado — tempo, talentos, recursos.' }
];

const PRINCIPIO_IDS = PRINCIPIOS_CARATER.map(p => p.id);

module.exports = { PRINCIPIOS_CARATER, PRINCIPIO_IDS };

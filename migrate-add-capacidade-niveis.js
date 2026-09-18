// Migração: cria a tabela de capacidade fixa por nível/turno de cada
// instituição — usada na tela "Estatísticas" (ver estatisticas-comparativas.js)
// pra comparar "quantos alunos tem matriculados" com "quantas vagas existem",
// mostrando a % de ocupação. É um número que o master/coordenador digita
// manualmente (não vem de nenhuma outra tabela — capacidade física da turma
// não é um dado que o sistema calcula sozinho), por isso a tabela só guarda
// o valor em si; quem preenche é a própria tela, célula a célula.
// Idempotente (CREATE TABLE IF NOT EXISTS), mesmo padrão de migrate-add-notas.js.
const mysql = require('mysql2/promise');
require('dotenv').config();

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306
  });

  try {
    console.log('Conectado ao banco. Criando tabela capacidade_niveis...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS capacidade_niveis (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_instituicao INT NOT NULL,
        nivel TINYINT NOT NULL,
        turno VARCHAR(10) NOT NULL,
        capacidade INT NOT NULL DEFAULT 0,
        atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_capacidade_inst_nivel_turno (id_instituicao, nivel, turno),
        FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id) ON DELETE CASCADE
      )
    `);
    console.log('Tabela capacidade_niveis OK.');

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});

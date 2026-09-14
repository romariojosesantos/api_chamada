// Migração: tabelas `listas`/`lista_alunos` — agrupamentos nomeados de
// alunos por instituição (tela "Listas", estilo Apple Notas: título + busca
// pra adicionar aluno). Também libera a tela pra "coordenador" na tabela de
// permissões (master já tem tudo, fixo em backend/auth.js — não precisa de
// linha na tabela).
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
    console.log('Conectado ao banco.');

    const [tabelaListas] = await db.query("SHOW TABLES LIKE 'listas'");
    if (tabelaListas.length === 0) {
      await db.query(`
        CREATE TABLE listas (
          id INT PRIMARY KEY AUTO_INCREMENT,
          id_instituicao INT NOT NULL,
          titulo VARCHAR(100) NOT NULL,
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id)
        ) ENGINE=InnoDB
      `);
      console.log('Tabela listas criada.');
    } else {
      console.log('Tabela listas já existia.');
    }

    const [tabelaListaAlunos] = await db.query("SHOW TABLES LIKE 'lista_alunos'");
    if (tabelaListaAlunos.length === 0) {
      await db.query(`
        CREATE TABLE lista_alunos (
          id_lista INT NOT NULL,
          id_aluno INT NOT NULL,
          adicionado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id_lista, id_aluno),
          FOREIGN KEY (id_lista) REFERENCES listas(id) ON DELETE CASCADE,
          FOREIGN KEY (id_aluno) REFERENCES alunos(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);
      console.log('Tabela lista_alunos criada.');
    } else {
      console.log('Tabela lista_alunos já existia.');
    }

    const [jaTemPermissao] = await db.query(
      "SELECT 1 FROM permissoes_perfil WHERE perfil = 'coordenador' AND tela = '/listas'"
    );
    if (jaTemPermissao.length === 0) {
      await db.query("INSERT INTO permissoes_perfil (perfil, tela) VALUES ('coordenador', '/listas')");
      console.log('Permissão de coordenador pra /listas inserida.');
    } else {
      console.log('Permissão de coordenador pra /listas já existia.');
    }

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});

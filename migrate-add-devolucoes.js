// Migração: tabelas `itens_devolucao`/`itens_devolucao_registros` — controle
// de devolução de uniforme e outros materiais por alunos INATIVOS (mesmo
// espírito da tela Termos, mas o público é quem já saiu, não quem está
// ativo). Cada instituição cria/apaga os seus próprios itens. Também libera
// a tela pra "coordenador" na tabela de permissões (master já tem tudo).
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

    const [tabelaItens] = await db.query("SHOW TABLES LIKE 'itens_devolucao'");
    if (tabelaItens.length === 0) {
      await db.query(`
        CREATE TABLE itens_devolucao (
          id INT PRIMARY KEY AUTO_INCREMENT,
          id_instituicao INT NOT NULL,
          nome VARCHAR(150) NOT NULL,
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id)
        ) ENGINE=InnoDB
      `);
      console.log('Tabela itens_devolucao criada.');
    } else {
      console.log('Tabela itens_devolucao já existia.');
    }

    const [tabelaRegistros] = await db.query("SHOW TABLES LIKE 'itens_devolucao_registros'");
    if (tabelaRegistros.length === 0) {
      await db.query(`
        CREATE TABLE itens_devolucao_registros (
          id_item INT NOT NULL,
          id_aluno INT NOT NULL,
          devolvido_em DATE NOT NULL,
          PRIMARY KEY (id_item, id_aluno),
          FOREIGN KEY (id_item) REFERENCES itens_devolucao(id) ON DELETE CASCADE,
          FOREIGN KEY (id_aluno) REFERENCES alunos(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);
      console.log('Tabela itens_devolucao_registros criada.');
    } else {
      console.log('Tabela itens_devolucao_registros já existia.');
    }

    const [jaTemPermissao] = await db.query(
      "SELECT 1 FROM permissoes_perfil WHERE perfil = 'coordenador' AND tela = '/devolucoes'"
    );
    if (jaTemPermissao.length === 0) {
      await db.query("INSERT INTO permissoes_perfil (perfil, tela) VALUES ('coordenador', '/devolucoes')");
      console.log('Permissão de coordenador pra /devolucoes inserida.');
    } else {
      console.log('Permissão de coordenador pra /devolucoes já existia.');
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

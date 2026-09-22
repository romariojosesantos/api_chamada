// Migração: tabela `aluno_ocorrencias` — registro de ocorrências de
// comportamento (negativas) usadas pela reforma da Meritocracia, que passa a
// somar pontos por presença (1 ponto cada) e descontar um percentual por
// ocorrência registrada (leve -25%, grave -50%, gravíssima -100%, somando até
// no máximo 100% de desconto quando há mais de uma no período).
//
// Efeito imediato (sem fila de confirmação, diferente do sistema de Formação
// de Caráter): quem registra é a própria equipe (educador/coordenador/
// monitor), soft-delete pra permitir desfazer engano sem perder o histórico.
//
// Também já cria a tela "/ocorrencias" no catálogo de permissões e concede
// acesso por padrão a monitor/professor/coordenador em TODAS as instituições
// existentes — sem isso ninguém além do master enxergaria a tela no dia em
// que isso for pro ar (telas são allow-list, não deny-list; ver
// backend/telas.js e migrate-permissoes-por-instituicao.js, mesmo espírito
// usado aqui).
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

    const [tabela] = await db.query("SHOW TABLES LIKE 'aluno_ocorrencias'");
    if (tabela.length === 0) {
      await db.query(`
        CREATE TABLE aluno_ocorrencias (
          id INT AUTO_INCREMENT PRIMARY KEY,
          id_instituicao INT NOT NULL,
          id_aluno INT NOT NULL,
          gravidade ENUM('leve','grave','gravissima') NOT NULL,
          percentual_aplicado INT NOT NULL,
          descricao TEXT NOT NULL,
          data_ocorrencia DATE NOT NULL,
          registrado_por INT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          excluido_em DATETIME NULL,
          excluido_por INT NULL,
          INDEX idx_ocorrencias_aluno (id_aluno),
          INDEX idx_ocorrencias_instituicao (id_instituicao),
          INDEX idx_ocorrencias_data (data_ocorrencia),
          CONSTRAINT fk_ocorrencias_aluno FOREIGN KEY (id_aluno) REFERENCES alunos(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);
      console.log('Tabela aluno_ocorrencias criada.');
    } else {
      console.log('Tabela aluno_ocorrencias já existia.');
    }

    const [instituicoes] = await db.query('SELECT id FROM instituicoes');
    const perfis = ['monitor', 'professor', 'coordenador'];
    let inseridos = 0;
    for (const inst of instituicoes) {
      for (const perfil of perfis) {
        const [result] = await db.query(
          'INSERT IGNORE INTO permissoes_perfil (id_instituicao, perfil, tela) VALUES (?, ?, ?)',
          [inst.id, perfil, '/ocorrencias']
        );
        inseridos += result.affectedRows;
      }
    }
    console.log(`Acesso padrão à tela /ocorrencias concedido: ${inseridos} linha(s) nova(s) em permissoes_perfil (monitor/professor/coordenador × ${instituicoes.length} instituição(ões)).`);

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});

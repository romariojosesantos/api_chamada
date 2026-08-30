// Migração: transforma o conceito de "atividade" de "um nome com N horários
// misturados" para "um nome + professor + dia + horário + turno = uma turma".
//
// Hoje uma atividade (ex.: "Violino 1") pode ter várias turmas de ~10 alunos
// cada, em dias/horários diferentes, todas empilhadas debaixo do mesmo
// idatividades — o que torna as colunas dia_semana/horario/turno de
// `atividades` inúteis (uma turma não pode ter 18 horários ao mesmo tempo).
//
// Esta migração:
//   1. Pra cada idatividades, descobre as combinações distintas de
//      (dia_semana, horario, turno) usadas em `matricula` (ativas + histórico).
//   2. A 1ª combinação de cada atividade fica na própria linha (só preenche as
//      3 colunas — nada mais muda).
//   3. Cada combinação extra vira uma linha NOVA em `atividades` (mesmo nome +
//      professor, dia/horário/turno da combinação).
//   4. As matrículas dessas combinações extras são reapontadas em massa (1
//      UPDATE...JOIN, não um loop por linha) para a nova linha.
//
// Roda por padrão em modo DRY-RUN (só mostra o que faria). Passe --aplicar
// pra executar de verdade, dentro de uma transação.
const pool = require('./db');

const APLICAR = process.argv.includes('--aplicar');

async function main() {
  const conn = await pool.getConnection();
  try {
    // 1. Combinações distintas usadas em matricula (ativas + histórico), com o
    //    nome/professor/instituição da atividade original pra poder clonar.
    const [combos] = await conn.query(`
      SELECT m.idatividades AS old_id, m.dia_semana, m.horario, m.turno,
             atv.nome, atv.idprofessor, atv.id_instituicao,
             COUNT(*) as qtd_matriculas
      FROM matricula m
      JOIN atividades atv ON atv.idatividades = m.idatividades
      GROUP BY m.idatividades, m.dia_semana, m.horario, m.turno
      ORDER BY m.idatividades, m.dia_semana, m.horario, m.turno
    `);

    // 2. Agrupa por idatividades: a 1ª combinação de cada grupo "fica" na
    //    linha original; as demais precisam de linha nova.
    const porAtividade = new Map();
    for (const c of combos) {
      if (!porAtividade.has(c.old_id)) porAtividade.set(c.old_id, []);
      porAtividade.get(c.old_id).push(c);
    }

    const manterNaOriginal = []; // 1 por atividade: { old_id, dia_semana, horario, turno }
    const criarNova = []; // as combinações extras: { old_id, nome, idprofessor, id_instituicao, dia_semana, horario, turno }

    for (const [oldId, lista] of porAtividade) {
      manterNaOriginal.push(lista[0]);
      for (let i = 1; i < lista.length; i++) {
        criarNova.push(lista[i]);
      }
    }

    console.log(`Atividades com matrícula: ${porAtividade.size}`);
    console.log(`Combinações que ficam na linha original: ${manterNaOriginal.length}`);
    console.log(`Linhas novas de atividade a criar: ${criarNova.length}`);

    if (!APLICAR) {
      console.log('\n[DRY-RUN] Nada foi alterado. Rode com --aplicar para executar de verdade.');
      console.log('\nExemplo de linhas novas que seriam criadas (5 primeiras):');
      criarNova.slice(0, 5).forEach(c => {
        console.log(`  "${c.nome}" (prof ${c.idprofessor}) -> ${c.dia_semana} ${c.horario} (${c.turno}) [${c.qtd_matriculas} matrículas a reapontar]`);
      });
      return;
    }

    await conn.beginTransaction();

    // 3. Preenche dia/horario/turno na linha original de cada atividade
    //    (1 UPDATE em massa com CASE, não um loop).
    if (manterNaOriginal.length > 0) {
      const ids = manterNaOriginal.map(c => c.old_id);
      const diaCase = manterNaOriginal.map(c => `WHEN ${c.old_id} THEN ${conn.escape(c.dia_semana)}`).join(' ');
      const horarioCase = manterNaOriginal.map(c => `WHEN ${c.old_id} THEN ${conn.escape(c.horario)}`).join(' ');
      const turnoCase = manterNaOriginal.map(c => `WHEN ${c.old_id} THEN ${conn.escape(c.turno)}`).join(' ');
      await conn.query(`
        UPDATE atividades
        SET dia_semana = CASE idatividades ${diaCase} END,
            horario = CASE idatividades ${horarioCase} END,
            turno = CASE idatividades ${turnoCase} END
        WHERE idatividades IN (${ids.join(',')})
      `);
      console.log(`OK: ${manterNaOriginal.length} linhas originais atualizadas com dia/horário/turno.`);
    }

    // 4. Insere as linhas novas em lote e recupera os IDs gerados (MySQL
    //    garante IDs contíguos a partir de LAST_INSERT_ID() num INSERT em
    //    lote de conexão única — por isso não precisamos reconsultar).
    let novosIds = [];
    if (criarNova.length > 0) {
      const values = criarNova.map(c => [c.nome, c.idprofessor, c.id_instituicao, c.dia_semana, c.horario, c.turno]);
      const [insertResult] = await conn.query(
        `INSERT INTO atividades (nome, idprofessor, id_instituicao, dia_semana, horario, turno) VALUES ?`,
        [values]
      );
      const primeiroId = insertResult.insertId;
      novosIds = criarNova.map((_, idx) => primeiroId + idx);
      console.log(`OK: ${criarNova.length} linhas novas de atividade inseridas (ids ${primeiroId}..${primeiroId + criarNova.length - 1}).`);
    }

    // 5. Reaponta as matrículas de cada combinação extra pra sua linha nova,
    //    via tabela temporária + 1 UPDATE...JOIN em massa (rápido mesmo com
    //    milhares de matrículas — nada de loop por linha).
    if (criarNova.length > 0) {
      await conn.query(`
        CREATE TEMPORARY TABLE _migracao_slots (
          old_id INT, dia_semana VARCHAR(45), horario VARCHAR(45), turno VARCHAR(45), new_id INT,
          PRIMARY KEY (old_id, dia_semana, horario, turno)
        )
      `);
      const linhasTemp = criarNova.map((c, idx) => [c.old_id, c.dia_semana, c.horario, c.turno, novosIds[idx]]);
      await conn.query(`INSERT INTO _migracao_slots (old_id, dia_semana, horario, turno, new_id) VALUES ?`, [linhasTemp]);

      const [updateResult] = await conn.query(`
        UPDATE matricula m
        JOIN _migracao_slots s
          ON m.idatividades = s.old_id
         AND m.dia_semana = s.dia_semana
         AND m.horario = s.horario
         AND m.turno = s.turno
        SET m.idatividades = s.new_id
      `);
      console.log(`OK: ${updateResult.affectedRows} matrículas reapontadas para as novas turmas.`);

      await conn.query('DROP TEMPORARY TABLE _migracao_slots');
    }

    await conn.commit();
    console.log('\nMigração concluída e commitada com sucesso.');
  } catch (err) {
    await conn.rollback();
    console.error('\nERRO — transação desfeita (rollback). Nada foi alterado.', err);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

main();

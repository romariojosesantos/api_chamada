const pool = require('./db');

async function verificarTodosAlunosSemPresenca() {
  try {
    console.log('Buscando TODOS os alunos e verificando presenças...');
    
    // Query para encontrar TODOS os alunos que não têm registros na tabela presenca
    const [rows] = await pool.query(`
      SELECT 
        a.id, 
        a.nome, 
        a.status AS status_aluno,
        a.turno, 
        a.id_instituicao, 
        i.nome AS nome_instituicao,
        COUNT(p.id) AS total_presencas,
        CASE 
          WHEN m.idaluno IS NOT NULL THEN 'Sim'
          ELSE 'Não'
        END AS tem_matricula,
        CASE 
          WHEN m.status = 'matriculado' THEN 'Matriculado'
          WHEN m.status = 'encerrada' THEN 'Encerrada'
          ELSE 'Sem status'
        END AS status_matricula
      FROM alunos a
      JOIN instituicoes i ON a.id_instituicao = i.id
      LEFT JOIN matricula m ON a.id = m.idaluno
      LEFT JOIN presenca p ON a.id = p.aluno_id
      GROUP BY a.id, a.nome, a.status, a.turno, a.id_instituicao, i.nome, m.idaluno, m.status
      HAVING total_presencas = 0  -- NÃO TEM NENHUMA PRESENÇA
      ORDER BY a.nome ASC
    `);

    if (rows.length === 0) {
      console.log('Todos os alunos possuem pelo menos uma presença registrada.');
    } else {
      console.log(`\n${rows.length} aluno(s) SEM NENHUMA presença registrada:\n`);
      console.table(rows);
      
      // Estatísticas detalhadas
      const stats = {
        total: rows.length,
        ativos: rows.filter(a => a.status_aluno === 'ativo').length,
        inativos: rows.filter(a => a.status_aluno === 'inativo').length,
        comMatricula: rows.filter(a => a.tem_matricula === 'Sim').length,
        semMatricula: rows.filter(a => a.tem_matricula === 'Não').length,
        matriculados: rows.filter(a => a.status_matricula === 'Matriculado').length,
        matriculaEncerrada: rows.filter(a => a.status_matricula === 'Encerrada').length
      };

      console.log('\n=== ESTATÍSTICAS GERAIS ===');
      console.log(`Total sem presença: ${stats.total}`);
      console.log(`Alunos ativos: ${stats.ativos}`);
      console.log(`Alunos inativos: ${stats.inativos}`);
      console.log(`Com matrícula: ${stats.comMatricula}`);
      console.log(`Sem matrícula: ${stats.semMatricula}`);
      console.log(`Matrícula ativa: ${stats.matriculados}`);
      console.log(`Matrícula encerrada: ${stats.matriculaEncerrada}`);

      // Agrupar por turno
      const porTurno = {};
      rows.forEach(aluno => {
        const turno = aluno.turno || 'SEM TURNO';
        if (!porTurno[turno]) porTurno[turno] = { total: 0, ativos: 0 };
        porTurno[turno].total++;
        if (aluno.status_aluno === 'ativo') porTurno[turno].ativos++;
      });

      console.log('\n--- Resumo por turno ---');
      Object.entries(porTurno).forEach(([turno, data]) => {
        console.log(`${turno}: ${data.total} alunos (${data.ativos} ativos)`);
      });

      // Agrupar por instituição
      const porInstituicao = {};
      rows.forEach(aluno => {
        const inst = aluno.nome_instituicao;
        if (!porInstituicao[inst]) porInstituicao[inst] = { total: 0, ativos: 0 };
        porInstituicao[inst].total++;
        if (aluno.status_aluno === 'ativo') porInstituicao[inst].ativos++;
      });

      console.log('\n--- Resumo por instituição ---');
      Object.entries(porInstituicao).forEach(([inst, data]) => {
        console.log(`${inst}: ${data.total} alunos (${data.ativos} ativos)`);
      });

      // Detalhe dos alunos ativos sem presença (os mais críticos)
      const ativosSemPresenca = rows.filter(a => a.status_aluno === 'ativo');
      if (ativosSemPresenca.length > 0) {
        console.log('\n=== ALUNOS ATIVOS SEM PRESENÇA (CRÍTICOS) ===');
        ativosSemPresenca.forEach(aluno => {
          console.log(`- ${aluno.nome} (${aluno.turno}) - ${aluno.nome_instituicao}`);
        });
      }
    }
  } catch (err) {
    console.error('Erro ao verificar alunos sem presença:', err);
  } finally {
    await pool.end();
  }
}

verificarTodosAlunosSemPresenca();

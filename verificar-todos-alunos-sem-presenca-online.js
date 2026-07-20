const mysql = require('mysql2/promise');
const XLSX = require('xlsx');
const path = require('path');

// Configuração do banco online
const dbConfig = {
  host: '31.97.83.209',
  port: 3306,
  user: 'romario_novo',
  password: 'RomarioSantos2025',
  database: 'chamada_conexao',
  timezone: 'America/Sao_Paulo'
};

async function verificarTodosAlunosSemPresencaOnline() {
  let pool;
  try {
    console.log('Conectando ao banco online...');
    pool = mysql.createPool(dbConfig);
    
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
      return;
    }

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

    // Gerar Excel completo
    await gerarExcelCompleto(rows, stats, porTurno, porInstituicao, ativosSemPresenca);

  } catch (err) {
    console.error('Erro ao verificar alunos sem presença:', err);
  } finally {
    if (pool) await pool.end();
  }
}

async function gerarExcelCompleto(rows, stats, porTurno, porInstituicao, ativosSemPresenca) {
  try {
    // Criar workbook
    const wb = XLSX.utils.book_new();

    // Aba 1: Todos os alunos sem presença
    const dadosGeral = rows.map((aluno, index) => ({
      'Nº': index + 1,
      'ID Aluno': aluno.id,
      'Nome': aluno.nome,
      'Status Aluno': aluno.status_aluno,
      'Turno': aluno.turno || 'SEM TURNO',
      'ID Instituição': aluno.id_instituicao,
      'Instituição': aluno.nome_instituicao,
      'Tem Matrícula': aluno.tem_matricula,
      'Status Matrícula': aluno.status_matricula,
      'Total de Presenças': 0
    }));

    const wsGeral = XLSX.utils.json_to_sheet(dadosGeral);
    wsGeral['!cols'] = [
      { wch: 5 }, { wch: 10 }, { wch: 50 }, { wch: 12 }, { wch: 15 },
      { wch: 15 }, { wch: 25 }, { wch: 12 }, { wch: 15 }, { wch: 18 }
    ];
    XLSX.utils.book_append_sheet(wb, wsGeral, 'Todos Sem Presença');

    // Aba 2: Apenas alunos ativos (críticos)
    if (ativosSemPresenca.length > 0) {
      const dadosAtivos = ativosSemPresenca.map((aluno, index) => ({
        'Nº': index + 1,
        'ID Aluno': aluno.id,
        'Nome': aluno.nome,
        'Turno': aluno.turno || 'SEM TURNO',
        'Instituição': aluno.nome_instituicao,
        'Status Matrícula': aluno.status_matricula,
        'Total de Presenças': 0
      }));

      const wsAtivos = XLSX.utils.json_to_sheet(dadosAtivos);
      wsAtivos['!cols'] = [
        { wch: 5 }, { wch: 10 }, { wch: 50 }, { wch: 15 },
        { wch: 25 }, { wch: 15 }, { wch: 18 }
      ];
      XLSX.utils.book_append_sheet(wb, wsAtivos, 'Ativos Sem Presença');
    }

    // Aba 3: Resumo estatístico
    const dadosResumo = [
      { 'Métrica': 'Total sem presença', 'Valor': stats.total },
      { 'Métrica': 'Alunos ativos', 'Valor': stats.ativos },
      { 'Métrica': 'Alunos inativos', 'Valor': stats.inativos },
      { 'Métrica': 'Com matrícula', 'Valor': stats.comMatricula },
      { 'Métrica': 'Sem matrícula', 'Valor': stats.semMatricula },
      { 'Métrica': 'Matrícula ativa', 'Valor': stats.matriculados },
      { 'Métrica': 'Matrícula encerrada', 'Valor': stats.matriculaEncerrada }
    ];

    const wsResumo = XLSX.utils.json_to_sheet(dadosResumo);
    wsResumo['!cols'] = [{ wch: 25 }, { wch: 15 }];
    XLSX.utils.book_append_sheet(wb, wsResumo, 'Resumo Estatístico');

    // Salvar arquivo
    const agora = new Date();
    const timestamp = agora.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const nomeArquivo = `relatorio-completo-alunos-sem-presenca-${timestamp}.xlsx`;
    const caminhoArquivo = path.join(__dirname, nomeArquivo);

    XLSX.writeFile(wb, caminhoArquivo);

    console.log(`\n✅ Arquivo Excel gerado com sucesso!`);
    console.log(`📁 Arquivo: ${caminhoArquivo}`);
    console.log(`📊 Total de alunos sem presença: ${rows.length}`);
    console.log(`📋 Planilhas geradas: Todos Sem Presença, Ativos Sem Presença, Resumo Estatístico`);

  } catch (err) {
    console.error('Erro ao gerar Excel:', err);
  }
}

verificarTodosAlunosSemPresencaOnline();

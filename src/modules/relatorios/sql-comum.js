// Trechos de SQL repetidos pelos relatórios de presença.

// CTE com os dias letivos de um intervalo: todas as datas, menos os dias sem
// aula (feriado/recesso). Parâmetros: data inicial, data final, instituição.
// Outras CTEs podem vir depois dela: `${CTE_DIAS_LETIVOS}, outra AS (...)`.
const CTE_DIAS_LETIVOS = `
  WITH RECURSIVE datas AS (
    SELECT ? as data
    UNION ALL
    SELECT DATE_ADD(data, INTERVAL 1 DAY) FROM datas WHERE data < ?
  ),
  dias_letivos AS (
    SELECT data FROM datas
    WHERE NOT EXISTS (SELECT 1 FROM dias_sem_aula WHERE data = datas.data AND id_instituicao = ?)
  )`;

// Qualquer matrícula (ativa ou já encerrada) que previa aula no dia `d.data`.
// Usar só a matrícula atual apagaria do passado quem trocou de turma depois.
const JOIN_MATRICULA_DO_DIA = `
  JOIN matricula m ON TRIM(m.dia_semana) = ELT(
      DAYOFWEEK(d.data), 'Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'
    )
    AND d.data >= m.data_inicio
    AND (m.data_fim IS NULL OR d.data <= m.data_fim)`;

// Presença `p` fora de dia sem aula. Parâmetro: instituição.
const FORA_DE_DIA_SEM_AULA = `NOT EXISTS (
  SELECT 1 FROM dias_sem_aula d
  WHERE d.data = DATE(p.data) AND d.id_instituicao = ?
)`;

// Período da presença que corresponde ao turno da matrícula `m`. Sem isso, um
// aluno com turma de dia e ensaio à noite casava com qualquer presença do dia.
const PERIODO_DA_MATRICULA = `CASE
  WHEN LOWER(m.turno) LIKE '%manh%' THEN 'manha'
  WHEN LOWER(m.turno) LIKE '%tard%' THEN 'tarde'
  WHEN LOWER(m.turno) LIKE '%noit%' THEN 'noite'
END`;

// Presença `p` do período certo. Registros antigos sem período (de antes da
// coluna existir) só valem para manhã/tarde: a chamada da noite não existia.
const CONDICAO_PERIODO = `(p.periodo = ${PERIODO_DA_MATRICULA} OR (p.periodo IS NULL AND ${PERIODO_DA_MATRICULA} <> 'noite'))`;

// Datas DATE podem vir como Date ou texto, conforme o driver.
const dataTexto = (valor) => (valor instanceof Date ? valor.toISOString().split('T')[0] : valor);

const percentual = (parte, total) => (total > 0 ? Math.round((parte / total) * 100) : 0);

module.exports = {
  CTE_DIAS_LETIVOS,
  JOIN_MATRICULA_DO_DIA,
  FORA_DE_DIA_SEM_AULA,
  CONDICAO_PERIODO,
  dataTexto,
  percentual,
};

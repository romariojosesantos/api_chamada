// Calendário de "dias sem aula" (feriados, recessos, pontos facultativos) por
// instituição. Consultado por presenca.js (bloqueia lançar/finalizar chamada
// nesses dias) e por relatorios.js (exclui essas datas do cálculo de esperados/
// faltas). Granularidade é por instituição+dia inteiro (não por turno/turma).
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { authMiddleware } = require('./auth');

// Redundante com o `app.use('/api', authMiddleware)` de _server.js (que já roda
// antes deste router ser montado), mas inofensivo — mantido por clareza/segurança
// caso este router um dia seja montado em outro lugar sem esse middleware global.
router.use(authMiddleware);

// Listar dias sem aula da instituição, com o nome de quem cadastrou. Aceita
// filtro opcional por período (?data_inicio=&data_fim=).
router.get('/', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;

    let sql = `
      SELECT d.id, d.data, d.motivo, d.id_instituicao, d.created_at,
             u.nome as created_by_nome
      FROM dias_sem_aula d
      LEFT JOIN usuarios u ON d.created_by = u.id
      WHERE d.id_instituicao = ?
    `;
    const params = [req.id_instituicao];

    if (data_inicio && data_fim) {
      sql += ` AND d.data BETWEEN ? AND ?`;
      params.push(data_inicio, data_fim);
    }

    sql += ` ORDER BY d.data DESC`;

    const [results] = await pool.query(sql, params);
    res.json(results);
  } catch (error) {
    console.error('Erro ao buscar dias sem aula:', error);
    res.status(500).json({ error: 'Erro ao buscar dias sem aula' });
  }
});

// Verifica se uma data específica é dia sem aula (usado por telas que precisam
// de uma checagem pontual sem carregar a lista inteira).
router.get('/verificar/:data', async (req, res) => {
  try {
    const { data } = req.params;

    const [results] = await pool.query(
      `SELECT id, motivo FROM dias_sem_aula
       WHERE data = ? AND id_instituicao = ?`,
      [data, req.id_instituicao]
    );

    if (results.length > 0) {
      res.json({ isDiaSemAula: true, motivo: results[0].motivo, id: results[0].id });
    } else {
      res.json({ isDiaSemAula: false });
    }
  } catch (error) {
    console.error('Erro ao verificar dia sem aula:', error);
    res.status(500).json({ error: 'Erro ao verificar dia sem aula' });
  }
});

// Criar um dia sem aula individual (um clique no calendário da tela DiasSemAula.js).
router.post('/', async (req, res) => {
  try {
    const { data, motivo } = req.body;

    if (!data) {
      return res.status(400).json({ error: 'Data é obrigatória' });
    }

    // Verificar se já existe dia sem aula para essa data
    const [existing] = await pool.query(
      `SELECT id FROM dias_sem_aula WHERE data = ? AND id_instituicao = ?`,
      [data, req.id_instituicao]
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: 'Já existe um dia sem aula registrado para esta data' });
    }

    const [result] = await pool.query(
      `INSERT INTO dias_sem_aula (data, motivo, id_instituicao, created_by) VALUES (?, ?, ?, ?)`,
      [data, motivo || null, req.id_instituicao, req.user?.id]
    );

    res.status(201).json({
      id: result.insertId,
      data,
      motivo,
      message: 'Dia sem aula criado com sucesso'
    });
  } catch (error) {
    console.error('Erro ao criar dia sem aula:', error);
    res.status(500).json({ error: 'Erro ao criar dia sem aula' });
  }
});

// Editar data/motivo de um dia sem aula existente.
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, motivo } = req.body;

    // Verificar se o dia sem aula pertence à instituição do usuário
    const [check] = await pool.query(
      `SELECT id FROM dias_sem_aula WHERE id = ? AND id_instituicao = ?`,
      [id, req.id_instituicao]
    );

    if (check.length === 0) {
      return res.status(404).json({ error: 'Dia sem aula não encontrado' });
    }

    // Se a data foi alterada, verificar se já existe outro registro com a nova data
    if (data) {
      const [existing] = await pool.query(
        `SELECT id FROM dias_sem_aula WHERE data = ? AND id_instituicao = ? AND id != ?`,
        [data, req.id_instituicao, id]
      );

      if (existing.length > 0) {
        return res.status(400).json({ error: 'Já existe um dia sem aula registrado para esta data' });
      }
    }

    await pool.query(
      `UPDATE dias_sem_aula SET data = ?, motivo = ? WHERE id = ? AND id_instituicao = ?`,
      [data, motivo || null, id, req.id_instituicao]
    );

    res.json({ message: 'Dia sem aula atualizado com sucesso' });
  } catch (error) {
    console.error('Erro ao atualizar dia sem aula:', error);
    res.status(500).json({ error: 'Erro ao atualizar dia sem aula' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar se o dia sem aula pertence à instituição do usuário
    const [check] = await pool.query(
      `SELECT id FROM dias_sem_aula WHERE id = ? AND id_instituicao = ?`,
      [id, req.id_instituicao]
    );

    if (check.length === 0) {
      return res.status(404).json({ error: 'Dia sem aula não encontrado' });
    }

    await pool.query(
      `DELETE FROM dias_sem_aula WHERE id = ? AND id_instituicao = ?`,
      [id, req.id_instituicao]
    );

    res.json({ message: 'Dia sem aula deletado com sucesso' });
  } catch (error) {
    console.error('Erro ao deletar dia sem aula:', error);
    res.status(500).json({ error: 'Erro ao deletar dia sem aula' });
  }
});

// Marca todos os sábados e domingos de um ano como sem aula, de uma vez.
// `ON DUPLICATE KEY UPDATE motivo = VALUES(motivo)` (em vez de INSERT IGNORE) faz
// essa ação ser segura de repetir: datas que já existem só têm o motivo
// atualizado, nunca duplicam linha (a unique key é data+id_instituicao).
router.post('/marcar-fins-de-semana', async (req, res) => {
  try {
    const { ano } = req.body;
    const year = ano || new Date().getFullYear();

    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31);

    const finsDeSemana = [];
    const currentDate = new Date(startDate);

    while (currentDate <= endDate) {
      const dayOfWeek = currentDate.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) { // 0 = Domingo, 6 = Sábado
        finsDeSemana.push(currentDate.toISOString().split('T')[0]);
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    const values = finsDeSemana.map(data => [data, 'Fim de semana', req.id_instituicao, req.user?.id]);

    if (values.length > 0) {
      await pool.query(
        `INSERT INTO dias_sem_aula (data, motivo, id_instituicao, created_by) VALUES ?
         ON DUPLICATE KEY UPDATE motivo = VALUES(motivo)`,
        [values]
      );
    }

    res.json({
      message: `${finsDeSemana.length} fins de semana marcados com sucesso`,
      total: finsDeSemana.length
    });
  } catch (error) {
    console.error('Erro ao marcar fins de semana:', error);
    res.status(500).json({ error: 'Erro ao marcar fins de semana' });
  }
});

// Adiciona os feriados nacionais brasileiros de um ano de uma vez (fixos +
// móveis, calculados a partir da Páscoa). Não inclui feriados estaduais/
// municipais nem pontos facultativos locais — esses continuam sendo lançados
// manualmente ou via /marcar-periodo.
router.post('/adicionar-feriados-nacionais', async (req, res) => {
  try {
    const { ano } = req.body;
    const year = ano || new Date().getFullYear();

    // Feriados nacionais fixos do Brasil
    const feriadosFixos = [
      { mes: 0, dia: 1, nome: 'Confraternização Universal' }, // 1º de Janeiro
      { mes: 3, dia: 21, nome: 'Tiradentes' }, // 21 de Abril
      { mes: 4, dia: 1, nome: 'Dia do Trabalho' }, // 1º de Maio
      { mes: 8, dia: 7, nome: 'Independência do Brasil' }, // 7 de Setembro
      { mes: 9, dia: 12, nome: 'Nossa Senhora Aparecida' }, // 12 de Outubro
      { mes: 10, dia: 2, nome: 'Finados' }, // 2 de Novembro
      { mes: 10, dia: 15, nome: 'Proclamação da República' }, // 15 de Novembro
      { mes: 11, dia: 25, nome: 'Natal' }, // 25 de Dezembro
    ];

    // Data da Páscoa (domingo) de um ano — algoritmo de Meeus/Jones/Butcher
    // (calendário gregoriano). Os demais feriados móveis são calculados a partir dela.
    const calcularPascoa = (ano) => {
      const a = ano % 19;
      const b = Math.floor(ano / 100);
      const c = ano % 100;
      const d = Math.floor(b / 4);
      const e = b % 4;
      const f = Math.floor((b + 8) / 25);
      const g = Math.floor((b - f + 1) / 3);
      const h = (19 * a + b - d - g + 15) % 30;
      const i = Math.floor(c / 4);
      const k = c % 4;
      const l = (32 + 2 * e + 2 * i - h - k) % 7;
      const m = Math.floor((a + 11 * h + 22 * l) / 451);
      const mes = Math.floor((h + l - 7 * m + 114) / 31);
      const dia = ((h + l - 7 * m + 114) % 31) + 1;
      return new Date(ano, mes - 1, dia);
    };

    const pascoa = calcularPascoa(year);

    // Carnaval (47 dias antes da Páscoa)
    const carnaval = new Date(pascoa);
    carnaval.setDate(pascoa.getDate() - 47);

    // Sexta-feira Santa (2 dias antes da Páscoa)
    const sextaSanta = new Date(pascoa);
    sextaSanta.setDate(pascoa.getDate() - 2);

    // Corpus Christi (60 dias depois da Páscoa)
    const corpusChristi = new Date(pascoa);
    corpusChristi.setDate(pascoa.getDate() + 60);

    const feriadosMoveis = [
      { data: carnaval, nome: 'Carnaval' },
      { data: sextaSanta, nome: 'Sexta-feira Santa' },
      { data: pascoa, nome: 'Páscoa' },
      { data: corpusChristi, nome: 'Corpus Christi' },
    ];

    const feriados = [];

    feriadosFixos.forEach(feriado => {
      const data = new Date(year, feriado.mes, feriado.dia);
      feriados.push({
        data: data.toISOString().split('T')[0],
        motivo: feriado.nome
      });
    });

    feriadosMoveis.forEach(feriado => {
      feriados.push({
        data: feriado.data.toISOString().split('T')[0],
        motivo: feriado.nome
      });
    });

    const values = feriados.map(f => [f.data, f.motivo, req.id_instituicao, req.user?.id]);

    if (values.length > 0) {
      await pool.query(
        `INSERT INTO dias_sem_aula (data, motivo, id_instituicao, created_by) VALUES ?
         ON DUPLICATE KEY UPDATE motivo = VALUES(motivo)`,
        [values]
      );
    }

    res.json({
      message: `${feriados.length} feriados nacionais adicionados com sucesso`,
      total: feriados.length,
      feriados
    });
  } catch (error) {
    console.error('Erro ao adicionar feriados nacionais:', error);
    res.status(500).json({ error: 'Erro ao adicionar feriados nacionais' });
  }
});

// Marca todos os dias de um período (ex.: recesso de férias) como sem aula, com
// um motivo comum a todos.
router.post('/marcar-periodo', async (req, res) => {
  try {
    const { data_inicio, data_fim, motivo } = req.body;

    if (!data_inicio || !data_fim) {
      return res.status(400).json({ error: 'data_inicio e data_fim são obrigatórias' });
    }

    const startDate = new Date(data_inicio);
    const endDate = new Date(data_fim);

    if (startDate > endDate) {
      return res.status(400).json({ error: 'data_inicio deve ser anterior ou igual a data_fim' });
    }

    const diasSemAula = [];
    const currentDate = new Date(startDate);

    while (currentDate <= endDate) {
      diasSemAula.push(currentDate.toISOString().split('T')[0]);
      currentDate.setDate(currentDate.getDate() + 1);
    }

    const values = diasSemAula.map(data => [data, motivo || 'Período sem aula', req.id_instituicao, req.user?.id]);

    if (values.length > 0) {
      await pool.query(
        `INSERT INTO dias_sem_aula (data, motivo, id_instituicao, created_by) VALUES ?
         ON DUPLICATE KEY UPDATE motivo = VALUES(motivo)`,
        [values]
      );
    }

    res.json({
      message: `${diasSemAula.length} dias marcados como sem aula com sucesso`,
      total: diasSemAula.length,
      periodo: { data_inicio, data_fim, motivo }
    });
  } catch (error) {
    console.error('Erro ao marcar período:', error);
    res.status(500).json({ error: 'Erro ao marcar período' });
  }
});

module.exports = router;

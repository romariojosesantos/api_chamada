// Schema (Joi) do corpo de gravação de chamada — usado com validate() de
// src/middlewares/validate.js. Atenção: `data` é declarada como Joi.date(),
// mas validate() nunca aplica o valor coagido de volta em req.body (ver o
// comentário em validate.js) — a rota continua recebendo a string "YYYY-MM-DD".
const Joi = require('joi');

const presencaSchema = Joi.object({
  data: Joi.date().iso().required(),
  // Uma chamada inteira (todos os `chamadas` do lote) é sempre de UM único
  // período — a tela de Chamada já é filtrada por turno antes de carregar a
  // lista (ver AttendanceList.jsx). Opcional só por compatibilidade: quando
  // ausente, a rota mantém o comportamento antigo (sem período).
  periodo: Joi.string().valid('manha', 'tarde', 'noite').allow(null),
  chamadas: Joi.array()
    .items(
      Joi.object({
        aluno_id: Joi.number().required(),
        // null é um valor válido e intencional: sinaliza "desmarcar" (apagar o
        // registro de presença existente) — ver o tratamento na rota.
        status: Joi.string()
          .valid('presente', 'falta', 'justificado', 'ausente')
          .allow(null)
          .required(),
        observacao: Joi.string().allow(null, ''),
      }),
    )
    .min(1)
    .required(),
});

module.exports = { presencaSchema };

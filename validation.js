// Schemas de validação (Joi) para os corpos de requisição da API. Centralizar
// aqui evita repetir as mesmas regras em cada rota.
const Joi = require('joi');

const schemas = {
  aluno: Joi.object({
    nome: Joi.string().trim().min(3).required().messages({
      'string.empty': 'O nome do aluno é obrigatório.',
      'string.min': 'O nome deve ter pelo menos 3 caracteres.'
    }),
    data_nascimento: Joi.date().iso().allow(null, ''),
    sexo: Joi.string().max(1).uppercase().allow(null, ''),
    telefone: Joi.string().allow(null, ''),
    turma: Joi.string().allow(null, ''),
    turno: Joi.string().allow(null, ''),
    transporte: Joi.string().allow(null, ''),
    Inf: Joi.string().allow(null, ''),
    status: Joi.string().valid('ativo', 'inativo', 'espera').default('ativo')
  }).unknown(true), // permite campos extras no payload (ex.: acompanhamento/ponto, tratados fora do schema)

  presenca: Joi.object({
    data: Joi.date().iso().required(),
    // Uma chamada inteira (todos os `chamadas` do lote) é sempre de UM único
    // período — a tela de Chamada já é filtrada por turno antes de carregar a
    // lista (ver AttendanceList.jsx). Opcional só por compatibilidade: quando
    // ausente, presenca.js mantém o comportamento antigo (sem período).
    periodo: Joi.string().valid('manha', 'tarde', 'noite').allow(null),
    chamadas: Joi.array().items(
      Joi.object({
        aluno_id: Joi.number().required(),
        // null é um valor válido e intencional: sinaliza "desmarcar" (apagar o
        // registro de presença existente) — ver o tratamento em presenca.js.
        status: Joi.string().valid('presente', 'falta', 'justificado', 'ausente').allow(null).required(),
        observacao: Joi.string().allow(null, '')
      })
    ).min(1).required()
  })
};

// Middleware de validação: valida req.body contra o schema `schemaName` e
// responde 400 com a lista de erros se algo estiver inválido.
//
// De propósito só usa `error` — o `value` que o Joi devolveria (com os campos
// coagidos pro tipo declarado no schema) é descartado, nunca aplicado de volta
// em `req.body`. Isso importa pro schema `presenca`, que declara
// `data: Joi.date().iso()`: se um dia alguém "consertar" isso pro jeito
// idiomático do Joi (`const { error, value } = ...; if (!error) req.body = value;`),
// `req.body.data` passaria a chegar em presenca.js como um objeto `Date` (não
// mais a string "YYYY-MM-DD" que os handlers esperam) — reintroduzindo o
// mesmo bug de fuso horário corrigido no frontend (new Date("YYYY-MM-DD") é
// meia-noite UTC), só que agora na GRAVAÇÃO da presença, não só na exibição.
// Antes de mudar isso, reconferir toda rota que usa validate('presenca')/
// validate('aluno') pra garantir que ainda espera strings, não objetos Date.
const validate = (schemaName) => (req, res, next) => {
  const { error } = schemas[schemaName].validate(req.body, { abortEarly: false });
  if (error) {
    return res.status(400).json({
      error: 'Falha na validação dos dados',
      details: error.details.map(d => d.message)
    });
  }
  next();
};

module.exports = { validate };

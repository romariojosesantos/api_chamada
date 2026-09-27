# Análise de Riscos - Migrações de Banco de Dados

## ⚠️ Avaliação de Riscos por Script

### 1. migrate-add-missing-indexes.js ✅ **RISCO BAIXO**
- **O que faz:** Apenas adiciona índices de performance
- **Impacto em dados:** NENHUM
- **Impacto em operação:** Pode causar lentidão momentânea durante criação de índices
- **Pode rodar em produção:** SIM
- **Backup necessário:** Recomendado mas não crítico
- **Rollback:** DROP INDEX (simples)

### 2. migrate-normalize-dias-semana.js ⚠️ **RISCO MÉDIO**
- **O que faz:** Cria novas tabelas e migra dados, mantém original
- **Impacto em dados:** NENHUM (dados originais preservados)
- **Impacto em operação:** Nenhum (sistema continua usando coluna original)
- **Pode rodar em produção:** SIM, com validação prévia
- **Backup necessário:** SIM
- **Rollback:** DROP TABLE novas (simples)

### 3. migrate-normalize-pks.js ❌ **RISCO ALTO**
- **O que faz:** Altera PKs e FKs de tabelas críticas
- **Impacto em dados:** NENHUM (apenas renomeia colunas)
- **Impacto em operação:** ALTO - pode quebrar aplicação se código não estiver atualizado
- **Pode rodar em produção:** NÃO, sem atualização prévia do código
- **Backup necessário:** OBRIGATÓRIO
- **Rollback:** Complexo (requer reversão manual)

## 📋 Procedimento Seguro para Produção

### Fase 1: Preparação
1. **Backup completo do banco**
   ```bash
   mysqldump -u [user] -p [database] > backup_$(date +%Y%m%d_%H%M%S).sql
   ```

2. **Testar em ambiente de staging**
   - Restaurar backup em staging
   - Rodar migrações
   - Testar todas as funcionalidades

3. **Atualizar código da aplicação**
   - Atualizar queries para usar novos nomes de colunas
   - Testar localmente
   - Deploy em staging

### Fase 2: Execução em Produção

#### Passo 1: Índices (Risco Baixo)
```bash
node migrate-add-missing-indexes.js
```
- Pode rodar durante horário de operação
- Monitorar performance

#### Passo 2: Dias da Semana (Risco Médio)
```bash
node migrate-normalize-dias-semana.js
```
- Rodar em horário de menor uso
- Validar dados migrados
- Manter coluna original por período de transição

#### Passo 3: Normalização de PKs (Risco Alto) ⚠️
**NÃO RECOMENDADO sem:**
- Atualização completa do código frontend/backend
- Testes exaustivos em staging
- Janela de manutenção programada
- Plano de rollback detalhado

## 🔄 Alternativa Segura - Migração Gradual

### Opção 1: Adicionar colunas ao invés de renomear
```javascript
// Em vez de renomear idatividades -> id_atividade
// Adicionar nova coluna e popular
ALTER TABLE matricula ADD COLUMN id_atividade_new INT;
UPDATE matricula SET id_atividade_new = idatividades;
// Usar ambas temporariamente
```

### Opção 2: Views de compatibilidade
```sql
CREATE VIEW matricula_compat AS
SELECT 
  idmatricula as id,
  idatividades as id_atividade,
  ...
FROM matricula;
```

### Opção 3: Manter status quo (recomendado para PKs)
- PKs inconsistentes não quebram funcionalidade
- Apenas afetam legibilidade do código
- Podem ser normalizados em refactoring futuro

## ✅ Recomendação Imediata

### Rodar AGORA (Seguro):
1. ✅ `migrate-add-missing-indexes.js` - Melhora performance sem risco

### Adiar (Requer planejamento):
2. ⏸️ `migrate-normalize-dias-semana.js` - Útil mas não urgente
3. ⏸️ `migrate-normalize-pks.js` - Apenas estética, alto risco

### Priorizar:
- Performance (índices) > Normalização > Estética

## 🚨 Sinais de Alerta

**NÃO rode migrações de PKs se:**
- Não tem backup recente
- Código não está atualizado
- Não tem janela de manutenção
- Equipe não está disponível para suporte

**SEMPRE:**
- Teste em staging primeiro
- Tenha plano de rollback
- Monitore logs após migração
- Comunique equipe sobre mudanças

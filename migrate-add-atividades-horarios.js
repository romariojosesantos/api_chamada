// Migration: Adicionar campos de horário à tabela atividades
// Este script adiciona colunas para dia_semana, horario e turno à tabela atividades
// Execute com: node migrate-add-atividades-horarios.js

require('dotenv').config();
const pool = require('./db');

async function migrate() {
  console.log('Iniciando migração: Adicionar campos de horário à tabela atividades...');
  
  try {
    // Verificar se as colunas já existem
    const [columns] = await pool.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'atividades'
      AND COLUMN_NAME IN ('dia_semana', 'horario', 'turno')
    `);
    
    const existingColumns = columns.map(c => c.COLUMN_NAME);
    
    if (existingColumns.includes('dia_semana') && existingColumns.includes('horario') && existingColumns.includes('turno')) {
      console.log('⚠️  As colunas já existem. Nenhuma alteração necessária.');
      return;
    }
    
    // Adicionar coluna dia_semana se não existir
    if (!existingColumns.includes('dia_semana')) {
      await pool.query(`
        ALTER TABLE atividades 
        ADD COLUMN dia_semana VARCHAR(20) DEFAULT NULL
      `);
      console.log('✓ Coluna dia_semana adicionada');
    }
    
    // Adicionar coluna horario se não existir
    if (!existingColumns.includes('horario')) {
      await pool.query(`
        ALTER TABLE atividades 
        ADD COLUMN horario VARCHAR(20) DEFAULT NULL
      `);
      console.log('✓ Coluna horario adicionada');
    }
    
    // Adicionar coluna turno se não existir
    if (!existingColumns.includes('turno')) {
      await pool.query(`
        ALTER TABLE atividades 
        ADD COLUMN turno VARCHAR(20) DEFAULT NULL
      `);
      console.log('✓ Coluna turno adicionada');
    }
    
    console.log('✅ Migração concluída com sucesso!');
    
  } catch (error) {
    console.error('❌ Erro durante migração:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

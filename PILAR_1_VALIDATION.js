#!/usr/bin/env node
/**
 * PILAR_1_VALIDATION.js
 * 
 * Script para validar todos os componentes do Pilar 1
 * Uso: node PILAR_1_VALIDATION.js
 */

'use strict';

const logger = require('./src/config/logger');
const OutputValidator = require('./src/compliance/output-validator');
const { 
    renderTemplate, 
    selectTemplate, 
    FOLLOWUP_TEMPLATES 
} = require('./src/templates/followup-templates');

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║         VALIDAÇÃO PILAR 1 - EFICIÊNCIA PRIMEIRA            ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

// ================================================================
// TEST 1: OutputValidator - Validações Básicas
// ================================================================
console.log('🧪 TEST 1: OutputValidator Validations');
console.log('─────────────────────────────────────\n');

const testCases = [
    {
        name: 'Resposta válida (humanizada)',
        text: 'Ótimo! Como posso ajudar?',
        shouldPass: true
    },
    {
        name: 'Resposta com >150 chars (DEVE REJEITAR)',
        text: 'Oi João! Tudo bem? Eu sou um assistente de IA especializado em vendas e gostaria de conversar com você sobre como podemos ajudar sua empresa a crescer. Qual é o melhor horário para falarmos?',
        shouldPass: false
    },
    {
        name: 'Resposta com >1 pergunta (DEVE REJEITAR)',
        text: 'Qual é seu orçamento? Você tem quantos funcionários? Qual é seu desafio?',
        shouldPass: false
    },
    {
        name: 'AI marker detectado (DEVE REJEITAR)',
        text: 'Como um assistente de IA, posso ajudar você com...',
        shouldPass: false
    },
    {
        name: 'Encerramento genérico (DEVE REJEITAR)',
        text: 'Aguardo seu feedback.',
        shouldPass: false
    },
    {
        name: 'Sem CTA específico (DEVE REJEITAR)',
        text: 'Tudo bem, vamos ver o que fazemos.',
        shouldPass: false
    }
];

let test1Pass = 0;
testCases.forEach((tc, idx) => {
    const result = OutputValidator.validate(tc.text, {
        stage: 'TOP_OF_FUNNEL',
        followUpDay: null
    });
    
    const passed = result.valid === tc.shouldPass;
    const status = passed ? '✅' : '❌';
    console.log(`${status} Test ${idx + 1}: ${tc.name}`);
    console.log(`   Esperado: ${tc.shouldPass ? 'VÁLIDO' : 'REJEITADO'}, Obtido: ${result.valid ? 'VÁLIDO' : 'REJEITADO'}`);
    if (result.issues.length > 0) {
        console.log(`   Issues: ${result.issues.join(', ')}`);
    }
    console.log(`   Score: ${result.score}/10\n`);
    if (passed) test1Pass++;
});

console.log(`✅ Resultado: ${test1Pass}/${testCases.length} testes passou\n`);

// ================================================================
// TEST 2: OutputValidator Fallback Logic
// ================================================================
console.log('\n🧪 TEST 2: OutputValidator Fallback (Stage-aware)');
console.log('──────────────────────────────────────────────────\n');

const stages = ['TOP_OF_FUNNEL', 'MIDDLE_OF_FUNNEL', 'BOTTOM_OF_FUNNEL'];
let test2Pass = 0;

stages.forEach(stage => {
    const fallback = OutputValidator.useFallback({
        stage: stage,
        objections: []
    });
    
    const valid = fallback && fallback.length > 0 && fallback.length <= 150;
    const status = valid ? '✅' : '❌';
    console.log(`${status} Fallback para ${stage}`);
    console.log(`   Texto: "${fallback}"`);
    console.log(`   Chars: ${fallback.length}\n`);
    if (valid) test2Pass++;
});

console.log(`✅ Resultado: ${test2Pass}/${stages.length} fallbacks válidos\n`);

// ================================================================
// TEST 3: Follow-up Templates Structure
// ================================================================
console.log('\n🧪 TEST 3: Follow-up Templates Structure');
console.log('──────────────────────────────────────────\n');

const expectedStructure = {
    D1: ['silent_no_response', 'budget_objection', 'email_request', 'gatekeeper'],
    D5: ['continue_gentle', 'clear_rejection', 'budget_still_blocking'],
    D10: ['final_last_touch', 'final_empathetic']
};

let test3Pass = 0;
Object.entries(expectedStructure).forEach(([day, templates]) => {
    const existing = Object.keys(FOLLOWUP_TEMPLATES[day] || {});
    const match = JSON.stringify(existing.sort()) === JSON.stringify(templates.sort());
    const status = match ? '✅' : '❌';
    console.log(`${status} ${day} templates`);
    console.log(`   Esperado: ${templates.join(', ')}`);
    console.log(`   Obtido: ${existing.join(', ')}\n`);
    if (match) test3Pass++;
});

console.log(`✅ Resultado: ${test3Pass}/${Object.keys(expectedStructure).length} estruturas válidas\n`);

// ================================================================
// TEST 4: Template Rendering
// ================================================================
console.log('\n🧪 TEST 4: Template Rendering (Variable Substitution)');
console.log('──────────────────────────────────────────────────────\n');

const renderTests = [
    { day: 'D1', template: 'silent_no_response', vars: { nome: 'João', empresa: 'Acme' } },
    { day: 'D5', template: 'continue_gentle', vars: { nome: 'Maria', empresa: 'Tech Corp' } },
    { day: 'D10', template: 'final_last_touch', vars: { nome: 'Pedro', empresa: 'Sales Inc' } }
];

let test4Pass = 0;
renderTests.forEach((rt, idx) => {
    const rendered = renderTemplate(rt.day, rt.template, rt.vars);
    const hasName = rendered.includes(rt.vars.nome);
    const hasCompany = rendered.includes(rt.vars.empresa);
    const hasContent = rendered.length > 20;
    
    const passed = hasName && hasCompany && hasContent;
    const status = passed ? '✅' : '❌';
    
    console.log(`${status} Render ${rt.day} / ${rt.template}`);
    console.log(`   Variables: {nome: '${rt.vars.nome}', empresa: '${rt.vars.empresa}'}`);
    console.log(`   Template contains name: ${hasName}`);
    console.log(`   Template contains company: ${hasCompany}`);
    console.log(`   Resultado: "${rendered}"\n`);
    
    if (passed) test4Pass++;
});

console.log(`✅ Resultado: ${test4Pass}/${renderTests.length} renderizações válidas\n`);

// ================================================================
// TEST 5: Template Selection Logic
// ================================================================
console.log('\n🧪 TEST 5: Template Auto-Selection (by Objection)');
console.log('────────────────────────────────────────────────\n');

const selectionTests = [
    { day: 'D1', objections: [], expected: 'silent_no_response' },
    { day: 'D1', objections: ['budget'], expected: 'budget_objection' },
    { day: 'D1', objections: ['other'], expected: 'email_request' },
    { day: 'D5', objections: ['nao_interesse'], expected: 'clear_rejection' },
    { day: 'D10', objections: [], expected: 'final_last_touch' }
];

let test5Pass = 0;
selectionTests.forEach((st, idx) => {
    const selected = selectTemplate(st.day, { objections_met: st.objections });
    const passed = selected === st.expected;
    const status = passed ? '✅' : '❌';
    
    console.log(`${status} Selection ${st.day} with objections: [${st.objections.join(', ')}]`);
    console.log(`   Esperado: ${st.expected}`);
    console.log(`   Obtido: ${selected}\n`);
    
    if (passed) test5Pass++;
});

console.log(`✅ Resultado: ${test5Pass}/${selectionTests.length} seleções corretas\n`);

// ================================================================
// SUMMARY
// ================================================================
console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║                     RESULTADO FINAL                        ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

const totalTests = testCases.length + stages.length + 
                  Object.keys(expectedStructure).length + 
                  renderTests.length + 
                  selectionTests.length;
const totalPass = test1Pass + test2Pass + test3Pass + test4Pass + test5Pass;

console.log(`📊 Total: ${totalPass}/${totalTests} testes passaram\n`);

if (totalPass === totalTests) {
    console.log('✅ ✅ ✅  PILAR 1 VALIDATION SUCCESS  ✅ ✅ ✅\n');
    console.log('Todos os componentes funcionando corretamente.');
    console.log('Pronto para deploy em produção.\n');
    process.exit(0);
} else {
    console.log('❌ ❌ ❌  PILAR 1 VALIDATION FAILED  ❌ ❌ ❌\n');
    console.log(`${totalTests - totalPass} testes falharam.\n`);
    process.exit(1);
}

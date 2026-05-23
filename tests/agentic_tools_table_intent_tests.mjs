import assert from 'assert';
import { detectRequestedContentKind } from '../src/taskpane/modules/commands/agentic-tools.js';

function testDetectsGenericTableCreationIntent() {
    assert.strictEqual(
        detectRequestedContentKind('turn the seller and buyer blocks into a table to save space'),
        'table'
    );

    assert.strictEqual(
        detectRequestedContentKind('reformat these milestones as a table with two columns'),
        'table'
    );
}

function testIgnoresTableRemovalIntent() {
    assert.strictEqual(
        detectRequestedContentKind('remove the table and turn it into plain text'),
        null
    );
}

function testIgnoresNonTableInstructions() {
    assert.strictEqual(
        detectRequestedContentKind('change Seller to Provider'),
        null
    );
}

testDetectsGenericTableCreationIntent();
testIgnoresTableRemovalIntent();
testIgnoresNonTableInstructions();

console.log('agentic_tools_table_intent_tests passed');

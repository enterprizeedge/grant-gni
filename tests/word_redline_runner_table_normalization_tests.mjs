import assert from 'assert';
import {
    inferTableConversionEndIndex,
    isDiagnosticReplacementText,
    normalizeTableReplacementText,
    synthesizeMarkdownTableFromSourceRange
} from '../src/taskpane/modules/docx-redline-js-integration/word-redline-runner.js';

function testInlineLabeledPipeTextNormalizesToMarkdownTable() {
    const input = 'Seller|[Name of Seller]|[Address of Seller]|And|Buyer|[Name of Buyer]|[Address of Buyer]';
    const normalized = normalizeTableReplacementText(input);

    assert.strictEqual(
        normalized,
        '| Seller | Buyer |\n'
        + '| --- | --- |\n'
        + '| [Name of Seller] | [Name of Buyer] |\n'
        + '| [Address of Seller] | [Address of Buyer] |'
    );
}

function testValidMarkdownTableIsPreserved() {
    const input = '| A | B |\n|---|---|\n| 1 | 2 |';
    assert.strictEqual(normalizeTableReplacementText(input), input);
}

function testMarkdownTableHtmlBreaksExpandToRows() {
    const input = '| Seller | Buyer |\n|---|---|\n| [Name of Seller]<br>[Address of Seller] | [Name of Buyer]<br>[Address of Buyer] |';

    assert.strictEqual(
        normalizeTableReplacementText(input),
        '| Seller | Buyer |\n'
        + '|---|---|\n'
        + '| [Name of Seller] | [Name of Buyer] |\n'
        + '| [Address of Seller] | [Address of Buyer] |'
    );
}

function testTableRangeInferenceStopsBeforeBodyParagraph() {
    const paragraphs = [
        {
            text: 'Disclosing Party:\v[Name of Disclosing Party]\v[Address of Disclosing Party]\v(the "Disclosing Party")'
        },
        { text: 'And' },
        {
            text: 'Receiving Party:\v[Name of Receiving Party]\v[Address of Receiving Party]\v(the "Receiving Party")'
        },
        {
            text: 'The Disclosing Party and the Receiving Party are hereinafter collectively referred to as the "Parties" and individually as a "Party."'
        }
    ];

    assert.strictEqual(inferTableConversionEndIndex(paragraphs, 0), 2);
}

function testSynthesizesGenericLabeledTableFromSourceRange() {
    const paragraphs = [
        {
            text: 'Seller:\v[Name of Seller]\v[Address of Seller]'
        },
        { text: 'And' },
        {
            text: 'Buyer:\v[Name of Buyer]\v[Address of Buyer]'
        }
    ];

    assert.strictEqual(
        synthesizeMarkdownTableFromSourceRange(paragraphs, 0, 2),
        '| Seller | Buyer |\n'
        + '| --- | --- |\n'
        + '| [Name of Seller] | [Name of Buyer] |\n'
        + '| [Address of Seller] | [Address of Buyer] |'
    );
}

function testDoesNotSynthesizeTableFromUnlabeledNarrativeRange() {
    const paragraphs = [
        { text: 'The first paragraph has normal sentence text.' },
        { text: 'The second paragraph also has normal sentence text.' }
    ];

    assert.strictEqual(synthesizeMarkdownTableFromSourceRange(paragraphs, 0, 1), null);
}

function testDetectsDiagnosticReplacementText() {
    const text = 'Disclosing Party|[Name of Disclosing Party]|[Address of Disclosing Party]|And|Receiving Party|[Name of Receiving Party]|[Address of Receiving Party]|None required for replace_range operation, but schema requires only paragraphIndex, endParagraphIndex, operation, and content for replace_range. Do NOT include originalText or replacementText.';
    assert.strictEqual(isDiagnosticReplacementText(text), true);
    assert.strictEqual(isDiagnosticReplacementText('| A | B |\n|---|---|\n| 1 | 2 |'), false);
}

testInlineLabeledPipeTextNormalizesToMarkdownTable();
testValidMarkdownTableIsPreserved();
testMarkdownTableHtmlBreaksExpandToRows();
testTableRangeInferenceStopsBeforeBodyParagraph();
testSynthesizesGenericLabeledTableFromSourceRange();
testDoesNotSynthesizeTableFromUnlabeledNarrativeRange();
testDetectsDiagnosticReplacementText();

console.log('word_redline_runner_table_normalization_tests passed');
